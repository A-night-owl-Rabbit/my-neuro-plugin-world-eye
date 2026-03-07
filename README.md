# 世界之眼 (World Eye) 插件

工具搜索与智能路由插件：自动发现所有工具、BM25 检索工具定义、下级智能体委派执行，实现大规模工具库的高效调用。

## 功能

- **工具自动发现**：自动索引所有 server-tools 和 MCP 工具，其他插件工具直接透传给主 LLM
- **BM25 + 关键词混合搜索**：支持中英文分词，高效检索 90+ 工具
- **两级智能体架构**：主 LLM 负责搜索决策，下级智能体（独立 LLM 调用）负责实际工具执行
- **人工审定缩略词**：所有工具的缩略词经人工审定，持久化到磁盘缓存
- **使用示例自动生成**：根据工具定义自动生成调用示例，辅助下级智能体精确执行
- **最近使用缓存**：重复调用同一工具时跳过搜索步骤，直接委派执行
- **Token 大幅节省**：90+ 个工具定义压缩为 2 个元工具 + 缩略词概览

## 工作流程

```
用户输入
  → onLLMRequest 拦截（90个工具 → 2个元工具 + 插件透传工具）
  → 主LLM 看到缩略词概览，判断需要什么工具
  → 调用 world_eye_search("关键词")
  → BM25 返回候选工具列表（含名称、功能、参数定义，不含使用示例）
  → 主LLM 自主决策选择合适的工具
  → 调用 world_eye_execute(tool_name, task_description)
  → 下级智能体收到: 任务要求 + 完整工具定义 + 使用示例
  → 下级智能体生成 tool_calls → 实际执行工具
  → 结果回传 → 主LLM 生成最终回复
```

## 安装

### 1. 复制插件文件

将整个目录复制到 `live-2d/plugins/community/world-eye/`：

```
live-2d/plugins/community/world-eye/
├── metadata.json
├── index.js
├── tool-registry.js
├── bm25-search.js
├── sub-agent.js
├── abbreviations.js
├── plugin_config.json
├── config.example.json
├── generate_cache.js
├── show_cache.js
├── .gitignore
└── test_*.js
```

### 2. 替换 llm-handler.js（必须）

本插件需要修改主项目的 `llm-handler.js` 才能正常工作。仓库中的 `patches/llm-handler.js` 是修改后的完整文件。

将 `patches/llm-handler.js` 复制并覆盖到：

```
live-2d/js/ai/llm-handler.js
```

> **核心改动**：在工具调用循环中，每次迭代从原始完整工具列表重新开始，确保 World Eye 的 `onLLMRequest` 钩子每次都能正确接收到全部工具进行分流。

## 配置

### 方式一：通过 UI 配置（推荐）

插件使用标准的 `plugin_config.json`，在肥牛.exe 的插件管理页面中点击「配置」按钮即可编辑所有配置项。

### 方式二：手动编辑

首次启动会自动从 `config.example.json` 创建 `plugin_config.json`。

手动编辑 `plugin_config.json`：

```json
{
  "enabled": true,
  "search_top_k": 5,
  "sub_agent": {
    "use_separate_model": true,
    "api_key": "你的API Key",
    "api_url": "https://api.siliconflow.cn/v1",
    "model": "deepseek-ai/DeepSeek-V3.2",
    "max_iterations": 5,
    "temperature": 0.3
  },
  "cache_ttl_seconds": 300
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| enabled | boolean | true | 是否启用插件 |
| search_top_k | number | 5 | 搜索返回候选工具数量 |
| sub_agent.use_separate_model | boolean | false | 是否为下级智能体使用独立模型 |
| sub_agent.api_key | string | "" | 下级智能体 API Key |
| sub_agent.api_url | string | "" | 下级智能体 API 地址 |
| sub_agent.model | string | "" | 下级智能体模型名称 |
| sub_agent.max_iterations | number | 5 | 下级智能体最大工具调用轮次 |
| sub_agent.temperature | number | 0.3 | 下级智能体生成温度 |
| cache_ttl_seconds | number | 300 | 最近使用工具的缓存过期时间（秒） |

当 `use_separate_model` 为 `false` 时，下级智能体复用主应用的 LLM 配置。

## 提供的元工具（2 个）

| 工具名 | 功能 |
|--------|------|
| world_eye_search | 根据功能描述关键词搜索匹配的工具，返回候选工具的名称、功能说明和参数定义 |
| world_eye_execute | 委派下级智能体执行指定工具，需提供工具名和具体任务描述 |

## 工具管理范围

- **世界之眼管理**：server-tools、MCP 工具（通过 BM25 索引检索）
- **直接透传**：其他插件提供的工具（如 AstrBook 论坛插件的 25 个工具直接暴露给主 LLM）

## 缩略词

所有工具的缩略词保存在 `abbreviations.js` 中，经人工审定。运行时缩略词、分类和使用示例持久化到 `tool_cache.json`（自动生成，已加入 `.gitignore`）。

## 辅助脚本

| 脚本 | 功能 |
|------|------|
| `generate_cache.js` | 扫描 server-tools 和插件，生成完整的 tool_cache.json |
| `show_cache.js` | 显示 tool_cache.json 的内容摘要 |

## 测试

```bash
node test_e2e.js        # 端到端测试：查询当前时间
node test_cache.js      # 缓存持久化测试
node test_goodnight.js  # 场景测试：用户说晚安
```

## 架构说明

### 两级智能体

1. **主 LLM（对话模型）**：看到工具缩略词概览，负责搜索和决策，选择合适的工具
2. **下级智能体（SubAgent）**：收到完整的工具定义和使用示例，负责精确的工具调用

### 搜索引擎

使用 BM25 + 关键词混合搜索，支持：
- CJK 字符逐字切分
- 英文按空白/标点切分
- 停用词过滤（中英文）
- 精确匹配加分

### llm-handler.js 修改详情

`patches/llm-handler.js` 中的核心改动（相对于原版 my-neuro-main）：

```javascript
// 原版：
const allTools = getMergedToolsList();

// 修改后：
const originalAllTools = getMergedToolsList();
let allTools = originalAllTools;

while (iteration < maxIterations) {
    // 每次迭代从原始列表重新开始
    allTools = [...originalAllTools];
    if (global.pluginManager) {
        const hookRequest = { messages: messagesForAPI, tools: allTools };
        await global.pluginManager.runLLMRequestHooks(hookRequest).catch(() => {});
        allTools = hookRequest.tools; // 采用插件修改后的工具列表
    }
    // ...
}
```

这确保了：
1. World Eye 的 `onLLMRequest` 每次都收到**完整的原始工具列表**
2. 插件能正确将 server-tools/MCP 工具替换为元工具，同时透传其他插件工具
3. 连续工具调用时不会因上轮替换而丢失工具定义

## 许可

MIT