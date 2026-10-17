/**
 * 渲染验证：用真实 Ollama 数据驱动页面的渲染函数，检查输出的 HTML
 * 不需要浏览器，只做 DOM 生成的正确性检查。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function loadPage() {
  const src = fs.readFileSync(__dirname + '/ollama-model-board.html', 'utf8')
    .match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/"use strict";[\r\n]+/, '')
    .replace(/\(function\(\)\{[\r\n]+/, '')
    .replace(/\}\)\(\);[\r\n]*$/, '')
    .replace(/if\(document.readyState==='loading'\)[\s\S]*?else boot\(\);/, '')
    .replace(/window\.__board=state;/, 'globalThis.__board=state;')
    .replace(/window\.__api=/, 'globalThis.__api=')
    .replace(/\}\)\(\);[\r\n]*$/, '');
  const mk = () => {
    const n = { style: { setProperty(){}, removeProperty(){} }, children: [], title: '',
      className: '', _h: '', dataset: {},
      classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
      addEventListener(){}, setAttribute(){}, remove(){}, focus(){},
      querySelectorAll: () => [], querySelector: () => null,
      appendChild(c){ n.children.push(c); } };
    Object.defineProperty(n, 'innerHTML', { get(){return n._h;}, set(v){n._h=v;} });
    Object.defineProperty(n, 'textContent', { get(){return n._h;}, set(v){n._h=v;} });
    return n;
  };
  const root = mk();
  const roots = {};
  root.querySelector = s => (roots[s] || (roots[s] = mk()));
  root.querySelectorAll = () => [];
  const ctx = { console, localStorage: { getItem: () => null, setItem: () => {} },
    location: { protocol: 'http:' }, navigator: {}, performance: { now: () => 0 },
    setTimeout, clearTimeout, fetch: () => {}, TextDecoder, AbortController };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.roots = roots;
  ctx.document = { querySelector: s => root.querySelector(s), querySelectorAll: () => [],
    createElement: () => mk(), addEventListener: () => {}, readyState: 'complete' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  ctx.__view=ctx.__view||{};
  return { ctx, roots };
}
/** 收集节点的完整输出：title + innerHTML + className + 子节点递归 */
const dump = n => {
  let h = (n.title || '') + (n._h || '') +
    (n.className ? ' class="' + n.className + '"' : '');
  (n.children || []).forEach(c => h += dump(c));
  return h;
};

(async () => {
  const tags = await (await fetch('http://127.0.0.1:11434/api/tags')).json();
  const { ctx } = loadPage();
  const V = ctx.__view || {};
  const roots = ctx.roots;
  const st = ctx.__board, A = ctx.__api;
  st.models = (tags.models || []).map(t => A.normalize(t, {}));
  st.totalSize = st.models.reduce((a, m) => a + m.size, 0);
  st.status = 'ready'; st.version = '0.20.0';
  const rows = A.sel.rows();
  let fail = 0;
  const ok = (c, m) => { if (!c) { fail++; console.log('  FAIL ' + m); } else console.log('  OK   ' + m); };

  console.log('=== 1. 表格 11 行 ===');
  let issues = 0;
  for (const m of rows) {
    const h = dump(ctx.rowTr(m));
    if (!/data-open=/.test(h) || /undefined|NaN|\[object Object\]/.test(h) ||
        !/data-bench=/.test(h) || !/data-del=/.test(h) || />[^<]* GB[<\s]/.test(h)) {
      issues++; console.log('  ! ' + m.name);
    }
  }
  ok(issues === 0, '11 行结构完整（可点开/有操作按钮/无 undefined）');

  console.log('');
  console.log('=== 2. 卡片视图 ===');
  st.ui.view = 'card';
  ctx.renderCards(rows);
  const ch = dump(ctx.roots['#viewCard']);
  ok(ch.indexOf('data-open=') >= 0, '卡片含 data-open');
  ok(/undefined|NaN|\[object Object\]/.test(ch) === false, '卡片无 undefined/NaN');
  ok(ch.indexOf('官方 benchmark') >= 0 && ch.indexOf('本机实测') >= 0, '卡片含双列分区标题');
  const chk = (ctx.roots['#viewCard'].children || []).filter(c => c.className === 'mc').length;
  ok(chk === 11, '生成 11 张卡片（实际 ' + chk + '）');

  console.log('');
  console.log('=== 3. 详情抽屉：gpt-oss-20b（MoE + thinking）===');
  const moe = st.models.find(m => m.basename === 'gpt-oss');
  st.meta[moe.name] = { loading: false, error: null, caps: ['completion', 'tools', 'thinking'],
    arch: A.extractArch({ 'general.architecture': 'gptoss', 'gptoss.expert_count': 32,
      'gptoss.expert_used_count': 4, 'gptoss.context_length': 131072,
      'gptoss.block_count': 24, 'gptoss.embedding_length': 2880 }),
    license: 'Apache 2.0', tensorCount: 241,
    quantMix: A.quantMix([{ type: 'MXFP4' }, { type: 'MXFP4' }, { type: 'F32' }]), raw: {} };
  const mh = ctx.drawerShell(moe);
  ok(/undefined|NaN|\[object Object\]/.test(mh) === false, '抽屉无 undefined/NaN');
  ok(mh.indexOf('深度思考') >= 0, 'thinking 能力显示为「深度思考」');
  ok(mh.indexOf('专家数') >= 0 && mh.indexOf('32') >= 0, 'MoE 专家数 32 正确显示');
  ok(mh.indexOf('激活 4') >= 0, '激活专家数 4 正确显示');
  ok(mh.indexOf('131,072') >= 0 || mh.indexOf('131072') >= 0, '上下文 131072 正确显示');
  ok(mh.indexOf('MMLU') >= 0 && mh.indexOf('85.3') >= 0, 'benchmark 表含 MMLU 85.3');
  ok(mh.indexOf('GPQA') >= 0 && mh.indexOf('71.5') >= 0, 'benchmark 表含 GPQA 71.5');
  ok(mh.indexOf('未公布') >= 0, '缺失项显示「未公布」而非 0');
  ok(mh.indexOf('openai.com') >= 0 || mh.indexOf('deploymentsafety') >= 0, '标注来源链接');
  ok(mh.indexOf('MXFP4') >= 0, '量化分布含 MXFP4');

  console.log('');
  console.log('=== 4. 详情抽屉：未核实模型（qwen3-coder-30b）===');
  const un = st.models.find(m => m.basename === 'qwen3-coder-30b');
  const uh = ctx.drawerShell(un);
  ok(/未收录|数据待核|数值待核/.test(uh), '未核实模型有明确提示');
  ok(uh.indexOf('33.3') < 0 && uh.indexOf('87.3') < 0, '未采用第三方来源的分数');

  console.log('');
  console.log('=== 5. 详情抽屉：nomic-embed-text（嵌入模型）===');
  const em = st.models.find(m => m.basename === 'nomic-embed-text');
  st.meta[em.name] = { loading: false, error: null, caps: ['embedding'],
    arch: A.extractArch({ 'general.architecture': 'nomic-bert', 'bert.context_length': 8192,
      'bert.embedding_length': 768, 'bert.block_count': 12 }),
    license: 'Apache 2.0', tensorCount: 196, quantMix: A.quantMix([{type:'F16'},{type:'F16'}]), raw: {} };
  const eh = ctx.drawerShell(em);
  ok(eh.indexOf('嵌入能力') >= 0 || eh.indexOf('向量维度') >= 0, '显示嵌入维度 768');
  ok(eh.indexOf('768') >= 0, '维度数值正确');
  ok(eh.indexOf('不参评') >= 0, '明确说明不参评生成类 benchmark');
  ok(eh.indexOf('62.28') >= 0, 'MTEB 62.28 正确显示');

  console.log('');
  console.log('=== 6. 口径说明是否如实展示 ===');
  const ds = st.models.find(m => m.basename === 'deepseek-r1');
  const dh = ctx.drawerShell(ds);
  ok(dh.indexOf('蒸馏') >= 0, 'DeepSeek-R1 标注为蒸馏版');
  ok(dh.indexOf('MATH-500') >= 0, '说明区分 MATH-500 与 MATH');
  const cs = st.models.find(m => m.basename === 'deepseek-coder-v2');
  const chh = ctx.drawerShell(cs);
  ok(chh.indexOf('Lite') >= 0, 'DeepSeek-Coder-V2 标注为 Lite 16B');
  ok(chh.indexOf('MBPP+') >= 0, '说明 MBPP 与 MBPP+ 口径差异');

  console.log('');
  console.log('=== 8. 元数据缺失时的降级 ===');
  const fail2 = st.models.find(m => m.basename === 'gemma-4-31b-crack');
  st.meta[fail2.name] = { loading: false, error: '模拟读取失败' };
  const fh = ctx.drawerShell(fail2);
  ok(fh.indexOf('元数据读取失败') >= 0, 'show 失败时显示错误而非崩溃');
  ok(fh.indexOf('重试') >= 0, '提供重试入口');
  ok(/undefined|NaN/.test(fh) === false, '失败态无 undefined');
  delete st.meta[fail2.name];
  st.meta[fail2.name] = { loading: true };
  const lh = ctx.drawerShell(fail2);
  ok(lh.indexOf('sk') >= 0 || lh.indexOf('加载') >= 0 || lh.indexOf('展开后') >= 0, '加载中显示骨架/占位');

  // ============================================================
  // 9. 显存需求 UI
  // ============================================================
  console.log('');
  console.log('=== 9. 显存列与分组带 ===');
  st.gpu = { name: 'RTX 4070 Ti SUPER', vramGiB: 16 };
  const META = {
    'qwen2.5-coder': { caps:['completion','tools','insert'],
      arch:A.extractArch({'general.architecture':'qwen2','qwen2.block_count':28,
        'qwen2.attention.head_count':28,'qwen2.attention.head_count_kv':4,
        'qwen2.embedding_length':3584,'qwen2.context_length':32768}) },
    'gemma-4-31b-crack': { caps:['completion'],
      arch:A.extractArch({'general.architecture':'gemma4','gemma4.block_count':60,
        'gemma4.attention.head_count':32,'gemma4.attention.key_length':512,
        'gemma4.embedding_length':5376,'gemma4.context_length':262144}) },
    'gpt-oss': { caps:['completion','tools','thinking'],
      arch:A.extractArch({'general.architecture':'gptoss','gptoss.block_count':24,
        'gptoss.attention.head_count':64,'gptoss.attention.head_count_kv':8,
        'gptoss.attention.key_length':64,'gptoss.embedding_length':2880,
        'gptoss.context_length':131072}) },
    'mixtral': { caps:['completion'],
      arch:A.extractArch({'general.architecture':'llama','llama.block_count':32,
        'llama.attention.head_count':32,'llama.attention.head_count_kv':8,
        'llama.embedding_length':4096,'llama.context_length':32768}) },
    'nomic-embed-text': { caps:['embedding'],
      arch:A.extractArch({'general.architecture':'nomic-bert','bert.block_count':12,
        'bert.attention.head_count':12,'bert.embedding_length':768,
        'bert.context_length':8192}) }
  };
  Object.keys(META).forEach(k=>{
    st.models.filter(m=>m.basename===k).forEach(m=>{ st.meta[m.name]=META[k]; });
  });

  const vrow = st.models.find(m=>m.basename==='qwen2.5-coder'&&m.paramB===7.6);
  const vtd = dump(V.vramTd(vrow));
  ok(vtd.indexOf('class="vr') >= 0, '显存列使用 .vr 样式');
  ok(/4\.\d\d GiB/.test(vtd), '主值显示合计需求（含 GiB 单位）');
  ok(vtd.indexOf('权重') >= 0, '副标含权重构成');
  ok(vtd.indexOf('KV') >= 0, '副标含 KV cache');
  ok(vtd.indexOf('理论估算') >= 0 || vtd.indexOf('以实测为准') >= 0,
     'tooltip 明确标注为理论估算');
  ok(vtd.indexOf('undefined') < 0, '显存列无 undefined');

  const ftd = dump(V.fitTd(vrow));
  ok(/class="fit ok"/.test(ftd), '4.8GiB/16GB -> fit ok（充裕）');
  ok(ftd.indexOf('RTX 4070 Ti SUPER') >= 0, 'tooltip 含显卡型号');

  const gpt = st.models.find(m=>m.basename==='gpt-oss');
  const gft = dump(V.fitTd(gpt));
  // 13.68/16 = 85.5% < 90% 阈值 -> comfortable
  ok(/class="fit ok"/.test(gft), 'gpt-oss 13.7GiB/16GB = 85.5% -> fit ok（充裕）');
  const mix = st.models.find(m=>m.basename==='mixtral');
  const mft = dump(V.fitTd(mix));
  ok(/class="fit dgr"/.test(mft), '26.4GiB/16GB -> fit dgr（溢出）');
  ok(mft.indexOf('超出') >= 0, '溢出时说明超出量');

  // 未配置显卡（fit 徽章在子节点上，用 dump 递归取）
  st.gpu = { name:'', vramGiB:null };
  const unk = dump(V.fitTd(vrow));
  ok(/class="fit none"/.test(unk), '未配置显卡 -> fit none（灰态）');
  ok(unk.indexOf('尚未配置') >= 0, '提示去设置显卡');
  st.gpu = { name:'RTX 4070 Ti SUPER', vramGiB:16 };

  console.log('');
  console.log('=== 10. 抽屉显存分区 ===');
  const vd = ctx.drawerShell(vrow);
  ok(vd.indexOf('显存占用') >= 0, '含「显存占用」分区');
  ok(vd.indexOf('权重占用') >= 0, '含权重明细');
  ok(vd.indexOf('KV cache') >= 0, '含 KV cache 明细');
  ok(vd.indexOf('运行时开销') >= 0, '含运行时开销');
  ok(vd.indexOf('合计需求') >= 0, '含合计需求');
  ok(vd.indexOf('适配判断') >= 0, '含适配判断');
  ok(vd.indexOf('上下文影响') >= 0, '含上下文影响可视化');
  ok(vd.indexOf('线性增长') >= 0, '说明 KV 随上下文线性增长');
  ok(vd.indexOf('ctxbars') >= 0, '上下文条形图已渲染');
  ok(/class="vrcomp/.test(vd), '构成条已渲染');
  ok(vd.indexOf('来自 /api/tags') >= 0, '权重标注了数据来源');
  ok(/undefined|NaN|\[object/.test(vd) === false, '显存分区无 undefined/NaN');

  // 溢出提示
  const md = ctx.drawerShell(mix);
  ok(md.indexOf('回落至系统内存') >= 0, '溢出时说明回落后果');
  ok(md.indexOf('显著下降') >= 0, '溢出时说明性能影响');

  // 嵌入模型
  const emb = st.models.find(m=>m.basename==='nomic-embed-text');
  const ed = ctx.drawerShell(emb);
  ok(ed.indexOf('不适用') >= 0, '嵌入模型 KV cache 标为不适用');
  ok(ed.indexOf('仅含编码器') >= 0, '说明嵌入模型仅含编码器');
  ok(ed.indexOf('上下文影响') < 0, '嵌入模型不显示上下文影响图');

  // 元数据未载入
  const nom = st.models.find(m=>m.basename==='gemma3');
  const nd = ctx.drawerShell(nom);
  ok(nd.indexOf('模型元数据载入中') >= 0 || nd.indexOf('未提供架构元数据') >= 0,
     '元数据未载入时降级提示');

  console.log('');
  console.log('=== 11. 显存筛选与排序 ===');
  st.ui.fits.add('overflow');
  const of = A.sel.rows();
  ok(of.length>0, '「溢出」筛选有结果：'+of.map(m=>m.basename).join(', '));
  ok(of.every(m=>A.fitLevel(A.vramEstimate(m,st.meta[m.name],A.VRAM_DEFAULT_CTX||4096),st.gpu)==='overflow'),
     '筛选结果全部为溢出');
  st.ui.fits.clear();
  st.ui.sort=[{k:'vram',d:-1}];
  const vs = A.sel.rows();
  const tots=vs.map(m=>A.vramEstimate(m,st.meta[m.name],4096).total);
  ok(tots.every((v,i)=>i===0||tots[i-1]>=v), '按显存需求降序正确');
  console.log('  降序: '+vs.map(m=>m.basename+':'+(tots[vs.indexOf(m)]/1073741824).toFixed(1)).join(' > '));
  st.ui.sort=[{k:'size',d:-1}];

  console.log('');
  console.log('=== 12. 诚实性检查 ===');
  ok(vd.indexOf('显存需求') >= 0 || vd.indexOf('显存占用') >= 0, '列名用「显存」措辞');
  const html = fs.readFileSync(path.join(__dirname,'ollama-model-board.html'),'utf8');
  ok(/显存需求/.test(html), '表头列名为「显存需求」而非「显存占用」');
  ok(/size_vram[\s\S]{0,200}?仅用于|isResident/.test(html), 'size_vram 仅用于驻留判断');
  ok(html.indexOf('K\times 0.05')>=0 || html.indexOf('VRAM_OVERHEAD_RATIO = 0.05')>=0,
     '5% 开销有明确定义');

  console.log('');
  console.log(fail === 0 ? '全部通过（0 失败）' : ('有 ' + fail + ' 项失败'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + e.message + '\n' + e.stack); process.exit(1); });
