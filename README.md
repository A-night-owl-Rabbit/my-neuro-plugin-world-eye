# 世界之眼 (World Eye) 插件

> [my-neuro(肥牛)](https://github.com/morettt/my-neuro) 社区插件发布仓库 · 依赖已内置、开箱即用

**v4** — 任务型多智能体代理路由：对主 AI **瘦身工具列表**，由**下级智能体**按角色调用已勾选代理的插件；支持单步委派、多步目标编排、专题研究与任务队列。

v4 相对 v3 的核心变化：

1. **统一工作人格**：删除了按角色的动漫人格与每步 200-400 字「思考独白」输出，所有分身共用一个「细致、准确、克制」的工作人格，每次调用只输出事实结果本体，速度显著提升。
2. **链路压缩提速**：研究任务按深度分级（quick = 搜索+摘要 2 步；standard = 搜索+审查写报合并 2-4 步；deep = 完整链路 4-8 步）；搜索阶段合并全部搜索插件工具由**单个**子代理首轮并行多引擎调用；协商交接默认关闭；点名委派（有效 plugin_name）直通执行，跳过路由模型。
3. **主模型直连通讯**：任务因信息缺口受阻（名称不明、未登录、前置条件缺失等）时不再直接失败，而是转入 `waiting_input` 状态并**主动推送求助通知给主模型**；主模型优先从对话上下文补齐信息后调用 `world_eye_control(action='answer')` 续跑，只在上下文确实没有线索时才轻量询问用户。等待超时（10 分钟）自动转失败。
4. **缩写认知修复**：主模型看到的插件清单每行都被明确标注为「极简缩写」，能力边界判断必须以 `world_eye_inspect` 结果为准。

**完整功能列表 → [FEATURES.md](./FEATURES.md)**

## 安装教程

**方式一（推荐）：WebUI 插件广场一键安装**

1. 打开 my-neuro 的 WebUI 控制面板 → 「广场」→ 插件广场
2. 找到「world-eye / 世界之眼」，点击安装（已装过则点更新）
3. 重启 Live2D 桌宠

**方式二：手动安装**

1. 点击本页绿色 `Code` 按钮 → `Download ZIP` 下载并解压
2. 把解压出的文件夹改名为 `world-eye`，放入 `my-neuro/live-2d/plugins/community/world-eye/`（确保 `index.js` 直接位于该目录下，而不是再套一层）
3. 重启 Live2D 桌宠，在 WebUI「插件管理」中启用

**启用后的配置步骤**

1. 在插件设置中启用插件，并勾选需要**代理**的社区插件
2. 配置**模型分组**与**角色配置**（模型须支持 Function Calling，API Key 请自行填入，仓库不含任何密钥）
3. 按需配置「任务限制」「安全策略」「世界之眼人格」「协商交接」
4. 保存后重启桌宠生效，一般无需改主项目核心文件

可选：复制 `config.example.json` 为 `config.json` 做本地覆盖（勿将含密钥的 `config.json` 提交到公开仓库）。

## 工作原理（v4 摘要）

- 在 `onLLMRequest` 中从主请求里**移除**已代理插件的原始工具，注入 **`world_eye_goal` / `world_eye_delegate` / `world_eye_research` / `world_eye_inspect` / `world_eye_control`** 五个元工具；未代理插件工具按原样保留。
- 主 AI 调用元工具后，由 **SubAgent** 使用配置的模型对目标插件做**多轮工具调用**直至完成、受阻（waiting_input）、入队或失败。
- 异步任务完成/受阻后通过主对话消息通道自动推送给主 AI；主 AI 用自己的人设转述结果或自主补答续跑。

## 配置默认值提示

- `negotiation.enabled` 默认 **false**（v4 为提速关闭；开启后每次交接追问会多花 2-3 次模型调用）。
- 研究 `output` 默认 **report**（主 AI 会自己转述，通常不需要 `report+persona` 口语化改写档）。

## 依赖说明

**依赖已随仓库内置（`node_modules/` 已打包，含 `node-fetch` 等），下载即用，无需执行 `npm install`。**
如果依赖目录损坏或想重装，在插件目录执行一次 `npm install` 即可恢复。

## 测试

仓库自带单元测试，安装 Node 18+ 后在插件目录执行：

```powershell
node --test tests/system-prompt.test.js tests/backend-split-prompt.test.js tests/research-flow.test.js tests/delegate-direct.test.js tests/waiting-input.test.js tests/meta-tools.test.js
```

## 常见问题

- **启用后主 AI 的工具变少了？** 这是正常现象：被勾选「代理」的插件工具从主模型移除，改由世界之眼的下级智能体调用，主模型只看到五个元工具。
- **提示模型不支持工具调用？** 「模型分组」里配置的模型必须支持 Function Calling（如 DeepSeek V3、GPT-4o、Qwen 系列等）。
- **任务卡在 waiting_input？** 说明子代理缺少信息在等待补充，主 AI 会收到求助通知并自动补答；超过 10 分钟未补齐会自动转失败。

## 兼容性

通过原地改写 `request.tools` 与消息清理逻辑配合现有 LLM 流程；具体行为以 `index.js` 为准。

## 更新日志

- **2026-08-27（v4.0.0）**：统一工作人格（删除逐步独白，大幅提速）；研究链路按 quick/standard/deep 分级压缩；新增主模型直连通讯（`waiting_input` 求助续跑机制）；新增 `lib/backend-split-prompt.js` 后端拆分提示与 `plugin_short_descriptions.json` 极简缩写清单；配置结构重构为 models/roles/limits/security/personality/negotiation 分区；随仓库附带完整单元测试。
- 2026-08-11（v3）：BM25 工具检索与子代理委派版本。

---

## 想邀请你，做这只小牛的“云饲养员”

做这个桌宠的初衷，其实是因为自己一个人工作学习的时候，总觉得屏幕里空落落的。看到大家都在使用，我就觉得熬夜写代码、调教AI的日子都亮闪闪的。🌟

不过，肥牛现在还在长身体（其实是我想给它做更多有趣的插件），养一只数字小牛其实也挺“费草”的哈哈。🌱

如果你在这只小肥牛这里获得过哪怕一秒钟的治愈，或者觉得它算个合格的桌面搭子，要不要考虑成为它的“云饲养员”呀？

你的每一次充电，都不是在打赏我，而是在给这只肥牛注入一点点魔法值。让它能变得更聪明、更通人性、能听懂你更多的碎碎念。

不用有压力哦！你愿意打开它，就是对我最大的鼓励啦。如果刚好有余力，就请肥牛喝瓶快乐水叭，它会记住你的味道的！🥤❤️

爱发电 https://ifdian.net/a/0923A

## 许可证

沿用项目原有**CC BY-NC-ND 4.0**许可；第三方依赖见其各自 `LICENSE` 文件。
