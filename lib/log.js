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

module.exports = { logToTerminal };
