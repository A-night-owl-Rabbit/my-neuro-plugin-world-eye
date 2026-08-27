const assert = require('node:assert/strict');
const test = require('node:test');
const { makeWorldEye, agentRuns } = require('./_helpers.js');

test('quick 研究 = 合并搜索 1 + 摘要报告 1（共 2 次子代理运行）', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google', 'search_bing'] } },
        roles: { search: { plugins: 'mock-search' } },
    });
    const result = await plugin._handleResearch({ topic: '测试主题', depth: 'quick', mode: 'sync' });
    assert.match(result, /最终研究结果/);
    const runs = agentRuns(calls);
    assert.equal(runs.length, 2, `期望 2 次子代理运行，实际 ${runs.length}: ${runs.map(r => r.role).join(',')}`);
    assert.deepEqual(runs.map(r => r.role), ['search', 'reporter']);
});

test('standard 研究无补搜 = 搜索 1 + 审查写报合并 1（共 2 次）', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
        roles: { search: { plugins: 'mock-search' } },
    });
    await plugin._handleResearch({ topic: '测试主题', mode: 'sync' });
    assert.deepEqual(agentRuns(calls).map(r => r.role), ['search', 'reporter']);
});

test('standard 研究触发补搜封顶 4 次：搜索→报告→补搜→终稿', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
        roles: { search: { plugins: 'mock-search' } },
        reporterOutputs: [
            '【需要补搜】\n- 原因: 核心问题未回答\n- 补搜目标: 官方来源',
            '终稿报告内容',
        ],
    });
    const result = await plugin._handleResearch({ topic: '测试主题', depth: 'standard', mode: 'sync' });
    assert.deepEqual(agentRuns(calls).map(r => r.role), ['search', 'reporter', 'search', 'reporter']);
    assert.match(result, /终稿报告内容/);
});

test('deep 研究 = 规划 + 合并搜索 + 独立审查 + 报告（无补搜共 4 次）', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
        roles: { search: { plugins: 'mock-search' } },
    });
    await plugin._handleResearch({ topic: '测试主题', depth: 'deep', mode: 'sync' });
    assert.deepEqual(agentRuns(calls).map(r => r.role), ['planner', 'search', 'reviewer', 'reporter']);
});

test('output 默认 report：不运行 persona 改写', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
        roles: { search: { plugins: 'mock-search' } },
    });
    await plugin._handleResearch({ topic: '测试主题', mode: 'sync' });
    assert.ok(!agentRuns(calls).some(r => r.role === 'persona'), 'persona 不应在默认输出档位运行');
});

test('显式 report+persona 时多一步口语化改写', async () => {
    const { plugin, calls } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
        roles: { search: { plugins: 'mock-search' } },
    });
    await plugin._handleResearch({ topic: '测试主题', output: 'report+persona', mode: 'sync' });
    assert.deepEqual(agentRuns(calls).map(r => r.role), ['search', 'reporter', 'persona']);
});
