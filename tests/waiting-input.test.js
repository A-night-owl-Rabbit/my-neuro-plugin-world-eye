const assert = require('node:assert/strict');
const test = require('node:test');
const { makeWorldEye } = require('./_helpers.js');

const APP_BLOCK_OUTCOME = {
    status: 'tool_chain_failed',
    content: '未能根据当前名称准确匹配到本机应用（当前尝试名称: 那个游戏），已停止继续猜测。缺少可确认的目标名称。',
    lastToolError: '未能根据当前名称准确匹配到本机应用',
};

function makeAppScenario(extra = {}) {
    return makeWorldEye({
        plugins: { 'windows-app-launcher': { tools: ['launch_app'] } },
        roles: { app: { plugins: 'windows-app-launcher' } },
        ...extra,
    });
}

async function runBlockedTask(plugin) {
    const info = plugin._delegatedPlugins.get('windows-app-launcher');
    const task = plugin._createTask({
        type: 'delegate',
        title: 'windows-app-launcher: 打开那个游戏',
        role: 'app',
        pluginName: 'windows-app-launcher',
        taskDescription: '打开那个游戏',
        mode: 'async',
    });
    const notice = await plugin._runDelegateTask(task.id, info, {
        role: 'app',
        taskDescription: '打开那个游戏',
        pluginName: 'windows-app-launcher',
    });
    return { task, notice };
}

test('信息缺口类失败转 waiting_input 并投递求助通知', async () => {
    const { plugin, sentMessages } = makeAppScenario({ executeOutcomes: [APP_BLOCK_OUTCOME] });
    const { task, notice } = await runBlockedTask(plugin);

    assert.equal(task.status, 'waiting_input');
    assert.match(task.meta.blockReason, /未能根据当前名称准确匹配/);
    assert.match(notice, /任务受阻·需要补充信息/);
    assert.match(notice, /world_eye_control/);
    assert.match(notice, /不要征求用户同意/);

    // 投递是异步的，等一个调度周期
    await new Promise(r => setTimeout(r, 30));
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /世界之眼任务受阻通知/);
    assert.equal(sentMessages[0].options.bypassExternalPolicy, true);

    plugin._clearWaitingTimer(task.id);
});

test('answer 动作带补充信息续跑任务直至完成', async () => {
    const { plugin, sentMessages } = makeAppScenario({ executeOutcomes: [APP_BLOCK_OUTCOME] });
    const { task } = await runBlockedTask(plugin);
    assert.equal(task.status, 'waiting_input');

    // 先让受阻通知完成投递（真实场景中主模型是收到通知后才会 answer）
    await new Promise(r => setTimeout(r, 30));

    const resumeMsg = plugin._handleControl({
        action: 'answer',
        task_id: task.id,
        answer: '准确名称是 Genshin Impact，桌面快捷方式叫「原神」',
    });
    assert.match(resumeMsg, /已续跑/);

    // 续跑是后台 promise，第二次 executeWithStatus 默认返回 completed
    await new Promise(r => setTimeout(r, 50));
    assert.equal(task.status, 'completed');
    assert.equal(task.meta.attempt, 2);
    assert.match(task.taskDescription, /主对话补充信息/);
    assert.match(task.taskDescription, /Genshin Impact/);

    // 受阻通知 1 条 + 完成结果 1 条
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[1].text, /世界之眼异步任务结果/);
});

test('对非 waiting_input 任务或缺参数的 answer 返回错误', async () => {
    const { plugin } = makeAppScenario();
    const info = plugin._delegatedPlugins.get('windows-app-launcher');
    const task = plugin._createTask({
        type: 'delegate',
        title: 't',
        role: 'app',
        pluginName: 'windows-app-launcher',
        taskDescription: '打开记事本',
        mode: 'async',
    });
    await plugin._runDelegateTask(task.id, info, {
        role: 'app',
        taskDescription: '打开记事本',
        pluginName: 'windows-app-launcher',
    });
    assert.equal(task.status, 'completed');

    const err1 = plugin._handleControl({ action: 'answer', task_id: task.id, answer: 'x' });
    assert.match(err1, /不在等待补充信息状态/);

    const err2 = plugin._handleControl({ action: 'answer', task_id: task.id });
    assert.match(err2, /需要提供 answer 参数/);
});

test('waiting_input 超时自动转 failed', async () => {
    const { plugin } = makeAppScenario({ executeOutcomes: [APP_BLOCK_OUTCOME] });
    plugin._waitingInputTTL = 30;
    const { task } = await runBlockedTask(plugin);
    assert.equal(task.status, 'waiting_input');

    await new Promise(r => setTimeout(r, 90));
    assert.equal(task.status, 'failed');
    assert.match(task.error, /超时/);
});

test('普通失败（非信息缺口）不转 waiting_input', async () => {
    const { plugin } = makeAppScenario({
        executeOutcomes: [{
            status: 'tool_chain_failed',
            content: '磁盘写入被系统拒绝，返回 EPERM。',
            lastToolError: 'EPERM: operation denied',
        }],
    });
    const { task } = await runBlockedTask(plugin);
    assert.equal(task.status, 'failed');
});
