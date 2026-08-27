const fs = require('fs');
const path = require('path');

const RUNTIME_LOG = path.join(__dirname, '..', '..', '..', '..', 'runtime.log');

function logToTerminal(level, message) {
    const formattedMsg = `[${level.toUpperCase()}] ${message}`;

    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }

    try {
        fs.appendFileSync(RUNTIME_LOG, formattedMsg + '\n', 'utf8');
    } catch {
        // 忽略文件写入错误
    }
}

// 工具日志：带 [TOOL] 标记，会被 WebUI 工具日志面板筛出展示
// 行为与 live-2d/js/api-utils.js 的 logToolAction 保持一致
function logToolAction(level, message) {
    const formattedMsg = `[${level.toUpperCase()}][TOOL] ${message}`;

    if (level === 'error') {
        console.error(`[TOOL] ${message}`);
    } else if (level === 'warn') {
        console.warn(`[TOOL] ${message}`);
    } else {
        console.log(`[TOOL] ${message}`);
    }

    try {
        fs.appendFileSync(RUNTIME_LOG, formattedMsg + '\n', 'utf8');
    } catch {
        // 忽略文件写入错误
    }
}

module.exports = { logToTerminal, logToolAction };
