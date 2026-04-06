// sub-agent.js - 下级智能体：独立 LLM + 插件工具执行循环

const { logToTerminal } = require('./lib/log.js');

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

const SHARED_EXECUTION_RULES = [
    '你属于世界之眼的内部执行体系，只负责完成当前任务，不负责与用户闲聊。',
    '优先完成任务目标，不解释你自己的身份、流程或系统实现。',
    '如果有工具可用，先用工具获取事实或执行动作，再组织结果。',
    '严格遵循工具参数要求；参数缺失时，先根据上下文补全最合理的值。',
    '不要伪造工具结果、文件路径、图片结果、播放状态、执行结果或来源。',
    '结果中保留对任务有帮助的信息，删掉空话、寒暄和自我表扬。',
    '遇到阻塞时，要明确说明阻塞点、已尝试步骤、还缺什么。',
    '除 persona 角色外，不主动使用强人设语气，不卖萌，不表演。',
];

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
            '不负责卖萌或抒情。',
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
            '对冲突信息做说明。',
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
            '用户描述不完整时可以合理补全，但不能偏离主题。',
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
        ]
    },
    app: {
        title: 'AppAgent',
        duty: '负责本机应用启动和桌面侧执行任务。',
        rules: [
            '只执行明确要求的动作。',
            '明确反馈成功、失败或阻塞原因。',
            '不自行扩展任务范围。',
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
            '执行 execute_shell_command 时，cwd 参数必须使用任务描述中给出的绝对路径，严禁自己猜测或拼接路径。如果路径不存在会导致命令在错误目录执行。',
            '执行前确认前置条件（如登录状态）。',
            '不执行与当前任务无关的技能操作。',
            '上游步骤传来的数据（如文本、图片路径）直接使用，不需要重新生成。',
            '不要在路径中添加 plugins/ 前缀。技能目录不在 plugins 下面。',
        ]
    },
};

class SubAgent {
    constructor(config, pluginConfig = {}) {
        this._config = config || {};
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
        });
    }

    async run(options = {}) {
        const role = options.role || 'general';
        const llmConfig = this._resolveLLMConfig(role, options.modelOverride || null);
        const systemPrompt = options.systemPrompt || this._buildSystemPrompt({
            role,
            workerLabel: options.workerLabel || '',
            isTemporaryWorker: options.isTemporaryWorker !== false,
        });
        const toolDefinitions = Array.isArray(options.toolDefinitions) ? options.toolDefinitions : [];
        const maxIterations = Math.max(1, options.maxIterations ?? llmConfig.maxIterations ?? 5);
        const temperature = options.temperature ?? llmConfig.temperature ?? 0.3;

        logToTerminal('info', `🌍 [世界之眼] 启动 ${role}，模型: ${llmConfig.model || '(未配置)'}，工具数: ${toolDefinitions.length}`);

        const messages = [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: this._buildUserPrompt({
                    taskDescription: options.taskDescription || '',
                    pluginDescription: options.pluginDescription || '',
                    extraContext: options.extraContext || [],
                })
            }
        ];

        let iteration = 0;
        while (iteration < maxIterations) {
            if (options.signal?.aborted) {
                logToTerminal('info', '🌍 [世界之眼] 子智能体被中止');
                return '任务已被中止。';
            }

            iteration++;
            logToTerminal('info', `🌍 [世界之眼] ${role} 第 ${iteration} 轮...`);

            let result;
            try {
                result = await this._callLLM(messages, toolDefinitions, options.signal, llmConfig, temperature);
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                logToTerminal('error', `🌍 [世界之眼] ${role} LLM 调用失败: ${error.message}`);
                return `任务执行失败: ${error.message}`;
            }

            if (!result.tool_calls || result.tool_calls.length === 0 || toolDefinitions.length === 0) {
                const finalContent = result.content || '任务执行完成，但未返回内容。';
                logToTerminal('info', `🌍 [世界之眼] ${role} 完成，共 ${iteration} 轮`);
                return finalContent;
            }

            messages.push({
                role: 'assistant',
                content: result.content || '',
                tool_calls: result.tool_calls
            });

            // 同一轮内的多个 tool_calls 并行执行（如搜索角色同时调用 google、bing、bilibili 等）
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

                logToTerminal('info', `🌍 [世界之眼] ${role} 调用工具: ${funcName}(${JSON.stringify(parameters)})`);

                let toolResult = '';
                try {
                    toolResult = await this._executeActualTool(funcName, parameters, toolCall);
                } catch (error) {
                    toolResult = `工具执行错误: ${error.message}`;
                    logToTerminal('error', `🌍 [世界之眼] 工具执行失败: ${error.message}`);
                }

                return { toolCall, funcName, result: toolResult };
            });

            const toolResults = await Promise.all(toolCallPromises);

            // 检查是否被中止
            if (toolResults.some(r => r.aborted)) {
                logToTerminal('info', `🌍 [世界之眼] ${role} 在工具执行阶段被中止`);
                return '任务已被中止。';
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

        logToTerminal('warn', `🌍 [世界之眼] ${role} 达到最大轮次限制 (${maxIterations})`);
        try {
            const summary = await this._callLLM(messages, [], options.signal, llmConfig, temperature);
            return summary.content || '工具调用链过长，已达到最大轮次限制。';
        } catch {
            return '工具调用链过长，已达到最大轮次限制。';
        }
    }

    _buildSystemPrompt({ role, workerLabel, isTemporaryWorker }) {
        const block = ROLE_PROMPT_BLOCKS[role] || ROLE_PROMPT_BLOCKS.general;
        const lines = [];
        lines.push(`你是世界之眼内部的 ${block.title}。`);
        lines.push(`职责: ${block.duty}`);
        if (isTemporaryWorker) {
            lines.push('你是临时 worker，只服务当前任务，不能为自己创建新角色，不能修改系统配置，任务结束即退出。');
        }
        if (workerLabel) {
            lines.push(`当前 worker 标识: ${workerLabel}`);
        }
        lines.push('');
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
        return lines.join('\n');
    }

    _buildUserPrompt({ taskDescription, pluginDescription, extraContext }) {
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
                sections.push(`## ${block.title || '补充上下文'}`);
                sections.push(block.content);
            }
        }

        sections.push('');
        sections.push('请根据以上要求完成任务。');
        return sections.join('\n');
    }

    _resolveLLMConfig(role, override = null) {
        const globalLlm = this._config?.llm || {};
        const defaultCfg = this._pluginConfig?.sub_agent || {};
        let roleCfg = this._pluginConfig?.agent_models?.[role] || {};
        // router 未单独配密钥时，复用 planner 的独立模型（与动态规划同一套 DeepSeek 等配置）
        if (role === 'router') {
            const r = this._pluginConfig?.agent_models?.router || {};
            const p = this._pluginConfig?.agent_models?.planner || {};
            const routerOk = r.use_separate_model && r.api_url && r.api_key;
            const plannerOk = p.use_separate_model && p.api_url && p.api_key;
            if (!routerOk && plannerOk) {
                roleCfg = {
                    ...p,
                    temperature: r.temperature ?? p.temperature ?? 0.2,
                    max_iterations: r.max_iterations ?? p.max_iterations ?? 3,
                    use_separate_model: true,
                };
            }
        }

        let selected = null;
        if (override?.api_url && override?.api_key) {
            selected = override;
        } else if (roleCfg.use_separate_model && roleCfg.api_url && roleCfg.api_key) {
            selected = roleCfg;
        } else if (defaultCfg.use_separate_model && defaultCfg.api_url && defaultCfg.api_key) {
            selected = defaultCfg;
        } else {
            selected = globalLlm;
        }

        const apiUrl = (selected.api_url || '').replace(/\/+$/, '');
        const apiKey = selected.api_key || '';
        const model = selected.model || '';
        const temperature = roleCfg.temperature ?? defaultCfg.temperature ?? 0.3;
        const maxIterations = roleCfg.max_iterations ?? defaultCfg.max_iterations ?? 5;

        if (!apiUrl || !apiKey || !model) {
            logToTerminal('warn', `🌍 [世界之眼] ${role} 未配置完整模型信息，将尝试按现有字段继续执行`);
        }

        return {
            apiUrl,
            apiKey,
            model,
            temperature,
            maxIterations,
        };
    }

    async _callLLM(messages, tools, signal, llmConfig, temperature) {
        if (!llmConfig.apiUrl || !llmConfig.apiKey) {
            throw new Error('下级智能体未正确配置 API 地址或密钥，请检查世界之眼配置');
        }

        const requestBody = {
            model: llmConfig.model,
            messages,
            temperature,
            stream: false,
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        }

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${llmConfig.apiKey}`
            },
            body: JSON.stringify(requestBody)
        };

        if (signal) fetchOptions.signal = signal;

        if (!_httpFetch) {
            throw new Error('当前环境无全局 fetch，请在 world-eye 插件目录执行 npm install 安装 node-fetch');
        }
        const response = await _httpFetch(`${llmConfig.apiUrl}/chat/completions`, fetchOptions);

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            throw new Error(`API 请求失败 (${response.status}): ${errorText.substring(0, 200)}`);
        }

        const data = await response.json();
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
                // 如果 pluginManager 找到了工具但执行失败，不要静默吞掉，返回错误信息
                const errMsg = pluginError?.message || String(pluginError);
                if (!errMsg.includes('找不到提供工具的插件')) {
                    return `工具 ${funcName} 执行出错: ${errMsg}`;
                }
                // "找不到提供工具的插件" 说明 pluginManager 没有该工具，继续尝试 MCP
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

module.exports = { SubAgent };
