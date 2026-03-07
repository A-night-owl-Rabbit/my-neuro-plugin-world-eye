// sub-agent.js - 下级智能体：独立 LLM 调用 + 迷你工具执行循环

const { logToTerminal } = require('../../../js/api-utils.js');

const SUB_AGENT_SYSTEM_PROMPT = `你是一个专业的工具执行智能体。你的职责是根据上级对话模型的要求，精确地调用指定的工具并返回结果。

工作规则：
1. 根据提供的工具定义和使用示例，生成正确的工具调用参数
2. 严格遵循工具的参数类型和必填要求
3. 如果要求中的参数信息不完整，使用合理的默认值
4. 工具执行后，对结果进行简要的结构化整理后返回
5. 不要添加与工具结果无关的额外内容`;

class SubAgent {
    /**
     * @param {object} config - 主应用配置
     * @param {object} pluginConfig - 世界之眼插件配置
     */
    constructor(config, pluginConfig = {}) {
        this._config = config;
        this._pluginConfig = pluginConfig;

        const subAgentCfg = pluginConfig.sub_agent || {};
        if (subAgentCfg.use_separate_model && subAgentCfg.api_url && subAgentCfg.api_key) {
            this._apiKey = subAgentCfg.api_key;
            this._apiUrl = subAgentCfg.api_url;
            this._model = subAgentCfg.model;
        } else {
            this._apiKey = config.llm.api_key;
            this._apiUrl = config.llm.api_url;
            this._model = config.llm.model;
        }

        this._temperature = subAgentCfg.temperature || 0.3;
        this._maxIterations = subAgentCfg.max_iterations || 5;
    }

    /**
     * 执行工具调用任务
     * @param {string} toolName - 要调用的工具名
     * @param {string} taskDescription - 上级对话模型的决策/要求
     * @param {string} toolInfo - 工具完整信息（定义+示例，来自 registry.formatForSubAgent）
     * @param {object} toolDefinition - 原始的 OpenAI function calling 工具定义
     * @returns {Promise<string>} 最终结果文本
     */
    async execute(toolName, taskDescription, toolInfo, toolDefinition) {
        logToTerminal('info', `🌍 [世界之眼] 下级智能体启动，目标工具: ${toolName}`);

        const messages = [
            { role: 'system', content: SUB_AGENT_SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    `## 任务要求`,
                    taskDescription,
                    ``,
                    `## 可用工具信息`,
                    toolInfo,
                    ``,
                    `请根据以上要求调用 ${toolName} 工具。`,
                ].join('\n')
            }
        ];

        const tools = [toolDefinition];

        let iteration = 0;
        while (iteration < this._maxIterations) {
            iteration++;
            logToTerminal('info', `🌍 [世界之眼] 下级智能体第 ${iteration} 轮...`);

            let result;
            try {
                result = await this._callLLM(messages, tools);
            } catch (error) {
                logToTerminal('error', `🌍 [世界之眼] 下级智能体 LLM 调用失败: ${error.message}`);
                return `工具执行失败: ${error.message}`;
            }

            // 没有工具调用 → 返回最终结果
            if (!result.tool_calls || result.tool_calls.length === 0) {
                const finalContent = result.content || '工具执行完成，但未返回内容。';
                logToTerminal('info', `🌍 [世界之眼] 下级智能体完成，共 ${iteration} 轮`);
                return finalContent;
            }

            // 有工具调用 → 执行并继续循环
            messages.push({
                role: 'assistant',
                content: result.content || '',
                tool_calls: result.tool_calls
            });

            for (const toolCall of result.tool_calls) {
                const funcName = toolCall.function.name;
                let parameters;
                try {
                    parameters = typeof toolCall.function.arguments === 'string'
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function.arguments;
                } catch {
                    parameters = {};
                }

                logToTerminal('info', `🌍 [世界之眼] 下级智能体调用工具: ${funcName}(${JSON.stringify(parameters)})`);

                let toolResult = '';
                try {
                    toolResult = await this._executeActualTool(funcName, parameters, toolCall);
                } catch (error) {
                    toolResult = `工具执行错误: ${error.message}`;
                    logToTerminal('error', `🌍 [世界之眼] 工具执行失败: ${error.message}`);
                }

                messages.push({
                    role: 'tool',
                    name: funcName,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                    tool_call_id: toolCall.id
                });
            }
        }

        logToTerminal('warn', `🌍 [世界之眼] 下级智能体达到最大轮次限制 (${this._maxIterations})`);
        // 尝试获取最终总结
        try {
            const summary = await this._callLLM(messages, []);
            return summary.content || '工具调用链过长，已达到最大轮次限制。';
        } catch {
            return '工具调用链过长，已达到最大轮次限制。';
        }
    }

    /**
     * 调用 LLM API
     * @private
     */
    async _callLLM(messages, tools) {
        const requestBody = {
            model: this._model,
            messages,
            temperature: this._temperature,
            stream: false
        };

        if (tools && tools.length > 0) {
            requestBody.tools = tools;
        }

        const response = await fetch(`${this._apiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this._apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

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

        // 处理 reasoning_content 回退
        if ((!message.content || message.content.trim() === '') && message.reasoning_content) {
            message.content = message.reasoning_content;
        }

        // 兼容 Qwen 文本格式工具调用
        if (message.content && !message.tool_calls) {
            const parsed = this._parseTextToolCalls(message.content);
            if (parsed) {
                message.tool_calls = parsed;
                message.content = this._removeToolCallText(message.content);
            }
        }

        return message;
    }

    /**
     * 通过全局 toolExecutor 执行实际工具
     * @private
     */
    async _executeActualTool(funcName, parameters, toolCall) {
        // 构造标准的 toolCall 对象
        const standardToolCall = {
            id: toolCall.id || `call_sub_${Date.now()}`,
            type: 'function',
            function: {
                name: funcName,
                arguments: JSON.stringify(parameters)
            }
        };

        // 尝试通过 MCP
        if (global.mcpManager && global.mcpManager.isEnabled) {
            try {
                const mcpResult = await global.mcpManager.handleToolCalls([standardToolCall]);
                if (mcpResult) return this._extractContent(mcpResult);
            } catch { /* fall through */ }
        }

        // 尝试通过本地工具
        if (global.localToolManager && global.localToolManager.isEnabled) {
            try {
                const localResult = await global.localToolManager.handleToolCalls([standardToolCall]);
                if (localResult) return this._extractContent(localResult);
            } catch { /* fall through */ }
        }

        // 尝试通过插件工具
        if (global.pluginManager) {
            try {
                const pluginResult = await global.pluginManager.executeTool(funcName, parameters);
                if (pluginResult !== undefined) return this._extractContent(pluginResult);
            } catch { /* fall through */ }
        }

        throw new Error(`未找到工具: ${funcName}`);
    }

    _extractContent(result) {
        if (typeof result === 'string') return result;
        if (result && result._hasScreenshot) {
            return result.results?.map(r => r.content).join('\n') || '截图已完成';
        }
        if (Array.isArray(result)) {
            return result.map(r => r.content || JSON.stringify(r)).join('\n');
        }
        if (result && result.content) return result.content;
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
            } catch { /* skip */ }
        }

        return toolCalls.length > 0 ? toolCalls : null;
    }

    _removeToolCallText(content) {
        return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }

    /**
     * 批量生成工具缩略词
     * @param {Array<{name: string, description: string}>} tools
     * @returns {Promise<Object<string, string>>} { toolName: abbreviation }
     */
    async generateAbbreviations(tools) {
        if (!tools || tools.length === 0) return {};

        const toolLines = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

        const messages = [
            {
                role: 'system',
                content: '你是工具缩略词生成专家。为每个工具生成一个精炼的中文缩略词（2-10个字），要求：\n1. 用最少的字概括工具的核心功能\n2. 使用"动词+对象"结构，如"搜索B站视频"、"生成图片"、"查询天气"\n3. 如果工具有多种用途，用/分隔，如"点赞/投币/收藏"\n4. 返回格式必须是 JSON 对象：{"工具名": "缩略词"}'
            },
            {
                role: 'user',
                content: `为以下 ${tools.length} 个工具生成缩略词：\n\n${toolLines}\n\n直接返回 JSON 对象，不要其他内容。`
            }
        ];

        try {
            const result = await this._callLLM(messages, []);
            const text = (result.content || '').trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        } catch (error) {
            logToTerminal('error', `🌍 [世界之眼] 缩略词生成失败: ${error.message}`);
        }
        return {};
    }
}

module.exports = { SubAgent };
