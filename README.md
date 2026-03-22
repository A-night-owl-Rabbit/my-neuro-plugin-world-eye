# 世界之眼 (World Eye) 插件

工具搜索与智能路由插件：自动发现 90+ 工具、BM25 检索、下级智能体委派执行，大幅节省 Token。

## 快速开始

1. 将插件文件夹放入 `live-2d/plugins/community/world-eye/`
2. 在插件配置页面开启「使用独立模型」
3. 填入下级智能体的 **API Key**、**API 地址**和**模型名称**（推荐 DeepSeek V3.2）
4. 启用插件即可，**无需修改主项目任何文件**

## 配置说明

| 配置项 | 说明 |
|--------|------|
| 启用插件 | 是否启用世界之眼工具路由 |
| 搜索返回数量 | 每次搜索返回的候选工具数量，默认 5 |
| 缓存过期时间 | 最近使用的工具缓存时间（秒），缓存期内可跳过搜索 |
| 使用独立模型 | 关闭则复用主应用 LLM，开启则用独立模型做工具调用 |
| API Key | 下级智能体的 API Key |
| API 地址 | 下级智能体的 API 基础地址 |
| 模型名称 | 推荐支持 Function Calling 的模型 |
| 最大调用轮次 | 单次任务最大工具调用轮数，默认 5 |
| 生成温度 | 越低越精确，默认 0.3 |

## 工作原理

- **90+ 工具 → 2 个元工具**：`onLLMRequest` 拦截请求，将所有 server-tools/MCP 工具替换为 `world_eye_search` 和 `world_eye_execute`，其他插件工具直接透传
- **BM25 搜索**：主 LLM 通过关键词搜索工具，看到候选工具的名称、功能和参数
- **下级智能体执行**：主 LLM 决策后委派独立 LLM 调用，下级智能体收到完整定义 + 使用示例
- **缓存机制**：重复调用同一工具时跳过搜索，直接委派执行

## 兼容性

插件通过原地修改 `request.tools` 数组（而非重新赋值）+ 每次从全局管理器获取最新工具列表，兼容原版 `llm-handler.js`，无需替换核心文件。

## 辅助脚本

| 脚本 | 功能 |
|------|------|
| `generate_cache.js` | 扫描 server-tools 和插件，生成 tool_cache.json |
| `show_cache.js` | 显示 tool_cache.json 的内容摘要 |

## 缩略词

所有工具的缩略词保存在 `abbreviations.js` 中，经人工审定。运行时持久化到 `tool_cache.json`（自动生成）。本项目采用 Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0) 许可证。
