// 一次性生成完整的 tool_cache.json（包含所有 server-tools + 插件的缩略词和使用示例）
// 运行方式: node generate_cache.js

const path = require('path');
const fs = require('fs');

// Mock api-utils（避免 require 失败）
const apiUtilsPath = path.join(__dirname, '..', '..', '..', 'js', 'api-utils.js');
try { require(apiUtilsPath); } catch {
    require.cache[require.resolve(apiUtilsPath)] = {
        id: apiUtilsPath, filename: apiUtilsPath, loaded: true,
        exports: {
            logToTerminal: () => {},
            logToolAction: () => {},
            getMergedToolsList: () => [],
            handleAPIError: async () => { throw new Error(); }
        }
    };
}

const { ToolRegistry } = require('./tool-registry.js');

// ===== 收集所有工具定义 =====

const ALL_TOOLS = [];
const SERVER_TOOLS_DIR = path.join(__dirname, '..', '..', '..', 'server-tools');

// 方法1: 从各文件的 getToolDefinitions() 收集
const toolFiles = fs.readdirSync(SERVER_TOOLS_DIR).filter(f =>
    f.endsWith('.js') && f !== 'index.js'
);

console.log(`📂 扫描 server-tools 目录: ${toolFiles.length} 个文件\n`);

let successCount = 0;
let failCount = 0;

for (const file of toolFiles) {
    const filePath = path.join(SERVER_TOOLS_DIR, file);
    try {
        const mod = require(filePath);
        if (typeof mod.getToolDefinitions === 'function') {
            const defs = mod.getToolDefinitions();
            if (Array.isArray(defs)) {
                for (const def of defs) {
                    const name = def.name || (def.function && def.function.name);
                    if (!name) continue;

                    // 统一为 OpenAI function calling 格式
                    if (def.type === 'function' && def.function) {
                        ALL_TOOLS.push(def);
                    } else {
                        ALL_TOOLS.push({
                            type: 'function',
                            function: {
                                name: def.name,
                                description: def.description || '',
                                parameters: def.parameters || { type: 'object', properties: {}, required: [] }
                            }
                        });
                    }
                }
                console.log(`  ✅ ${file}: ${defs.length} 个工具 (getToolDefinitions)`);
                successCount++;
            }
        } else {
            // 方法2: 导出的 async function（由 index.js 自动扫描的那些）
            const funcNames = Object.keys(mod).filter(k =>
                typeof mod[k] === 'function' && k !== 'getToolDefinitions' && k !== 'executeFunction'
            );
            if (funcNames.length > 0) {
                for (const funcName of funcNames) {
                    const toolName = funcName.replace(/([A-Z])/g, '_$1').toLowerCase();
                    ALL_TOOLS.push({
                        type: 'function',
                        function: {
                            name: toolName,
                            description: `${funcName} 工具`,
                            parameters: { type: 'object', properties: {}, required: [] }
                        }
                    });
                }
                console.log(`  ✅ ${file}: ${funcNames.length} 个工具 (exported functions)`);
                successCount++;
            } else {
                console.log(`  ⏭️  ${file}: 无工具定义`);
            }
        }
    } catch (err) {
        console.log(`  ❌ ${file}: 加载失败 - ${err.message.substring(0, 80)}`);
        failCount++;
    }
}

// 方法3: 扫描插件目录
const PLUGINS_DIR = path.join(__dirname, '..', '..');
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

const pluginDirs = ['community'];
for (const subDir of pluginDirs) {
    const communityDir = path.join(PLUGINS_DIR, subDir);
    if (!fs.existsSync(communityDir)) continue;

    const pluginFolders = fs.readdirSync(communityDir).filter(f => {
        const indexPath = path.join(communityDir, f, 'index.js');
        return fs.existsSync(indexPath) && f !== 'world-eye';
    });

    for (const folder of pluginFolders) {
        try {
            const pluginModule = require(path.join(communityDir, folder, 'index.js'));
            const PluginClass = typeof pluginModule === 'function' ? pluginModule : pluginModule.default;
            if (!PluginClass) continue;

            const instance = new PluginClass({ name: folder }, {});
            const tools = instance.getTools ? instance.getTools() : [];

            if (tools.length > 0) {
                ALL_TOOLS.push(...tools);
                console.log(`  ✅ plugin/${folder}: ${tools.length} 个工具`);
            }
        } catch (err) {
            console.log(`  ⏭️  plugin/${folder}: ${err.message.substring(0, 60)}`);
        }
    }
}

// 去重（按 name）
const seen = new Set();
const uniqueTools = [];
for (const tool of ALL_TOOLS) {
    const name = (tool.function || tool).name;
    if (!seen.has(name)) {
        seen.add(name);
        uniqueTools.push(tool);
    }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  📊 总计: ${uniqueTools.length} 个唯一工具`);
console.log(`  加载成功: ${successCount} 个文件, 失败: ${failCount} 个文件`);
console.log(`${'═'.repeat(50)}\n`);

// ===== 构建 ToolRegistry 并生成缓存 =====

const registry = new ToolRegistry(__dirname);
registry.buildFromToolsList(uniqueTools);

console.log(`✅ tool_cache.json 已生成!`);
console.log(`   路径: ${path.join(__dirname, 'tool_cache.json')}`);
console.log(`   工具数: ${registry.size}`);

// 输出分类统计
const categories = {};
for (const tool of uniqueTools) {
    const name = (tool.function || tool).name;
    const entry = registry.getByName(name);
    if (entry) {
        const cat = entry.category;
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(name);
    }
}

console.log(`\n📋 分类统计:`);
for (const [cat, names] of Object.entries(categories).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`   [${cat}] ${names.length} 个: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '...' : ''}`);
}
