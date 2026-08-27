const assert = require('node:assert/strict');
const test = require('node:test');
const { makeWorldEye } = require('./_helpers.js');

function getTool(plugin, name) {
    return plugin.getTools().find(t => t.function.name === name);
}

test('goal/delegate 描述声明清单是极简缩写', () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    const goal = getTool(plugin, 'world_eye_goal');
    const delegate = getTool(plugin, 'world_eye_delegate');
    assert.match(goal.function.description, /极简缩写/);
    assert.match(goal.function.description, /world_eye_inspect/);
    assert.match(delegate.function.description, /极简缩写/);
});

test('inspect 描述含缩写硬规则', () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    const inspect = getTool(plugin, 'world_eye_inspect');
    assert.match(inspect.function.description, /极简缩写/);
    assert.match(inspect.function.description, /以 inspect 结果为准/);
});

test('control 描述与参数支持 answer 动作', () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    const control = getTool(plugin, 'world_eye_control');
    assert.match(control.function.description, /answer/);
    assert.ok(control.function.parameters.properties.action.enum.includes('answer'));
    assert.ok(control.function.parameters.properties.answer, 'control 需有 answer 参数定义');
});

test('元工具描述零动漫人格残留', () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    const residue = /鲁路修|リヴァイ|柯南|雪乃|遠子|結衣|折木|卡卡西|セイバー|英梨々|路由官|润色 結衣/;
    for (const t of plugin.getTools()) {
        assert.doesNotMatch(t.function.description || '', residue, `${t.function.name} 描述含动漫残留`);
    }
});
