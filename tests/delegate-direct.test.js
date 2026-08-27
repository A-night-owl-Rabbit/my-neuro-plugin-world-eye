const assert = require('node:assert/strict');
const test = require('node:test');
const { makeWorldEye } = require('./_helpers.js');

test('点名有效插件直通执行，不调用目标路由', async () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    let goalCalls = 0;
    let routerCalls = 0;
    plugin._handleGoal = async () => { goalCalls++; return 'goal path'; };
    plugin._invokeGoalRouterLLM = async () => { routerCalls++; return {}; };
    let execArgs = null;
    plugin._executeDelegatedPluginRun = async (params, taskDescription, mode) => {
        execArgs = { params, taskDescription, mode };
        return 'direct ok';
    };

    const result = await plugin._handleDelegate({
        plugin_name: 'mock-search',
        task_description: '查个资料',
        mode: 'sync',
    });
    assert.equal(result, 'direct ok');
    assert.equal(goalCalls, 0, '直通路径不应调用 _handleGoal');
    assert.equal(routerCalls, 0, '直通路径不应调用路由模型');
    assert.equal(execArgs.params.plugin_name, 'mock-search');
    assert.equal(execArgs.taskDescription, '查个资料');
});

test('点名无效插件回退目标路由并携带建议', async () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    let goalArgs = null;
    plugin._handleGoal = async (p) => { goalArgs = p; return 'goal path'; };
    const result = await plugin._handleDelegate({
        plugin_name: 'not-exist',
        task_description: '干点啥',
        mode: 'sync',
    });
    assert.equal(result, 'goal path');
    assert.equal(goalArgs.suggested_plugin, 'not-exist');
});

test('省略插件名走目标路由', async () => {
    const { plugin } = makeWorldEye({
        plugins: { 'mock-search': { tools: ['search_google'] } },
    });
    let goalCalls = 0;
    plugin._handleGoal = async () => { goalCalls++; return 'goal path'; };
    await plugin._handleDelegate({ task_description: '干点啥', mode: 'sync' });
    assert.equal(goalCalls, 1);
});

test('URL 任务点名 app 启动器时安全纠偏仍生效', async () => {
    const { plugin } = makeWorldEye({
        plugins: { 'windows-app-launcher': { tools: ['launch_app'] } },
        roles: { app: { plugins: 'windows-app-launcher' } },
    });
    const result = await plugin._handleDelegate({
        plugin_name: 'windows-app-launcher',
        task_description: '打开网页 https://example.com 并登录网站',
        mode: 'sync',
    });
    assert.match(result, /浏览器自动化技能插件|未纳入世界之眼代理/, 'URL 任务不应硬跑 app 启动器');
});
