// 世界之眼 - 端到端模拟测试：查询当前时间
// 模拟完整工作流：初始化 → 工具发现 → onLLMRequest → 搜索 → 决策 → 委派执行 → 结果回传

const path = require('path');

// ===== Mock 全局环境 =====
const apiUtilsPath = path.join(__dirname, '..', '..', '..', 'js', 'api-utils.js');
try { require(apiUtilsPath); } catch {
    require.cache[require.resolve(apiUtilsPath)] = {
        id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
        exports: {
            logToTerminal: (level, msg) => console.log(`    [${level.toUpperCase()}] ${msg}`),
            logToolAction: (level, msg) => console.log(`    [TOOL-${level.toUpperCase()}] ${msg}`),
            getMergedToolsList: () => [], handleAPIError: async () => { throw new Error('API error'); }
        }
    };
}
const pluginBasePath = path.join(__dirname, '..', '..', '..', 'js', 'core', 'plugin-base.js');
try { require(pluginBasePath); } catch {
    require.cache[require.resolve(pluginBasePath)] = {
        id: pluginBasePath, filename: pluginBasePath, loaded: true,
        exports: {
            Plugin: class Plugin {
                constructor(metadata, context) { this.metadata = metadata; this.context = context; }
                async onInit() {} async onStart() {} getTools() { return []; }
                async executeTool() {} async onLLMRequest() {}
            }
        }
    };
}

// ===== 模拟的工具列表（对应你实际的 server-tools）=====
const MOCK_ALL_TOOLS = [
    { type: 'function', function: { name: 'get_current_time', description: '当用户明确询问当前时间、日期或星期时调用此工具。例如：\'现在几点？\', \'今天星期几？\'。', parameters: { type: 'object', properties: { timezone: { type: 'string', description: '时区（可选，如Asia/Shanghai，默认使用服务器时区）' } }, required: [] } } },
    { type: 'function', function: { name: 'greeting_time_auto_check', description: '当用户使用与时间相关的问候语或道别语时自动调用。例如：\'早上好\', \'晚上好\', \'晚安\'。', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'google_search', description: 'Google搜索 - 使用Google搜索引擎进行网页搜索，结果最全面，经AI深度提炼', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'web_search', description: '快速搜索 - Tavily引擎快速网页搜索，经AI深度提炼', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'search_bilibili_video', description: '根据关键词搜索B站视频。', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '搜索关键词' } }, required: ['keyword'] } } },
    { type: 'function', function: { name: 'execute_code', description: '执行AI生成的Python代码，支持各种编程任务如数据处理、文件操作、网络请求、计算等', parameters: { type: 'object', properties: { code: { type: 'string', description: '要执行的Python代码' } }, required: ['code'] } } },
    { type: 'function', function: { name: 'launch_application', description: '根据应用名称启动用户电脑上的一个指定应用程序。', parameters: { type: 'object', properties: { appName: { type: 'string', description: '要启动的应用程序名称' } }, required: ['appName'] } } },
    { type: 'function', function: { name: 'take_screenshot', description: '截取当前电脑屏幕的截图', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'control_edge_browser', description: '控制 Edge 浏览器打开URL或搜索', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['open_url', 'search'], description: '操作类型' }, target: { type: 'string', description: '目标URL或搜索词' } }, required: ['action', 'target'] } } },
    { type: 'function', function: { name: 'check_beichen_weather', description: '执行天气查询', parameters: { type: 'object', properties: {}, required: [] } } },
    { type: 'function', function: { name: 'memos_search_memory', description: '搜索记忆', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'astrbook_browse_threads', description: '浏览 Astrbook 论坛的帖子列表。', parameters: { type: 'object', properties: { page: { type: 'number', description: '页码' } }, required: [] } } },
];

// ===== Mock 全局工具管理器（让 _discoverTools 能正确工作）=====
global.localToolManager = {
    isEnabled: true,
    getToolsForLLM: () => MOCK_ALL_TOOLS
};
global.mcpManager = null;
global.pluginManager = null;

// ===== 开始测试 =====

const LOG_SEPARATOR = '═'.repeat(70);
const STEP_SEPARATOR = '─'.repeat(70);
let stepNum = 0;

function logStep(title) {
    stepNum++;
    console.log(`\n${STEP_SEPARATOR}`);
    console.log(`  📌 步骤 ${stepNum}: ${title}`);
    console.log(STEP_SEPARATOR);
}

(async () => {
    console.log(`\n${LOG_SEPARATOR}`);
    console.log(`  🌍 世界之眼 - 端到端工作流测试`);
    console.log(`  📋 测试场景: 用户问"现在几点了"`);
    console.log(`  📅 测试时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
    console.log(LOG_SEPARATOR);

    // ===== 步骤 1: 插件初始化 =====
    logStep('插件初始化 (onInit)');

    const WorldEyePlugin = require('./index.js');
    const mockContext = {
        _config: { llm: { api_key: 'test-key', api_url: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash' } }
    };
    const plugin = new WorldEyePlugin({ name: 'world-eye', version: '1.0.0' }, mockContext);
    plugin._pluginConfig = { enabled: true, search_top_k: 5, cache_ttl_seconds: 300 };

    console.log('    ✅ 插件实例创建成功');
    console.log(`    配置: enabled=${plugin._pluginConfig.enabled}, top_k=${plugin._pluginConfig.search_top_k}`);

    // ===== 步骤 2: 工具发现 =====
    logStep('工具自动发现 (onStart → buildFromToolsList)');

    plugin._registry.buildFromToolsList(MOCK_ALL_TOOLS);
    console.log(`    ✅ 发现并注册了 ${plugin._registry.size} 个工具`);
    console.log(`    工具列表:`);
    MOCK_ALL_TOOLS.forEach(t => {
        const name = t.function.name;
        const entry = plugin._registry.getByName(name);
        console.log(`      • ${name} → [${entry.category}] ${entry.abbreviation}`);
    });

    // ===== 步骤 3: 缩略词概览生成 =====
    logStep('生成工具缩略词概览（注入到 world_eye_search 描述中）');

    const abbreviationList = plugin._registry.getAbbreviationList();
    console.log('    缩略词概览 (主LLM会看到):');
    abbreviationList.split('\n').forEach(line => console.log(`      ${line}`));

    // ===== 步骤 4: 用户发送消息，触发 onLLMRequest =====
    logStep('用户输入 → onLLMRequest 钩子拦截');

    console.log('    👤 用户: "现在几点了"');
    console.log(`    原始工具列表: ${MOCK_ALL_TOOLS.length} 个工具`);

    const mockRequest = {
        messages: [
            { role: 'system', content: '你是一个AI助手...' },
            { role: 'user', content: '现在几点了' }
        ],
        tools: [...MOCK_ALL_TOOLS]
    };

    await plugin.onLLMRequest(mockRequest);

    console.log(`    🔄 拦截后工具列表: ${mockRequest.tools.length} 个元工具`);
    mockRequest.tools.forEach(t => {
        console.log(`      • ${t.function.name}: ${t.function.description.substring(0, 60)}...`);
    });

    // ===== 步骤 5: 模拟主LLM决策 → 调用 world_eye_search =====
    logStep('主LLM 决策 → 调用 world_eye_search("时间 几点")');

    console.log('    🤖 主LLM 分析: 用户问时间 → 需要搜索时间相关工具');
    console.log('    🤖 主LLM 调用: world_eye_search(query="时间 几点")');
    console.log('');

    const searchResult = await plugin.executeTool('world_eye_search', {
        query: '时间 几点',
        top_k: 5
    });

    console.log('');
    console.log('    📋 搜索结果 (返回给主LLM的内容):');
    console.log('    ┌' + '─'.repeat(64) + '┐');
    searchResult.split('\n').forEach(line => {
        console.log(`    │ ${line.padEnd(63)}│`);
    });
    console.log('    └' + '─'.repeat(64) + '┘');

    // ===== 步骤 6: 模拟主LLM选择工具 → 调用 world_eye_execute =====
    logStep('主LLM 自主决策 → 选择 get_current_time → 调用 world_eye_execute');

    console.log('    🤖 主LLM 阅读搜索结果后判断:');
    console.log('      - 候选 get_current_time: 当用户明确询问时间 ← 完全匹配!');
    console.log('      - 候选 greeting_time_auto_check: 问候语自动检查 ← 不适用');
    console.log('      - 其他候选: 不相关');
    console.log('    🤖 主LLM 决策: 选择 get_current_time');
    console.log('');
    console.log('    🤖 主LLM 调用: world_eye_execute(');
    console.log('         tool_name: "get_current_time",');
    console.log('         task_description: "查询当前时间，默认使用 Asia/Shanghai 时区"');
    console.log('       )');

    // ===== 步骤 7: 查看下级智能体会收到什么 =====
    logStep('下级智能体接收内容预览（完整定义 + 使用示例）');

    const subAgentInfo = plugin._registry.formatForSubAgent('get_current_time');
    console.log('    📦 下级智能体收到的完整工具信息:');
    console.log('    ┌' + '─'.repeat(64) + '┐');
    subAgentInfo.split('\n').forEach(line => {
        console.log(`    │ ${line.padEnd(63)}│`);
    });
    console.log('    └' + '─'.repeat(64) + '┘');

    // ===== 步骤 8: 模拟下级智能体执行（无法实际调用LLM，模拟输出）=====
    logStep('下级智能体执行工具调用（模拟）');

    console.log('    🤖 下级智能体 System Prompt:');
    console.log('      "你是一个专业的工具执行智能体..."');
    console.log('');
    console.log('    🤖 下级智能体分析任务要求 + 工具定义 + 使用示例');
    console.log('    🤖 下级智能体生成 tool_calls:');
    console.log('      {');
    console.log('        name: "get_current_time",');
    console.log('        arguments: { timezone: "Asia/Shanghai" }');
    console.log('      }');
    console.log('');

    // 模拟实际工具执行结果
    const now = new Date();
    const mockToolResult = `当前Asia/Shanghai时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;

    console.log(`    🔧 toolExecutor 执行 get_current_time({timezone: "Asia/Shanghai"})`);
    console.log(`    📤 工具返回: "${mockToolResult}"`);
    console.log('');
    console.log('    🤖 下级智能体收到工具结果，生成最终回复:');
    const subAgentFinalResult = mockToolResult;
    console.log(`    📤 下级智能体返回: "${subAgentFinalResult}"`);

    // ===== 步骤 9: 结果回传给主LLM =====
    logStep('world_eye_execute 返回结果 → 主LLM 生成最终回复');

    console.log(`    📥 主LLM 收到 world_eye_execute 返回:`);
    console.log(`       "${subAgentFinalResult}"`);
    console.log('');
    console.log(`    🤖 主LLM 生成最终回复:`);
    console.log(`       "现在是北京时间 ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })}。"`);

    // ===== 步骤 10: 验证缓存机制 =====
    logStep('重复调用验证（缓存机制）');

    // 模拟 execute 被调用后的缓存状态
    plugin._recentTools.set('get_current_time', {
        name: 'get_current_time',
        definition: MOCK_ALL_TOOLS[0],
        lastUsed: Date.now()
    });

    const recentList = Array.from(plugin._recentTools.keys()).join(', ');
    console.log(`    📦 最近使用缓存: [${recentList}]`);
    console.log('');
    console.log('    👤 用户: "那东京呢？现在东京几点？"');
    console.log('    🤖 主LLM 看到 "最近使用过的工具: get_current_time"');
    console.log('    🤖 主LLM 直接调用 world_eye_execute(');
    console.log('         tool_name: "get_current_time",');
    console.log('         task_description: "查询东京时间，timezone 使用 Asia/Tokyo"');
    console.log('       )');
    console.log('    ⚡ 跳过搜索步骤，直接委派下级智能体执行');

    const tokyoTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    console.log(`    📤 结果: "当前Asia/Tokyo时间：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Tokyo' })}"`);

    // ===== 汇总 =====
    console.log(`\n${LOG_SEPARATOR}`);
    console.log('  📊 工作流总结');
    console.log(LOG_SEPARATOR);
    console.log('');
    console.log('  首次调用流程:');
    console.log('    用户输入 → onLLMRequest拦截(12个工具→2个元工具)');
    console.log('    → 主LLM调用 world_eye_search("时间 几点")');
    console.log('    → BM25返回5个候选(含相关度分数)');
    console.log('    → 主LLM自主决策选择 get_current_time');
    console.log('    → 主LLM调用 world_eye_execute(tool_name, task_description)');
    console.log('    → 下级智能体(独立LLM) 收到: 任务要求+完整定义+使用示例');
    console.log('    → 下级智能体生成 tool_calls → toolExecutor执行');
    console.log('    → 结果回传 → 主LLM生成最终回复 → 用户');
    console.log('');
    console.log('  重复调用流程(缓存命中):');
    console.log('    用户输入 → onLLMRequest拦截');
    console.log('    → 主LLM看到"最近使用: get_current_time"');
    console.log('    → 直接调用 world_eye_execute (跳过搜索)');
    console.log('    → 下级智能体执行 → 结果回传 → 用户');
    console.log('');
    console.log(`  Token 节省: 原始 ${MOCK_ALL_TOOLS.length} 个工具定义 → 仅 2 个元工具 + 缩略词概览`);
    console.log(`${LOG_SEPARATOR}\n`);

})().catch(e => {
    console.error('测试失败:', e);
    process.exit(1);
});
