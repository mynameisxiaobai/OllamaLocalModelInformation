/**
 * start-board.bat 静态校验（不执行 bat，只检查文本结构）
 * 逐项检查会导致双击报错的语法陷阱。
 */
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'start-board.bat');
const t = fs.readFileSync(p, 'binary').toString('binary');
const lines = t.split('\r\n');
/** 注释与空行不参与语法检查 */
const code = l => !/^\s*(rem\b|::)/i.test(l) && l.trim() !== '';
let bad = 0;
const ok = c => !c || bad++;

console.log('=== 1. 反斜杠转义残留（本次报错根因）===');
const bs = lines.map((l, i) => [i + 1, l]).filter(([, l]) => code(l) && l.includes('\\"'));
if (bs.length) { bad += bs.length; bs.forEach(([n, l]) => console.log('  第' + n + '行: ' + l.trim())); }
else console.log('  OK  可执行代码中无任何 \\" 转义');

console.log('');
console.log('=== 2. 嵌套 ' + 'cm' + 'd /c ===');
const cc = lines.map((l, i) => [i + 1, l]).filter(([, l]) => code(l) && /\bcmd\s*\/c/i.test(l));
if (cc.length) { bad += cc.length; cc.forEach(([n, l]) => console.log('  第' + n + '行: ' + l.trim())); }
else console.log('  OK  无嵌套调用');

console.log('');
console.log('=== 3. 引号配对（可执行行双引号数须为偶数）===');
let unpaired = 0;
lines.forEach((l, i) => {
  if (!code(l)) return;
  const c = (l.match(/"/g) || []).length;
  if (c % 2 !== 0) { unpaired++; bad++; console.log('  第' + (i + 1) + '行 引号数=' + c + ': ' + l.trim()); }
});
if (!unpaired) console.log('  OK  可执行行引号全部成对');

console.log('');
console.log('=== 4. timeout.exe 依赖 ===');
const to = lines.map((l, i) => [i + 1, l])
  .filter(([, l]) => code(l) && /\btimeout\b/i.test(l));
if (to.length) { bad += to.length; to.forEach(([n, l]) => console.log('  第' + n + '行: ' + l.trim())); }
else console.log('  OK  已改用 ping 延时');

console.log('');
console.log('=== 5. if (...) 括号块（记忆：bat 应避免）===');
const par = lines.map((l, i) => [i + 1, l])
  .filter(([, l]) => code(l) && /^\s*if\s.*\(\s*\)\s*then/i.test(l));
if (par.length) { bad += par.length; par.forEach(([n, l]) => console.log('  第' + n + '行: ' + l.trim())); }
else console.log('  OK  无括号块');

console.log('');
console.log('=== 6. 标签与 goto 完整性 ===');
const labels = lines.filter(l => /^:[a-z]/i.test(l.trim())).map(l => l.trim().slice(1).toLowerCase());
// goto 后的标签名允许下划线，需完整匹配到某个已定义标签
const gotos = [...t.matchAll(/goto\s+([a-z_][a-z_0-9]*)/gi)].map(m => m[1].toLowerCase());
const missing = [...new Set(gotos)].filter(g => !labels.includes(g));
if (missing.length) { bad++; console.log('  FAIL 跳转到不存在的标签: ' + missing.join(', ')); }
else console.log('  OK  标签 [' + labels.join(', ') + '] 全部有定义');
console.log('      goto 目标: ' + [...new Set(gotos)].join(', '));

console.log('');
console.log('=== 7. 端口探测循环 ===');
const loopOk = /:port[\r\n]+[\s\S]*?goto port/i.test(t);
const hasIncr = /set\s+\/a\s+PORT\s*\+=\s*1/i.test(t);
const hasSeed = /set\s+"PORT=5173"/i.test(t);
const hasBound = /if\s+%TRY%\s+GTR\s+20/i.test(t);
ok(!loopOk); ok(!hasIncr); ok(!hasSeed); ok(!hasBound);
console.log('  :port 标签 ' + (loopOk ? 'OK' : '缺失'));
console.log('  PORT 初值 5173 ' + (hasSeed ? 'OK' : '缺失'));
console.log('  PORT 递增 ' + (hasIncr ? 'OK' : '缺失'));
console.log('  循环上限 20 ' + (hasBound ? 'OK' : '缺失'));

console.log('');
console.log('=== 8. 关键行最终形态 ===');
lines.forEach((l, i) => {
  if (/ping -n|start\s+""|http\.server|npx\s|--yes serve/.test(l))
    console.log('  ' + (i + 1) + ': ' + l);
});

console.log('');
console.log('=== 9. 文件格式 ===');
const crlf = (t.match(/\r\n/g) || []).length;
const lf = (t.match(/\n/g) || []).length;
const bareLf = lf - crlf;
let ascii = true;
for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 127) { ascii = false; break; }
if (bareLf !== 0) { bad++; console.log('  FAIL 存在 ' + bareLf + ' 个裸 LF，需全部为 CRLF'); }
else console.log('  CRLF ' + crlf + ' 行，裸 LF 0  OK');
console.log('  纯 ASCII ' + (ascii ? 'OK' : 'FAIL'));
if (!ascii) bad++;
console.log('  大小 ' + fs.statSync(p).size + ' 字节');

console.log('');
console.log(bad === 0 ? '全部检查通过（0 问题）' : ('发现 ' + bad + ' 个问题'));
process.exit(bad ? 1 : 0);
