/**
 * 剥离注释安全性验证：语法通过不足以证明安全（可能改坏正则/字符串而语法仍合法）。
 * 硬判据：在浏览器里逐一比对【每个函数的 toString 去注释后】是否全等，
 * 以及关键数据常量是否逐字节一致。
 * 用法: node verify-strip.js <srcBase> <distBase>
 * 两侧都须是已起好的 HTTP 服务（源码版 / 剥离版各一），file:// 下 fetch API 不可用。
 * 环境可移植：PLAYWRIGHT_PATH 指定 playwright 模块路径（默认尝试 require('playwright')），
 *            EDGE_PATH 指定浏览器可执行文件（默认按平台探测 Edge/Chromium 常见位置）。
 */
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (e) { /* 尝试下一个 */ }
  }
  console.error('找不到 playwright，请设 PLAYWRIGHT_PATH 环境变量指向模块目录');
  process.exit(1);
}
const { chromium } = loadPlaywright();
function findEdge() {
  if (process.env.EDGE_PATH) return process.env.EDGE_PATH;
  const fs = require('fs');
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
       'C:/Program Files/Microsoft/Edge/Application/msedge.exe']
    : ['/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return undefined; // 交给 playwright 自带浏览器
}
const EDGE = findEdge();
const SRC = process.argv[2] || 'http://127.0.0.1:8802';
const DIST = process.argv[3] || 'http://127.0.0.1:8803';

// 去掉注释后再比对函数体（两侧同样处理，抵消注释差异）
const PROBE = () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
  const names = Object.keys(window).filter(k => {
    try { return typeof window[k] === 'function' && window[k].toString().indexOf('[native code]') < 0; }
    catch (e) { return false; }
  });
  const fns = {};
  for (const n of names) {
    try { fns[n] = strip(window[n].toString()).replace(/\s+/g, ' ').trim(); } catch (e) {}
  }
  // 语料是 const 声明，不挂 window —— 必须在页面作用域内直接引用，
  // 否则取到 0 个常量、该项成为空判据（假 PASS）。
  const data = {};
  const grab = (k, v) => { try { if (v !== undefined) data[k] = JSON.stringify(v); } catch (e) {} };
  grab('CORPUS', typeof CORPUS !== 'undefined' ? CORPUS : undefined);
  grab('IELTS_LIBRARY', typeof IELTS_LIBRARY !== 'undefined' ? IELTS_LIBRARY : undefined);
  grab('DAILY_WORDS', typeof DAILY_WORDS !== 'undefined' ? DAILY_WORDS : undefined);
  grab('WORDS', typeof WORDS !== 'undefined' ? WORDS : undefined);
  grab('PHRASES', typeof PHRASES !== 'undefined' ? PHRASES : undefined);
  grab('HOME_SENTENCES', typeof HOME_SENTENCES !== 'undefined' ? HOME_SENTENCES : undefined);
  grab('DAILY_TOPIC_EXTRA', typeof DAILY_TOPIC_EXTRA !== 'undefined' ? DAILY_TOPIC_EXTRA : undefined);
  grab('DAILY_TOPIC_WORDS', typeof DAILY_TOPIC_WORDS !== 'undefined' ? DAILY_TOPIC_WORDS : undefined);
  grab('LIBRARY_CATEGORIES', typeof LIBRARY_CATEGORIES !== 'undefined' ? LIBRARY_CATEGORIES : undefined);
  // 同样：配置对象多为 const，须页面作用域内引用。
  // 存完整 JSON 而非仅键名，值改了也要能抓到。
  const objs = {};
  const grabO = (k, v) => { try { if (v !== undefined && v !== null) objs[k] = JSON.stringify(v); } catch (e) {} };
  grabO('FINGERS', typeof FINGERS !== 'undefined' ? FINGERS : undefined);
  grabO('FINGER_NAME', typeof FINGER_NAME !== 'undefined' ? FINGER_NAME : undefined);
  grabO('KB_ROWS', typeof KB_ROWS !== 'undefined' ? KB_ROWS : undefined);
  grabO('PREF_KEYS', typeof PREF_KEYS !== 'undefined' ? PREF_KEYS : undefined);
  grabO('PREF_SYNC_ORDER', typeof PREF_SYNC_ORDER !== 'undefined' ? PREF_SYNC_ORDER : undefined);
  grabO('PREF_HANDLERS', typeof PREF_HANDLERS !== 'undefined' ? Object.keys(PREF_HANDLERS).sort() : undefined);
  grabO('sharePainters', typeof sharePainters !== 'undefined' ? Object.keys(sharePainters).sort() : undefined);
  grabO('chartLayers', typeof chartLayers !== 'undefined' ? Object.keys(chartLayers).sort() : undefined);
  grabO('CHART_PAD', typeof CHART_PAD !== 'undefined' ? CHART_PAD : undefined);
  grabO('ALL_PAGES', typeof ALL_PAGES !== 'undefined' ? ALL_PAGES : undefined);
  grabO('TAB_ORDER', typeof TAB_ORDER !== 'undefined' ? TAB_ORDER : undefined);
  grabO('StudioMotionEngine', window.StudioMotionEngine ? Object.keys(window.StudioMotionEngine).sort() : undefined);
  grabO('StudioAccent', window.StudioAccent ? Object.keys(window.StudioAccent).sort() : undefined);
  grabO('StudioSound', window.StudioSound ? Object.keys(window.StudioSound).sort() : undefined);
  grabO('engineEase', window.StudioMotionEngine ? [0, .25, .5, .75, 1].map(t => window.StudioMotionEngine.ease(t)) : undefined);
  grabO('engineDur', window.StudioMotionEngine ? ['micro','base','macro'].map(k => window.StudioMotionEngine.dur(k)) : undefined);
  return { fns, data, objs, fnCount: Object.keys(fns).length };
};

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const grab = async (base) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    const r = await page.evaluate(PROBE);
    await ctx.close();
    return { ...r, errs };
  };
  const a = await grab(SRC);
  const b = await grab(DIST);
  await browser.close();

  const R = [];
  const ok = (n, c, d) => R.push({ name: n, pass: !!c, detail: d });

  ok('函数数量一致', a.fnCount === b.fnCount, a.fnCount + ' vs ' + b.fnCount);
  const allNames = [...new Set([...Object.keys(a.fns), ...Object.keys(b.fns)])];
  const fnDiff = [];
  for (const n of allNames) {
    if (a.fns[n] === undefined) { fnDiff.push(n + ' (仅 dist 有)'); continue; }
    if (b.fns[n] === undefined) { fnDiff.push(n + ' (仅 src 有)'); continue; }
    if (a.fns[n] !== b.fns[n]) fnDiff.push(n);
  }
  ok('全部函数体去注释后逐一全等', fnDiff.length === 0,
     fnDiff.length ? fnDiff.slice(0, 8).join(', ') : allNames.length + ' 个函数全等');

  const dataDiff = [];
  for (const k of new Set([...Object.keys(a.data), ...Object.keys(b.data)])) {
    if (a.data[k] !== b.data[k]) dataDiff.push(k);
  }
  ok('语料常量逐字节一致', dataDiff.length === 0,
     dataDiff.length ? dataDiff.join(', ') : Object.keys(a.data).length + ' 个常量全等');

  const objDiff = [];
  for (const k of new Set([...Object.keys(a.objs), ...Object.keys(b.objs)])) {
    if (a.objs[k] !== b.objs[k]) objDiff.push(k + ': ' + a.objs[k] + ' vs ' + b.objs[k]);
  }
  ok('引擎/配置对象导出面一致', objDiff.length === 0,
     objDiff.length ? objDiff.slice(0, 4).join(' | ') : Object.keys(a.objs).length + ' 个对象全等');

  ok('源码版零 pageerror', a.errs.length === 0, a.errs.slice(0, 2).join(' | '));
  ok('剥离版零 pageerror', b.errs.length === 0, b.errs.slice(0, 2).join(' | '));

  const pass = R.filter(r => r.pass).length;
  for (const r of R) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name.padEnd(34) + ' ' + String(r.detail || '').slice(0, 150));
  console.log('\n=== ' + R.length + ' 项：' + pass + ' PASS / ' + (R.length - pass) + ' FAIL ===');
  // 结果写当前工作目录而非脚本目录：仓库里的脚本目录应保持干净（产物不入库）
  require('fs').writeFileSync(process.cwd() + '/strip-verify.json', JSON.stringify(R, null, 1));
  process.exitCode = pass === R.length ? 0 : 1;
})();
