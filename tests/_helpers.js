// 测试辅助：构造带 fake 代理插件与 fake SubAgent 的 WorldEyePlugin 实例
const WorldEyePlugin = require('../index.js');

function tool(name) {
    return {
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties: {} } }
    };
}

/**
 * @param {object} opts
 * @param {object} opts.plugins  形如 { 'plugin-id': { displayName?, description?, tools: ['tool_a'] } }
 * @param {object} opts.roles    形如 { search: { plugins: 'plugin-id' } }
 * @param {Array}  opts.reporterOutputs  reporter 角色历次 run 的返回值序列（用于模拟【需要补搜】）
 * @param {Array}  opts.executeOutcomes  executeWithStatus 历次返回的结构体序列（用于模拟受阻/失败），耗尽后默认 completed
 */
function makeWorldEye({ plugins = {}, roles = {}, reporterOutputs = [], executeOutcomes = [] } = {}) {
    const registry = {};
    for (const [name, def] of Object.entries(plugins)) {
        registry[name] = {
            metadata: { name, displayName: def.displayName || name, description: def.description || '' },
            getTools() { return (def.tools || []).map(tool); }
        };
    }
    global.pluginManager = {
        getPlugin(name) { return registry[name] || null; }
    };

    const sentMessages = [];
    const context = {
        getConfig() { return {}; },
        getPluginConfig() { return {}; },
        addSystemPromptPatch() {},
        removeSystemPromptPatch() {},
        showSubtitle() {},
        async sendMessage(text, options) {
            sentMessages.push({ text, options });
            return { ok: true };
        }
    };

    const plugin = new WorldEyePlugin({}, context);
    plugin._pluginConfig = {
        enabled: true,
        delegated_plugins: Object.fromEntries(Object.keys(plugins).map(n => [n, true])),
        models: {},
        roles,
        limits: {},
        security: {},
        personality: { enabled: true },
        negotiation: { enabled: false, max_rounds: 0 }
    };
    for (const [name, p] of Object.entries(registry)) {
        plugin._allPluginsMeta.set(name, p.metadata);
    }
    plugin._forceRefreshDelegatedPlugins();
    plugin._archiveResearchTask = () => {};

    const calls = [];
    let reporterIdx = 0;
    let executeIdx = 0;
    plugin._subAgent = {
        updatePluginConfig() {},
        async execute(pluginName, taskDescription, pluginDescription, tools, signal, opts = {}) {
            calls.push({ kind: 'execute', role: opts.role, pluginName, taskDescription });
            return `执行结果(${opts.role})`;
        },
        async executeWithStatus(pluginName, taskDescription, pluginDescription, tools, signal, opts = {}) {
            calls.push({ kind: 'executeWithStatus', role: opts.role, pluginName, taskDescription });
            if (executeIdx < executeOutcomes.length) {
                return executeOutcomes[executeIdx++];
            }
            return { status: 'completed', content: `执行结果(${opts.role})` };
        },
        async run(opts = {}) {
            calls.push({ kind: 'run', role: opts.role, taskDescription: opts.taskDescription });
            if (opts.role === 'reporter') {
                const out = reporterOutputs[reporterIdx] !== undefined ? reporterOutputs[reporterIdx] : '正式报告内容';
                reporterIdx++;
                return out;
            }
            return `${opts.role} 输出`;
        },
        async runWithStatus(opts = {}) {
            calls.push({ kind: 'runWithStatus', role: opts.role, taskDescription: opts.taskDescription });
            return { status: 'completed', content: `${opts.role} 输出` };
        },
    };

    return { plugin, calls, sentMessages };
}

const AGENT_KINDS = ['execute', 'executeWithStatus', 'run', 'runWithStatus'];

/** 过滤出真正的子代理运行记录（每条 = 一次完整的子代理执行） */
function agentRuns(calls) {
    return calls.filter(c => AGENT_KINDS.includes(c.kind));
}

module.exports = { makeWorldEye, agentRuns, tool };
