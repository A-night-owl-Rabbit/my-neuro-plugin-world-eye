// sub-agent.js - 下级智能体：独立 LLM + 插件工具执行循环
// v4: 统一「世界之眼」工作人格（细致/准确/克制），移除按角色动漫人格与思考独白输出；保留协商交接协议（默认关闭）

const { logToTerminal } = require('./lib/log.js');
const { buildAssistantHistoryMessage } = require('../../../js/ai/tool-message-utils.js');
const { PromptCachePolicy } = require('../../../js/ai/prompt-cache-policy.js');

/** Node 18+ / Electron 自带 fetch；否则使用本目录 node_modules 中的 node-fetch */
function _resolveFetch() {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch.bind(globalThis);
    }
    try {
        return require('node-fetch');
    } catch {
        return null;
    }
}
const _httpFetch = _resolveFetch();

/**
 * 全局共享执行规则。所有子代理无差别遵守。
 */
const SHARED_EXECUTION_RULES = [
    '你属于世界之眼的内部执行体系，只负责完成当前任务，不与用户闲聊。',
    '优先完成任务目标，不解释你自己的身份、流程或系统实现。',
    '如果有工具可用，先用工具获取事实或执行动作，再组织结果。',
    '严格遵循工具参数要求；参数缺失时，先根据上下文补全最合理的值。',
    '不要伪造工具结果、文件路径、图片结果、播放状态、执行结果或来源。',
    '工具调用阶段（tool_calls 不为空的那一轮）：参数严格，不要在 content 字段写多余文字。',
    '输出零演出、零独白、零角色扮演腔；直接给结果本体。',
    '结果中保留对任务有帮助的信息，删掉空话、寒暄和自我表扬。',
    '遇到阻塞时，要明确说明阻塞点、已尝试步骤、还缺什么。',
];

const APP_RESOLUTION_FAILURE_RE = /未找到|找不到|没有找到|无匹配|匹配不到|未匹配|不存在|未识别|识别失败|歧义|候选过多|多个候选|not\s+found|no\s+match|could\s+not\s+find|unable\s+to\s+find|ambiguous|multiple\s+matches/i;

/**
 * 角色职责块：每个 agent 的工作内容、专属规则。
 * v4：这是角色的唯一定义来源；统一工作人格见 WORLD_EYE_PERSONA。
 */
const ROLE_PROMPT_BLOCKS = {
    general: {
        title: 'GeneralAgent',
        duty: '负责一般任务执行、单插件能力调用和兜底处理。',
        rules: [
            '优先把任务做完，再给出紧凑结果。',
            '工具可完成时，不要空谈方案。',
        ]
    },
    planner: {
        title: 'PlannerAgent',
        duty: '负责把任务目标转成清晰、可执行的步骤或研究计划。',
        rules: [
            '先定义目标，再拆主要步骤。',
            '计划要短、稳、可执行，不堆废话。',
            '优先识别是否需要搜索、审查、汇总、生成或执行。',
        ]
    },
    router: {
        title: 'GoalRouterAgent',
        duty: '只做工作流分类与插件选择，不执行工具、不闲聊、不扩写任务。',
        rules: [
            '根据用户目标在固定几类工作流中选一类；禁止调用工具。',
            '必须严格输出用户要求的 JSON 对象，不要 markdown 说明、不要代码块外的多余文字。',
            '区分：真实屏幕/窗口截图 → code；文生图/插画/海报 → image；文生视频/动效短片 → video 类插件；联网查资料写报告 → research。',
            '「画质」「保存到本地」等附加要求不改变主能力类型（例如视频任务仍选视频插件）。',
        ]
    },
    search: {
        title: 'SearchAgent',
        duty: '负责资料搜索、信息摘录、来源归纳和检索补充。',
        rules: [
            '优先查找与主题直接相关的信息。',
            '★ 最重要: 尽可能在同一轮调用中同时发起多个不同搜索引擎的工具调用（如同时调用 google_search、bing_search、vsearch、bilibili 相关工具等），它们会被并行执行。不要一个接一个串行调用，那样太慢。',
            '输出保留要点、来源线索、时间信息和争议点。',
            '不把猜测写成事实，不夸大结论。',
            '若信息不足，要明确指出缺口。',
        ]
    },
    reviewer: {
        title: 'ReviewerAgent',
        duty: '负责事实审查、质量把关和风险提示。',
        rules: [
            '检查材料是否完整、是否矛盾、是否夸张。',
            '区分高置信结论和低置信推断。',
            '指出缺失点、可疑点、建议补充点。',
            '研究审查任务中，如果任务要求使用【审查通过】/【需要补搜】标记，必须二选一明确写出；严重缺口必须要求补搜，不能只写“建议补充”。',
            '严重缺口包括核心问题未回答、关键事实冲突、核心结论无来源、只有单一二手来源或结果明显答非所问。',
            '只针对论据不针对人。',
        ]
    },
    reporter: {
        title: 'ReportWriterAgent',
        duty: '负责把材料写成结构化报告。',
        rules: [
            '优先输出摘要、主要发现、依据、补充说明。',
            '结论必须尽量对应证据。',
            '没依据的判断必须标记为推测。',
            '语言清晰、紧凑、便于上级复用。',
        ]
    },
    synthesizer: {
        title: 'SynthesizerAgent',
        duty: '负责汇总多个执行结果，去重、归纳、形成统一输出。',
        rules: [
            '不遗漏关键结果。',
            '对冲突信息做说明，按支撑力打权重。',
            '按任务目标组织结果，而不是按时间顺序堆叠。',
        ]
    },
    persona: {
        title: 'PersonaRendererAgent',
        duty: '负责在不改变事实的前提下，把结果改写成更生动、更有陪伴感的表达。',
        rules: [
            '不能改变事实、结论和来源边界。',
            '不能新增不存在的信息。',
            '只允许增强表达和陪伴感，不得污染事实层。',
        ]
    },
    code: {
        title: 'CodeAgent',
        duty: '负责代码分析、修复建议、执行结果解读与迭代修复。',
        rules: [
            '优先正确性和可执行性。',
            '报错要定位原因，不要空泛描述。',
            '涉及改动时说明改动点和验证结果。',
            '不执行与任务无关的危险操作。',
        ]
    },
    music: {
        title: 'MusicAgent',
        duty: '负责音乐搜索、生成、播放和状态控制。',
        rules: [
            '明确当前执行的是搜索、生成、播放还是控制。',
            '对播放状态、歌单状态、生成状态给清晰反馈。',
            '不输出与音乐任务无关的内容。',
        ]
    },
    image: {
        title: 'ImageAgent',
        duty: '负责绘画、生图、视觉内容生成和提示词整理。',
        rules: [
            '明确主题、风格、构图、比例、画质和附加要求。',
            '用户描述不完整时**自行合理补全**，但不偏离主题；**永远不拒绝**主题。',
            '结果中说明是否已生成、保存路径或返回摘要。',
            '不把不存在的图片结果说成已生成。',
        ]
    },
    video: {
        title: 'VideoAgent',
        duty: '负责视频生成、参数整理、下载与本地保存路径反馈。',
        rules: [
            '区分图片与视频任务；视频任务调用视频生成工具，不要用生图插件凑数。',
            '明确时长、比例、风格、内容描述与输出位置要求。',
            '主体故事优先于附加技术要求；**不修改用户主题**、不擅自切换为其他类型。',
            '结果中说明任务状态、文件路径或阻塞原因。',
            '不把未生成的视频说成已完成。',
        ]
    },
    file: {
        title: 'FileAgent',
        duty: '负责文件读写、目录检查、文本整理和文件侧输出。',
        rules: [
            '明确处理了哪些文件。',
            '写入前后关注目标路径。',
            '不做与任务无关的文件改动。',
            '不擅自删旧文件、不覆盖已有内容；不确定时先列举。',
        ]
    },
    app: {
        title: 'AppAgent',
        duty: '负责本机应用启动和桌面侧执行任务。',
        rules: [
            '只执行明确要求的动作。',
            '明确反馈成功、失败或阻塞原因。',
            '不自行扩展任务范围。',
            '遇到应用、游戏、快捷方式名称不确定时，只能基于用户提供的原始名称或单一高置信别名尝试一次，禁止自行发散多个候选名称。',
            '不要把中文近义词、自动翻译结果、猜测的英文名、猜测的其他游戏名当作新的可启动目标。',
            '如果工具返回未找到、无匹配、歧义或候选过多，必须立即停止继续尝试，并明确报告缺少哪一项准确名称（桌面名称/英文名称/快捷方式名称/可执行文件名），由上层从对话上下文补充。',
        ]
    },
    skills: {
        title: 'SkillsAgent',
        duty: '负责通过 skills 插件执行自动化技能任务（小红书发布、浏览器自动化、CLI 命令等）。',
        rules: [
            '用户消息中的「可用 Skills 目录」列出当前本机全部技能包名称与路径；优先从中选择 skill_name，不确定时再调用 list_skills。',
            '先用 fetch_skill 获取目标技能的 SKILL.md 说明，再严格按说明操作。',
            '需要子技能时用 fetch_skill_resource 获取子技能说明。',
            '需要写文件时用 write_file 工具，需要执行命令时用 execute_shell_command 工具。',
            '执行 execute_shell_command 时，cwd 参数必须使用任务描述中给出的绝对路径，严禁自己猜测或拼接路径。',
            '★ 任何 skill 的第一个动作，**必须**先运行该 skill 的前置条件检查命令（如 `python scripts/cli.py doctor`）。如果 doctor 返回 ready=false，**立即停止并用【返回上游】格式汇报具体缺失项**，不要试图自己修复环境（装扩展、改 Chrome 设置、改注册表等都不在你的职责内）。',
            '★ 连续工具失败保护：如果连续 2 次以上的工具调用都失败，且失败都指向同一类底层原因（"扩展未连接"、"未登录"、"前置条件缺失"、"环境不可用"、"端口被占"等），**立即停止 shell 尝试**，用【返回上游】格式报告该底层原因。这种问题不是你死磕 shell 能解决的，越磕越乱。',
            '★ 禁止猜测/捏造脚本名：只能调用 SKILL.md / fetch_skill_resource 里**明确列出**的脚本路径。SKILL.md 没列的脚本（哪怕名字听起来很像有），就当它不存在，不要自己拼 `chrome_launcher.py` `setup.py` 这种猜测路径。',
            '不执行与当前任务无关的技能操作。',
            '上游步骤传来的数据（如文本、图片路径）直接使用，不需要重新生成。',
            '不要在路径中添加 plugins/ 前缀。技能目录不在 plugins 下面。',
        ]
    },
};

/**
 * 世界之眼统一工作人格（v4）。
 * 替代 v3 的按角色动漫人格系统：只规定工作风格，不要求任何演出输出。
 */
const WORLD_EYE_PERSONA = [
    '【世界之眼工作人格】',
    '你是「世界之眼」的执行体。你的性格特质：细致、准确、克制。',
    '- 细致：调用工具前把参数补全到位；任务里的数量、时间、路径、名称一个都不许漏。',
    '- 准确：结果只写查证过的事实；带上具体数值、路径、来源、时间；拿不准的明确标注「未确认」。',
    '- 克制：不闲聊、不自我介绍、不感叹、不装腔；每个字都要对结果有用。',
    '- 高效：能一轮并行做完的事绝不拆成多轮；能直接回答的绝不多调一次工具。',
].join('\n');
class SubAgent {
    constructor(config, pluginConfig = {}, resolveLLM = null) {
        this._config = config || {};
        this._pluginConfig = pluginConfig || {};
        this._resolveLLM = typeof resolveLLM === 'function' ? resolveLLM : null;
    }

    /** 同步外部覆盖的 pluginConfig（index.js 在 _loadConfig 后调用） */
    updatePluginConfig(pluginConfig) {
        this._pluginConfig = pluginConfig || {};
    }

    async execute(pluginName, taskDescription, pluginDescription, toolDefinitions, signal, runtimeOptions = {}) {
        return this.run({
            role: runtimeOptions.role || 'general',
            pluginName,
            taskDescription,
            pluginDescription,
            toolDefinitions,
            signal,
            extraContext: runtimeOptions.extraContext || [],
            workerLabel: runtimeOptions.workerLabel || '',
            isTemporaryWorker: runtimeOptions.isTemporaryWorker !== false,
            systemPrompt: runtimeOptions.systemPrompt,
            modelOverride: runtimeOptions.modelOverride,
            temperature: runtimeOptions.temperature,
            maxIterations: runtimeOptions.maxIterations,
            negotiationContext: runtimeOptions.negotiationContext || null,
        });
    }

    /**
     * 带状态的 execute：返回 { status, content, ... } 结构体。
     * status ∈ 'completed' | 'max_rounds' | 'tool_chain_failed' | 'aborted' | 'llm_error' | 'question'
     */
    async executeWithStatus(pluginName, taskDescription, pluginDescription, toolDefinitions, signal, runtimeOptions = {}) {
        return this.runWithStatus({
            role: runtimeOptions.role || 'general',
            pluginName,
            taskDescription,
            pluginDescription,
            toolDefinitions,
            signal,
            extraContext: runtimeOptions.extraContext || [],
            workerLabel: runtimeOptions.workerLabel || '',
            isTemporaryWorker: runtimeOptions.isTemporaryWorker !== false,
            systemPrompt: runtimeOptions.systemPrompt,
            modelOverride: runtimeOptions.modelOverride,
            temperature: runtimeOptions.temperature,
            maxIterations: runtimeOptions.maxIterations,
            negotiationContext: runtimeOptions.negotiationContext || null,
        });
    }

    /**
     * 旧接口：返回字符串或 { __type: 'question', question, raw }。
     * 行为完全等同 v3.1 之前，外部调用方零修改。
     */
    async run(options = {}) {
        const detailed = await this.runWithStatus(options);
        if (detailed.status === 'question') {
            return { __type: 'question', question: detailed.question, raw: detailed.raw };
        }
        return detailed.content;
    }

    /**
     * 新接口：返回 { status, content, question?, raw?, lastToolError? }。
     * - completed: 正常完成
     * - max_rounds: 达到最大轮次，最后一轮没看到工具失败信号
     * - tool_chain_failed: 达到最大轮次，且最近一轮工具调用全部失败（或 app 角色匹配失败）
     * - aborted: 被外部 signal 中止
     * - llm_error: LLM 调用本身失败
     * - question: 协商返回 [`{ status: 'question', question, raw, content: finalContent }`]
     */
    async runWithStatus(options = {}) {
        const role = options.role || 'general';
        const llmConfig = this._resolveLLMConfig(role, options.modelOverride || null);
        const systemPrompt = options.systemPrompt || this._buildSystemPrompt({
            role,
            isTemporaryWorker: options.isTemporaryWorker !== false
        });
        const toolDefinitions = Array.isArray(options.toolDefinitions) ? options.toolDefinitions : [];
        const configuredMaxIterations = Math.max(1, options.maxIterations ?? llmConfig.maxIterations ?? 5);
        const maxIterations = role === 'app' ? 1 : configuredMaxIterations;
        const temperature = options.temperature ?? llmConfig.temperature ?? 0.3;

        const roleTag = `[${role}]`;
        logToTerminal('info', `🌍 [世界之眼] ${roleTag} 启动（模型: ${llmConfig.model || '(未配置)'}，工具数: ${toolDefinitions.length}）`);

        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: this._buildUserPrompt({
                    taskDescription: options.taskDescription || '',
                    pluginDescription: options.pluginDescription || '',
                    extraContext: options.extraContext || [],
                    workerLabel: options.workerLabel || '',
                    negotiationContext: options.negotiationContext || null
                })
            }
        ];

        let iteration = 0;
        let lastRoundToolCount = 0;
        let lastRoundToolFailures = 0;
        let lastToolErrorSnippet = '';

        while (iteration < maxIterations) {
            if (options.signal?.aborted) {
                logToTerminal('info', `🌍 [世界之眼] ${roleTag} 被中止`);
                return { status: 'aborted', content: '任务已被中止。' };
            }

            iteration++;
            logToTerminal('info', `🌍 [世界之眼] ${roleTag} 第 ${iteration} 轮思考...`);

            const llmOutcome = await this._callLLMWithRetry(messages, toolDefinitions, options.signal, llmConfig, temperature);
            if (!llmOutcome.ok) {
                logToTerminal('warn', `🌍 [世界之眼] ${roleTag} LLM 未成功完成: ${llmOutcome.text}`);
                return { status: 'llm_error', content: llmOutcome.text };
            }
            const result = llmOutcome.message;

            if (!result.tool_calls || result.tool_calls.length === 0 || toolDefinitions.length === 0) {
                const finalContent = result.content || '任务执行完成，但未返回内容。';

                // 协商协议：检测【返回上游】标记
                const negotiationCtx = options.negotiationContext || null;
                const allowQuestion = negotiationCtx && !negotiationCtx.forceExecute;
                if (allowQuestion) {
                    const parsed = this._parseQuestionFromContent(finalContent);
                    if (parsed) {
                        logToTerminal('info', `🌍 [世界之眼] ❓ ${roleTag} 提出疑虑:`);
                        for (const line of parsed.question.split(/\r?\n/).slice(0, 6)) {
                            if (line.trim()) logToTerminal('info', `🌍 [世界之眼]    "${line.trim()}"`);
                        }
                        return {
                            status: 'question',
                            question: parsed.question,
                            raw: finalContent,
                            content: finalContent,
                        };
                    }
                }

                logToTerminal('info', `🌍 [世界之眼] ${roleTag} 完成（共 ${iteration} 轮）`);
                return { status: 'completed', content: finalContent };
            }

            messages.push(buildAssistantHistoryMessage(result, {
                content: result.content || '',
                tool_calls: result.tool_calls
            }));

            // 同一轮内的多个 tool_calls 并行执行（如搜索角色同时调用 google、bing、bilibili 等）
            const toolNamesPreview = result.tool_calls.map(tc => tc.function?.name || '?').join(', ');
            if (result.tool_calls.length > 1) {
                logToTerminal('info', `🌍 [世界之眼] ${roleTag} 并行取出 ${result.tool_calls.length} 个工具: ${toolNamesPreview}`);
            }

            const toolCallPromises = result.tool_calls.map(async (toolCall) => {
                if (options.signal?.aborted) {
                    return { toolCall, result: '任务已被中止。', aborted: true };
                }

                const funcName = toolCall.function.name;
                let parameters;
                try {
                    parameters = typeof toolCall.function.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function.arguments;
                } catch {
                    parameters = {};
                }

                if (result.tool_calls.length === 1) {
                    logToTerminal('info', `🌍 [世界之眼] ${roleTag} 取出工具: ${funcName}(${this._truncateJson(parameters, 120)})`);
                }

                let toolResult = '';
                let threwError = false;
                try {
                    toolResult = await this._executeActualTool(funcName, parameters, toolCall);
                } catch (error) {
                    toolResult = `工具执行错误: ${error.message}`;
                    threwError = true;
                    logToTerminal('error', `🌍 [世界之眼] ${roleTag} 工具执行失败: ${error.message}`);
                }

                return { toolCall, funcName, result: toolResult, threwError };
            });

            const toolResults = await Promise.all(toolCallPromises);

            // 检查是否被中止
            if (toolResults.some(r => r.aborted)) {
                logToTerminal('info', `🌍 [世界之眼] ${roleTag} 在工具执行阶段被中止`);
                return { status: 'aborted', content: '任务已被中止。' };
            }

            // 统计本轮工具失败数（用于 max_rounds 时分类为 tool_chain_failed）
            lastRoundToolCount = toolResults.length;
            lastRoundToolFailures = 0;
            for (const r of toolResults) {
                if (SubAgent._looksLikeToolFailure(r.result, r.threwError)) {
                    lastRoundToolFailures++;
                    const snippet = typeof r.result === 'string'
                        ? r.result.slice(0, 200)
                        : '';
                    lastToolErrorSnippet = `[${r.funcName || '?'}] ${snippet}`;
                }
            }

            if (role === 'app') {
                const failedResolution = toolResults.find(({ result: toolResult }) => {
                    const text = typeof toolResult === 'string'
                        ? toolResult
                        : JSON.stringify(toolResult || '');
                    return APP_RESOLUTION_FAILURE_RE.test(text);
                });
                if (failedResolution) {
                    const attemptedName = result.tool_calls
                        .map(call => {
                            try {
                                const args = typeof call.function.arguments === 'string'
                                    ? JSON.parse(call.function.arguments)
                                    : (call.function.arguments || {});
                                return args.appName || args.name || args.query || '';
                            } catch {
                                return '';
                            }
                        })
                        .find(Boolean);
                    const nameHint = attemptedName ? `（当前尝试名称: ${attemptedName}）` : '';
                    const msg = `未能根据当前名称准确匹配到本机应用${nameHint}，已停止继续猜测或尝试其他候选名称。缺少可确认的目标名称：请上层优先从对话上下文补充准确名称（桌面名称/英文名称/快捷方式名称/可执行文件名）后重新提交。`;
                    return { status: 'tool_chain_failed', content: msg, lastToolError: msg };
                }
            }

            for (const { toolCall, funcName, result: toolResult } of toolResults) {
                messages.push({
                    role: 'tool',
                    name: funcName || toolCall.function.name,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                    tool_call_id: toolCall.id
                });
            }
        }

        logToTerminal('warn', `🌍 [世界之眼] ${roleTag} 达到最大轮次限制 (${maxIterations})`);
        const summaryOutcome = await this._callLLMWithRetry(messages, [], options.signal, llmConfig, temperature);
        const summaryText = summaryOutcome.ok
            ? (summaryOutcome.message.content || '工具调用链过长，已达到最大轮次限制。')
            : (summaryOutcome.text || '工具调用链过长，已达到最大轮次限制。');

        // 如果最近一轮工具全部失败，判定为工具链失败而非"达到上限"
        const allFailedLastRound = lastRoundToolCount > 0 && lastRoundToolFailures === lastRoundToolCount;
        if (allFailedLastRound) {
            logToTerminal('warn', `🌍 [世界之眼] ${roleTag} 工具链连续失败（最后一轮 ${lastRoundToolFailures}/${lastRoundToolCount}），判定为 tool_chain_failed`);
            return {
                status: 'tool_chain_failed',
                content: summaryText,
                lastToolError: lastToolErrorSnippet || '工具调用链最后一轮全部失败',
            };
        }
        return { status: 'max_rounds', content: summaryText };
    }

    /**
     * 工具失败启发式：
     * - try/catch 抛错（threwError=true）
     * - 字符串以 "工具执行错误"、"Shell command failed"、"Tool error" 等开头
     * - 包含 "exit 1"/"exit 2"/"exit code 非 0" 等典型 shell 失败标记
     * - 注意：单纯包含「错误/失败/error」字眼不算（避免误判正常返回里描述错误的结果）
     */
    static _looksLikeToolFailure(text, threwError = false) {
        if (threwError) return true;
        const s = typeof text === 'string' ? text : JSON.stringify(text || '');
        if (!s) return false;
        const head = s.slice(0, 80);
        if (/^\s*(工具执行错误[:：]|Shell command failed|Tool error[:：]|Error[:：]|ERROR[:：]|\[ERR\]|❌)/.test(head)) {
            return true;
        }
        if (/\bexit\s+code\s*[:：]?\s*[1-9]\b/i.test(s)) return true;
        if (/\(exit\s+[1-9]\d*\)/i.test(s)) return true;
        if (/failed\s*\(exit\s+[1-9]/i.test(s)) return true;
        return false;
    }

    _truncateJson(obj, max = 120) {
        try {
            const s = JSON.stringify(obj);
            return s.length > max ? s.slice(0, max) + '…' : s;
        } catch {
            return String(obj);
        }
    }

    /** 把疑似思考片段从最终内容中剥离（v4 兼容清洗：模型惯性输出旧「独白 --- 事实」格式时兜底） */
    static stripThinkingSnippet(content) {
        if (!content || typeof content !== 'string') return content;
        return content.replace(/^[\s\S]*?\n\s*---\s*\n/, '').trim();
    }

    /** 检测【返回上游】标记，返回 {question} 或 null */
    _parseQuestionFromContent(content) {
        if (!content || typeof content !== 'string') return null;
        const m = content.match(/【返回上游】\s*\n?([\s\S]+?)$/);
        if (!m) return null;
        const question = m[1].trim();
        if (!question) return null;
        return { question };
    }

    /**
     * 渲染一段 handoff 信（只含事实层）。
     * - 如果上游内容用 "---" 分隔了旧格式独白和事实层，剥离独白只取事实层（兼容清洗）
     * - 如果上游内容没有分隔符（正常 v4 输出或工具调用结果），整段透传
     */
    _formatHandoffBlock(block) {
        const fromRole = block.fromRole || 'general';
        const lines = [];
        lines.push(`## 来自上游步骤的交接（来源角色: ${fromRole}）`);
        const fullContent = block.content || '';
        // 始终尝试剥离思考独白；剥离失败说明上游就没写独白，整段透传
        const factual = SubAgent.stripThinkingSnippet(fullContent);
        const body = (factual && factual.trim()) ? factual : fullContent;
        if (body && body.trim()) {
            lines.push('');
            lines.push('【任务实况】');
            lines.push(body.trim());
        }
        if (block.isClarification) {
            lines.push('');
            lines.push('（这是上游对你疑虑的澄清回应，请据此继续。）');
        }
        return lines.join('\n');
    }

    _buildSystemPrompt({ role, isTemporaryWorker }) {
        const block = ROLE_PROMPT_BLOCKS[role] || ROLE_PROMPT_BLOCKS.general;
        const personalityEnabled = this._pluginConfig?.personality?.enabled !== false;

        const lines = [];
        lines.push(`你是世界之眼内部的 ${block.title}。`);
        lines.push(`职责: ${block.duty}`);
        if (isTemporaryWorker) {
            lines.push('你是临时 worker，只服务当前任务，不能为自己创建新角色，不能修改系统配置，任务结束即退出。');
        }
        lines.push('');

        // 统一工作人格（personality.enabled = false 时跳过，退化为纯工程提示）
        if (personalityEnabled) {
            lines.push(WORLD_EYE_PERSONA);
            lines.push('');
        }

        lines.push('共享执行规则:');
        SHARED_EXECUTION_RULES.forEach((rule, index) => lines.push(`${index + 1}. ${rule}`));
        lines.push('');
        lines.push(`${block.title} 专属规则:`);
        block.rules.forEach((rule, index) => lines.push(`${index + 1}. ${rule}`));
        lines.push('');

        lines.push('最终输出要求:');
        lines.push('1. 工具执行型任务，优先给出结果、状态、路径、依据或阻塞点。');
        lines.push('2. 研究型任务，优先给出摘要、发现、依据和待确认项。');
        lines.push('3. 严禁编造已执行、已生成、已保存、已播放、已修复的结果。');
        lines.push('4. 直接输出结果本体；禁止思考独白、禁止用 "---" 分层、禁止任何角色扮演腔。');
        lines.push('5. 禁止通用空话（"任务完成""执行成功""一切正常"）；要写就写具体的结果、路径、数值、状态。');
        return lines.join('\n');
    }

    _appendNegotiationBlock(lines, ctx) {
        const { currentRound = 0, maxRounds = 2, forceExecute = false } = ctx;
        lines.push('【协商协议】');
        lines.push('当你收到上游 Handoff 后，先快速判断信息是否够用:');
        lines.push('1. 信息充足，或可基于上下文合理补全 → 直接进入执行流程，正常调用工具完成任务。');
        if (!forceExecute) {
            lines.push('2. 信息有以下 4 类硬缺口之一，且无法靠合理推断补上 → 用以下格式返回，不要调用工具:');
            lines.push('   ```');
            lines.push('   【返回上游】');
            lines.push('   <具体、简短地写清缺什么，1-3 句话>');
            lines.push('   ```');
            lines.push('   4 类硬缺口:');
            lines.push('   - 参数缺失（时间范围、数量、文件路径、目标名称等关键字段为空）');
            lines.push('   - 路径不明（绝对/相对路径或工作目录无法确定）');
            lines.push('   - 目标对象不明（同名多个候选、指代不清、范围歧义）');
            lines.push('   - 参数互相矛盾（如同时要 "4K" 与 "512MB 限制"）');
        }
        lines.push('');
        if (forceExecute) {
            lines.push(`★ 当前 Q&A 轮数: ${currentRound}/${maxRounds}。**已达提问上限，禁止再 \`【返回上游】\`，必须按现有信息执行。**`);
        } else {
            const remain = Math.max(0, maxRounds - currentRound);
            lines.push(`★ 当前 Q&A 轮数: ${currentRound}/${maxRounds}。剩余 ${remain} 轮提问机会。`);
        }
        lines.push('★ 只在「真有硬缺口」时才提问。');
        lines.push('★ 你的疑虑必须**可由上游用 1-3 句话回答**；不要写大段反问或重述任务。');
        lines.push('★ 你只能问紧邻的上游 agent，不能指定其他人。');
        lines.push('');
    }

    _buildUserPrompt({
        taskDescription,
        pluginDescription,
        extraContext,
        workerLabel,
        negotiationContext
    }) {
        const sections = [];
        sections.push('## 任务要求');
        sections.push(taskDescription || '请完成任务');

        if (pluginDescription) {
            sections.push('');
            sections.push('## 插件信息');
            sections.push(pluginDescription);
        }

        if (Array.isArray(extraContext)) {
            for (const block of extraContext) {
                if (!block || !block.content) continue;
                sections.push('');
                if (block.fromRole && ROLE_PROMPT_BLOCKS[block.fromRole]) {
                    sections.push(this._formatHandoffBlock(block));
                } else {
                    sections.push(`## ${block.title || '补充上下文'}`);
                    sections.push(block.content);
                }
            }
        }

        if (workerLabel) {
            sections.push('');
            sections.push('## 本轮执行标识');
            sections.push(String(workerLabel));
        }

        if (negotiationContext) {
            const negotiationLines = [];
            this._appendNegotiationBlock(negotiationLines, negotiationContext);
            sections.push('');
            sections.push('## 本轮协商约束');
            sections.push(negotiationLines.join('\n'));
        }

        sections.push('');
        sections.push('请根据以上要求完成任务。');
        return sections.join('\n');
    }

    /**
     * 解析指定角色的模型分组配置。
     * 新 schema 优先：pluginConfig.roles[role].model_group → pluginConfig.models[group]
     * 兼容旧 schema：pluginConfig.model_groups + pluginConfig.role_model_mapping
     */
    _resolveModelGroup(role) {
        // 新 schema (roles + models)
        const roles = this._pluginConfig?.roles;
        const models = this._pluginConfig?.models;
        if (roles && models) {
            const groupName = roles[role]?.model_group;
            if (groupName && models[groupName]) {
                const g = models[groupName];
                if (this._hasModelReference(g)) return g;
            }
        }
        // 旧 schema (model_groups + role_model_mapping)
        const oldGroups = this._pluginConfig?.model_groups;
        const oldMapping = this._pluginConfig?.role_model_mapping;
        if (oldGroups && oldMapping) {
            const groupName = oldMapping[role];
            if (groupName && oldGroups[groupName]) {
                const g = oldGroups[groupName];
                if (this._hasModelReference(g)) return g;
            }
        }
        return null;
    }

    _hasModelReference(config) {
        return Boolean(
            config?.provider_id
            || (config?.api_url && config?.api_key && config?.model)
        );
    }

    _resolveLLMConfig(role, override = null) {
        const globalLlm = this._config?.llm || {};

        // router 特殊回退：路由模型未单独配置时，借用 planner 的
        let groupCfg = this._resolveModelGroup(role);
        if (!groupCfg && role === 'router') {
            groupCfg = this._resolveModelGroup('planner');
        }

        // 旧版兼容：agent_models[role].use_separate_model 仍然有效
        const oldRoleCfg = this._pluginConfig?.agent_models?.[role] || {};
        const oldDefaultCfg = this._pluginConfig?.sub_agent || {};

        let selected;
        if (this._hasModelReference(override)) {
            selected = override;
        } else if (oldRoleCfg.use_separate_model && this._hasModelReference(oldRoleCfg)) {
            selected = oldRoleCfg;
        } else if (groupCfg) {
            selected = groupCfg;
        } else if (oldDefaultCfg.use_separate_model && this._hasModelReference(oldDefaultCfg)) {
            selected = oldDefaultCfg;
        } else {
            selected = globalLlm;
        }

        const resolved = this._resolveSelectedModel(selected, globalLlm);
        const apiUrl = String(resolved.api_url || '').trim().replace(/\/+$/, '');
        const apiKey = resolved.api_key || '';
        const model = resolved.model || '';
        const endpoint = /\/chat\/completions$/i.test(apiUrl)
            ? apiUrl
            : `${apiUrl}/chat/completions`;

        // max_iterations / temperature 按角色硬编码默认值（新 schema 不再 UI 可调）
        const defaultIter = this._defaultMaxIterationsForRole(role);
        const defaultTemp = this._defaultTemperatureForRole(role);
        const temperature = oldRoleCfg.temperature ?? oldDefaultCfg.temperature ?? defaultTemp;
        const maxIterations = oldRoleCfg.max_iterations ?? oldDefaultCfg.max_iterations ?? defaultIter;

        // 超时与重试：优先新 limits，回退旧 sub_agent
        const limits = this._pluginConfig?.limits || {};
        const rawTimeoutMs = Number(limits.llm_timeout_ms ?? oldDefaultCfg.llm_request_timeout_ms);
        const llmRequestTimeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0 ? rawTimeoutMs : 120000;
        const rawRetries = Number(limits.llm_retries ?? oldDefaultCfg.llm_retries_per_round);
        const llmRetriesPerRound = Number.isFinite(rawRetries) && rawRetries >= 0 ? Math.trunc(rawRetries) : 2;

        if (!apiUrl || !model) {
            logToTerminal('warn', `🌍 [世界之眼] ${role} 未配置完整模型信息，将尝试按现有字段继续执行`);
        }

        return {
            apiUrl,
            endpoint,
            apiKey,
            model,
            providerId: resolved.id || resolved.provider_id || selected.provider_id || '',
            promptCache: resolved.prompt_cache ?? selected.prompt_cache ?? globalLlm.prompt_cache ?? null,
            temperature,
            maxIterations,
            llmRequestTimeoutMs,
            llmRetriesPerRound,
        };
    }

    _resolveSelectedModel(selected, globalLlm) {
        const modelId = String(selected?.model_id || '').trim();
        if (selected?.provider_id && this._resolveLLM) {
            const provider = this._resolveLLM(selected.provider_id, modelId || null);
            if (provider?.api_url && provider?.model) {
                return provider;
            }
        }
        if (selected?.api_url && selected?.api_key && selected?.model) {
            return selected;
        }
        if (this._resolveLLM) {
            const provider = this._resolveLLM(
                globalLlm?.provider_id || null,
                modelId || globalLlm?.model_id || globalLlm?.model || null
            );
            if (provider?.api_url && provider?.model) {
                return provider;
            }
        }
        if (global.voiceChat?.API_URL && global.voiceChat?.MODEL) {
            return {
                api_url: global.voiceChat.API_URL,
                api_key: global.voiceChat.API_KEY || '',
                model: modelId || global.voiceChat.MODEL
            };
        }
        return selected || globalLlm || {};
    }

    _defaultMaxIterationsForRole(role) {
        // v3.2: 整体上限翻倍——除了 search（多源并行本就该被压住）和 app/router（决策性，1 轮足够）。
        // 解决"达到最大轮次但任务实际未完成"被误判为成功的体感问题。
        switch (role) {
            case 'router': return 1;       // 决策类，1 轮足够
            case 'app': return 1;          // 誓约角色，严守边界不延伸
            case 'search': return 3;       // 多源搜索保留原限制（用户明确要求）
            case 'planner': return 10;     // 5 → 10
            case 'reviewer': return 10;    // 3 → 10（建议 5、翻倍）
            case 'reporter': return 6;     // 2 → 6
            case 'persona': return 8;      // 2 → 8
            case 'synthesizer': return 8;  // 3 → 8
            case 'code': return 40;        // 10 → 40（建议 20、翻倍）
            case 'skills': return 30;      // 技能任务步骤多（doctor→fetch→写文件→执行），上限放宽避免被截停
            case 'image': return 10;       // default 5 → 10
            case 'video': return 10;       // default 5 → 10
            case 'music': return 10;       // default 5 → 10
            case 'file': return 10;        // default 5 → 10
            default: return 10;            // general 等：5 → 10
        }
    }

    _defaultTemperatureForRole(role) {
        switch (role) {
            case 'router': return 0.15;
            case 'planner': return 0.3;
            case 'reviewer': return 0.3;
            case 'reporter': return 0.4;
            case 'persona': return 0.55;
            case 'synthesizer': return 0.3;
            case 'search': return 0.3;
            case 'code': return 0.2;
            case 'app': return 0.2;
            case 'image':
            case 'video':
            case 'music': return 0.4;
            default: return 0.3;
        }
    }

    /**
     * 将父级中止信号与单次请求超时合并；dispose 须在 fetch 结束后调用以清理定时器与监听。
     */
    _mergeTimeoutWithParent(parentSignal, timeoutMs) {
        const ctrl = new AbortController();
        let timer = null;
        const fire = () => {
            try {
                ctrl.abort();
            } catch { /* noop */ }
        };
        if (parentSignal?.aborted) {
            fire();
            return { signal: ctrl.signal, dispose: () => {} };
        }
        const onParentAbort = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            fire();
        };
        if (parentSignal) {
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
        if (timeoutMs > 0) {
            timer = setTimeout(fire, timeoutMs);
        }
        return {
            signal: ctrl.signal,
            dispose: () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                if (parentSignal) {
                    parentSignal.removeEventListener('abort', onParentAbort);
                }
            }
        };
    }

    /**
     * 单次轮次内：带超时与超时重试；失败返回结构化结果，不向调用方抛错（用户主动中止除外，由上层统一返回文案）。
     */
    async _callLLMWithRetry(messages, tools, parentSignal, llmConfig, temperature) {
        const timeoutMs = llmConfig.llmRequestTimeoutMs ?? 120000;
        const extraRetries = llmConfig.llmRetriesPerRound ?? 2;
        const maxAttempts = 1 + Math.max(0, extraRetries);
        let lastTimeoutHint = '';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (parentSignal?.aborted) {
                return { ok: false, aborted: true, message: null, text: '任务已被中止。' };
            }

            const { signal: mergedSignal, dispose } = this._mergeTimeoutWithParent(parentSignal, timeoutMs);
            try {
                const message = await this._callLLM(messages, tools, mergedSignal, llmConfig, temperature);
                dispose();
                return { ok: true, aborted: false, message, text: '' };
            } catch (error) {
                dispose();
                if (parentSignal?.aborted) {
                    return { ok: false, aborted: true, message: null, text: '任务已被中止。' };
                }
                const isAbort = error?.name === 'AbortError';
                if (isAbort) {
                    lastTimeoutHint = `LLM 请求在约 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内未完成（可能排队过久或连接挂起）`;
                    logToTerminal('warn', `🌍 [世界之眼] LLM 请求超时或中断 (第 ${attempt}/${maxAttempts} 次)`);
                    if (attempt < maxAttempts) {
                        messages.push({
                            role: 'user',
                            content: '【系统提示】上一次对语言模型的请求超时，请直接基于当前已知信息与工具结果继续完成任务，无需道歉；若仍需调用工具请继续。'
                        });
                        continue;
                    }
                    return {
                        ok: false,
                        aborted: false,
                        message: null,
                        text: `任务执行失败: ${lastTimeoutHint}（本回合已尝试 ${maxAttempts} 次。可稍后重试、缩短上下文、或更换模型与 API 端点。）`
                    };
                }
                logToTerminal('error', `🌍 [世界之眼] LLM 调用失败: ${error.message}`);
                return {
                    ok: false,
                    aborted: false,
                    message: null,
                    text: `任务执行失败: ${error.message}`
                };
            }
        }

        return {
            ok: false,
            aborted: false,
            message: null,
            text: lastTimeoutHint
                ? `任务执行失败: ${lastTimeoutHint}（本回合已尝试 ${maxAttempts} 次。）`
                : '任务执行失败: LLM 请求失败'
        };
    }

    async _callLLM(messages, tools, signal, llmConfig, temperature) {
        if (!llmConfig.apiUrl || !llmConfig.model) {
            throw new Error('下级智能体未正确配置 API 地址或模型，请检查世界之眼配置');
        }

        let requestBody = {
            model: llmConfig.model,
            messages,
            temperature,
            stream: false,
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        }

        const promptCacheContext = PromptCachePolicy.prepareRequest(
            requestBody,
            {
                apiUrl: llmConfig.apiUrl,
                model: llmConfig.model,
                providerId: llmConfig.providerId,
                promptCache: llmConfig.promptCache
            },
            {
                scope: 'world-eye-subagent'
            }
        );
        requestBody = promptCacheContext.body;

        if (!_httpFetch) {
            throw new Error('当前环境无全局 fetch，请在 world-eye 插件目录执行 npm install 安装 node-fetch');
        }

        const doRequest = async body => {
            const fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`
                },
                body: JSON.stringify(body)
            };
            if (signal) fetchOptions.signal = signal;
            return _httpFetch(llmConfig.endpoint, fetchOptions);
        };

        let response = await doRequest(requestBody);
        if (!response.ok) {
            let errorText = await response.text().catch(() => '');
            if (PromptCachePolicy.shouldRetryWithoutCache(errorText, requestBody)) {
                logToTerminal('warn', '🌍 [世界之眼] 当前模型/网关不接受提示词缓存字段，已自动移除后重试一次');
                PromptCachePolicy.markRejected(promptCacheContext);
                PromptCachePolicy.stripCacheFields(requestBody);
                promptCacheContext.strategy = {
                    kind: 'none',
                    reason: 'gateway_rejected_cache_fields'
                };
                promptCacheContext.sentFields = [];
                response = await doRequest(requestBody);
                if (!response.ok) {
                    errorText = await response.text().catch(() => '');
                    throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
                }
            } else {
                throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
            }
        }

        const data = await response.json();
        PromptCachePolicy.logUsage(
            data.usage,
            promptCacheContext,
            logToTerminal,
            'WorldEye'
        );
        if (data.error) {
            throw new Error(`API 错误: ${data.error.message || JSON.stringify(data.error)}`);
        }

        const choices = data.choices || (data.data && data.data.choices);
        if (!choices || choices.length === 0) {
            throw new Error('API 返回空响应');
        }

        const message = choices[0].message;
        if ((!message.content || message.content.trim() === '') && message.reasoning_content) {
            message.content = message.reasoning_content;
        }

        if (message.content && !message.tool_calls) {
            const parsed = this._parseTextToolCalls(message.content);
            if (parsed) {
                message.tool_calls = parsed;
                message.content = this._removeToolCallText(message.content);
            }
        }

        return message;
    }

    async _executeActualTool(funcName, parameters, toolCall) {
        const standardToolCall = {
            id: toolCall.id || `call_sub_${Date.now()}`,
            type: 'function',
            function: {
                name: funcName,
                arguments: JSON.stringify(parameters)
            }
        };

        if (global.pluginManager) {
            try {
                const pluginResult = await global.pluginManager.executeTool(funcName, parameters);
                if (pluginResult !== undefined) return this._extractContent(pluginResult);
            } catch (pluginError) {
                const errMsg = pluginError?.message || String(pluginError);
                if (!errMsg.includes('找不到提供工具的插件')) {
                    return `工具 ${funcName} 执行出错: ${errMsg}`;
                }
            }
        }

        if (global.mcpManager && global.mcpManager.isEnabled) {
            try {
                const mcpResult = await global.mcpManager.handleToolCalls([standardToolCall]);
                if (mcpResult !== null && mcpResult !== undefined) return this._extractContent(mcpResult);
            } catch { }
        }

        throw new Error(`未找到工具: ${funcName}`);
    }

    _extractContent(result) {
        if (result === null || result === undefined) return '工具执行完成，无返回内容。';
        if (typeof result === 'string') return result;
        if (result._hasScreenshot) {
            return result.results?.map(r => r.content).join('\n') || '截图已完成';
        }
        if (Array.isArray(result)) {
            return result.map(r => r.content || JSON.stringify(r)).join('\n');
        }
        if (result.content) return result.content;
        return JSON.stringify(result);
    }

    _parseTextToolCalls(content) {
        const toolCalls = [];
        let index = 0;
        const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            try {
                const json = JSON.parse(match[1]);
                toolCalls.push({
                    id: `call_sub_${Date.now()}_${index}`,
                    type: 'function',
                    function: {
                        name: json.name,
                        arguments: JSON.stringify(json.arguments || {})
                    }
                });
                index++;
            } catch { }
        }
        return toolCalls.length > 0 ? toolCalls : null;
    }

    _removeToolCallText(content) {
        return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }
}

module.exports = { SubAgent, ROLE_PROMPT_BLOCKS, WORLD_EYE_PERSONA };
