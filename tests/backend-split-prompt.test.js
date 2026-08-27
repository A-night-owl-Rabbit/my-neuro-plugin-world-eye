const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFeiniuBackendSplitPrompt } = require('../lib/backend-split-prompt.js');

test('清单内能力走世界之眼，并嵌入折叠行', () => {
    const prompt = buildFeiniuBackendSplitPrompt([
        '- multi-search: 多引擎并行搜索'
    ]);
    assert.match(prompt, /- multi-search: 多引擎并行搜索/);
    assert.match(prompt, /能被上面某一行的能力覆盖 → 只用 world_eye_goal/);
});

test('清单头部声明每行是极简缩写', () => {
    const prompt = buildFeiniuBackendSplitPrompt([
        '- multi-search: 多引擎并行搜索'
    ]);
    assert.match(prompt, /每行是极简缩写/);
    assert.match(prompt, /world_eye_inspect/);
});

test('清单外电脑任务走 Codex', () => {
    const prompt = buildFeiniuBackendSplitPrompt([
        '- multi-search: 多引擎并行搜索'
    ]);
    assert.match(prompt, /不能被任何一行覆盖 → 用 codex_delegate/);
});

test('系统默认浏览器打开 URL 一律 Codex', () => {
    const prompt = buildFeiniuBackendSplitPrompt([
        '- browser-harness: 受控 Chrome 内点击/抓取/截图/填表，不是给主人弹日常浏览器'
    ]);
    assert.match(prompt, /系统默认浏览器打开 URL/);
    assert.match(prompt, /一律 codex_delegate/);
});

test('空清单时电脑任务一律走 Codex，且不含假插件行', () => {
    const prompt = buildFeiniuBackendSplitPrompt([]);
    assert.match(prompt, /一律走 Codex/);
    assert.doesNotMatch(prompt, /- [a-z0-9-]+:/);
});
