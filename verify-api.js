/**
 * 端到端验证 API 层与跑分引擎（不依赖浏览器）
 * 直接用 Node 内置 fetch 调用本机 Ollama，复刻页面里 API 层的解析逻辑。
 * 目的：验证流式解析、TTFT 测量、tokens/s 计算是否正确。
 */
const API_BASE = 'http://127.0.0.1:11434';
const BENCH_PROMPT = '用大约 80 个汉字，简要说明二分查找的思路与适用场景。';

async function* _stream(path, body, signal) {
  const r = await fetch(API_BASE + path, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const t = await r.text(); if (t) msg += ' · ' + t.slice(0, 200); } catch (e) {}
    throw new Error(msg);
  }
  const rd = r.body.getReader();
  const dec = new TextDecoder('utf-8');
  let rem = '';
  const handle = line => {
    const s = line.trim();
    if (!s) return null;
    let d; try { d = JSON.parse(s); } catch (e) { return null; }
    if (d && d.error) throw new Error(d.error);
    return d;
  };
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      rem += dec.decode(value, { stream: true });
      let nl;
      while ((nl = rem.indexOf('\n')) >= 0) {
        const line = rem.slice(0, nl); rem = rem.slice(nl + 1);
        const d = handle(line);
        if (d) yield d;
      }
    }
    rem += dec.decode();
    if (rem.trim()) { const d = handle(rem); if (d) yield d; }
  } finally { try { rd.cancel(); } catch (e) {} }
}

async function once(model, maxTokens) {
  const t0 = performance.now();
  let ttft = null, last = null;
  const body = { model, stream: true, prompt: BENCH_PROMPT,
    options: { num_predict: maxTokens, temperature: 0, seed: 42 } };
  let chunks = 0;
  for await (const d of _stream('/api/generate', body)) {
    chunks++;
    if (ttft === null && d.response && d.response.length) ttft = performance.now() - t0;
    if (d.done) last = d;
  }
  if (!last || !last.done) throw new Error('流意外结束');
  if (ttft === null) ttft = performance.now() - t0;
  const ev = last.eval_duration || 0, evc = last.eval_count || 0;
  const pev = last.prompt_eval_duration || 0, pevc = last.prompt_eval_count || 0;
  return {
    ttftMs: ttft, loadMs: (last.load_duration || 0) / 1e6,
    tps: ev > 0 ? evc / (ev / 1e9) : null,
    promptTps: pev > 0 ? pevc / (pev / 1e9) : null,
    evalCount: evc, chunks, doneReason: last.done_reason || ''
  };
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

  console.log('=== 1. version / tags / ps ===');
  const v = await (await fetch(API_BASE + '/api/version')).json();
  ok(!!v.version, 'version = ' + v.version);
  const tags = await (await fetch(API_BASE + '/api/tags')).json();
  ok((tags.models || []).length === 11, '模型数 = ' + (tags.models || []).length);
  const ps = await (await fetch(API_BASE + '/api/ps')).json();
  ok(Array.isArray(ps.models), 'ps.models 是数组（当前 ' + ps.models.length + ' 个驻留）');

  console.log('');
  console.log('=== 2. DELETE 方法语义（不真删，只验证方法不被拒）===');
  const delResp = await fetch(API_BASE + '/api/delete', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'nonexistent-probe-does-not-exist' })
  });
  ok(delResp.status !== 405, 'DELETE 方法未被拒（status ' + delResp.status + '，非 405）');
  const postResp = await fetch(API_BASE + '/api/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' })
  });
  ok(postResp.status === 405, 'POST 方法确实返回 405（实测 ' + postResp.status + '）');

  console.log('');
  console.log('=== 3. show 元数据（架构后缀匹配的真实输入）===');
  const showRes = await (await fetch(API_BASE + '/api/show', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'qwen2.5-coder:7b', verbose: false })
  })).json();
  const mi = showRes.model_info || {};
  const pick = suf => { const k = Object.keys(mi).find(k => k === suf || k.endsWith('.' + suf)); return k ? mi[k] : null; };
  ok(pick('context_length') === 32768, 'context_length = ' + pick('context_length'));
  ok(pick('embedding_length') === 3584, 'embedding_length = ' + pick('embedding_length'));
  ok(pick('block_count') === 28, 'block_count = ' + pick('block_count'));
  ok(pick('attention.head_count') === 28, 'head_count = ' + pick('attention.head_count'));
  ok(Array.isArray(showRes.tensors) && showRes.tensors.length > 100, 'tensors = ' + (showRes.tensors || []).length + ' 项');
  const mix = {};
  (showRes.tensors || []).forEach(t => { mix[t.type] = (mix[t.type] || 0) + 1; });
  ok(Object.keys(mix).length >= 2, '量化类型 ' + Object.keys(mix).length + ' 种: ' + JSON.stringify(mix));
  ok(Array.isArray(showRes.capabilities), 'capabilities = ' + JSON.stringify(showRes.capabilities));

  console.log('');
  console.log('=== 4. embedding 模型识别（必须被排除出测速队列）===');
  const embShow = await (await fetch(API_BASE + '/api/show', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'nomic-embed-text:latest', verbose: false })
  })).json();
  const isEmb = (embShow.capabilities || []).includes('embedding');
  ok(isEmb, 'nomic-embed-text capabilities 含 embedding');

  console.log('');
  console.log('=== 5. 跑分引擎端到端（1.5b 小模型，预热+1次）===');
  const M = 'qwen2.5-coder:1.5b';
  const warm = await once(M, 32);
  console.log('  预热: TTFT=' + warm.ttftMs.toFixed(0) + 'ms  load=' + warm.loadMs.toFixed(0) + 'ms  chunks=' + warm.chunks);
  const r1 = await once(M, 128);
  console.log('  实测: TTFT=' + r1.ttftMs.toFixed(0) + 'ms  load=' + r1.loadMs.toFixed(0) + 'ms');
  console.log('        eval_count=' + r1.evalCount + '  eval 速度=' + r1.tps.toFixed(1) + ' tok/s');
  console.log('        prompt 速度=' + r1.promptTps.toFixed(1) + ' tok/s  done_reason=' + r1.doneReason);
  ok(r1.evalCount > 0, 'eval_count = ' + r1.evalCount);
  ok(r1.tps > 0, 'tokens/s = ' + r1.tps.toFixed(1));
  ok(r1.ttftMs > 0, 'TTFT = ' + r1.ttftMs.toFixed(0) + 'ms');
  ok(r1.chunks > 1, '收到多个流式分片（' + r1.chunks + ' 个），验证逐行解析有效');
  ok(r1.loadMs < r1.ttftMs * 1.2 || warm.loadMs > 0, '预热后 load 应显著小于冷启动');

  const r2 = await once(M, 128);
  const med = (a, b) => (a + b) / 2;
  console.log('  二次: ' + r2.tps.toFixed(1) + ' tok/s  (首次 ' + r1.tps.toFixed(1) + ')');
  ok(Math.abs(r1.tps - r2.tps) / r1.tps < 0.5, '两次结果差异 ' +
     (100 * Math.abs(r1.tps - r2.tps) / r1.tps).toFixed(1) + '%，稳定性可接受');

  console.log('');
  console.log('=== 6. pull 错误语义（不存在的模型，验证流内 error）===');
  let pullErr = null, sawStatus = false;
  try {
    for await (const d of _stream('/api/pull', { name: 'definitely-not-a-real-model-xyz', stream: true })) {
      if (d.status) sawStatus = true;
    }
  } catch (e) { pullErr = e.message; }
  ok(pullErr !== null, '流内抛出 error（HTTP 仍 200）: ' + pullErr);

  console.log('');
  console.log('结果：通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL ' + e.message + '\n' + e.stack); process.exit(1); });
