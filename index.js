// 世界之眼 (World Eye) - 工具搜索与智能路由插件
// 自动发现所有工具、BM25 检索工具定义、下级智能体委派执行

const { Plugin } = require('../../../js/core/plugin-base.js');
const { logToTerminal } = require('../../../js/api-utils.js');
const { ToolRegistry } = require('./tool-registry.js');
const { SubAgent } = require('./sub-agent.js');
const PLUGIN_TAG = '🌍 [世界之眼]';

class WorldEyePlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);

        this._pluginDir = __dirname;
        this._registry = new ToolRegistry(this._pluginDir);
        this._subAgent = null;

        /** @type {Map<string, {name: string, definition: object, lastUsed: number}>} */
        this._recentTools = new Map();
        this._cacheTTL = 300_000; // 默认 5 分钟

        this._config = null;
        this._pluginConfig = null;
    }

    async onInit() {
        this._loadConfig();
        logToTerminal('info', `${PLUGIN_TAG} 插件初始化完成`);
    }

    async onStart() {
        const tools = this._collectFreshTools();
        if (tools.length > 0) {
            this._registry.buildFromToolsList(tools);
        }
        logToTerminal('info', `${PLUGIN_TAG} 已发现 ${this._registry.size} 个工具，索引构建完成`);
    }

    /**
     * 核心钩子：拦截 LLM 请求，替换工具列表
     * 兼容原版 llm-handler.js，无需修改主项目任何文件
     */
    async onLLMRequest(request) {
        if (!this._pluginConfig || !this._pluginConfig.enabled) return;

        // 始终从全局管理器获取完整工具列表
        // 不依赖 request.tools（多轮迭代中可能是上轮修改后的残留）
        const freshTools = this._collectFreshTools();

        // 识别插件工具（由 pluginManager 提供），这些不归世界之眼管
        const pluginToolNames = new Set();
        if (global.pluginManager) {
            try {
                const pluginTools = global.pluginManager.getAllTools();
                for (const t of pluginTools) {
                    const name = (t.function || t).name || '';
                    if (!name.startsWith('world_eye_')) {
                        pluginToolNames.add(name);
                    }
                }
            } catch { /* skip */ }
        }

        // 分流：server-tools/MCP → 世界之眼管理 | 插件工具 → 直接透传
        const managedTools = [];
        const passthroughTools = [];
        for (const t of freshTools) {
            const name = (t.function || t).name || '';
            if (name.startsWith('world_eye_')) continue;
            if (pluginToolNames.has(name)) {
                passthroughTools.push(t);
            } else {
                managedTools.push(t);
            }
        }

        const changed = this._registry.buildFromToolsList(managedTools);
        if (changed) {
            logToTerminal('info', `${PLUGIN_TAG} 工具索引已更新，当前 ${this._registry.size} 个工具（另有 ${passthroughTools.length} 个插件工具直接透传）`);
            this._refineAbbreviationsAsync();
        }

        // 原地修改数组，使修改在原版 llm-handler.js 中生效
        // （request.tools 与 llm-handler 中的 allTools 指向同一个数组对象）
        const newTools = [...this._buildMetaTools(), ...passthroughTools];
        if (Array.isArray(request.tools)) {
            request.tools.length = 0;
            request.tools.push(...newTools);
        } else {
            request.tools = newTools;
        }
    }

    /**
     * 返回世界之眼提供的工具定义
     */
    getTools() {
        return this._buildMetaTools();
    }

    /**
     * 执行工具调用
     */
    async executeTool(name, params) {
        if (name === 'world_eye_search') {
            return await this._handleSearch(params);
        }
        if (name === 'world_eye_execute') {
            return await this._handleExecute(params);
        }
        return undefined;
    }

    // ===== 搜索处理 =====

    async _handleSearch(params) {
        const query = params.query || '';
        const topK = params.top_k || this._getTopK();

        logToTerminal('info', `${PLUGIN_TAG} 搜索工具: "${query}" (top_k=${topK})`);

        const results = this._registry.search(query, topK);

        logToTerminal('info', `${PLUGIN_TAG} 找到 ${results.length} 个候选工具: ${results.map(r => r.entry.name).join(', ')}`);

        return this._registry.formatSearchResults(results);
    }

    // ===== 执行处理 =====

    async _handleExecute(params) {
        const toolName = params.tool_name;
        const taskDescription = params.task_description || params.requirements || '';

        if (!toolName) {
            return '错误: 缺少 tool_name 参数。请指定要调用的工具名称。';
        }

        logToTerminal('info', `${PLUGIN_TAG} 委派执行: ${toolName}`);
        logToTerminal('info', `${PLUGIN_TAG} 任务描述: ${taskDescription.substring(0, 100)}...`);

        // 查找工具定义
        const entry = this._registry.getByName(toolName);
        if (!entry) {
            return `错误: 未找到工具 "${toolName}"。请先使用 world_eye_search 搜索可用工具。`;
        }

        // 更新最近使用缓存
        this._recentTools.set(toolName, {
            name: toolName,
            definition: entry.definition,
            lastUsed: Date.now()
        });
        this._cleanExpiredCache();

        // 获取工具的完整信息（含使用示例，给下级智能体）
        const toolInfo = this._registry.formatForSubAgent(toolName);

        // 确保下级智能体已初始化
        this._ensureSubAgent();

        // 委派给下级智能体执行
        const result = await this._subAgent.execute(
            toolName,
            taskDescription,
            toolInfo,
            entry.definition
        );

        logToTerminal('info', `${PLUGIN_TAG} 执行完成: ${toolName}，结果长度: ${result.length}`);
        // 添加完成标识，避免主 LLM 误判需再次调用工具，从而减少重复结果导致的 TTS 卡住
        const completionPrefix = '【世界之眼执行完毕】\n\n';
        return result.startsWith(completionPrefix) ? result : completionPrefix + result;
    }

    // ===== 构建元工具 =====

    _buildMetaTools() {
        const abbreviationList = this._registry.getAbbreviationList();
        const recentList = this._getRecentToolsList();

        const searchDesc = [
            '搜索可用工具。根据功能描述关键词搜索匹配的工具，返回候选工具的名称、功能说明和参数定义。',
            '',
            '当前系统中可用的工具类别概览:',
            abbreviationList || '(暂无已注册的工具)',
            recentList ? `\n最近使用过的工具: ${recentList}` : '',
        ].join('\n');

        return [
            {
                type: 'function',
                function: {
                    name: 'world_eye_search',
                    description: searchDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: '搜索关键词，描述你需要的工具功能，例如"天气查询"、"论坛发帖"、"货币转换"'
                            },
                            top_k: {
                                type: 'number',
                                description: '返回候选工具数量，默认 5'
                            }
                        },
                        required: ['query']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_execute',
                    description: '委派下级智能体执行指定工具。需先通过 world_eye_search 确认工具名称，或直接使用最近使用过的工具名。提供工具名和具体的任务要求/参数，下级智能体将根据完整的工具定义和使用示例来执行工具调用。【重要】本次调用一经返回即表示已执行完毕，请仅根据本次返回结果直接生成面向用户的回复，勿对同一任务重复调用本工具。',
                    parameters: {
                        type: 'object',
                        properties: {
                            tool_name: {
                                type: 'string',
                                description: '要调用的工具名称（必须是 world_eye_search 返回的候选工具名，或最近使用过的工具名）'
                            },
                            task_description: {
                                type: 'string',
                                description: '具体的任务描述和要求。详细说明你需要工具完成什么操作、使用什么参数值。例如："查询东京当前天气，使用摄氏度"'
                            }
                        },
                        required: ['tool_name', 'task_description']
                    }
                }
            }
        ];
    }

    // ===== 工具收集 =====

    /**
     * 从全局管理器收集所有工具（server-tools + MCP + 插件工具）
     * 每次调用都返回最新的完整列表，不依赖缓存
     */
    _collectFreshTools() {
        const tools = [];
        if (global.localToolManager && global.localToolManager.isEnabled) {
            try { tools.push(...global.localToolManager.getToolsForLLM()); } catch { /* skip */ }
        }
        if (global.mcpManager && global.mcpManager.isEnabled) {
            try { tools.push(...global.mcpManager.getToolsForLLM()); } catch { /* skip */ }
        }
        if (global.pluginManager) {
            try {
                const pluginTools = global.pluginManager.getAllTools();
                for (const t of pluginTools) {
                    const name = (t.function || t).name || '';
                    if (!name.startsWith('world_eye_')) tools.push(t);
                }
            } catch { /* skip */ }
        }
        return tools;
    }

    // ===== 缓存管理 =====

    _cleanExpiredCache() {
        const now = Date.now();
        for (const [name, info] of this._recentTools) {
            if (now - info.lastUsed > this._cacheTTL) {
                this._recentTools.delete(name);
            }
        }
    }

    _getRecentToolsList() {
        this._cleanExpiredCache();
        if (this._recentTools.size === 0) return '';
        return Array.from(this._recentTools.keys()).join(', ');
    }

    // ===== 配置 =====

    _loadConfig() {
        this._config = this.context?.getConfig?.() || this.context?._config || null;

        try {
            const cfg = this.context.getPluginConfig();
            this._pluginConfig = { enabled: true, search_top_k: 5, cache_ttl_seconds: 300, ...cfg };
        } catch {
            this._pluginConfig = { enabled: true, search_top_k: 5, cache_ttl_seconds: 300 };
        }

        this._cacheTTL = (this._pluginConfig.cache_ttl_seconds || 300) * 1000;
    }

    _getTopK() {
        return this._pluginConfig?.search_top_k || 5;
    }

    _ensureSubAgent() {
        if (!this._subAgent) {
            const appConfig = this._config || {};
            this._subAgent = new SubAgent(appConfig, this._pluginConfig || {});
        }
    }

    /**
     * 异步精炼缩略词：检查是否有新工具缺少人工缩略词，用 LLM 生成
     * 不阻塞主流程，后台静默执行
     */
    _refineAbbreviationsAsync() {
        const needRefine = this._registry.getToolsNeedingRefinement();
        if (needRefine.length === 0) return;

        logToTerminal('info', `${PLUGIN_TAG} 发现 ${needRefine.length} 个工具缺少缩略词，后台生成中...`);

        this._ensureSubAgent();
        this._subAgent.generateAbbreviations(needRefine).then(abbrMap => {
            const count = this._registry.updateAbbreviations(abbrMap);
            if (count > 0) {
                logToTerminal('info', `${PLUGIN_TAG} 已为 ${count} 个工具生成缩略词并缓存`);
            }
        }).catch(() => {});
    }
}

module.exports = WorldEyePlugin;
