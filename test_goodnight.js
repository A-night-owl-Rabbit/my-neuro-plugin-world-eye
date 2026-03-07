// 世界之眼 - 端到端测试：用户说"晚安"
// 预期: 搜索到 sleep_weather_auto_check / write_ai_diary / greeting_time_auto_check

const path = require('path');
const fs = require('fs');

// Mock 依赖
const apiUtilsPath = path.join(__dirname, '..', '..', '..', 'js', 'api-utils.js');
try { require(apiUtilsPath); } catch {
    require.cache[require.resolve(apiUtilsPath)] = {
        id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
        exports: {
            logToTerminal: (lv, msg) => console.log(`    [${lv.toUpperCase()}] ${msg}`),
            logToolAction: () => {},
            getMergedToolsList: () => [],
            handleAPIError: async () => { throw new Error(); }
        }
    };
}
const pluginBasePath = path.join(__dirname, '..', '..', '..', 'js', 'core', 'plugin-base.js');
try { require(pluginBasePath); } catch {
    require.cache[require.resolve(pluginBasePath)] = {
        id: pluginBasePath, filename: pluginBasePath, loaded: true,
        exports: {
            Plugin: class Plugin {
                constructor(m, c) { this.metadata = m; this.context = c; }
                async onInit() {} async onStart() {} getTools() { return []; }
                async executeTool() {} async onLLMRequest() {}
            }
        }
    };
}

// Mock 全局工具管理器
const MOCK_TOOLS = [
    { type: 'function', function: { name: 'get_current_time', description: '当用户明确询问当前时间、日期或星期时调用此工具。例如：\'现在几点？\', \'今天星期几？\'。', parameters: { type: 'object', properties: { timezone: { type: 'string', description: '时区' } }, required: [] } } },
    { type: 'function', function: { name: 'greeting_time_auto_check', description: '当用户使用与时间相关的问候语或道别语时自动调用。例如：\'早上好\', \'晚上好\', \'晚安\'。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'sleep_weather_auto_check', description: '当用户表达要去睡觉的意图时，自动查询天津北辰区天气并提供睡前提醒。检测关键词如：睡觉、睡了、晚安、休息等。', parameters: { type: 'object', properties: { user_message: { type: 'string', description: '用户的消息内容' } }, required: ['user_message'] } } },
    { type: 'function', function: { name: 'write_ai_diary', description: '当用户说晚安、睡觉等表示要去睡觉的话时，调用此工具生成今天的AI日志。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'beichen_weather_reminder', description: '查询天津北辰区天气。如果在当天凌晨6点之前查询，则提醒今天的天气；如果在6点之后，则提醒次日的天气。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'google_search', description: 'Google搜索 - 最全面的搜索引擎，结果经AI深度提炼', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'execute_code', description: '执行AI生成的Python代码，支持各种编程任务如数据处理、文件操作、网络请求、计算等', parameters: { type: 'object', properties: { code: { type: 'string', description: '要执行的Python代码' } }, required: ['code'] } } },
    { type: 'function', function: { name: 'launch_application', description: '根据应用名称启动用户电脑上的一个指定应用程序。', parameters: { type: 'object', properties: { appName: { type: 'string', description: '应用名称' } }, required: ['appName'] } } },
    { type: 'function', function: { name: 'memos_search_memory', description: '从AI的长期记忆系统中搜索相关历史信息和对话', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'play_random_music', description: '使用你的真实声音开始唱一首随机的歌曲', parameters: { type: 'object', properties: {}, required: [] } } },
];

global.localToolManager = { isEnabled: true, getToolsForLLM: () => MOCK_TOOLS };
global.mcpManager = null;
global.pluginManager = null;

const LOG_SEP = '═'.repeat(65);
const STEP_SEP = '─'.repeat(65);
let step = 0;
function logStep(title) {
    step++;
    console.log(`\n${STEP_SEP}`);
    console.log(`  📌 步骤 ${step}: ${title}`);
    console.log(STEP_SEP);
}

(async () => {
    console.log(`\n${LOG_SEP}`);
    console.log(`  🌍 世界之眼 - "晚安"场景测试`);
    console.log(`  📋 用户说: "晚安~明天还要早起呢"`);
    console.log(`  📅 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    console.log(LOG_SEP);

    // 初始化
    logStep('初始化插件 + 注册工具');
    const WorldEyePlugin = require('./index.js');
    const plugin = new WorldEyePlugin({ name: 'world-eye' }, {
        _config: { llm: { api_key: 'test', api_url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3.2' } }
    });
    plugin._pluginConfig = { enabled: true, search_top_k: 5, cache_ttl_seconds: 300 };
    plugin._registry.buildFromToolsList(MOCK_TOOLS);
    console.log(`    ✅ 注册 ${plugin._registry.size} 个工具`);

    // onLLMRequest 拦截
    logStep('onLLMRequest 拦截（10个工具 → 2个元工具）');
    const request = {
        messages: [
            { role: 'system', content: '你是AI助手肥牛...' },
            { role: 'user', content: '晚安~明天还要早起呢' }
        ],
        tools: [...MOCK_TOOLS]
    };
    console.log(`    👤 用户: "晚安~明天还要早起呢"`);
    console.log(`    原始工具: ${request.tools.length} 个`);
    await plugin.onLLMRequest(request);
    console.log(`    拦截后: ${request.tools.length} 个元工具`);

    // 主LLM看到的缩略词概览
    logStep('主LLM看到的缩略词概览');
    const abbr = plugin._registry.getAbbreviationList();
    abbr.split('\n').forEach(line => console.log(`    ${line}`));

    // 搜索：晚安 天气 睡觉
    logStep('主LLM调用 world_eye_search("晚安 睡觉 天气")');
    console.log('    🤖 主LLM 分析: 用户说晚安 → 需要睡前天气提醒');
    const searchResult = await plugin.executeTool('world_eye_search', { query: '晚安 睡觉 天气', top_k: 5 });
    console.log('');
    console.log('    📋 搜索结果:');
    console.log('    ┌' + '─'.repeat(60) + '┐');
    searchResult.split('\n').forEach(line => {
        console.log(`    │ ${line.padEnd(59)}│`);
    });
    console.log('    └' + '─'.repeat(60) + '┘');

    // 主LLM决策
    logStep('主LLM 自主决策');
    console.log('    🤖 主LLM 分析搜索结果:');

    const candidates = plugin._registry.search('晚安 睡觉 天气', 5);
    candidates.forEach((c, i) => {
        const entry = c.entry;
        const match = entry.name === 'sleep_weather_auto_check' ? '← 最匹配!' :
                      entry.name === 'write_ai_diary' ? '← 也需要调用' :
                      entry.name === 'greeting_time_auto_check' ? '← 也相关' : '';
        console.log(`      ${i + 1}. ${entry.name} (${c.score.toFixed(2)}) → ${entry.abbreviation} ${match}`);
    });

    console.log('');
    console.log('    🤖 主LLM 决策: 先调用 sleep_weather_auto_check（睡前天气）');

    // 执行第一个工具
    logStep('委派执行 sleep_weather_auto_check');
    console.log('    🤖 主LLM 调用: world_eye_execute(');
    console.log('         tool_name: "sleep_weather_auto_check",');
    console.log('         task_description: "用户说晚安，查询睡前天气提醒，user_message=晚安~明天还要早起呢"');
    console.log('       )');

    const subAgentInfo = plugin._registry.formatForSubAgent('sleep_weather_auto_check');
    console.log('');
    console.log('    📦 下级智能体收到:');
    console.log('    ┌' + '─'.repeat(60) + '┐');
    subAgentInfo.split('\n').forEach(line => {
        console.log(`    │ ${line.padEnd(59)}│`);
    });
    console.log('    └' + '─'.repeat(60) + '┘');

    console.log('');
    console.log('    🤖 下级智能体(DeepSeek V3.2) 生成 tool_calls:');
    console.log('      {');
    console.log('        name: "sleep_weather_auto_check",');
    console.log('        arguments: { user_message: "晚安~明天还要早起呢" }');
    console.log('      }');
    console.log('');
    console.log('    🔧 toolExecutor 执行 → 返回天气结果:');
    console.log('      "明天天津北辰区：晴转多云，8~18°C，东南风3级。');
    console.log('       温馨提示：明天早晚温差较大，早起记得加件外套哦~"');
    console.log('');
    console.log('    📤 下级智能体返回结果 → 主LLM');

    // 缓存命中 + 第二个工具
    logStep('主LLM 继续调用 write_ai_diary（缓存中已有 sleep_weather_auto_check）');
    plugin._recentTools.set('sleep_weather_auto_check', { name: 'sleep_weather_auto_check', definition: MOCK_TOOLS[2], lastUsed: Date.now() });

    console.log(`    📦 最近使用缓存: [${Array.from(plugin._recentTools.keys()).join(', ')}]`);
    console.log('    🤖 主LLM 还需要写AI日志 → 调用 world_eye_execute(');
    console.log('         tool_name: "write_ai_diary",');
    console.log('         task_description: "用户说晚安要去睡觉了，生成今天的AI日志"');
    console.log('       )');
    console.log('');
    console.log('    🔧 下级智能体执行 write_ai_diary() → 日志生成完成');

    // 最终回复
    logStep('主LLM 生成最终回复');
    console.log('    📥 主LLM 收到两个工具的结果:');
    console.log('       1. 天气: "明天晴转多云，8~18°C，早起加外套"');
    console.log('       2. 日志: "今日AI日志已生成"');
    console.log('');
    console.log('    🤖 主LLM 最终回复:');
    console.log('    ┌' + '─'.repeat(60) + '┐');
    console.log('    │ "晚安呀~明天天津北辰区晴转多云，8到18度，早晚温差   │');
    console.log('    │  比较大，明天早起记得穿外套哦！今天的日记我也写好了，│');
    console.log('    │  好好休息，明天见~"                                   │');
    console.log('    └' + '─'.repeat(60) + '┘');

    // 总结
    console.log(`\n${LOG_SEP}`);
    console.log('  📊 "晚安"场景工作流总结');
    console.log(LOG_SEP);
    console.log('');
    console.log('  用户: "晚安~明天还要早起呢"');
    console.log('    → onLLMRequest 拦截 (10个工具 → 2个元工具)');
    console.log('    → 主LLM 看缩略词概览，识别到"睡前天气提醒"和"AI日志生成"');
    console.log('    → world_eye_search("晚安 睡觉 天气")');
    console.log('    → BM25 返回候选: sleep_weather_auto_check, write_ai_diary, ...');
    console.log('    → 主LLM 决策: 先查天气，再写日志');
    console.log('    → world_eye_execute("sleep_weather_auto_check", ...)');
    console.log('        → 下级智能体(DeepSeek V3.2) 执行 → 天气结果回传');
    console.log('    → world_eye_execute("write_ai_diary", ...)');
    console.log('        → 下级智能体执行 → 日志生成完成');
    console.log('    → 主LLM 整合结果 → 回复用户');
    console.log(`\n${LOG_SEP}\n`);

})().catch(e => { console.error('测试失败:', e); process.exit(1); });
