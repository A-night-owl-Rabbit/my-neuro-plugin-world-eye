const assert = require('node:assert/strict');
const test = require('node:test');
const { SubAgent, ROLE_PROMPT_BLOCKS, WORLD_EYE_PERSONA } = require('../sub-agent.js');

const ALL_ROLES = Object.keys(ROLE_PROMPT_BLOCKS);
// 注意：不含「思考独白」「扮演」——v4 提示里有「禁止思考独白」「禁止任何角色扮演腔」的合法禁令语句
const ANIME_RESIDUE = /折木|鲁路修|リヴァイ|柯南|雪乃|遠子|爱德华|結衣|Daru|公生|英梨々|凉宫|羽川|セイバー|卡卡西|动漫|你就是.*角色|animeRef/;

test('统一人格常量包含核心特质关键词', () => {
    assert.match(WORLD_EYE_PERSONA, /世界之眼工作人格/);
    assert.match(WORLD_EYE_PERSONA, /细致/);
    assert.match(WORLD_EYE_PERSONA, /准确/);
    assert.match(WORLD_EYE_PERSONA, /克制/);
});

test('所有角色系统提示注入统一人格且零动漫残留', () => {
    const agent = new SubAgent({}, { personality: { enabled: true } });
    for (const role of ALL_ROLES) {
        const prompt = agent._buildSystemPrompt({ role, isTemporaryWorker: true });
        assert.match(prompt, /【世界之眼工作人格】/, `${role} 缺少统一人格`);
        assert.doesNotMatch(prompt, ANIME_RESIDUE, `${role} 存在动漫/独白残留`);
        assert.match(prompt, new RegExp(ROLE_PROMPT_BLOCKS[role].title), `${role} 缺少职责标题`);
    }
});

test('系统提示禁止独白分层输出', () => {
    const agent = new SubAgent({}, {});
    const prompt = agent._buildSystemPrompt({ role: 'search', isTemporaryWorker: true });
    assert.match(prompt, /禁止思考独白/);
    assert.match(prompt, /禁止用 "---" 分层/);
});

test('personality.enabled=false 时退化为纯工程提示', () => {
    const agent = new SubAgent({}, { personality: { enabled: false } });
    const prompt = agent._buildSystemPrompt({ role: 'general', isTemporaryWorker: true });
    assert.doesNotMatch(prompt, /【世界之眼工作人格】/);
    assert.match(prompt, /共享执行规则/);
});

test('协商块保留工程协议但无人格样例', () => {
    const agent = new SubAgent({}, {});
    const lines = [];
    agent._appendNegotiationBlock(lines, { currentRound: 0, maxRounds: 2, forceExecute: false });
    const text = lines.join('\n');
    assert.match(text, /【返回上游】/);
    assert.match(text, /4 类硬缺口/);
    assert.doesNotMatch(text, /questionSamples|提问样例|审查提问权/);
});

test('handoff 信件用角色名而非人格名', () => {
    const agent = new SubAgent({}, {});
    const block = agent._formatHandoffBlock({ fromRole: 'search', content: '事实内容 A' });
    assert.match(block, /来源角色: search/);
    assert.match(block, /事实内容 A/);
});

test('handoff 信件兼容剥离旧格式独白层', () => {
    const agent = new SubAgent({}, {});
    const oldStyle = '我此刻在想一些演出内容……\n\n---\n\n事实层结果 B';
    const block = agent._formatHandoffBlock({ fromRole: 'reporter', content: oldStyle });
    assert.match(block, /事实层结果 B/);
    assert.doesNotMatch(block, /演出内容/);
});
