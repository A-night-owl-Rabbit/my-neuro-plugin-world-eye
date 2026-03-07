const c = require('./tool_cache.json');
console.log('哈希:', c._hash);
console.log('时间:', c._savedAt);
console.log('工具数:', Object.keys(c.tools).length);
console.log('');
Object.entries(c.tools).forEach(([name, val], i) => {
    console.log(`${String(i + 1).padStart(2)}. [${val.category}] ${name}: ${val.abbreviation}`);
});
