/**
 * 显存需求估算的单元验证
 * 用本机 Ollama 实测到的真实架构参数交叉校验公式。
 * 重点：GQA 模型必须用 head_count_kv 而非 head_count，否则高估约 7 倍。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function load() {
  let src = fs.readFileSync(path.join(__dirname, 'ollama-model-board.html'), 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
  try { new vm.Script(src, { filename: 'b.js' }); }
  catch (e) { console.log('FAIL 语法: ' + e.message); process.exit(1); }
  src = src.replace(/"use strict";[\r\n]+/, '')
    .replace(/\(function\(\)\{[\r\n]+/, '')
    .replace(/\}\)\(\);[\r\n]*$/, '')
    .replace(/if\(document.readyState==='loading'\)[\s\S]*?else boot\(\);/, '')
    .replace(/window\.__board=state;/, 'globalThis.__board=state;')
    .replace(/window\.__api=/, 'globalThis.__api=');
  const mk = () => ({
    style: { setProperty(){} }, children: [], className: '', _h: '', dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    addEventListener(){}, setAttribute(){}, remove(){}, focus(){},
    querySelectorAll: () => [], querySelector: () => null,
    appendChild(c){ this.children.push(c); }
  });
  const root = mk();
  root.querySelector = () => mk(); root.querySelectorAll = () => [];
  const ctx = { console, localStorage: { getItem: () => null, setItem: () => {} },
    location: { protocol: 'http:' }, navigator: {}, performance: { now: () => 0 },
    setTimeout, clearTimeout, fetch: () => {}, TextDecoder, AbortController };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.roots = {};
  ctx.document = { querySelector: () => mk(), querySelectorAll: () => [],
    createElement: () => mk(), addEventListener: () => {}, readyState: 'complete' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.__api;
}

const A = load();
const G = 1073741824;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL ' + m); } };

/* 本机实测的真实架构参数 */
const ARCH = {
  'qwen2.5-coder:7b': { 'general.architecture': 'qwen2', 'qwen2.block_count': 28,
    'qwen2.attention.head_count': 28, 'qwen2.attention.head_count_kv': 4,
    'qwen2.embedding_length': 3584, 'qwen2.context_length': 32768 },
  'gemma-4-31b-crack': { 'general.architecture': 'gemma4', 'gemma4.block_count': 60,
    'gemma4.attention.head_count': 32, 'gemma4.attention.head_count_kv': null,
    'gemma4.attention.key_length': 512, 'gemma4.embedding_length': 5376,
    'gemma4.context_length': 262144 },
  'qwen3-coder-30b': { 'general.architecture': 'qwen3moe', 'qwen3moe.block_count': 48,
    'qwen3moe.attention.head_count': 32, 'qwen3moe.attention.head_count_kv': 4,
    'qwen3moe.attention.key_length': 128, 'qwen3moe.embedding_length': 2048,
    'qwen3moe.context_length': 262144 },
  'gpt-oss:20b': { 'general.architecture': 'gptoss', 'gptoss.block_count': 24,
    'gptoss.attention.head_count': 64, 'gptoss.attention.head_count_kv': 8,
    'gptoss.attention.key_length': 64, 'gptoss.embedding_length': 2880,
    'gptoss.context_length': 131072 },
  'mixtral:8x7b': { 'general.architecture': 'llama', 'llama.block_count': 32,
    'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8,
    'llama.embedding_length': 4096, 'llama.context_length': 32768 },
  'nomic-embed-text': { 'general.architecture': 'nomic-bert', 'bert.block_count': 12,
    'bert.attention.head_count': 12, 'bert.embedding_length': 768,
    'bert.context_length': 8192 }
};
const archOf = k => A.extractArch(ARCH[k]);

console.log('=== 1. KV cache 公式（qwen2.5-coder:7b 真实架构）===');
const a = archOf('qwen2.5-coder:7b');
[[2048, 0.109], [4096, 0.219], [8192, 0.438], [32768, 1.750]].forEach(([ctx, exp]) => {
  const got = A.kvCacheBytes(a, ctx) / G;
  console.log('  ctx=' + String(ctx).padStart(5) + ' -> ' + got.toFixed(3) + ' GiB (预期 ' + exp + ')');
  ok(Math.abs(got - exp) < 0.006, 'ctx=' + ctx + ' 偏差过大');
});

console.log('');
console.log('=== 2. GQA 正确性（关键回归：必须用 kv_heads=4 而非 head_count=28）===');
const wrongArch = Object.assign({}, a);
wrongArch.headCountKV = wrongArch.headCount;   // 故意制造 bug
const right = A.kvCacheBytes(a, 32768), wrong = A.kvCacheBytes(wrongArch, 32768);
console.log('  正确(4 kv heads) = ' + (right / G).toFixed(3) + ' GiB');
console.log('  错误(28 heads)    = ' + (wrong / G).toFixed(3) + ' GiB');
ok(Math.abs(wrong / right - 7) < 0.01, '误用 head_count 恰好高估 7 倍');
ok(right !== wrong, '断言能捕获此 bug');

console.log('');
console.log('=== 3. kv_heads=null 时回退 head_count（gemma-4-31b 实测为 null）===');
const g4 = archOf('gemma-4-31b-crack');
ok(g4.headCountKV === null, 'gemma4 的 headCountKV 确为 null');
ok(g4.keyLength === 512, 'keyLength=512 已提取');
const g4kv = A.kvCacheBytes(g4, 4096);
ok(g4kv != null, '回退后成功计算');
console.log('  gemma4 kv@4096 = ' + (g4kv / G).toFixed(3) + ' GiB');

console.log('');
console.log('=== 4. key_length 优先于 emb/heads 推算（gpt-oss）===');
const go = archOf('gpt-oss:20b');
const viaKeyLength = A.kvCacheBytes(go, 4096);
const viaGuess = 2 * 24 * 8 * Math.floor(2880 / 64) * 4096 * 2;
ok(viaKeyLength !== viaGuess, '必须用 key_length=64 而非 emb/heads=45');
console.log('  key_length 路径 = ' + (viaKeyLength / G).toFixed(3) +
  ' GiB，推算路径会得到 ' + (viaGuess / G).toFixed(3) + ' GiB');

console.log('');
console.log('=== 5. MoE 模型（qwen3moe / gptoss 专家数不影响 KV）===');
const q3 = archOf('qwen3-coder-30b');
ok(q3.expertCount === undefined || q3.expertCount === null, '该条无 expert_count 字段（不影响本测试）');
ok(A.kvCacheBytes(q3, 4096) != null, 'qwen3moe 可计算');
console.log('  qwen3moe kv@4096 = ' + (A.kvCacheBytes(q3, 4096) / G).toFixed(3) + ' GiB');

console.log('');
console.log('=== 6. 缺字段降级 ===');
ok(A.kvCacheBytes(null, 4096) === null, 'arch=null -> null');
ok(A.kvCacheBytes({}, 4096) === null, '空 arch -> null');
ok(A.kvCacheBytes(a, null) === null, 'ctx=null -> null');
ok(A.kvCacheBytes({ blockCount: 4, headCount: 2 }, 4096) === null, '缺 embedding/keyLength -> null');

console.log('');
console.log('=== 7. 嵌入模型不计 KV ===');
const embEst = A.vramEstimate({ size: 274302450, family: 'nomic-bert' },
  { arch: archOf('nomic-embed-text') }, 4096);
ok(embEst.isEmbedding === true, '识别为嵌入模型');
ok(embEst.kv === 0 && embEst.kvAvailable === false, '不计算 KV cache');
console.log('  nomic 估算 ' + (embEst.total / G).toFixed(3) + ' GiB（仅权重+5%开销）');

console.log('');
console.log('=== 8. vramEstimate 构成 ===');
const row = { size: 4683087561, family: 'qwen2' };
const est = A.vramEstimate(row, { arch: a }, 4096);
ok(est.weight === row.size, '权重取 /api/tags 的 size');
ok(est.kv === A.kvCacheBytes(a, 4096), 'KV 正确');
ok(Math.abs(est.overhead - row.size * 0.05) < 1, '5% 运行时开销');
ok(Math.abs(est.total - (row.size + est.kv + est.overhead)) < 1, 'total 构成正确');
ok(est.archKnown === true && est.kvAvailable === true, '标志位正确');
console.log('  权重 ' + (est.weight / G).toFixed(2) + ' + KV ' + (est.kv / G).toFixed(2) +
  ' + 开销 ' + (est.overhead / G).toFixed(2) + ' = ' + (est.total / G).toFixed(2) + ' GiB');

console.log('');
console.log('=== 9. fitLevel 三态（16GB 显卡，阈值 90%）===');
const gpu = { name: 'RTX 4070 Ti SUPER', vramGiB: 16 };
const cases = [
  ['qwen2.5-coder:1.5b', 986062089, 'qwen2', 'qwen2.5-coder:7b', 'comfortable'],
  ['qwen2.5-coder:7b', 4683087561, 'qwen2', 'qwen2.5-coder:7b', 'comfortable'],
  ['gemma3:12b', 8149190253, 'gemma3', null, 'comfortable'],
  ['gpt-oss:20b', 13793441244, 'gptoss', 'gpt-oss:20b', 'comfortable'],
  ['gemma-4-31b-crack', 18687057755, 'gemma4', 'gemma-4-31b-crack', 'overflow'],
  ['mixtral:8x7b', 26443602516, 'llama', 'mixtral:8x7b', 'overflow']
];
cases.forEach(([nm, size, fam, ak, exp]) => {
  const m = ak ? { arch: archOf(ak) } : {};
  const e = A.vramEstimate({ size, family: fam }, m, 4096);
  const lv = A.fitLevel(e, gpu);
  const pctv = (e.total / (16 * G) * 100).toFixed(0);
  console.log('  ' + nm.padEnd(24) + (e.total / G).toFixed(2) + ' GiB  占 ' +
    pctv.padStart(3) + '%  -> ' + lv + (lv === exp ? '' : '  (预期 ' + exp + ')'));
  ok(lv === exp, nm + ' 适配判断应为 ' + exp + ' 实为 ' + lv);
});
ok(A.fitLevel(est, null) === 'unknown', '未配置显卡 -> unknown');
ok(A.fitLevel(est, {}) === 'unknown', 'vramGiB 为空 -> unknown');
ok(A.fitLevel(est, { vramGiB: 0 }) === 'unknown', '0 显存视为未配置');
// 补 tight 分支覆盖：构造一个 91% 的场景
const tightEst = { total: 16 * G * 0.95 };
ok(A.fitLevel(tightEst, gpu) === 'tight', '占 95% -> tight（余量不足 10%）');
ok(A.fitLevel({ total: 16 * G * 0.90 }, gpu) === 'comfortable', '正好 90% 仍算充裕');
ok(A.fitLevel({ total: 16 * G * 1.01 }, gpu) === 'overflow', '超过 100% -> overflow');

console.log('');
console.log('=== 10. vramSeries 单调递增 ===');
const s = A.vramSeries(row, { arch: a });
ok(s.length === 7, '7 个档位');
ok(s.every((x, i) => i === 0 || s[i - 1].total <= x.total), '随上下文单调递增');
console.log('  ' + s.map(x => x.ctx / 1024 + 'K:' + (x.total / G).toFixed(1)).join('  '));

console.log('');
console.log('=== 11. fitMeta 四态标签 ===');
const fm = A.fitMeta();
['unknown', 'comfortable', 'tight', 'overflow'].forEach(k =>
  ok(!!fm[k] && !!fm[k].label, k + ' 有标签：' + (fm[k] && fm[k].label)));

console.log('');
console.log('=== 12. 全部真实模型均可估算 ===');
const SIZES = {
  'gemma-4-31b-crack': 18687057755, 'gemma4:26b': 17987581215,
  'qwen2.5-coder:7b': 4683087561, 'nomic-embed-text': 274302450,
  'qwen2.5-coder:1.5b': 986062089, 'qwen3-coder-30b': 18556689840,
  'deepseek-coder-v2': 8905126121, 'mixtral:8x7b': 26443602516,
  'gpt-oss:20b': 13793441244, 'gemma3:12b': 8149190253,
  'deepseek-r1:14b': 8988112209
};
Object.keys(SIZES).forEach(nm => {
  const e = A.vramEstimate({ size: SIZES[nm], family: 'x' },
    { arch: archOf(nm) || {} }, 4096);
  ok(e && e.total > 0, nm + ' 可估算');
});

console.log('');
console.log(fail === 0 ? '全部通过（' + pass + ' 项断言，0 失败）' : ('通过 ' + pass + ' / 失败 ' + fail));
process.exit(fail ? 1 : 0);
