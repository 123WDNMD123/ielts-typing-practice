/* ============================================================
   app.js — 业务逻辑（v2.0）
   阶段一：从 v1.8 原样迁出，用于验证拆文件链路。
   阶段二起逐域重写。
   ============================================================ */

/* ================= 通用状态 ================= */
// 总词库合并必须放在 DAILY_WORDS 初始化之后，否则 TDZ 会中断整份主脚本。
const existingDailyWords = new Set(DAILY_WORDS.map(x=>x.w));
DAILY_WORDS.push(...DAILY_TOPIC_EXTRA.filter(x=>!existingDailyWords.has(x.w)));

const S = { text:'', pos:0, errors:0, correct:0, startedAt:null,
            mode:null, duration:0, timer:null, finished:false, label:'', material:'', level:null, tokens:null,
            spans:[], _cur:null, _scrollPending:false };
let ignoreCase = false;
let retryAction = null;
let resultSequence = 0;

let currentTab = 'daily';
/* 「有进行中的练习」的唯一判据（测试/课程共用，每日单词另有 hasActiveDailySession）。
   三条件缺一不可：mode 非空排除初始态，text 非空排除空会话，
   !finished 排除已结算 —— 已结算后切 Tab 不该再弹「未完成成绩不会保存」的确认。 */
function hasActiveTestSession(){ return !!(S.mode && S.text && !S.finished); }
function hasActiveDailySession(){ return !!(D.list.length && D.startedAt && D.idx < D.list.length); }

function switchTab(t){
  if(!currentUser){
    authShow();
    return false;
  }
  if((t==='class' || t==='admin') && currentUser.role !== 'teacher') return false;
  if(t!==currentTab && hasActiveTestSession()){
    if(S.startedAt && !confirm('离开会结束本次练习，未完成的成绩不会保存。确定离开吗？')) return false;
    resetSession(true);
  }
  currentTab = t;
  selectStudioTab(t);
  // 测试/课程进行中则恢复打字区现场，否则显示对应菜单
  const inTest = (t==='test' && S.mode==='test' && hasActiveTestSession());
  const inCourse = (t==='course' && S.mode==='course' && hasActiveTestSession());
  const showTyping = inTest || inCourse;
  document.getElementById('page-test').classList.toggle('hidden', t!=='test' || showTyping);
  document.getElementById('page-course').classList.toggle('hidden', t!=='course' || showTyping);
  document.getElementById('page-library').classList.toggle('hidden', t!=='library');
  document.getElementById('page-daily').classList.toggle('hidden', t!=='daily');
  document.getElementById('page-history').classList.toggle('hidden', t!=='history');
  document.getElementById('page-class').classList.toggle('hidden', t!=='class');
  document.getElementById('page-admin').classList.toggle('hidden', t!=='admin');
  document.getElementById('typingSection').classList.toggle('hidden', !showTyping);
  if(!showTyping) focusExitAll();
  if(t==='daily'){
    dailyView('practice');
    if(!D.list.length && document.getElementById('dailySummary').classList.contains('hidden')) startDaily();
  }
  if(t==='library') renderLibrary();
  if(t==='history') renderHistory();
  if(t==='class') renderClass();
  if(t==='admin') loadAdmin();
  animatePage(t);
  closeSidebar();
  return true;
}

const TAB_ORDER = ['daily','test','course','library','history','class','admin'];
let lastAnimatedTab = 'daily';
/* v2.1 Tab 转场：pageCross 双页交叉（旧页反向快速淡出 + 新页错峰方向淡入）。
   仍走纯合成层而非 flip() 克隆：Tab 页内容是实时渲染的列表（语料库/历史/班级），
   克隆快照会与真实 DOM 短暂不一致。方向由 TAB_ORDER 索引决定。
   旧页引用取「上一 Tab 实际可见的元素」：test/course 进行中是 typingSection，
   否则是对应 page-*。pageCross 内部代际号防连切竞态（旧动画 cancel + 钉终值）。 */
const TAB_PAGE_MAP = {test:'page-test', course:'page-course', library:'page-library', daily:'page-daily', history:'page-history', class:'page-class', admin:'page-admin'};
function tabVisibleEl(t){
  const typing = document.getElementById('typingSection');
  if((t==='test' || t==='course') && !typing.classList.contains('hidden')) return typing;
  return document.getElementById(TAB_PAGE_MAP[t]);
}
function animatePage(t){
  const el = document.getElementById(TAB_PAGE_MAP[t]);
  const typing = document.getElementById('typingSection');
  // 新页实际可见体：test/course 恢复现场时是打字区
  const inn = ((t==='test' || t==='course') && !typing.classList.contains('hidden')) ? typing : el;
  if(!inn) return;
  const out = (lastAnimatedTab !== t) ? tabVisibleEl(lastAnimatedTab) : null;
  const fwd = TAB_ORDER.indexOf(t) >= TAB_ORDER.indexOf(lastAnimatedTab);
  lastAnimatedTab = t;
  const E = window.StudioMotionEngine;
  if(E && !E.isOff()){
    E.pageCross(out, inn, fwd ? 1 : -1, { duration: 'base', dx: 22 });
    return;
  }
  // off 档或引擎缺失：直切。旧页显隐已由 switchTab 的 classList.toggle 完成。
  // 但仍要清在途动画（切档瞬间可能有上一轮 full/lite 的动画在飞）。
  if(E) E.pageKill(inn.parentNode);
}
function randItem(a){ return a[Math.floor(Math.random()*a.length)]; }

/* ===== 雅思语料库与每日一句 ===== */
let libraryFilter = 'all';
let homeSentenceIndex = 0;
function initHomeSentence(){
  const now = new Date();
  const day = (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(now.getFullYear(),0,0)) / 86400000;
  homeSentenceIndex = day % HOME_SENTENCES.length;
  renderHomeSentence();
}
function renderHomeSentence(){
  if(!HOME_SENTENCES.length) return;
  const item = HOME_SENTENCES[homeSentenceIndex];
  document.getElementById('homeSentenceEn').textContent = item.en;
  document.getElementById('homeSentenceZh').textContent = item.zh;
}
function setLibraryFilter(cat){
  libraryFilter = cat;
  document.querySelectorAll('.library-filter').forEach(b=>b.classList.toggle('active', b.dataset.cat===cat));
  renderLibrary();
}
function clearLibrarySearch(){
  document.getElementById('librarySearch').value = '';
  renderLibrary();
}
/* ===== v2.0 语料库：筛选与渲染分离 =====
   原 renderLibrary 把过滤谓词与 HTML 拼接混在一处。
   拆为 libraryMatches()（纯谓词，可单测）+ libraryItemHTML()（纯模板）
   + renderLibrary()（只做取输入/写 DOM）。
   搜索命中字段与顺序保持原样：en/zh/alt/note/topic/分类名。 */
function libraryMatches(item, cat, q){
  if(cat !== 'all' && item.cat !== cat) return false;
  if(!q) return true;
  return [item.en, item.zh, item.alt, item.note, item.topic, LIBRARY_CATEGORIES[item.cat]]
    .join(' ').toLowerCase().includes(q);
}
function libraryItemHTML(item, index){
  const alt = item.alt ? `<div class="lib-alt">↔ ${esc(item.alt)}</div>` : '';
  return `<article class="library-item">
      <div class="lib-tags"><span class="lib-tag">${esc(LIBRARY_CATEGORIES[item.cat])}</span><span class="lib-tag">${esc(item.topic)}</span></div>
      <div class="lib-en">${esc(item.en)}</div>
      ${alt}
      <div class="lib-zh">${esc(item.zh)}</div>
      <div class="lib-note">${esc(item.note)}</div>
      <div class="lib-actions"><button class="btn" onclick="practiceLibraryItem(${index})">练这条</button></div>
    </article>`;
}
const LIBRARY_EMPTY_HTML = '<div class="library-empty">没有找到匹配的内容。试试更短的关键词，或切换到“全部”。</div>';

function renderLibrary(){
  const q = document.getElementById('librarySearch').value.trim().toLowerCase();
  const rows = IELTS_LIBRARY.map((item,index)=>({item,index}))
    .filter(({item}) => libraryMatches(item, libraryFilter, q));
  document.getElementById('libraryCount').textContent = rows.length;
  document.getElementById('libraryList').innerHTML = rows.length
    ? rows.map(({item,index}) => libraryItemHTML(item, index)).join('')
    : LIBRARY_EMPTY_HTML;
}
function practiceLibraryItem(ref){
  if(!requireLogin()) return;
  const item = typeof ref === 'number' ? IELTS_LIBRARY[ref] : ref;
  if(!item || !switchTab('course')) return;
  const text = item.alt ? item.en + '; ' + item.alt : item.en;
  beginSession('course', '雅思语料 · ' + LIBRARY_CATEGORIES[item.cat], text, item.topic + ' · ' + item.zh, 'article', null);
  retryAction = () => practiceLibraryItem(ref);
}
const Q = { active:false, item:null, pos:0, errors:0, correct:0, startedAt:null, finished:false, spans:[], cur:null, lastRecord:null };
function practiceHomeSentence(){ startHomeSentencePractice(); }
function startHomeSentencePractice(){
  if(!requireLogin()) return;
  Q.active = true;
  Q.item = HOME_SENTENCES[homeSentenceIndex];
  Q.pos = 0; Q.errors = 0; Q.correct = 0;
  Q.startedAt = null; Q.finished = false; Q.cur = null; Q.lastRecord = null;
  document.getElementById('homeSentencePreview').classList.add('hidden');
  document.getElementById('homeSentencePractice').classList.remove('hidden');
  document.getElementById('homeSentenceResult').classList.add('hidden');
  document.getElementById('homeSentenceSaveTip').classList.add('hidden');
  document.getElementById('homeSentencePracticeZh').classList.add('hidden');
  document.getElementById('homeSentencePracticeZh').textContent = Q.item.zh;
  document.getElementById('homeSentenceZhBtn').textContent = '显示释义';
  const target = document.getElementById('homeSentenceTarget');
  target.innerHTML = '';
  Q.spans = [];
  for(let i=0;i<Q.item.en.length;i++){
    const sp = document.createElement('span');
    sp.className = 'ch'; sp.textContent = Q.item.en[i];
    Q.spans.push(sp); target.appendChild(sp);
  }
  document.getElementById('homeSentenceInput').value = '';
  skipHomeSentenceIgnored();
  updateHomeSentenceCursor();
  focusHomeSentenceInput();
}
function exitHomeSentencePractice(){
  Q.active = false; Q.finished = false; Q.cur = null; Q.lastRecord = null;
  const input = document.getElementById('homeSentenceInput');
  if(input) input.value = '';
  document.getElementById('homeSentencePractice').classList.add('hidden');
  document.getElementById('homeSentencePreview').classList.remove('hidden');
}
function resetHomeSentencePractice(){ startHomeSentencePractice(); }
function nextHomeSentence(){
  homeSentenceIndex = (homeSentenceIndex + 1) % HOME_SENTENCES.length;
  renderHomeSentence();
}
function nextHomeSentencePractice(){
  nextHomeSentence();
  startHomeSentencePractice();
}
function skipHomeSentenceIgnored(){
  while(Q.pos < Q.item.en.length && isIgnorableChar(Q.item.en[Q.pos])){
    Q.spans[Q.pos].classList.add('done-ok');
    Q.spans[Q.pos].classList.remove('done-err','cur');
    Q.pos++;
  }
}
function updateHomeSentenceCursor(){
  if(Q.cur) Q.cur.classList.remove('cur');
  Q.cur = (!Q.finished && Q.spans[Q.pos]) || null;
  if(Q.cur) Q.cur.classList.add('cur');
  const total = Q.item ? Q.item.en.length : 0;
  document.getElementById('homeSentenceProgress').textContent = Q.pos + ' / ' + total;
  document.getElementById('homeSentenceErrors').textContent = '错误 ' + Q.errors;
}
function homeSentenceChar(ch){
  if(!Q.active || Q.finished || !Q.item || ch.length!==1 || isIgnorableChar(ch)) return;
  skipHomeSentenceIgnored();
  if(Q.pos>=Q.item.en.length){ finishHomeSentence(); return; }
  if(!Q.startedAt) Q.startedAt = Date.now();
  const expected = Q.item.en[Q.pos];
  const ok = ignoreCase ? ch.toLowerCase()===expected.toLowerCase() : ch===expected;
  StudioSound.key(ok);
  const sp = Q.spans[Q.pos];
  if(ok){
    Q.correct++; Q.pos++;
    sp.classList.add('done-ok'); sp.classList.remove('done-err','cur');
    skipHomeSentenceIgnored();
  }else{
    Q.errors++;
    sp.classList.add('done-err');
  }
  updateHomeSentenceCursor();
  if(Q.pos>=Q.item.en.length) finishHomeSentence();
}
function homeSentenceBackspace(){
  if(!Q.active || Q.finished || !Q.correct) return;
  const previous = Q.pos;
  do { Q.pos--; } while(isIgnorableChar(Q.item.en[Q.pos]));
  Q.correct--;
  for(let i=Q.pos;i<=previous && i<Q.spans.length;i++) Q.spans[i].classList.remove('done-ok','done-err');
  updateHomeSentenceCursor();
}
/* ================= 打字输入的统一分派层 =================
   三处练习（首页每日一句 / 测试与课程 / 每日单词）共用同一套按键语义：
   Esc（可选）→ 输入法与修饰键屏蔽 → Backspace → 单字符。
   差异只在「守卫条件」与「三个回调」，故把骨架收敛到 typingDispatch，
   各处仍显式写出自己的守卫，避免把不同的前置判断误统一。

   顺序即契约：Esc 必须在「已完成」守卫之前处理（完成后仍要能退出专注），
   而修饰键屏蔽必须在 Backspace 之前（Ctrl+Backspace 是删词，不该被当成退格）。 */
function typingModifiers(e){ return e.isComposing || e.ctrlKey || e.metaKey || e.altKey; }
function typingDispatch(e, opts){
  if(opts.escape && e.key === 'Escape'){ opts.escape(e); return true; }
  if(opts.blocked()) return true;
  if(typingModifiers(e)) return true;
  if(e.key === 'Backspace'){ e.preventDefault(); opts.backspace(); return true; }
  if(e.key.length === 1){ e.preventDefault(); opts.char(e.key); return true; }
  return false;
}
/* 移动端转焦：可见的排版区拿到焦点后立刻转给隐藏 input 唤起软键盘。
   preventScroll 防止 iOS 聚焦时页面跳动；个别浏览器不支持参数，降级为无参 focus。 */
function focusHiddenInput(id, fallback){
  const el = document.getElementById(id);
  if(!el) return;
  try{ el.focus({preventScroll:true}); }catch(e){ if(fallback) el.focus(); }
}
/* beforeinput 是移动端的实际输入通道（keydown 在软键盘上不可靠）：
   有 data 就逐字符喂，删除类 inputType 走退格。两条分支都要 preventDefault，
   否则隐藏 input 会真的积累文本，与自绘的字符状态脱节。 */
function typingBeforeInput(e, blocked, onChar, onBackspace){
  if(blocked()) return;
  if(e.data && e.data.length){
    e.preventDefault();
    for(const ch of e.data) onChar(ch);
  } else if(e.inputType === 'deleteContentBackward'){
    e.preventDefault();
    onBackspace();
  }
}
function homeSentenceKeydown(e){
  if(!Q.active) return;
  typingDispatch(e, {
    escape: ev => { ev.preventDefault(); exitHomeSentencePractice(); },
    blocked: () => Q.finished,
    backspace: homeSentenceBackspace,
    char: homeSentenceChar
  });
}
function focusHomeSentenceInput(){
  if(!Q.active || Q.finished) return;
  focusHiddenInput('homeSentenceInput', true);
}
function toggleHomeSentenceZh(){
  const zh = document.getElementById('homeSentencePracticeZh');
  const show = zh.classList.contains('hidden');
  zh.classList.toggle('hidden', !show);
  document.getElementById('homeSentenceZhBtn').textContent = show ? '隐藏释义' : '显示释义';
  focusHomeSentenceInput();
}
/* 朗读唯一入口：先 cancel 打断上一句再 speak，避免排队叠加。
   rate 默认 0.9（单词）；首页例句用 0.88 —— 整句稍慢便于跟读，这是有意差异不要统一。 */
const SPEECH_LANG = 'en-US';
const SPEECH_RATE_WORD = 0.9;
const SPEECH_RATE_SENTENCE = 0.88;
function speakText(text, rate){
  if(!text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = SPEECH_LANG;
  u.rate = rate == null ? SPEECH_RATE_WORD : rate;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}
function speakHomeSentence(){
  // 守卫保持原样：不支持语音时连焦点也不转移（原实现在同一 if 里 return）
  if(!Q.item || !('speechSynthesis' in window)) return;
  speakText(Q.item.en, SPEECH_RATE_SENTENCE);
  focusHomeSentenceInput();
}
function finishHomeSentence(){
  if(Q.finished) return;
  Q.finished = true;
  updateHomeSentenceCursor();
  /* 注意：每日一句的结算口径与测试/课程【有意不同】，不要统一到 sessionSeconds/sessionWpm：
     · secs 无 startedAt 时回落 Date.now() 得 1（而非 0），保证未计时也能出成绩
     · wpm 走 (correct/5)/(secs/60)，与 round(correct*12/secs) 数学等价但取整路径不同 */
  const secs = Math.max(1, Math.round((Date.now()-(Q.startedAt || Date.now()))/1000));
  const acc = accuracy(Q.correct, Q.errors);
  const wpm = Math.round((Q.correct/5)/(secs/60));
  document.getElementById('homeSentenceResultText').textContent = '用时 ' + secs + ' 秒 · 准确率 ' + acc + '% · 错误 ' + Q.errors + ' 个' + (acc===100 ? '，全对！' : '');
  document.getElementById('homeSentenceResult').classList.remove('hidden');
  document.getElementById('homeSentencePracticeZh').classList.remove('hidden');
  document.getElementById('homeSentenceZhBtn').textContent = '隐藏释义';
  const rec = {t:Date.now(),student:getStudent(),label:'每日一句',material:Q.item.topic+' · '+Q.item.en,wpm,acc,chars:Q.correct,errs:Q.errors,secs};
  Q.lastRecord = rec;
  saveHomeSentenceRecord(rec, Q.item);
}
async function saveHomeSentenceRecord(rec, item){
  let saved = false;
  try{
    const res = await fetch('/api/records',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(rec)});
    saved = res.ok;
  }catch(e){}
  if(Q.lastRecord===rec && Q.item===item) document.getElementById('homeSentenceSaveTip').classList.toggle('hidden', saved);
}
document.getElementById('homeSentenceTarget').addEventListener('keydown', homeSentenceKeydown);
document.getElementById('homeSentenceInput').addEventListener('keydown', homeSentenceKeydown);
document.getElementById('homeSentenceInput').addEventListener('beforeinput', e=>{
  if(!Q.active || Q.finished) return;
  if(e.inputType==='insertText' && e.data){
    e.preventDefault();
    for(const ch of e.data) homeSentenceChar(ch);
  }else if(e.inputType==='deleteContentBackward'){
    e.preventDefault(); homeSentenceBackspace();
  }
  e.target.value = '';
});

/* 速度测试素材：随机拼段落直到累计 ≥2200 字符（保证 120 秒也打不完，
   计时模式才能真实测速）。段落粒度而非整篇，避免每次都是同一篇开头。
   注意 while 条件每轮重算 join —— 这是原实现口径， randItem 调用次数决定随机序列，
   改成累加长度会改变调用次数进而改变基线词序，故保持原样。 */
const TEST_TEXT_MIN_CHARS = 2200;
function testPool(src){
  return src === 'all' ? CORPUS.readings.concat(CORPUS.listenings) : CORPUS[src];
}
function pickTestText(){
  const pool = testPool(document.getElementById('testSource').value);
  const segs = [];
  while(segs.join(' ').length < TEST_TEXT_MIN_CHARS){
    const p = randItem(pool);
    const paras = p.text.split('\n\n');
    segs.push(randItem(paras));
  }
  return { label:'速度测试 · ' + document.getElementById('testDuration').selectedOptions[0].text, text:segs.join(' ') };
}

function startTest(){
  if(!requireLogin()) return;
  const d = pickTestText();
  const duration = parseInt(document.getElementById('testDuration').value);
  beginSession('test', '打字速度测试（' + duration + ' 秒）', d.text, '随机素材：' + document.getElementById('testSource').selectedOptions[0].text, 'article', null);
  // beginSession 会重置练习状态，因此必须在开始后再恢复计时时长。
  S.duration = duration;
  document.getElementById('stTime').textContent = fmtTime(duration);
  retryAction = startTest;
}

/* 课程配置表：数量与词池即产品口径。
   抽样必须用 for 循环逐个 randItem（不可改 shuffle 后 slice）——
   randItem 的调用次数与顺序决定随机序列，改了会漂移基线词序。 */
const COURSE_LEVELS = {
  beginner:     { count: 60, pool: () => WORDS,   title: '初级课程 · 单字练习', material: '雅思真题高频单词 × 60' },
  intermediate: { count: 25, pool: () => PHRASES, title: '中级课程 · 词组练习', material: '雅思真题常用词组 × 25' }
};
function sampleItems(pool, count){
  const out = [];
  for(let i=0;i<count;i++) out.push(randItem(pool));
  return out;
}
function startCourse(level){
  if(!requireLogin()) return;
  const cfg = COURSE_LEVELS[level];
  if(cfg){
    const items = sampleItems(cfg.pool(), cfg.count);
    beginSession('course', cfg.title, items.join(' '), cfg.material, level, items);
  }
  // 未知 level 时不开始会话，但仍登记重试动作（与 v1.8 一致）
  retryAction = () => startCourse(level);
}
/* v2.0 文章列表：数据源与渲染分离。
   passageCatalog() 把阅读+听力拼成统一目录（idx 全局连续，与 v1.8 一致）；
   渲染改 DocumentFragment 一次挂载，避免 32 次 appendChild 逐次触发布局。
   标题补 esc() 转义 —— 原实现直插 innerHTML，语料标题含特殊字符会破坏结构。 */
function passageCatalog(){
  return CORPUS.readings.map((r,i)=>({...r,cat:'阅读文章',idx:i}))
    .concat(CORPUS.listenings.map((r,i)=>({...r,cat:'听力原文',idx:CORPUS.readings.length+i})));
}
function showPassages(){
  const menu = document.getElementById('courseMenu');
  const passages = document.getElementById('passageMenu');
  const wasMenuVisible = !menu.classList.contains('hidden');
  menu.classList.add('hidden');
  passages.classList.remove('hidden');
  const list = document.getElementById('passageList');
  const frag = document.createDocumentFragment();
  for(const p of passageCatalog()){
    const div = document.createElement('div');
    div.className = 'passage-item';
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.innerHTML = `<span><span style="color:var(--primary);font-size:12px;margin-right:8px">[${esc(p.cat)}]</span>${esc(p.title)}</span><span class="wcount">${p.words} 词</span>`;
    div.onclick = () => startPassage(p);
    frag.appendChild(div);
  }
  list.innerHTML = '';
  list.appendChild(frag);
  /* v2.1 课程内导航：菜单→文章列表视为「进入下一级」，前进方向。
     pageCross 需要旧页仍可见才能做退场，故先摘 hidden 再转场（旧页由引擎收尾隐藏）。
     wasMenuVisible=false（如重练回列表）时 out 传 null，只做入场。 */
  const E = window.StudioMotionEngine;
  if(E && !E.isOff()){
    if(wasMenuVisible) menu.classList.remove('hidden');
    E.pageCross(wasMenuVisible ? menu : null, passages, 1, { duration: 'base', dx: 22 });
  }
}
/* 高级课程固定 level='article'、tokens=null —— 整篇连排，不做单词分卡。
   retryAction 必须闭包捕获 p：重练要回到同一篇，而不是重抽一篇。 */
function startPassage(p){
  if(!requireLogin()) return;
  beginSession('course','高级课程 · ' + p.cat, p.text, p.title, 'article', null);
  retryAction = () => startPassage(p);
}
function backToMenu(){
  const menu = document.getElementById('courseMenu');
  const passages = document.getElementById('passageMenu');
  const wasPassagesVisible = !passages.classList.contains('hidden');
  passages.classList.add('hidden');
  menu.classList.remove('hidden');
  document.getElementById('page-course').classList.remove('hidden');
  document.getElementById('typingSection').classList.add('hidden');
  /* v2.1 返回上级：与 showPassages 互逆（后退方向），开与关呼应。
     从打字区退出（closeModal 路径）时列表已隐藏，只做菜单入场。 */
  const E = window.StudioMotionEngine;
  if(E && !E.isOff()){
    if(wasPassagesVisible) passages.classList.remove('hidden');
    E.pageCross(wasPassagesVisible ? passages : null, menu, -1, { duration: 'base', dx: 22 });
  }
}

/* 进入练习时要让位的三个菜单页。顺序无关（都只是加 hidden），
   但清单本身是契约：漏一个会出现菜单与打字区同屏。 */
const SESSION_PAGES = ['page-test', 'page-course', 'page-library'];
function beginSession(mode, title, text, material, level, tokens){
  resetSession(true);
  S.mode = mode; S.text = text; S.label = title; S.material = material;
  S.level = level || 'article';
  S.tokens = tokens || null;
  SESSION_PAGES.forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('typingSection').classList.remove('hidden');
  document.getElementById('sessionTitle').textContent = title;
  document.getElementById('materialTitle').textContent = material;
  document.getElementById('stTime').textContent = S.duration ? fmtTime(S.duration) : '不限';
  renderText();
  liveCurveReset();
  focusMeasureCacheInvalidate();   // 文本/级别变化 → 目标布局缓存失效（隐藏行自然高度依赖内容）
  // 先归零滚动再起镜：镜头终点按 scrollY=0 量测，避免起镜后再滚动导致终点错位。
  // 不用 smooth scroll——它会与逐帧镜头争抢主线程，且卡片此时已是 fixed 承载。
  window.scrollTo(0, 0);
  focusSet(1); // 两段式专注：选定项目先进入半专注
  // 预热排在起镜「之后」：0→1 这一镜只需 1 档目标，其余档位在后续空闲帧逐帧补齐。
  // 若排在起镜前，量测会与镜头首帧撞在同一个 rAF，形成长任务把首帧顶掉。
  focusPrewarm();
}

/* 会话清零字段全集（与 session-probe 的 16 字段断言逐项对照）。
   必须是工厂函数而非共享常量对象：spans 是数组，若共用同一引用，
   上一次会话的 span 残留会漏进下一次会话（renderText 虽会整体重赋值，
   但 resetSession 到 renderText 之间存在窗口，updateCursor 会读到脏数组）。
   timer 不在表内 —— 它必须先 clearInterval 再置 null，不能只赋空值。 */
function sessionResetState(){
  return { text:'', pos:0, errors:0, correct:0, startedAt:null,
           mode:null, duration:0, finished:false, label:'', material:'', level:null, tokens:null,
           spans:[], _cur:null, _scrollPending:false };
}
function resetSession(silent){
  clearInterval(S.timer); S.timer=null;
  Object.assign(S, sessionResetState());
  liveCurveStop();
  focusExitAll();
  document.getElementById('typeArea').innerHTML='';
  const liveHint = document.getElementById('liveHint');
  if(liveHint) liveHint.classList.remove('show');
  if(!silent){
    document.getElementById('typingSection').classList.add('hidden');
    if(document.getElementById('tab-test').classList.contains('active')) document.getElementById('page-test').classList.remove('hidden');
    if(document.getElementById('tab-course').classList.contains('active')){ backToMenu(); }
  }
}

/* ================= 渲染与输入 ================= */
function renderText(){
  const area = document.getElementById('typeArea');
  area.innerHTML='';
  area.classList.remove('level-beginner','level-intermediate','level-article');
  area.classList.add('level-' + (S.level || 'article'));
  const frag = document.createDocumentFragment();
  const spans = [];
  if(S.tokens && (S.level==='beginner' || S.level==='intermediate')){
    let idx = 0;
    S.tokens.forEach((tok, ti)=>{
      const chip = document.createElement('span');
      chip.className = 'chip';
      for(let j=0;j<tok.length;j++){
        const sp = document.createElement('span');
        sp.className = 'ch'; sp.textContent = tok[j]; sp.dataset.i = idx++;
        spans.push(sp); chip.appendChild(sp);
      }
      // 单词/词组之间的空格也作为可输入字符，保留在卡片末尾。
      if(ti < S.tokens.length - 1){
        const sp = document.createElement('span');
        sp.className = 'ch space-char'; sp.textContent = ' '; sp.dataset.i = idx++;
        spans.push(sp); chip.appendChild(sp);
      }
      frag.appendChild(chip);
    });
  } else {
    for(let i=0;i<S.text.length;i++){
      const sp = document.createElement('span');
      sp.className='ch'; sp.textContent=S.text[i]; sp.dataset.i=i;
      spans.push(sp); frag.appendChild(sp);
    }
  }
  S.spans = spans;
  area.appendChild(frag);
  skipIgnoredChars();
  updateCursor();
}

// 降低练习难度：中英文标点及其他符号自动跳过，不参与正误与成绩统计。
function isIgnorableChar(ch){ return /[\p{P}\p{S}]/u.test(ch); }
function skipIgnoredChars(){
  const spans = S.spans;
  while(S.pos<S.text.length && isIgnorableChar(S.text[S.pos])){
    const sp = spans[S.pos];
    if(sp){ sp.classList.add('done-ok'); sp.classList.remove('done-err','cur'); if(S._cur===sp) S._cur=null; }
    S.pos++;
  }
}

function updateCursor(){
  const spans = S.spans;
  if(S._cur){ S._cur.classList.remove('cur'); S._cur = null; }
  const cur = spans[S.pos];
  if(cur && !S.finished){ cur.classList.add('cur'); S._cur = cur; }
  if(!S._scrollPending){
    S._scrollPending = true;
    requestAnimationFrame(()=>{
      S._scrollPending = false;
      const c = S.spans[S.pos];
      if(c) c.scrollIntoView({block:'nearest'});
    });
  }
  const total = S.text.length || 1;
  document.getElementById('progressFill').style.width = Math.min(100, S.pos/total*100) + '%';
  highlightNextKey();
}

function accuracy(correct, errors){
  return correct + errors ? Math.round(correct / (correct + errors) * 100) : 100;
}
function typeBackspace(){
  if(!S.correct) return;
  StudioSound.backspace();
  const previous = S.pos;
  do { S.pos--; } while(isIgnorableChar(S.text[S.pos]));
  S.correct--;
  for(let i=S.pos;i<=previous && i<S.spans.length;i++) S.spans[i].classList.remove('done-ok','done-err');
  updateLive();
  updateCursor();
}
function typeChar(ch){
  if(ch.length!==1 || isIgnorableChar(ch)) return;
  skipIgnoredChars();
  if(S.pos>=S.text.length){
    updateCursor();
    if(!S.duration) finish('练习完成');
    return;
  }
  if(!S.startedAt){
    S.startedAt = Date.now();
    S.timer=setInterval(tick, 200); // 计时模式倒计时 / 不限时模式计已用时
    if(focusLevel === 1) focusSet(2); // 两段式专注：首键进入极简全屏
    liveCurveLastSample = Date.now();
    liveCurveStart();
  }
  const expected = S.text[S.pos];
  const ok = ignoreCase ? (ch.toLowerCase()===expected.toLowerCase()) : (ch===expected);
  StudioSound.key(ok);
  const keyEl = keyFor(expected);
  keyErrTrack(expected, ok); // F2：按「应打字符」累计敲击与错误
  if(ok){
    S.correct++; S.pos++;
    const sp = S.spans[S.pos-1];
    if(sp){ sp.classList.add('done-ok'); sp.classList.remove('cur'); }
    if(keyEl){ flash(keyEl,'hit-ok'); }
  } else {
    S.errors++;
    const sp = S.spans[S.pos];
    if(sp){ sp.classList.add('done-err'); }
    if(keyEl){ flash(keyEl,'hit-err'); }
  }
  skipIgnoredChars();
  updateLive();
  updateCursor();
  if(S.pos>=S.text.length && !S.duration) finish('练习完成');
}
function typeKeydown(e){
  typingDispatch(e, {
    escape: focusEscHandler,          // Esc 先于「已完成」守卫：完成后仍要能逐级退出专注
    blocked: () => S.finished || !S.text,
    backspace: typeBackspace,
    char: typeChar
  });
}
document.getElementById('typeArea').addEventListener('keydown', typeKeydown);
document.getElementById('typeInput').addEventListener('keydown', typeKeydown);
// 移动端：打字区聚焦时转焦到隐藏 input，用 beforeinput 驱动练习
function focusTypeInput(){ focusHiddenInput('typeInput'); }
document.getElementById('typeArea').addEventListener('focus', focusTypeInput);
document.getElementById('typeInput').addEventListener('beforeinput', e =>
  typingBeforeInput(e, () => S.finished || !S.text, typeChar, typeBackspace));

function flash(el, cls){
  el.classList.add(cls);
  setTimeout(()=>el.classList.remove(cls), 150);
}

/* 统计格刷新：WPM 与曲线采样共用 curveInstantWpm 同一口径（原先两处各写一份公式）。
   未开始（startedAt 为空）时直接记 0 —— 不可省这个守卫：
   curveInstantWpm 内部按 (now-startedAt) 算，startedAt 为 null 会得出巨大 mins 反而算出 0，
   但 startedAt 为 0 或极早时间戳时会算出虚高值，故显式短路。 */
function liveWpm(correct, startedAt, now){
  return startedAt ? curveInstantWpm(correct, startedAt, now) : 0;
}
function updateLive(){
  document.getElementById('stWpm').textContent = liveWpm(S.correct, S.startedAt, Date.now());
  document.getElementById('stAcc').textContent = accuracy(S.correct, S.errors) + '%';
  document.getElementById('stErr').textContent = S.errors;
  liveCurveSample();
  if(focusLevel > 0) syncFocusCapsule();
}
function tick(){
  updateLive();
  if(S.duration){
    const left = Math.max(0, S.duration - (Date.now()-S.startedAt)/1000);
    document.getElementById('stTime').textContent = fmtTime(Math.ceil(left));
    if(focusLevel > 0) syncFocusCapsule();
    if(left<=0) finish('时间到');
  } else {
    const elapsed = Math.floor((Date.now()-S.startedAt)/1000);
    document.getElementById('stTime').textContent = fmtTime(elapsed);
    if(focusLevel > 0) syncFocusCapsule();
  }
}
/* 秒 → m:ss（分钟不补零，秒补零）。入参应为整数秒；
   小数秒会让 s%60 出现小数，调用方须先取整（sessionSeconds 已保证）。 */
function fmtTime(s){ return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
/* HTML 文本/属性转义。注意：**不可**用于把字符串拼进 onclick 等 JS 上下文——
   属性值会先解码实体再交给 JS，&#39; 还原成裸单引号会破坏 JS 字面量
   （v1.8 管理表格曾因此失效，见 adminActionsHTML 的 data-* 改法）。 */
const ESC_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>ESC_MAP[c]); }

/* v2.0 成绩结算：计算层抽为纯函数。
   公式与 v1.8 逐字一致，仅从 finish() 里提出来便于单测：
     · secs 至少 1 秒（避免除零与瞬时完成的虚高 WPM）；未开始则 0
     · wpm = round(correct * 12 / secs)  —— 12 是每词按 5 字符折算的系数
     · acc 由 accuracy() 统一口径
   注意 t 与 secs 都取 Date.now()，保持与原实现相同的两次取值语义。 */
function sessionSeconds(startedAt, now){
  return startedAt ? Math.max(1, Math.round((now - startedAt) / 1000)) : 0;
}
function sessionWpm(correct, secs){
  return secs ? Math.round(correct * 12 / secs) : 0;
}
function buildResultRecord(s, now){
  const secs = sessionSeconds(s.startedAt, now);
  const wpm = sessionWpm(s.correct, secs);
  return { t: now, label: s.label, material: s.material, wpm, acc: accuracy(s.correct, s.errors),
           chars: s.correct, errs: s.errors, secs };
}

async function finish(reason){
  if(S.finished) return;
  S.finished = true;
  clearInterval(S.timer);
  liveCurveStop();
  focusExitAll();
  const rec = buildResultRecord(S, Date.now());
  const secs = rec.secs, wpm = rec.wpm, acc = rec.acc;
  lastResult = rec;
  keyErrFlush(); // F2：练习结束立即落盘剩余增量，不等 2.5s 节流（避免关页面丢统计）
  if(wpm && rec.chars) StudioSound.complete();
  const modal = document.getElementById('modal');
  const tip = document.getElementById('mdSaveTip');
  const resultId = ++resultSequence;
  document.getElementById('mdTitle').textContent = reason;
  document.getElementById('mdSub').textContent = rec.label + ' · ' + rec.material;
  countUp('mdWpm', wpm, 'macro');
  document.getElementById('mdAcc').textContent = acc + '%';
  document.getElementById('mdChars').textContent = rec.chars;
  document.getElementById('mdErr').textContent = rec.errs;
  document.getElementById('mdTime').textContent = secs + 's';
  showRecordBadge('mdRecord', checkPersonalBest(wpm));
  tip.classList.add('hidden');
  modal.classList.remove('hidden');
  // v2.1：结算弹窗入场走引擎（与设置/分享同节奏），CSS popIn 已移除
  if(window.StudioMotionEngine) StudioMotionEngine.modalIn(modal.querySelector('.box'));
  if(wpm && rec.chars){
    const box = modal.querySelector('.box');
    const r = box ? box.getBoundingClientRect() : null;
    burstParticles({ n:130, x:r ? r.left + r.width/2 : undefined, y:r ? r.top + r.height*0.3 : undefined });
  }
  if(!wpm || !rec.chars) return;
  const saved = await saveDailyRecord(rec);
  if(resultId===resultSequence) tip.classList.toggle('hidden', saved);
}
function closeModal(){
  resultSequence++;
  const modal = document.getElementById('modal');
  const E = window.StudioMotionEngine;
  const box = modal.querySelector('.box');
  /* v2.1 结算弹窗退场：视觉收回（modalOut）与状态清零并行 ——
     resetSession/页面切换立即执行（重练等后续动作依赖新状态），
     只有 modal 的 hidden 等动画结束再加。重练时 beginSession 会立即
     重新打开弹窗，modalIn 的代际号会取消在途退场，互不干扰。 */
  resetSession(true);
  document.getElementById('typingSection').classList.add('hidden');
  if(document.getElementById('tab-course').classList.contains('active')) backToMenu();
  else document.getElementById('page-test').classList.remove('hidden');
  if(E && !E.isOff() && box && !modal.classList.contains('hidden')){
    /* 代际守卫：onDone 只在退场自然结束时被调（被 modalKill/新 modalIn 中断则不调），
       故回调里直接加 hidden 即可，无需再验状态 —— 重练路径不会走到这里。 */
    E.modalOut(box, { onDone: () => modal.classList.add('hidden') });
  }else{
    modal.classList.add('hidden');
  }
}
/* 重练：先关弹窗再重放上次动作。顺序不可换 ——
   closeModal 内部会 resetSession(true) 并推进 resultSequence（作废在途的保存回执），
   若先 retryAction，新会话的 startedAt 会被随后的清零抹掉。 */
function retrySession(){
  closeModal();
  if(retryAction) retryAction();
}

/* ================= 虚拟键盘 ================= */
const FINGERS = {
  '`':'f-lpinky','1':'f-lpinky','2':'f-lring','3':'f-lmid','4':'f-lindex','5':'f-lindex',
  '6':'f-rindex','7':'f-rindex','8':'f-rmid','9':'f-rring','0':'f-rpinky','-':'f-rpinky','=':'f-rpinky',
  'q':'f-lpinky','w':'f-lring','e':'f-lmid','r':'f-lindex','t':'f-lindex',
  'y':'f-rindex','u':'f-rindex','i':'f-rmid','o':'f-rring','p':'f-rpinky','[':'f-rpinky',']':'f-rpinky',
  'a':'f-lpinky','s':'f-lring','d':'f-lmid','f':'f-lindex','g':'f-lindex',
  'h':'f-rindex','j':'f-rindex','k':'f-rmid','l':'f-rring',';':'f-rpinky',"'":'f-rpinky',
  'z':'f-lpinky','x':'f-lring','c':'f-lmid','v':'f-lindex','b':'f-lindex',
  'n':'f-rindex','m':'f-rindex',',':'f-rmid','.':'f-rring','/':'f-rpinky',
  ' ':'thumb'
};
const FINGER_NAME = {'f-lpinky':'左手小指','f-lring':'左手无名指','f-lmid':'左手中指','f-lindex':'左手食指',
  'f-rindex':'右手食指','f-rmid':'右手中指','f-rring':'右手无名指','f-rpinky':'右手小指','thumb':'拇指（空格）'};
const KB_ROWS = [
  ['`','1','2','3','4','5','6','7','8','9','0','-','='],
  ['q','w','e','r','t','y','u','i','o','p','[',']'],
  ['a','s','d','f','g','h','j','k','l',';',"'"],
  ['z','x','c','v','b','n','m',',','.','/']
];
const KB_MAP = {};        // 练习内实时键盘（指法高亮 + 可选热力）
const KB_MAP_REVIEW = {}; // F2 复盘页键盘（只读热力，不参与实时高亮）
/* 键帽元素工厂：键面大写 + 指法小字，fingerColors 决定是否带指法配色类。
   空格键在 KB_ROWS 中不出现（单独一行），故这里的 k===' ' 分支只是防御性保留。 */
function kbKeyEl(k, fingerColors){
  const el = document.createElement('div');
  el.className = 'key' + (fingerColors ? ' ' + (FINGERS[k]||'') : '');
  el.dataset.key = k;
  el.innerHTML = `<span>${k===' '?'':k.toUpperCase()}</span><span class="fn">${k}</span>`;
  return el;
}
/* 行首缩进垫片：模拟真实键盘的错位排布（a 行半键、z 行一又四分之一键）。
   以行首字符为键，宽度即契约——改动会破坏指法列对齐。 */
const KB_INDENT = { a: '30px', z: '60px' };
function kbSpacerEl(width){
  const sp = document.createElement('div');
  sp.className = 'key'; sp.style.width = width; sp.style.border = 'none';
  return sp;
}
function kbRowEl(row, map, fingerColors){
  const r = document.createElement('div'); r.className = 'kb-row';
  row.forEach(k => { const el = kbKeyEl(k, fingerColors); map[k] = el; r.appendChild(el); });
  const indent = KB_INDENT[row[0]];
  if(indent) r.insertBefore(kbSpacerEl(indent), r.firstChild);
  return r;
}
function kbSpaceRowEl(map){
  const r = document.createElement('div'); r.className = 'kb-row';
  const sp = document.createElement('div'); sp.className = 'key thumb'; sp.dataset.key = ' ';
  sp.innerHTML = '<span class="fn">space 空格</span>';
  map[' '] = sp;
  r.appendChild(sp);
  return r;
}
/* 挂载顺序即 DOM 顺序契约：四行字母区 → 空格行。两套键盘共用此函数，
   差异仅在 fingerColors（练习内带指法色，复盘页纯色只承载热力）。 */
function buildKBInto(body, map, fingerColors){
  if(!body) return;
  KB_ROWS.forEach(row => body.appendChild(kbRowEl(row, map, fingerColors)));
  body.appendChild(kbSpaceRowEl(map));
}
buildKBInto(document.getElementById('kbBody'), KB_MAP, true);
buildKBInto(document.getElementById('kbBodyReview'), KB_MAP_REVIEW, false);
/* 字符 → 练习内键帽元素。大小写归一（Shift 组合键仍指向同一物理键）；
   键盘上没有的字符（中文/标点变体）返回 null，由调用方降级为「下一个字符」提示。
   只查 KB_MAP（练习内），复盘键盘 KB_MAP_REVIEW 不参与实时高亮。 */
function keyFor(ch){
  return KB_MAP[ch.toLowerCase()] || null;
}

/* ================= F2 错键热力图 =================
   采集口径：按「应打字符」（expected）而非「实际按错的键」计数——
   用户想知道的是「哪个键位打不准」，而非「误触了哪个键」。
   本地累加 → 节流批量上报（避免每次击键一个请求）→ 服务端累加。
   热力等级按错误率分档，样本不足（<5 次）不着色，避免偶发一次错误就标红。 */
const KEYERR_MIN_SAMPLE = 5;
let keyErrLocal = {};        // { ch: {errs, hits} } 尚未上报的增量
let keyErrAll = {};          // { ch: {errs, hits} } 服务端已有 + 本地增量（用于渲染）
let keyErrFlushTimer = 0;
let keyErrLoaded = false;
let kbMode = 'finger';

/* 可统计字符：单个 ASCII 可打印字符（0x20..0x7E）。
   排除中文/换行/控制符——键盘上没有对应键位，计入会污染错误率。 */
function keyErrCountable(expected){
  if(typeof expected !== 'string' || expected.length !== 1) return null;
  const ch = expected.toLowerCase();
  const code = ch.charCodeAt(0);
  return (code < 0x20 || code > 0x7E) ? null : ch;
}
/* 累加一次敲击到某张计数表（本地待上报表 / 渲染用全量表共用同一口径） */
function keyErrBump(table, ch, ok){
  if(!table[ch]) table[ch] = { errs:0, hits:0 };
  table[ch].hits++;
  if(!ok) table[ch].errs++;
}
function keyErrTrack(expected, ok){
  const ch = keyErrCountable(expected);
  if(ch === null) return;
  keyErrBump(keyErrLocal, ch, ok);
  keyErrBump(keyErrAll, ch, ok);
  // 性能：只更新受影响的那一个键，且仅更新当前可见的键盘。
  // 逐键全量重绘（两套键盘 ~94 个键的 class 增删 + querySelector）会拖慢打字帧率。
  kbHeatPaintKey(ch);
  // 节流：2.5s 内的击键合并成一次上报
  if(!keyErrFlushTimer) keyErrFlushTimer = setTimeout(keyErrFlush, 2500);
}
async function keyErrFlush(){
  if(keyErrFlushTimer){ clearTimeout(keyErrFlushTimer); keyErrFlushTimer = 0; }
  const keys = Object.keys(keyErrLocal).map(ch => ({ ch, errs:keyErrLocal[ch].errs, hits:keyErrLocal[ch].hits }))
    .filter(k => k.errs > 0 || k.hits > 0);
  if(!keys.length) return;
  if(!currentUser){ keyErrLocal = {}; return; } // 未登录不留存，避免串账号
  const pending = keyErrLocal;
  keyErrLocal = {};
  try{
    const r = await fetch('/api/keyerrors', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ keys }) });
    if(!r.ok) throw new Error('status ' + r.status);
  }catch(e){
    // 上报失败：把增量还回本地，下次一并重试（不丢统计）
    for(const k of keys){
      if(!keyErrLocal[k.ch]) keyErrLocal[k.ch] = { errs:0, hits:0 };
      keyErrLocal[k.ch].errs += k.errs;
      keyErrLocal[k.ch].hits += k.hits;
    }
  }
}
async function keyErrLoad(){
  if(!currentUser){ keyErrAll = {}; keyErrLoaded = false; return; }
  try{
    const r = await fetch('/api/keyerrors');
    if(!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    keyErrAll = {};
    (j.items || []).forEach(x => { keyErrAll[x.ch] = { errs:x.errs, hits:x.hits }; });
    keyErrLoaded = true;
  }catch(e){ keyErrLoaded = false; }
  kbHeatPaint(); kbHeatSummary();
}
/* 热力分档阈值表（降序，首个命中即取）。语义：
   0=不着色（无样本/样本不足/零错误），1..4 底色由浅到深。
   阈值是产品口径不可擅改：0.25/0.15/0.08 三条线，其余有错样本归 1。 */
const KEYERR_TIERS = [[0.25, 4], [0.15, 3], [0.08, 2]];
function keyErrLevel(rec){
  if(!rec || rec.hits < KEYERR_MIN_SAMPLE || !rec.errs) return 0;
  const rate = rec.errs / rec.hits;
  for(const [min, lv] of KEYERR_TIERS) if(rate >= min) return lv;
  return 1;
}
// 练习内键盘的两种配色（指法 / 热力）；复盘页键盘恒为热力，不受此开关影响
/* 两种配色的静态文案（说明行 + 字幕），集中在表里防散落 */
const KB_MODE_COPY = {
  heat:   { sub: '底色越深 = 该键错误率越高' },
  finger: { sub: '高亮键 = 下一个应按的键' }
};
/* 分段开关组：按钮 on 类 + aria-pressed 同步，字幕行 hidden 互斥 */
function kbModeToggle(id, on){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
}
function kbModeCaption(id, hidden){
  const el = document.getElementById(id);
  if(el) el.classList.toggle('hidden', hidden);
}
function kbModeChrome(heat){
  kbModeToggle('kbModeFinger', !heat);
  kbModeToggle('kbModeHeat', heat);
  kbModeCaption('kbCaptionFinger', heat);
  kbModeCaption('kbCaptionHeatLive', !heat);
  const sub = document.getElementById('kbSubtitle');
  if(sub) sub.textContent = KB_MODE_COPY[heat ? 'heat' : 'finger'].sub;
  const body = document.getElementById('kbBody');
  if(body) body.classList.toggle('heat', heat);
}
/* 顺序即契约：规范化模式 → 更新外观 → 按需拉数据 → 重绘 → 下一键提示 → 落盘。
   kbHeatPaint 必须在 highlightNextKey 之前：后者会读/写 liveHint 并可能失效几何缓存，
   而底色要先就位，避免提示行高度变化触发重排时底色还是旧的。 */
function kbSetMode(mode){
  kbMode = (mode === 'heat') ? 'heat' : 'finger';
  const heat = kbMode === 'heat';
  kbModeChrome(heat);
  if(heat && !keyErrLoaded) keyErrLoad();
  kbHeatPaint();
  // 统一由 highlightNextKey 决定提示文案与下一键高亮（两种视图都要有下一键外框）
  highlightNextKey();
  try{ localStorage.setItem('typingKbMode', kbMode); }catch(e){}
}
const HEAT_CLASSES = ['heat-0','heat-1','heat-2','heat-3','heat-4'];
function kbHeatClearEl(el){
  if(!el) return;
  el.classList.remove(...HEAT_CLASSES);
  const r = el.querySelector('.kb-rate');
  if(r) r.remove();
}
function kbHeatClearMap(map){
  Object.keys(map).forEach(k => kbHeatClearEl(map[k]));
}
/* 清空练习内键盘的热力（切回指法配色 / 退出登录时走），复盘键盘不受影响 */
function kbHeatClear(){ kbHeatClearMap(KB_MAP); }
/* 单键绘制：等级/百分比都没变就一个 DOM 操作也不做（打字热路径，每次击键都会调）。
   百分比标签的显示条件与「非零热力档」完全同义（lv>0 ⟺ hits≥门槛 且 errs>0），
   故直接复用 lv 判定，避免两处口径漂移导致「有底色却无百分比」。 */
function kbHeatPaintEl(el, rec){
  if(!el) return;
  const lv = keyErrLevel(rec);
  const cls = 'heat-' + lv;
  if(!el.classList.contains(cls)){
    el.classList.remove(...HEAT_CLASSES);
    el.classList.add(cls);
  }
  const show = lv > 0;
  const pct = show ? (Math.round(rec.errs / rec.hits * 100) + '%') : null;
  let r = el.querySelector('.kb-rate');
  if(show){
    if(!r){ r = document.createElement('span'); r.className = 'kb-rate'; el.appendChild(r); }
    if(r.textContent !== pct) r.textContent = pct;
  } else if(r){ r.remove(); }
}
/* 可见性门（着色范围的唯一判据，勿在别处重复判断）：
   · 复盘键盘：只要 #dailyKeysPanel 可见就恒着色，不受 kbMode 影响
   · 练习键盘：需 kbMode==='heat'；单键路径还要求 #typingSection 可见（热路径省无用功） */
function kbPanelVisible(id){
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('hidden');
}
function kbReviewVisible(){ return kbPanelVisible('dailyKeysPanel'); }
function kbLiveHeatActive(){ return kbMode === 'heat' && kbPanelVisible('typingSection'); }
function kbHeatPaintKey(ch){
  const rec = keyErrAll[ch];
  if(kbReviewVisible()) kbHeatPaintEl(KB_MAP_REVIEW[ch], rec);
  if(kbLiveHeatActive()) kbHeatPaintEl(KB_MAP[ch], rec);
}
/* 全量重绘一张键盘（~47 键）。只在视图切换/数据加载/清空时走，
   打字热路径必须走 kbHeatPaintKey 单键，否则每键一次 querySelector 会拖慢帧率。 */
function kbHeatPaintMap(map){
  Object.keys(map).forEach(k => kbHeatPaintEl(map[k], keyErrAll[k]));
}
function kbHeatPaint(){
  // 全量重绘只在视图切换/加载/清空时走（打字热路径走 kbHeatPaintKey 单键）。
  // 注意：此处练习键盘不校验 typingSection 可见性——切到热力配色时即使当前不在练习页，
  // 也要把底色准备好，回到练习页即刻正确。这个不对称是 v1.8 既有口径，保持不变。
  if(kbReviewVisible()) kbHeatPaintMap(KB_MAP_REVIEW);
  if(kbMode === 'heat') kbHeatPaintMap(KB_MAP); else kbHeatClearMap(KB_MAP);
}
/* ---- 薄弱键位统计：数据层 ---- */
function keyErrRows(all){
  return Object.keys(all).map(ch => {
    const r = all[ch];
    return { ch, errs:r.errs, hits:r.hits, rate: r.hits ? r.errs / r.hits : 0 };
  });
}
function keyErrTotals(rows){
  return {
    errs: rows.reduce((a, x) => a + x.errs, 0),
    hits: rows.reduce((a, x) => a + x.hits, 0)
  };
}
/* 薄弱键排序口径：错误率降序，同率比绝对错误数；只取前 8。
   样本门槛与着色一致（KEYERR_MIN_SAMPLE），保证「标红的键必上榜」不矛盾。 */
const KB_WEAK_LIMIT = 8;
function keyErrWeakKeys(rows){
  return rows.filter(x => x.hits >= KEYERR_MIN_SAMPLE && x.errs > 0)
    .sort((a, b) => b.rate - a.rate || b.errs - a.errs).slice(0, KB_WEAK_LIMIT);
}
/* ---- 模板层：三种空态/常态文案集中在此 ---- */
const KB_EMPTY_HTML = '<div class="kb-heat-empty">还没有统计数据，完成一次练习后这里会显示薄弱键位。</div>';
function kbNoWeakHTML(){
  return '<div class="kb-heat-empty">暂无明显薄弱键位（样本不足 ' + KEYERR_MIN_SAMPLE + ' 次的键不计入）。</div>';
}
function kbTotalsHTML(t){
  const overall = (t.errs / t.hits * 100).toFixed(1);
  return '累计敲击 <b>' + t.hits + '</b> 次 · 错误 <b>' + t.errs + '</b> 次 · 整体错误率 <b>' + overall + '%</b>';
}
function kbWeakChipHTML(x){
  const label = x.ch === ' ' ? 'space' : esc(x.ch.toUpperCase());
  return '<span class="kb-heat-chip">' + label + ' <b>' + Math.round(x.rate * 100) + '%</b> ' + x.errs + '/' + x.hits + '</span>';
}
/* ---- 渲染层：三条出口（无数据 / 有量无薄弱 / 有薄弱），文案与结构由上方模板决定 ---- */
function kbHeatSummary(){
  const sum = document.getElementById('kbHeatSum'), top = document.getElementById('kbHeatTop');
  if(!sum || !top) return;
  const rows = keyErrRows(keyErrAll);
  const t = keyErrTotals(rows);
  if(!t.hits){ sum.innerHTML = ''; top.innerHTML = KB_EMPTY_HTML; return; }
  sum.innerHTML = kbTotalsHTML(t);
  const weak = keyErrWeakKeys(rows);
  top.innerHTML = weak.length ? weak.map(kbWeakChipHTML).join('') : kbNoWeakHTML();
}
async function keyErrReset(){
  if(!currentUser) return;
  if(!confirm('清空全部错键统计？此操作不可撤销。')) return;
  try{
    const r = await fetch('/api/keyerrors/reset', { method:'POST' });
    if(!r.ok) throw new Error('status ' + r.status);
    keyErrAll = {}; keyErrLocal = {};
    if(keyErrFlushTimer){ clearTimeout(keyErrFlushTimer); keyErrFlushTimer = 0; }
    kbHeatPaint(); kbHeatSummary();
  }catch(e){ alert('清空失败，请稍后重试'); }
}
/* ---- 下一键提示：文案层（纯函数，无 DOM） ---- */
const KB_HINT_IDLE = '开始输入后，这里会提示应该使用哪根手指';
function kbHeatNote(){ return '按错误率着色，样本不足 ' + KEYERR_MIN_SAMPLE + ' 次的键不着色'; }
/* 三条出口：Shift 组合键 / 普通键 + 手指 / 键盘上没有的字符。
   注意 Shift 判定同时看 ignoreCase——开启忽略大小写后不再要求 Shift。 */
function nextKeyHTML(ch, mapped, ignoreCaseNow){
  if(!mapped) return `下一个字符：<b>${ch.replace(/</g,'&lt;')}</b>`;
  const fname = FINGER_NAME[FINGERS[ch.toLowerCase()]] || '该键对应手指';
  if(/[A-Z]/.test(ch) && !ignoreCaseNow) return `下一个键：<b>Shift + ${ch}</b>（${fname}）`;
  return `下一个键：<b>${ch===' '?'空格':ch.toUpperCase()}</b> → 请使用 <b>${fname}</b>`;
}
/* ---- 渲染层：清旧高亮 → 定文案 → 写两处 → 按需失效几何缓存 ---- */
let _nextKeyEl = null;
function kbClearNextKey(){
  if(_nextKeyEl){ _nextKeyEl.classList.remove('next'); _nextKeyEl = null; }
}
function highlightNextKey(){
  kbClearNextKey();
  const hint = document.getElementById('fingerHint');
  const live = document.getElementById('liveHint');
  // F2：热力视图下键盘底色表达错误率，卡片内的说明行必须恒定解释配色，
  // 否则会被上一次指法文案残留覆盖（「下一键」信息仍由 liveHint 承载）。
  const heat = kbMode === 'heat';
  if(heat) hint.innerHTML = kbHeatNote();
  /* 越界守卫（v2.0 修真实缺陷）：pos 可以等于 text.length ——
     打完最后一字符、或 skipIgnoredChars 把 pos 推到末尾时，updateCursor 仍会调本函数。
     v1.8 只守了 !S.text || S.finished，此时 S.text[S.pos] 为 undefined，
     keyFor(undefined) 抛 TypeError，导致 typeChar 后续的 finish() **永不执行**：
     不限时模式打完全文却拿不到成绩（已用 overflow-isolate.js 取证）。
     故把「已打到末尾」与「无文本/已完成」同等对待：收起提示行，不再读字符。 */
  if(!S.text || S.finished || S.pos >= S.text.length){
    if(!heat) hint.innerHTML = KB_HINT_IDLE;
    live.classList.remove('show');
    return;
  }
  const ch = S.text[S.pos];
  const el = keyFor(ch);
  if(el){ el.classList.add('next'); _nextKeyEl = el; }
  const html = nextKeyHTML(ch, !!el, ignoreCase);
  if(!heat) hint.innerHTML = html;
  live.innerHTML = html;
  const wasShown = live.classList.contains('show');
  live.classList.add('show');
  // 提示行从无到有会改变辅助行占用高度：目标布局缓存失效，落定后的预热帧重新量测
  if(!wasShown) focusMeasureCacheInvalidate();
}

/* ================= 账号与主题 ================= */
let currentUser = null;
let authMode = 'login';
function getStudent(){ return currentUser ? currentUser.display_name : ''; }
/* 网络错误友好化：静态快照主机（如预览面板 static-html）没有后端时，
   把 Failed to fetch 翻译成可操作的提示，避免用户误以为账号或密码问题。 */
function netErrMsg(e){
  const noBackend = () => {
    if(location.protocol === 'file:') return '当前是直接打开的本地 HTML 文件，没有后端服务，登录/成绩接口不可用。请改用同源预览入口或正式地址打开本页。';
    const h = location.hostname;
    if(h !== 'localhost' && h !== '127.0.0.1') return '当前页面打开在没有后端服务的主机上（静态快照不转发登录/成绩接口）。请改用同源预览入口或正式地址打开本页。';
    return '无法连接服务器：请确认服务已启动，或改用同源预览入口/正式地址打开本页。';
  };
  if(e instanceof TypeError) return noBackend();
  if(e instanceof SyntaxError) return '服务器响应异常（当前主机可能没有后端服务）。请改用同源预览入口或正式地址打开本页。';
  return (e && e.message) || '网络异常，请稍后重试';
}
function roleLabel(role){ return role === 'teacher' ? '教师' : '学生'; }
function requireLogin(){
  if(currentUser) return true;
  authShow();
  return false;
}
function setAuthMode(mode){
  authMode = mode;
  document.getElementById('authTabLogin').classList.toggle('active', mode==='login');
  document.getElementById('authTabRegister').classList.toggle('active', mode==='register');
  document.getElementById('displayNameField').classList.toggle('hidden', mode!=='register');
  document.getElementById('authTitle').textContent = mode==='login' ? '登录' : '学生注册';
  document.getElementById('authSubmit').textContent = mode==='login' ? '登录' : '注册并登录';
  document.getElementById('authPassword').setAttribute('autocomplete', mode==='login' ? 'current-password' : 'new-password');
  document.getElementById('authError').textContent = '';
}
/* v2.1：登录弹窗统一到 modal 通道（与结算/改密同节奏）。
   v2.0 时退场已是引擎时长 + CSS authOut，但入场仍是 CSS popIn（只认 full、时长 base），
   开 base / 关 micro 不对称。v2.1 全部改走 modalIn/modalOut：
   入场 base EASE_OUT，退场 base×0.72 EASE，位移互逆，onDone 契约（自然结束才隐藏）。
   所有「摘 hidden 显示登录框」的入口统一走 authShow()，避免漏接入场动画。 */
let authClosing = false;
function authShow(){
  const modal = document.getElementById('authModal');
  const wasHidden = modal.classList.contains('hidden');
  authClosing = false;
  modal.classList.remove('hidden');
  const E = window.StudioMotionEngine;
  if(E && wasHidden) E.modalIn(modal.querySelector('.auth-layout'));
}
function hideAuthModalAnimated(){
  const modal = document.getElementById('authModal');
  const layout = modal.querySelector('.auth-layout');
  if(modal.classList.contains('hidden') || authClosing) return;
  const finish = ()=>{ authClosing = false; modal.classList.add('hidden'); };
  const E = window.StudioMotionEngine;
  if(E && !E.isOff() && layout){
    authClosing = true;
    E.modalOut(layout, { onDone: finish });
  }else finish();
}
async function submitAuth(){
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const displayName = document.getElementById('authDisplayName').value.trim();
  const err = document.getElementById('authError');
  const submit = document.getElementById('authSubmit');
  err.textContent = '';
  submit.disabled = true;
  try{
    const body = authMode==='register' ? {username, password, display_name:displayName} : {username, password};
    const res = await fetch('/api/auth/' + (authMode==='register' ? 'register' : 'login'), {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '操作失败');
    currentUser = data.user;
    updateAuthUI();
    hideAuthModalAnimated();
    syncFavsFromServer();
    syncPrefsFromServer();
    keyErrLocal = {}; keyErrAll = {}; keyErrLoaded = false; // F2：换账号先清空
    keyErrLoad();
    srsLoad(); // F4：拉取复习调度
    if(data.linked_records > 0) alert('已自动关联 ' + data.linked_records + ' 条同名历史成绩。');
    switchTab('daily');
  }catch(e){
    err.textContent = netErrMsg(e);
  }finally{
    submit.disabled = false;
  }
}
/* v2.0 退出登录：分阶段清理管线。
   原 45 行顺序语句 → 四个语义阶段，顺序即契约不可调换：
     ① 关闭浮层（先关弹窗，避免后续 DOM 重绘时弹窗内容闪烁）
     ② 清练习现场（会话/每日/首页句/成绩缓存）
     ③ 清个人数据缓存（错键/SRS/收藏）—— 必须早于 ④ 的重绘
     ④ 重绘与导航（kbHeatPaint 依赖已清空的 keyErrLocal，dailyView 依赖已重置的 D）
   页面隐藏改为遍历 ALL_PAGES，新增页面不再需要改这里。 */
const ALL_PAGES = ['admin','class','course','library','history','test','daily'];

function logoutCloseOverlays(){
  // 顺序与 v1.8 一致：settings/share 先隐藏 → resultSequence++ → modal 隐藏
  // v2.1：全部浮层走强制出口（清在途动画 + 钉终值），避免 logout 后残影
  settingsForceHide();
  shareForceHide();
  resultSequence++;   // 递增以作废在途的成绩渲染回调
  const E = window.StudioMotionEngine;
  const m = document.getElementById('modal');
  if(m){
    const box = m.querySelector('.box');
    if(E && box) E.modalKill(box);
    m.classList.add('hidden');
  }
  // 改密弹窗与登录弹窗同样可能有在途开/合动画，一并清掉再定终态
  const pw = document.getElementById('pwModal');
  if(pw){
    const card = pw.querySelector('.auth-card');
    if(E && card) E.modalKill(card);
    pw.classList.add('hidden');
    pwClosing = false;
  }
  const auth = document.getElementById('authModal');
  if(auth){
    const layout = auth.querySelector('.auth-layout');
    if(E && layout) E.modalKill(layout);
    authClosing = false;   // 终态由 logoutRepaintAndNavigate 的 authShow 决定
  }
}
function logoutClearSessions(){
  resetSession(true);
  lastDailyResult = null;
  lastResult = null;
  historyRecords = [];
  // 清空日常练习现场，避免切换账号后残留上一人的进度
  D.list = []; D.startedAt = null; D.idx = 0; D.busy = false;
  document.getElementById('dailySummary').classList.add('hidden');
  clearTimeout(cardTimer); cardTimer = null;
  exitHomeSentencePractice();
  favCache = null;
}
function logoutClearUserData(){
  // F2/F4：清空本人统计与调度缓存，避免切换账号后残留上一人的数据
  if(keyErrFlushTimer){ clearTimeout(keyErrFlushTimer); keyErrFlushTimer = 0; }
  keyErrLocal = {}; keyErrAll = {}; keyErrLoaded = false;
  srsState = { items:[], due:[], dueCount:0, total:0 }; srsLoaded = false;
}
function logoutRepaintAndNavigate(){
  kbHeatPaint(); kbHeatSummary();
  srsRenderBadge();
  dailyView('practice');   // 离开复盘/生词本，避免残留上一人的数据视图
  document.getElementById('typingSection').classList.add('hidden');
  updateAuthUI();
  // 隐藏全部页面（含教师专属）再单独放行 daily，避免切换账号时页面内容泄漏
  ALL_PAGES.forEach(p => {
    const el = document.getElementById('page-' + p);
    if(el) el.classList.add('hidden');
  });
  selectStudioTab('daily');
  currentTab = 'daily';
  document.getElementById('page-daily').classList.remove('hidden');
  authShow();
}

async function logout(){
  try{ await fetch('/api/auth/logout', {method:'POST'}); }catch(e){}
  currentUser = null;
  logoutCloseOverlays();
  logoutClearSessions();
  logoutClearUserData();
  logoutRepaintAndNavigate();
}
function updateAuthUI(){
  document.getElementById('userDisplay').textContent = currentUser ? (currentUser.display_name + '（' + currentUser.username + '）') : '未登录';
  // 退出登录移入设置面板的账号段；未登录时该段整体隐藏
  const lo = document.getElementById('settingsLogoutBtn');
  if(lo) lo.classList.toggle('hidden', !currentUser);
  const acctTab = document.getElementById('settingsTabAccount');
  if(acctTab) acctTab.classList.toggle('hidden', !currentUser);
  // 未登录强制回外观段。settingsPane 是后文 let 声明，早期调用可能落在暂时性死区，故兜底。
  if(!currentUser){ try{ settingsSection('appearance'); }catch(e){} }
  const isTeacher = !!(currentUser && currentUser.role === 'teacher');
  document.getElementById('tab-class').classList.toggle('hidden', !isTeacher);
  document.getElementById('tab-admin').classList.toggle('hidden', !isTeacher);
}
async function loadSession(){
  try{
    const data = await fetch('/api/auth/me').then(r=>r.json());
    currentUser = data.user || null;
  }catch(e){ currentUser = null; }
  updateAuthUI();
  // 启动定终态：已登录立即隐藏（无动画），未登录走统一入场
  if(currentUser) document.getElementById('authModal').classList.add('hidden');
  else authShow();
  if(currentUser){ syncFavsFromServer(); syncPrefsFromServer(); keyErrLoad(); srsLoad(); switchTab('daily'); }
  // 恢复上次的键盘视图偏好（未登录也可用指法视图）
  let savedKb = 'finger';
  try{ savedKb = localStorage.getItem('typingKbMode') || 'finger'; }catch(e){}
  kbSetMode(savedKb === 'heat' && currentUser ? 'heat' : 'finger');
}
/* 侧栏选中态：active 类与 aria-current 必须同进同退（读屏软件靠后者播报当前页）。
   只操作侧栏按钮，不读页面 hidden —— 故调用方可以在页面尚未显示时先选中。 */
function selectStudioTab(tab){
  const active = document.getElementById('tab-'+tab);
  document.querySelectorAll('.sidebar nav button').forEach(button=>{
    const on = button === active;
    button.classList.toggle('active', on);
    if(on) button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('studioSection').textContent = active.textContent.trim();
}
/* 关闭弹窗后把焦点还给导航：窄屏侧栏收起时汉堡钮可见，聚焦它；
   宽屏汉堡钮 display:none（getClientRects 为空），改聚焦当前 Tab。
   用 getClientRects 而非 offsetParent —— 后者对 position:fixed 元素返回 null 会误判。 */
function focusStudioNavigation(){
  const menu = document.getElementById('menuToggle');
  const target = menu.getClientRects().length ? menu : document.getElementById('tab-'+currentTab);
  if(target) target.focus({preventScroll:true});
}
/* 侧栏开合的三处状态（抽屉 open 类 / 遮罩显隐 / 汉堡钮 aria）必须同拍，
   否则会出现「遮罩在但抽屉已关」或 aria 与实际不符的无障碍问题。 */
function sidebarSetOpen(open){
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('sidebarBackdrop').classList.toggle('hidden', !open);
  document.getElementById('menuToggle').setAttribute('aria-expanded', String(open));
}
function openSidebar(){
  sidebarSetOpen(true);
  document.querySelector('.sidebar nav button.active').focus();
}
/* 焦点还原必须在摘 open 类**之前**：抽屉一旦关闭，其中的焦点元素即不可见，
   此时再判断 aside.contains(activeElement) 会失真，焦点会留在隐藏元素上。
   restoreFocus 为真时强制还原（点遮罩关闭）；否则仅当焦点确实在抽屉内才还原。 */
function closeSidebar(restoreFocus){
  const aside = document.getElementById('sidebar');
  const menu = document.getElementById('menuToggle');
  if(aside.classList.contains('open') && (restoreFocus || aside.contains(document.activeElement))) menu.focus();
  sidebarSetOpen(false);
}
function applyTheme(theme, save){
  document.documentElement.setAttribute('data-theme', theme);
  if(save){ prefLocalSet('theme', theme); pushPref('theme', theme); }
  const lightBtn = document.getElementById('modeLightBtn');
  const darkBtn = document.getElementById('modeDarkBtn');
  if(lightBtn) lightBtn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  if(darkBtn) darkBtn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  const historyPage = document.getElementById('page-history');
  if(currentUser && historyPage && !historyPage.classList.contains('hidden')) drawChart(historyRecords);
  /* 主题变了要重算主题色派生（深色基底随主色派生近黑）。
     这里传 null 表示「用默认主色」，而非 accentHex() 的默认色值 ——
     StudioAccent.apply(null) 内部自取默认，两者等价但保持原调用口径。 */
  if(window.StudioAccent){
    const accent = prefLocalGet('accent');
    StudioAccent.apply(accent && ACCENT_HEX_RE.test(accent) ? accent.toLowerCase() : null, theme === 'dark');
  }
}
function setThemeMode(mode){
  themeCrossfade();
  applyTheme(mode === 'dark' ? 'dark' : 'light', true);
}
/* ---------- 动效档位与主题过渡 ---------- */
function setMotionMode(mode){
  if(!window.StudioMotion) return;
  StudioMotion.set(mode);
  pushPref('motion', mode);
  syncMotionUI();
  if(mode === 'off'){ stopMotionFx(); liveCurveStop(); }
  else if(S.startedAt && !S.finished) liveCurveStart();
}
/* 分段按钮组选中态：一组里恰有一个 aria-pressed=true。
   原先动效/音效风格/主题色三处各写一份同样的 forEach，现统一到此处。
   pairs 是 [元素id, 该按钮代表的值]；缺失的元素静默跳过（面板可能未挂载）。 */
function syncPressedGroup(pairs, current){
  pairs.forEach(([id, val])=>{
    const b = document.getElementById(id);
    if(b) b.setAttribute('aria-pressed', current === val ? 'true' : 'false');
  });
}
const MOTION_BUTTONS = [['motionFullBtn','full'],['motionLiteBtn','lite'],['motionOffBtn','off']];
function syncMotionUI(){
  if(!window.StudioMotion) return;
  syncPressedGroup(MOTION_BUTTONS, StudioMotion.get());
}
/* 环境背景随标签页可见性暂停，避免后台空转耗电 */
document.addEventListener('visibilitychange', ()=>{
  const ab = document.querySelector('.ambient-bg');
  if(ab) ab.style.animationPlayState = document.hidden ? 'paused' : '';
  if(ab) ab.querySelectorAll('i').forEach(el=>{ el.style.animationPlayState = document.hidden ? 'paused' : ''; });
  if(document.hidden) liveCurveStop();
  else if(S.startedAt && !S.finished) liveCurveStart();
  if(document.hidden) keyErrFlush(); // F2：切走前把错键增量落盘
});
window.addEventListener('pagehide', ()=>{ keyErrFlush(); });
let themeXfadeTimer = null;
/* 主题切换的色彩交叉淡入：临时给一批容器挂 transition，过渡结束即摘类。
   v2.0 修时长不同步（与 authOut 同类缺陷）：原 JS 硬编码 420ms 是照旧版 CSS 的 .35s 加余量算的，
   而新版 CSS 已改用 var(--dur-base)=320ms —— 类多挂 100ms，期间任何颜色变化都会被意外拖慢。
   改为从 motion.js 读同一时间源，CSS 与 JS 永远同拍（lite/off 档也自动跟随）。
   余量 +40ms 覆盖过渡收尾帧，避免掐断最后一帧。 */
const THEME_XFADE_SLACK = 40;
function themeCrossfade(){
  if(!window.StudioMotion || StudioMotion.get() !== 'full') return;
  const root = document.documentElement;
  root.classList.add('theme-xfade');
  clearTimeout(themeXfadeTimer);
  const hold = (window.StudioMotionEngine ? StudioMotionEngine.dur('base') : 320) + THEME_XFADE_SLACK;
  themeXfadeTimer = setTimeout(()=>root.classList.remove('theme-xfade'), hold);
}
/* ---------- Canvas 粒子庆祝（full/lite 驱动，off 与减弱动效跳过） ---------- */
let motionFxCanvas = null, motionFxRaf = 0;
function stopMotionFx(){
  if(motionFxRaf){ cancelAnimationFrame(motionFxRaf); motionFxRaf = 0; }
  if(motionFxCanvas){ motionFxCanvas.remove(); motionFxCanvas = null; }
}
function burstParticles(opts){
  if(!window.StudioMotion) return;
  const mode = StudioMotion.get();
  if(mode === 'off' || StudioMotion.reduced()) return;
  stopMotionFx();
  const cv = document.createElement('canvas');
  cv.className = 'motion-fx';
  cv.setAttribute('aria-hidden','true');
  document.body.appendChild(cv);
  motionFxCanvas = cv;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const small = W <= 650;
  let n = opts && opts.n ? opts.n : 150;
  if(mode === 'lite') n = Math.round(n * 0.55);
  if(small) n = Math.round(n * 0.5);
  const css = getComputedStyle(document.documentElement);
  const themeColors = ['--primary','--accent','--ok'].map(k=>css.getPropertyValue(k).trim()).filter(Boolean);
  const colors = ['#f2cf6b','#e2694f','#6bcb77','#4d96ff','#c780fa'].concat(themeColors);
  const cx = opts && opts.x != null ? opts.x : W / 2;
  const cy = opts && opts.y != null ? opts.y : H * 0.42;
  const parts = [];
  for(let i=0;i<n;i++){
    const a = Math.random() * Math.PI * 2;
    const sp = 2.5 + Math.random() * 7.5;
    parts.push({
      x:cx, y:cy,
      vx:Math.cos(a)*sp, vy:Math.sin(a)*sp - 3.2,
      w:4 + Math.random()*6, h:7 + Math.random()*8,
      rot:Math.random()*Math.PI, vr:(Math.random()-.5)*.28,
      color:colors[i % colors.length],
      life:1, decay:.008 + Math.random()*.01,
      round:Math.random() < .3
    });
  }
  let last = performance.now();
  function step(now){
    const dt = Math.min(3, (now - last) / 16.7); last = now;
    ctx.clearRect(0, 0, W, H);
    let alive = false;
    for(const p of parts){
      if(p.life <= 0) continue;
      alive = true;
      p.vy += 0.16 * dt;
      p.vx *= Math.pow(.985, dt);
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= p.decay * dt;
      if(p.y > H + 30){ p.life = 0; continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.4));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if(p.round){ ctx.beginPath(); ctx.arc(0, 0, p.w/2, 0, 7); ctx.fill(); }
      else ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h * (.4 + .6*Math.abs(Math.sin(p.rot*2))));
      ctx.restore();
    }
    if(alive && motionFxCanvas === cv){ motionFxRaf = requestAnimationFrame(step); }
    else { motionFxRaf = 0; if(motionFxCanvas === cv){ cv.remove(); motionFxCanvas = null; } }
  }
  motionFxRaf = requestAnimationFrame(step);
}
/* 破纪录判定：本机最佳 WPM（不影响服务器成绩口径） */
function checkPersonalBest(wpm){
  if(!wpm) return false;
  let best = 0;
  try{ best = parseInt(localStorage.getItem('typingBestWpm') || '0', 10) || 0; }catch(e){}
  if(wpm > best){
    try{ localStorage.setItem('typingBestWpm', String(wpm)); }catch(e){}
    return best > 0; // 首次练习不弹「新纪录」，避免无参照的误导
  }
  return false;
}
function showRecordBadge(id, isRecord){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('hidden', !isRecord);
  if(isRecord) replayCssAnimation(el);
}
/* ---------- 批A：偏好后端同步（本机缓存首屏防闪烁，登录后拉取应用，变更写穿） ---------- */
const PREF_KEYS = {theme:'typingTheme', accent:'typingAccent', motion:'typingMotion', sound:'typingSound', soundStyle:'typingSoundStyle', ignoreCase:'typingIgnoreCase', autoSpeak:'dailyAutoSpeak'};
/* 音效风格白名单：三处共用（启动读缓存 StudioSound.init / 用户切换 setSoundStyle / 服务端同步）。
   主题色格式：applyTheme / accentHex / PREF_HANDLERS.accent / setAccent 四处共用。
   两者都放在偏好常量区，与 PREF_KEYS 同处一屏，便于核对取值域。
   位置上并非被迫前置：唯一的启动期入口是文件末尾的 initTheme()（L2695），
   晚于本处初始化，故放在后段也不会命中 TDZ（已用 tdz-isolate.js 取证：
   TDZ 机制真实存在，但本例原位置本就安全）。这里是可维护性选择，不是缺陷修复。 */
const SOUND_STYLES = ['soft','mech','typewriter'];
const ACCENT_HEX_RE = /^#[0-9a-f]{6}$/i;
const SOUND_STYLE_BUTTONS = [['soundSoftBtn','soft'],['soundMechBtn','mech'],['soundTypeBtn','typewriter']];
/* 开关组用 '1'/'0' 当作两个「值」，即可复用同一个 syncPressedGroup：
   开 → on 键为 '1' 命中；关 → off 键为 '0' 命中。与原先两行手写 if 完全等价。 */
const SOUND_TOGGLE_BUTTONS = [['soundOnBtn','1'],['soundOffBtn','0']];
function prefLocalGet(key){ try{ return localStorage.getItem(PREF_KEYS[key]); }catch(e){ return null; } }
function prefLocalSet(key, val){
  try{
    if(val === null || val === undefined || val === '') localStorage.removeItem(PREF_KEYS[key]);
    else localStorage.setItem(PREF_KEYS[key], val);
  }catch(e){}
}
function pushPref(key, val){
  if(!currentUser) return;
  const out = (val === null || val === undefined) ? '' : String(val);
  try{ if(out === '') localStorage.removeItem(PREF_KEYS[key]); else localStorage.setItem(PREF_KEYS[key], out); }catch(e){}
  fetch('/api/prefs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prefs:{[key]: out}})}).catch(()=>{});
}
/* ===== v2.0 偏好同步：处理器表 =====
   重写要点（原 50 行 7 段 if → 每键一个独立 handler）：
     · 统一语义：服务端空串 = 已恢复默认 → 清本机缓存 + 回落默认（跨设备重置可传播）
     · 每键 handler 签名 (raw) => void，raw 是服务端字符串（可能为 ''）
     · 键的处理顺序与 v1.8 严格一致（theme 必须先于 accent，accent 派生依赖当前主题）
   语义不变量由 12-settings-appearance 基线路径（12 步）守住。 */
const PREF_HANDLERS = {
  theme(raw){
    if(raw === 'light' || raw === 'dark'){ prefLocalSet('theme', raw); applyTheme(raw, false); }
    else if(raw === ''){
      prefLocalSet('theme', null);
      const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(sysDark ? 'dark' : 'light', false);
    }
  },
  accent(raw){
    const hex = /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : '';
    prefLocalSet('accent', hex || null);
    if(window.StudioAccent){
      StudioAccent.apply(hex || null, document.documentElement.getAttribute('data-theme') === 'dark');
      syncAccentUI();
    }
  },
  motion(raw){
    if(!window.StudioMotion) return;
    const mv = (raw === 'full' || raw === 'lite' || raw === 'off') ? raw : 'full';
    if(raw === ''){ prefLocalSet('motion', null); StudioMotion.set(mv); }
    else { prefLocalSet('motion', mv); document.documentElement.setAttribute('data-motion', mv); }
    syncMotionUI();
    if(mv === 'off') stopMotionFx();
    if(S.startedAt && !S.finished){ if(mv === 'off') liveCurveStop(); else liveCurveStart(); }
  },
  ignoreCase(raw){
    if(raw === ''){ prefLocalSet('ignoreCase', null); ignoreCase = false; }
    else { prefLocalSet('ignoreCase', raw); ignoreCase = raw === '1'; }
    const cb = document.getElementById('ignoreCaseToggle');
    if(cb) cb.checked = ignoreCase;
  },
  autoSpeak(raw){
    prefLocalSet('autoSpeak', raw === '' ? null : raw);
  },
  sound(raw){
    if(raw === ''){ prefLocalSet('sound', null); StudioSound.enabled = true; }
    else { prefLocalSet('sound', raw); StudioSound.enabled = raw === '1'; }
  },
  soundStyle(raw){
    if(raw === ''){ prefLocalSet('soundStyle', null); StudioSound.style = 'soft'; }
    else if(SOUND_STYLES.indexOf(raw) >= 0){ prefLocalSet('soundStyle', raw); StudioSound.style = raw; }
  },
};
// 顺序即契约：theme → accent → motion → ignoreCase → autoSpeak → sound → soundStyle
const PREF_SYNC_ORDER = ['theme','accent','motion','ignoreCase','autoSpeak','sound','soundStyle'];

async function syncPrefsFromServer(){
  if(!currentUser) return;
  try{
    const res = await fetch('/api/prefs');
    if(!res.ok) return;
    const data = await res.json();
    const p = data.prefs || {};
    // 本机有、服务端没有的键：首次同步时把本机偏好上传（老用户平滑迁移）
    const missing = {};
    Object.keys(PREF_KEYS).forEach(k=>{
      if(!(k in p)){ const lv = prefLocalGet(k); if(lv !== null) missing[k] = lv; }
    });
    if(Object.keys(missing).length){
      fetch('/api/prefs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prefs:missing})}).catch(()=>{});
    }
    for(const k of PREF_SYNC_ORDER){
      if(k in p) PREF_HANDLERS[k](p[k]);
    }
    syncSoundUI();
  }catch(e){}
}
/* ---------- 批A：按键音效（WebAudio 合成，默认开·柔和，三风格） ---------- */
const StudioSound = {
  ctx:null, enabled:true, style:'soft',
  init(){
    const s = prefLocalGet('sound'); this.enabled = s === null ? true : s === '1';
    const st = prefLocalGet('soundStyle'); this.style = SOUND_STYLES.indexOf(st) >= 0 ? st : 'soft';
  },
  unlock(){
    if(!this.enabled) return;
    if(!this.ctx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      try{ this.ctx = new AC(); }catch(e){ return; }
    }
    if(this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});
  },
  _env(g, t0, a, peak, dur){
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  },
  _tone(freq, type, peak, dur, when){
    const c = this.ctx; if(!c) return;
    const t0 = c.currentTime + (when || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    this._env(g, t0, 0.004, peak, dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  _noise(peak, dur, filterFreq, when){
    const c = this.ctx; if(!c) return;
    const t0 = c.currentTime + (when || 0);
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i] = (Math.random()*2-1) * (1 - i/len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = filterFreq; f.Q.value = 0.9;
    const g = c.createGain(); this._env(g, t0, 0.002, peak, dur);
    src.connect(f); f.connect(g); g.connect(c.destination);
    src.start(t0);
  },
  key(ok){
    if(!this.enabled) return;
    this.unlock(); if(!this.ctx || this.ctx.state !== 'running') return;
    if(!ok){ this._tone(150, 'sine', 0.10, 0.11); return; }
    if(this.style === 'mech'){ this._noise(0.09, 0.035, 2600); this._tone(210, 'triangle', 0.05, 0.05); }
    else if(this.style === 'typewriter'){ this._noise(0.11, 0.025, 3800); this._tone(520, 'square', 0.022, 0.03); }
    else { this._tone(660 + Math.random()*60, 'sine', 0.055, 0.06); }
  },
  backspace(){
    if(!this.enabled) return;
    this.unlock(); if(!this.ctx || this.ctx.state !== 'running') return;
    this._tone(340, 'sine', 0.04, 0.05);
  },
  complete(){
    if(!this.enabled) return;
    this.unlock(); if(!this.ctx || this.ctx.state !== 'running') return;
    [523.25, 659.25, 783.99].forEach((f,i)=>this._tone(f, 'sine', 0.07, 0.16, i*0.09));
  }
};
function setSoundOn(on){
  StudioSound.enabled = !!on;
  prefLocalSet('sound', on ? '1' : '0'); pushPref('sound', on ? '1' : '0');
  if(on){ StudioSound.unlock(); StudioSound.key(true); }
  syncSoundUI();
}
function setSoundStyle(style){
  if(SOUND_STYLES.indexOf(style) < 0) return;
  StudioSound.style = style;
  prefLocalSet('soundStyle', style); pushPref('soundStyle', style);
  StudioSound.unlock(); StudioSound.key(true);
  syncSoundUI();
}
function syncSoundUI(){
  const on = StudioSound.enabled;
  syncPressedGroup(SOUND_TOGGLE_BUTTONS, on ? '1' : '0');
  const label = document.getElementById('soundStateLabel');
  if(label) label.textContent = on ? '开' : '关';
  syncPressedGroup(SOUND_STYLE_BUTTONS, StudioSound.style);
}
/* ---------- 专注模式：一镜到底（focusDolly） ----------
   0 正常 / 1 半专注 / 2 全屏，三者共用一条连续时间线。
   卡片外框 left/top/width/height 全程连续插值（不用 scale，文字不畸变、不糊），
   落定帧几何与目标静态布局完全重合 —— 没有第二次起跳，也没有落定突跳。
   页头、页标题、侧栏、光斑、键盘、胶囊全部挂在同一条时间线上。

   边框位置关系（v1.8 重写的核心）：内部组件绝不冻结在起点值——
   文本区 border-box 宽每帧等于「当帧卡片内容盒宽」，高每帧等于「当帧内容盒高减去其余组件」，
   辅助行高度/外边距、卡片内边距/描边、曲线/进度条尺寸全部同拍插值。
   于是任何一帧里组件右缘/底缘都贴着边框内缘：推近不留白缝、拉远不穿出边框。
   代价是文本随宽度逐帧换行（单次帧内布局），用合成层提层压住Paint成本，帧率门禁实测达标。
   两端（起点/终点）都量真实静态布局（隐藏辅助行用离屏探针补自然高度，探针只在预热/起镜帧），
   落定交还 CSS 时几何完全重合，零突跳。
   中断安全：起点取「当前已写入的视觉值」，快速连按 Esc 从现状续接。 */
let focusLevel = 0;
let focusDollyRaf = 0;
let focusDollyDefer = 0;    // 0→1 延后一帧起镜的句柄（让建 DOM 的首布局先完成）
let focusDollyGen = 0;      // 镜头代号：每次起镜自增，过期 step 凭此自动退出（中断/连按 Esc 防竞态）
let focusDollyNow = null;   // 飞行中最近一帧写入的镜头状态
/* v2.0：时长与缓动改由 motion.js 统一令牌供给，与 Tab 转场/弹窗/卡片同一套节奏。
   原值 520/400ms + easeInOutCubic 已并入 --dur-macro(500ms) + cubic-bezier(.32,.72,0,1)。
   注意：这里只换「时间源」，逐帧几何插值逻辑一律不动 ——
   文本需随宽度重排、canvas 需每帧重绘、打字焦点不能断，
   这三条决定了专注模式必须走逐帧通道而非 FLIP 克隆层。 */
const FOCUS_DOLLY_MS = 500;
const FOCUS_DOLLY_SHORT = 380;
const FOCUS_EASE = t => (window.StudioMotionEngine ? StudioMotionEngine.ease(t)
                        : (t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2));
const focusEl = id => document.getElementById(id);
const focusCard = () => document.querySelector('#typingSection > .typing-card');
const FOCUS_AUX_IDS = ['panelKicker','sessionHeader','materialTitle','liveHint','liveStats'];
const FOCUS_GAP_IDS = FOCUS_AUX_IDS.concat(['typeArea','liveCurveWrap','progressBar']);
const FOCUS_AUX_DISPLAY = {liveStats:'grid', sessionHeader:'flex'};
/* 读计算样式的数值：'auto'/'none'/'' 等 parseFloat 得 NaN，一律回落 fallback。
   几何插值全程用它取值 —— 直接 parseFloat 会把 NaN 带进 lerp，整条镜头变成 NaN px。 */
function focusNum(el, prop, fallback){
  const v = parseFloat(getComputedStyle(el)[prop]);
  return isFinite(v) ? v : fallback;
}
/* 离屏探针的固定样式：绝对定位移出视口 + visibility:hidden（仍参与布局计算，
   与 display:none 不同，这才能量到高度）+ 解除高度上限与裁剪。
   左右 margin 归零：探针挂在 body 下，避免继承卡片内的水平居中 margin 影响宽度。 */
const FOCUS_PROBE_BASE = 'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
const FOCUS_PROBE_BOX = 'height:auto;max-height:none;opacity:1;overflow:visible;margin-left:0;margin-right:0';
function focusAuxNatural(id, width){
  // display:none 的元素 rect 为 0，用离屏探针量自然高度（探针不入文档流，不影响画面）
  const el = focusEl(id);
  if(!el) return {h:0, mt:0, mb:0};
  const probe = el.cloneNode(true);
  // 摘掉自身与后代的所有 id：否则会与真实节点重复，getElementById 可能命中探针
  probe.removeAttribute('id');
  probe.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  probe.style.cssText = FOCUS_PROBE_BASE +
    'display:' + (FOCUS_AUX_DISPLAY[id] || 'block') + ';width:' + Math.max(1, width) + 'px;' + FOCUS_PROBE_BOX;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const out = {h: probe.getBoundingClientRect().height, mt: parseFloat(cs.marginTop)||0, mb: parseFloat(cs.marginBottom)||0};
  probe.remove();
  return out;
}
/* 采集镜头状态：卡片视口几何 + 四边内边距/描边/圆角 + 辅助行高度透明度 + 文本区/曲线/进度条尺寸。
   natural=true 时把隐藏辅助行的自然高度用离屏探针补回（收拢/展开动画的另一端需要真实高度）。
   边框四边单独记录：飞行中 border 宽度逐帧插值（半专注 1px ↔ 全屏 0px），
   内部组件的可用空间必须按「当帧」的 border+padding 推导，边框与内容的位置关系才全程成立。 */
function focusSnapshot(natural){
  const card = focusCard();
  const r = card.getBoundingClientRect();
  const area = focusEl('typeArea'), curve = focusEl('liveCurveWrap'), prog = focusEl('progressBar');
  const innerW = Math.max(1, card.clientWidth - focusNum(card,'paddingLeft',0) - focusNum(card,'paddingRight',0));
  const aux = FOCUS_AUX_IDS.map(id=>{
    const el = focusEl(id);
    if(!el) return {id, h:0, o:0, mt:0, mb:0};
    const cs = getComputedStyle(el);
    if(cs.display === 'none'){
      const nat = natural ? focusAuxNatural(id, innerW) : {h:0, mt:0, mb:0};
      return {id, h:nat.h, o:0, mt:nat.mt, mb:nat.mb};
    }
    return {id, h: el.getBoundingClientRect().height, o: focusNum(el,'opacity',1),
            mt: focusNum(el,'marginTop',0), mb: focusNum(el,'marginBottom',0)};
  });
  return {
    left:r.left, top:r.top, width:r.width, height:r.height,
    padT:focusNum(card,'paddingTop',0), padR:focusNum(card,'paddingRight',0),
    padB:focusNum(card,'paddingBottom',0), padL:focusNum(card,'paddingLeft',0),
    bdT:focusNum(card,'borderTopWidth',0), bdR:focusNum(card,'borderRightWidth',0),
    bdB:focusNum(card,'borderBottomWidth',0), bdL:focusNum(card,'borderLeftWidth',0),
    radius:focusNum(card,'borderTopLeftRadius',0),
    areaH: area.getBoundingClientRect().height,
    areaPadT:focusNum(area,'paddingTop',0), areaPadR:focusNum(area,'paddingRight',0),
    areaPadB:focusNum(area,'paddingBottom',0), areaPadL:focusNum(area,'paddingLeft',0),
    areaBdT:focusNum(area,'borderTopWidth',0), areaBdR:focusNum(area,'borderRightWidth',0),
    areaBdB:focusNum(area,'borderBottomWidth',0), areaBdL:focusNum(area,'borderLeftWidth',0),
    areaMt:focusNum(area,'marginTop',0), areaMb:focusNum(area,'marginBottom',0),
    curveH: focusNum(curve,'height',0), curveMt:focusNum(curve,'marginTop',0), curveMb:focusNum(curve,'marginBottom',0),
    progH: prog.getBoundingClientRect().height, progMt:focusNum(prog,'marginTop',0), progMb:focusNum(prog,'marginBottom',0),
    aux,
    /* 真实相邻间隙（见 focusGaps）：飞行态用它替代 margin 之和，规避外边距折叠差异 */
    gaps: focusGaps()
  };
}
/* 量每个组件「上方真实间隙」＝ 它与上一个可见兄弟底边的距离（首个组件取到内容盒顶）。
   为什么不能直接用 marginTop+marginBottom（末尾帧跳变根因之三）：
   静态流内卡片是 block，相邻兄弟垂直 margin 会**折叠**（实测 materialTitle.mb 8 +
   liveHint.mt 8 实际只占 8px）；飞行中卡片是 flex，margin **不折叠**。
   按 margin 之和算占用会多算折叠量 → 文本区被算矮 → 落定切回 block 折叠生效，
   文本区突然长高 8~17px。改为「飞行时 marginTop=真实间隙、marginBottom=0」，
   flex 下的总占用与静态渲染恒等，落定零突跳，且组件位置逐帧与静态一致。
   只在快照时量（预热/起镜帧），飞行中插值常数，不额外触发重排。 */
function focusGaps(){
  const card = focusCard();
  const cr = card.getBoundingClientRect();
  const top0 = cr.top + focusNum(card,'borderTopWidth',0) + focusNum(card,'paddingTop',0);
  const out = {};
  let prevBottom = top0;
  FOCUS_GAP_IDS.forEach(id=>{
    const el = focusEl(id);
    if(!el){ out[id] = 0; return; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if(cs.display === 'none' || r.height <= 0){ out[id] = 0; return; }
    out[id] = Math.max(0, r.top - prevBottom);
    prevBottom = r.bottom;
  });
  return out;
}
/* 逐帧内联值的临时摘除/还原（量测目标布局时用，同一帧内完成，用户不可见） */
function focusInlineEls(){
  // 卡片 + 全部参与插值的组件（顺序即 FOCUS_GAP_IDS 顺序，便于对照快照）
  return [focusCard()].concat(FOCUS_GAP_IDS.map(focusEl)).filter(Boolean);
}
/* 量测期间必须冻结「布局类」CSS 过渡，否则读到的是过渡中间态而非目标终态。
   反面教训（末尾帧跳变 bug 根因之一）：.main 的 margin-left 带 .42s 过渡，
   仅由 html.focus-dolly .main{transition:none} 压制；而量测窗口会先摘掉 focus-dolly 类，
   过渡随即复活 —— 0→1 量到 mainX=224（侧栏仍占位的起始值），落定却是 0，
   于是卡片在末帧横向瞬移 159px。故量测时显式把 .main/.wrap/.sidebar 的过渡钉成 none。 */
const FOCUS_LAYOUT_ELS = () => [document.querySelector('.main'), document.querySelector('.wrap'),
                                document.querySelector('.sidebar')].filter(Boolean);
function focusFreezeLayout(saved){
  FOCUS_LAYOUT_ELS().forEach(el=>{
    saved.push([el, el.getAttribute('style')]);
    el.style.transition = 'none';
  });
}
function focusStripInline(){
  const card = focusCard();
  const els = focusInlineEls();                 // 只取一次：两次调用之间若有 DOM 变动会摘错节点
  const saved = els.map(el=>[el, el.getAttribute('style')]);
  els.forEach(el=>el.removeAttribute('style'));
  if(card) card.classList.remove('focus-dolly');
  focusFreezeLayout(saved);
  return saved;
}
function focusRestoreInline(saved){
  // 空串等价于无样式：还原成 removeAttribute，避免留下 style="" 残迹（落定清理断言要求 null）
  saved.forEach(([el, style])=>{ if(style) el.setAttribute('style', style); else el.removeAttribute('style'); });
  focusNormalizeEmpty();
}
/* 量测会临时摘除/还原内联样式，个别浏览器在 removeProperty 后留下 style="" 空属性。
   空属性与无样式等价但 getAttribute 返回 "" 而非 null，统一抹掉，保证落定后彻底干净。 */
function styleIsEmpty(el){ return el.getAttribute('style') === ''; }
function focusNormalizeEmpty(){
  focusInlineEls().forEach(el=>{ if(styleIsEmpty(el)) el.removeAttribute('style'); });
}
/* 注：曾有 focusFlowWidth(level) 用公式（clientWidth − 侧栏宽 − wrap padding）推算流内宽度。
   已删除 —— 公式与实际布局会差一个滚动条宽或 CSS 过渡中间态，是末尾帧横向瞬移的来源。
   现在卡片在量测窗口内保持流内 block 原样，宽高直接由真实布局给出，无需推算。 */
/* 目标量测缓存：量一次目标静态布局要强制同步重排（含离屏探针），在按键任务里做会成长任务。
   同一视口+同一文本下目标布局不变，缓存起来供后续镜头复用；视口尺寸或文本长度变化时失效。 */
let focusMeasureCache = {};
let focusMeasureCacheKey = '';
function focusMeasureCacheInvalidate(){ focusMeasureCache = {}; focusMeasureCacheKey = ''; }
function focusMeasureCacheSig(){
  return window.innerWidth + 'x' + window.innerHeight + '|' + (S.text ? S.text.length : 0) + '|' + (S.level || '');
}
/* 缓存签名校验：视口/文本/难度任一变化就整体作废。两个量测入口共用同一口径。 */
function focusMeasureCacheSync(){
  const sig = focusMeasureCacheSig();
  if(sig !== focusMeasureCacheKey){ focusMeasureCache = {}; focusMeasureCacheKey = sig; }
}
/* ---- 量测窗口：进入/退出成对使用，中间读的 rect 即目标档真实静态布局 ----
   进入：记住 root 三个焦点类 → 摘掉全部内联（并冻结布局过渡）→ 切到目标档。
   退出：还原三个类 → 还原内联 → 若原本在飞行中，把卡片的 focus-dolly 类补回。
   两步顺序不可换：先还原类再还原内联，否则内联还原时 CSS 仍处在目标档，
   个别属性（如 border）会被目标档规则重新覆盖。 */
function focusMeasureEnter(level){
  const root = document.documentElement, card = focusCard();
  const keep = {
    half: root.classList.contains('focus-half'),
    full: root.classList.contains('focus-full'),
    dolly: root.classList.contains('focus-dolly')
  };
  const saved = focusStripInline();
  root.classList.remove('focus-dolly');
  root.classList.toggle('focus-half', level === 1);
  root.classList.toggle('focus-full', level === 2);
  return { root, card, keep, saved };
}
function focusMeasureExit(w){
  w.root.classList.toggle('focus-half', w.keep.half);
  w.root.classList.toggle('focus-full', w.keep.full);
  w.root.classList.toggle('focus-dolly', w.keep.dolly);
  focusRestoreInline(w.saved);
  if(w.keep.dolly && w.card) w.card.classList.add('focus-dolly');
}
/* 量目标级别的静态布局作为镜头终点，量完立刻还原当前视觉。
   内部组件与外框同拍插值（边框位置关系全程成立），两端都必须是真实静态布局：
   隐藏辅助行用离屏探针补自然高度（natural=true）。探针成本只落在预热帧——
   起镜时缓存已由 focusPrewarm 备好；飞行中绝不预热（focusPrewarmCancel）。 */
function focusMeasureTarget(level){
  focusMeasureCacheSync();
  if(focusMeasureCache['t' + level]) return JSON.parse(JSON.stringify(focusMeasureCache['t' + level]));
  const w = focusMeasureEnter(level);
  const card = w.card;
  let shot;
  if(level === 2){
    // 全屏态本就是 flex + absolute 铺满视口，直接量即真实静态布局
    shot = focusSnapshot(true);
    shot.aux.forEach(a=>{ a.h = 0; a.o = 0; a.mt = 0; a.mb = 0; });
    FOCUS_AUX_IDS.forEach(id=>{ shot.gaps[id] = 0; });
  } else {
    /* 流内档位（0/1）必须在「真实静态流布局」下量，不能临时改 fixed：
       ① 位置：卡片留在流内，切到目标类且布局过渡已冻结，rect 即落定真值
          （曾因 .main 的 margin-left 过渡未冻结而量到起始值，末帧横移 159px）；
       ② 内部间隙：静态卡片是 block，相邻 margin 会折叠；改 fixed 会变 flex 不折叠，
          量出的间隙偏大，落定折叠生效后文本区突然长高。故保持 block 原样量。 */
    card.style.visibility = 'hidden';   // 同帧内量完即还原，用户不可见
    const flowR = card.getBoundingClientRect();
    focusMeasureCache['r' + level] = {left: flowR.left, top: flowR.top + window.scrollY};
    shot = focusSnapshot(true);
    if(level === 1){
      // 半专注：统计格收起（胶囊已接管）。它已是 display:none，
      // 其下方组件的间隙在快照里已按「上一个可见兄弟」算好，无需再修正。
      shot.aux.forEach(a=>{ if(a.id === 'liveStats'){ a.h = 0; a.o = 0; a.mt = 0; a.mb = 0; } });
      shot.gaps.liveStats = 0;
    }
    card.style.visibility = '';
  }
  focusMeasureExit(w);
  focusMeasureCache['t' + level] = shot;
  return JSON.parse(JSON.stringify(shot));
}
/* 预热目标量测缓存：把 0/1/2 三档目标布局量好缓存，起镜时直接命中。
   单次量测要强制同步重排（实测 30~70ms），故「每帧只量一项」摊到多个空闲帧。
   铁律：飞行期间一律不预热 —— 起镜时 focusDolly 会调 focusPrewarmCancel() 撤销在途预热，
   落定后再 focusPrewarm() 重排。否则预热帧与镜头帧相撞，实测把 0→1 拖到 45fps。 */
let focusPrewarmRaf = 0;
function focusPrewarmCancel(){
  if(focusPrewarmRaf){ cancelAnimationFrame(focusPrewarmRaf); focusPrewarmRaf = 0; }
}
/* 预热是否可继续：练习页在渲染 + 有文本 + 当前不在飞行（含尚未起飞的延后镜头）。
   飞行中一律退出，落定后 focusDolly 会重新排预热 —— 否则预热帧与镜头帧相撞掉帧。 */
function focusPrewarmAllowed(){
  if(!kbPanelVisible('typingSection') || !S.text) return false;
  return !focusDollyNow && !focusDollyDefer;
}
const FOCUS_PREWARM_LEVELS = [0, 1, 2];
function focusPrewarm(){
  focusPrewarmCancel();
  // 0/1 档的流内位置已在 focusMeasureTarget 内顺带量好，无需单独的 flowRect 任务
  let i = 0;
  const runOne = ()=>{
    focusPrewarmRaf = 0;
    if(!focusPrewarmAllowed()) return;
    try{ focusMeasureTarget(FOCUS_PREWARM_LEVELS[i]); }catch(e){}
    i++;
    if(i < FOCUS_PREWARM_LEVELS.length) focusPrewarmRaf = requestAnimationFrame(runOne);
  };
  focusPrewarmRaf = requestAnimationFrame(runOne);
}
/* 目标流内态的卡片视口位置：临时把卡片放回文档流读一次 rect（同帧还原） */
function focusFlowRect(level){
  focusMeasureCacheSync();
  if(focusMeasureCache['r' + level]) return Object.assign({}, focusMeasureCache['r' + level]);
  const w = focusMeasureEnter(level);
  // liveStats 的隐藏由 focus-half 类的 CSS（display:none）负责，无需再写内联——
  // 写后再 removeProperty 会留下 style="" 残迹，故这里只读 rect，不碰 liveStats 样式。
  const r = w.card.getBoundingClientRect();
  const out = {left:r.left, top:r.top + window.scrollY};
  focusMeasureExit(w);
  focusMeasureCache['r' + level] = out;
  return Object.assign({}, out);
}
/* 飞行中逐帧应用镜头状态。边框位置关系的核心不变量：
   ① 文本区 border-box 宽 == 当帧卡片内容盒宽（右缘永远贴着边框内缘，不钉死起点宽）；
   ② 文本区高 = 当帧卡片内容盒高 − 其余组件占用（底缘永远贴着边框内缘，不冻结起点高）；
   ③ 辅助行/曲线/进度条的高度与外边距、卡片内边距与描边全部同拍插值。
   文本区宽度随外框逐帧变化会触发换行重排——这是「边框关系正确」的必要代价，
   用合成层提层 + 单帧单次布局把成本压住（实测见 dolly-perf 门禁）。 */
function focusDollyApply(s){
  const card = focusCard();
  card.style.left = s.left + 'px';
  card.style.top = s.top + 'px';
  card.style.width = s.width + 'px';
  card.style.height = s.height + 'px';
  card.style.padding = s.padT + 'px ' + s.padR + 'px ' + s.padB + 'px ' + s.padL + 'px';
  card.style.borderRadius = s.radius + 'px';
  card.style.borderWidth = s.bdT + 'px ' + s.bdR + 'px ' + s.bdB + 'px ' + s.bdL + 'px';
  /* 垂直账目一律用「真实上方间隙」gaps，不用 margin 之和：
     飞行态卡片是 flex（margin 不折叠），静态流内卡片是 block（相邻 margin 折叠）。
     把每个组件写成 marginTop=真实间隙、marginBottom=0，flex 下总占用与静态恒等，
     落定交还 CSS 时不会因折叠差异而突跳。 */
  const g = s.gaps || {};
  let occ = 0;
  s.aux.forEach(a=>{
    const el = focusEl(a.id);
    if(!el) return;
    if(a.h <= .3 && a.o <= .01){
      el.style.display = 'none';
      el.style.height = '0px'; el.style.marginTop = '0px'; el.style.marginBottom = '0px'; el.style.opacity = '0';
      return;
    }
    const gap = g[a.id] || 0;
    el.style.display = FOCUS_AUX_DISPLAY[a.id] || 'block';
    el.style.height = a.h + 'px';
    el.style.marginTop = gap + 'px';
    el.style.marginBottom = '0px';
    el.style.opacity = a.o;
    el.style.overflow = 'hidden';
    el.style.pointerEvents = a.o < .5 ? 'none' : '';
    occ += a.h + gap;
  });
  const area = focusEl('typeArea');
  const areaGap = g.typeArea || 0;
  area.style.padding = s.areaPadT + 'px ' + s.areaPadR + 'px ' + s.areaPadB + 'px ' + s.areaPadL + 'px';
  area.style.borderWidth = s.areaBdT + 'px ' + s.areaBdR + 'px ' + s.areaBdB + 'px ' + s.areaBdL + 'px';
  area.style.marginTop = areaGap + 'px';
  area.style.marginBottom = '0px';
  area.style.maxHeight = 'none';
  area.style.minHeight = '0';
  area.style.overflow = 'hidden';
  /* ② 高度一律写显式值、且不做 floor（末尾帧跳变根因之五）：
     全屏静态态 flex:1 1 auto 会把剩余空间按**分数**精确分配（实测 762.844px），
     飞行态若 Math.floor 成 762px，落定就多出 0.844px，曲线/进度条随之位移。
     曾试过飞行态也用 flex:1 1 auto 让浏览器同算法分配 —— 反而更差（13.6px）：
     flex 会把曲线/进度条也当可伸缩项参与分配，与逐帧插值的固定高度打架。
     正解：保持 flex:0 0 auto + 显式分数高度，剩余量自己算准即可。 */
  area.style.flex = '0 0 auto';
  // ① 宽度：border-box 口径钉到当帧内容盒宽，padding/border 变化不影响外缘位置。
  // floor 取整：浏览器把元素宽向上取整到布局像素，ceil 会让右缘超出内缘 1px。
  const innerW = Math.max(1, s.width - s.bdL - s.bdR - s.padL - s.padR);
  area.style.boxSizing = 'border-box';
  area.style.width = Math.floor(innerW) + 'px';
  const curve = focusEl('liveCurveWrap');
  const curveGap = g.liveCurveWrap || 0;
  curve.style.height = s.curveH + 'px';
  curve.style.marginTop = curveGap + 'px';
  curve.style.marginBottom = '0px';
  const prog = focusEl('progressBar');
  const progGap = g.progressBar || 0;
  prog.style.height = s.progH + 'px';
  prog.style.marginTop = progGap + 'px';
  prog.style.marginBottom = '0px';
  // ③ 高度：内容盒高减去其余组件及其真实间隙，剩余全部给文本区。
  // 不 floor：静态终态（flex 填满 / block 封顶）都可能是分数像素，
  // 取整会让末帧比落定值矮零点几像素，曲线与进度条跟着位移。
  // 宽度仍 floor（浏览器把元素宽向上取整，ceil 会让右缘越界 1px）。
  const innerH = Math.max(1, s.height - s.bdT - s.bdB - s.padT - s.padB);
  const areaH = Math.max(0, innerH - occ - areaGap - s.curveH - curveGap - s.progH - progGap);
  area.style.height = areaH + 'px';
}
function focusChromeEls(){
  return {
    hdr: document.querySelector('.studio-header'),
    heading: document.querySelector('.page:not(.hidden) .page-heading') || document.querySelector('.page-heading'),
    kb: focusEl('keyboard'),
    amb: Array.from(document.querySelectorAll('.ambient-bg i')),
    cap: focusEl('focusCapsule'),
    ex: focusEl('focusExit'),
    footer: document.querySelector('.studio-footer')
  };
}
/* 停时钟 + 作废在途镜头：代号自增让任何过期 step 自行退出（含尚未起飞的延后镜头）。
   连按 Esc / 中断续接都靠这一步防竞态，必须先停 raf 再自增。 */
function focusDollyAbort(){
  if(focusDollyRaf){ cancelAnimationFrame(focusDollyRaf); focusDollyRaf = 0; }
  if(focusDollyDefer){ cancelAnimationFrame(focusDollyDefer); focusDollyDefer = 0; }
  focusDollyGen++;
  focusDollyNow = null;
}
/* chrome 各元素要交还的内联属性清单（顺序即清理顺序）。
   页头/页标题/页脚用 visibility 而非 display 承载隐藏，故两者都要清；
   键盘用 display；光斑与胶囊/退出钮只有 opacity。 */
function focusChromeRelease(c){
  return [
    { els: [c.hdr, c.heading, c.footer], props: ['opacity','visibility'] },
    { els: [c.kb],                     props: ['opacity','display'] },
    { els: c.amb,                      props: ['opacity'] },
    { els: [c.cap, c.ex],              props: ['opacity'] }
  ];
}
function focusDollyClear(){
  focusDollyAbort();
  const root = document.documentElement;
  root.classList.remove('focus-dolly');
  const card = focusCard();
  if(card) card.classList.remove('focus-dolly');
  focusInlineEls().forEach(el=>el.removeAttribute('style'));
  focusNormalizeEmpty();
  const c = focusChromeEls();
  // 落定防「二次淡入」：chrome 带 CSS 过渡（opacity .36s 等）。飞行末帧 chrome 已落在目标透明度，
  // 与静态 CSS 值一致，清内联不会触发过渡；但为防个别浏览器从末值再过渡一遍，先以 transition:none
  // 清值（同帧提交静态终值），下一帧再交还 CSS 过渡。不做强制重排，避免落定帧长任务。
  const groups = focusChromeRelease(c);
  const chrome = groups.reduce((a, g) => a.concat(g.els), []).filter(Boolean);
  chrome.forEach(el=>{ el.style.transition = 'none'; });
  groups.forEach(g => g.els.forEach(el => {
    if(el) g.props.forEach(p => el.style.removeProperty(p));
  }));
  requestAnimationFrame(()=>{ chrome.forEach(el=>{ el.style.removeProperty('transition'); if(styleIsEmpty(el)) el.removeAttribute('style'); }); });
}
/* 一次连续镜头：from（当前视觉）→ to（目标静态布局），单一时钟单一缓动。 */
function focusDolly(level, duration){
  const root = document.documentElement, card = focusCard();
  // 中断安全：先停掉上一条镜头的时钟再自增代号——过期 step 凭代号自动退出，
  // 不会与新镜头同时写值，也不会在落定时用旧目标覆盖新状态（连按 Esc 防竞态）。
  if(focusDollyRaf){ cancelAnimationFrame(focusDollyRaf); focusDollyRaf = 0; }
  if(focusDollyDefer){ cancelAnimationFrame(focusDollyDefer); focusDollyDefer = 0; }
  focusPrewarmCancel();   // 飞行期间绝不预热：撤销在途量测，落定后重排
  const gen = ++focusDollyGen;
  const flying = !!focusDollyNow;
  // 起点 natural=true：隐藏辅助行补自然高度，收拢/展开两端才是真实静态布局。
  // 探针成本落在起镜帧（0→1 约一次重排），预热缓存命中时目标端零探针。
  const from = flying ? focusDollyNow : focusSnapshot(true);
  // chrome 起点必须在切换目标类「之前」读：此刻 DOM 仍是上一档的静态类，
  // 计算值即真实视觉（0→1 时页头/键盘=1，1→2 时已=0）。切类后再读会拿到目标值导致瞬隐而非淡出。
  const c = focusChromeEls();
  const opNow = el => el ? (getComputedStyle(el).display === 'none' ? 0 : focusNum(el,'opacity',1)) : 0;
  const chromeFrom = {hdr:opNow(c.hdr), heading:opNow(c.heading), kb:opNow(c.kb),
                      amb:c.amb.length ? focusNum(c.amb[0],'opacity',1) : 1, cap:opNow(c.cap), footer:opNow(c.footer)};
  const to = focusMeasureTarget(level);
  if(level < 2){
    // 流内终点：卡片真实文档位置（换算成视口坐标，镜头期间用 fixed 承载）
    const rect = focusFlowRect(level);
    to.left = rect.left;
    to.top = rect.top - window.scrollY;
    // 辅助行高度/外边距与外框同拍插值（focusMeasureTarget 已给自然高度），此处只定终点透明度。
    // 半专注下 liveStats 收起（胶囊已接管），其余辅助行在 0/1 档均可见。
    to.aux.forEach(a=>{ a.o = (level === 1 && a.id === 'liveStats') ? 0 : 1; });
  }
  // 起镜：先挂飞行类（CSS 转 fixed/flex 承载逐帧值），再切目标档位类。顺序不可换。
  root.classList.add('focus-dolly');
  card.classList.add('focus-dolly');
  focusRootLevel(level);
  const chromeTo = {hdr: level === 0 ? 1 : 0, heading: level === 0 ? 1 : 0, kb: level === 0 ? 1 : 0,
                    amb: level === 2 ? .7 : 1, cap: level > 0 ? 1 : 0, footer: level === 0 ? 1 : 0};
  const lerp = (a,b,t)=>a + (b-a)*t;
  // chrome 逐帧写值（页头/页标题/键盘/页脚/光斑/胶囊同拍）
  const applyChrome = t => {
    const co = lerp(chromeFrom.hdr, chromeTo.hdr, t);
    [c.hdr, c.heading].forEach(el=>{ if(el){ el.style.opacity = co; el.style.visibility = co < .01 ? 'hidden' : 'visible'; } });
    if(c.kb){
      const ko = lerp(chromeFrom.kb, chromeTo.kb, t);
      c.kb.style.display = ko < .01 ? 'none' : '';
      c.kb.style.opacity = ko;
    }
    if(c.footer){
      const fo = lerp(chromeFrom.footer, chromeTo.footer, t);
      c.footer.style.opacity = fo;
      c.footer.style.visibility = fo < .01 ? 'hidden' : 'visible';
    }
    const ao = lerp(chromeFrom.amb, chromeTo.amb, t);
    c.amb.forEach(el=>{ el.style.opacity = ao; });
    const ca = lerp(chromeFrom.cap, chromeTo.cap, t);
    [c.cap, c.ex].forEach(el=>{ if(el) el.style.opacity = ca; });
  };
  // v2.0：时长交由统一引擎按档位换算（full 原值 / lite ×0.5 / off 0）。
  // 专注模式的几何动画仅 full 档启用（见 focusSet），故此处实际只会拿到 full 值；
  // 走引擎口径是为了让「时长令牌」成为全站唯一时间源，避免各处各写常量。
  const dur = Math.max(140, (window.StudioMotionEngine
    ? StudioMotionEngine.dur(duration || FOCUS_DOLLY_MS)
    : (duration || FOCUS_DOLLY_MS)));
  let t0 = 0;   // 首帧时间戳锚定：rAF 的 now 可能早于按键任务里的 performance.now()，
                // 若以按键时刻为 t0，首帧 raw 会为负 → 缓动外插 → 宽度反向回弹。以首帧 now 为 t0 杜绝。
  // 首帧立即落到起点（卡片几何 + chrome 透明度同步写），避免第一帧出现目标布局闪现：
  // 目标类已切换（如 1→0 移除 focus-half 会让键盘变可见），必须同帧把 chrome 钉回起点值。
  focusDollyNow = from;
  focusDollyApply(from);
  applyChrome(0);
  const step = now => {
    if(gen !== focusDollyGen) return;   // 已被新镜头取代：立即退出，不再写值/落定
    if(!t0) t0 = now;
    const raw = Math.max(0, Math.min(1, (now - t0) / dur));
    const t = FOCUS_EASE(raw);
    // 外框 left/top/width/height 全程连续插值 → 落定帧与目标静态几何重合，无突跳。
    // 边框位置关系：内边距/描边/辅助行高度与外边距/曲线/进度条全部同拍插值，
    // 文本区宽高在 focusDollyApply 里由「当帧」外框推导（右缘/底缘永远贴边框内缘）。
    // 两端都是真实静态布局（natural=true 补隐藏行自然高度），故落定交还 CSS 零突跳。
    const s = {
      left:lerp(from.left,to.left,t), top:lerp(from.top,to.top,t),
      width:lerp(from.width,to.width,t), height:lerp(from.height,to.height,t),
      padT:lerp(from.padT,to.padT,t), padR:lerp(from.padR,to.padR,t),
      padB:lerp(from.padB,to.padB,t), padL:lerp(from.padL,to.padL,t),
      bdT:lerp(from.bdT,to.bdT,t), bdR:lerp(from.bdR,to.bdR,t),
      bdB:lerp(from.bdB,to.bdB,t), bdL:lerp(from.bdL,to.bdL,t),
      radius:lerp(from.radius,to.radius,t),
      areaPadT:lerp(from.areaPadT,to.areaPadT,t), areaPadR:lerp(from.areaPadR,to.areaPadR,t),
      areaPadB:lerp(from.areaPadB,to.areaPadB,t), areaPadL:lerp(from.areaPadL,to.areaPadL,t),
      areaBdT:lerp(from.areaBdT,to.areaBdT,t), areaBdR:lerp(from.areaBdR,to.areaBdR,t),
      areaBdB:lerp(from.areaBdB,to.areaBdB,t), areaBdL:lerp(from.areaBdL,to.areaBdL,t),
      areaMt:lerp(from.areaMt,to.areaMt,t), areaMb:lerp(from.areaMb,to.areaMb,t),
      curveH:lerp(from.curveH,to.curveH,t), curveMt:lerp(from.curveMt,to.curveMt,t), curveMb:lerp(from.curveMb,to.curveMb,t),
      progH:lerp(from.progH,to.progH,t), progMt:lerp(from.progMt,to.progMt,t), progMb:lerp(from.progMb,to.progMb,t),
      aux: from.aux.map((a,i)=>({id:a.id, h:lerp(a.h,to.aux[i].h,t), o:lerp(a.o,to.aux[i].o,t),
                                mt:lerp(a.mt,to.aux[i].mt,t), mb:lerp(a.mb,to.aux[i].mb,t)})),
      // 真实相邻间隙同拍插值（替代 margin 之和，规避 block/flex 折叠差异）
      gaps: (()=>{
        const fg = from.gaps || {}, tg = to.gaps || {}, o = {};
        FOCUS_GAP_IDS.forEach(id=>{ o[id] = lerp(fg[id]||0, tg[id]||0, t); });
        return o;
      })()
    };
    focusDollyApply(s);
    focusDollyNow = s;
    applyChrome(t);
    try{ liveCurveDraw(now); }catch(e){}   // 曲线画布随当帧尺寸重绘，避免拉伸糊化
    /* 末帧判定必须用「实际时刻」而非 rAF 传入的 now（末尾帧跳变根因之四）：
       rAF 的 now 是帧起始时间戳，回调执行时已过去若干毫秒；用它算 raw，
       最后一帧常停在 0.96~0.99 就满足落定条件。几何因 easeInOutCubic 尾段平坦
       几乎看不出（dw/dh=0），但 chrome 的 opacity 是线性映射，
       实测页头停在 0.69 / 0.37 就被清内联 → 落定瞬间「啪」地亮起。
       故这里用 performance.now() 复核：只要真实时间还没走完，就继续飞；
       真到点了再补一帧精确终值（t=1），保证 chrome 与几何同时到位。 */
    if(raw < 1){
      const realRaw = (performance.now() - t0) / dur;
      if(realRaw < 1){ focusDollyRaf = requestAnimationFrame(step); return; }
      // 真实时间已走完但本帧 raw 未到 1：同帧补写精确终值，避免 opacity 差一截
      const fin = {};
      Object.keys(to).forEach(k=>{ if(k !== 'aux' && k !== 'gaps') fin[k] = to[k]; });
      fin.aux = to.aux.map(a=>({id:a.id, h:a.h, o:a.o, mt:a.mt, mb:a.mb}));
      fin.gaps = Object.assign({}, to.gaps);
      focusDollyApply(fin);
      focusDollyNow = fin;
      applyChrome(1);
      try{ liveCurveDraw(performance.now()); }catch(e){}
    }
    // 落定：交还 CSS 静态布局，清掉所有逐帧内联值（同一帧内完成，无闪跳）
    if(gen !== focusDollyGen) return;   // 双保险：落定前再验代号
    focusDollyRaf = 0;
    focusDollyNow = null;
    focusDollyClear();
    focusRootLevel(level);
    if(level > 0) syncFocusCapsule();
    try{ liveCurveDraw(performance.now()); }catch(e){}
    focusPrewarm();   // 落定后补齐其余档位缓存（飞行中被跳过的那些）
  };
  focusDollyRaf = requestAnimationFrame(step);
}
/* 根类切换：只在「直切」与「镜头落定」两处调用，飞行途中不得提前切
   （提前切会让 CSS 静态布局与逐帧内联值打架，落定必跳变）。 */
function focusRootLevel(level){
  const root = document.documentElement;
  root.classList.toggle('focus-half', level === 1);
  root.classList.toggle('focus-full', level === 2);
}
/* 镜头是否可跑：需 full 档 + 页面可见 + 卡片真实在渲染树里（getClientRects 非空）。
   任一不满足就直切，避免对隐藏元素做无意义插值。 */
function focusCanAnimate(){
  const card = focusCard(), section = focusEl('typingSection');
  const visible = card && section && !section.classList.contains('hidden') && card.getClientRects().length > 0;
  return !!(window.StudioMotion && StudioMotion.get() === 'full' && !document.hidden && visible);
}
function focusSet(level){
  if(level === focusLevel){ if(level > 0) syncFocusCapsule(); return; }
  const prev = focusLevel;
  focusLevel = level;
  if(focusCanAnimate()){
    // 注：曾试过把 0→1 延后一帧起镜（想让建 DOM 的首布局先完成），实测无稳定收益、
    // 多次反而更差（延后帧与预热/首布局的相对时序不可控），故保持同帧起镜。
    focusDolly(level, (level === 1 && prev === 0) ? FOCUS_DOLLY_SHORT : FOCUS_DOLLY_MS);
  } else {
    focusDollyClear();
    focusRootLevel(level);
  }
  if(level > 0) syncFocusCapsule();
  // 焦点保持在打字输入，避免过渡后丢键（移动端聚焦隐藏 input 唤起键盘）
  requestAnimationFrame(()=>{
    try{
      if(matchMedia('(max-width:930px)').matches) focusTypeInput();
      else focusEl('typeArea').focus({preventScroll:true});
    }catch(e){}
  });
}
/* Esc 逐级降档：2→1→0，一次按键只降一级（不直跳 0，给用户中间态）。
   已在 0 档时什么都不做，让 Esc 继续冒泡给对话框层。 */
function focusStepDown(){
  if(focusLevel === 2) focusSet(1);
  else if(focusLevel === 1) focusSet(0);
}
/* Esc 在打字区按键处理器里同步拦截（先于对话框监听器），避免焦点在隐藏 input 时事件路径差异。
   守卫 focusLevel>0 && S.text && !S.finished 只管「练习进行中」这一半；
   另一半（无文本 / 已结算）由 document 级 Esc 监听器接手，其条件
   `!(S.text && !S.finished)` 恰是本守卫的取反 —— 两者互补覆盖全集，不重不漏。
   差别：本路径 preventDefault（吃掉 Esc），document 路径不 preventDefault（留给对话框层）。
   故「已结算时按 Esc 仍会降档，但 pd=false」是正确行为，不是漏拦截。
   两处守卫不可合并：合并会连带改变其它按键的拦截时机与 Esc 的冒泡语义。 */
function focusEscHandler(e){
  if(e.key === 'Escape' && focusLevel > 0 && S.text && !S.finished){
    e.preventDefault();
    focusStepDown();
  }
}
/* 一键全退（退出钮 / 切页 / 结算）：直落 0 档，不走逐级 */
function focusExitAll(){ focusSet(0); }
/* 胶囊是统计格的镜像：飞行/全屏时统计格收起，四项数值由这里同拍搬运。
   取 textContent 而非重算，保证与统计格显示口径（含取整/单位）逐字一致。 */
const FOCUS_CAPSULE_MIRROR = [['fcWpm','stWpm'], ['fcAcc','stAcc'], ['fcTime','stTime'], ['fcErr','stErr']];
function syncFocusCapsule(){
  FOCUS_CAPSULE_MIRROR.forEach(([dst, src]) => {
    document.getElementById(dst).textContent = document.getElementById(src).textContent;
  });
  // 计时模式显示「剩余」，自由练习显示「用时」
  document.getElementById('fcTimeLabel').textContent = S.duration ? '剩余' : '用时';
}
/* ---------- 批A：实时 WPM 曲线 ---------- */
let liveCurveSamples = [], liveCurveRaf = 0, liveCurveLastSample = 0;
function liveCurveReset(){
  liveCurveSamples = []; liveCurveLastSample = 0;
  liveCurveStop();
  const cv = document.getElementById('liveCurve');
  if(cv){ const ctx = cv.getContext('2d'); ctx.clearRect(0,0,cv.width,cv.height); }
}
/* 采样节流 ~1s（950ms 留一点余量，避免与 rAF 节拍互相错开导致漏采）。
   上限 240 点 ≈ 4 分钟，超出丢最旧点，保证长练习内存与绘制成本恒定。 */
const CURVE_SAMPLE_MS = 950;
const CURVE_MAX_POINTS = 240;
/* 瞬时 WPM = (正确字符/5) / 分钟数。
   0.008 分钟（0.48s）地板：刚起步时 elapsed 极小会算出天文数字，故不足则记 0。
   注意这与结算用的 sessionWpm（按秒取整）口径**不同**：曲线要的是平滑瞬时值。 */
const CURVE_MIN_MINS = 0.008;
function curveInstantWpm(correct, startedAt, now){
  const mins = (now - startedAt) / 60000;
  return mins > CURVE_MIN_MINS ? Math.round((correct/5)/mins) : 0;
}
function liveCurveSample(){
  if(!S.startedAt || S.finished) return;
  const now = Date.now();
  if(now - liveCurveLastSample < CURVE_SAMPLE_MS) return;
  liveCurveLastSample = now;
  liveCurveSamples.push(curveInstantWpm(S.correct, S.startedAt, now));
  if(liveCurveSamples.length > CURVE_MAX_POINTS) liveCurveSamples.shift();
  // 已有 rAF 循环在跑时不必额外画（循环下一帧自会画）
  if(!liveCurveRaf) liveCurveDraw(performance.now());
}
/* 呼吸循环只在 full 档且页面可见时跑：lite/off 档尾点不呼吸，
   静态画一次即可，省掉常驻 rAF（移动端续航与帧率红线）。 */
function liveCurveStart(){
  liveCurveStop();
  const mode = window.StudioMotion ? StudioMotion.get() : 'full';
  if(mode === 'full' && !document.hidden){
    const loop = (t)=>{ liveCurveDraw(t); liveCurveRaf = requestAnimationFrame(loop); };
    liveCurveRaf = requestAnimationFrame(loop);
  }
}
function liveCurveStop(){ if(liveCurveRaf){ cancelAnimationFrame(liveCurveRaf); liveCurveRaf = 0; } }
/* ---- 实时 WPM 曲线：几何层 ----
   与历史折线图（chartGeometry）同架构，但口径不同：
   · 纵轴上界 max(pts,20)*1.15 —— 20 是地板值，低速时曲线不贴顶
   · 横轴分母 max(len,2) —— 单点时落在左端而非居中（历史图单点是居中）
   这两条是产品既有口径，像素基线已钉住，勿"顺手统一"。 */
const CURVE_PAD = { t: 16, b: 8, l: 10, r: 14 };
function curveGeometry(pts, W, H){
  const P = CURVE_PAD;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxW = Math.max(...pts, 20) * 1.15;
  const n = Math.max(pts.length, 2);
  return {
    W, H, padT: P.t, padB: P.b, padL: P.l, padR: P.r,
    x: i => P.l + iw * i / (n - 1),
    y: v => P.t + ih * (1 - v / maxW)
  };
}
/* 空态提示基线：避让左上角「实时 WPM」标签。
   标签 absolute top:6px、11px 字，实测底缘在容器内 24px 处（含 1px 边框偏移）。
   11px 无衬线 ascent≈9px，故基线须 ≥ 24+9+2(安全间隙)=35 才完全不压标签。
   全屏态曲线区内容高仅 54px，居中基线 H/2+4=31 会压进标签带（像素实测叠压 1~2px）。
   取「居中」与 35 的较大者，并用 H-3 兜底防止矮容器里被裁；高容器仍保持居中。 */
const CURVE_EMPTY_TEXT = '开始输入后，这里绘制实时速度曲线';
function curveEmptyBaseline(H){ return Math.min(Math.max(H/2 + 4, 35), H - 3); }
/* 尾点半径：full 档随时间呼吸，其余档位固定。
   t 非数字（如初帧未传）时也取固定值，避免 NaN 半径画不出点。 */
function curveTailRadius(t){
  const mode = window.StudioMotion ? StudioMotion.get() : 'full';
  return (mode === 'full' && typeof t === 'number') ? 3.2 + Math.sin(t/300) * 1.1 : 3.2;
}
/* ---- 图层：顺序即契约（面积 → 描边 → 尾点光晕 → 尾点 → 数值），不可调换 ---- */
const curveLayers = {
  area(ctx, pts, g, primary){
    const grad = ctx.createLinearGradient(0, g.padT, 0, g.H);
    grad.addColorStop(0, hexToRgba(primary, 0.22));
    grad.addColorStop(1, hexToRgba(primary, 0.02));
    ctx.beginPath();
    pts.forEach((v,i)=>{ i ? ctx.lineTo(g.x(i),g.y(v)) : ctx.moveTo(g.x(i),g.y(v)); });
    ctx.lineTo(g.x(pts.length-1), g.H-g.padB); ctx.lineTo(g.x(0), g.H-g.padB); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  },
  stroke(ctx, pts, g, primary){
    ctx.beginPath();
    pts.forEach((v,i)=>{ i ? ctx.lineTo(g.x(i),g.y(v)) : ctx.moveTo(g.x(i),g.y(v)); });
    ctx.strokeStyle = primary; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  },
  tail(ctx, pts, g, primary, r){
    const lx = g.x(pts.length-1), ly = g.y(pts[pts.length-1]);
    // 0..7 弧度 > 2π，等价整圆（保持原写法，避免浮点差异改变抗锯齿像素）
    ctx.beginPath(); ctx.arc(lx, ly, r + 3.5, 0, 7); ctx.fillStyle = hexToRgba(primary, 0.18); ctx.fill();
    ctx.beginPath(); ctx.arc(lx, ly, r, 0, 7); ctx.fillStyle = primary; ctx.fill();
  },
  value(ctx, pts, g, primary){
    ctx.fillStyle = primary; ctx.font = '600 11px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(pts[pts.length-1] + ' WPM', g.W - g.padR, 12);
  }
};
function curveDrawEmpty(ctx, W, H){
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(CURVE_EMPTY_TEXT, 10, curveEmptyBaseline(H));
}
/* 每帧调用（打字时 rAF 驱动）：先按 dpr 对齐画布物理尺寸，再清屏绘制。
   隐藏祖先直接返回 —— 此时 clientWidth 为 0，画下去会把画布尺寸清零。 */
function liveCurveDraw(t){
  const cv = document.getElementById('liveCurve');
  const wrap = document.getElementById('liveCurveWrap');
  if(!cv || !wrap || wrap.closest('.hidden')) return;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if(cv.width !== Math.round(W*dpr) || cv.height !== Math.round(H*dpr)){ cv.width = Math.round(W*dpr); cv.height = Math.round(H*dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  const pts = liveCurveSamples;
  if(!pts.length){ curveDrawEmpty(ctx, W, H); return; }
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
  const g = curveGeometry(pts, W, H);
  curveLayers.area(ctx, pts, g, primary);
  curveLayers.stroke(ctx, pts, g, primary);
  curveLayers.tail(ctx, pts, g, primary, curveTailRadius(t));
  curveLayers.value(ctx, pts, g, primary);
}
function hexToRgba(hex, a){
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if(!m) return 'rgba(40,92,66,' + a + ')';
  const n = parseInt(m[1], 16);
  return 'rgba(' + (n>>16&255) + ',' + (n>>8&255) + ',' + (n&255) + ',' + a + ')';
}
/* ---------- 批A：成绩分享卡 ---------- */
let lastResult = null, shareDataUrl = null;
async function fetchStreak(){
  if(!currentUser) return null;
  try{
    const res = await fetch('/api/streak');
    if(!res.ok) return null;
    return await res.json();
  }catch(e){ return null; }
}
/* ===== v2.0 分享卡：声明式绘制管线 =====
   重写要点（原 90 行命令式绘制 → 分层可测单元）：
     ① sharePalette()  调色板解析独立，可单测暗/亮派生
     ② sharePainters   图元层（底色/柔光/圆角卡）与文本层分离
     ③ shareLayout()   全部坐标与字号集中成数据，改样式不再翻绘制代码
   硬约束：Canvas 绘制是有序操作，层序与参数必须与 v1.8 完全一致，
   输出 PNG 逐字节相等（sharecard-baseline.js 4 用例 sha256 门禁）。 */
const SHARE_W = 1200, SHARE_H = 675;

function sharePalette(){
  const css = getComputedStyle(document.documentElement);
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const v = (k, fallback) => css.getPropertyValue(k).trim() || fallback;
  const primary = v('--primary', '#285c42');
  return {
    dark, primary,
    accent: v('--accent', primary),
    bg:    dark ? v('--bg', '#0b0e0c')   : '#f7f8f2',
    card:  dark ? v('--card', '#151b17') : '#fffefa',
    text:  dark ? v('--text', '#ecf0ed') : '#1d2b24',
    muted: dark ? v('--muted', '#a4aba6'): '#59685e',
  };
}

/* 图元层：每个 painter 只管一件事，签名统一 (ctx, pal) */
const sharePainters = {
  base(ctx, pal){
    ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, SHARE_W, SHARE_H);
  },
  glow(ctx, pal){
    // 径向渐变而非 blur 滤镜（性能红线：大尺寸常驻绘制禁 blur）
    const one = (cx, cy, r, color, alpha) => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, hexToRgba(color, alpha));
      g.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    };
    one(1050, 90, 520, pal.primary, pal.dark ? 0.20 : 0.14);
    one(120, 620, 480, pal.accent,  pal.dark ? 0.14 : 0.10);
  },
  panel(ctx, pal){
    const x = 60, y = 60, w = 1080, h = 555, r = 26;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = pal.card; ctx.fill();
    ctx.strokeStyle = hexToRgba(pal.primary, 0.35); ctx.lineWidth = 2; ctx.stroke();
  },
};

/* 文本层：坐标/字号/对齐全部数据化。
   seq 决定绘制顺序；measure 项表示该项宽度需回传给后续项（WPM 后缀定位）。 */
function shareLayout(rec, streak, pal, displayName){
  const d = new Date(rec.t || Date.now());
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
                + '-' + String(d.getDate()).padStart(2, '0');
  const items = [
    { text: 'IELTS TYPE STUDIO · 雅思打字练习', font: '600 24px sans-serif', color: pal.primary, align: 'left',  x: 110,  y: 130 },
    { text: dateStr,                            font: '20px sans-serif',     color: pal.muted,   align: 'right', x: 1090, y: 130 },
    { text: String(rec.wpm),                    font: '800 150px sans-serif',color: pal.text,    align: 'left',  x: 110,  y: 330, measure: 'wpm' },
    { text: 'WPM',                              font: '700 40px sans-serif', color: pal.primary, align: 'left',  x: 120,  y: 330, dxFrom: 'wpm' },
    { text: '每分钟字数 · ' + (rec.label || '练习'), font: '22px sans-serif', color: pal.muted,   align: 'left',  x: 110,  y: 372 },
  ];
  // 三个数据格：值 + 标题，横向步进 250
  [[rec.acc + '%', '准确率'], [rec.secs + 's', '用时'], [String(rec.chars), '正确字符']]
    .forEach((c, i) => {
      const cx = 110 + i * 250;
      items.push({ text: c[0], font: '750 52px sans-serif', color: pal.text,  align: 'left', x: cx, y: 480 });
      items.push({ text: c[1], font: '20px sans-serif',     color: pal.muted, align: 'left', x: cx, y: 512 });
    });
  items.push({ text: displayName, font: '700 34px sans-serif', color: pal.text, align: 'right', x: 1090, y: 470 });
  if(streak){
    items.push({ text: '🔥 连续打卡 ' + streak.current + ' 天', font: '600 26px sans-serif', color: pal.primary, align: 'right', x: 1090, y: 512 });
    items.push({ text: '历史最佳 ' + streak.best + ' 天',       font: '18px sans-serif',     color: pal.muted,   align: 'right', x: 1090, y: 542 });
  }
  items.push({ text: '语料：' + (rec.material || '').slice(0, 40), font: '18px sans-serif', color: pal.muted, align: 'left', x: 110, y: 578 });
  items.push({ text: '每天 10 分钟，打出雅思手感', font: '600 18px sans-serif', color: hexToRgba(pal.primary, 0.85), align: 'right', x: 1090, y: 578 });
  return items;
}

function shareRenderText(ctx, items){
  const measured = {};
  for(const it of items){
    ctx.fillStyle = it.color;
    ctx.font = it.font;
    ctx.textAlign = it.align;
    const x = it.dxFrom ? it.x + (measured[it.dxFrom] || 0) : it.x;
    ctx.fillText(it.text, x, it.y);
    if(it.measure) measured[it.measure] = ctx.measureText(it.text).width;
  }
}

async function openShareCard(rec){
  if(!rec) return;
  const streak = await fetchStreak();
  const cv = document.createElement('canvas');
  cv.width = SHARE_W; cv.height = SHARE_H;
  const ctx = cv.getContext('2d');
  const pal = sharePalette();
  // 层序固定：底色 → 柔光 → 卡片 → 文本（与 v1.8 一致，不可调换）
  sharePainters.base(ctx, pal);
  sharePainters.glow(ctx, pal);
  sharePainters.panel(ctx, pal);
  shareRenderText(ctx, shareLayout(rec, streak, pal,
    currentUser ? currentUser.display_name : '打字练习'));
  shareDataUrl = cv.toDataURL('image/png');
  document.getElementById('shareImg').src = shareDataUrl;
  const modal = document.getElementById('shareModal');
  shareClosing = false;
  modal.classList.remove('hidden');
  /* v2.1：分享卡与设置页共用 sheet 通道（每面板独立代际，互不误杀）。
     无固定入口元素，anchor 传 null → 保底纵向展开，节奏与设置页一致。 */
  const E = window.StudioMotionEngine;
  if(E) E.sheetIn(modal.querySelector('.appearance-panel'), null);
}
let shareClosing = false;
function closeShareCard(){
  const modal = document.getElementById('shareModal');
  if(modal.classList.contains('hidden') || shareClosing) return;
  const E = window.StudioMotionEngine;
  const panel = modal.querySelector('.appearance-panel');
  const finish = () => { shareClosing = false; modal.classList.add('hidden'); };
  if(E && !E.isOff() && panel){
    shareClosing = true;
    E.sheetOut(panel, { onDone: finish });
  }else{
    finish();
  }
}
/* 401 / logout 异常路径：立即隐藏并清在途动画 */
function shareForceHide(){
  const E = window.StudioMotionEngine;
  const panel = document.querySelector('#shareModal .appearance-panel');
  if(E && panel) E.sheetKill(panel);
  shareClosing = false;
  document.getElementById('shareModal').classList.add('hidden');
}
function downloadShareCard(){
  if(!shareDataUrl) return;
  const a = document.createElement('a');
  a.href = shareDataUrl;
  a.download = 'typing-share-' + new Date().toISOString().slice(0,10) + '.png';
  document.body.appendChild(a); a.click(); a.remove();
}
/* ---------- 个性化主题色 ---------- */
/* 主题色读取的唯一入口：校验 6 位十六进制并归一小写，非法/缺失回落默认色。
   走 prefLocalGet 而非裸 localStorage —— 键名集中在 PREF_KEYS，且已含隐私模式 try/catch。 */
function accentHex(){
  const v = prefLocalGet('accent');
  return v && ACCENT_HEX_RE.test(v) ? v.toLowerCase() : StudioAccent.defaultHex;
}
function accentLabel(hex){
  const p = StudioAccent.presets.find(p=>p.hex === hex);
  return p ? p.name : '自定义 ' + hex.toUpperCase();
}
/* 选主题色：默认色不写缓存（存 null = 用默认），这样跨设备重置能传播。
   pushPref 传空串而非 null —— 服务端以空串表示「已恢复默认」并删行。 */
function setAccent(hex){
  hex = (hex || '').toLowerCase();
  if(!ACCENT_HEX_RE.test(hex)) return;
  const stored = hex === StudioAccent.defaultHex ? null : hex;
  prefLocalSet('accent', stored);
  pushPref('accent', stored === null ? '' : stored);
  themeCrossfade();
  StudioAccent.apply(hex, document.documentElement.getAttribute('data-theme') === 'dark');
  syncAccentUI();
  const historyPage = document.getElementById('page-history');
  if(currentUser && historyPage && !historyPage.classList.contains('hidden')) drawChart(historyRecords);
}
function syncAccentUI(){
  const hex = accentHex();
  document.querySelectorAll('.accent-swatch').forEach(b=>{
    b.setAttribute('aria-pressed', b.dataset.accent === hex ? 'true' : 'false');
  });
  const custom = document.getElementById('accentCustom');
  const isCustom = !StudioAccent.presets.some(p=>p.hex === hex);
  custom.classList.toggle('on', isCustom);
  const input = document.getElementById('accentCustomInput');
  input.value = hex;
  input.setAttribute('aria-label', '自定义主题色，当前 ' + accentLabel(hex));
  document.getElementById('accentName').textContent = accentLabel(hex);
  const entryName = document.getElementById('settingsEntryAccent');
  if(entryName) entryName.textContent = accentLabel(hex);
}
/* 统一设置面板：外观段 + 账号段，桌面居中弹窗、移动端底部抽屉。
   section 记忆上次停留的分段，重开时回到原处（账号段未登录时强制回外观）。 */
let settingsPane = 'appearance';
function settingsSection(which){
  const wantAccount = which === 'account' && !!currentUser;
  settingsPane = wantAccount ? 'account' : 'appearance';
  const tabs = [['settingsTabAppearance','settingsPaneAppearance','appearance'],
                ['settingsTabAccount','settingsPaneAccount','account']];
  tabs.forEach(([tabId, paneId, key])=>{
    const tab = document.getElementById(tabId), pane = document.getElementById(paneId);
    const on = key === settingsPane;
    if(tab){ tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on ? 0 : -1; }
    if(pane) pane.classList.toggle('hidden', !on);
  });
  if(settingsPane === 'account') syncAccountUI();
}
/* v2.1 设置页开合：sheetIn/sheetOut 互逆呼应（demo 的 openApp/closeApp 语义）。
   开：面板从入口卡片（settingsEntry）方向展开；关：沿同一曲线收回入口方向。
   关闭动画期间面板保持可见（不加 hidden），动画结束才真正隐藏 ——
   这是「开与关相互呼应」的关键：v2.0 关闭是瞬隐，观感断裂。
   settingsClosing 防重入：动画期间再点关闭/Esc 直接忽略，由代际号兜底。 */
let settingsClosing = false;
/* 401 强制下线等异常路径：不等收回动画，立即隐藏并清在途动画与内联样式。
   正常关闭一律走 closeSettings()（带动画），此函数只供会话失效路径使用。 */
function settingsForceHide(){
  const E = window.StudioMotionEngine;
  if(E) E.sheetKill();
  settingsClosing = false;
  document.getElementById('settingsModal').classList.add('hidden');
}
function openSettings(which){
  if(which === 'account' && !requireLogin()) return;
  settingsSection(which || settingsPane);
  const modal = document.getElementById('settingsModal');
  const wasHidden = modal.classList.contains('hidden');
  settingsClosing = false;
  modal.classList.remove('hidden');
  const E = window.StudioMotionEngine;
  if(E && wasHidden){
    const panel = modal.querySelector('.appearance-panel');
    const anchor = document.getElementById('settingsEntry');
    E.sheetIn(panel, anchor);
  }
}
function closeSettings(){
  const modal = document.getElementById('settingsModal');
  const wasOpen = !modal.classList.contains('hidden');
  if(!wasOpen || settingsClosing) return;
  const E = window.StudioMotionEngine;
  const panel = modal.querySelector('.appearance-panel');
  const finish = () => {
    settingsClosing = false;
    modal.classList.add('hidden');
    const mobile = window.matchMedia('(max-width:930px)').matches;
    if(mobile && !document.getElementById('sidebar').classList.contains('open')) openSidebar();
    // 侧栏 visibility 过渡约 180ms，未结束时元素不可聚焦：立即尝试一次，过渡结束后兜底补焦
    const restore = () => {
      if(!document.getElementById('settingsModal').classList.contains('hidden')) return;
      const entry = document.getElementById('settingsEntry');
      if(entry && entry.getClientRects().length){ entry.focus({preventScroll:true}); return; }
      const menu = document.getElementById('menuToggle');
      if(menu.getClientRects().length) menu.focus({preventScroll:true});
    };
    restore();
    setTimeout(restore, 220);
  };
  if(E && !E.isOff() && panel){
    settingsClosing = true;
    E.sheetOut(panel, { onDone: finish });
  }else{
    finish();
  }
}
function accountMsg(id, text, ok){
  const el = document.getElementById(id);
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok && !!text);
  el.classList.toggle('err', !ok && !!text);
}
function syncAccountUI(){
  if(!currentUser) return;
  document.getElementById('accountName').textContent = currentUser.display_name;
  document.getElementById('accountSub').textContent = roleLabel(currentUser.role) + ' · 成绩展示名';
  document.getElementById('accountUsername').textContent = currentUser.username;
  const created = currentUser.created_at;
  let createdText = '—';
  if(created){
    const d = new Date(created > 1e12 ? created : created * 1000);
    if(!isNaN(d)) createdText = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  document.getElementById('accountCreated').textContent = createdText;
  document.getElementById('accountDisplayName').value = currentUser.display_name;
  ['accountOldPw','accountNewPw','accountNewPw2'].forEach(id=>{ document.getElementById(id).value = ''; });
  accountMsg('accountNameMsg','');
  accountMsg('accountPwMsg','');
}
async function saveDisplayName(){
  if(!requireLogin()) return;
  const input = document.getElementById('accountDisplayName');
  const btn = document.getElementById('accountNameSave');
  const name = input.value.trim();
  accountMsg('accountNameMsg','');
  if(name === currentUser.display_name){ accountMsg('accountNameMsg','昵称没有变化', true); return; }
  btn.disabled = true;
  try{
    const res = await fetch('/api/auth/profile', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({display_name:name})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '保存失败');
    currentUser = data.user;
    updateAuthUI();
    syncAccountUI();
    accountMsg('accountNameMsg','昵称已更新', true);
    const historyPage = document.getElementById('page-history');
    if(historyPage && !historyPage.classList.contains('hidden')) renderHistory();
  }catch(e){
    accountMsg('accountNameMsg', netErrMsg(e));
  }finally{
    btn.disabled = false;
  }
}
async function savePassword(){
  if(!requireLogin()) return;
  const oldPw = document.getElementById('accountOldPw').value;
  const newPw = document.getElementById('accountNewPw').value;
  const newPw2 = document.getElementById('accountNewPw2').value;
  const btn = document.getElementById('accountPwSave');
  accountMsg('accountPwMsg','');
  if(!oldPw || !newPw || !newPw2){ accountMsg('accountPwMsg','请完整填写当前密码与新密码'); return; }
  if(newPw.length < 8){ accountMsg('accountPwMsg','新密码至少 8 位'); return; }
  if(newPw !== newPw2){ accountMsg('accountPwMsg','两次输入的新密码不一致'); return; }
  btn.disabled = true;
  try{
    const res = await fetch('/api/auth/password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({old_password:oldPw, new_password:newPw, confirm_password:newPw2})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '修改失败');
    ['accountOldPw','accountNewPw','accountNewPw2'].forEach(id=>{ document.getElementById(id).value = ''; });
    accountMsg('accountPwMsg','密码已修改，本机保持登录', true);
  }catch(e){
    accountMsg('accountPwMsg', netErrMsg(e));
  }finally{
    btn.disabled = false;
  }
}
function initAccentPicker(){
  const wrap = document.getElementById('accentSwatches');
  if(!wrap || !window.StudioAccent) return;
  StudioAccent.presets.forEach(p=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'accent-swatch';
    b.dataset.accent = p.hex;
    b.style.background = p.hex;
    b.title = p.name;
    b.setAttribute('aria-label', '主题色：' + p.name);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', ()=>setAccent(p.hex));
    wrap.appendChild(b);
  });
  const label = document.createElement('label');
  label.className = 'accent-custom';
  label.id = 'accentCustom';
  label.title = '自定义颜色';
  const input = document.createElement('input');
  input.type = 'color';
  input.id = 'accentCustomInput';
  input.value = StudioAccent.defaultHex;
  input.addEventListener('input', ()=>setAccent(input.value));
  label.appendChild(input);
  wrap.appendChild(label);
  syncAccentUI();
}
function toggleIgnoreCase(){
  ignoreCase = document.getElementById('ignoreCaseToggle').checked;
  prefLocalSet('ignoreCase', ignoreCase ? '1' : '0');
  pushPref('ignoreCase', ignoreCase ? '1' : '0');
}
/* 启动期读本地忽略大小写偏好：'1' 为开，其余（含 null / 隐私模式抛错）一律关。
   服务端偏好在登录后由 PREF_HANDLERS.ignoreCase 覆盖，这里只负责首屏无闪。 */
function initIgnoreCase(){
  let saved = false;
  try{ saved = localStorage.getItem('typingIgnoreCase') === '1'; }catch(e){}
  ignoreCase = saved;
  const cb = document.getElementById('ignoreCaseToggle');
  if(cb) cb.checked = saved;
}
(function initTheme(){
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);
  initAccentPicker();
  syncMotionUI();
  initIgnoreCase();
  StudioSound.init();
  syncSoundUI();
  initHomeSentence();
})();
(function initAuthEvents(){
  ['authUsername','authDisplayName','authPassword'].forEach(id=>{
    document.getElementById(id).addEventListener('keydown', e=>{ if(e.key==='Enter') submitAuth(); });
  });
  loadSession();
})();
let historyRecords = [];
let historyRequest = 0;
function dateFromRecord(ts){ return new Date(ts>1e12 ? ts : ts*1000); }
async function renderHistory(){
  const account = currentUser;
  const request = ++historyRequest;
  const cards = document.getElementById('statCards');
  const tbl = document.getElementById('historyTable');
  let h, stats;
  historyRecords = [];
  cards.innerHTML = '';
  tbl.textContent = '正在加载成绩…';
  drawChart([]);
  try{
    const res = await fetch('/api/records?scope=mine&limit=60');
    if(account!==currentUser || request!==historyRequest) return;
    if(res.status===401){ currentUser=null; updateAuthUI(); settingsForceHide(); shareForceHide(); authShow(); return; }
    if(!res.ok) throw new Error();
    const data = await res.json();
    if(account!==currentUser || request!==historyRequest) return;
    h = data.records.reverse();
    stats = data.stats;
  }catch(e){
    if(account===currentUser && request===historyRequest) tbl.textContent = '成绩加载失败，请重试。';
    return;
  }
  historyRecords = h;
  if(!h.length){
    tbl.innerHTML='<div class="empty-tip">暂无练习记录，快去完成第一次测试吧！</div>';
    return;
  }
  const best = stats.best;
  const avg = Math.round(stats.avg_wpm);
  const avgAcc = Math.round(stats.avg_acc);
  const total = stats.total;
  cards.innerHTML = `
    <div class="cell"><b>${best}</b><span>最佳 WPM</span></div>
    <div class="cell"><b>${avg}</b><span>平均 WPM</span></div>
    <div class="cell"><b>${avgAcc}%</b><span>平均准确率</span></div>
    <div class="cell"><b>${total}</b><span>累计练习次数</span></div>`;
  let rows = h.slice().reverse().map((r,ri)=>{
    const d = dateFromRecord(r.t);
    return `<tr><td>${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}</td>
    <td>${esc(r.label)}</td><td>${r.wpm}</td><td>${r.acc}%</td><td>${r.errs}</td><td>${r.secs}s</td>
    <td><button type="button" class="btn ghost share-row-btn" data-share-idx="${ri}" aria-label="生成这条成绩的分享卡">分享</button></td></tr>`;
  }).join('');
  tbl.innerHTML = `<table><tr><th>时间</th><th>模式</th><th>WPM</th><th>准确率</th><th>错误</th><th>用时</th><th></th></tr>${rows}</table>`;
  tbl.querySelectorAll('[data-share-idx]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const r = h.slice().reverse()[parseInt(btn.dataset.shareIdx, 10)];
      if(r) openShareCard({ t:r.t, label:r.label, material:r.material, wpm:r.wpm, acc:r.acc, chars:r.chars, errs:r.errs, secs:r.secs });
    });
  });
  drawChart(h);
}
/* ===== v2.0 历史折线图：分层绘制管线 =====
   重写要点（原 61 行单函数 → 几何/图层分离）：
     · chartGeometry()  纯函数算坐标系与映射，可单测（不碰 canvas）
     · chartLayers      网格/WPM 线/准确率线/刻度/图例各自独立
     · 空态与单条态提前返回，语义与 v1.8 一致
   硬约束：层序与数值必须完全一致，输出 PNG 逐字节相等
   （chart-baseline.js 6 分支 sha256 门禁：空/单条/多条明暗/同值/两点）。 */
const CHART_H = 280;
const CHART_PAD = { l: 40, r: 40, t: 20, b: 30 };

function chartPalette(){
  const css = getComputedStyle(document.documentElement);
  const v = k => css.getPropertyValue(k).trim();
  return { primary: v('--primary'), ok: v('--ok'), border: v('--border'), muted: v('--muted') };
}

/* 纯几何：入参数据与画布宽，出映射函数与刻度。不产生任何绘制副作用。 */
function chartGeometry(h, W){
  const H = CHART_H, P = CHART_PAD;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxW = Math.max(...h.map(r => r.wpm), 20) * 1.15;
  return {
    W, H, iw, ih, maxW, padL: P.l, padR: P.r, padT: P.t,
    x: i => P.l + (h.length === 1 ? iw / 2 : iw * i / (h.length - 1)),
    yW: v => P.t + ih * (1 - v / maxW),
    yA: v => P.t + ih * (1 - v / 100),
    // 首/中/尾三个日期刻度，去重（两点时首尾可能重合）
    ticks: [0, Math.floor((h.length - 1) / 2), h.length - 1].filter((v, i, a) => a.indexOf(v) === i),
  };
}

const chartLayers = {
  grid(ctx, g, pal){
    ctx.strokeStyle = pal.border; ctx.fillStyle = pal.muted;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    for(let i = 0; i <= 4; i++){
      const y = g.padT + g.ih * i / 4;
      ctx.beginPath(); ctx.moveTo(g.padL, y); ctx.lineTo(g.W - g.padR, y); ctx.stroke();
      ctx.fillText(Math.round(g.maxW * (4 - i) / 4), g.padL - 6, y + 4);
    }
  },
  wpm(ctx, g, pal, h){
    ctx.strokeStyle = pal.primary; ctx.lineWidth = 2; ctx.beginPath();
    h.forEach((r, i) => { i ? ctx.lineTo(g.x(i), g.yW(r.wpm)) : ctx.moveTo(g.x(i), g.yW(r.wpm)); });
    ctx.stroke();
    ctx.fillStyle = pal.primary;
    h.forEach((r, i) => { ctx.beginPath(); ctx.arc(g.x(i), g.yW(r.wpm), 3, 0, 7); ctx.fill(); });
  },
  acc(ctx, g, pal, h){
    ctx.strokeStyle = pal.ok; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
    h.forEach((r, i) => { i ? ctx.lineTo(g.x(i), g.yA(r.acc)) : ctx.moveTo(g.x(i), g.yA(r.acc)); });
    ctx.stroke(); ctx.setLineDash([]);
  },
  dateTicks(ctx, g, pal, h){
    const fmtDate = ts => { const d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000); return (d.getMonth() + 1) + '/' + d.getDate(); };
    ctx.fillStyle = pal.muted; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    g.ticks.forEach(i => { ctx.fillText(fmtDate(h[i].t), g.x(i), g.H - 6); });
  },
  legend(ctx, g, pal){
    ctx.textAlign = 'left'; ctx.font = '12px sans-serif';
    ctx.fillStyle = pal.primary; ctx.fillText('● WPM（每分钟字数）', g.padL, 14);
    ctx.fillStyle = pal.ok; ctx.fillText('- - 准确率 %', g.padL + 170, 14);
  },
};

function drawChart(h){
  const cv = document.getElementById('historyChart');
  const box = document.getElementById('chartBox');
  const dpr = window.devicePixelRatio || 1;
  const W = box.clientWidth, H = CHART_H;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const pal = chartPalette();
  ctx.clearRect(0, 0, W, H);
  // 空态
  if(!h.length){
    ctx.fillStyle = pal.muted; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', W / 2, H / 2); return;
  }
  // 单条态：给友好提示而不是孤立的一个点
  if(h.length === 1){
    ctx.fillStyle = pal.primary; ctx.font = '15px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('已记录 1 次练习（WPM ' + h[0].wpm + '）', W / 2, H / 2 - 8);
    ctx.fillStyle = pal.muted; ctx.font = '13px sans-serif';
    ctx.fillText('再完成几次练习，就能看到成绩趋势曲线了', W / 2, H / 2 + 20);
    return;
  }
  const g = chartGeometry(h, W);
  // 层序即契约：网格 → WPM 线 → 准确率虚线 → 日期刻度 → 图例
  chartLayers.grid(ctx, g, pal);
  chartLayers.wpm(ctx, g, pal, h);
  chartLayers.acc(ctx, g, pal, h);
  chartLayers.dateTicks(ctx, g, pal, h);
  chartLayers.legend(ctx, g, pal);
}
function clearHistory(){
  if(!currentUser){ authShow(); return; }
  if(confirm('确定要清空「'+getStudent()+'」的全部练习记录吗？此操作不可恢复。')){
    fetch('/api/records', {method:'DELETE'})
      .then(async res=>{
        if(!res.ok){ const data = await res.json(); throw new Error(data.error || '清空失败'); }
        renderHistory();
      })
      .catch(e=>alert(e.message || '清空失败，请重试。'));
  }
}
/* ===== 全班记录（教师视角） ===== */
async function renderClass(){
  let sum = {students:[]}, rec = {records:[]};
  try{
    const [res1, res2] = await Promise.all([
      fetch('/api/summary'),
      fetch('/api/records?scope=class&limit=30')
    ]);
    if(res1.status===401 || res2.status===401){ currentUser=null; updateAuthUI(); settingsForceHide(); authShow(); return; }
    sum = await res1.json(); rec = await res2.json();
  }catch(e){}
  const st = sum.students || [];
  const cards = document.getElementById('classCards');
  if(!st.length){
    cards.innerHTML = '';
    document.getElementById('classTable').innerHTML = '<div class="empty-tip">暂无任何学生的练习记录</div>';
    document.getElementById('recentTable').innerHTML = '';
    return;
  }
  const totalCnt = st.reduce((a,s)=>a+s.cnt,0);
  const avgWpm = Math.round(st.reduce((a,s)=>a+s.avg_wpm,0)/st.length);
  const avgAcc = Math.round(st.reduce((a,s)=>a+s.avg_acc,0)/st.length);
  cards.innerHTML = `
    <div class="cell"><b>${st.length}</b><span>参与学生数</span></div>
    <div class="cell"><b>${totalCnt}</b><span>累计练习次数</span></div>
    <div class="cell"><b>${avgWpm}</b><span>全班平均 WPM</span></div>
    <div class="cell"><b>${avgAcc}%</b><span>全班平均准确率</span></div>`;
  let rows = st.map((s,i)=>{
    const d = new Date(s.last_t*1000);
    const t = (s.last_t>1e12) ? new Date(s.last_t) : d;
    const name = s.username ? (esc(s.display_name) + '（' + esc(s.username) + '）') : esc(s.display_name || s.student || '');
    return `<tr><td>${i+1}</td><td class="stu">${name}</td><td>${s.best}</td><td>${s.avg_wpm}</td><td>${s.avg_acc}%</td><td>${s.cnt}</td><td>${s.last_words == null ? 0 : s.last_words}</td><td>${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}</td></tr>`;
  }).join('');
  document.getElementById('classTable').innerHTML =
    `<table><tr><th>排名</th><th>学生</th><th>最佳 WPM</th><th>平均 WPM</th><th>平均准确率</th><th>练习次数</th><th>最近练习单词数</th><th>最近练习</th></tr>${rows}</table>`;
  let recs = (rec.records||[]).slice(0,30).map(r=>{
    const t = (r.t>1e12) ? new Date(r.t) : new Date(r.t*1000);
    const words = Math.round((r.chars || 0) / 5);
    const name = r.username ? (esc(r.student) + '（' + esc(r.username) + '）') : esc(r.student);
    return `<tr><td>${name}</td><td>${esc(r.label)}</td><td>${r.wpm}</td><td>${r.acc}%</td><td>${words}</td><td>${t.getMonth()+1}/${t.getDate()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}</td></tr>`;
  }).join('');
  document.getElementById('recentTable').innerHTML =
    `<table><tr><th>学生</th><th>模式</th><th>WPM</th><th>准确率</th><th>单词数</th><th>时间</th></tr>${recs}</table>`;
}
/* ===== 日常练习 ===== */
function shuffle(a){ const r=a.slice(); for(let i=r.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [r[i],r[j]]=[r[j],r[i]]; } return r; }
const D = { list:[], idx:0, pos:0, errors:0, correct:0, startedAt:null, skipped:0, busy:false, spans:[] };
let cardTimer = null;
const WORD_CARD_MS = 3500;
/* 每日练习三视图：Tab 与面板成对，恰有一个 active / 恰有一个不隐藏。
   非法值一律回落 practice（与 v1.8 一致）。 */
const DAILY_VIEWS = [
  ['practice', 'dailyTabPractice', 'dailyPracticePanel'],
  ['notebook', 'dailyTabNotebook', 'dailyNotebookPanel'],
  ['keys',     'dailyTabKeys',     'dailyKeysPanel']
];
/* 分段顺序即方向：练习→生词本→错键分析为前进，反之为后退。 */
const DAILY_VIEW_ORDER = ['practice', 'notebook', 'keys'];
let lastDailyView = 'practice';
function dailyView(view){
  const v = (view==='notebook' || view==='keys') ? view : 'practice';
  const prev = lastDailyView;
  lastDailyView = v;
  DAILY_VIEWS.forEach(([key, tabId, paneId])=>{
    document.getElementById(tabId).classList.toggle('active', key === v);
    document.getElementById(paneId).classList.toggle('hidden', key !== v);
  });
  if(v==='notebook') renderNotebook();
  if(v==='keys'){
    // 进入复盘页先落盘尚未上报的增量，再拉最新统计（跨设备也能看到刚练的结果）
    keyErrFlush();
    kbHeatPaint(); kbHeatSummary();   // 先按本地数据立即着色，避免等网络的空白帧
    if(currentUser) keyErrLoad();
  }
  /* v2.1：三分段切换与 Tab/课程同走 pageCross（scope 是 #page-daily，
     与 Tab 级作用域独立，互不误杀在途动画）。同段重入只做状态刷新不转场。
     旧页需仍可见才能退场，故先摘 hidden 再交给引擎收尾隐藏。 */
  if(prev !== v){
    const inn = document.getElementById(DAILY_VIEWS.find(x=>x[0]===v)[2]);
    const out = document.getElementById(DAILY_VIEWS.find(x=>x[0]===prev)[2]);
    const E = window.StudioMotionEngine;
    if(E && !E.isOff()){
      out.classList.remove('hidden');
      E.pageCross(out, inn, DAILY_VIEW_ORDER.indexOf(v) > DAILY_VIEW_ORDER.indexOf(prev) ? 1 : -1, { duration: 'base', dx: 18 });
    }
  }
}
function getDailyPool(topic){
  const topicWords = DAILY_TOPIC_WORDS[topic];
  if(topic==='all' || !topicWords) return DAILY_WORDS;
  const allowed = new Set(topicWords);
  const pool = DAILY_WORDS.filter(x=>allowed.has(x.w));
  return pool.length ? pool : DAILY_WORDS;
}
function updateDailyLengthOptions(){
  const topic = document.getElementById('dailyTopic').value;
  const size = getDailyPool(topic).length;
  const select = document.getElementById('dailyLength');
  Array.from(select.options).forEach(opt=>{ opt.disabled = parseInt(opt.value,10) > size; });
  if(parseInt(select.value,10) > size) select.value = '20';
}
function dailySettingsChanged(){
  updateDailyLengthOptions();
  if(hasActiveDailySession() && !confirm('更改话题或词数会重新开始当前轮，确定继续吗？')){
    document.getElementById('dailyTopic').value = D.topic || 'all';
    document.getElementById('dailyLength').value = String(D.count || 20);
    updateDailyLengthOptions();
    return;
  }
  startDaily();
}
/* 开新一轮：先把上一轮的词卡/结算/在途动画全部收干净，再抽样。
   顺序不可换 —— cancelFlies 必须在摘 hidden 之前，否则克隆层会在新词卡上留残影；
   清内联 opacity/transform 是因为 FLIP 飞行可能被打断在中途值。 */
function dailyCardReset(){
  clearTimeout(cardTimer); cardTimer = null;
  if(window.StudioMotionEngine) StudioMotionEngine.cancelFlies();
  const wc = document.getElementById('wordCard');
  wc.style.opacity = ''; wc.style.transform = '';
  wc.classList.add('hidden');
}
function startDaily(){
  if(!requireLogin()) return;
  updateAutoSpeakUI();
  dailyCardReset();
  document.getElementById('dailySummary').classList.add('hidden');
  document.getElementById('dailyInputView').classList.remove('hidden');
  const topicSelect = document.getElementById('dailyTopic');
  const topic = topicSelect.value;
  updateDailyLengthOptions();
  const count = parseInt(document.getElementById('dailyLength').value, 10) || 20;
  const pool = getDailyPool(topic);
  D.topic = topic;
  D.topicLabel = topicSelect.selectedOptions[0].text;
  D.count = count;
  D.list = shuffle(pool).slice(0, Math.min(count, pool.length));
  lastDailyResult = null;
  showDailySaveTip(false);
  D.idx = 0; D.errors = 0; D.correct = 0; D.startedAt = null; D.skipped = 0; D.busy = false;
  document.getElementById('dailyTip').textContent = D.topicLabel + ' · 本轮 ' + D.list.length + ' 词。输入单词，听发音，难词可加入生词本';
  renderDailyWord();
  document.getElementById('dailyArea').focus();
}
function renderDailyWord(){
  const item = D.list[D.idx];
  D.busy = false;
  D.pos = 0;
  document.getElementById('dPhonetic').textContent = 'AmE: ' + item.p;
  document.getElementById('dDef').textContent = item.d;
  updateDailyFav();
  const area = document.getElementById('dailyArea');
  area.innerHTML = '';
  const spans = [];
  for(let i=0;i<item.w.length;i++){
    const sp = document.createElement('span');
    sp.className = 'ch'; sp.textContent = item.w[i]; sp.dataset.i = i;
    spans.push(sp); area.appendChild(sp);
  }
  D.spans = spans; D.caret = null;
  updateDailyStats();
  if(autoSpeakEnabled()) dailySpeak();
}
function updateDailyStats(){
  const next = D.spans[D.pos] || null;
  if(D.caret!==next){
    if(D.caret) D.caret.classList.remove('cur');
    if(next) next.classList.add('cur');
    D.caret = next;
  }
  /* WPM 与练习页/实时曲线共用 curveInstantWpm 同一口径（原先此处自写一份公式）。
     0.008 分钟地板值与「未开始记 0」两条守卫都在该函数内，口径不会漂移。 */
  const wpm = liveWpm(D.correct, D.startedAt, Date.now());
  const acc = accuracy(D.correct, D.errors);
  document.getElementById('dWpm').textContent = wpm;
  document.getElementById('dAcc').textContent = acc + '%';
  document.getElementById('dProg').textContent = Math.round(D.idx / D.list.length * 100) + '%';
}
function dailyBackspace(){
  if(D.pos>0){
    StudioSound.backspace();
    D.correct--;
    const previous = D.spans[D.pos--];
    if(previous) previous.classList.remove('done-err');
    D.spans[D.pos].classList.remove('done-ok','done-err');
    updateDailyStats();
  }
}
function dailyChar(ch){
  if(D.busy || !D.list.length || ch.length !== 1) return;
  if(!D.startedAt) D.startedAt = Date.now();
  const item = D.list[D.idx];
  const expected = item.w[D.pos];
  const spans = D.spans;
  const dailyOk = ignoreCase ? ch.toLowerCase()===expected.toLowerCase() : ch===expected;
  StudioSound.key(dailyOk);
  if(dailyOk){
    D.correct++; D.pos++;
    if(spans[D.pos-1]){ spans[D.pos-1].classList.add('done-ok'); spans[D.pos-1].classList.remove('done-err'); }
    if(D.pos >= item.w.length){
      D.busy = true;
      updateDailyStats();
      showWordCard(item);
    }
  } else {
    D.errors++;
    const sp = spans[D.pos];
    if(sp && !sp.classList.contains('done-err')){ sp.classList.add('done-err'); }
  }
  updateDailyStats();
}
function dailyKeydown(e){
  // 每日单词没有 Esc 退出语义（Esc 由全局对话框层处理），故不传 escape
  typingDispatch(e, {
    blocked: () => D.busy || !D.list.length,
    backspace: dailyBackspace,
    char: dailyChar
  });
}
function focusDailyInput(){ focusHiddenInput('dailyInput'); }
document.getElementById('dailyArea').addEventListener('focus', focusDailyInput);
document.getElementById('dailyInput').addEventListener('beforeinput', e =>
  typingBeforeInput(e, () => D.busy || !D.list.length, dailyChar, dailyBackspace));
function dailyNext(){
  D.idx++;
  if(D.idx >= D.list.length){
    D.busy = true;
    showDailySummary();
    return;
  }
  renderDailyWord();
  document.getElementById('dailyArea').focus();
}
/* 输入区 → 词卡的视图交接：隐藏前者、显示后者。两条路径共用。 */
function wordCardReveal(inputView, card){
  inputView.classList.add('hidden');
  card.classList.remove('hidden');
}
/* CSS 入场动画重播：置 none → 强制回流 → 清空，让同一个卡片每次都能重新播。 */
function replayCssAnimation(el){
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
function showWordCard(item){
  document.getElementById('wcWord').textContent = item.w;
  document.getElementById('wcPhonetic').textContent = 'AmE: ' + item.p;
  document.getElementById('wcDef').textContent = item.d;
  const inputView = document.getElementById('dailyInputView');
  const card = document.getElementById('wordCard');
  const E = window.StudioMotionEngine;
  /* v2.0：词卡改用 FLIP 飞行克隆层。
     这是克隆层真正成立的场景 —— 卡片内容（单词/音标/释义）此刻已定稿且静态，
     变形期间不需要重排、不需要交互、无 canvas。
     从输入区矩形形变到卡片矩形，克隆层承担全部几何，真实卡片只做错峰浮现。
     量不到有效矩形（宽高为 0 / localRect 抛错）时降级走 CSS 入场，不留白屏。 */
  const canFly = E && !E.isOff() && inputView && !inputView.classList.contains('hidden');
  if(canFly){
    const host = card.offsetParent || document.body;
    let fromRect = null, toRect = null;
    try{ fromRect = E.localRect(inputView, host); }catch(e){ fromRect = null; }
    // 先显示真实卡片以量取终点矩形，随后交给引擎隐藏并飞行
    wordCardReveal(inputView, card);
    card.style.animation = 'none';
    try{ toRect = E.localRect(card, host); }catch(e){ toRect = null; }
    if(fromRect && toRect && fromRect.w > 0 && toRect.w > 0){
      E.flip({
        source: card, from: fromRect, to: toRect, host: host,
        duration: 'base', radius: [12, 17], reveal: card, glyph: false
      });
    }else{
      card.style.animation = '';
    }
  }else{
    wordCardReveal(inputView, card);
    replayCssAnimation(card);
  }
  updateWcFav();
  speakText(item.w);
  clearTimeout(cardTimer);
  cardTimer = setTimeout(continueAfterCard, WORD_CARD_MS);
}
/* 收藏按钮态：词卡与输入区两处同逻辑，只差元素 id。
   文案与 on 类必须同拍，否则出现「已收藏」但无高亮的错配。 */
function favButtonSync(id){
  const btn = document.getElementById(id);
  if(!btn || !D.list.length) return;
  const fav = getDailyFavs().includes(D.list[D.idx].w);
  btn.textContent = fav ? '已收藏' : '收藏';
  btn.classList.toggle('on', fav);
}
function updateWcFav(){ favButtonSync('wcFav'); }
function toggleFavFromCard(){
  dailyFav();
  updateWcFav();
}
function continueAfterCard(){
  if(document.getElementById('wordCard').classList.contains('hidden')) return;
  // 词卡可能在 FLIP 飞行中被手动提前切走，dailyCardReset 会中断在途克隆层防残影
  dailyCardReset();
  document.getElementById('dailyInputView').classList.remove('hidden');
  dailyNext();
}
let lastDailyResult = null;
async function showDailySummary(){
  dailyCardReset();
  // 结算页与输入区互斥：两者都隐藏，只留 summary
  document.getElementById('dailyInputView').classList.add('hidden');
  // 与测试/课程结算共用同一公式，消除重复实现
  const secs = sessionSeconds(D.startedAt, Date.now());
  const wpm = sessionWpm(D.correct, secs);
  const acc = accuracy(D.correct, D.errors);
  const total = D.list.length;
  const summary = document.getElementById('dailySummary');
  summary.classList.remove('hidden');
  replayCssAnimation(summary);
  // 主指标（WPM/准确率）走 macro，次要指标走 base，形成主次节奏
  countUp('dsWpm', wpm, 'macro');
  countUp('dsAcc', acc, 'macro', '%');
  countUp('dsCorrect', D.correct, 'base');
  countUp('dsErr', D.errors, 'base');
  countUp('dsSkip', D.skipped, 'base');
  countUp('dsTime', secs, 'base', 's');
  document.getElementById('dailyTip').textContent = '练习完成！WPM ' + wpm + ' · 准确率 ' + acc + '% · 跳过 ' + D.skipped + ' 个。点击"再来一轮"继续。';
  showRecordBadge('dsRecord', checkPersonalBest(wpm));
  if(wpm && D.correct) StudioSound.complete();
  launchConfetti();
  // 保存成绩，失败时给出明显红字提示并允许重试
  const rec = { t:Date.now(), student:getStudent(), label:'日常练习', material:(D.topicLabel || '全部核心词') + ' × ' + total, wpm, acc, chars:D.correct, errs:D.errors, secs };
  D.list = [];
  if(!rec.chars || !rec.wpm) return;
  lastDailyResult = rec;
  lastResult = rec;
  const saved = await saveDailyRecord(rec);
  if(lastDailyResult===rec) showDailySaveTip(!saved);
}
function showDailySaveTip(failed){
  const tip = document.getElementById('dSaveTip');
  const btn = document.getElementById('dRetryBtn');
  if(failed) tip.textContent = '成绩未能保存，请检查网络后重试。';
  tip.classList.toggle('hidden', !failed);
  btn.classList.toggle('hidden', !failed);
}
async function retrySaveDaily(){
  if(!lastDailyResult) return;
  const rec = lastDailyResult;
  const tip = document.getElementById('dSaveTip');
  const btn = document.getElementById('dRetryBtn');
  if(btn.disabled) return;
  btn.disabled = true;
  const saved = await saveDailyRecord(rec);
  btn.disabled = false;
  if(lastDailyResult!==rec) return;
  if(saved){
    tip.textContent = '成绩已成功保存到服务器。';
    btn.classList.add('hidden');
    setTimeout(()=>{ if(lastDailyResult===rec) tip.classList.add('hidden'); }, 2000);
  } else {
    tip.textContent = '成绩仍未保存，请检查网络后重试。';
  }
}
/* v2.0 数字滚动：缓动与时长收归统一引擎。
   原先硬编码 1-(1-t)^3 与 850/800/600 三种散落时长，
   现改为引擎 easeOut + 三档时长（主指标 macro、次指标 base），
   lite/off 由引擎 dur() 统一降级，不再各自判断。
   末帧直接写终值，避免缓动末段取整误差导致数字停在 target-1。 */
function countUp(id, target, dur, suffix){
  const el = document.getElementById(id);
  if(!el) return;
  suffix = suffix || '';
  const E = window.StudioMotionEngine;
  const D = E ? E.dur(dur || 'base') : (dur || 320);
  if(!D){ el.textContent = target + suffix; return; }
  const ease = E ? E.easeOut : (t => 1 - Math.pow(1 - t, 3));
  const start = performance.now();
  function step(now){
    const t = Math.min(1, (now - start) / D);
    if(t >= 1){ el.textContent = target + suffix; return; }
    el.textContent = Math.round(target * ease(t)) + suffix;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function launchConfetti(){
  const box = document.getElementById('confetti');
  if(!box) return;
  box.innerHTML = '';
  const mode = window.StudioMotion ? StudioMotion.get() : 'full';
  if(mode === 'off' || (window.StudioMotion && StudioMotion.reduced())) return;
  const r = box.getBoundingClientRect();
  burstParticles({ n:150, x:r.left + r.width/2, y:r.top + r.height*0.35 });
  if(mode === 'lite') return; // 精简档只保留 Canvas 爆发，不再叠加 DOM 彩带
  const colors = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#c780fa','#ff9f43'];
  const n = window.innerWidth <= 650 ? 30 : 60;
  /* v2.0：彩带时长/缓动收归引擎。原先 1.6+rand*1.4s 与固定 3600ms 清理是散落常量，
     现以 macro 档为基准派生，lite 档自动减半，清理时机由实际最长时长推导而非魔法数。 */
  const E = window.StudioMotionEngine;
  const unit = E ? E.dur('macro') : 500;      // full=500 lite=250
  const scale = unit / 500;                    // 相对基准档的缩放
  const frag = document.createDocumentFragment();
  let maxEnd = 0;
  for(let i=0;i<n;i++){
    const p = document.createElement('i');
    const d = (1600 + Math.random()*1400) * scale;
    const delay = Math.random()*600 * scale;
    maxEnd = Math.max(maxEnd, d + delay);
    p.style.left = (Math.random()*100) + '%';
    p.style.top = '0';
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = d + 'ms';
    p.style.animationDelay = delay + 'ms';
    if(E) p.style.animationTimingFunction = E.EASE;
    p.style.width = (6 + Math.random()*6) + 'px';
    p.style.height = (10 + Math.random()*8) + 'px';
    frag.appendChild(p);
  }
  box.appendChild(frag);
  // 清理留 200ms 余量，保证最后一片落完再清（原固定 3600ms 是魔法数）
  setTimeout(()=>{ box.innerHTML = ''; }, Math.ceil(maxEnd) + 200);
}
async function saveDailyRecord(rec){
  if((rec.chars || 0) <= 0) return true;
  try{
    const res = await fetch('/api/records', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(rec)});
    return res.ok;
  }catch(e){ return false; }
}
function dailySkip(){
  if(D.busy || !D.list.length) return;
  D.skipped++;
  dailyNext();
}
function dailySpeak(){
  if(!D.list.length) return;
  speakText(D.list[D.idx].w);
}
/* '1' 为开，其余（含 null / 隐私模式抛错）一律关。走 prefLocalGet 统一键名与容错。 */
function autoSpeakEnabled(){ return prefLocalGet('autoSpeak') === '1'; }
function updateAutoSpeakUI(){
  const el = document.getElementById('dAutoSpeak');
  if(!el) return;
  const on = autoSpeakEnabled();
  el.classList.toggle('on', on);
  el.textContent = on ? '自动发音：开' : '自动发音：关';
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}
function dailyAutoSpeakToggle(){
  const on = !autoSpeakEnabled();
  prefLocalSet('autoSpeak', on ? '1' : '0');
  pushPref('autoSpeak', on ? '1' : '0');
  updateAutoSpeakUI();
  if(on) dailySpeak();
}
let favCache = null;
function getDailyFavs(){
  if(favCache) return favCache.slice();
  try{ return JSON.parse(localStorage.getItem('dailyFavs') || '[]'); }catch(e){ return []; }
}
function setDailyFavs(list){
  favCache = Array.isArray(list) ? list.slice() : [];
  try{ localStorage.setItem('dailyFavs', JSON.stringify(favCache)); }catch(e){}
}
async function syncFavsFromServer(){
  if(!currentUser) return;
  try{
    const res = await fetch('/api/favs');
    if(!res.ok) return;
    const data = await res.json();
    if(Array.isArray(data.favs)) setDailyFavs(data.favs);
  }catch(e){}
}
async function pushFavChange(word, add){
  if(!currentUser) return;
  try{
    await fetch('/api/favs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({word, add})});
  }catch(e){}
}
async function clearServerFavs(){
  if(!currentUser) return;
  try{
    await fetch('/api/favs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({clear:true})});
  }catch(e){}
}
function dailyFav(){
  if(!D.list.length) return;
  const w = D.list[D.idx].w;
  let favs = getDailyFavs();
  let add;
  if(favs.includes(w)){ favs = favs.filter(x=>x!==w); add = false; }
  else { favs.push(w); add = true; }
  setDailyFavs(favs);
  pushFavChange(w, add);
  updateDailyFav();
}
function focusAfterDailyAction(){
  if(!D.busy && D.list.length) focusDailyInput();
}
function updateDailyFav(){ favButtonSync('dFav'); }
document.getElementById('dailyArea').addEventListener('keydown', dailyKeydown);
document.getElementById('dailyInput').addEventListener('keydown', dailyKeydown);

/* ===== 生词本 ===== */
const DAILY_MAP = {};
DAILY_WORDS.forEach(x=>{ DAILY_MAP[x.w] = x; });
/* v2.0 生词本：SRS 三态判定抽为纯函数。
   判定条件与 v1.8 逐字一致，只是从模板里提出来便于单测：
     · due_at <= now              → 待复习
     · reps/lapses/last_review >0 → 待巩固（显示下次时间）
       「忘了」会把 reps 归零但 lapses+1，此时不是新词
     · 否则                        → 新词
   rec 为空（未登录或调度未就绪）返回空串，不显示标签。 */
function notebookSrsTag(rec, now){
  if(!rec) return '';
  if(rec.due_at <= now) return '<span class="nb-srs due">待复习</span>';
  if(rec.reps > 0 || rec.lapses > 0 || rec.last_review > 0){
    return '<span class="nb-srs later">' + esc(srsFmtLeft(rec.due_at)) + '</span>';
  }
  return '<span class="nb-srs fresh">新词</span>';
}
/* 生词本条目：三个动作按钮走 data-* + 事件委托，绝不把单词拼进 onclick。
   v2.0 修真实缺陷（与批次11 管理表格同源，已用 notebook-xss-probe.js 取证）：
   原写法 onclick="notebookSpeak('${esc(w)}')"，esc 做的是 HTML 实体转义（' → &#39;），
   而属性值会先解码再交给 JS，实体还原成裸单引号后破坏 JS 字符串字面量：
     · don't / a'b'c → SyntaxError，发音/查词/移除【三个按钮全部失效】
     · a\b           → \b 被当转义序列，实参变成 a<退格>，移除会匹配不到词而静默失败
   现网词表 1178 条恰好零触发字符，故此前未暴露；但查词/收藏可来自用户输入，必须修。 */
const NOTEBOOK_ACTIONS = [['speak','发音'],['lookup','查词'],['remove','移除']];
function notebookItemHTML(w, item, tag){
  const safe = esc(w);
  const btns = NOTEBOOK_ACTIONS.map(([act, label]) =>
    `<button class="btn ghost" data-act="${act}" data-word="${safe}">${label}</button>`).join('');
  return `<div class="nb-item"><div><div class="w">${safe}${tag}</div><div class="p">AmE: ${esc(item.p)}</div><div class="d">${esc(item.d)}</div></div>
      <div class="nb-actions">${btns}</div></div>`;
}
/* 一次性委托：条目每次渲染都是新节点，逐个绑定会泄漏且随列表增长变慢。 */
document.getElementById('nbList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if(!btn) return;
  const w = btn.dataset.word;
  if(!w) return;
  if(btn.dataset.act === 'speak') notebookSpeak(w);
  else if(btn.dataset.act === 'lookup') notebookLookup(w);
  else if(btn.dataset.act === 'remove') notebookRemove(w);
});
function renderNotebook(){
  const list = document.getElementById('nbList');
  const favs = getDailyFavs();
  const q = document.getElementById('nbSearch').value.trim().toLowerCase();
  const filtered = favs.filter(w=>!q || w.toLowerCase().includes(q));
  document.getElementById('nbCount').textContent = favs.length ? '共 ' + favs.length + ' 个' : '';
  if(!filtered.length){
    list.innerHTML = '<div class="empty-tip">' + (favs.length ? '没有匹配的单词' : '还没有收藏单词，去「日常练习」点“收藏”吧') + '</div>';
    return;
  }
  const sm = srsLoaded ? srsMap() : {};
  // 单次渲染统一时间基准，避免同屏不同词用不同秒数判定到期。
  // 注意 srsFmtLeft 内部自取 srsNow()，格式化口径与 v1.8 一致，不受此影响。
  const now = srsNow();
  list.innerHTML = filtered.map(w=>{
    const item = DAILY_MAP[w] || {p:'', d:''};
    return notebookItemHTML(w, item, notebookSrsTag(sm[w], now));
  }).join('');
  srsRenderBadge();
}
function notebookSpeak(w){ speakText(w); }
function notebookLookup(w){
  const url = 'https://dict.youdao.com/w/' + encodeURIComponent(w) + '/#keyfrom=dict2.top';
  window.open(url, '_blank', 'noopener');
}
function notebookRemove(w){
  let favs = getDailyFavs().filter(x=>x!==w);
  setDailyFavs(favs);
  pushFavChange(w, false);
  renderNotebook();
}
function notebookClear(){
  if(!getDailyFavs().length) return;
  if(confirm('确定清空生词本吗？此操作不可恢复。')){
    setDailyFavs([]);
    clearServerFavs();
    renderNotebook();
  }
}

/* ================= F4 间隔重复（简化 SM-2，调度在后端） =================
   前端只负责：拉取调度状态、按到期组卷、提交自评、渲染下次时间。
   算法与权威时间都在服务端，避免本机时钟不准导致排程错乱。 */
let srsState = { items:[], due:[], dueCount:0, total:0 };
let srsLoaded = false;
let srsMode = false;          // true = 复习到期模式（四档自评）
let srsClockSkew = 0;         // 服务端 now - 本机 now，用于显示剩余时间

function srsNow(){ return Math.floor(Date.now()/1000) + srsClockSkew; }
async function srsLoad(){
  if(!currentUser){ srsState = { items:[], due:[], dueCount:0, total:0 }; srsLoaded = false; srsRenderBadge(); return; }
  try{
    const r = await fetch('/api/srs');
    if(!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    srsState = { items:j.items || [], due:j.due || [], dueCount:j.dueCount || 0, total:j.total || 0 };
    if(typeof j.now === 'number') srsClockSkew = j.now - Math.floor(Date.now()/1000);
    srsLoaded = true;
  }catch(e){ srsLoaded = false; }
  srsRenderBadge();
  if(!document.getElementById('dailyNotebookPanel').classList.contains('hidden')) renderNotebook();
}
function srsMap(){
  const m = {};
  srsState.items.forEach(x => { m[x.word] = x; });
  return m;
}
function srsFmtLeft(due){
  const d = due - srsNow();
  if(d <= 0) return '现在';
  if(d < 3600) return Math.max(1, Math.round(d/60)) + ' 分钟后';
  if(d < 86400) return Math.round(d/3600) + ' 小时后';
  const days = d/86400;
  if(days < 30) return Math.round(days) + ' 天后';
  return Math.round(days/30) + ' 个月后';
}
function srsFmtInterval(days){
  if(days <= 0) return '10 分钟';
  if(days < 1) return Math.round(days*24*60) + ' 分钟';
  if(days < 30) return (Math.round(days*10)/10) + ' 天';
  if(days < 365) return (Math.round(days/30*10)/10) + ' 个月';
  return (Math.round(days/365*10)/10) + ' 年';
}
function srsRenderBadge(){
  const bar = document.getElementById('srsBar'), badge = document.getElementById('srsBadge');
  const dueBtn = document.getElementById('srsDueBtn');
  if(!bar || !badge) return;
  const rp = document.getElementById('reviewPanel');
  const inReview = !!rp && !rp.classList.contains('hidden');
  const show = !!currentUser && srsState.total > 0 && !inReview;
  bar.classList.toggle('hidden', !show);
  if(!show) return;
  const due = srsState.dueCount;
  badge.innerHTML = due > 0
    ? '待复习 <b class="due-now">' + due + '</b> 个 · 生词本共 <b>' + srsState.total + '</b> 个'
    : '本轮已全部复习完 · 生词本共 <b>' + srsState.total + '</b> 个';
  if(dueBtn){ dueBtn.disabled = due === 0; dueBtn.textContent = due > 0 ? ('复习到期 (' + due + ')') : '暂无到期'; }
}
async function srsResetAll(){
  if(!currentUser || !srsState.total) return;
  if(!confirm('重置全部复习进度？所有单词会立即重新到期，此操作不可撤销。')) return;
  try{
    const r = await fetch('/api/srs/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ all:true }) });
    if(!r.ok) throw new Error('status ' + r.status);
    await srsLoad();
  }catch(e){ alert('重置失败，请稍后重试'); }
}
// 预估各档下次间隔（与后端 srs_next 同口径，仅用于按钮提示文案）
function srsPreview(rec, quality){
  let ease = rec ? rec.ease : 2.5, interval = rec ? rec.interval : 0, reps = rec ? rec.reps : 0;
  if(quality === 'again') return 0;
  if(reps === 0) interval = quality === 'easy' ? 4 : 1;
  else if(reps === 1) interval = quality === 'easy' ? 6 : 3;
  else interval = Math.max(1, interval * ease * (quality === 'easy' ? 1.15 : (quality === 'hard' ? 0.8 : 1)));
  return Math.min(365, interval);
}
function srsUpdateGradeHints(){
  const w = R.list[R.idx];
  const rec = srsMap()[w];
  const set = (id, q) => { const el = document.getElementById(id); if(el) el.textContent = srsFmtInterval(srsPreview(rec, q)); };
  set('srsHardHint', 'hard'); set('srsGoodHint', 'good'); set('srsEasyHint', 'easy');
}
async function srsGrade(quality){
  if(R.done || !srsMode) return;
  const word = R.list[R.idx];
  if(!word) return;
  try{
    const r = await fetch('/api/srs/review', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ word, quality }) });
    if(!r.ok) throw new Error('status ' + r.status);
    const j = await r.json();
    // 就地更新本地调度，避免整表重拉
    const it = srsState.items.find(x => x.word === word);
    if(it){ it.ease = j.ease; it.interval = j.interval; it.reps = j.reps; it.lapses = j.lapses; it.due_at = j.due_at; it.last_review = Math.floor(Date.now()/1000); }
    srsState.due = srsState.items.filter(x => x.due_at <= srsNow()).map(x => x.word);
    srsState.dueCount = srsState.due.length;
  }catch(e){ /* 提交失败不阻断复习流程，下次进入会重新拉取 */ }
  if(quality === 'again') R.unknown++; else R.known++;
  reviewNext();
}

/* ===== 背单词（闪卡） ===== */
const R = { list:[], idx:0, flipped:false, known:0, unknown:0, done:false };
function startReview(dueOnly){
  const favs = getDailyFavs();
  if(!favs.length){ alert('生词本还是空的，先去「练习」收藏几个单词吧'); return; }
  srsMode = !!dueOnly && !!currentUser && srsLoaded;
  let pool = favs;
  if(srsMode){
    const dueSet = new Set(srsState.due);
    pool = favs.filter(w => dueSet.has(w));
    if(!pool.length){ alert('当前没有到期的单词，休息一下吧'); srsMode = false; return; }
  }
  Object.assign(R, { list: shuffle(pool), idx:0, flipped:false, known:0, unknown:0, done:false });
  // 生词本三块让位给闪卡面板（srsBar 可能未挂载）
  ['nbToolbar','nbList','srsBar'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.classList.add('hidden');
  });
  document.getElementById('reviewPanel').classList.remove('hidden');
  document.getElementById('reviewSkipBtn').textContent = '下一个';
  const hint = document.getElementById('reviewHint');
  if(hint) hint.textContent = REVIEW_HINTS[srsMode ? 'srs' : 'plain'];
  renderReviewCard();
}
const REVIEW_HINTS = {
  srs:   '翻面后按记忆程度自评，系统按遗忘曲线安排下次复习 · 空格翻面，Esc 退出',
  plain: '先看单词回忆释义，再点卡片翻面确认 · 空格翻面，→ 下一个，Esc 退出'
};
/* 闪卡按钮显隐的唯一真值表。四组互斥关系一目了然，改一处不会漏改另一处：
     翻面前 → 只有「翻面」和「下一个」
     翻面后 · 普通模式 → 「认识 / 不认识」+「下一个」
     翻面后 · 到期模式 → 四档自评（隐藏两档与「下一个」，避免误跳过自评）
   hidden 为 true 表示隐藏。srsGradeRow 可能未挂载，故单独容错。 */
function reviewControls(flipped, mode){
  return {
    reviewFlipBtn: flipped,
    reviewKnownBtn: !flipped || mode,
    reviewUnknownBtn: !flipped || mode,
    srsGradeRow: !flipped || !mode,
    reviewSkipBtn: mode && flipped
  };
}
/* 结算态：全部作答按钮隐藏，只留一个「再来一轮 / 返回生词本」。 */
function reviewDoneControls(){
  return { reviewFlipBtn:true, reviewKnownBtn:true, reviewUnknownBtn:true,
           srsGradeRow:true, reviewSkipBtn:false };
}
function reviewApplyControls(state){
  Object.keys(state).forEach(id => {
    const el = document.getElementById(id);
    if(el) el.classList.toggle('hidden', state[id]);
  });
}
function reviewProgressText(rec){
  return (R.idx+1) + ' / ' + R.list.length
    + (srsMode ? ' · 到期复习' : '')
    + (rec && rec.reps > 0 ? ' · 已复习 ' + rec.reps + ' 次' : '');
}
function renderReviewCard(){
  const w = R.list[R.idx];
  const item = DAILY_MAP[w] || {p:'', d:''};
  document.getElementById('reviewWord').textContent = w;
  document.getElementById('reviewPhonetic').textContent = item.p ? ('AmE: ' + item.p) : '';
  const def = document.getElementById('reviewDef');
  def.textContent = item.d;
  def.classList.toggle('hidden', !R.flipped);
  document.getElementById('reviewCard').classList.toggle('flipped', R.flipped);
  reviewApplyControls(reviewControls(R.flipped, srsMode));
  if(srsMode && R.flipped) srsUpdateGradeHints();
  document.getElementById('reviewProgress').textContent =
    reviewProgressText(srsMode ? srsMap()[w] : null);
}
function reviewFlip(){ if(R.done) return; R.flipped = true; renderReviewCard(); }
function reviewMark(known){ if(R.done) return; if(known) R.known++; else R.unknown++; reviewNext(); }
function reviewNext(){
  // 到期复习跑完后不再自动组卷（此时已无到期词），直接回生词本看新排程
  if(R.done){ if(srsMode){ reviewExit(); } else { startReview(); } return; }
  R.idx++; R.flipped = false;
  if(R.idx >= R.list.length){ reviewFinish(); return; }
  renderReviewCard();
}
function reviewFinish(){
  R.done = true;
  document.getElementById('reviewWord').textContent = '本轮完成';
  document.getElementById('reviewPhonetic').textContent = '';
  const def = document.getElementById('reviewDef');
  def.classList.remove('hidden');
  def.textContent = srsMode
    ? ('已安排 ' + R.known + ' 个 · 需重来 ' + R.unknown + ' 个')
    : ('认识 ' + R.known + ' 个 · 不认识 ' + R.unknown + ' 个');
  document.getElementById('reviewCard').classList.remove('flipped');
  document.getElementById('reviewProgress').textContent = '共 ' + R.list.length + ' 个单词';
  reviewApplyControls(reviewDoneControls());
  document.getElementById('reviewSkipBtn').textContent = srsMode ? '返回生词本' : '再来一轮';
  if(srsMode){
    // 先用本地已就地更新的调度算「下次复习」（同步、无竞态），再异步回服务端校准
    const next = srsState.items.filter(x => x.due_at > srsNow()).sort((a,b) => a.due_at - b.due_at)[0];
    if(next) def.textContent += ' · 下次复习 ' + srsFmtLeft(next.due_at);
    srsLoad();
  }
}
function reviewExit(){
  document.getElementById('reviewPanel').classList.add('hidden');
  document.getElementById('nbToolbar').classList.remove('hidden');
  document.getElementById('nbList').classList.remove('hidden');
  reviewApplyControls({ srsGradeRow:true, reviewSkipBtn:false });
  srsMode = false;
  renderNotebook();   // 内部会调 srsRenderBadge，恢复顶部到期条
}
document.addEventListener('keydown', e=>{
  const panel = document.getElementById('reviewPanel');
  if(!panel || panel.closest('.hidden')) return;
  const t = e.target;
  if(t && (t.tagName==='INPUT' || t.tagName==='TEXTAREA')) return;
  if(e.key===' '){ e.preventDefault(); reviewFlip(); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); reviewNext(); }
  else if(e.key==='Escape'){ reviewExit(); }
});

/* ===== 后台管理（教师） ===== */
let pwStudentId = null;
async function loadAdmin(){
  const msg = document.getElementById('adminMsg');
  const box = document.getElementById('adminStudents');
  try{
    const res = await fetch('/api/admin/students');
    if(res.status===401){ currentUser=null; updateAuthUI(); settingsForceHide(); shareForceHide(); authShow(); return; }
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '加载失败');
    renderAdminStudents(data.students || []);
    msg.textContent='';
  }catch(e){
    msg.textContent = e.message || '加载失败';
    box.innerHTML='';
  }
}
/* 管理后台时间：服务端可能给秒或毫秒（1e12 为分界），统一成 M/D HH:mm。
   无记录返回破折号而非空串，保持表格列对齐。 */
function fmtAdminTime(ts){
  if(!ts) return '—';
  const d = ts>1e12 ? new Date(ts) : new Date(ts*1000);
  return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function adminStatusHTML(disabled){
  return disabled ? '<span class="badge off">已禁用</span>' : '<span class="badge">正常</span>';
}
/* 操作按钮一律走 data-* + 事件委托，绝不把姓名拼进 onclick。
   v1.8 遗留缺陷（已取证 admin-xss-probe.js）：原先写 onclick="openPwModal(id,'${esc(name)}')"，
   esc 做的是 HTML 实体转义（' → &#39;），而 HTML 属性值会先解码再交给 JS，
   于是实体还原成裸单引号，破坏 JS 字符串字面量：
     · 姓名含 ' （O'Brien）→ SyntaxError，重置密码按钮完全失效
     · 姓名含 \ （a\b）→ \b 被当转义序列，弹窗标题吞字符
   改为把 id 放 data-id、姓名放 data-name（属性值只需 HTML 转义，读取时浏览器自动解码），
   由委托处理器读 dataset 调用，彻底消除 JS 字符串注入面。 */
function adminActionsHTML(s){
  const id = Number(s.id) || 0;
  const toggle = s.disabled
    ? `<button class="btn ghost" data-act="toggle" data-id="${id}" data-disabled="0">启用</button>`
    : `<button class="btn ghost" data-act="toggle" data-id="${id}" data-disabled="1">禁用</button>`;
  return '<div class="admin-action">' +
    `<button class="btn ghost" data-act="pw" data-id="${id}" data-name="${esc(s.display_name)}">重置密码</button>` +
    toggle + '</div>';
}
function adminRowHTML(s){
  return '<tr>' +
    `<td class="stu">${esc(s.display_name)}</td>` +
    `<td>${esc(s.username)}</td>` +
    `<td>${adminStatusHTML(s.disabled)}</td>` +
    `<td>${s.record_count}</td>` +
    `<td>${fmtAdminTime(s.last_t)}</td>` +
    `<td>${adminActionsHTML(s)}</td>` +
    '</tr>';
}
const ADMIN_THEAD = '<tr><th>姓名</th><th>账号</th><th>状态</th><th>练习次数</th><th>最近练习</th><th>操作</th></tr>';
const ADMIN_EMPTY_HTML = '<div class="empty-tip">暂无学生账号</div>';
function renderAdminStudents(list){
  const box = document.getElementById('adminStudents');
  if(!list.length){ box.innerHTML = ADMIN_EMPTY_HTML; return; }
  box.innerHTML = '<div style="overflow-x:auto"><table>' + ADMIN_THEAD +
    list.map(adminRowHTML).join('') + '</table></div>';
}
/* 委托一次绑定即可（表格每次 loadAdmin 全量重绘，逐按钮绑定会泄漏）。
   姓名从 dataset 读，浏览器已解码属性实体，拿到的是原始字符串。 */
document.getElementById('adminStudents').addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if(!btn) return;
  const id = Number(btn.dataset.id);
  if(!id) return;
  if(btn.dataset.act === 'pw') openPwModal(id, btn.dataset.name || '');
  else if(btn.dataset.act === 'toggle') adminToggle(id, btn.dataset.disabled === '1');
});
async function adminCreateStudent(){
  const msg = document.getElementById('adminMsg');
  const username = document.getElementById('admUsername').value.trim();
  const displayName = document.getElementById('admDisplayName').value.trim();
  const password = document.getElementById('admPassword').value;
  msg.textContent='';
  try{
    const res = await fetch('/api/admin/students', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password, display_name:displayName})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '创建失败');
    document.getElementById('admUsername').value='';
    document.getElementById('admDisplayName').value='';
    document.getElementById('admPassword').value='';
    loadAdmin();
  }catch(e){ msg.textContent = e.message || '创建失败'; }
}
async function adminToggle(id, disabled){
  try{
    const res = await fetch('/api/admin/students/'+id+'/toggle', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({disabled})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '操作失败');
    loadAdmin();
  }catch(e){ document.getElementById('adminMsg').textContent = e.message || '操作失败'; }
}
function openPwModal(id, name){
  pwStudentId = id;
  document.getElementById('pwTarget').textContent = '为「'+name+'」设置新密码';
  document.getElementById('pwNew').value='';
  document.getElementById('pwError').textContent='';
  const modal = document.getElementById('pwModal');
  pwClosing = false;
  modal.classList.remove('hidden');
  // v2.1：改密弹窗与结算弹窗同通道同节奏
  if(window.StudioMotionEngine) StudioMotionEngine.modalIn(modal.querySelector('.auth-card'));
}
let pwClosing = false;
function closePwModal(){
  pwStudentId = null;
  const modal = document.getElementById('pwModal');
  if(modal.classList.contains('hidden') || pwClosing) return;
  const E = window.StudioMotionEngine;
  const card = modal.querySelector('.auth-card');
  const finish = () => { pwClosing = false; modal.classList.add('hidden'); };
  if(E && !E.isOff() && card){
    pwClosing = true;
    E.modalOut(card, { onDone: finish });
  }else{
    finish();
  }
}
async function adminSetPassword(){
  const password = document.getElementById('pwNew').value;
  const err = document.getElementById('pwError');
  err.textContent='';
  try{
    const res = await fetch('/api/admin/students/'+pwStudentId+'/password', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password})});
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || '操作失败');
    closePwModal();
    loadAdmin();
  }catch(e){ err.textContent = e.message || '操作失败'; }
}
function exportRecords(){ window.location.href = '/api/admin/export'; }

let chartResizeFrame = 0;
window.addEventListener('resize', ()=>{
  focusMeasureCacheInvalidate();   // 视口变化 → 目标布局量测缓存失效
  if(chartResizeFrame || document.getElementById('page-history').classList.contains('hidden')) return;
  chartResizeFrame = requestAnimationFrame(()=>{
    chartResizeFrame = 0;
    if(!document.getElementById('page-history').classList.contains('hidden')) drawChart(historyRecords);
  });
});
document.getElementById('ignoreCaseToggle').addEventListener('click', e=>{
  if(e.detail && hasActiveTestSession()) focusTypeInput();
});
// Keep keyboard focus on the topmost visible dialog.
(function initStudioDialogs(){
  const dialogs = ['pwModal','authModal','modal','settingsModal','shareModal'].map(id=>document.getElementById(id));
  // 取「最上层」可见对话框：按计算 z-index 降序，而非数组顺序。
  // 分享卡（z-index 106）叠在结果弹窗（100）之上，若按数组顺序取会误关底层弹窗。
  const getDialog = () => dialogs
    .filter(el=>!el.classList.contains('hidden'))
    .sort((a,b)=>(parseInt(getComputedStyle(b).zIndex)||0)-(parseInt(getComputedStyle(a).zIndex)||0))[0];
  const focusables = dialog => Array.from(dialog.querySelectorAll('button:not([disabled]),input:not([disabled])')).filter(el=>el.getClientRects().length);
  let previous = null;
  const update = () => {
    const active = getDialog();
    document.getElementById('appMain').inert = !!active;
    document.getElementById('sidebar').inert = !!active;
    const fExit = document.getElementById('focusExit');
    if(fExit) fExit.inert = !!active;
    if(active && active!==previous){
      // 设置面板：焦点落在当前分段的第一个可操作元素（外观→选中色板，账号→昵称输入）
      const target = active.id==='settingsModal'
        ? (settingsPane==='account'
            ? (document.getElementById('accountDisplayName') || focusables(active)[0])
            : (active.querySelector('.accent-swatch[aria-pressed="true"]') || focusables(active)[0]))
        : (active.querySelector('input') || focusables(active)[0]);
      if(target) target.focus({preventScroll:true});
    }else if(!active && previous && document.activeElement===document.body){
      if(previous.id==='authModal' && currentUser) focusDailyInput();
      else if(previous.id==='settingsModal'){
        // 侧栏 visibility 过渡未结束时入口尚不可聚焦，过渡完成后兜底补焦
        setTimeout(()=>{
          if(getDialog()) return;
          const entry = document.getElementById('settingsEntry');
          if(entry && entry.getClientRects().length) entry.focus({preventScroll:true});
          else focusStudioNavigation();
        }, 220);
      }
      else focusStudioNavigation();
    }
    previous = active;
  };
  const observer = new MutationObserver(update);
  dialogs.forEach(el=>observer.observe(el,{attributes:true,attributeFilter:['class']}));
  document.getElementById('settingsModal').addEventListener('click', e=>{
    if(e.target.id==='settingsModal') closeSettings();
  });
  document.addEventListener('keydown', e=>{
    const active = getDialog();
    if(e.key==='Escape'){
      if(active && active.id==='pwModal') closePwModal();
      else if(active && active.id==='modal') closeModal();
      else if(active && active.id==='settingsModal') closeSettings();
      else if(active && active.id==='shareModal') closeShareCard();
      else if(!active && focusLevel > 0 && !(S.text && !S.finished)) focusStepDown(); // 打字会话内的 Esc 已由 typeKeydown 处理
      else if(!active && document.getElementById('sidebar').classList.contains('open')) closeSidebar(true);
    }
    if(e.key!=='Tab' || !active) return;
    const items = focusables(active);
    if(!items.length) return;
    const index = items.indexOf(document.activeElement);
    if(index<0 || (!e.shiftKey && index===items.length-1) || (e.shiftKey && index===0)){
      e.preventDefault();
      items[e.shiftKey ? items.length-1 : 0].focus();
    }
  });
})();
// 无障碍：role="button" 元素支持 Enter/Space 键盘触发
document.addEventListener('keydown', e=>{
  const t = e.target;
  if(!t || !t.getAttribute || t.getAttribute('role')!=='button') return;
  if(t.tagName==='INPUT' || t.tagName==='TEXTAREA') return;
  if(e.key==='Enter' || e.key===' '){
    e.preventDefault();
    t.click();
  }
});
