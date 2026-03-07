// bm25-search.js - BM25 + 关键词混合搜索引擎（支持中英文）

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'and',
    'but', 'or', 'not', 'no', 'if', 'then', 'else', 'when',
    'up', 'out', 'so', 'than', 'too', 'very', 'just',
    'it', 'its', 'this', 'that', 'these', 'those',
    '的', '了', '在', '是', '我', '有', '和', '就',
    '不', '人', '都', '一', '一个', '上', '也', '很',
    '到', '说', '要', '去', '你', '会', '着', '没有',
    '看', '好', '自己', '这', '他', '她', '它',
]);

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

/**
 * 中英文混合分词：CJK 字符逐字切分，英文/数字按空白和标点切分
 */
function tokenize(text) {
    if (!text) return [];

    const normalized = text.toLowerCase().replace(/[_\-./]/g, ' ');
    const tokens = [];
    let englishBuffer = '';

    for (const char of normalized) {
        if (CJK_RANGE.test(char)) {
            if (englishBuffer.trim()) {
                tokens.push(englishBuffer.trim());
                englishBuffer = '';
            }
            tokens.push(char);
        } else if (/[a-z0-9]/.test(char)) {
            englishBuffer += char;
        } else {
            if (englishBuffer.trim()) {
                tokens.push(englishBuffer.trim());
                englishBuffer = '';
            }
        }
    }
    if (englishBuffer.trim()) {
        tokens.push(englishBuffer.trim());
    }

    return tokens.filter(t => t.length > 0 && !STOP_WORDS.has(t));
}

class BM25Index {
    /**
     * @param {object} options
     * @param {number} [options.k1=1.5] - 词频饱和参数
     * @param {number} [options.b=0.75] - 文档长度归一化参数
     */
    constructor(options = {}) {
        this.k1 = options.k1 || 1.5;
        this.b = options.b || 0.75;

        this.documents = [];      // [{id, tokens, originalText}]
        this.invertedIndex = {};   // term -> Set<docIndex>
        this.docFrequency = {};    // term -> document frequency
        this.docLengths = [];      // document lengths
        this.avgDocLength = 0;
        this.totalDocs = 0;
    }

    /**
     * 添加文档到索引
     * @param {string} id - 文档唯一标识
     * @param {string} text - 文档文本
     */
    addDocument(id, text) {
        const tokens = tokenize(text);
        const docIndex = this.documents.length;

        this.documents.push({ id, tokens, originalText: text });
        this.docLengths.push(tokens.length);
        this.totalDocs++;

        // 统计该文档中每个词的出现次数
        const termCounts = {};
        for (const token of tokens) {
            termCounts[token] = (termCounts[token] || 0) + 1;
        }

        // 更新倒排索引和文档频率
        for (const term of Object.keys(termCounts)) {
            if (!this.invertedIndex[term]) {
                this.invertedIndex[term] = new Set();
                this.docFrequency[term] = 0;
            }
            this.invertedIndex[term].add(docIndex);
            this.docFrequency[term]++;
        }

        // 更新平均文档长度
        const totalLength = this.docLengths.reduce((a, b) => a + b, 0);
        this.avgDocLength = totalLength / this.totalDocs;
    }

    /**
     * 搜索并返回排序后的结果
     * @param {string} query - 搜索查询
     * @param {number} [topK=5] - 返回结果数量
     * @returns {Array<{id: string, score: number}>}
     */
    search(query, topK = 5) {
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        const scores = new Array(this.totalDocs).fill(0);

        for (const term of queryTokens) {
            const matchingDocs = this.invertedIndex[term];
            if (!matchingDocs) continue;

            const df = this.docFrequency[term] || 0;
            // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
            const idf = Math.log((this.totalDocs - df + 0.5) / (df + 0.5) + 1);

            for (const docIndex of matchingDocs) {
                const docTokens = this.documents[docIndex].tokens;
                const docLength = this.docLengths[docIndex];

                // 计算该词在文档中的词频
                let tf = 0;
                for (const t of docTokens) {
                    if (t === term) tf++;
                }

                // BM25 公式
                const numerator = tf * (this.k1 + 1);
                const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / this.avgDocLength));
                scores[docIndex] += idf * (numerator / denominator);
            }
        }

        // 精确匹配加分：查询词在工具名中完全匹配时额外加分
        for (let i = 0; i < this.totalDocs; i++) {
            const docText = this.documents[i].originalText.toLowerCase();
            for (const token of queryTokens) {
                if (docText.includes(token)) {
                    scores[i] += 0.5;
                }
            }
        }

        // 排序并返回 top-k
        const results = [];
        for (let i = 0; i < this.totalDocs; i++) {
            if (scores[i] > 0) {
                results.push({ id: this.documents[i].id, score: scores[i] });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, topK);
    }

    /**
     * 清空索引
     */
    clear() {
        this.documents = [];
        this.invertedIndex = {};
        this.docFrequency = {};
        this.docLengths = [];
        this.avgDocLength = 0;
        this.totalDocs = 0;
    }
}

module.exports = { BM25Index, tokenize };
