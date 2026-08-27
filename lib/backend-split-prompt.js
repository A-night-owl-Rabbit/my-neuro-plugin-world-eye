/**
 * 根据世界之眼当回合折叠清单，生成肥牛主模型看到的「世界之眼 vs Codex」分工提示。
 * 只吃传入的行，不读磁盘、不读 plugin_config。
 */
function buildFeiniuBackendSplitPrompt(foldedLines = []) {
    const lines = Array.isArray(foldedLines)
        ? foldedLines.map(line => String(line || '').trim()).filter(Boolean)
        : [];
    const listBody = lines.length > 0
        ? lines.join('\n')
        : '（当前没有代理插件，电脑任务一律走 Codex）';
    return [
        '[世界之眼与 Codex 分工]',
        '你在「世界之眼」和「Codex」这两个电脑任务后端之间，只能按下面这份清单选择。',
        '',
        '当前世界之眼清单（只有这些能力走世界之眼；每行是极简缩写，完整工具签名以 world_eye_inspect 为准）：',
        listBody,
        '',
        '硬规则：',
        '1. 主人要做的事，能被上面某一行的能力覆盖 → 只用 world_eye_goal / world_eye_delegate / world_eye_research，不要用 codex_delegate。',
        '2. 不能被任何一行覆盖 → 用 codex_delegate。不要把目标丢进 world_eye_goal 碰运气。',
        '3. 给主人在自己屏幕上打开网页、用系统默认浏览器打开 URL、操作系统级命令、清单未写明的桌面操作 → 一律 codex_delegate。受控 Chrome 里的点击/抓取/截图不是这件事。',
        '4. 本规则只管世界之眼 vs Codex。小屋、洛基之影、人格导演等其它主对话工具照旧，不要改成 Codex。'
    ].join('\n');
}

module.exports = { buildFeiniuBackendSplitPrompt };
