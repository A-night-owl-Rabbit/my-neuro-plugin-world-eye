// 测试缓存持久化：验证缩略词、分类、示例能正确保存和恢复

const path = require('path');
const fs = require('fs');

// Mock 依赖
const apiUtilsPath = path.join(__dirname, '..', '..', '..', 'js', 'api-utils.js');
try { require(apiUtilsPath); } catch {
    require.cache[require.resolve(apiUtilsPath)] = {
        id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
        exports: {
            logToTerminal: () => {},
            logToolAction: () => {},
            getMergedToolsList: () => [],
            handleAPIError: async () => { throw new Error('API error'); }
        }
    };
}

const { ToolRegistry } = require('./tool-registry.js');

const MOCK_TOOLS = [
    { type: 'function', function: { name: 'get_current_time', description: '查询当前时间、日期或星期', parameters: { type: 'object', properties: { timezone: { type: 'string', description: '时区，如Asia/Shanghai' } }, required: [] } } },
    { type: 'function', function: { name: 'google_search', description: 'Google搜索引擎进行网页搜索', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'take_screenshot', description: '截取当前电脑屏幕的截图', parameters: { type: 'object', properties: {}, required: [] } } },
];

const cachePath = path.join(__dirname, 'tool_cache.json');

// 清理旧缓存
if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);

console.log('=== 第一次构建（无缓存，需要生成） ===\n');

const registry1 = new ToolRegistry(__dirname);
const changed1 = registry1.buildFromToolsList(MOCK_TOOLS);

console.log(`buildFromToolsList 返回: ${changed1} (应为 true)`);
console.log(`注册工具数: ${registry1.size}`);
console.log('');

for (const tool of MOCK_TOOLS) {
    const entry = registry1.getByName(tool.function.name);
    console.log(`  ${entry.name}:`);
    console.log(`    缩略词: ${entry.abbreviation}`);
    console.log(`    分类: ${entry.category}`);
    console.log(`    示例数: ${entry.examples.length}`);
}

// 检查缓存文件是否已写入
const cacheExists = fs.existsSync(cachePath);
console.log(`\n缓存文件已写入: ${cacheExists} (应为 true)`);

if (cacheExists) {
    const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log(`缓存哈希: ${cacheData._hash}`);
    console.log(`缓存时间: ${cacheData._savedAt}`);
    console.log(`缓存工具数: ${Object.keys(cacheData.tools).length}`);
    console.log('');
    for (const [name, data] of Object.entries(cacheData.tools)) {
        console.log(`  ${name}:`);
        console.log(`    缩略词: ${data.abbreviation}`);
        console.log(`    分类: ${data.category}`);
        console.log(`    示例数: ${data.examples.length}`);
    }
}

console.log('\n=== 第二次构建（模拟进程重启，从磁盘缓存恢复） ===\n');

const registry2 = new ToolRegistry(__dirname);
const changed2 = registry2.buildFromToolsList(MOCK_TOOLS);

console.log(`buildFromToolsList 返回: ${changed2} (应为 true，因为内存哈希为空)`);
console.log(`注册工具数: ${registry2.size}`);
console.log('');

let allMatch = true;
for (const tool of MOCK_TOOLS) {
    const e1 = registry1.getByName(tool.function.name);
    const e2 = registry2.getByName(tool.function.name);

    const abbrMatch = e1.abbreviation === e2.abbreviation;
    const catMatch = e1.category === e2.category;
    const exMatch = JSON.stringify(e1.examples) === JSON.stringify(e2.examples);

    if (!abbrMatch || !catMatch || !exMatch) allMatch = false;

    console.log(`  ${e2.name}:`);
    console.log(`    缩略词: ${e2.abbreviation} ${abbrMatch ? '✅ 一致' : '❌ 不一致'}`);
    console.log(`    分类: ${e2.category} ${catMatch ? '✅ 一致' : '❌ 不一致'}`);
    console.log(`    示例: ${exMatch ? '✅ 一致' : '❌ 不一致'}`);
}

console.log('\n=== 第三次构建（同一实例，哈希命中内存，应跳过） ===\n');

const changed3 = registry2.buildFromToolsList(MOCK_TOOLS);
console.log(`buildFromToolsList 返回: ${changed3} (应为 false，内存哈希命中直接跳过)`);

console.log('\n=== 搜索验证（缓存恢复后 BM25 索引是否正常） ===\n');

const results = registry2.search('时间 几点', 3);
console.log(`搜索 "时间 几点" 返回 ${results.length} 个结果:`);
results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.entry.name} (分数: ${r.score.toFixed(2)})`);
});

console.log(`\n${'═'.repeat(50)}`);
console.log(`  总结: ${allMatch ? '✅ 所有缓存数据恢复一致' : '❌ 存在不一致'}`);
console.log(`${'═'.repeat(50)}\n`);

// 清理测试缓存
if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
process.exit(allMatch ? 0 : 1);
