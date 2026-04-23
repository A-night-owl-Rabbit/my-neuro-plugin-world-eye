// 世界之眼 (World Eye) v3 - 任务型多智能体代理路由

const fs = require('fs');
const path = require('path');
const { Plugin } = require('./lib/plugin-base.js');
const { logToTerminal } = require('./lib/log.js');
const { SubAgent } = require('./sub-agent.js');

const PLUGIN_TAG = '🌍 [世界之眼]';
const TOOLS_CACHE_TTL = 60_000;
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
};

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
        /** 投递前的冷静期（等用户停止交互后再投递） */
        this._deliveryCooldownMs = 2000;
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

    async onStop() {
        this._teardownAsyncDelivery();
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
     */
    _enqueueResult(taskId, taskTitle, result) {
        this._pendingResults.push({
            taskId,
            taskTitle,
            result,
            timestamp: Date.now(),
            delivered: false,
        });
        logToTerminal('info', `${PLUGIN_TAG} 任务 ${taskId} 结果已入队，待投递队列长度: ${this._pendingResults.length}`);
        this._scheduleDeliveryCheck();
    }

    /**
     * 安排一次投递检查（带冷静期，避免打断正在进行的交互）。
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
     * 检查是否空闲，若空闲则投递队列中的待处理结果。
     */
    async _tryDeliverResults() {
        if (this._isDelivering) return;
        if (this._pendingResults.length === 0) return;

        this._purgeExpiredResults();
        if (this._pendingResults.length === 0) return;

        if (!this._isConversationIdle()) {
            this._scheduleDeliveryCheck();
            return;
        }

        this._isDelivering = true;
        try {
            const batch = this._pendingResults.splice(0, this._pendingResults.length);
            const combinedParts = [];
            for (const item of batch) {
                combinedParts.push(
                    `--- 任务 ${item.taskId}（${item.taskTitle}）---\n${item.result}`
                );
            }
            const resultText = combinedParts.join('\n\n');
            const taskIds = batch.map(b => b.taskId).join(', ');

            this.context.addSystemPromptPatch(
                'world_eye_async_result',
                `\n[世界之眼异步任务结果]\n以下是后台完成的任务结果。请用你自己的人设语气和风格，自然地把结果告诉用户，就像你自己完成了一样，不要提"世界之眼"或"后台任务"这些内部概念：\n${resultText}\n[/世界之眼异步任务结果]`
            );

            logToTerminal('info', `${PLUGIN_TAG} 正在投递异步结果: ${taskIds}`);
            await this.context.sendMessage(
                `[内部提示] 之前安排的任务有结果了，请查看系统提示中的任务结果，用你的人设和语气自然地告诉用户。`
            );

            setTimeout(() => {
                this.context.removeSystemPromptPatch('world_eye_async_result');
            }, 5000);
        } catch (e) {
            logToTerminal('error', `${PLUGIN_TAG} 异步结果投递失败: ${e.message}`);
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
                '使用哪个插件由世界之眼根据任务语义独立裁决；主对话填写的 plugin_name 仅为参考，可被否决。'
            );
        }

        /** 世界之眼内部路由已完成（goal → delegate），直接跑子智能体 */
        if (params._fromGoalRedirect) {
            return await this._executeDelegatedPluginRun(params, taskDescription, mode);
        }

        /** 主对话层：一律先经世界之眼路由；plugin_name / agent_role 仅作建议 */
        const suggestedPlugin = params.plugin_name != null ? String(params.plugin_name).trim() : '';
        const suggestedRole =
            typeof params.agent_role === 'string' && params.agent_role.trim()
                ? params.agent_role.trim()
                : undefined;
        if (suggestedPlugin) {
            logToTerminal(
                'info',
                `${PLUGIN_TAG} delegate: 主模型建议插件「${suggestedPlugin}」` +
                    `${suggestedRole ? `、角色「${suggestedRole}」` : ''}，将由世界之眼路由裁决（可否决）`
            );
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

        const limitCheck = this._checkRoleCapacity(role);
        const queueReason = limitCheck || '';

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
        });

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
        const output = (params.output || 'report+persona').toLowerCase();
        const mode = (params.mode || 'sync').toLowerCase();

        if (!topic.trim()) {
            return '错误: 缺少 topic 参数。';
        }

        const searchTools = this._getResearchToolsForPlugins(this._pickPluginsByRole('search'));
        if (searchTools.length === 0) {
            return '错误: 当前没有可用于研究任务的搜索工具，请先在世界之眼配置中启用 multi-search、bilibili-tools 或相关搜索插件。';
        }

        const plannerLimit = this._checkRoleCapacity('planner');

        const task = this._createTask({
            type: 'research',
            title: `研究: ${topic.substring(0, 50)}`,
            role: 'planner',
            taskDescription: topic,
            mode,
            meta: { depth, output },
        });

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
                output: params.output || 'report+persona',
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
            logToTerminal('info', `${PLUGIN_TAG} 任务已中止: ${task.id}`);
            return `已请求中止任务: ${task.id}`;
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

        return '未知的控制动作。支持: status, stop, cancel, result, raw_result, list, queue';
    }

    _getMetaTools() {
        if (this._cachedMetaTools) return this._cachedMetaTools;
        this._cachedMetaTools = this._buildMetaTools();
        return this._cachedMetaTools;
    }

    _buildMetaTools() {
        const pluginLines = [];
        for (const [name, info] of this._delegatedPlugins) {
            const displayName = info.metadata.displayName || name;
            const desc = info.metadata.description || '无描述';
            pluginLines.push(`- ${name} (${displayName}): ${desc}`);
        }

        if (pluginLines.length === 0) return [];

        const delegateDesc = [
            '【异步执行】调用后立即返回任务ID，世界之眼在后台执行，结果完成后会自动通知你。',
            '填写 task_description 说明要达成什么结果或执行什么操作（路由以任务语义为准）。',
            '可选填写 plugin_name / agent_role：仅作主观对话层的**建议**，世界之眼独立裁决并**可完全否决**。',
            '工作流与 world_eye_goal 相同（研究、复合编排、单插件委派等）。',
            '',
            '⚠️ 多步骤、多能力协作请写清完整目标，不要拆成多次调用。也可直接使用 world_eye_goal。',
            '⚠️ 调用后用你自己的语气和人设风格告诉用户你已经安排了，不要等待结果。结果会在后台完成后自动推送给你。',
            '',
            '当前已代理插件（供主对话参考；最终选用由世界之眼决定）:',
            ...pluginLines,
        ].join('\n');

        return [
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
                                description:
                                    '可选。主观对话层对插件的猜测；世界之眼会独立裁决，**可不采纳**。名称须与已代理插件 id 一致（若填写）。',
                            },
                            task_description: {
                                type: 'string',
                                description:
                                    '要完成的目标或操作（路由以本字段语义为准）。'
                            },
                            agent_role: {
                                type: 'string',
                                description: '可选。主观对话层对角色的猜测；世界之眼可否决。',
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
                    description: '【异步执行】提交一个研究主题，立即返回任务ID。世界之眼会在后台自动完成规划、搜索、审查、报告生成，完成后自动通知你。适用于主题研究、资料综述、趋势分析、来源考证。调用后用你自己的人设风格告诉用户正在研究，不要等待结果。',
                    parameters: {
                        type: 'object',
                        properties: {
                            topic: {
                                type: 'string',
                                description: '研究主题，例如“清明扫墓的风俗来源”或“最近 AI 的发展趋势”。'
                            },
                            depth: {
                                type: 'string',
                                description: '研究深度',
                                enum: ['quick', 'standard', 'deep']
                            },
                            output: {
                                type: 'string',
                                description: '输出类型',
                                enum: ['summary', 'report', 'report+persona']
                            }
                        },
                        required: ['topic']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'world_eye_goal',
                    description: [
                        '【异步执行】提交一个任务目标，立即返回任务ID。世界之眼在后台自动选择最合适的工作流与插件执行，完成后自动通知你。调用后用你自己的人设风格告诉用户你已经安排了，不要等待结果。',
                        '',
                        '与 world_eye_delegate 的路由逻辑相同（主对话若填写 plugin_name 也仅为建议，世界之眼可否决）。',
                        '',
                        '★ 复合/多步骤需求请用本工具或 delegate，并把完整目标写清；不要依赖主对话猜测插件名。',
                        '例如:',
                        '- "画一张插画并写一段文案发布到小红书" → 自动拆分为 画图+写文案+发布 三步并行',
                        '- "搜索最新AI新闻然后写一篇总结" → 自动拆分为 搜索+撰写 两步',
                        '- "写一段代码并保存到文件" → 自动拆分为 编码+保存 两步',
                        '',
                        '也支持单步任务（画图、研究、音乐等），会自动路由到对应角色。',
                        '',
                        '世界之眼能力目录:',
                        ...this._buildCapabilityLines(),
                    ].join('\n'),
                    parameters: {
                        type: 'object',
                        properties: {
                            goal: {
                                type: 'string',
                                description: '任务目标（自然语言）。可以是单步目标如"画一张猫咪插画"，也可以是多步复合目标如"画一张赛博朋克少女插画，再写一段吐槽文案发到小红书"。复合目标请完整描述，不要拆分。'
                            },
                            depth: {
                                type: 'string',
                                description: '当目标被识别为研究任务时使用的深度',
                                enum: ['quick', 'standard', 'deep']
                            },
                            output: {
                                type: 'string',
                                description: '当目标被识别为研究任务时使用的输出类型',
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
                    name: 'world_eye_control',
                    description: '控制世界之眼任务：查看状态、获取结果、停止任务、列出任务。',
                    parameters: {
                        type: 'object',
                        properties: {
                            action: {
                                type: 'string',
                                description: '控制动作',
                                enum: ['status', 'stop', 'cancel', 'result', 'raw_result', 'list', 'queue']
                            },
                            task_id: {
                                type: 'string',
                                description: '任务ID。list 动作可省略。'
                            }
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
        for (const [name, enabled] of Object.entries(delegatedCfg)) {
            if (!enabled) continue;

            const plugin = global.pluginManager?.getPlugin(name);
            if (!plugin) continue;

            const meta = this._allPluginsMeta.get(name);
            if (!meta) continue;

            let tools = [];
            try {
                tools = plugin.getTools() || [];
            } catch { }

            this._delegatedPlugins.set(name, { metadata: meta, tools });
            for (const t of tools) {
                const toolName = (t.function || t).name || '';
                if (toolName) this._delegatedToolNames.add(toolName);
            }
        }

        this._lastToolsRefresh = Date.now();
    }

    _syncDelegatedPluginsConfig() {
        const configPath = path.join(this._pluginDir, 'plugin_config.json');
        let raw = {};
        try {
            if (fs.existsSync(configPath)) {
                raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch { }

        if (!raw.delegated_plugins || typeof raw.delegated_plugins !== 'object') {
            raw.delegated_plugins = {
                title: '代理插件列表',
                description: '勾选需要由世界之眼代理的插件，被代理的插件工具将由下级智能体执行',
                type: 'object',
                fields: {}
            };
        }

        const dp = raw.delegated_plugins;
        if (!dp.fields) dp.fields = {};

        const existingFields = dp.fields;
        const newFields = {};

        for (const [name, meta] of this._allPluginsMeta) {
            if (existingFields[name]) {
                newFields[name] = existingFields[name];
                newFields[name].title = meta.displayName || name;
                newFields[name].description = meta.description || '';
            } else {
                newFields[name] = {
                    title: meta.displayName || name,
                    description: meta.description || '',
                    type: 'bool',
                    default: false,
                    value: false
                };
            }
        }

        dp.fields = newFields;

        if (!raw.agent_models) {
            raw.agent_models = {
                title: '角色模型配置',
                description: '按角色为世界之眼内部智能体绑定不同模型。关闭独立模型则回退到下级智能体默认模型或主配置。',
                type: 'object',
                fields: {
                    planner: this._buildRoleModelField('规划角色'),
                    search: this._buildRoleModelField('搜索角色'),
                    reviewer: this._buildRoleModelField('审查角色'),
                    reporter: this._buildRoleModelField('报告角色'),
                    persona: this._buildRoleModelField('人设角色'),
                    code: this._buildRoleModelField('代码角色'),
                    music: this._buildRoleModelField('音乐角色'),
                    image: this._buildRoleModelField('生图角色'),
                    file: this._buildRoleModelField('文件角色'),
                    app: this._buildRoleModelField('应用角色'),
                    synthesizer: this._buildRoleModelField('汇总角色'),
                    skills: this._buildRoleModelField('技能角色'),
                }
            };
        }

        if (!raw.role_plugin_bindings) {
            raw.role_plugin_bindings = {
                title: '角色插件映射',
                description: '为各角色指定默认可调用的代理插件，使用逗号分隔插件名。为空时走内置默认映射。',
                type: 'object',
                fields: {
                    search: this._buildRolePluginBindingField('搜索角色', 'multi-search,bilibili-tools'),
                    music: this._buildRolePluginBindingField('音乐角色', 'minimax-music,rebirth-feiniu-music'),
                    image: this._buildRolePluginBindingField('生图角色', 'openrouter-image'),
                    code: this._buildRolePluginBindingField('代码角色', 'code-executor'),
                    file: this._buildRolePluginBindingField('文件角色', 'mcp-filesystem,txt-writer'),
                    app: this._buildRolePluginBindingField('应用角色', 'windows-app-launcher'),
                    general: this._buildRolePluginBindingField('通用角色', ''),
                    skills: this._buildRolePluginBindingField('技能角色', 'myneuro-plugin-skills'),
                }
            };
        }

        if (!raw.task_limits) {
            raw.task_limits = {
                title: '任务限制',
                description: '限制世界之眼并发任务数量，尤其是代码任务。',
                type: 'object',
                fields: {
                    max_concurrent_tasks: {
                        title: '最大并发任务数',
                        description: '世界之眼同时运行的任务上限',
                        type: 'int',
                        default: 6,
                        value: 6
                    },
                    max_concurrent_code_tasks: {
                        title: '最大并发代码任务数',
                        description: 'CodeAgent 同时运行上限，建议保持 1',
                        type: 'int',
                        default: 1,
                        value: 1
                    }
                }
            };
        }

        if (!raw.security) {
            raw.security = {
                title: '安全策略',
                description: '控制代码任务和高风险行为的安全限制。',
                type: 'object',
                fields: {
                    code_execution_enabled: {
                        title: '启用代码执行任务',
                        description: '关闭后将拒绝 CodeAgent 任务',
                        type: 'bool',
                        default: true,
                        value: true
                    },
                    code_allowed_plugins: {
                        title: '允许代码执行的插件',
                        description: '逗号分隔，默认只允许 code-executor',
                        type: 'string',
                        default: 'code-executor',
                        value: 'code-executor'
                    },
                    block_dangerous_commands: {
                        title: '拦截高危命令模式',
                        description: '对任务描述中的明显危险命令进行拦截',
                        type: 'bool',
                        default: true,
                        value: true
                    }
                }
            };
        }

        if (!raw.model_groups) {
            raw.model_groups = {
                title: '模型分组',
                description: '定义可复用的模型组（API地址+密钥+模型名），在 role_model_mapping 中通过组名引用，避免为每个角色重复填写。优先级低于 agent_models 中的独立配置。',
                type: 'object',
                fields: {
                    deepseek: {
                        title: 'DeepSeek（推理/规划/代码）',
                        description: '适合规划、路由、审查、代码等需要强推理能力的角色',
                        type: 'object',
                        fields: {
                            api_url: { title: 'API 地址', type: 'string', default: '', value: '' },
                            api_key: { title: 'API Key', type: 'string', default: '', value: '' },
                            model: { title: '模型名', type: 'string', default: 'deepseek-ai/DeepSeek-V3.2', value: '' },
                        }
                    },
                    qwen_coder: {
                        title: 'Qwen3-Coder（快速执行）',
                        description: '适合搜索、报告、汇总、生图、视频等执行类角色，通过硅基流动调用',
                        type: 'object',
                        fields: {
                            api_url: { title: 'API 地址', type: 'string', default: '', value: '' },
                            api_key: { title: 'API Key', type: 'string', default: '', value: '' },
                            model: { title: '模型名', type: 'string', default: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', value: '' },
                        }
                    },
                }
            };
        }

        if (!raw.role_model_mapping) {
            raw.role_model_mapping = {
                title: '角色→模型组映射',
                description: '为每个角色指定使用哪个模型组（填写 model_groups 中的组名）。留空则使用 agent_models 独立配置或默认配置。',
                type: 'object',
                fields: {
                    planner: { title: '规划角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '推荐 deepseek（需要强推理）' },
                    router: { title: '路由角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '推荐 deepseek（需要准确判断）' },
                    reviewer: { title: '审查角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '推荐 deepseek（需要批判性分析）' },
                    code: { title: '代码角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '推荐 deepseek（需要精确代码能力）' },
                    search: { title: '搜索角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder（工具调用快速执行）' },
                    reporter: { title: '报告角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '需要结构化分析能力' },
                    general: { title: '通用角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    image: { title: '生图角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    video: { title: '视频角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    file: { title: '文件角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    app: { title: '应用角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    skills: { title: '技能角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                    synthesizer: { title: '汇总角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '需要归纳推理能力' },
                    persona: { title: '人设角色', type: 'string', default: 'deepseek', value: 'deepseek', description: '需要理解人设风格进行改写' },
                    music: { title: '音乐角色', type: 'string', default: 'qwen_coder', value: 'qwen_coder', description: '推荐 qwen_coder' },
                }
            };
        }

        try {
            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
        } catch (e) {
            logToTerminal('warn', `${PLUGIN_TAG} 写入 plugin_config.json 失败: ${e.message}`);
        }

        this._loadConfig();
    }

    _buildRoleModelField(title) {
        return {
            title,
            description: `${title}使用的独立模型配置`,
            type: 'object',
            fields: {
                use_separate_model: {
                    title: '使用独立模型',
                    description: '关闭则回退到默认下级模型配置',
                    type: 'bool',
                    default: false,
                    value: false
                },
                api_key: {
                    title: 'API Key',
                    description: '该角色专用 API Key',
                    type: 'string',
                    default: '',
                    value: ''
                },
                api_url: {
                    title: 'API 地址',
                    description: '该角色专用 API 地址',
                    type: 'string',
                    default: '',
                    value: ''
                },
                model: {
                    title: '模型名称',
                    description: '该角色使用的模型',
                    type: 'string',
                    default: '',
                    value: ''
                },
                max_iterations: {
                    title: '最大调用轮次',
                    description: '该角色单次最大轮次',
                    type: 'int',
                    default: 5,
                    value: 5
                },
                temperature: {
                    title: '生成温度',
                    description: '该角色生成温度',
                    type: 'float',
                    default: 0.3,
                    value: 0.3
                }
            }
        };
    }

    _buildRolePluginBindingField(title, defaultValue) {
        return {
            title,
            description: `${title}默认绑定的插件列表，逗号分隔。`,
            type: 'string',
            default: defaultValue,
            value: defaultValue,
        };
    }

    _loadConfig() {
        this._config = this.context?.getConfig?.() || this.context?._config || null;
        try {
            const cfg = this.context.getPluginConfig();
            this._pluginConfig = { enabled: true, delegated_plugins: {}, sub_agent: {}, agent_models: {}, role_plugin_bindings: {}, task_limits: {}, ...cfg };
        } catch {
            this._pluginConfig = { enabled: true, delegated_plugins: {}, sub_agent: {}, agent_models: {}, role_plugin_bindings: {}, task_limits: {} };
        }
    }

    _ensureSubAgent() {
        if (!this._subAgent) {
            this._subAgent = new SubAgent(this._config || {}, this._pluginConfig || {});
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
                '★ 重要: 请尽可能在同一轮同时调用多个不同的搜索工具（如 google_search、bing_search、bilibili_search 等），它们会被并行执行，这样可以大幅加快搜索速度。不要一个一个串行调用。',
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
            const runtimeOpts = this._shouldAttachSkillsInventory(options.role, options.pluginName)
                ? { ...baseRuntime, extraContext: this._skillsInventoryExtraContext() }
                : baseRuntime;

            const result = await this._subAgent.execute(
                options.pluginName,
                options.taskDescription,
                pluginDescription,
                mergedTools,
                task.abortController.signal,
                runtimeOpts
            );
            task.result = this._wrapResult('执行报告', options.taskDescription, result);
            task.structuredResult = this._buildStructuredResult(task, {
                summary: result,
                sections: {
                    report: result,
                },
                artifacts: [],
            });
            task.status = task.abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.COMPLETED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();

            if (task.mode === 'async' && task.status === TASK_STATUS.COMPLETED) {
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
            if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在规划...');
            const planSummary = await this._subAgent.run({
                role: 'planner',
                workerLabel: `planner-${task.id}`,
                isTemporaryWorker: true,
                taskDescription: `请为研究主题“${options.topic}”生成一份简洁执行计划。要求说明研究重点、搜索角度、审查重点和最终输出目标。研究深度: ${options.depth}`,
                toolDefinitions: [],
                signal: task.abortController.signal,
            });

            if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在搜索资料...');
            const searchPluginNames = this._pickPluginsByRole('search');
            const searchContexts = [{ title: '研究计划', content: planSummary }];
            const searchTasks = [];
            for (const pluginName of searchPluginNames) {
                const info = this._delegatedPlugins.get(pluginName);
                const searchTools = this._getResearchToolsForPlugins([pluginName]);
                if (!info || searchTools.length === 0) continue;
                const subtask = { pluginName, role: 'search', status: TASK_STATUS.RUNNING };
                task.subtasks.push(subtask);
                searchTasks.push(
                    this._subAgent.execute(
                        pluginName,
                        `围绕主题“${options.topic}”搜索资料，提取关键事实、来源线索、时间信息与争议点。研究深度: ${options.depth}\n执行计划:\n${planSummary}`,
                        `插件: ${info.metadata.displayName || pluginName}\n说明: ${info.metadata.description || ''}`,
                        searchTools,
                        task.abortController.signal,
                        {
                            role: 'search',
                            workerLabel: `search-${pluginName}-${task.id}`,
                            isTemporaryWorker: true,
                        }
                    ).then(result => {
                        subtask.status = TASK_STATUS.COMPLETED;
                        subtask.result = result;
                        return { pluginName, result };
                    }).catch(error => {
                        subtask.status = task.abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED;
                        subtask.error = error.message;
                        return { pluginName, result: `搜索失败: ${error.message}` };
                    })
                );
            }

            const searchResults = await Promise.all(searchTasks);
            for (const item of searchResults) {
                searchContexts.push({
                    title: `搜索结果 - ${item.pluginName}`,
                    content: item.result,
                });
            }

            if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在审查材料...');
            const reviewSummary = await this._subAgent.run({
                role: 'reviewer',
                workerLabel: `reviewer-${task.id}`,
                isTemporaryWorker: true,
                taskDescription: `审查关于“${options.topic}”的研究材料，指出高置信结论、低置信结论、缺失点和争议点。`,
                toolDefinitions: [],
                signal: task.abortController.signal,
                extraContext: searchContexts,
            });

            if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在撰写报告...');
            const reportSummary = await this._subAgent.run({
                role: 'reporter',
                workerLabel: `reporter-${task.id}`,
                isTemporaryWorker: true,
                taskDescription: `基于已有材料输出一份关于“${options.topic}”的研究报告。要求包含摘要、主要发现、依据、补充说明。研究深度: ${options.depth}`,
                toolDefinitions: [],
                signal: task.abortController.signal,
                extraContext: [
                    ...searchContexts,
                    { title: '审查意见', content: reviewSummary },
                ],
            });

            let finalOutput = reportSummary;
            if (options.output === 'report+persona') {
                if (task.mode === 'async') this._showProgressSubtitle('🌍 研究进度: 正在润色输出...');
                finalOutput = await this._subAgent.run({
                    role: 'persona',
                    workerLabel: `persona-${task.id}`,
                    isTemporaryWorker: true,
                    taskDescription: `请把下面的研究报告转成更有陪伴感、更生动的人设化回答。必须保持事实不变，允许更自然、拟人化，但不能改变结论。`,
                    toolDefinitions: [],
                    signal: task.abortController.signal,
                    extraContext: [
                        { title: '研究报告', content: reportSummary },
                    ],
                });
            } else if (options.output === 'summary') {
                finalOutput = await this._subAgent.run({
                    role: 'synthesizer',
                    workerLabel: `synthesizer-${task.id}`,
                    isTemporaryWorker: true,
                    taskDescription: `请把下面材料整理成简洁摘要，主题是“${options.topic}”。`,
                    toolDefinitions: [],
                    signal: task.abortController.signal,
                    extraContext: [
                        { title: '研究报告', content: reportSummary },
                        { title: '审查意见', content: reviewSummary },
                    ],
                });
            }

            const sections = [
                `【世界之眼·研究报告】`,
                `主题: ${options.topic}`,
                `深度: ${options.depth}`,
                '',
                '【研究计划】',
                planSummary,
                '',
                '【审查摘要】',
                reviewSummary,
                '',
                '【研究报告】',
                reportSummary,
            ];

            if (options.output === 'report+persona') {
                sections.push('', '【最终对用户输出建议】', finalOutput);
            } else if (options.output === 'summary') {
                sections.push('', '【摘要】', finalOutput);
            }

            sections.push('', '——以上为世界之眼内部研究结果。请基于这些内容自然回复用户，不要重复报告标签。');

            task.result = sections.join('\n');
            task.structuredResult = this._buildStructuredResult(task, {
                summary: finalOutput,
                sections: {
                    plan: planSummary,
                    review: reviewSummary,
                    report: reportSummary,
                    final: finalOutput,
                },
                artifacts: [],
            });
            task.status = task.abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.COMPLETED;
            task.finishedAt = Date.now();
            task.updatedAt = Date.now();
            this._archiveResearchTask(task);

            if (task.mode === 'async' && task.status === TASK_STATUS.COMPLETED) {
                this._showProgressSubtitle(`✅ 研究完成: ${options.topic.substring(0, 30)}`);
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
                this._showProgressSubtitle(`❌ 研究任务失败: ${options.topic.substring(0, 30)}`);
                this._enqueueResult(task.id, task.title, `研究任务失败: ${error.message}`);
            }

            return task.status === TASK_STATUS.CANCELLED ? '研究任务已被中止。' : `研究任务失败: ${error.message}`;
        } finally {
            this._leaveRole('planner');
            this._scheduleQueuedTasks();
        }
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

            logToTerminal('info', `${PLUGIN_TAG} 复合步骤 [${step.id}] 开始 (角色: ${step.role})`);

            // 构建任务描述，注入上游输出
            let enrichedTask = step.task;
            if (step.inputBindings) {
                for (const [paramName, sourceKey] of Object.entries(step.inputBindings)) {
                    const upstream = outputs[sourceKey] || '';
                    if (upstream) {
                        enrichedTask += `\n\n[${paramName} — 来自上游步骤的输出]:\n${upstream}`;
                    }
                }
            }

            const promise = this._executeCompositeStep(step, enrichedTask, task.abortController.signal)
                .then(result => {
                    outputs[step.outputKey] = result;
                    stepStatus[step.id] = 'completed';
                    const sub = findSubtask(step.id);
                    if (sub) { sub.status = TASK_STATUS.COMPLETED; sub.result = result; }
                    logToTerminal('info', `${PLUGIN_TAG} 复合步骤 [${step.id}] 完成`);
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

    async _executeCompositeStep(step, enrichedTask, signal) {
        const plugins = step.plugins || [];
        const tools = this._getToolsForPlugins(plugins);

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
            const compositeOpts = this._shouldAttachSkillsInventory(step.role, pluginName)
                ? { ...baseCompositeOpts, extraContext: this._skillsInventoryExtraContext() }
                : baseCompositeOpts;
            return await this._subAgent.execute(
                pluginName,
                enrichedTask,
                pluginDesc,
                tools,
                signal,
                compositeOpts
            );
        } else {
            return await this._subAgent.run({
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
            signal: AbortSignal.timeout(30000),
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
            '## 输出格式',
            '严格输出 JSON 数组，不要加任何额外文字、解释或 markdown 标记。',
            '如果你认为这个目标用单步就能完成，输出空数组 []。',
            '',
            '## 用户目标',
            goal,
        ].join('\n');
    }

    _parsePlannerOutput(rawOutput, goal) {
        if (!rawOutput || typeof rawOutput !== 'string') {
            throw new Error('规划器未返回有效输出');
        }

        // 提取 JSON（可能被 markdown 代码块包裹）
        let jsonStr = rawOutput.trim();
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
                task.result || '',
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
        const raw = this._pluginConfig?.role_plugin_bindings?.[role] || '';
        if (!raw || typeof raw !== 'string') return [];
        return raw.split(',').map(item => item.trim()).filter(Boolean);
    }

    _extractJsonObjectFromLlmText(raw) {
        if (!raw || typeof raw !== 'string') throw new Error('空输出');
        let s = raw.trim();
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
            '## 输出格式',
            '严格输出**一个** JSON 对象，不要 markdown、不要解释。字段如下：',
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
            signal: AbortSignal.timeout(45000),
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
        return [
            `【世界之眼·${title}】`,
            `任务: ${taskDescription}`,
            '',
            result,
            '',
            '——以上为世界之眼执行结果。请根据结果内容自然回复用户，不要复述报告标签。',
        ].join('\n');
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
