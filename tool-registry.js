// tool-registry.js - 工具注册表：自动发现、缩略词生成、索引构建、示例自动生成

const fs = require('fs');
const path = require('path');
const { BM25Index } = require('./bm25-search.js');
const { ABBREVIATION_MAP } = require('./abbreviations.js');

// 排除的工具（配置/设置类，已内置到插件中，不需要暴露给主LLM）
const EXCLUDED_TOOLS = new Set([
    'astrbook_register',
    'astrbook_config',
]);

const EXAMPLE_TYPE_MAP = {
    string: (prop) => {
        if (prop.enum && prop.enum.length > 0) return prop.enum[0];
        if (prop.description) {
            const match = prop.description.match(/[eE]\.?g\.?\s*[:：]?\s*["']?([^"',，。)）]+)/);
            if (match) return match[1].trim();
        }
        return 'example_value';
    },
    number: (prop) => {
        if (prop.enum && prop.enum.length > 0) return prop.enum[0];
        if (prop.minimum !== undefined) return prop.minimum;
        return 1;
    },
    integer: (prop) => {
        if (prop.enum && prop.enum.length > 0) return prop.enum[0];
        if (prop.minimum !== undefined) return prop.minimum;
        return 1;
    },
    boolean: () => true,
    array: (prop) => {
        if (prop.items) {
            const itemGen = EXAMPLE_TYPE_MAP[prop.items.type];
            if (itemGen) return [itemGen(prop.items)];
        }
        return [];
    },
    object: () => ({})
};

class ToolRegistry {
    constructor(pluginDir) {
        this._pluginDir = pluginDir;
        this._cachePath = path.join(pluginDir, 'tool_cache.json');

        /** @type {Map<string, ToolEntry>} name -> entry */
        this._tools = new Map();
        this._bm25 = new BM25Index();
        this._toolsHash = '';
        this._cache = {};

        this._loadCache();
    }

    /**
     * 从合并的工具列表构建注册表
     * @param {Array} toolsList - getMergedToolsList() 返回的工具列表
     * @returns {boolean} 是否有变化（需要重建索引）
     */
    buildFromToolsList(toolsList) {
        const newHash = this._computeHash(toolsList);
        if (newHash === this._toolsHash) return false;

        // 磁盘缓存命中：哈希匹配且缓存中有工具数据，直接恢复
        if (this._cache._hash === newHash && this._cache.tools && Object.keys(this._cache.tools).length > 0) {
            this._restoreFromCache(toolsList);
            this._toolsHash = newHash;
            return true;
        }

        this._tools.clear();
        this._bm25.clear();

        for (const toolDef of toolsList) {
            const funcDef = toolDef.function || toolDef;
            const name = funcDef.name;
            if (!name || EXCLUDED_TOOLS.has(name)) continue;

            const description = funcDef.description || '';
            const parameters = funcDef.parameters || funcDef.input_schema || {};

            const abbreviation = this._generateAbbreviation(name, description);
            const category = this._extractCategory(name);
            const examples = this._generateExamples(name, description, parameters);

            const entry = {
                name,
                abbreviation,
                category,
                description,
                definition: toolDef,
                parameters,
                examples
            };

            this._tools.set(name, entry);

            const searchText = this._buildSearchText(name, description, parameters);
            this._bm25.addDocument(name, searchText);
        }

        this._toolsHash = newHash;
        this._saveCache();
        return true;
    }

    /**
     * BM25 搜索工具
     * @param {string} query
     * @param {number} topK
     * @returns {Array<{entry: ToolEntry, score: number}>}
     */
    search(query, topK = 5) {
        const results = this._bm25.search(query, topK);
        return results
            .map(r => {
                const entry = this._tools.get(r.id);
                return entry ? { entry, score: r.score } : null;
            })
            .filter(Boolean);
    }

    /**
     * 按名称精确获取工具
     */
    getByName(name) {
        return this._tools.get(name) || null;
    }

    /**
     * 获取所有工具的缩略词列表（用于注入到 search 工具描述中）
     */
    getAbbreviationList() {
        const lines = [];
        const byCategory = {};

        for (const [, entry] of this._tools) {
            const cat = entry.category || 'other';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(`${entry.name}: ${entry.abbreviation}`);
        }

        for (const [cat, items] of Object.entries(byCategory)) {
            lines.push(`[${cat}] ${items.join(' | ')}`);
        }

        return lines.join('\n');
    }

    /**
     * 获取注册工具数量
     */
    get size() {
        return this._tools.size;
    }

    /**
     * 格式化搜索结果为返回给主LLM的文本（不含使用示例）
     */
    formatSearchResults(results) {
        if (results.length === 0) {
            return '未找到匹配的工具。你可以尝试用不同的关键词重新搜索。';
        }

        const parts = results.map((r, i) => {
            const e = r.entry;
            const paramDesc = this._formatParameters(e.parameters);
            return [
                `--- 候选工具 ${i + 1} (相关度: ${r.score.toFixed(2)}) ---`,
                `名称: ${e.name}`,
                `功能: ${e.description}`,
                paramDesc ? `参数:\n${paramDesc}` : '参数: 无',
            ].join('\n');
        });

        parts.push('\n以上为搜索候选结果，请根据实际需求判断是否适用。如需调用，请使用 world_eye_execute 并指定工具名和具体要求。');
        return parts.join('\n\n');
    }

    /**
     * 格式化工具的完整信息（含使用示例，给下级智能体用）
     */
    formatForSubAgent(name) {
        const entry = this._tools.get(name);
        if (!entry) return null;

        const paramDesc = this._formatParameters(entry.parameters);
        const exampleText = entry.examples.length > 0
            ? entry.examples.map((ex, i) =>
                `示例 ${i + 1}: ${ex.scenario}\n调用: ${JSON.stringify(ex.tool_call, null, 2)}\n说明: ${ex.note}`
            ).join('\n\n')
            : '暂无使用示例';

        return [
            `工具名称: ${entry.name}`,
            `功能描述: ${entry.description}`,
            paramDesc ? `参数定义:\n${paramDesc}` : '参数: 无',
            `\n使用示例:\n${exampleText}`,
        ].join('\n');
    }

    // ===== 内部方法 =====

    _generateAbbreviation(name, description) {
        if (ABBREVIATION_MAP[name]) {
            return ABBREVIATION_MAP[name];
        }
        const cached = this._cache.tools?.[name];
        if (cached?.abbreviation && !cached._autoGenerated) {
            return cached.abbreviation;
        }
        if (description) {
            const clean = description
                .replace(/[。.!！?？,，;；：:（）()【】\[\]'"]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            const short = clean.substring(0, 15);
            return short + (clean.length > 15 ? '...' : '');
        }
        return name.replace(/_/g, ' ');
    }

    /**
     * 获取需要 LLM 精炼缩略词的工具列表
     * @returns {Array<{name: string, description: string}>}
     */
    getToolsNeedingRefinement() {
        const needRefine = [];
        for (const [name, entry] of this._tools) {
            if (ABBREVIATION_MAP[name]) continue;
            const cached = this._cache.tools?.[name];
            if (cached?.abbreviation && !cached._autoGenerated) continue;
            needRefine.push({ name, description: entry.description });
        }
        return needRefine;
    }

    /**
     * 用 LLM 生成的缩略词批量更新注册表并持久化
     * @param {Object<string, string>} abbrMap - { toolName: abbreviation }
     */
    updateAbbreviations(abbrMap) {
        let updated = 0;
        for (const [name, abbr] of Object.entries(abbrMap)) {
            const entry = this._tools.get(name);
            if (entry && abbr) {
                entry.abbreviation = abbr;
                updated++;
            }
        }
        if (updated > 0) {
            this._saveCache();
        }
        return updated;
    }

    _extractCategory(name) {
        // 提取工具名中的命名空间前缀作为分类
        const parts = name.split('_');
        if (parts.length >= 2) {
            return parts[0];
        }
        return 'general';
    }

    _generateExamples(name, description, parameters) {
        const examples = [];
        const props = parameters.properties || {};
        const required = parameters.required || [];
        const propNames = Object.keys(props);

        if (propNames.length === 0) {
            examples.push({
                scenario: description || `调用 ${name}`,
                tool_call: { name, arguments: {} },
                note: '无需参数即可调用'
            });
            return examples;
        }

        // 示例 1：只填必填参数
        const minimalArgs = {};
        for (const paramName of required) {
            const prop = props[paramName];
            if (prop) {
                const gen = EXAMPLE_TYPE_MAP[prop.type];
                minimalArgs[paramName] = gen ? gen(prop) : 'value';
            }
        }
        examples.push({
            scenario: description || `调用 ${name}`,
            tool_call: { name, arguments: minimalArgs },
            note: required.length > 0
                ? `必填参数: ${required.join(', ')}`
                : '所有参数均为可选'
        });

        // 示例 2：包含可选参数（如果有的话）
        const optionalParams = propNames.filter(p => !required.includes(p));
        if (optionalParams.length > 0) {
            const fullArgs = { ...minimalArgs };
            for (const paramName of optionalParams.slice(0, 2)) {
                const prop = props[paramName];
                if (prop) {
                    const gen = EXAMPLE_TYPE_MAP[prop.type];
                    fullArgs[paramName] = gen ? gen(prop) : 'value';
                }
            }
            const usedOptional = optionalParams.slice(0, 2).join(', ');
            examples.push({
                scenario: `${description || name}（含可选参数）`,
                tool_call: { name, arguments: fullArgs },
                note: `额外使用了可选参数: ${usedOptional}`
            });
        }

        return examples;
    }

    _buildSearchText(name, description, parameters) {
        const parts = [name.replace(/_/g, ' '), description];

        const props = parameters.properties || {};
        for (const [paramName, paramDef] of Object.entries(props)) {
            parts.push(paramName.replace(/_/g, ' '));
            if (paramDef.description) {
                parts.push(paramDef.description);
            }
        }

        return parts.join(' ');
    }

    _formatParameters(parameters) {
        const props = parameters.properties || {};
        const required = new Set(parameters.required || []);
        const entries = Object.entries(props);

        if (entries.length === 0) return '';

        return entries.map(([name, def]) => {
            const req = required.has(name) ? '(必填)' : '(可选)';
            const type = def.type || 'any';
            const desc = def.description || '';
            const enumStr = def.enum ? `，可选值: [${def.enum.join(', ')}]` : '';
            return `  - ${name} (${type}) ${req}: ${desc}${enumStr}`;
        }).join('\n');
    }

    _computeHash(toolsList) {
        const names = toolsList
            .map(t => (t.function || t).name || '')
            .sort()
            .join('|');
        // 简单哈希：长度 + 名称拼接的 charCode 求和
        let hash = names.length;
        for (let i = 0; i < names.length; i++) {
            hash = ((hash << 5) - hash + names.charCodeAt(i)) | 0;
        }
        return String(hash);
    }

    _loadCache() {
        try {
            if (fs.existsSync(this._cachePath)) {
                this._cache = JSON.parse(fs.readFileSync(this._cachePath, 'utf8'));
            }
        } catch {
            this._cache = {};
        }
    }

    _saveCache() {
        const toolsCache = {};
        for (const [name, entry] of this._tools) {
            toolsCache[name] = {
                abbreviation: entry.abbreviation,
                category: entry.category,
                examples: entry.examples
            };
        }
        const cache = {
            _hash: this._toolsHash,
            _savedAt: new Date().toISOString(),
            tools: toolsCache
        };
        try {
            fs.writeFileSync(this._cachePath, JSON.stringify(cache, null, 2), 'utf8');
            this._cache = cache;
        } catch {
            // 写入失败不影响运行
        }
    }

    /**
     * 从磁盘缓存恢复缩略词、分类和示例，跳过重新生成
     */
    _restoreFromCache(toolsList) {
        this._tools.clear();
        this._bm25.clear();

        const cached = this._cache.tools;

        for (const toolDef of toolsList) {
            const funcDef = toolDef.function || toolDef;
            const name = funcDef.name;
            if (!name || EXCLUDED_TOOLS.has(name)) continue;

            const description = funcDef.description || '';
            const parameters = funcDef.parameters || funcDef.input_schema || {};
            const hit = cached[name];

            const entry = {
                name,
                abbreviation: hit ? hit.abbreviation : this._generateAbbreviation(name, description),
                category: hit ? hit.category : this._extractCategory(name),
                description,
                definition: toolDef,
                parameters,
                examples: hit ? hit.examples : this._generateExamples(name, description, parameters)
            };

            this._tools.set(name, entry);

            const searchText = this._buildSearchText(name, description, parameters);
            this._bm25.addDocument(name, searchText);
        }
    }
}

module.exports = { ToolRegistry };
