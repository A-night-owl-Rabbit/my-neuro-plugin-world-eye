// 世界之眼 (World Eye) v4 - 任务型多智能体代理路由 + 统一工作人格 + 压缩链路 + 主模型直连通讯 + 折叠协议

const fs = require('fs');
const path = require('path');
const { Plugin } = require('./lib/plugin-base.js');
const { logToTerminal, logToolAction } = require('./lib/log.js');
const { SubAgent, ROLE_PROMPT_BLOCKS } = require('./sub-agent.js');
const { buildFeiniuBackendSplitPrompt } = require('./lib/backend-split-prompt.js');

const PLUGIN_TAG = '🌍 [世界之眼]';
const TOOLS_CACHE_TTL = 60_000;
/** 协商默认轮数（v4: 默认 0 = 关闭协商以提速；用户可在配置中开启） */
const DEFAULT_NEGOTIATION_ROUNDS = 0;
/** 生图意图：不用单字「画」，避免「画质」「油画布」等误判；保留常见口语短语 */
const IMAGE_INTENT_RE = /(绘|生图|插画|海报|配图|图片|图像|封面|立绘|视觉|绘画|画图|作画|手绘|水彩|油画|素描|平面图|画一幅|画一张|画个|画只|帮我画|给.*画)/;
/** 视频生成类目标（需在 file/「保存」等分支之前匹配） */
const VIDEO_INTENT_RE = /(视频|短片|动效|mp4|gif|animation|animate|即梦|jimeng)/i;
/** 浏览器技能意图：网站/URL/网页导航/表单/抓取/测试等，优先交给 skills/agent-browser，而不是 app 启动器 */
const BROWSER_SKILL_INTENT_RE = /(https?:\/\/|www\.|\burl\b|网址|链接|网站|网页|官网|web\s*page|website|browser|浏览器|打开网页|打开网站|访问网页|访问网站|访问链接|网页自动化|浏览器自动化|网页登录|登录网站|登录网页|表单填写|填写表单|抓取页面|页面抓取|网页测试|页面测试|click\s+button|fill\s+form)/i;
const TASK_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    /** v4: 任务因信息缺口受阻，等待主模型通过 world_eye_control(action='answer') 补充信息续跑 */
    WAITING_INPUT: 'waiting_input',
};

/**
 * 「信息缺口」类失败特征（v4）：命中时任务转 waiting_input 请主模型补答，
 * 而不是直接宣告失败。覆盖：名称未匹配/歧义、未登录、前置条件缺失、参数/路径不明。
 */
const INFO_GAP_RE = /未找到|找不到|没有找到|无匹配|匹配不到|未匹配|未能.{0,15}匹配|不存在|未识别|识别失败|歧义|候选过多|多个候选|未登录|登录态|前置条件|参数缺失|路径不明|缺少.{0,10}(名称|信息|路径|参数)|需要.{0,6}(提供|确认|明确)|not\s+found|no\s+match|ambiguous|multiple\s+matches|login\s+required|not\s+logged\s+in/i;

/**
 * 插件折叠版描述（主 LLM 默认能看到的「能力概览」）。
 *
 * - 数据存放在 `plugin_short_descriptions.json`（同目录），易于人工编辑。
 * - 该文件覆盖**所有**插件（不论是否启用），但只有 delegated_plugins 勾选了的才会被主 LLM 看到。
 * - 没收录的插件回退到「智能截断」（按标点回退到完整短句）。
 * - 该映射在首次访问时懒加载并缓存；编辑 JSON 后重启插件生效。
 */
let _pluginShortDescCache = null;
function _loadPluginShortDescriptions() {
    if (_pluginShortDescCache) return _pluginShortDescCache;
    try {
        const jsonPath = path.join(__dirname, 'plugin_short_descriptions.json');
        if (fs.existsSync(jsonPath)) {
            const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const cleaned = {};
            for (const [k, v] of Object.entries(raw)) {
                // 下划线开头的 key（_readme / _updated / _format 等元数据）跳过
                if (k.startsWith('_')) continue;
                if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim();
            }
            _pluginShortDescCache = cleaned;
            return cleaned;
        }
    } catch (e) {
        logToTerminal('warn', `${PLUGIN_TAG} 读取 plugin_short_descriptions.json 失败: ${e.message}`);
    }
    _pluginShortDescCache = {};
    return _pluginShortDescCache;
}
function getPluginShortDescription(pluginId) {
    const map = _loadPluginShortDescriptions();
    return map[pluginId] || null;
}

/**
 * 智能截断：把 metadata.description 在标点处优雅截断到 maxLen 以内。
 * 没在 PLUGIN_SHORT_DESCRIPTIONS 中收录的插件回退使用。
 */
function smartTruncate(text, maxLen = 28) {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    const head = clean.slice(0, maxLen);
    // 优先在「。」「.」处截断
    const sentenceEnd = head.match(/^(.*?[。.])/);
    if (sentenceEnd && sentenceEnd[1].length >= Math.floor(maxLen * 0.5)) {
        return sentenceEnd[1];
    }
    // 否则在「，、；,;」处截断
    const lastPunct = head.match(/^(.*[，,、；;])/);
    if (lastPunct && lastPunct[1].length >= Math.floor(maxLen * 0.5)) {
        return lastPunct[1].replace(/[，,、；;]\s*$/, '') + '…';
    }
    return head + '…';
}

class WorldEyePlugin extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);

        this._pluginDir = __dirname;
        this._pluginsBaseDir = path.join(__dirname, '..', '..');
        this._subAgent = null;
        this._config = null;
        this._pluginConfig = null;

        this._allPluginsMeta = new Map();
        this._delegatedPlugins = new Map();
        this._delegatedToolNames = new Set();
        this._cachedMetaTools = null;
        this._lastToolsRefresh = 0;

        this._activeTasks = new Map();
        this._taskSeq = 0;
        this._runningRoleCounts = new Map();
        this._resourceLocks = new Map();
        this._taskQueue = [];

        /** 异步结果投递队列 */
        this._pendingResults = [];
        this._deliveryTimer = null;
        this._isDelivering = false;
        /** 结果最大存活时间（毫秒） */
        this._resultTTL = 10 * 60 * 1000;
        /** v4: 受阻任务等待主模型补充信息的最长时间（毫秒），超时自动转失败 */
        this._waitingInputTTL = 10 * 60 * 1000;
        /** v4: 受阻任务超时定时器 taskId → timer */
        this._waitingTimers = new Map();
        /** 投递检查防抖；任务结果需要立即进入主对话，排队交给 sendToLLM 单飞锁处理。 */
        this._deliveryCooldownMs = 0;
        /** eventBus 监听器引用（用于 onStop 清理） */
        this._boundOnInputEnd = null;
        this._boundOnTTSEnd = null;

    }

    async onInit() {
        this._loadConfig();
        this._ensureArchiveDir();
        logToTerminal('info', `${PLUGIN_TAG} 插件初始化完成`);
    }

    async onStart() {
        this._scanAllPlugins();
        this._syncDelegatedPluginsConfig();
        this._forceRefreshDelegatedPlugins();
        const delegatedNames = Array.from(this._delegatedPlugins.keys());
        logToTerminal('info', `${PLUGIN_TAG} 已扫描 ${this._allPluginsMeta.size} 个插件，代理 ${delegatedNames.length} 个: ${delegatedNames.join(', ') || '(无)'}`);

        this._setupAsyncDelivery();
    }

    async onConfigChanged(newConfig) {
        this._config = this.context?.getConfig?.() || this.context?._config || this._config;
        this._pluginConfig = {
            enabled: true,
            delegated_plugins: {},
            models: {},
            roles: {},
            limits: {},
            security: {},
            personality: { enabled: true },
            negotiation: { enabled: false, max_rounds: 0 },
            ...(newConfig && typeof newConfig === 'object' ? newConfig : {})
        };
        this._lastToolsRefresh = 0;
        this._forceRefreshDelegatedPlugins();

        if (this._subAgent && typeof this._subAgent.updatePluginConfig === 'function') {
            this._subAgent.updatePluginConfig(this._pluginConfig);
        }
        logToTerminal('info', `${PLUGIN_TAG} 配置已热更新，已重建代理工具缓存`);
    }

    async onStop() {
        try {
            this.context?.removeSystemPromptPatch?.('world-eye-codex-backend-split');
        } catch { }
        this._teardownAsyncDelivery();
        for (const timer of this._waitingTimers.values()) {
            clearTimeout(timer);
        }
        this._waitingTimers.clear();
    }

    // ==================== 异步结果投递系统 ====================

    _setupAsyncDelivery() {
        try {
            const { eventBus } = require(path.join(this._pluginsBaseDir, '..', 'js', 'core', 'event-bus.js'));
            this._boundOnInputEnd = () => this._scheduleDeliveryCheck();
            this._boundOnTTSEnd = () => this._scheduleDeliveryCheck();
            eventBus.on('user:input:end', this._boundOnInputEnd);
            eventBus.on('tts:end', this._boundOnTTSEnd);
            logToTerminal('info', `${PLUGIN_TAG} 异步结果投递系统已启动`);
        } catch (e) {
            logToTerminal('warn', `${PLUGIN_TAG} 异步投递事件注册失败: ${e.message}，将使用轮询兜底`);
        }
    }

    _teardownAsyncDelivery() {
        try {
            const { eventBus } = require(path.join(this._pluginsBaseDir, '..', 'js', 'core', 'event-bus.js'));
            if (this._boundOnInputEnd) eventBus.off('user:input:end', this._boundOnInputEnd);
            if (this._boundOnTTSEnd) eventBus.off('tts:end', this._boundOnTTSEnd);
        } catch { }
        if (this._deliveryTimer) {
            clearTimeout(this._deliveryTimer);
            this._deliveryTimer = null;
        }
    }

    /**
     * 将异步任务结果压入待投递队列。
     * @param {string} kind 'result' = 任务完成/失败结果；'blocked' = 受阻求助通知（v4）
     */
    _enqueueResult(taskId, taskTitle, result, kind = 'result') {
        this._pendingResults.push({
            taskId,
            taskTitle,
            result,
            kind,
            timestamp: Date.now(),
            delivered: false,
        });
        logToTerminal('info', `${PLUGIN_TAG} 任务 ${taskId} ${kind === 'blocked' ? '受阻通知' : '结果'}已入队，待投递队列长度: ${this._pendingResults.length}`);
        // 同步在工具日志里留一条任务生命周期事件，方便在 WebUI 工具日志面板看到后台进度
        logToolAction('info', `🌍 世界之眼任务${kind === 'blocked' ? '受阻待补充' : '已完成'}入队 [${taskId}] ${taskTitle}（准备立即投递，队列长度: ${this._pendingResults.length}）`);
        this._scheduleDeliveryCheck();
    }

    /**
     * 安排一次投递检查。
     */
    _scheduleDeliveryCheck() {
        if (this._deliveryTimer) clearTimeout(this._deliveryTimer);
        if (this._pendingResults.length === 0) return;
        this._deliveryTimer = setTimeout(() => {
            this._deliveryTimer = null;
            this._tryDeliverResults();
        }, this._deliveryCooldownMs);
    }

    /**
     * 投递队列中的待处理结果。
     */
    async _tryDeliverResults() {
        if (this._isDelivering) return;
        if (this._pendingResults.length === 0) return;

        this._purgeExpiredResults();
        if (this._pendingResults.length === 0) return;

        this._isDelivering = true;
        let batch = [];
        try {
            batch = this._pendingResults.splice(0, this._pendingResults.length);
            const resultItems = batch.filter(item => item.kind !== 'blocked');
            const blockedItems = batch.filter(item => item.kind === 'blocked');
            const taskIds = batch.map(b => b.taskId).join(', ');

            // 把最终结果/受阻通知写入工具日志（WebUI 工具日志面板按 [TOOL] 标记筛选展示）
            // 异步投递不走工具调用链，logToolAction 不会被 llm-handler 自动触发，需要在这里手动补一条
            for (const item of batch) {
                const safeResult = String(item.result || '').slice(0, 4000);
                logToolAction(
                    'info',
                    `🌍 世界之眼异步任务${item.kind === 'blocked' ? '受阻' : '完成'} [${item.taskId}] ${item.taskTitle}\n${item.kind === 'blocked' ? '通知' : '结果'}:\n${safeResult}`
                );
            }

            const sections = ['[内部动态上下文]'];
            if (resultItems.length > 0) {
                const resultText = resultItems
                    .map(item => `--- 任务 ${item.taskId}（${item.taskTitle}）---\n${item.result}`)
                    .join('\n\n');
                sections.push(
                    '[世界之眼异步任务结果]',
                    '以下是后台完成的任务结果。请用你自己的人设语气和风格，自然地把结果告诉用户，就像你自己完成的一样，不要提"世界之眼"或"后台任务"这些内部概念。结果直接讲重点，不需要先征询用户是否要听：',
                    resultText,
                    '[/世界之眼异步任务结果]'
                );
            }
            if (blockedItems.length > 0) {
                const blockedText = blockedItems
                    .map(item => item.result)
                    .join('\n\n');
                sections.push(
                    '[世界之眼任务受阻通知]',
                    '以下后台任务因缺少关键信息而暂停，按每条通知里的处理规则自主处理（优先从对话上下文补齐并调用 world_eye_control 的 answer 动作，不要征求用户同意）：',
                    blockedText,
                    '[/世界之眼任务受阻通知]'
                );
            }

            logToTerminal('info', `${PLUGIN_TAG} 正在投递异步消息: ${taskIds}（直达主对话，跳过主动消息冷却）`);
            const deliveryResult = await this.context.sendMessage(
                sections.join('\n'),
                { bypassExternalPolicy: true }
            );
            if (deliveryResult && deliveryResult.ok === false) {
                throw new Error(`主对话投递被拒绝: ${deliveryResult.reason || 'unknown'}`);
            }

        } catch (e) {
            logToTerminal('error', `${PLUGIN_TAG} 异步结果投递失败: ${e.message}`);
            if (batch && batch.length > 0) {
                this._pendingResults.unshift(...batch);
                logToTerminal('warn', `${PLUGIN_TAG} 异步结果已重新入队，待投递队列长度: ${this._pendingResults.length}`);
            }
        } finally {
            this._isDelivering = false;
            if (this._pendingResults.length > 0) {
                this._scheduleDeliveryCheck();
            }
        }
    }

    _isConversationIdle() {
        try {
            const { appState } = require(path.join(this._pluginsBaseDir, '..', 'js', 'core', 'app-state.js'));
            if (appState.isProcessingUserInput()) return false;
            if (appState.isPlayingTTS()) return false;
            if (appState.isProcessingBarrage()) return false;
            return true;
        } catch {
            return true;
        }
    }

    _purgeExpiredResults() {
        const now = Date.now();
        const before = this._pendingResults.length;
        this._pendingResults = this._pendingResults.filter(item => {
            if (now - item.timestamp > this._resultTTL) {
                logToTerminal('warn', `${PLUGIN_TAG} 异步结果已过期并丢弃: ${item.taskId}`);
                return false;
            }
            return true;
        });
        if (before !== this._pendingResults.length) {
            logToTerminal('info', `${PLUGIN_TAG} 清理过期结果: ${before - this._pendingResults.length} 条`);
        }
    }

    _showProgressSubtitle(text) {
        try {
            if (this.context && this.context.showSubtitle) {
                this.context.showSubtitle(text, 3000);
            }
        } catch { }
    }

    async onLLMRequest(request) {
        if (!this._pluginConfig || !this._pluginConfig.enabled) return;

        this._refreshDelegatedPluginsIfNeeded();
        if (this._delegatedPlugins.size === 0) return;

        if (Array.isArray(request.messages)) {
            this._sanitizeMessages(request.messages);
        }

        if (!Array.isArray(request.tools)) return;

        const kept = request.tools.filter(t => {
            const name = (t.function || t).name || '';
            if (name.startsWith('world_eye_')) return false;
            return !this._delegatedToolNames.has(name);
        });

        request.tools.length = 0;
        request.tools.push(...this._getMetaTools(), ...kept);
        request.tools.sort((left, right) => {
            const a = this._toolName(left);
            const b = this._toolName(right);
            if (a === b) return 0;
            return a < b ? -1 : 1;
        });
    }

    getTools() {
        if (!this._pluginConfig || !this._pluginConfig.enabled) return [];
        return this._getMetaTools();
    }

    async executeTool(name, params) {
        if (!this._pluginConfig || !this._pluginConfig.enabled) return undefined;

        if (name === 'world_eye_delegate') {
            params = params || {};
            params.mode = 'async';
            return await this._handleDelegate(params);
        }
        if (name === 'world_eye_control') {
            return this._handleControl(params || {});
        }
        if (name === 'world_eye_research') {
            params = params || {};
            params.mode = 'async';
            return await this._handleResearch(params);
        }
        if (name === 'world_eye_goal') {
            params = params || {};
            params.mode = 'async';
            return await this._handleGoal(params);
        }
        if (name === 'world_eye_inspect') {
            return this._handleInspect(params || {});
        }

        const fallbackResult = this._tryFallbackDelegation(name, params);
        if (fallbackResult !== undefined) {
            return await fallbackResult;
        }

        return undefined;
    }

    _sanitizeMessages(messages) {
        const toolNames = this._delegatedToolNames;
        if (toolNames.size === 0) return;

        const taintedCallIds = new Set();
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];

            if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
                const cleaned = msg.tool_calls.filter(tc => {
                    const fname = tc?.function?.name || '';
                    if (toolNames.has(fname)) {
                        taintedCallIds.add(tc.id);
                        return false;
                    }
                    return true;
                });

                if (cleaned.length === 0 && (!msg.content || !msg.content.trim())) {
                    messages.splice(i, 1);
                } else if (cleaned.length !== msg.tool_calls.length) {
                    msg.tool_calls = cleaned.length > 0 ? cleaned : undefined;
                }
            }

            if (msg.role === 'tool' && taintedCallIds.has(msg.tool_call_id)) {
                messages.splice(i, 1);
            }
        }
    }

    async _handleDelegate(params) {
        const taskDescription = (params.task_description || params.goal || '').trim();
        const mode = (params.mode || 'sync').toLowerCase();

        if (!taskDescription) {
            return (
                '错误: 请提供 task_description，用自然语言说明要完成的目标或操作。' +
                '不确定用哪个插件时省略 plugin_name 或改用 world_eye_goal。'
            );
        }

        /** 世界之眼内部路由已完成（goal → delegate），直接跑子智能体 */
        if (params._fromGoalRedirect) {
            return await this._executeDelegatedPluginRun(params, taskDescription, mode);
        }

        /**
         * v4 点名直通：主模型显式给出有效 plugin_name 时直接执行，跳过路由模型（省 1 次 LLM 调用）。
         * 浏览器/URL 类安全纠偏在 _executeDelegatedPluginRun 内仍然生效。
         */
        const suggestedPlugin = params.plugin_name != null ? String(params.plugin_name).trim() : '';
        const suggestedRole =
            typeof params.agent_role === 'string' && params.agent_role.trim()
                ? params.agent_role.trim()
                : undefined;

        if (suggestedPlugin) {
            this._refreshDelegatedPluginsIfNeeded();
            if (this._delegatedPlugins.has(suggestedPlugin)) {
                logToTerminal('info', `${PLUGIN_TAG} delegate: 点名插件「${suggestedPlugin}」直通执行（跳过路由模型）`);
                return await this._executeDelegatedPluginRun(
                    { ...params, plugin_name: suggestedPlugin, agent_role: suggestedRole },
                    taskDescription,
                    mode
                );
            }
            logToTerminal('warn', `${PLUGIN_TAG} delegate: 点名插件「${suggestedPlugin}」不在代理列表，回退目标路由`);
        }

        return await this._handleGoal({
            goal: taskDescription,
            mode,
            depth: params.depth,
            output: params.output,
            suggested_plugin: suggestedPlugin || undefined,
            suggested_agent_role: suggestedRole,
        });
    }

    /**
     * 世界之眼已选定插件与角色后，启动子智能体执行（含 URL→skills 安全纠偏）。
     */
    async _executeDelegatedPluginRun(params, taskDescription, mode) {
        let pluginName = params.plugin_name != null ? String(params.plugin_name).trim() : '';
        if (!pluginName) {
            return '错误: 世界之眼内部路由未提供 plugin_name。';
        }

        this._refreshDelegatedPluginsIfNeeded();

        /** 路由仍误选应用启动器时，网页/URL 类任务强制改派到 skills（与 _selectWorkflow 一致） */
        let delegateBrowserRedirect = false;
        if (
            taskDescription.trim()
            && this._inferRoleFromPlugin(pluginName) === 'app'
            && BROWSER_SKILL_INTENT_RE.test(taskDescription)
        ) {
            const skillsName = this._pickPluginsByRole('skills')[0] || 'myneuro-plugin-skills';
            if (this._delegatedPlugins.has(skillsName)) {
                logToTerminal(
                    'info',
                    `${PLUGIN_TAG} 执行阶段: 网页/URL 意图，已从应用插件「${pluginName}」纠偏至「${skillsName}」`
                );
                pluginName = skillsName;
                delegateBrowserRedirect = true;
            } else {
                return (
                    '错误: 任务涉及打开网页或访问 URL，需要浏览器自动化技能插件（例如 myneuro-plugin-skills），' +
                    '但当前未纳入世界之眼代理。请在「世界之眼」配置中启用并代理该插件后再试。'
                );
            }
        }

        const role = delegateBrowserRedirect
            ? 'skills'
            : (params.agent_role || this._inferRoleFromPlugin(pluginName));

        const info = this._delegatedPlugins.get(pluginName);
        if (!info) {
            const available = Array.from(this._delegatedPlugins.keys()).join(', ');
            return `错误: 未找到被代理的插件 "${pluginName}"。可用的代理插件: ${available || '(无)'}`;
        }

        if (!info.tools || info.tools.length === 0) {
            return `错误: 插件 "${pluginName}" 当前没有可用的工具。`;
        }

        if (role === 'code') {
            const safetyCheck = this._checkCodeTaskSafety(pluginName, taskDescription);
            if (safetyCheck) {
                return safetyCheck;
            }
        }

        const task = this._createTask({
            type: 'delegate',
            title: `${pluginName}: ${taskDescription.substring(0, 40) || '执行任务'}`,
            role,
            pluginName,
            taskDescription,
            mode,
            meta: role === 'search' ? { supersedeGroup: 'search' } : {},
        });
        if (this._isSearchLikeTask(task)) {
            this._cancelSupersededSearchTasks(task.id, `被新搜索任务 ${task.id} 替换`);
        }

        const limitCheck = this._checkRoleCapacity(role);
        const queueReason = limitCheck || '';

        if (queueReason) {
            this._enqueueTask(task.id, 'delegate', { info, options: { role, taskDescription, pluginName } }, queueReason);
            if (mode === 'async') {
                return `[任务已排队] 当前有其他任务在执行，稍后会自动开始。请用你的人设语气告诉用户你已经安排好了，不过可能需要稍等一下。\n任务ID: ${task.id}`;
            }
            return `[任务已排队] 当前有其他任务在执行，稍后会自动开始。请用你的人设语气告诉用户你已经安排好了，不过可能需要稍等一下。\n任务ID: ${task.id}`;
        }

        const runner = this._runDelegateTask(task.id, info, { role, taskDescription, pluginName });
        if (mode === 'async') {
            runner.catch(() => {});
            return `[异步任务已接受] 任务正在后台执行中，完成后会自动通知你。请用你的人设语气告诉用户你已经安排好了，可以继续聊别的。\n任务ID: ${task.id}\n任务: ${taskDescription.substring(0, 60)}`;
        }

        return await runner;
    }

    async _handleResearch(params) {
        const topic = params.topic || params.task_description || '';
        const depth = (params.depth || 'standard').toLowerCase();
        // v4: 默认 report——主对话模型投递时本来就会用自己的人设转述，persona 改写仅显式要求时执行
        const output = (params.output || 'report').toLowerCase();
        const mode = (params.mode || 'sync').toLowerCase();

        if (!topic.trim()) {
            return '错误: 缺少 topic 参数。';
        }

        const searchTools = this._getResearchToolsForPlugins(this._pickPluginsByRole('search'));
        if (searchTools.length === 0) {
            return '错误: 当前没有可用于研究任务的搜索工具，请先在世界之眼配置中启用 multi-search、bilibili-tools 或相关搜索插件。';
        }

        const task = this._createTask({
            type: 'research',
            title: `研究: ${topic.substring(0, 50)}`,
            role: 'planner',
            taskDescription: topic,
            mode,
            meta: { depth, output, supersedeGroup: 'search' },
        });
        this._cancelSupersededSearchTasks(task.id, `被新研究任务 ${task.id} 替换`);

        const plannerLimit = this._checkRoleCapacity('planner');

        if (plannerLimit) {
            this._enqueueTask(task.id, 'research', { options: { topic, depth, output } }, plannerLimit);
            if (mode === 'async') {
                return `[研究任务已排队] 当前有其他任务在执行，研究会稍后自动开始。请用你的人设语气告诉用户你已经安排好了研究，不过得等一下。\n任务ID: ${task.id}`;
            }
            return `[研究任务已排队] 当前有其他任务在执行，研究会稍后自动开始。请用你的人设语气告诉用户你已经安排好了研究，不过得等一下。\n任务ID: ${task.id}`;
        }

        const runner = this._runResearchTask(task.id, { topic, depth, output });
        if (mode === 'async') {
            runner.catch(() => {});
            return `[异步研究任务已接受] 正在后台进行研究，完成后会自动通知你。请用你的人设语气告诉用户你正在帮忙查资料/研究，可以继续聊别的。\n任务ID: ${task.id}\n主题: ${topic}`;
        }

        return await runner;
    }

    async _handleGoal(params) {
        const goal = (params.goal || params.task_description || '').trim();
        const mode = (params.mode || 'sync').toLowerCase();
        if (!goal) {
            return '错误: 缺少 goal 参数。';
        }

        const workflow = await this._selectWorkflowAccurate(goal, {
            suggested_plugin: params.suggested_plugin,
            suggested_agent_role: params.suggested_agent_role,
        });

        if (workflow.type === 'composite') {
            return await this._handleComposite({
                goal,
                templateName: workflow.templateName,
                mode,
            });
        }

        if (workflow.type === 'planned_composite') {
            return await this._handlePlannedComposite(goal, mode);
        }

        if (workflow.type === 'research') {
            return await this._handleResearch({
                topic: goal,
                depth: params.depth || 'standard',
                output: params.output || 'report',
                mode,
            });
        }

        // 已由 goal 工作流选定单一插件，禁止再次触发 delegate 的多步骤重定向（否则会 goal↔delegate 死循环）
        return await this._handleDelegate({
            plugin_name: workflow.pluginName,
            task_description: goal,
            agent_role: workflow.role,
            mode,
            _fromGoalRedirect: true,
        });
    }

    _handleControl(params) {
        const action = (params.action || '').toLowerCase();
        const taskId = params.task_id || '';

        if (action === 'list') {
            return this._listTasks();
        }
        if (action === 'queue') {
            return this._listQueue();
        }

        if (!taskId) {
            if (action === 'status') {
                return this._listTasks();
            }
            return '错误: 该控制动作需要 task_id。';
        }

        const task = this._activeTasks.get(taskId);
        if (!task) {
            return `未找到任务: ${taskId}`;
        }

        if (action === 'stop' || action === 'cancel') {
            task.abortController.abort();
            task.status = TASK_STATUS.CANCELLED;
            task.updatedAt = Date.now();
            this._clearWaitingTimer(task.id);
            logToTerminal('info', `${PLUGIN_TAG} 任务已中止: ${task.id}`);
            return `已请求中止任务: ${task.id}`;
        }

        if (action === 'answer') {
            const answer = String(params.answer || '').trim();
            if (!answer) {
                return '错误: answer 动作需要提供 answer 参数（补充信息内容）。';
            }
            if (task.status !== TASK_STATUS.WAITING_INPUT) {
                return `错误: 任务 ${task.id} 当前状态为 ${task.status}，不在等待补充信息状态，无法 answer。`;
            }
            return this._resumeWaitingTask(task, answer);
        }

        if (action === 'status') {
            return this._formatTaskStatus(task);
        }

        if (action === 'result') {
            return task.result || this._formatTaskStatus(task);
        }
        if (action === 'raw_result') {
            return JSON.stringify(task.structuredResult || {}, null, 2);
        }

        return '未知的控制动作。支持: status, stop, cancel, result, raw_result, list, queue, answer';
    }

    // ==================== 折叠协议 (Context Folding) ====================

    /**
     * world_eye_inspect returns detail as a tool result. Keeping it in the
     * tool turn preserves the main system prefix for prompt caching.
     */
    _handleInspect(params) {
        this._refreshDelegatedPluginsIfNeeded();
        const pluginName = params.plugin_name != null ? String(params.plugin_name).trim() : '';

        if (!pluginName) {
            // 全量索引
            if (this._delegatedPlugins.size === 0) return '错误: 当前没有任何被代理的插件。';
            const sections = [];
            for (const [name, info] of this._sortedDelegatedEntries()) {
                sections.push(this._renderPluginDetail(name, info));
            }
            const detail = sections.join('\n\n');
            return detail;
        }

        const info = this._delegatedPlugins.get(pluginName);
        if (!info) {
            const available = Array.from(this._delegatedPlugins.keys()).sort().join(', ');
            return `错误: 未找到代理插件 "${pluginName}"。可用插件: ${available || '(无)'}`;
        }

        return this._renderPluginDetail(pluginName, info);
    }

    /**
     * 渲染单个插件的详细信息（描述 + 工具列表 + 角色映射）。
     */
    _renderPluginDetail(name, info) {
        const display = info.metadata?.displayName || name;
        const desc = (info.metadata?.description || '').trim();
        const role = this._inferRoleFromPlugin(name);

        const lines = [];
        lines.push(`### ${name}（${display}）`);
        if (desc) lines.push(`- 描述: ${desc}`);
        lines.push(`- 由世界之眼内部 ${role} 角色调度`);
        const tools = this._canonicalToolList(info.tools || []);
        if (tools.length === 0) {
            lines.push('- 工具列表: （无）');
        } else {
            lines.push(`- 工具列表（${tools.length} 个）:`);
            for (const t of tools) {
                const fn = t.function || t;
                const tn = (fn.name || '').trim();
                if (!tn) continue;
                const td = (fn.description || '').replace(/\s+/g, ' ').trim();
                const tdShort = td.length > 200 ? td.slice(0, 200) + '…' : td;
                lines.push(`  - \`${tn}\`: ${tdShort || '（无描述）'}`);
            }
        }
        return lines.join('\n');
    }

    // ==================== 协商交接 (Negotiated Handoff) ====================

    /**
     * 封装一次「上游 → 下游」交接，允许下游对上游做 ≤maxRounds 轮的 Q&A 澄清。
     *
     * 参数：
     *   - upstreamRole, downstreamRole
     *   - downstreamTask: 给下游的任务描述
     *   - downstreamTools: 给下游的工具定义（可为空数组）
     *   - downstreamExtraContext: 给下游的初始 extraContext（含 fromRole handoff 信件）
     *   - downstreamPluginName / downstreamPluginDescription: 可选，下游绑定的插件
     *   - upstreamRefineContext: 上游在澄清时能看到的背景上下文
     *   - signal: AbortSignal
     *   - workerLabelPrefix: 日志 workerLabel 前缀
     *   - maxRounds: 默认 DEFAULT_NEGOTIATION_ROUNDS=2
     */
    /**
     * 旧接口：返回字符串。所有外部调用方零修改。
     */
    async _negotiateTransition(opts) {
        const detailed = await this._negotiateTransitionDetailed(opts);
        return detailed.content;
    }

    /**
     * 带状态版本：返回 { status, content, lastToolError? } 结构体。
     * 仅由 _executeCompositeStep 调用，复合工作流据此判定 completed/failed。
     */
    async _negotiateTransitionDetailed(opts) {
        const {
            upstreamRole, downstreamRole,
            downstreamTask, downstreamTools = [], downstreamExtraContext = [],
            downstreamPluginName = null, downstreamPluginDescription = '',
            upstreamRefineContext = [], signal,
            workerLabelPrefix = `${downstreamRole}-task`,
        } = opts;

        const negotiationEnabled = this._isNegotiationEnabled();
        const maxRounds = negotiationEnabled ? this._getNegotiationMaxRounds() : 0;
        let currentContext = [...downstreamExtraContext];

        for (let round = 0; round <= maxRounds; round++) {
            if (signal?.aborted) return { status: 'aborted', content: '任务已被中止。' };

            const isLastRound = round === maxRounds;
            const runtimeOpts = {
                role: downstreamRole,
                taskDescription: downstreamTask,
                toolDefinitions: downstreamTools,
                signal,
                extraContext: currentContext,
                workerLabel: `${workerLabelPrefix}-r${round}`,
                isTemporaryWorker: true,
                negotiationContext: negotiationEnabled ? {
                    currentRound: round,
                    maxRounds,
                    forceExecute: isLastRound,
                } : null,
            };

            let result;
            if (downstreamPluginName && downstreamPluginDescription) {
                result = await this._subAgent.executeWithStatus(
                    downstreamPluginName,
                    downstreamTask,
                    downstreamPluginDescription,
                    downstreamTools,
                    signal,
                    runtimeOpts
                );
            } else {
                result = await this._subAgent.runWithStatus(runtimeOpts);
            }

            // 协商：下游返回 question
            if (result.status === 'question') {
                if (isLastRound) {
                    logToTerminal('warn', `${PLUGIN_TAG} ⚠ ${downstreamRole} 在最后一轮仍提问，已忽略，按现状返回。`);
                    return {
                        status: 'max_rounds',
                        content: result.raw || '下游未能在限定轮数内完成任务。',
                    };
                }
                this._logNegotiationQ(round + 1, maxRounds, downstreamRole, upstreamRole, result.question);

                const refineTaskDesc = [
                    `下游 ${downstreamRole} 对你之前的交接产生了疑虑。请用你的思考方式直接回答以解决他的疑虑，不要重新写完整计划/报告，1-3 句话即可。`,
                    '',
                    '下游的疑虑：',
                    result.question,
                ].join('\n');

                let refined;
                try {
                    refined = await this._subAgent.run({
                        role: upstreamRole,
                        taskDescription: refineTaskDesc,
                        toolDefinitions: [],
                        signal,
                        extraContext: upstreamRefineContext,
                        workerLabel: `${upstreamRole}-refine-${workerLabelPrefix}-r${round}`,
                        isTemporaryWorker: true,
                        negotiationContext: null, // 上游澄清不再协商
                        maxIterations: 2,
                    });
                } catch {
                    refined = `（${upstreamRole} 在澄清阶段失败，请按现有信息继续）`;
                }

                const refinedText = typeof refined === 'string' ? refined : (refined?.raw || '');
                this._logNegotiationA(round + 1, maxRounds, upstreamRole, downstreamRole, refinedText);

                currentContext.push({
                    title: `${upstreamRole} 的澄清回应（第 ${round + 1} 轮）`,
                    content: refinedText,
                    fromRole: upstreamRole,
                    isClarification: true,
                });
                continue;
            }

            // 完成（透传 sub-agent 的状态）
            return result;
        }

        return { status: 'max_rounds', content: '协商达到上限但未获结果。' };
    }

    _isNegotiationEnabled() {
        const cfg = this._pluginConfig?.negotiation;
        if (!cfg) return false; // v4: 默认关闭（提速）；配置显式开启才协商
        return cfg.enabled === true;
    }

    _getNegotiationMaxRounds() {
        const cfg = this._pluginConfig?.negotiation;
        const raw = Number(cfg?.max_rounds);
        if (!Number.isFinite(raw) || raw < 0) return DEFAULT_NEGOTIATION_ROUNDS;
        return Math.min(5, Math.max(0, Math.trunc(raw)));
    }

    /** 返回用户配置的 LLM 超时（毫秒），兼容新老 schema。默认 120 秒。 */
    _getConfiguredLlmTimeoutMs() {
        const newVal = Number(this._pluginConfig?.limits?.llm_timeout_ms);
        if (Number.isFinite(newVal) && newVal > 0) return newVal;
        const oldVal = Number(this._pluginConfig?.sub_agent?.llm_request_timeout_ms);
        if (Number.isFinite(oldVal) && oldVal > 0) return oldVal;
        return 120000;
    }

    /** 打印一次 handoff 日志 */
    _logHandoff(fromRole, toRole) {
        logToTerminal('info', `${PLUGIN_TAG} Handoff: ${fromRole} → ${toRole}`);
    }

    _logNegotiationQ(round, max, downRole, upRole, question) {
        logToTerminal('info', `${PLUGIN_TAG} Handoff-Q[${round}/${max}]: ${downRole} → ${upRole}`);
        const lines = question.split(/\r?\n/).filter(l => l.trim()).slice(0, 3);
        for (const line of lines) {
            const truncated = line.length > 120 ? line.slice(0, 120) + '…' : line;
            logToTerminal('info', `${PLUGIN_TAG}    疑虑: "${truncated}"`);
        }
    }

    _logNegotiationA(round, max, upRole, downRole, answer) {
        logToTerminal('info', `${PLUGIN_TAG} Handoff-A[${round}/${max}]: ${upRole} → ${downRole}`);
        const first = answer.split(/\r?\n/).find(l => l.trim()) || '';
        const cleaned = first.replace(/^---\s*$/, '').trim();
        const truncated = cleaned.length > 120 ? cleaned.slice(0, 120) + '…' : cleaned;
        if (truncated) {
            logToTerminal('info', `${PLUGIN_TAG}    回应: "${truncated}"`);
        }
    }

    _getMetaTools() {
        if (!this._cachedMetaTools) {
            this._cachedMetaTools = this._buildMetaTools();
        }
        // Callers are allowed to compose or normalize tool objects. Return a
        // copy so those changes never mutate the cache-stable template.
        return this._cloneTools(this._cachedMetaTools);
    }

    _buildMetaTools() {
        // 折叠版插件清单：每插件 1 行
        // 优先用 plugin_short_descriptions.json（人工归纳的能力概览，覆盖所有插件）
        // 没收录的插件回退到 smartTruncate（按标点优雅截断 metadata.description）
        // 只遍历 _delegatedPlugins —— 这就保证主 LLM 只看得到「启用且代理」的插件
        const foldedPluginLines = this._collectFoldedPluginLines();
        const splitPrompt = this._applyBackendSplitPrompt(foldedPluginLines);

        if (foldedPluginLines.length === 0) return [];

        const folded = foldedPluginLines.join('\n');

        const goalDesc = [
            splitPrompt,
            '',
            '[世界之眼·目标入口] 把目标交给后台执行体系，立即返回 task_id，结果在后台完成时自动推送给你。',
            '适用：单步动作（生图/搜索/写代码）、多步组合（先...再...）、研究类（联网调研写报告）。',
            '',
            '★ 先看上面的世界之眼清单。清单覆盖的目标才用本工具；清单覆盖不了的电脑任务改用 codex_delegate。',
            '★ 不要把清单外的目标丢进本工具碰运气。',
            '★ 不确定某个具体工具签名时，先调 `world_eye_inspect`。',
            '',
            '当前后台代理插件（注意: 每行是该插件能力的**极简缩写**，不代表完整能力与工具列表；对能力有疑问先用 world_eye_inspect 查完整工具签名）:',
            folded,
        ].join('\n');

        const delegateDesc = [
            splitPrompt,
            '',
            '[世界之眼·点名委派] 把任务交给后台指定插件执行（异步返回 task_id）。',
            '适用：你已经明确知道要用哪个插件做什么（已 inspect 过或对插件签名很熟）。',
            '★ plugin_name 有效时将被**直接采纳**执行（不再经过内部路由，速度更快；仅保留浏览器/URL 类安全纠偏）。',
            '★ 因此点名前必须确认插件能力——不确定就先 `world_eye_inspect`，或改用 `world_eye_goal` 让内部路由选。',
            '不确定是否在清单里，也不要猜，改用 Codex。',
            '',
            '★ task_description 描述要达成什么结果或执行什么操作。',
            '',
            '可用插件（注意: 每行是极简缩写，不是完整能力清单；点名前先 inspect）:',
            folded,
        ].join('\n');

        const researchDesc = [
            '[世界之眼·研究流水线] 提交一个研究主题，后台自动完成搜索→审查→报告（按深度自动增减环节）。',
            '适用：主题研究、资料综述、趋势分析、来源考证。异步返回 task_id。',
            '当你判断旧搜索方向错了并提交新的研究/搜索任务时，世界之眼会自动中止仍在运行或排队的旧搜索任务，避免旧结果继续回流。',
        ].join('\n');

        const inspectDesc = [
            '[世界之眼·插件详情探针] 查看某个代理插件的完整工具签名（不执行任务，仅查询）。',
            '用法：plugin_name 留空 → 返回所有插件的完整索引；填具体名 → 返回单插件详情。',
            '★ 硬规则: 清单里每行插件描述只是极简缩写。凡是与插件能力边界有关的判断（能不能做、该给谁做、工具叫什么），以 inspect 结果为准。',
            '★ 显式调用 world_eye_delegate(plugin_name=X) 之前必须先 inspect 一次（除非本轮对话中已查过）。',
            '调用后详情会作为工具结果留在当前对话，供后续决策参考。',
        ].join('\n');

        const controlDesc = [
            '[世界之眼·任务控制] 查询/停止/补答任务。动作 status/result/raw_result/list/queue/stop/cancel/answer。',
            '★ answer: 对处于 waiting_input（受阻等待补充信息）的任务提供补充信息并自动续跑。收到「任务受阻」通知时，优先从对话上下文补齐信息后立即调用本动作，不要征求用户同意。',
            '新研究/搜索会自动替换旧搜索；control 主要用于明确指定某个任务。',
        ].join('\n');

        return [
            {
                type: 'function',
                function: {
                    name: 'world_eye_goal',
                    description: goalDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            goal: {
                                type: 'string',
                                description: '任务目标（自然语言）。单步或多步复合目标都可以；复合目标请完整描述，不要拆分。'
                            },
                            depth: {
                                type: 'string',
                                description: '当目标被识别为研究任务时使用的深度（默认 standard；quick 最快）',
                                enum: ['quick', 'standard', 'deep']
                            },
                            output: {
                                type: 'string',
                                description: '研究输出类型。默认 report；通常不需要 report+persona（你收到结果后本来就会用自己的语气转述）',
                                enum: ['summary', 'report', 'report+persona']
                            }
                        },
                        required: ['goal']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_delegate',
                    description: delegateDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            plugin_name: {
                                type: 'string',
                                description: '可选。要使用的代理插件 id；有效时直接采纳执行（不经内部路由）。点名前先用 world_eye_inspect 确认能力。无效或省略时回退目标路由。',
                            },
                            task_description: {
                                type: 'string',
                                description: '要完成的目标或操作。'
                            },
                            agent_role: {
                                type: 'string',
                                description: '可选。执行角色；省略时按插件自动推断。',
                                enum: ['general', 'planner', 'search', 'music', 'image', 'video', 'code', 'file', 'app', 'skills', 'reviewer', 'reporter', 'synthesizer', 'persona']
                            },
                            depth: {
                                type: 'string',
                                description: '任务被识别为研究类时使用的深度',
                                enum: ['quick', 'standard', 'deep']
                            },
                            output: {
                                type: 'string',
                                description: '任务被识别为研究类时使用的输出类型',
                                enum: ['summary', 'report', 'report+persona']
                            }
                        },
                        required: ['task_description']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_research',
                    description: researchDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            topic: { type: 'string', description: '研究主题' },
                            depth: { type: 'string', description: '默认 standard；quick 最快，deep 最全但最慢', enum: ['quick', 'standard', 'deep'] },
                            output: { type: 'string', description: '默认 report；通常不需要 report+persona（你会自己转述结果）', enum: ['summary', 'report', 'report+persona'] }
                        },
                        required: ['topic']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_inspect',
                    description: inspectDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            plugin_name: {
                                type: 'string',
                                description: '可选。要查询的插件 id（必须与代理列表中的 id 一致）。留空则返回所有插件的完整索引。'
                            }
                        }
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_control',
                    description: controlDesc,
                    parameters: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                enum: ['status', 'stop', 'cancel', 'result', 'raw_result', 'list', 'queue', 'answer']
                            },
                            task_id: { type: 'string', description: '任务ID。list/queue 可省略。' },
                            answer: { type: 'string', description: 'answer 动作必填：给受阻任务的补充信息（如准确名称、路径、账号说明）。' }
                        },
                        required: ['action']
                    }
                }
            }
        ];
    }

    _scanAllPlugins() {
        this._allPluginsMeta.clear();
        const builtinDir = path.join(this._pluginsBaseDir, 'built-in');
        const communityDir = path.join(this._pluginsBaseDir, 'community');

        for (const baseDir of [builtinDir, communityDir]) {
            if (!fs.existsSync(baseDir)) continue;
            let entries;
            try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { continue; }

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const metaPath = path.join(baseDir, entry.name, 'metadata.json');
                if (!fs.existsSync(metaPath)) continue;

                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                    if (meta.name && meta.name !== 'world-eye') {
                        this._allPluginsMeta.set(meta.name, meta);
                    }
                } catch { }
            }
        }
    }

    _refreshDelegatedPluginsIfNeeded() {
        const now = Date.now();
        if (now - this._lastToolsRefresh < TOOLS_CACHE_TTL) return;
        this._forceRefreshDelegatedPlugins();
    }

    _forceRefreshDelegatedPlugins() {
        this._delegatedPlugins.clear();
        this._delegatedToolNames.clear();
        this._cachedMetaTools = null;

        const delegatedCfg = this._pluginConfig?.delegated_plugins || {};
        for (const [name, enabled] of Object.entries(delegatedCfg).sort(
            ([left], [right]) => left.localeCompare(right)
        )) {
            if (!enabled) continue;

            const plugin = global.pluginManager?.getPlugin(name);
            if (!plugin) continue;

            const meta = this._allPluginsMeta.get(name);
            if (!meta) continue;

            let tools = [];
            try {
                tools = plugin.getTools() || [];
            } catch { }

            const stableTools = this._canonicalToolList(tools);
            this._delegatedPlugins.set(name, { metadata: meta, tools: stableTools });
            for (const t of stableTools) {
                const toolName = (t.function || t).name || '';
                if (toolName) this._delegatedToolNames.add(toolName);
            }
        }

        this._lastToolsRefresh = Date.now();
        this._applyBackendSplitPrompt(this._collectFoldedPluginLines());
    }

    _collectFoldedPluginLines() {
        const foldedPluginLines = [];
        for (const [name, info] of this._sortedDelegatedEntries()) {
            const short = getPluginShortDescription(name)
                || smartTruncate(info.metadata?.description || '', 28);
            foldedPluginLines.push(`- ${name}: ${short}`);
        }
        return foldedPluginLines;
    }

    _applyBackendSplitPrompt(foldedPluginLines) {
        const splitPrompt = buildFeiniuBackendSplitPrompt(foldedPluginLines);
        this.context?.addSystemPromptPatch?.('world-eye-codex-backend-split', splitPrompt);
        return splitPrompt;
    }

    _sortedDelegatedEntries() {
        return Array.from(this._delegatedPlugins.entries())
            .sort(([left], [right]) => left.localeCompare(right));
    }

    _toolName(tool) {
        return String(tool?.function?.name || tool?.name || '');
    }

    _canonicalToolList(tools) {
        return this._cloneTools(tools).sort((left, right) => {
            const a = this._toolName(left);
            const b = this._toolName(right);
            if (a === b) return 0;
            return a < b ? -1 : 1;
        });
    }

    _cloneTools(tools) {
        try {
            return JSON.parse(JSON.stringify(Array.isArray(tools) ? tools : []));
        } catch (_) {
            return Array.isArray(tools) ? tools.map(tool => ({ ...tool })) : [];
        }
    }

    /**
     * 同步 plugin_config.json schema：
     * - delegated_plugins 仅显示插件名（无 description），UI 简洁
     * - 单一 roles 表合并 role_plugin_bindings + role_model_mapping
     * - 单一 limits 块合并 task_limits + sub_agent 的超时/重试
     * - personality / negotiation 只暴露最常用的开关
     * - 老 schema (agent_models / sub_agent / role_plugin_bindings / role_model_mapping / model_groups / task_limits)
     *   通过 _migrateOldConfigToNew 一次性迁移有用的值
     */
    _syncDelegatedPluginsConfig() {
        const configPath = path.join(this._pluginDir, 'plugin_config.json');
        let raw = {};
        try {
            if (fs.existsSync(configPath)) {
                raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch { }

        const hadLegacyKeys = !!(raw.model_groups || raw.role_plugin_bindings || raw.role_model_mapping
            || raw.task_limits || raw.agent_models || raw.sub_agent);
        raw = this._migrateOldConfigToNew(raw);
        if (hadLegacyKeys) {
            logToTerminal('info', `${PLUGIN_TAG} 已将老配置一次性迁移到新 schema（更紧凑、规整）`);
        }

        // 1. enabled
        if (!raw.enabled || typeof raw.enabled !== 'object' || !('value' in raw.enabled)) {
            const prev = typeof raw.enabled === 'boolean' ? raw.enabled : true;
            raw.enabled = {
                title: '启用插件',
                description: '是否启用世界之眼插件代理路由',
                type: 'bool',
                default: true,
                value: prev
            };
        }

        // 2. delegated_plugins —— 仅 title + bool，**不带 description**
        if (!raw.delegated_plugins || typeof raw.delegated_plugins !== 'object') {
            raw.delegated_plugins = {
                title: '代理插件',
                description: '勾选要由世界之眼托管的插件',
                type: 'object',
                fields: {}
            };
        }
        if (!raw.delegated_plugins.fields) raw.delegated_plugins.fields = {};
        const existingPluginFields = raw.delegated_plugins.fields;
        const newPluginFields = {};
        for (const [name, meta] of this._allPluginsMeta) {
            const oldValue = existingPluginFields[name]?.value;
            newPluginFields[name] = {
                title: meta.displayName || name,
                type: 'bool',
                default: false,
                value: oldValue === true
            };
            // 注意：UI 仅显示 title + 勾选框，不再展示长 description
        }
        raw.delegated_plugins.fields = newPluginFields;

        // 3. models —— 模型分组（保留 deepseek / qwen_coder 两组默认）
        if (!raw.models || typeof raw.models !== 'object') {
            raw.models = {
                title: '模型分组',
                description: '可复用的模型组（API地址+密钥+模型名），在 roles 表中通过组名引用',
                type: 'object',
                fields: {}
            };
        }
        if (!raw.models.fields) raw.models.fields = {};
        const MODEL_DEFAULTS = {
            deepseek: { model: 'deepseek-ai/DeepSeek-V3.2' },
            qwen_coder: { model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' },
        };
        for (const [groupName, defaults] of Object.entries(MODEL_DEFAULTS)) {
            if (!raw.models.fields[groupName]) {
                raw.models.fields[groupName] = {
                    title: groupName,
                    type: 'object',
                    fields: {
                        provider_id: {
                            title: 'LLM 提供商',
                            description: '优先从“LLM 配置”引用提供商；留空时兼容下方旧 API 字段。',
                            type: 'llm_provider',
                            default: '',
                            value: ''
                        },
                        model_id: {
                            title: 'LLM 模型',
                            description: '选择该提供商下的模型；留空时自动选择。',
                            type: 'llm_model',
                            provider_field: `models.${groupName}.provider_id`,
                            default: '',
                            value: ''
                        },
                        api_url: { title: 'API 地址', type: 'string', default: '', value: '' },
                        api_key: { title: 'API Key', type: 'string', default: '', value: '' },
                        model: { title: '模型名', type: 'string', default: defaults.model, value: '' }
                    }
                };
            }
        }
        for (const [groupName, group] of Object.entries(raw.models.fields)) {
            if (!group || typeof group !== 'object') continue;
            if (!group.fields) group.fields = {};
            if (!group.fields.provider_id) {
                group.fields.provider_id = {
                    title: 'LLM 提供商',
                    description: '优先从“LLM 配置”引用提供商；留空时兼容下方旧 API 字段。',
                    type: 'llm_provider',
                    default: '',
                    value: ''
                };
            }
            if (!group.fields.model_id) {
                group.fields.model_id = {
                    title: 'LLM 模型',
                    description: '选择该提供商下的模型；留空时自动选择。',
                    type: 'llm_model',
                    provider_field: `models.${groupName}.provider_id`,
                    default: '',
                    value: ''
                };
            } else {
                group.fields.model_id.provider_field = `models.${groupName}.provider_id`;
            }
            for (const legacyKey of ['api_url', 'api_key', 'model']) {
                const legacy = group.fields[legacyKey];
                if (legacy && typeof legacy === 'object') {
                    legacy.description = '旧版手填字段：只有提供商下拉留空、且地址/Key/模型都填全时才生效。建议改用提供商下拉选择。';
                }
            }
        }

        // 4. roles —— 合并 role_plugin_bindings + role_model_mapping 为单一表
        const ROLE_DEFAULTS = {
            planner:     { title: 'planner（规划）',    model_group: 'deepseek',   plugins: '' },
            router:      { title: 'router（路由）',     model_group: 'deepseek',   plugins: '' },
            search:      { title: 'search（搜索）',     model_group: 'qwen_coder', plugins: 'multi-search,bilibili-tools,kimi-search,glm-search' },
            reviewer:    { title: 'reviewer（审查）',   model_group: 'deepseek',   plugins: '' },
            reporter:    { title: 'reporter（报告）',   model_group: 'deepseek',   plugins: '' },
            synthesizer: { title: 'synthesizer（汇总）', model_group: 'deepseek',   plugins: '' },
            persona:     { title: 'persona（口语化改写）', model_group: 'deepseek',   plugins: '' },
            code:        { title: 'code（代码）',       model_group: 'deepseek',   plugins: 'code-executor' },
            music:       { title: 'music（音乐）',      model_group: 'qwen_coder', plugins: 'minimax-music,rebirth-feiniu-music' },
            image:       { title: 'image（生图）',      model_group: 'qwen_coder', plugins: 'openrouter-image' },
            video:       { title: 'video（视频）',      model_group: 'qwen_coder', plugins: 'jimeng-video' },
            file:        { title: 'file（文件）',       model_group: 'qwen_coder', plugins: 'mcp-filesystem,txt-writer' },
            app:         { title: 'app（应用）',        model_group: 'qwen_coder', plugins: 'windows-app-launcher' },
            skills:      { title: 'skills（技能）',     model_group: 'qwen_coder', plugins: 'myneuro-plugin-skills' },
            general:     { title: 'general（兜底）',    model_group: 'qwen_coder', plugins: '' },
        };
        if (!raw.roles || typeof raw.roles !== 'object') {
            raw.roles = {
                title: '角色配置（每行 = 一个 agent 的「模型组 + 默认插件」）',
                type: 'object',
                fields: {}
            };
        }
        if (!raw.roles.fields) raw.roles.fields = {};
        for (const [roleKey, def] of Object.entries(ROLE_DEFAULTS)) {
            const existing = raw.roles.fields[roleKey];
            if (!existing) {
                raw.roles.fields[roleKey] = {
                    title: def.title,
                    type: 'object',
                    fields: {
                        model_group: { title: '模型组', type: 'string', default: def.model_group, value: def.model_group },
                        plugins: { title: '默认插件', type: 'string', default: def.plugins, value: def.plugins }
                    }
                };
            } else {
                existing.title = def.title;
                if (!existing.fields) existing.fields = {};
                if (!existing.fields.model_group) {
                    existing.fields.model_group = { title: '模型组', type: 'string', default: def.model_group, value: def.model_group };
                }
                if (!existing.fields.plugins) {
                    existing.fields.plugins = { title: '默认插件', type: 'string', default: def.plugins, value: def.plugins };
                }
            }
        }

        // 5. limits —— task_limits + sub_agent.{timeout,retries} 合并
        if (!raw.limits || typeof raw.limits !== 'object') {
            raw.limits = {
                title: '运行限制',
                type: 'object',
                fields: {
                    max_tasks: { title: '并发任务上限', type: 'int', default: 6, value: 6 },
                    max_code_tasks: { title: '并发代码任务上限', type: 'int', default: 1, value: 1 },
                    llm_timeout_ms: { title: 'LLM 超时(ms)', type: 'int', default: 120000, value: 120000 },
                    llm_retries: { title: '超时重试次数', type: 'int', default: 2, value: 2 }
                }
            };
        }

        // 6. security
        if (!raw.security || typeof raw.security !== 'object') {
            raw.security = {
                title: '安全',
                type: 'object',
                fields: {
                    code_execution_enabled: { title: '允许代码执行', type: 'bool', default: true, value: true },
                    code_allowed_plugins: { title: '代码执行白名单', type: 'string', default: 'code-executor', value: 'code-executor' },
                    block_dangerous_commands: { title: '拦截高危命令', type: 'bool', default: true, value: true }
                }
            };
        }

        // 7. personality —— 只暴露 enabled 总开关（v4: 统一工作人格，非角色扮演）
        if (!raw.personality || typeof raw.personality !== 'object') {
            raw.personality = {
                title: '世界之眼人格',
                type: 'object',
                fields: {
                    enabled: { title: '启用统一工作人格', type: 'bool', default: true, value: true }
                }
            };
        }

        // 8. negotiation —— 暴露 enabled + max_rounds（v4: 默认关闭以提速）
        if (!raw.negotiation || typeof raw.negotiation !== 'object') {
            raw.negotiation = {
                title: '协商交接',
                type: 'object',
                fields: {
                    enabled: { title: '启用协商', type: 'bool', default: false, value: false },
                    max_rounds: { title: '每交接最大轮数', type: 'int', default: 0, value: 0 }
                }
            };
        }

        // 删除所有老 schema 残留字段（迁移已把有用值搬走）
        delete raw.agent_models;
        delete raw.sub_agent;
        delete raw.role_plugin_bindings;
        delete raw.role_model_mapping;
        delete raw.model_groups;
        delete raw.task_limits;

        try {
            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
        } catch (e) {
            logToTerminal('warn', `${PLUGIN_TAG} 写入 plugin_config.json 失败: ${e.message}`);
        }

        this._loadConfig();

        // 通知已实例化的 SubAgent 同步最新配置
        if (this._subAgent && typeof this._subAgent.updatePluginConfig === 'function') {
            this._subAgent.updatePluginConfig(this._pluginConfig);
        }
    }

    /**
     * 一次性迁移老配置到新 schema。
     * 保留 API Key / 模型名 / 已勾选插件 / 角色绑定等用户数据。
     */
    _migrateOldConfigToNew(raw) {
        if (!raw || typeof raw !== 'object') return raw;

        const getNestedValue = (obj, ...keys) => {
            let cur = obj;
            for (const k of keys) {
                if (cur && typeof cur === 'object' && k in cur) cur = cur[k];
                else return undefined;
            }
            return cur;
        };

        // 1. model_groups → models
        if (raw.model_groups && !raw.models) {
            const newModels = {
                title: '模型分组',
                description: '可复用的模型组（API地址+密钥+模型名），在 roles 表中通过组名引用',
                type: 'object',
                fields: {}
            };
            const groupsFields = raw.model_groups.fields || {};
            for (const [groupName, groupDef] of Object.entries(groupsFields)) {
                const gf = groupDef?.fields || {};
                newModels.fields[groupName] = {
                    title: groupName,
                    type: 'object',
                    fields: {
                        provider_id: {
                            title: 'LLM 提供商',
                            description: '优先从“LLM 配置”引用提供商；留空时兼容下方旧 API 字段。',
                            type: 'llm_provider',
                            default: '',
                            value: getNestedValue(gf, 'provider_id', 'value') || ''
                        },
                        model_id: {
                            title: 'LLM 模型',
                            description: '选择该提供商下的模型；留空时自动选择。',
                            type: 'llm_model',
                            provider_field: `models.${groupName}.provider_id`,
                            default: '',
                            value: getNestedValue(gf, 'model_id', 'value') || ''
                        },
                        api_url: {
                            title: 'API 地址', type: 'string',
                            default: getNestedValue(gf, 'api_url', 'default') || '',
                            value: getNestedValue(gf, 'api_url', 'value') || ''
                        },
                        api_key: {
                            title: 'API Key', type: 'string',
                            default: '',
                            value: getNestedValue(gf, 'api_key', 'value') || ''
                        },
                        model: {
                            title: '模型名', type: 'string',
                            default: getNestedValue(gf, 'model', 'default') || '',
                            value: getNestedValue(gf, 'model', 'value') || ''
                        }
                    }
                };
            }
            raw.models = newModels;
        }

        // 2. role_plugin_bindings + role_model_mapping → roles
        if (!raw.roles && (raw.role_plugin_bindings || raw.role_model_mapping)) {
            const pluginsFields = raw.role_plugin_bindings?.fields || {};
            const modelMapFields = raw.role_model_mapping?.fields || {};
            const allRoleKeys = new Set([
                ...Object.keys(pluginsFields),
                ...Object.keys(modelMapFields),
            ]);

            const newRoles = {
                title: '角色配置（每行 = 一个 agent 的「模型组 + 默认插件」）',
                type: 'object',
                fields: {}
            };
            for (const roleKey of allRoleKeys) {
                const pluginsValue = getNestedValue(pluginsFields, roleKey, 'value') || '';
                const modelGroupValue = getNestedValue(modelMapFields, roleKey, 'value') || '';
                newRoles.fields[roleKey] = {
                    title: roleKey,
                    type: 'object',
                    fields: {
                        model_group: { title: '模型组', type: 'string', default: '', value: modelGroupValue },
                        plugins: { title: '默认插件', type: 'string', default: '', value: pluginsValue }
                    }
                };
            }
            raw.roles = newRoles;
        }

        // 3. task_limits + sub_agent.{timeout,retries} → limits
        if (!raw.limits && (raw.task_limits || raw.sub_agent)) {
            const tlFields = raw.task_limits?.fields || {};
            const saFields = raw.sub_agent?.fields || {};
            raw.limits = {
                title: '运行限制',
                type: 'object',
                fields: {
                    max_tasks: { title: '并发任务上限', type: 'int', default: 6, value: getNestedValue(tlFields, 'max_concurrent_tasks', 'value') ?? 6 },
                    max_code_tasks: { title: '并发代码任务上限', type: 'int', default: 1, value: getNestedValue(tlFields, 'max_concurrent_code_tasks', 'value') ?? 1 },
                    llm_timeout_ms: { title: 'LLM 超时(ms)', type: 'int', default: 120000, value: getNestedValue(saFields, 'llm_request_timeout_ms', 'value') ?? 120000 },
                    llm_retries: { title: '超时重试次数', type: 'int', default: 2, value: getNestedValue(saFields, 'llm_retries_per_round', 'value') ?? 2 }
                }
            };
        }

        // 4. sub_agent 上的 API Key 兜底：若 models 里 deepseek / qwen_coder 的 url/key 都还是空，
        //    把老 sub_agent 的 url/key 灌进去（model 不动）
        if (raw.sub_agent && raw.models?.fields) {
            const saFields = raw.sub_agent.fields || {};
            const saApiUrl = getNestedValue(saFields, 'api_url', 'value');
            const saApiKey = getNestedValue(saFields, 'api_key', 'value');
            if (saApiUrl && saApiKey) {
                for (const gName of Object.keys(raw.models.fields)) {
                    const g = raw.models.fields[gName];
                    if (g?.fields) {
                        if (!g.fields.api_url?.value) g.fields.api_url.value = saApiUrl;
                        if (!g.fields.api_key?.value) g.fields.api_key.value = saApiKey;
                    }
                }
            }
        }

        return raw;
    }

    _loadConfig() {
        this._config = this.context?.getConfig?.() || this.context?._config || null;
        try {
            const cfg = this.context.getPluginConfig();
            this._pluginConfig = {
                enabled: true,
                delegated_plugins: {},
                models: {},
                roles: {},
                limits: {},
                security: {},
                personality: { enabled: true },
                negotiation: { enabled: false, max_rounds: 0 },
                ...cfg
            };
        } catch {
            this._pluginConfig = {
                enabled: true,
                delegated_plugins: {},
                models: {},
                roles: {},
                limits: {},
                security: {},
                personality: { enabled: true },
                negotiation: { enabled: false, max_rounds: 0 }
            };
        }
    }

    _ensureSubAgent() {
        if (!this._subAgent) {
            this._subAgent = new SubAgent(
                this._config || {},
                this._pluginConfig || {},
                (providerId, modelId) => this.context.resolveLLM(providerId, modelId)
            );
        }
    }

    _createTask(data) {
        const id = `we_${Date.now()}_${++this._taskSeq}`;
        const task = {
            id,
            type: data.type || 'delegate',
            title: data.title || '任务',
            role: data.role || 'general',
            pluginName: data.pluginName || null,
            taskDescription: data.taskDescription || '',
            mode: data.mode || 'sync',
            status: TASK_STATUS.PENDING,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            startedAt: 0,
            finishedAt: 0,
            abortController: new AbortController(),
            result: '',
            structuredResult: null,
            error: '',
            subtasks: [],
            meta: data.meta || {},
        };
        this._activeTasks.set(id, task);
        return task;
    }

    _isSearchLikeTask(task) {
        if (!task) return false;
        if (task.type === 'research') return true;
        if (task.meta?.supersedeGroup === 'search') return true;
        if (task.role === 'search') return true;
        if (task.pluginName && this._pickPluginsByRole('search').includes(task.pluginName)) return true;
        return false;
    }

    _cancelSupersededSearchTasks(keepTaskId, reason = '被新的搜索任务替换') {
        const cancellable = new Set([TASK_STATUS.PENDING, TASK_STATUS.RUNNING, TASK_STATUS.WAITING_INPUT]);
        const cancelledIds = [];

        for (const task of this._activeTasks.values()) {
            if (!task || task.id === keepTaskId) continue;
            if (!cancellable.has(task.status)) continue;
            if (!this._isSearchLikeTask(task)) continue;

            if (!task.abortController.signal.aborted) {
                task.abortController.abort();
            }
            task.status = TASK_STATUS.CANCELLED;
            task.error = reason;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();
            task.meta.cancelReason = reason;
            this._clearWaitingTimer(task.id);
            cancelledIds.push(task.id);
        }

        if (cancelledIds.length > 0) {
            this._taskQueue = this._taskQueue.filter(item => !cancelledIds.includes(item.taskId));
            logToTerminal('info', `${PLUGIN_TAG} 已自动中止旧搜索任务: ${cancelledIds.join(', ')}；原因: ${reason}`);
            logToolAction('info', `🌍 世界之眼已自动中止旧搜索任务: ${cancelledIds.join(', ')}（${reason}）`);
        }

        return cancelledIds;
    }

    async _runDelegateTask(taskId, info, options) {
        const task = this._activeTasks.get(taskId);
        if (!task) return '任务不存在';

        task.status = TASK_STATUS.RUNNING;
        task.startedAt = Date.now();
        task.updatedAt = Date.now();
        this._ensureSubAgent();
        this._enterRole(task.role);

        if (task.mode === 'async') {
            this._showProgressSubtitle(`🌍 世界之眼正在执行: ${task.title}`);
        }

        const resourceCheck = this._tryAcquireResources(task.id, task.role);
        if (resourceCheck) {
            task.status = TASK_STATUS.PENDING;
            task.error = '';
            task.meta.queueReason = resourceCheck;
            this._leaveRole(task.role);
            this._enqueueTask(task.id, 'delegate', { info, options }, resourceCheck);
            return `任务已重新排队: ${task.id}\n原因: ${resourceCheck}`;
        }

        let mergedTools = info.tools;
        let pluginDescription;
        if (options.role === 'search') {
            const searchPluginNames = this._pickPluginsByRole('search');
            const descLines = [];
            const toolSet = new Set(mergedTools.map(t => ((t.function || t).name || '')));
            for (const spName of searchPluginNames) {
                const spInfo = this._delegatedPlugins.get(spName);
                if (!spInfo) continue;
                descLines.push(`- ${spInfo.metadata.displayName || spName}: ${spInfo.metadata.description || '无描述'}`);
                if (spName === options.pluginName) continue;
                for (const t of (spInfo.tools || [])) {
                    const tName = (t.function || t).name || '';
                    if (tName && !toolSet.has(tName)) {
                        mergedTools = [...mergedTools, t];
                        toolSet.add(tName);
                    }
                }
            }
            pluginDescription = [
                `搜索角色（已合并 ${searchPluginNames.length} 个搜索插件的工具）:`,
                ...descLines,
                `可用工具总数: ${mergedTools.length}`,
                '',
                '★ 重要: 第 1 轮必须一次性并行发起所有相关搜索工具调用（多引擎交叉取证），它们会被并行执行。第 2 轮只允许补缺口，最后一轮必须输出结论。不要一个接一个串行调用。',
            ].join('\n');
            logToTerminal('info', `${PLUGIN_TAG} 搜索角色已合并 ${searchPluginNames.length} 个插件共 ${mergedTools.length} 个工具`);
        } else {
            pluginDescription = [
                `插件: ${info.metadata.displayName || options.pluginName}`,
                `说明: ${info.metadata.description || '无描述'}`,
                `可用工具数: ${info.tools.length}`,
            ].join('\n');
        }

        try {
            const baseRuntime = {
                role: options.role,
                workerLabel: `${options.role || 'general'}-worker-${task.id}`,
                isTemporaryWorker: true,
            };
            const extraContext = this._buildSubAgentExtraContext(options.role, options.pluginName, options.taskDescription);
            const runtimeOpts = extraContext.length > 0
                ? { ...baseRuntime, extraContext }
                : baseRuntime;

            const outcome = await this._subAgent.executeWithStatus(
                options.pluginName,
                options.taskDescription,
                pluginDescription,
                mergedTools,
                task.abortController.signal,
                runtimeOpts
            );
            const content = typeof outcome === 'string' ? outcome : (outcome?.content || '');
            const status = (outcome && typeof outcome === 'object' && outcome.status) ? outcome.status : 'completed';

            if (task.abortController.signal.aborted || status === 'aborted') {
                task.status = TASK_STATUS.CANCELLED;
                task.finishedAt = Date.now();
                task.updatedAt = Date.now();
                return '任务已被中止。';
            }

            // v4: 信息缺口类失败 → 转 waiting_input 请主模型补答，而不是直接失败
            if (status === 'tool_chain_failed' && this._isInfoGapFailure(outcome)) {
                return this._parkTaskWaitingInput(task, info, options, outcome);
            }

            if (status === 'llm_error' || status === 'tool_chain_failed') {
                task.error = String(outcome?.lastToolError || content || '执行失败').slice(0, 500);
                task.result = content;
                task.structuredResult = this._buildStructuredResult(task, {
                    summary: '',
                    sections: { report: content },
                    artifacts: [],
                    error: task.error,
                });
                task.status = TASK_STATUS.FAILED;
                task.finishedAt = Date.now();
                task.updatedAt = Date.now();

                if (task.mode === 'async') {
                    this._showProgressSubtitle(`❌ 世界之眼任务失败: ${task.title}`);
                    this._enqueueResult(task.id, task.title, `执行失败: ${task.error}\n\n[执行详情]\n${content}`);
                }
                return `执行失败: ${task.error}`;
            }

            // completed / max_rounds: 按执行结果处理（max_rounds 内容为总结文本）
            task.result = this._wrapResult('执行报告', options.taskDescription, content);
            task.structuredResult = this._buildStructuredResult(task, {
                summary: content,
                sections: {
                    report: content,
                },
                artifacts: [],
            });
            task.status = TASK_STATUS.COMPLETED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            if (task.mode === 'async') {
                this._showProgressSubtitle(`✅ 世界之眼任务完成: ${task.title}`);
                this._enqueueResult(task.id, task.title, task.result);
            }

            return task.result;
        } catch (error) {
            task.error = error.message;
            task.structuredResult = this._buildStructuredResult(task, {
                summary: '',
                sections: {},
                artifacts: [],
                error: error.message,
            });
            task.status = task.abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            if (task.mode === 'async' && task.status === TASK_STATUS.FAILED) {
                this._showProgressSubtitle(`❌ 世界之眼任务失败: ${task.title}`);
                this._enqueueResult(task.id, task.title, `执行失败: ${error.message}`);
            }

            return task.status === TASK_STATUS.CANCELLED ? '任务已被中止。' : `执行失败: ${error.message}`;
        } finally {
            this._releaseResources(task.id);
            this._leaveRole(task.role);
            this._scheduleQueuedTasks();
        }
    }

    // ==================== 受阻求助与续跑（v4 主模型直连通讯） ====================

    /** 判断一次失败是否属于「信息缺口」（可由主模型补答后续跑） */
    _isInfoGapFailure(outcome) {
        const text = [outcome?.lastToolError || '', outcome?.content || ''].join('\n');
        return INFO_GAP_RE.test(text);
    }

    /**
     * 把任务停靠在 waiting_input 状态：记录续跑上下文、推送求助通知给主模型、挂超时兜底。
     */
    _parkTaskWaitingInput(task, info, options, outcome) {
        const blockReason = String(outcome?.lastToolError || outcome?.content || '缺少继续执行所需的关键信息')
            .replace(/\s+/g, ' ')
            .slice(0, 500);
        task.status = TASK_STATUS.WAITING_INPUT;
        task.updatedAt = Date.now();
        task.meta.blockReason = blockReason;
        task.meta.waitingSince = Date.now();
        task.meta.resume = { kind: 'delegate', info, options };

        logToTerminal('info', `${PLUGIN_TAG} 任务 ${task.id} 受阻等待补充信息: ${blockReason.slice(0, 120)}`);

        const notice = this._buildWaitingInputNotice(task);
        if (task.mode === 'async') {
            this._showProgressSubtitle(`⏸ 世界之眼任务受阻: ${task.title}`);
            this._enqueueResult(task.id, task.title, notice, 'blocked');
        }
        this._scheduleWaitingInputTimeout(task.id);
        return notice;
    }

    /** 受阻求助通知文案：指示主模型优先自行补齐，只在上下文没有线索时才轻量问用户。 */
    _buildWaitingInputNotice(task) {
        return [
            '[世界之眼任务受阻·需要补充信息]',
            `任务ID: ${task.id}`,
            `任务: ${task.title}`,
            `受阻原因: ${task.meta.blockReason || '缺少继续执行所需的关键信息'}`,
            '',
            '处理规则（按顺序执行，不要征求用户同意）:',
            '1. 先检查最近对话内容是否已包含所缺信息（准确名称、路径、账号状态等）。',
            `2. 能补齐 → 立即调用 world_eye_control(action='answer', task_id='${task.id}', answer='<补充信息>')，任务会自动续跑。`,
            '3. 对话里确实没有 → 才向用户简短提问缺的那一项；不要复述任务过程和内部流程。',
        ].join('\n');
    }

    /** 受阻任务超时兜底：超过 _waitingInputTTL 未收到补充信息则转失败。 */
    _scheduleWaitingInputTimeout(taskId) {
        this._clearWaitingTimer(taskId);
        const timer = setTimeout(() => {
            this._waitingTimers.delete(taskId);
            const task = this._activeTasks.get(taskId);
            if (!task || task.status !== TASK_STATUS.WAITING_INPUT) return;
            task.status = TASK_STATUS.FAILED;
            task.error = `等待补充信息超时（${Math.round(this._waitingInputTTL / 60000)} 分钟）`;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();
            logToTerminal('warn', `${PLUGIN_TAG} 任务 ${taskId} 等待补充信息超时，已转失败`);
        }, this._waitingInputTTL);
        this._waitingTimers.set(taskId, timer);
    }

    _clearWaitingTimer(taskId) {
        const timer = this._waitingTimers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this._waitingTimers.delete(taskId);
        }
    }

    /**
     * answer 动作：对 waiting_input 任务注入补充信息并重新执行（同一任务记录，attempt+1）。
     */
    _resumeWaitingTask(task, answer) {
        const resume = task.meta.resume;
        if (!resume || resume.kind !== 'delegate' || !resume.info || !resume.options) {
            task.status = TASK_STATUS.FAILED;
            task.error = '受阻任务缺少续跑上下文';
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();
            return `错误: 任务 ${task.id} 缺少续跑上下文，无法继续。请重新提交任务。`;
        }
        this._clearWaitingTimer(task.id);

        task.meta.attempt = (task.meta.attempt || 1) + 1;
        task.meta.blockReason = '';
        task.status = TASK_STATUS.PENDING;
        task.updatedAt = Date.now();

        const enrichedOptions = {
            ...resume.options,
            taskDescription: [
                resume.options.taskDescription,
                '',
                '[主对话补充信息]',
                answer,
            ].join('\n'),
        };
        task.taskDescription = enrichedOptions.taskDescription;
        task.meta.resume = { kind: 'delegate', info: resume.info, options: enrichedOptions };

        logToTerminal('info', `${PLUGIN_TAG} 任务 ${task.id} 收到补充信息，开始续跑（第 ${task.meta.attempt} 次尝试）`);
        const runner = this._runDelegateTask(task.id, resume.info, enrichedOptions);
        runner.catch(() => {});
        return `[任务已续跑] ${task.id} 已带着补充信息重新执行，完成后会自动通知你。请用你的人设语气告诉用户已经继续在办了。`;
    }

    /**
     * v4 研究任务入口：按深度分派链路。
     *   quick    = 合并搜索(≤2 轮) → 摘要式报告                       （2 次子代理运行）
     *   standard = 合并搜索(≤3 轮) → 审查+撰写合并（至多 1 次补搜 → 终稿）（2-4 次）
     *   deep     = 规划 → 合并搜索 → 独立审查 → 补搜循环(≤2) → 报告      （4-8 次）
     * 搜索阶段统一为「1 个子代理合并全部搜索插件工具」，首轮并行多引擎。
     */
    async _runResearchTask(taskId, options) {
        const task = this._activeTasks.get(taskId);
        if (!task) return '任务不存在';

        task.status = TASK_STATUS.RUNNING;
        task.startedAt = Date.now();
        task.updatedAt = Date.now();
        this._ensureSubAgent();
        this._enterRole('planner');

        if (task.mode === 'async') {
            this._showProgressSubtitle(`🌍 世界之眼开始研究: ${options.topic.substring(0, 30)}`);
        }

        try {
            const depth = String(options.depth || 'standard').toLowerCase();
            const parts = depth === 'deep'
                ? await this._runDeepResearchFlow(task, options)
                : await this._runFastResearchFlow(task, options, depth);
            return await this._finalizeResearchSuccess(task, options, parts);
        } catch (error) {
            task.error = error.message;
            task.structuredResult = this._buildStructuredResult(task, {
                summary: '',
                sections: {},
                artifacts: [],
                error: error.message,
            });
            task.status = task.abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            if (task.mode === 'async' && task.status === TASK_STATUS.FAILED) {
                this._showProgressSubtitle(`❌ 研究任务失败: ${options.topic.substring(0, 30)}`);
                this._enqueueResult(task.id, task.title, `研究任务失败: ${error.message}`);
            }

            return task.status === TASK_STATUS.CANCELLED ? '研究任务已被中止。' : `研究任务失败: ${error.message}`;
        } finally {
            this._leaveRole('planner');
            this._scheduleQueuedTasks();
        }
    }

    /**
     * 合并所有 search 角色插件的（研究安全）工具与描述，供单个搜索子代理一次性使用。
     * 返回 { tools, description, pluginName, pluginCount }。
     */
    _buildMergedSearchContext() {
        const searchPluginNames = this._pickPluginsByRole('search');
        const mergedTools = [];
        const toolSet = new Set();
        const descLines = [];
        let primaryPlugin = '';
        for (const spName of searchPluginNames) {
            const spInfo = this._delegatedPlugins.get(spName);
            if (!spInfo) continue;
            const safeTools = this._getResearchToolsForPlugins([spName]);
            if (safeTools.length === 0) continue;
            if (!primaryPlugin) primaryPlugin = spName;
            descLines.push(`- ${spInfo.metadata.displayName || spName}: ${spInfo.metadata.description || '无描述'}`);
            for (const t of safeTools) {
                const tName = (t.function || t).name || '';
                if (tName && !toolSet.has(tName)) {
                    mergedTools.push(t);
                    toolSet.add(tName);
                }
            }
        }
        const description = [
            `搜索角色（已合并 ${descLines.length} 个搜索插件的工具）:`,
            ...descLines,
            `可用工具总数: ${mergedTools.length}`,
            '',
            '★ 重要: 第 1 轮必须一次性并行发起所有相关搜索工具调用（多引擎交叉取证），它们会被并行执行。第 2 轮只允许补缺口，最后一轮必须输出结论。不要一个接一个串行调用。',
        ].join('\n');
        return { tools: mergedTools, description, pluginName: primaryPlugin, pluginCount: descLines.length };
    }

    /** 搜索任务模板：规划职责已内嵌，不再单独调用 planner（quick/standard）。 */
    _buildResearchSearchTask(topic, depth) {
        return [
            `围绕主题“${topic}”联网搜索资料。研究深度: ${depth}`,
            '',
            '执行方法:',
            '1. 先识别主题的核心问题与关键实体（人物/作品/产品/版本/时间）。',
            '2. 第 1 轮一次性并行调用所有可用的搜索工具，多引擎交叉取证。',
            '3. 提取关键事实、来源线索、时间信息与争议点；信息不足时下一轮只补缺口。',
            '4. 输出保留: 要点、来源、时间、争议点、信息缺口。不把猜测写成事实。',
        ].join('\n');
    }

    /** quick 深度的摘要式报告任务。 */
    _buildQuickReportTask(topic) {
        return `基于已有搜索材料，用紧凑篇幅总结“${topic}”: 摘要 + 主要发现 + 来源线索 + 待确认项。不需要长篇报告，不要输出【需要补搜】。`;
    }

    /** standard 深度的「审查+撰写合并」任务：自查通过直接成稿，严重缺口输出【需要补搜】。 */
    _buildReviewedReportTask(topic, depth, { finalPass = false } = {}) {
        const gapRule = finalPass
            ? '这是终稿轮: 即使仍有缺口也不要再输出【需要补搜】，把未解决问题标注为低置信/待确认后直接成稿。'
            : '自查发现严重缺口时（核心问题未回答、核心结论无来源、关键事实冲突、只有单一二手来源、答非所问），输出【需要补搜】并列出: 补搜原因、补搜目标、建议关键词/来源方向，然后停止，不要写正式报告；否则直接输出报告。';
        return [
            `基于已有搜索材料，产出关于“${topic}”的研究报告。研究深度: ${depth}`,
            '',
            '第一步先在内部完成审查自查（不必输出过程）:',
            '- 核心问题是否已被回答？结论是否有来源支撑？',
            '- 关键时间、版本、人物、数值是否互相矛盾？',
            '- 是否过度依赖单一二手来源？',
            gapRule,
            '',
            '报告格式: 摘要 → 主要发现（按高置信/低置信/推测分档）→ 依据与来源 → 补充说明。',
        ].join('\n');
    }

    /**
     * v4 快速研究链（quick/standard）。
     * 返回 { planSummary, reviewHistory, repairSummaries, reportSummary }。
     */
    async _runFastResearchFlow(task, options, depth) {
        const signal = task.abortController.signal;
        const search = this._buildMergedSearchContext();
        if (search.tools.length === 0) {
            throw new Error('没有可用于研究任务的搜索工具');
        }

        // 1) 搜索：单子代理合并全部搜索插件工具，首轮并行多引擎
        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在搜索资料...');
        const searchSubtask = { pluginName: search.pluginName, role: 'search', status: TASK_STATUS.RUNNING };
        task.subtasks.push(searchSubtask);
        const searchResult = await this._subAgent.execute(
            search.pluginName,
            this._buildResearchSearchTask(options.topic, depth),
            search.description,
            search.tools,
            signal,
            {
                role: 'search',
                workerLabel: `search-${task.id}`,
                isTemporaryWorker: true,
                maxIterations: depth === 'quick' ? 2 : 3,
            }
        );
        searchSubtask.status = TASK_STATUS.COMPLETED;
        searchSubtask.result = searchResult;
        if (signal.aborted) throw new Error('研究任务已被中止。');

        const searchContexts = [
            { title: '搜索结果', content: typeof searchResult === 'string' ? searchResult : String(searchResult || ''), fromRole: 'search' },
        ];

        // 2) 审查+撰写合并（quick 直接摘要成稿；standard 允许一次【需要补搜】返工）
        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在撰写报告...');
        this._logHandoff('search', 'reporter');
        let reportSummary = await this._subAgent.run({
            role: 'reporter',
            workerLabel: `reporter-${task.id}`,
            isTemporaryWorker: true,
            taskDescription: depth === 'quick'
                ? this._buildQuickReportTask(options.topic)
                : this._buildReviewedReportTask(options.topic, depth, { finalPass: false }),
            toolDefinitions: [],
            signal,
            extraContext: searchContexts,
        });
        if (signal.aborted) throw new Error('研究任务已被中止。');

        const repairSummaries = [];
        if (depth !== 'quick') {
            const repairDecision = this._parseResearchRepairRequest(reportSummary);
            if (repairDecision.needsRepair) {
                task.meta.researchRepairRounds = 1;
                if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 报告要求补搜(1/1)...');
                logToTerminal('info', `${PLUGIN_TAG} 报告自查要求补搜（standard 至多 1 轮）`);
                this._logHandoff('reporter', 'search');

                const repairSubtask = { pluginName: search.pluginName, role: 'search', status: TASK_STATUS.RUNNING, repairRound: 1 };
                task.subtasks.push(repairSubtask);
                const repairResult = await this._subAgent.execute(
                    search.pluginName,
                    this._buildResearchRepairSearchTask(options.topic, depth, 1, repairDecision.requestText),
                    search.description,
                    search.tools,
                    signal,
                    {
                        role: 'search',
                        workerLabel: `repair-search-${task.id}`,
                        isTemporaryWorker: true,
                        maxIterations: 2,
                    }
                );
                repairSubtask.status = TASK_STATUS.COMPLETED;
                repairSubtask.result = repairResult;
                if (signal.aborted) throw new Error('研究任务已被中止。');

                const repairText = typeof repairResult === 'string' ? repairResult : String(repairResult || '');
                repairSummaries.push({ round: 1, result: repairText });
                searchContexts.push({ title: '补搜结果', content: repairText, fromRole: 'search' });

                if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在撰写终稿...');
                this._logHandoff('search', 'reporter');
                reportSummary = await this._subAgent.run({
                    role: 'reporter',
                    workerLabel: `reporter-final-${task.id}`,
                    isTemporaryWorker: true,
                    taskDescription: this._buildReviewedReportTask(options.topic, depth, { finalPass: true }),
                    toolDefinitions: [],
                    signal,
                    extraContext: [
                        ...searchContexts,
                        { title: '上一轮补搜要求', content: repairDecision.requestText, fromRole: 'reporter' },
                    ],
                });
                if (signal.aborted) throw new Error('研究任务已被中止。');
            }
        }

        return {
            planSummary: '（v4 快速链路: 规划已内嵌到搜索任务模板，无独立规划步骤。）',
            reviewHistory: [],
            repairSummaries,
            reportSummary: typeof reportSummary === 'string' ? reportSummary : String(reportSummary || ''),
        };
    }

    /**
     * v4 深度研究链（deep）：planner → 合并搜索 → 独立审查 → 补搜循环(≤2) → 报告。
     * 返回 { planSummary, reviewHistory, repairSummaries, reportSummary }。
     */
    async _runDeepResearchFlow(task, options) {
        const signal = task.abortController.signal;
        const depth = 'deep';
        const search = this._buildMergedSearchContext();
        if (search.tools.length === 0) {
            throw new Error('没有可用于研究任务的搜索工具');
        }

        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在规划...');
        const planSummary = await this._subAgent.run({
            role: 'planner',
            workerLabel: `planner-${task.id}`,
            isTemporaryWorker: true,
            taskDescription: `请为研究主题“${options.topic}”生成一份简洁执行计划。要求说明研究重点、搜索角度、审查重点和最终输出目标。研究深度: ${depth}`,
            toolDefinitions: [],
            signal,
        });
        if (signal.aborted) throw new Error('研究任务已被中止。');

        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在搜索资料...');
        this._logHandoff('planner', 'search');
        const searchSubtask = { pluginName: search.pluginName, role: 'search', status: TASK_STATUS.RUNNING };
        task.subtasks.push(searchSubtask);
        const searchResult = await this._negotiateTransition({
            upstreamRole: 'planner',
            downstreamRole: 'search',
            downstreamTask: this._buildResearchSearchTask(options.topic, depth),
            downstreamTools: search.tools,
            downstreamExtraContext: [{ title: '研究计划', content: planSummary, fromRole: 'planner' }],
            downstreamPluginName: search.pluginName,
            downstreamPluginDescription: search.description,
            upstreamRefineContext: [{ title: '主题', content: options.topic }],
            signal,
            workerLabelPrefix: `search-${task.id}`,
        });
        searchSubtask.status = TASK_STATUS.COMPLETED;
        searchSubtask.result = searchResult;
        if (signal.aborted) throw new Error('研究任务已被中止。');

        const searchContexts = [
            { title: '研究计划', content: planSummary, fromRole: 'planner' },
            { title: '搜索结果', content: searchResult, fromRole: 'search' },
        ];

        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在审查材料...');
        this._logHandoff('search', 'reviewer');
        let reviewSummary = await this._negotiateTransition({
            upstreamRole: 'search',
            downstreamRole: 'reviewer',
            downstreamTask: this._buildResearchReviewTask(options.topic, depth),
            downstreamTools: [],
            downstreamExtraContext: searchContexts,
            upstreamRefineContext: [{ title: '研究计划', content: planSummary, fromRole: 'planner' }],
            signal,
            workerLabelPrefix: `reviewer-${task.id}`,
        });
        if (signal.aborted) throw new Error('研究任务已被中止。');

        const reviewHistory = [{ round: 0, result: reviewSummary }];
        const repairSummaries = [];
        const maxRepairRounds = this._getResearchRepairMaxRounds(depth);
        for (let repairRound = 1; repairRound <= maxRepairRounds; repairRound++) {
            const repairDecision = this._parseResearchRepairRequest(reviewSummary);
            if (!repairDecision.needsRepair) break;

            task.meta.researchRepairRounds = repairRound;
            if (task.mode === 'async') this._showProgressSubtitle(`🌍 研究进度: 审查要求补搜(${repairRound}/${maxRepairRounds})...`);
            logToTerminal('info', `${PLUGIN_TAG} 审查要求补搜，第 ${repairRound}/${maxRepairRounds} 轮`);
            this._logHandoff('reviewer', 'search');

            const repairSubtask = { pluginName: search.pluginName, role: 'search', status: TASK_STATUS.RUNNING, repairRound };
            task.subtasks.push(repairSubtask);
            const repairResult = await this._negotiateTransition({
                upstreamRole: 'reviewer',
                downstreamRole: 'search',
                downstreamTask: this._buildResearchRepairSearchTask(options.topic, depth, repairRound, repairDecision.requestText),
                downstreamTools: search.tools,
                downstreamExtraContext: [
                    { title: '研究计划', content: planSummary, fromRole: 'planner' },
                    { title: `审查补搜要求 - 第 ${repairRound} 轮`, content: repairDecision.requestText, fromRole: 'reviewer' },
                ],
                downstreamPluginName: search.pluginName,
                downstreamPluginDescription: search.description,
                upstreamRefineContext: searchContexts.slice(1),
                signal,
                workerLabelPrefix: `repair-search-${task.id}-r${repairRound}`,
            });
            repairSubtask.status = TASK_STATUS.COMPLETED;
            repairSubtask.result = repairResult;
            if (signal.aborted) throw new Error('研究任务已被中止。');

            const repairText = typeof repairResult === 'string' ? repairResult : String(repairResult || '');
            repairSummaries.push({ round: repairRound, result: repairText });
            searchContexts.push({ title: `补搜结果 第 ${repairRound} 轮`, content: repairText, fromRole: 'search' });

            if (task.mode === 'async') this._showProgressSubtitle(`🌍 研究进度: 正在复审补搜结果(${repairRound}/${maxRepairRounds})...`);
            this._logHandoff('search', 'reviewer');
            reviewSummary = await this._negotiateTransition({
                upstreamRole: 'search',
                downstreamRole: 'reviewer',
                downstreamTask: this._buildResearchReviewTask(
                    options.topic,
                    depth,
                    repairRound,
                    repairDecision.requestText,
                    repairRound >= maxRepairRounds
                ),
                downstreamTools: [],
                downstreamExtraContext: [
                    ...searchContexts,
                    { title: `上一轮审查意见`, content: reviewHistory[reviewHistory.length - 1].result, fromRole: 'reviewer' },
                ],
                upstreamRefineContext: searchContexts.slice(1),
                signal,
                workerLabelPrefix: `reviewer-${task.id}-r${repairRound}`,
            });
            if (signal.aborted) throw new Error('研究任务已被中止。');
            reviewHistory.push({ round: repairRound, result: reviewSummary });
        }

        const reviewContextBlocks = reviewHistory.map(item => ({
            title: item.round === 0 ? '初次审查意见' : `第 ${item.round} 轮复审意见`,
            content: item.result,
            fromRole: 'reviewer',
        }));

        if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在撰写报告...');
        this._logHandoff('reviewer', 'reporter');
        const reportSummary = await this._negotiateTransition({
            upstreamRole: 'reviewer',
            downstreamRole: 'reporter',
            downstreamTask: `基于已有材料输出一份关于“${options.topic}”的研究报告。要求包含摘要、主要发现、依据、补充说明。研究深度: ${depth}`,
            downstreamTools: [],
            downstreamExtraContext: [
                ...searchContexts,
                ...reviewContextBlocks,
            ],
            upstreamRefineContext: searchContexts.slice(1), // 不含 plan
            signal,
            workerLabelPrefix: `reporter-${task.id}`,
        });
        if (signal.aborted) throw new Error('研究任务已被中止。');

        return { planSummary, reviewHistory, repairSummaries, reportSummary };
    }

    /**
     * 研究成功收尾（三档深度共用）：可选输出转换（summary / report+persona 口语化改写）、
     * 组装内部结果、写 structuredResult、归档、异步投递。
     */
    async _finalizeResearchSuccess(task, options, parts) {
        const signal = task.abortController.signal;
        const { planSummary, reviewHistory, repairSummaries, reportSummary } = parts;
        const reviewSummary = reviewHistory.length > 0 ? reviewHistory[reviewHistory.length - 1].result : '';

        let finalOutput = reportSummary;
        if (options.output === 'report+persona') {
            if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在做口语化改写...');
            this._logHandoff('reporter', 'persona');
            finalOutput = await this._subAgent.run({
                role: 'persona',
                workerLabel: `persona-${task.id}`,
                isTemporaryWorker: true,
                taskDescription: '请把下面的研究报告改写成适合口头转述的自然中文。必须保持事实、结论和来源边界不变，只调整表达方式，删掉报告腔。',
                toolDefinitions: [],
                signal,
                extraContext: [
                    { title: '研究报告', content: reportSummary, fromRole: 'reporter' },
                ],
            });
            if (signal.aborted) throw new Error('研究任务已被中止。');
        } else if (options.output === 'summary') {
            this._logHandoff('reporter', 'synthesizer');
            finalOutput = await this._subAgent.run({
                role: 'synthesizer',
                workerLabel: `synthesizer-${task.id}`,
                isTemporaryWorker: true,
                taskDescription: `请把下面材料整理成简洁摘要，主题是“${options.topic}”。`,
                toolDefinitions: [],
                signal,
                extraContext: [
                    { title: '研究报告', content: reportSummary, fromRole: 'reporter' },
                    ...(reviewSummary ? [{ title: '审查意见', content: reviewSummary, fromRole: 'reviewer' }] : []),
                ],
            });
            if (signal.aborted) throw new Error('研究任务已被中止。');
        }

        const internalSections = [
            `【世界之眼·研究报告】`,
            `主题: ${options.topic}`,
            `深度: ${options.depth}`,
            '',
            '【研究计划】',
            planSummary,
            '',
            '【审查摘要】',
            reviewHistory.length > 0
                ? reviewHistory.map(item => `【${item.round === 0 ? '初次审查' : `第 ${item.round} 轮复审`}】\n${item.result}`).join('\n\n')
                : '（快速链路: 审查自查已合并进报告撰写步骤。）',
            '',
            '【补搜摘要】',
            repairSummaries.length > 0
                ? repairSummaries.map(item => `【第 ${item.round} 轮补搜】\n${item.result}`).join('\n\n')
                : '未触发补搜。',
            '',
            '【研究报告】',
            reportSummary,
        ];

        if (options.output === 'report+persona') {
            internalSections.push('', '【最终对用户输出建议】', finalOutput);
        } else if (options.output === 'summary') {
            internalSections.push('', '【摘要】', finalOutput);
        }

        internalSections.push('', '——以上为世界之眼内部研究结果。仅供 raw_result / 归档调试使用，不应直接暴露给主对话。');

        const internalResult = internalSections.join('\n');
        const publicBody = this._sanitizePersonaArtifacts(finalOutput || reportSummary || '').trim();
        task.result = [
            '【最终研究结果】',
            `主题: ${options.topic}`,
            '',
            publicBody || '研究已完成，但最终输出为空。请查看 raw_result 获取内部结果。',
            '',
            '——以上为最终结果。请基于这些内容自然回复用户，不要提及审查、补搜、内部流程、世界之眼或任何内部 agent 名。',
        ].join('\n');
        task.structuredResult = this._buildStructuredResult(task, {
            summary: publicBody,
            sections: {
                plan: planSummary,
                review: reviewSummary,
                review_history: reviewHistory,
                repair_rounds: repairSummaries,
                report: reportSummary,
                final: finalOutput,
            },
            artifacts: [],
            internal_result: internalResult,
        });
        task.status = signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.COMPLETED;
        task.finishedAt = Date.now();
        task.updatedAt = Date.now();
        this._archiveResearchTask(task);

        if (task.mode === 'async' && task.status === TASK_STATUS.COMPLETED) {
            this._showProgressSubtitle(`✅ 研究完成: ${options.topic.substring(0, 30)}`);
            this._enqueueResult(task.id, task.title, task.result);
        }

        return task.result;
    }

    _pickPluginsByRole(role) {
        const configured = this._getConfiguredPluginsForRole(role);
        if (configured.length > 0) {
            return configured.filter(name => this._delegatedPlugins.has(name));
        }

        const names = Array.from(this._delegatedPlugins.keys());
        if (role === 'search') {
            return names.filter(name => ['multi-search', 'bilibili-tools'].includes(name));
        }
        if (role === 'music') {
            return names.filter(name => ['minimax-music', 'rebirth-feiniu-music'].includes(name));
        }
        if (role === 'video') {
            const prefer = ['jimeng-video'];
            const hit = prefer.find(n => names.includes(n));
            if (hit) return [hit];
            return names.filter(name => /(^|-)video$/i.test(name) || /^jimeng/i.test(name));
        }
        if (role === 'image') {
            return names.filter(name => ['openrouter-image'].includes(name));
        }
        if (role === 'code') {
            return names.filter(name => ['code-executor'].includes(name));
        }
        if (role === 'file') {
            return names.filter(name => ['mcp-filesystem', 'txt-writer'].includes(name));
        }
        if (role === 'app') {
            return names.filter(name => ['windows-app-launcher'].includes(name));
        }
        if (role === 'skills') {
            return names.filter(name => ['myneuro-plugin-skills'].includes(name));
        }
        return names;
    }

    _getToolsForPlugins(pluginNames) {
        const tools = [];
        for (const pluginName of pluginNames) {
            const info = this._delegatedPlugins.get(pluginName);
            if (info?.tools?.length) {
                tools.push(...info.tools);
            }
        }
        return tools;
    }

    _getResearchToolsForPlugins(pluginNames) {
        return this._getToolsForPlugins(pluginNames).filter(tool => this._isResearchSafeTool(tool));
    }

    _getResearchRepairMaxRounds(depth) {
        const normalized = String(depth || 'standard').toLowerCase();
        if (normalized === 'deep') return 2;
        return 1;
    }

    _parseResearchRepairRequest(reviewText) {
        const raw = typeof reviewText === 'string' ? reviewText : String(reviewText || '');
        const factual = SubAgent.stripThinkingSnippet(raw).trim();
        const text = factual || raw;
        if (!/【\s*需要补搜\s*】/.test(text)) {
            return { needsRepair: false, requestText: '' };
        }

        let requestText = text;
        const markerIndex = text.search(/【\s*需要补搜\s*】/);
        if (markerIndex >= 0) {
            requestText = text.slice(markerIndex).trim();
        }
        requestText = requestText.replace(/【\s*审查通过\s*】[\s\S]*$/g, '').trim();
        return {
            needsRepair: true,
            requestText: requestText || '【需要补搜】审查认为现有材料存在严重缺口，但未给出具体补搜目标。请优先补充官方来源、一手来源和独立来源。',
        };
    }

    _buildResearchReviewTask(topic, depth, repairRound = 0, previousRepairRequest = '', isFinalReview = false) {
        const stage = repairRound > 0 ? `第 ${repairRound} 轮补搜后的复审` : '初次审查';
        const finalRule = isFinalReview
            ? '这已经是最后一轮复审。即使仍有缺口，也不要再输出【需要补搜】；请输出【审查通过】，并把未解决问题明确标为低置信/待确认。'
            : '如果存在严重缺口，必须输出【需要补搜】并写清楚补搜目标；如果资料足够进入报告阶段，必须输出【审查通过】。';
        const previous = previousRepairRequest
            ? `\n上一轮补搜要求:\n${previousRepairRequest}\n`
            : '';
        return [
            `审查关于“${topic}”的研究材料。当前阶段: ${stage}。研究深度: ${depth}`,
            previous,
            '你的输出必须在事实结果层明确包含以下两个标记之一，且只能二选一:',
            '1. 【审查通过】资料足够进入报告阶段。随后列出高置信结论、低置信结论、争议点和写报告注意事项。',
            '2. 【需要补搜】资料存在严重缺口。随后必须列出: 补搜原因、补搜目标、建议关键词/来源方向。',
            '',
            '严重缺口包括:',
            '- 用户问题的核心没有被回答。',
            '- 核心结论缺少来源。',
            '- 关键时间、版本、人物、地点或数值互相矛盾。',
            '- 只有营销号、论坛传言或单一二手来源，缺少官方/一手/独立来源。',
            '- 搜索结果明显太浅、过时或答非所问。',
            '',
            '普通缺口不必返工，可在【审查通过】后标低置信，例如细节不全、非关键来源不足、轻微表述差异。',
            finalRule,
            '',
            '输出格式示例:',
            '【审查通过】\n- 高置信结论: ...\n- 低置信/待确认: ...\n- 报告写作注意: ...',
            '',
            '或:',
            '【需要补搜】\n- 原因: ...\n- 补搜目标: ...\n- 建议关键词/来源: ...',
        ].filter(Boolean).join('\n');
    }

    _buildResearchRepairSearchTask(topic, depth, repairRound, repairRequest) {
        return [
            `这是第 ${repairRound} 轮返工补搜。原始研究主题: “${topic}”。研究深度: ${depth}`,
            '',
            '审查 Agent 认为现有材料存在严重缺口，要求补搜。你只需要解决审查指出的缺口，不要重写报告。',
            '',
            '审查补搜要求:',
            repairRequest,
            '',
            '补搜规则:',
            '- 优先搜索官方公告、官网、更新日志、作者/厂商/平台一手来源。',
            '- 若没有官方来源，补充视频实录、截图、可信社区帖或至少两个相互独立来源。',
            '- 避免重复已有材料；重点补齐审查指出的缺口。',
            '- 输出必须说明每条补充材料解决了哪个缺口，并保留来源线索、时间信息和置信度。',
        ].join('\n');
    }

    _isResearchSafeTool(tool) {
        const name = ((tool.function || tool).name || '').trim();
        if (!name) return false;
        return !/^(login_|send_|interact_|play_|create_|write_|delete_|remove_|launch_|open_|execute_|run_)/i.test(name);
    }

    _buildCapabilityLines() {
        return [
            '- research_topic: 围绕主题自动规划、搜索、审查、输出研究报告，并可转成更生动的人设化回答',
            '- image_task: 根据描述进行绘画、生图、插画、海报或视觉内容生成',
            '- code_task: 代码分析、修复、执行与结果解释，默认受更严格并发与安全限制',
            '- music_task: 音乐搜索、生成、播放与状态反馈',
            '- file_task: 文件读写、目录检索、文本整理',
            '- app_task: 本机应用启动与桌面侧动作执行',
            '- composite_task: 复合多步任务，如"发小红书"（自动写文+生图+发布）等，多步骤并行协作',
            '- planned_composite: 对于没有预设模板的复合目标，自动规划分解为并行步骤后执行',
            '- auto_goal: 根据高层目标自动选择 research/image/music/code/file/app/composite/planned_composite 工作流',
        ];
    }

    // ── 兜底拦截：主模型绕过 world_eye_* 直接调用或编造被代理工具名时，自动转 delegate ──

    _tryFallbackDelegation(name, params) {
        if (this._delegatedPlugins.size === 0) return undefined;

        let matchedPlugin = null;

        if (this._delegatedToolNames.has(name)) {
            matchedPlugin = this._findPluginByToolName(name);
        }

        if (!matchedPlugin) {
            const normalized = name.replace(/_/g, '-').toLowerCase();
            if (this._delegatedPlugins.has(normalized)) {
                matchedPlugin = normalized;
            }
        }

        if (!matchedPlugin) {
            for (const [pluginName] of this._delegatedPlugins) {
                const pluginNorm = pluginName.replace(/-/g, '_').toLowerCase();
                const toolNorm = name.toLowerCase();
                if (toolNorm === pluginNorm) {
                    matchedPlugin = pluginName;
                    break;
                }
            }
        }

        if (!matchedPlugin) return undefined;

        const taskDesc = this._buildFallbackTaskDescription(name, params);
        logToTerminal('warn', `${PLUGIN_TAG} 兜底拦截: 主模型调用了 "${name}"，自动转为 delegate → ${matchedPlugin}（任务: ${taskDesc.substring(0, 80)}）`);

        return this._handleDelegate({
            plugin_name: matchedPlugin,
            task_description: taskDesc,
            _fromFallback: true,
        });
    }

    _findPluginByToolName(toolName) {
        for (const [pluginName, info] of this._delegatedPlugins) {
            for (const t of (info.tools || [])) {
                if (((t.function || t).name || '') === toolName) return pluginName;
            }
        }
        return null;
    }

    _buildFallbackTaskDescription(toolName, params) {
        if (!params || typeof params !== 'object') {
            return typeof params === 'string' ? params : `执行 ${toolName}`;
        }
        const parts = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `${k}: ${v}`);
        return parts.length > 0 ? parts.join(', ') : `执行 ${toolName}`;
    }

    _getCompositeTemplates() {
        const skillsDir = path.resolve(this._pluginDir, '..', '..', '..', 'skills', 'xiaohongshu-skills');
        return {
            xiaohongshu_publish: {
                keywords: /(小红书|xhs|红书).*(发布|发帖|发|写|做一篇|来一篇|帮我发)|(发布|发帖|做一篇|来一篇|写一篇|帮我发|发).*(小红书|xhs|红书)/,
                buildSteps: (goal) => [
                    {
                        id: 'write_content',
                        role: 'reporter',
                        plugins: [],
                        task: `为小红书帖子撰写标题和正文。主题: "${goal}"。\n要求:\n- 标题不超过20字，有吸引力\n- 正文适合小红书风格，口语化、有节奏感，可以用 emoji\n- 正文200-500字\n\n严格按以下格式输出，不要加额外说明:\n标题: xxx\n正文: xxx`,
                        dependsOn: [],
                        outputKey: 'content',
                    },
                    {
                        id: 'generate_image',
                        role: 'image',
                        plugins: ['openrouter-image'],
                        task: `根据主题"${goal}"生成一张适合小红书风格的配图。图片要精美、有吸引力、适合社交媒体展示。`,
                        dependsOn: [],
                        outputKey: 'image',
                    },
                    {
                        id: 'publish',
                        role: 'skills',
                        plugins: ['myneuro-plugin-skills'],
                        task: `使用小红书技能发布帖子。\n\n操作步骤:\n1. 调用 fetch_skill(skill_name="xiaohongshu-skills") 获取技能说明\n2. 调用 fetch_skill_resource(skill_name="xiaohongshu-skills", resource_path="skills/xhs-publish/SKILL.md") 获取发布子技能说明\n3. 从上游 [content] 提取标题和正文\n4. 用 write_file 把标题写入临时文件（如 ${skillsDir}/temp_title.txt）\n5. 用 write_file 把正文写入临时文件（如 ${skillsDir}/temp_content.txt）\n6. 从上游 [image] 提取图片路径\n7. 用 execute_shell_command 执行发布命令:\n   python scripts/cli.py publish --title-file <标题文件> --content-file <正文文件> --images <图片路径>\n   cwd 设置为小红书技能目录: ${skillsDir}`,
                        dependsOn: ['write_content', 'generate_image'],
                        outputKey: 'publish_result',
                        inputBindings: { content: 'content', image: 'image' },
                    },
                ],
            },
        };
    }

    // ==================== 复合工作流 ====================

    async _handleComposite(params) {
        const { goal, templateName, mode } = params;
        const templates = this._getCompositeTemplates();
        const template = templates[templateName];
        if (!template) return '错误: 未找到复合工作流模板。';

        const steps = template.buildSteps(goal);

        // 校验步骤引用的插件是否存在
        for (const step of steps) {
            for (const pluginName of (step.plugins || [])) {
                if (!this._delegatedPlugins.has(pluginName)) {
                    return `错误: 复合工作流步骤 "${step.id}" 需要插件 "${pluginName}"，但该插件未被代理或未加载。`;
                }
            }
        }

        const task = this._createTask({
            type: 'composite',
            title: `复合任务: ${goal.substring(0, 40)}`,
            role: 'planner',
            taskDescription: goal,
            mode,
            meta: { templateName },
        });

        logToTerminal('info', `${PLUGIN_TAG} 启动复合工作流 [${templateName}]，步骤: ${steps.map(s => s.id).join(' → ')}，任务: ${task.id}`);

        const runner = this._runCompositeWorkflow(task.id, steps);
        if (mode === 'async') {
            runner.catch(() => {});
            return `[异步复合任务已接受] 正在后台执行多步骤任务，完成后会自动通知你。请用你的人设语气告诉用户你已经安排好了，可以继续聊别的。\n任务ID: ${task.id}\n步骤数: ${steps.length}`;
        }
        return await runner;
    }

    async _runCompositeWorkflow(taskId, steps) {
        const task = this._activeTasks.get(taskId);
        if (!task) return '任务不存在';

        task.status = TASK_STATUS.RUNNING;
        task.startedAt = Date.now();
        task.updatedAt = Date.now();
        this._ensureSubAgent();

        const outputs = {};
        const stepStatus = {};
        const stepPromises = {};

        for (const step of steps) {
            stepStatus[step.id] = 'pending';
            task.subtasks.push({
                id: step.id,
                role: step.role,
                plugins: step.plugins,
                status: TASK_STATUS.PENDING,
                result: '',
                error: '',
            });
        }

        const findSubtask = (id) => task.subtasks.find(s => s.id === id);

        const tryStartStep = (step) => {
            if (stepStatus[step.id] !== 'pending') return null;
            const allDepsReady = step.dependsOn.every(depId => stepStatus[depId] === 'completed');
            if (!allDepsReady) return null;

            // 检查是否有依赖失败（如果依赖失败，该步骤也标记为失败）
            const anyDepFailed = step.dependsOn.some(depId => stepStatus[depId] === 'failed');
            if (anyDepFailed) {
                stepStatus[step.id] = 'failed';
                const sub = findSubtask(step.id);
                if (sub) { sub.status = TASK_STATUS.FAILED; sub.error = '前置步骤失败'; }
                outputs[step.outputKey] = '步骤跳过: 前置步骤失败';
                return Promise.resolve();
            }

            stepStatus[step.id] = 'running';
            const sub = findSubtask(step.id);
            if (sub) sub.status = TASK_STATUS.RUNNING;

            logToTerminal('info', `${PLUGIN_TAG} 复合步骤 [${step.id}] 开始 (${step.role})`);

            // 收集上游 fromRole 信息 + 注入到任务描述
            let enrichedTask = step.task;
            const upstreamHandoffContext = []; // [{title, content, fromRole}]
            let primaryUpstreamRole = null; // 第一个 inputBindings 来源作为协商时的紧邻上游
            if (step.inputBindings) {
                for (const [paramName, sourceKey] of Object.entries(step.inputBindings)) {
                    const upstream = outputs[sourceKey] || '';
                    if (!upstream) continue;
                    // 找到产生 sourceKey 的步骤
                    const srcStep = steps.find(s => s.outputKey === sourceKey);
                    const srcRole = srcStep?.role;
                    if (srcRole && ROLE_PROMPT_BLOCKS[srcRole]) {
                        if (!primaryUpstreamRole) primaryUpstreamRole = srcRole;
                        upstreamHandoffContext.push({
                            title: `[${paramName}] 来自步骤 ${srcStep.id}`,
                            content: upstream,
                            fromRole: srcRole,
                        });
                        this._logHandoff(srcRole, step.role, upstream);
                    } else {
                        // 没有 fromRole 信息的简化注入
                        enrichedTask += `\n\n[${paramName} — 来自上游步骤的输出]:\n${upstream}`;
                    }
                }
            }

            const promise = this._executeCompositeStep(step, enrichedTask, task.abortController.signal, {
                upstreamHandoffContext,
                primaryUpstreamRole,
            })
                .then(rawResult => {
                    // rawResult 现在统一是 { status, content, lastToolError? } 结构体
                    const isObj = rawResult && typeof rawResult === 'object';
                    const status = isObj && rawResult.status ? rawResult.status : 'completed';
                    const content = isObj ? (rawResult.content || '') : String(rawResult || '');
                    const sub = findSubtask(step.id);

                    if (status === 'completed') {
                        outputs[step.outputKey] = content;
                        stepStatus[step.id] = 'completed';
                        if (sub) { sub.status = TASK_STATUS.COMPLETED; sub.result = content; }
                        logToTerminal('info', `${PLUGIN_TAG} 复合步骤 [${step.id}] 完成`);
                        return;
                    }

                    // 非 completed 一律算失败，不让下游误以为有可用结果
                    const reason = ({
                        max_rounds: '达到最大轮次仍未完成',
                        tool_chain_failed: '工具链连续失败',
                        aborted: '步骤被中止',
                        llm_error: 'LLM 调用失败',
                    })[status] || `异常状态: ${status}`;
                    const detail = rawResult && rawResult.lastToolError ? ` — ${rawResult.lastToolError}` : '';
                    const errMsg = `${reason}${detail}`;
                    outputs[step.outputKey] = `步骤失败（${reason}）${detail}\n\n[最后产出片段]\n${content}`.trim();
                    stepStatus[step.id] = 'failed';
                    if (sub) { sub.status = TASK_STATUS.FAILED; sub.error = errMsg; sub.result = content; }
                    logToTerminal('warn', `${PLUGIN_TAG} 复合步骤 [${step.id}] 未真正完成 (status=${status})${detail}`);
                })
                .catch(error => {
                    outputs[step.outputKey] = `步骤失败: ${error.message}`;
                    stepStatus[step.id] = 'failed';
                    const sub = findSubtask(step.id);
                    if (sub) { sub.status = TASK_STATUS.FAILED; sub.error = error.message; }
                    logToTerminal('warn', `${PLUGIN_TAG} 复合步骤 [${step.id}] 失败: ${error.message}`);
                });

            stepPromises[step.id] = promise;
            return promise;
        };

        try {
            while (true) {
                if (task.abortController.signal.aborted) {
                    task.status = TASK_STATUS.CANCELLED;
                    task.finishedAt = Date.now();
                    task.updatedAt = Date.now();
                    return '复合任务已被中止。';
                }

                // 尝试启动所有可执行的步骤
                for (const step of steps) {
                    if (stepStatus[step.id] === 'pending') {
                        tryStartStep(step);
                    }
                }

                // 收集所有正在运行的 promise
                const runningEntries = steps.filter(s => stepStatus[s.id] === 'running');
                if (runningEntries.length === 0) break;

                // 等待任意一个完成
                await Promise.race(runningEntries.map(s => stepPromises[s.id]));
            }

            // 检查是否有关键步骤失败
            const failedSteps = steps.filter(s => stepStatus[s.id] === 'failed');
            const allCompleted = steps.every(s => stepStatus[s.id] === 'completed');

            // 汇总结果
            const resultSections = steps.map(step => {
                const status = stepStatus[step.id];
                const output = outputs[step.outputKey] || '(无输出)';
                return `[步骤: ${step.id}] (${step.role}) — ${status}\n${output}`;
            });

            const lastStepOutput = outputs[steps[steps.length - 1].outputKey] || '';

            task.result = this._wrapResult(
                '复合任务报告',
                task.taskDescription,
                resultSections.join('\n\n---\n\n')
            );
            task.structuredResult = this._buildStructuredResult(task, {
                summary: lastStepOutput,
                sections: outputs,
                artifacts: [],
                error: failedSteps.length > 0 ? `${failedSteps.length} 个步骤失败: ${failedSteps.map(s => s.id).join(', ')}` : '',
            });
            task.status = allCompleted ? TASK_STATUS.COMPLETED : TASK_STATUS.FAILED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            logToTerminal('info', `${PLUGIN_TAG} 复合工作流完成，状态: ${task.status}，步骤: ${steps.length}/${steps.length - failedSteps.length} 成功`);

            if (task.mode === 'async' && task.status === TASK_STATUS.COMPLETED) {
                this._showProgressSubtitle(`✅ 复合任务完成: ${task.title}`);
                this._enqueueResult(task.id, task.title, task.result);
            } else if (task.mode === 'async' && task.status === TASK_STATUS.FAILED) {
                this._showProgressSubtitle(`⚠️ 复合任务部分失败: ${task.title}`);
                this._enqueueResult(task.id, task.title, task.result);
            }

            return task.result;

        } catch (error) {
            task.status = TASK_STATUS.FAILED;
            task.error = error.message;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            if (task.mode === 'async') {
                this._showProgressSubtitle(`❌ 复合任务失败: ${task.title}`);
                this._enqueueResult(task.id, task.title, `复合任务失败: ${error.message}`);
            }

            return `复合任务失败: ${error.message}`;
        }
    }

    /**
     * 执行一个复合步骤。
     * 返回结构体 { status, content, lastToolError? }：
     *   - status='completed'  正常完成
     *   - status='max_rounds' 达到最大轮次但无明显工具失败
     *   - status='tool_chain_failed' 工具链失败（最后一轮工具全失败 / app 角色匹配失败 / 协商最后一轮仍提问）
     *   - status='aborted'    被中止
     *   - status='llm_error'  LLM 调用本身失败
     */
    async _executeCompositeStep(step, enrichedTask, signal, opts = {}) {
        const plugins = step.plugins || [];
        const tools = this._getToolsForPlugins(plugins);
        const upstreamHandoffContext = Array.isArray(opts.upstreamHandoffContext) ? opts.upstreamHandoffContext : [];
        const primaryUpstreamRole = opts.primaryUpstreamRole || null;

        // 合并：上游 handoff 上下文 + 角色额外上下文（skills 目录 / app 约束等）
        const extraContext = [
            ...upstreamHandoffContext,
            ...this._buildSubAgentExtraContext(step.role, plugins[0], enrichedTask),
        ];

        // 有紧邻上游 → 走协商交接（最多 2 轮 Q&A），否则直接执行
        if (primaryUpstreamRole) {
            if (tools.length > 0) {
                const pluginName = plugins[0];
                const info = this._delegatedPlugins.get(pluginName);
                const pluginDesc = info
                    ? `插件: ${info.metadata.displayName || pluginName}\n说明: ${info.metadata.description || ''}`
                    : `插件: ${pluginName}`;
                return await this._negotiateTransitionDetailed({
                    upstreamRole: primaryUpstreamRole,
                    downstreamRole: step.role,
                    downstreamTask: enrichedTask,
                    downstreamTools: tools,
                    downstreamExtraContext: extraContext,
                    downstreamPluginName: pluginName,
                    downstreamPluginDescription: pluginDesc,
                    upstreamRefineContext: upstreamHandoffContext,
                    signal,
                    workerLabelPrefix: `composite-${step.id}`,
                });
            }
            return await this._negotiateTransitionDetailed({
                upstreamRole: primaryUpstreamRole,
                downstreamRole: step.role,
                downstreamTask: enrichedTask,
                downstreamTools: [],
                downstreamExtraContext: extraContext,
                upstreamRefineContext: upstreamHandoffContext,
                signal,
                workerLabelPrefix: `composite-${step.id}`,
            });
        }

        // 无上游 → 直接执行
        if (tools.length > 0) {
            const pluginName = plugins[0];
            const info = this._delegatedPlugins.get(pluginName);
            const pluginDesc = info
                ? `插件: ${info.metadata.displayName || pluginName}\n说明: ${info.metadata.description || ''}`
                : `插件: ${pluginName}`;
            const baseCompositeOpts = {
                role: step.role,
                workerLabel: `composite-${step.id}`,
                isTemporaryWorker: true,
            };
            const compositeOpts = extraContext.length > 0
                ? { ...baseCompositeOpts, extraContext }
                : baseCompositeOpts;
            return await this._subAgent.executeWithStatus(
                pluginName,
                enrichedTask,
                pluginDesc,
                tools,
                signal,
                compositeOpts
            );
        } else {
            return await this._subAgent.runWithStatus({
                role: step.role,
                taskDescription: enrichedTask,
                toolDefinitions: [],
                signal,
                workerLabel: `composite-${step.id}`,
                isTemporaryWorker: true,
            });
        }
    }

    // ==================== 动态规划 (Planner Fallback) ====================

    async _handlePlannedComposite(goal, mode) {
        logToTerminal('info', `${PLUGIN_TAG} 动态规划: 正在为目标分解步骤...`);

        let steps;
        try {
            steps = await this._planDynamicWorkflow(goal);
        } catch (error) {
            logToTerminal('warn', `${PLUGIN_TAG} 动态规划失败: ${error.message}，回退到单步委派`);
            // 规划失败，回退到通用委派
            const pluginName = this._pickPluginsByRole('general')[0] || Array.from(this._delegatedPlugins.keys())[0];
            return await this._handleDelegate({
                plugin_name: pluginName,
                task_description: goal,
                agent_role: this._inferRoleFromPlugin(pluginName),
                mode,
                _fromGoalRedirect: true,
            });
        }

        if (!steps || steps.length === 0) {
            logToTerminal('info', `${PLUGIN_TAG} 规划器判定为单步任务，回退到委派`);
            const pluginName = this._pickPluginsByRole('general')[0] || Array.from(this._delegatedPlugins.keys())[0];
            return await this._handleDelegate({
                plugin_name: pluginName,
                task_description: goal,
                agent_role: this._inferRoleFromPlugin(pluginName),
                mode,
                _fromGoalRedirect: true,
            });
        }

        // 校验步骤引用的插件是否存在
        for (const step of steps) {
            for (const pluginName of (step.plugins || [])) {
                if (!this._delegatedPlugins.has(pluginName)) {
                    logToTerminal('warn', `${PLUGIN_TAG} 动态规划步骤 "${step.id}" 引用了不存在的插件 "${pluginName}"，移除`);
                    step.plugins = step.plugins.filter(p => p !== pluginName);
                }
            }
        }

        const task = this._createTask({
            type: 'planned_composite',
            title: `动态规划: ${goal.substring(0, 40)}`,
            role: 'planner',
            taskDescription: goal,
            mode,
            meta: { plannedSteps: steps.map(s => s.id) },
        });

        logToTerminal('info', `${PLUGIN_TAG} 动态规划完成，步骤: ${steps.map(s => `${s.id}(${s.role})`).join(' → ')}，任务: ${task.id}`);

        const runner = this._runCompositeWorkflow(task.id, steps);
        if (mode === 'async') {
            runner.catch(() => {});
            return `[异步规划任务已接受] 正在后台执行多步骤任务，完成后会自动通知你。请用你的人设语气告诉用户你已经安排好了，可以继续聊别的。\n任务ID: ${task.id}\n步骤数: ${steps.length}`;
        }
        return await runner;
    }

    _getSkillsRootDir() {
        return path.resolve(this._pluginDir, '..', '..', '..', 'skills');
    }

    /**
     * 解析 SKILL.md 首段 YAML frontmatter 中的 name / description（支持单行与 description: | / > 多行块）。
     */
    _parseSkillMdFrontmatter(text) {
        if (!text || typeof text !== 'string') return null;
        const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
        if (!match) return null;
        const lines = match[1].split(/\r?\n/);
        let name = '';
        let description = '';
        let i = 0;
        const stripQuotes = (s) => {
            const t = s.trim();
            if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
                return t.slice(1, -1);
            }
            return t;
        };
        while (i < lines.length) {
            const line = lines[i];
            const nameM = line.match(/^name:\s*(.+)$/);
            if (nameM) {
                name = stripQuotes(nameM[1]);
                i++;
                continue;
            }
            const descM = line.match(/^description:\s*(.*)$/);
            if (descM) {
                const rest = descM[1].trim();
                if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
                    i++;
                    const buf = [];
                    while (i < lines.length) {
                        const L = lines[i];
                        if (/^[a-zA-Z_][a-zA-Z0-9_]*:\s/.test(L) && !/^\s/.test(L)) {
                            break;
                        }
                        buf.push(L.replace(/^( {1,2}|\t)/, ''));
                        i++;
                    }
                    description = buf.join('\n').trim();
                } else {
                    description = stripQuotes(rest);
                    i++;
                }
                continue;
            }
            i++;
        }
        if (!name || !description) return null;
        return { name, description };
    }

    /**
     * 扫描 live-2d/skills 下直接子目录（跳过 _ 与 . 开头），读取 SKILL.md。
     */
    _listDiscoveredSkills() {
        const root = this._getSkillsRootDir();
        if (!fs.existsSync(root)) return [];
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return [];
        }
        const out = [];
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            if (ent.name.startsWith('_') || ent.name.startsWith('.')) continue;
            const mdPath = path.join(root, ent.name, 'SKILL.md');
            if (!fs.existsSync(mdPath)) continue;
            let raw;
            try {
                raw = fs.readFileSync(mdPath, 'utf8');
            } catch {
                continue;
            }
            const parsed = this._parseSkillMdFrontmatter(raw);
            if (!parsed) continue;
            out.push({
                name: parsed.name,
                description: parsed.description,
                path: path.join(root, ent.name),
            });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    _buildPlannerToolsAndSkillsSection() {
        const lines = [];
        lines.push('## 已代理插件与工具（规划步骤时请据此选择角色与 plugins）');
        lines.push('以下为当前世界之眼已代理插件暴露的工具名与简介；执行阶段由对应子智能体使用完整工具定义。');
        lines.push('');

        const MAX_TOOLS = 100;
        let toolCount = 0;
        let truncated = false;

        for (const [pname, info] of this._delegatedPlugins) {
            const display = info.metadata?.displayName || pname;
            const pdesc = (info.metadata?.description || '').replace(/\s+/g, ' ').trim().slice(0, 220);
            lines.push(`### 插件 \`${pname}\`（${display}）`);
            if (pdesc) lines.push(`插件简介: ${pdesc}`);
            const tools = info.tools || [];
            for (const t of tools) {
                if (toolCount >= MAX_TOOLS) {
                    truncated = true;
                    break;
                }
                const fn = t.function || t;
                const tn = (fn.name || '').trim();
                if (!tn) continue;
                const td = (fn.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
                lines.push(`- \`${tn}\`: ${td || '（无描述）'}`);
                toolCount++;
            }
            lines.push('');
            if (truncated) break;
        }
        if (truncated) {
            lines.push('（工具条目已达上限，其余工具略；规划时优先使用已列出能力与 skills 列表。）');
            lines.push('');
        }

        lines.push('## 可用 Skills 技能包（skills 角色 + 插件 myneuro-plugin-skills）');
        lines.push('下列条目来自本机 `skills` 目录扫描（不含 `_` 前缀子目录）。调用时使用 fetch_skill(skill_name)，skill_name 为下列名称。');
        lines.push('');
        const skills = this._listDiscoveredSkills();
        if (skills.length === 0) {
            lines.push('（未扫描到有效 SKILL.md，或 skills 目录不存在。）');
        } else {
            const maxDesc = 280;
            for (const s of skills) {
                const full = s.description.replace(/\s+/g, ' ').trim();
                const desc = full.slice(0, maxDesc);
                lines.push(`- \`${s.name}\`: ${desc}${full.length > maxDesc ? '…' : ''}`);
                lines.push(`  - 目录: ${s.path}`);
            }
        }
        return lines.join('\n');
    }

    _getSkillsInventoryForSubAgent() {
        const skills = this._listDiscoveredSkills();
        if (skills.length === 0) return '';
        const lines = [
            '以下为当前本机 `skills` 目录下的技能包（与世界之眼扫描结果一致）。`skill_name` 必须使用下列名称之一。',
            '执行前应用 fetch_skill(skill_name) 读取完整 SKILL.md；若有疑问可再调用 list_skills。',
            '',
        ];
        for (const s of skills) {
            lines.push(`- **${s.name}**`);
            lines.push(`  - 目录（execute_shell_command 的 cwd 通常设为此目录）: ${s.path}`);
            lines.push(`  - 摘要: ${s.description}`);
            lines.push('');
        }
        return lines.join('\n');
    }

    _skillsInventoryExtraContext() {
        const content = this._getSkillsInventoryForSubAgent();
        if (!content) return [];
        return [{ title: '可用 Skills 目录', content }];
    }

    _appExecutionExtraContext(taskDescription = '') {
        const content = [
            '应用启动任务的名称处理规则:',
            '1. 优先使用用户原文中的应用名、游戏名、快捷方式名或可执行文件名，不要自行改写为近义词。',
            '2. 不要把自动翻译、猜测的英文名、猜测的中文别名、其他相似游戏名当作新的启动目标。',
            '3. 若当前名称无法精确匹配本机应用，必须停止继续尝试，不允许连续更换多个候选名。',
            '4. 匹配失败时，直接返回让上层 AI 向用户确认准确名称，尤其是桌面显示名称、英文名称、快捷方式名称或 exe 名称。',
        ];
        if (taskDescription && taskDescription.trim()) {
            content.push('');
            content.push(`本次任务原始描述: ${taskDescription.trim()}`);
        }
        return [{ title: '应用名称匹配约束', content: content.join('\n') }];
    }

    _buildSubAgentExtraContext(role, pluginName, taskDescription = '') {
        const contexts = [];
        if (this._shouldAttachSkillsInventory(role, pluginName)) {
            contexts.push(...this._skillsInventoryExtraContext());
        }
        if (role === 'app') {
            contexts.push(...this._appExecutionExtraContext(taskDescription));
        }
        return contexts;
    }

    _shouldAttachSkillsInventory(role, pluginName) {
        if (role === 'skills') return true;
        if (pluginName === 'myneuro-plugin-skills') return true;
        return false;
    }

    async _planDynamicWorkflow(goal) {
        this._ensureSubAgent();

        const prompt = this._buildPlannerPrompt(goal);

        const result = await this._subAgent.run({
            role: 'planner',
            taskDescription: prompt,
            toolDefinitions: [],
            // 规划器要做完整 DAG 拆分，prompt 很长；尊重用户配置的超时（默认 120s）
            // 同时给一个上限以防失控：取配置值与 180s 中的较小者
            signal: AbortSignal.timeout(Math.min(180000, Math.max(30000, this._getConfiguredLlmTimeoutMs()))),
            workerLabel: 'dynamic-planner',
            isTemporaryWorker: true,
        });

        return this._parsePlannerOutput(result, goal);
    }

    _buildPlannerPrompt(goal) {
        this._refreshDelegatedPluginsIfNeeded();

        // 收集可用角色及其绑定的插件
        const roleCapabilities = [];
        const allRoles = ['search', 'image', 'video', 'music', 'code', 'file', 'app', 'skills', 'reporter', 'reviewer', 'synthesizer'];
        const pluginBindings = {};

        for (const role of allRoles) {
            const plugins = this._pickPluginsByRole(role);
            const availablePlugins = plugins.filter(p => this._delegatedPlugins.has(p));
            pluginBindings[role] = availablePlugins;

            if (role === 'reporter' || role === 'reviewer' || role === 'synthesizer') {
                // 纯文本角色，无需插件
                roleCapabilities.push(`- ${role}: 纯文本处理角色（无需插件）。`
                    + (role === 'reporter' ? ' 擅长撰写结构化文本、文案、报告。' : '')
                    + (role === 'reviewer' ? ' 擅长审查、校对、质量把关。' : '')
                    + (role === 'synthesizer' ? ' 擅长汇总多个结果、去重归纳。' : ''));
            } else if (availablePlugins.length > 0) {
                const pluginDescs = availablePlugins.map(p => {
                    const info = this._delegatedPlugins.get(p);
                    return `${p}(${info?.metadata?.displayName || p})`;
                });
                roleCapabilities.push(`- ${role}: 可用插件 [${pluginDescs.join(', ')}]`);
            }
        }

        const skillsDir = path.resolve(this._pluginDir, '..', '..', '..', 'skills', 'xiaohongshu-skills');
        const toolsAndSkillsBlock = this._buildPlannerToolsAndSkillsSection();

        const codePlugins = pluginBindings.code || [];
        const codePluginHint = codePlugins.length > 0
            ? `规划涉及下列能力时，步骤 role 必须为 code，且 plugins 使用本机已绑定的代码插件（当前可用: ${codePlugins.join(', ')}）。`
            : '当前未配置可用的代码执行插件；若用户目标依赖脚本/精确计算，仍应规划为 code 步骤并写明需求，由执行阶段报错或回退。';

        return [
            '你是一个任务规划器。你的工作是把用户的复合目标分解成可并行执行的步骤（DAG）。',
            '',
            '## 可用角色及能力',
            ...roleCapabilities,
            '',
            '## code 角色适用场景（应主动派给 code，不要误派给 image / reporter）',
            codePluginHint,
            '- 本机屏幕/窗口截图、录屏前准备、从显示器抓取像素并保存为文件（真实画面，不是文生图）。',
            '- 需要程序保证精度的任务：复杂算术、公式求值、统计汇总、单位换算、大数运算等（reporter 不负责可靠计算）。',
            '- 结构化数据处理：解析/生成 JSON、CSV、日志裁剪、批量重命名规则、简单格式转换、校验和/哈希等。',
            '- 调用本机环境能力：读本地文件做运算、HTTP 请求本地服务、执行经用户允许的自动化脚本、与操作系统 API 交互（在沙箱/插件允许范围内）。',
            '- 代码阅读、调试、运行示例、安装依赖说明后的脚本执行、命令行工具调用（由 code 插件执行，而非手写伪代码给 reporter）。',
            '',
            '## 其他角色与 code 的分工（避免选错）',
            '- image: 仅用于「根据文字/创意描述生成图画、插画、海报」等 AI 绘画；凡是「截取真实屏幕/游戏画面/窗口内容」一律不是 image。',
            '- video: 文生视频、短视频、动效片段；使用 jimeng-video 等视频插件，不要用 image 冒充。',
            '- file: 侧重文件系统读写、目录列举、用已有工具直接操作文件；若需「先算再写」「先抓屏再保存」应拆成 code（算/截）再 file 或一步 code 内完成保存。',
            '- reporter / synthesizer: 撰写、归纳、润色文案；不承担精确计算、不执行脚本、不截屏。',
            '- search: 联网检索事实与资料；不执行本机代码。',
            '- app: 启动/切换 GUI 应用程序；与「在应用内截图」组合时通常先 app 再 code 截屏，或一步 code 完成截屏。',
            '',
            toolsAndSkillsBlock,
            '',
            '## 步骤格式规则',
            '每个步骤必须包含以下字段:',
            '- id: 唯一标识符（英文，如 step_1, write_text, generate_img）',
            '- role: 执行该步骤的角色名（必须是上面列出的角色之一）',
            '- plugins: 该步骤需要的插件列表（字符串数组，纯文本角色填 []）',
            '- task: 该步骤的具体任务描述（给执行者看的，要详细具体）',
            '- dependsOn: 依赖的步骤 ID 列表（无依赖填 []，有依赖则该步骤等依赖完成后才执行）',
            '- outputKey: 输出标识符（英文，后续步骤可通过此 key 引用该步骤的输出）',
            '- inputBindings: 可选，从上游步骤引用数据。格式: { "参数名": "上游outputKey" }',
            '',
            '## 约束',
            '- 最多 6 个步骤',
            '- 尽可能让无依赖关系的步骤并行（dependsOn 为 []）',
            '- 不要创建只有一个步骤的计划（单步任务不需要规划）',
            '- 不要创建 research 角色的步骤（研究任务有专门的流程，不走这里）',
            '- 若用户明确要求「截取/截图/当前屏幕/屏幕截图」等真实屏幕画面，必须用 code 角色（如 code-executor）完成截屏与落盘；禁止用 image 角色的 AI 生图冒充屏幕截图',
            '- 若目标包含可靠数值结果、脚本执行或本机自动化，必须有 code 步骤；禁止只派 reporter 完成「算出」「跑一下脚本」类需求',
            '- 每个步骤的 task 描述必须足够详细，让执行者不需要额外上下文就能完成',
            '- 如果某步骤需要用到上游步骤的结果，必须在 inputBindings 中声明，并在 task 中提到 [参数名] 占位符',
            `- 小红书技能目录绝对路径: ${skillsDir}`,
            '',
            '## 输出格式（两段式，重要）',
            '第 1 段（可选，≤ 2 句话）：用你的思考方式写下当下判断。例如：「目标含截屏+发布两步，截屏走 code，发布走 skills；并行的话发布要等」。',
            '第 2 段（必需）：用单独一行 "---" 分隔后，输出严格的 JSON 数组（不要加 markdown 代码块、不要 ```json、不要任何额外注释）。',
            '如果你认为这个目标用单步就能完成，第 2 段输出空数组 []。',
            '',
            '完整示例（请严格模仿这个形态）:',
            '终局是发布小红书图文，需要截屏 + 发布两步；截屏失败时整盘崩，所以截屏要单独成步。',
            '---',
            '[{"id":"capture","role":"code","plugins":["code-executor"],"task":"...","dependsOn":[],"outputKey":"image"},{"id":"publish","role":"skills","plugins":["myneuro-plugin-skills"],"task":"...","dependsOn":["capture"],"outputKey":"result","inputBindings":{"image":"image"}}]',
            '',
            '## 用户目标',
            goal,
        ].join('\n');
    }

    _parsePlannerOutput(rawOutput, goal) {
        if (!rawOutput || typeof rawOutput !== 'string') {
            throw new Error('规划器未返回有效输出');
        }

        // 先剥离开头的思考片段（如果有的话，已在 sub-agent.js 的 run() 中日志打印过）
        let jsonStr = SubAgent.stripThinkingSnippet(rawOutput).trim();

        // 提取 JSON（可能被 markdown 代码块包裹）
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1].trim();
        }

        // 尝试提取纯 JSON 数组
        const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            jsonStr = arrayMatch[0];
        }

        let steps;
        try {
            steps = JSON.parse(jsonStr);
        } catch (error) {
            throw new Error(`规划器输出的 JSON 解析失败: ${error.message}\n原始输出: ${rawOutput.substring(0, 200)}`);
        }

        if (!Array.isArray(steps)) {
            throw new Error('规划器输出不是数组');
        }

        if (steps.length === 0) {
            return []; // 规划器判定为单步任务
        }

        // 验证并清理步骤
        return this._validateAndCleanSteps(steps);
    }

    _validateAndCleanSteps(steps) {
        const MAX_STEPS = 6;
        const ALLOWED_ROLES = new Set([
            'general', 'planner', 'search', 'reviewer', 'reporter',
            'synthesizer', 'code', 'music', 'image', 'video', 'file', 'app', 'skills',
        ]);

        if (steps.length > MAX_STEPS) {
            logToTerminal('warn', `${PLUGIN_TAG} 规划器返回 ${steps.length} 个步骤，截断到 ${MAX_STEPS}`);
            steps = steps.slice(0, MAX_STEPS);
        }

        const stepIds = new Set();
        const validated = [];

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];

            // 必需字段检查
            if (!step.id || typeof step.id !== 'string') {
                step.id = `step_${i + 1}`;
            }
            if (stepIds.has(step.id)) {
                step.id = `${step.id}_${i}`;
            }
            stepIds.add(step.id);

            if (!step.role || !ALLOWED_ROLES.has(step.role)) {
                logToTerminal('warn', `${PLUGIN_TAG} 步骤 "${step.id}" 角色 "${step.role}" 无效，改为 general`);
                step.role = 'general';
            }

            // 禁止 research 角色（有专门流程）
            if (step.role === 'planner') {
                step.role = 'general';
            }

            if (!step.task || typeof step.task !== 'string') {
                throw new Error(`步骤 "${step.id}" 缺少 task 描述`);
            }

            if (!Array.isArray(step.dependsOn)) {
                step.dependsOn = [];
            }
            // 过滤不存在的依赖
            step.dependsOn = step.dependsOn.filter(depId => stepIds.has(depId) || steps.some(s => s.id === depId));

            if (!step.outputKey || typeof step.outputKey !== 'string') {
                step.outputKey = `output_${step.id}`;
            }

            if (!Array.isArray(step.plugins)) {
                step.plugins = [];
            }

            // 为需要插件的角色自动绑定插件（如果规划器没指定）
            if (step.plugins.length === 0 && !['reporter', 'reviewer', 'synthesizer', 'general', 'planner', 'persona'].includes(step.role)) {
                const rolePlugins = this._pickPluginsByRole(step.role);
                if (rolePlugins.length > 0) {
                    step.plugins = [rolePlugins[0]];
                }
            }

            if (step.inputBindings && typeof step.inputBindings !== 'object') {
                step.inputBindings = {};
            }

            validated.push({
                id: step.id,
                role: step.role,
                plugins: step.plugins,
                task: step.task,
                dependsOn: step.dependsOn,
                outputKey: step.outputKey,
                inputBindings: step.inputBindings || {},
            });
        }

        // 循环依赖检测
        if (this._hasCircularDeps(validated)) {
            throw new Error('规划器输出的步骤存在循环依赖');
        }

        return validated;
    }

    _hasCircularDeps(steps) {
        const visited = new Set();
        const visiting = new Set();
        const stepMap = new Map(steps.map(s => [s.id, s]));

        const dfs = (id) => {
            if (visiting.has(id)) return true; // 环
            if (visited.has(id)) return false;
            visiting.add(id);
            const step = stepMap.get(id);
            if (step) {
                for (const depId of step.dependsOn) {
                    if (dfs(depId)) return true;
                }
            }
            visiting.delete(id);
            visited.add(id);
            return false;
        };

        for (const step of steps) {
            if (dfs(step.id)) return true;
        }
        return false;
    }

    _ensureArchiveDir() {
        const archiveDir = path.join(this._pluginDir, 'data', 'research-archive');
        fs.mkdirSync(archiveDir, { recursive: true });
        this._archiveDir = archiveDir;
    }

    _enqueueTask(taskId, kind, payload, reason) {
        const task = this._activeTasks.get(taskId);
        if (!task) return;
        if (this._taskQueue.some(item => item.taskId === taskId)) return;
        task.status = TASK_STATUS.PENDING;
        task.updatedAt = Date.now();
        task.meta.queueReason = reason || '';
        this._taskQueue.push({ taskId, kind, payload, queuedAt: Date.now() });
    }

    _scheduleQueuedTasks() {
        if (this._taskQueue.length === 0) return;

        const remaining = [];
        for (const item of this._taskQueue) {
            const task = this._activeTasks.get(item.taskId);
            if (!task || task.status !== TASK_STATUS.PENDING) continue;

            const limitCheck = this._checkRoleCapacity(task.role);
            if (limitCheck) {
                remaining.push(item);
                continue;
            }

            if (item.kind === 'delegate') {
                const { info, options } = item.payload;
                this._runDelegateTask(item.taskId, info, options).catch(() => {});
            } else if (item.kind === 'research') {
                const { options } = item.payload;
                this._runResearchTask(item.taskId, options).catch(() => {});
            }
        }

        this._taskQueue = remaining;
    }

    _buildStructuredResult(task, payload = {}) {
        return {
            task_id: task.id,
            type: task.type,
            title: task.title,
            status: task.status,
            role: task.role,
            plugin_name: task.pluginName,
            summary: payload.summary || '',
            sections: payload.sections || {},
            artifacts: payload.artifacts || [],
            error: payload.error || task.error || '',
            created_at: task.createdAt,
            started_at: task.startedAt,
            finished_at: task.finishedAt,
            subtasks: task.subtasks || [],
        };
    }

    _archiveResearchTask(task) {
        try {
            if (!this._archiveDir) this._ensureArchiveDir();
            const safeTitle = (task.title || 'research').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            const filePath = path.join(this._archiveDir, `${task.id}_${safeTitle}.md`);
            const content = [
                `# ${task.title}`,
                '',
                `- 任务ID: ${task.id}`,
                `- 状态: ${task.status}`,
                `- 创建时间: ${new Date(task.createdAt).toISOString()}`,
                `- 完成时间: ${new Date(task.finishedAt || Date.now()).toISOString()}`,
                '',
                task.structuredResult?.internal_result || task.result || '',
                '',
                '## Structured Result',
                '```json',
                JSON.stringify(task.structuredResult || {}, null, 2),
                '```',
            ].join('\n');
            fs.writeFileSync(filePath, content, 'utf8');
            task.meta.archivePath = filePath;
            if (task.structuredResult) {
                task.structuredResult.archive_path = filePath;
            }
        } catch (error) {
            logToTerminal('warn', `${PLUGIN_TAG} 研究归档失败: ${error.message}`);
        }
    }

    _getConfiguredPluginsForRole(role) {
        // 新 schema 优先：roles[role].plugins（逗号分隔字符串）
        const newRolesPlugins = this._pluginConfig?.roles?.[role]?.plugins;
        if (typeof newRolesPlugins === 'string' && newRolesPlugins.trim()) {
            return newRolesPlugins.split(',').map(item => item.trim()).filter(Boolean);
        }
        // 老 schema 兼容
        const oldRaw = this._pluginConfig?.role_plugin_bindings?.[role];
        if (typeof oldRaw === 'string' && oldRaw.trim()) {
            return oldRaw.split(',').map(item => item.trim()).filter(Boolean);
        }
        return [];
    }

    _extractJsonObjectFromLlmText(raw) {
        if (!raw || typeof raw !== 'string') throw new Error('空输出');
        // 先剥离开头的思考片段（若有 --- 分隔则取分隔后的部分；sub-agent 的 run() 已经把思考片段日志打印过）
        let s = SubAgent.stripThinkingSnippet(raw).trim();
        const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) s = codeBlockMatch[1].trim();
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start === -1 || end === -1 || end <= start) throw new Error('无 JSON 对象');
        return JSON.parse(s.slice(start, end + 1));
    }

    _buildGoalRouterPrompt(goal, hints = {}) {
        this._refreshDelegatedPluginsIfNeeded();
        const pluginsLines = [];
        for (const [name, info] of this._delegatedPlugins) {
            const display = info.metadata?.displayName || name;
            const desc = (info.metadata?.description || '').replace(/\s+/g, ' ').trim().slice(0, 280);
            pluginsLines.push(`- \`${name}\`（${display}）${desc ? `: ${desc}` : ''}`);
        }
        const templates = this._getCompositeTemplates();
        const templateLines = [];
        for (const [templateName] of Object.entries(templates)) {
            templateLines.push(`- \`${templateName}\`: 预设复合流程；若用户要**真实屏幕截图**再发帖，不要选 composite，应选 planned_composite`);
        }
        const sp = (hints.suggested_plugin || '').trim();
        const sr = (hints.suggested_agent_role || '').trim();
        const suggestionBlock =
            sp || sr
                ? [
                    '',
                    '## 主观对话层的建议（仅供参考；你必须根据「用户目标」独立裁决，有权完全否决）',
                    sp ? `- 对方建议的插件 plugin_name: \`${sp}\`` : '- 对方未建议具体插件',
                    sr ? `- 对方建议的角色 agent_role: \`${sr}\`` : '',
                    '若建议与用户目标语义不符（例如用应用启动器打开网址、把截图判成生图），**以用户目标为准**，选择正确的工作流与 plugin_name。',
                    '',
                ]
                    .filter(line => line !== '')
                    .join('\n')
                : '';
        return [
            '你是世界之眼的目标路由器。只根据用户目标选择工作流类型，不执行工具。',
            '',
            '## 当前已代理插件（delegate 时 plugin_name 必须完全匹配下列之一）',
            pluginsLines.length ? pluginsLines.join('\n') : '（无）',
            '',
            '## 预设复合模板（仅当用户目标明显匹配固定多步产品流程时选 composite）',
            templateLines.length ? templateLines.join('\n') : '（当前无模板）',
            '',
            '## 工作流类型 workflow 取值',
            '- research — 用户要**联网检索、资料综述、趋势分析、来源考证、写研究报告**（不是单纯本地文件操作）。',
            '- planned_composite — **多能力编排**：出现「先…再…」「然后」「同时」、或明显要多个不同角色协作；或「**截取真实屏幕/窗口/游戏画面** + 发帖/写文案」等与固定模板冲突的组合。',
            '- composite — **仅当**用户目标匹配某预设模板且不需要插入截屏等偏离模板的步骤；需同时给出 composite_template。',
            '- delegate — **单插件可完成**的明确任务（例如只生成视频、只生图、只跑代码、只读文件）。',
            '',
            '## 能力区分（极易错，务必遵守）',
            '- **真实屏幕/显示器/窗口/游戏画面截图、截屏** → workflow=delegate, agent_role=code, plugin_name 选本机 code 类插件（如 code-executor），**绝不是 image**。',
            '- **打开网站、访问 URL、网页导航、网页登录、网页点击、表单填写、页面抓取、网页测试、浏览器自动化** → 优先选择 `skills` 角色，并把 plugin_name 设为 skills 类插件（如 myneuro-plugin-skills）；**不要**把任意网站访问误判为 app / windows-app-launcher。',
            '- **应用启动器 windows-app-launcher** 只用于打开 apps.json 中已登记的本机应用、桌面快捷方式或已保存的网址快捷方式名称；若用户直接给出网址、域名或要求浏览网页，不能选它。',
            '- **根据文字描述 AI 生成图画/插画/海报** → image 插件（如 openrouter-image）。',
            '- **文生视频、短视频、动效影片** → 选名称含 video 的插件（如 jimeng-video）；**不是 openrouter-image**。',
            '- **「画质」「4K」「保存到本地」** 只是质量或落盘要求，**不改变**主类型判断。',
            '- 用户只说了「保存」但若主体是生成视频/图，仍选对应生成类插件，不要仅因「保存」选 file。',
            suggestionBlock,
            '',
            '## 输出格式（两段式）',
            '第 1 段（可选，≤ 1 句话）：用你"冷静速判"的方式写下当下判断。例如：「截屏+发帖明显多步骤，走 planned_composite」。',
            '第 2 段（必需）：用单独一行 "---" 分隔后，输出严格的**一个** JSON 对象（不要 markdown 代码块、不要 ```json、不要其他文字）。字段如下：',
            '{',
            '  "workflow": "research" | "planned_composite" | "composite" | "delegate",',
            '  "composite_template": "模板 id 或 null",',
            '  "plugin_name": "delegate 时必填，与上表完全一致；其他 workflow 可 null",',
            '  "agent_role": "general|search|image|video|music|code|file|app|skills 之一，delegate 时尽量填准",',
            '  "brief_reason": "不超过 40 字"',
            '}',
            '',
            '## 用户目标',
            goal,
        ].join('\n');
    }

    _normalizeRouterDecision(obj) {
        const wf = (obj.workflow || '').toLowerCase().trim();
        const brief = (obj.brief_reason || '').slice(0, 200);

        if (wf === 'research') {
            return { type: 'research' };
        }
        if (wf === 'planned_composite') {
            return { type: 'planned_composite' };
        }
        if (wf === 'composite') {
            const tpl = (obj.composite_template || '').trim();
            const templates = this._getCompositeTemplates();
            if (tpl && templates[tpl]) {
                return { type: 'composite', templateName: tpl };
            }
            logToTerminal('warn', `${PLUGIN_TAG} 路由模型返回未知模板 "${tpl}"，改为 planned_composite`);
            return { type: 'planned_composite' };
        }
        if (wf === 'delegate') {
            const name = (obj.plugin_name || '').trim();
            this._refreshDelegatedPluginsIfNeeded();
            if (name && this._delegatedPlugins.has(name)) {
                const role = (obj.agent_role || '').trim() || this._inferRoleFromPlugin(name);
                return { type: 'delegate', pluginName: name, role };
            }
            logToTerminal('warn', `${PLUGIN_TAG} 路由 delegate 插件名无效 "${name}"，回退启发式路由`);
            return null;
        }
        logToTerminal('warn', `${PLUGIN_TAG} 路由模型返回未知 workflow "${wf}"，回退启发式。原因: ${brief}`);
        return null;
    }

    async _invokeGoalRouterLLM(goal, hints = {}) {
        this._ensureSubAgent();
        const prompt = this._buildGoalRouterPrompt(goal, hints);
        const raw = await this._subAgent.run({
            role: 'router',
            taskDescription: prompt,
            toolDefinitions: [],
            // 路由器只输出 JSON，prompt 较短；与规划器同样尊重用户配置（上限 90s）
            signal: AbortSignal.timeout(Math.min(90000, Math.max(20000, this._getConfiguredLlmTimeoutMs()))),
            workerLabel: 'goal-router',
            isTemporaryWorker: true,
            maxIterations: 1,
            temperature: 0.15,
        });
        if (!raw || (typeof raw === 'string' && raw.includes('任务执行失败'))) {
            throw new Error(typeof raw === 'string' ? raw : '路由器无输出');
        }
        const data = this._extractJsonObjectFromLlmText(raw);
        return data;
    }

    /** 主对话建议的插件与世界之眼最终 delegate 结果不一致时打日志（不阻断） */
    _logSuggestedPluginOverride(hints, workflow, sourceLabel) {
        const sug = (hints.suggested_plugin || '').trim();
        if (
            !sug
            || !workflow
            || workflow.type !== 'delegate'
            || !workflow.pluginName
            || workflow.pluginName === sug
        ) {
            return;
        }
        logToTerminal(
            'info',
            `${PLUGIN_TAG} ${sourceLabel}否决主模型建议插件「${sug}」，选用「${workflow.pluginName}」`
        );
    }

    async _selectWorkflowAccurate(goal, hints = {}) {
        this._refreshDelegatedPluginsIfNeeded();
        if (this._delegatedPlugins.size === 0) {
            logToTerminal('warn', `${PLUGIN_TAG} 无代理插件，跳过 LLM 路由`);
            const emptyWf = this._selectWorkflow(goal, hints);
            this._logSuggestedPluginOverride(hints, emptyWf, '启发式路由');
            return emptyWf;
        }
        try {
            const data = await this._invokeGoalRouterLLM(goal, hints);
            const workflow = this._normalizeRouterDecision(data);
            if (workflow) {
                this._logSuggestedPluginOverride(hints, workflow, 'LLM 路由');
                logToTerminal('info', `${PLUGIN_TAG} LLM 路由: ${data.workflow} → ${workflow.type}${workflow.pluginName ? ` (${workflow.pluginName})` : ''}`);
                return workflow;
            }
        } catch (error) {
            logToTerminal('warn', `${PLUGIN_TAG} LLM 路由失败，回退关键词: ${error.message}`);
        }
        const fallbackWf = this._selectWorkflow(goal, hints);
        this._logSuggestedPluginOverride(hints, fallbackWf, '启发式路由');
        return fallbackWf;
    }

    _selectWorkflow(goal, hints = {}) {
        void hints;
        const text = goal.toLowerCase();
        const wantsBrowserSkill = BROWSER_SKILL_INTENT_RE.test(goal) || BROWSER_SKILL_INTENT_RE.test(text);

        // 真实屏幕截图 + 小红书发帖：不能用固定模板 xiaohongshu_publish（该模板第二步永远是 AI 生图），改走动态规划以便插入 code 截图步骤
        const wantsScreenCapture = /(截取当前屏幕|截取.*屏幕|截图|截屏|屏幕截图|屏幕抓取|screen\s*shot|screenshot)/i.test(goal);
        const wantsXhsPublish = /(小红书|xhs|红书)/i.test(goal)
            && /(发布|发帖|发小红书|发到小红书|发一篇|写一篇)/i.test(goal);
        if (wantsScreenCapture && wantsXhsPublish) {
            return { type: 'planned_composite' };
        }

        // 复合工作流模板优先匹配
        const templates = this._getCompositeTemplates();
        for (const [templateName, template] of Object.entries(templates)) {
            if (template.keywords.test(goal) || template.keywords.test(text)) {
                return { type: 'composite', templateName };
            }
        }

        if (/(研究|分析|趋势|来源|综述|报告|考证)/.test(goal)) {
            return { type: 'research' };
        }
        if (VIDEO_INTENT_RE.test(goal)) {
            const pluginName = this._pickPluginsByRole('video')[0];
            if (pluginName) {
                return { type: 'delegate', role: this._inferRoleFromPlugin(pluginName), pluginName };
            }
        }
        if (IMAGE_INTENT_RE.test(goal)) {
            const pluginName = this._pickPluginsByRole('image')[0] || 'openrouter-image';
            return { type: 'delegate', role: 'image', pluginName };
        }
        if (/(音乐|歌曲|播放|歌单|bgm|作曲|生成音乐)/i.test(text)) {
            const pluginName = this._pickPluginsByRole('music')[0] || 'rebirth-feiniu-music';
            return { type: 'delegate', role: 'music', pluginName };
        }
        if (/(代码|脚本|报错|修复|执行|调试|python|node)/i.test(text)) {
            const pluginName = this._pickPluginsByRole('code')[0] || 'code-executor';
            return { type: 'delegate', role: 'code', pluginName };
        }
        if (wantsBrowserSkill) {
            const pluginName = this._pickPluginsByRole('skills')[0] || 'myneuro-plugin-skills';
            return { type: 'delegate', role: 'skills', pluginName };
        }
        if (/(文件|目录|保存|写入|读取|txt|文档)/.test(goal)) {
            const pluginName = this._pickPluginsByRole('file')[0] || 'mcp-filesystem';
            return { type: 'delegate', role: 'file', pluginName };
        }
        if (/(打开|启动|应用|软件|程序|桌面)/.test(goal)) {
            const pluginName = this._pickPluginsByRole('app')[0] || 'windows-app-launcher';
            return { type: 'delegate', role: 'app', pluginName };
        }

        // 动态规划: 检测目标是否涉及多步骤/跨角色协作
        if (this._looksLikeMultiStepGoal(goal)) {
            return { type: 'planned_composite' };
        }

        const pluginName = this._pickPluginsByRole('general')[0] || Array.from(this._delegatedPlugins.keys())[0];
        return { type: 'delegate', role: this._inferRoleFromPlugin(pluginName), pluginName };
    }

    /**
     * 启发式判断目标是否需要多步骤跨角色协作。
     * 检测连接词/多动作模式，以及目标中是否涉及 2+ 个不同角色的关键词。
     */
    _looksLikeMultiStepGoal(goal) {
        // 连接词/多步骤信号词
        const multiStepPatterns = /先.{2,}再|.{2,}然后.{2,}|.{2,}之后.{2,}|.{2,}并且.{2,}|.{2,}同时.{2,}|第一步.{2,}第二步|步骤\s*[1１一]|分.{0,2}步/;
        if (multiStepPatterns.test(goal)) return true;

        // 角色关键词映射
        const roleKeywords = {
            research: /(研究|分析|趋势|来源|综述|考证|调研|查一下|搜索)/,
            image: IMAGE_INTENT_RE,
            music: /(音乐|歌曲|bgm|作曲|生成音乐)/,
            code: /(代码|脚本|执行|python|node|编程)/,
            file: /(文件|保存|写入|读取|文档)/,
            app: /(打开|启动|应用|软件)/,
            skills: /(发布|自动化|技能|脚本执行|网址|链接|网站|网页|浏览器|登录网站|登录网页|表单填写|页面抓取|网页测试)/,
            reporter: /(撰写|写文|写作|文案|文章|内容)/,
        };
        const matchedRoles = new Set();
        for (const [role, pattern] of Object.entries(roleKeywords)) {
            if (pattern.test(goal)) matchedRoles.add(role);
        }
        if (matchedRoles.size >= 2) return true;

        return false;
    }

    _getTaskLimits() {
        const limits = this._pluginConfig?.task_limits || {};
        return {
            maxConcurrentTasks: Number(limits.max_concurrent_tasks || 6),
            maxConcurrentCodeTasks: Number(limits.max_concurrent_code_tasks || 1),
        };
    }

    _getSecurityConfig() {
        const security = this._pluginConfig?.security || {};
        return {
            codeExecutionEnabled: security.code_execution_enabled !== false,
            codeAllowedPlugins: typeof security.code_allowed_plugins === 'string'
                ? security.code_allowed_plugins.split(',').map(item => item.trim()).filter(Boolean)
                : ['code-executor'],
            blockDangerousCommands: security.block_dangerous_commands !== false,
            dangerousCommandPatterns: [
                /rm\s+-rf/i,
                /del\s+\/f/i,
                /format\s+/i,
                /shutdown\s+/i,
                /reg\s+delete/i,
                /Remove-Item\s+.*-Recurse/i,
            ],
        };
    }

    _getResourceKeysForRole(role) {
        if (role === 'code') return ['code-runtime'];
        if (role === 'music') return ['music-player'];
        if (role === 'image') return ['image-generation'];
        if (role === 'file') return ['filesystem-write'];
        if (role === 'app') return ['desktop-control'];
        return [];
    }

    _tryAcquireResources(taskId, role) {
        const resources = this._getResourceKeysForRole(role);
        for (const key of resources) {
            const owner = this._resourceLocks.get(key);
            if (owner && owner !== taskId) {
                return `错误: 资源 ${key} 当前正被任务 ${owner} 占用，请稍后再试。`;
            }
        }
        for (const key of resources) {
            this._resourceLocks.set(key, taskId);
        }
        return '';
    }

    _releaseResources(taskId) {
        for (const [key, owner] of Array.from(this._resourceLocks.entries())) {
            if (owner === taskId) {
                this._resourceLocks.delete(key);
            }
        }
    }

    _checkCodeTaskSafety(pluginName, taskDescription) {
        const security = this._getSecurityConfig();
        if (!security.codeExecutionEnabled) {
            return '错误: 当前已禁用代码执行任务。';
        }

        if (security.codeAllowedPlugins.length > 0 && !security.codeAllowedPlugins.includes(pluginName)) {
            return `错误: 插件 ${pluginName} 不在允许的代码执行插件列表中。`;
        }

        if (security.blockDangerousCommands) {
            for (const pattern of security.dangerousCommandPatterns) {
                if (pattern.test(taskDescription)) {
                    return '错误: 任务描述中包含被拦截的高危命令模式，已拒绝执行。';
                }
            }
        }

        return '';
    }

    _checkRoleCapacity(role) {
        const limits = this._getTaskLimits();
        const runningTasks = Array.from(this._activeTasks.values()).filter(task => task.status === TASK_STATUS.RUNNING).length;
        if (runningTasks >= limits.maxConcurrentTasks) {
            return `错误: 当前世界之眼运行中的任务过多，已达到并发上限 ${limits.maxConcurrentTasks}。`;
        }

        if (role === 'code') {
            const current = this._runningRoleCounts.get('code') || 0;
            if (current >= limits.maxConcurrentCodeTasks) {
                return `错误: 当前代码任务已达到并发上限 ${limits.maxConcurrentCodeTasks}。`;
            }
        }

        return '';
    }

    _enterRole(role) {
        const current = this._runningRoleCounts.get(role) || 0;
        this._runningRoleCounts.set(role, current + 1);
    }

    _leaveRole(role) {
        const current = this._runningRoleCounts.get(role) || 0;
        if (current <= 1) {
            this._runningRoleCounts.delete(role);
        } else {
            this._runningRoleCounts.set(role, current - 1);
        }
    }

    _inferRoleFromPlugin(pluginName) {
        if (this._getConfiguredPluginsForRole('code').includes(pluginName) || ['code-executor'].includes(pluginName)) return 'code';
        if (this._getConfiguredPluginsForRole('music').includes(pluginName) || ['minimax-music', 'rebirth-feiniu-music'].includes(pluginName)) return 'music';
        if (this._getConfiguredPluginsForRole('video').includes(pluginName) || ['jimeng-video'].includes(pluginName) || /(^|-)video$/i.test(pluginName)) return 'video';
        if (this._getConfiguredPluginsForRole('image').includes(pluginName) || ['openrouter-image'].includes(pluginName)) return 'image';
        if (this._getConfiguredPluginsForRole('search').includes(pluginName) || ['multi-search', 'bilibili-tools'].includes(pluginName)) return 'search';
        if (this._getConfiguredPluginsForRole('file').includes(pluginName) || ['mcp-filesystem', 'txt-writer'].includes(pluginName)) return 'file';
        if (this._getConfiguredPluginsForRole('app').includes(pluginName) || ['windows-app-launcher'].includes(pluginName)) return 'app';
        if (this._getConfiguredPluginsForRole('skills').includes(pluginName) || ['myneuro-plugin-skills'].includes(pluginName)) return 'skills';
        return 'general';
    }

    _wrapResult(title, taskDescription, result) {
        const sanitized = this._sanitizePersonaArtifacts(result);
        return [
            `【世界之眼·${title}】`,
            `任务: ${taskDescription}`,
            '',
            sanitized,
            '',
            '——以上为世界之眼执行结果。请根据结果内容自然回复用户，**不要**复述报告标签，**不要**提及世界之眼/任何内部 agent 名/动漫人物名/作品名（这些只是内部协作概念）。',
        ].join('\n');
    }

    /**
     * 剥离最终结果中的「思考片段」「handoff 信件」「【返回上游】」「【内心独白】」等内部协作语料，
     * 主 LLM 只应看到事实层。
     */
    _sanitizePersonaArtifacts(content) {
        if (!content || typeof content !== 'string') return content;
        let s = content;

        // 1. 移除最开头的「思考片段 + ---」块（只移除第一次出现）
        s = s.replace(/^[\s\S]*?\n\s*---\s*\n/, '');

        // 2. 移除 handoff 信件块 「## 来自 X · YYY（ZZZ）的交接 ... 直到下一个 ## 或末尾」
        s = s.replace(/##\s*来自[\s\S]*?(?=\n##\s|$)/g, '').trim();

        // 3. 移除残留的【内心独白】（旧版兼容）
        s = s.replace(/【内心独白】[\s\S]*?---\s*\n?/g, '').trim();

        // 4. 移除任何残留的 【返回上游】 块
        s = s.replace(/【返回上游】[\s\S]*?(?=\n##\s|$)/g, '').trim();

        // 5. 移除残留的角色名信号（保守做法：只移除 emoji+shortName 单独成行的标题，不动正文）
        s = s.replace(/^\s*[♟️⚔️🔍❄️📖⚗️🌸💻🎹🎨🎬📚🛡️🥷💤]\s*\S{1,8}\s*$/gm, '').trim();

        return s || content;
    }

    _formatTaskStatus(task) {
        const elapsed = ((Date.now() - task.createdAt) / 1000).toFixed(1);
        return [
            `任务ID: ${task.id}`,
            `类型: ${task.type}`,
            `标题: ${task.title}`,
            `状态: ${task.status}`,
            `角色: ${task.role}`,
            `已运行: ${elapsed}s`,
            `子任务数: ${task.subtasks.length}`,
            task.meta?.queueReason ? `排队原因: ${task.meta.queueReason}` : '',
            task.status === TASK_STATUS.WAITING_INPUT && task.meta?.blockReason
                ? `受阻原因: ${task.meta.blockReason}（用 world_eye_control 的 answer 动作补充信息可续跑）`
                : '',
            task.meta?.archivePath ? `归档: ${task.meta.archivePath}` : '',
        ].filter(Boolean).join('\n');
    }

    _listTasks() {
        if (this._activeTasks.size === 0) {
            return '当前没有世界之眼任务。';
        }
        return Array.from(this._activeTasks.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10)
            .map(task => `${task.id} | ${task.status} | ${task.type} | ${task.title}${task.meta?.queueReason ? ' | queued' : ''}`)
            .join('\n');
    }

    _listQueue() {
        if (this._taskQueue.length === 0) {
            return '当前任务队列为空。';
        }
        return this._taskQueue.map(item => {
            const task = this._activeTasks.get(item.taskId);
            return `${item.taskId} | ${item.kind} | ${task?.title || ''} | ${task?.meta?.queueReason || ''}`;
        }).join('\n');
    }
}

module.exports = WorldEyePlugin;
