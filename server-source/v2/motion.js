/* ============================================================
   motion.js — v2.0 统一动画引擎

   提炼自 demo/app-open-animation.html 的四条机制：
     ① 单一缓动 + 三档时长令牌，全站共用，杜绝各写各的曲线
     ② 错峰分层（0 / D×0.18 / D×0.34），造层次感而非齐步走
     ③ 几何变形只由一个层承担；其余层只走 transform / opacity 合成
     ④ 预模糊双层：blur 是静态滤镜，只切 opacity，绝不动画 blur 本身

   两种动画通道，按内容性质分流（这是 v2.0 的核心判断）：
     · flip()  飞行克隆层 + WAAPI —— 只用于【内容静态】的转场
               （Tab 切换 / 弹窗开合 / 卡片进出）。克隆层是位图快照，
               内容在变形期间不需要可读、可交互、随宽度重排。
     · dolly() 单 rAF 逐帧布局插值 —— 用于【内容必须活着】的几何变形
               （专注模式 half→full）。因为 #typeArea 是 pre-wrap +
               overflow-wrap:anywhere + clamp 字号，宽度变则断行变；
               liveCurve canvas 每帧按当帧宽重绘；打字首键触发时焦点不能断。
               克隆层在这三条上物理不成立，故保留逐帧通道，但共用同一缓动与时长。

   v2.1 增补两条页面级通道（手机应用式转场，纯合成层）：
     · pageCross()  栏目切换双页交叉：旧页反向快速淡出 + 新页错峰方向淡入，
                    代际号防连切竞态，任何时候至多一对页面在飞。
     · sheetIn/Out() 设置页开合：从入口卡片方向展开 / 沿同一曲线收回，
                    开与关互逆呼应；移动端自动变底部抽屉语义。

   档位：StudioMotion full / lite / off（off 与 reduced-motion 直切）。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- ① 统一缓动与时长令牌 ----------
     v2.2：令牌的唯一真源是 tokens.css，本文件启动时读进来。
     下面的 FALLBACK 只在「CSS 尚未解析完 / 变量被误删」时兜底，
     正常路径下永远不会用到 —— 改节奏请改 tokens.css，不要改这里。

     曾经的坑：CSS 与 JS 各写一份 180/320/500 与同一条贝塞尔串，
     靠注释「请保持一致」维系。这类约定必然漂移（v2.1 的 lite 档就
     只改了 CSS 没改 JS）。现在 JS 读 --motion-base-*（原值，不随档位变），
     档位换算仍由下面的 dur() 独揽 —— 若读 --dur-*（已减半值），
     lite 档会被减半两次。 */

  var FALLBACK = {
    ease: 'cubic-bezier(0.32, 0.72, 0, 1)',
    easeOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
    easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    micro: 180, base: 320, macro: 500, tap: 90,
    stagger: 28, staggerMid: 0.18, staggerTrail: 0.34,
    back: 0.72
  };

  var ROOT = document.documentElement;

  function cssVar(name) {
    try {
      var v = getComputedStyle(ROOT).getPropertyValue(name);
      return v ? v.trim() : '';
    } catch (e) { return ''; }
  }

  /** 读毫秒令牌：支持 "180ms" / "0.18s" / "180" 三种写法 */
  function cssMs(name, fb) {
    var v = cssVar(name);
    if (!v) return fb;
    var n = parseFloat(v);
    if (!isFinite(n)) return fb;
    if (/(^|[^m])s$/.test(v)) return Math.round(n * 1000);   // 秒 → 毫秒，但 ms 结尾不算
    return Math.round(n);
  }

  function cssNum(name, fb) {
    var v = cssVar(name);
    if (!v) return fb;
    var n = parseFloat(v);
    return isFinite(n) ? n : fb;
  }

  /** 从 "cubic-bezier(a,b,c,d)" 抠出四个数；抠不动就用兜底串 */
  function cssEase(name, fb) {
    var v = cssVar(name) || fb;
    var m = v.match(/cubic-bezier\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    if (!m) return { css: fb, pts: parseBezierPoints(fb) };
    return {
      css: 'cubic-bezier(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + m[4] + ')',
      pts: [+m[1], +m[2], +m[3], +m[4]]
    };
  }

  function parseBezierPoints(str) {
    var fb = [0.32, 0.72, 0, 1];
    var m = String(str).match(/cubic-bezier\s*\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    return m ? [+m[1], +m[2], +m[3], +m[4]] : fb;
  }

  var _ease = cssEase('--ease', FALLBACK.ease);
  var _easeOut = cssEase('--ease-out', FALLBACK.easeOut);
  var _easeInOut = cssEase('--ease-inout', FALLBACK.easeInOut);

  // demo 原值：iOS 式「快起慢落」，尾段极平坦，落定观感柔和
  var EASE = _ease.css;
  var EASE_OUT = _easeOut.css;
  var EASE_INOUT = _easeInOut.css;

  var DUR = {
    micro: cssMs('--motion-base-micro', FALLBACK.micro),  // 微交互：hover / 按键反馈 / 小徽章
    base: cssMs('--motion-base-base', FALLBACK.base),     // 转场：Tab 切换 / 弹窗 / 卡片
    macro: cssMs('--motion-base-macro', FALLBACK.macro),  // 大几何：专注模式推近拉远
    tap: cssMs('--motion-base-tap', FALLBACK.tap)         // 按压：比 micro 更短，手感才锐利
  };

  // 错峰比例（demo：0 / 0.18 / 0.34）
  var STAGGER = {
    lead: 0,
    mid: cssNum('--stagger-ratio-mid', FALLBACK.staggerMid),
    trail: cssNum('--stagger-ratio-trail', FALLBACK.staggerTrail),
    step: cssMs('--motion-base-stagger', FALLBACK.stagger)  // 列表逐项延迟基数
  };

  // 回撤比例：所有「关」的动作都比「开」短，开合才互逆
  var BACK = cssNum('--motion-back', FALLBACK.back);

  /* 编排节拍：一次转场拆成几个先行/并行的子层时用的内部比例。
     这些不是档位令牌（不随 lite 变化），而是「同一支舞怎么分拍」的
     编舞常数。集中在此，免得散落成一堆认不出来的 0.45 / 0.62 / 0.88。 */
  var BEAT = {
    flipGlyph: 0.72,    // 克隆层字形放大淡出：占主几何 0.72D，错峰 0.18D 起
    flipReveal: 0.62,   // 真实内容浮现：更短更晚，收尾不拖尾巴
    pageOut: 0.45,      // 旧页退场只给 0.45D，快速让位给新页
    pageOutShift: 0.6,  // 旧页反向位移量 = dx × 0.6
    pageInDelay: 0.12,  // 新页延迟 0.12D 起步（错峰机制的页面版）
    pageIn: 0.88        // 新页用余下 0.88D 走完
  };

  function motionMode() {
    return (window.StudioMotion && window.StudioMotion.get()) || 'full';
  }
  function isOff() { return motionMode() === 'off'; }
  function isLite() { return motionMode() === 'lite'; }

  /** 按档位换算实际时长：full 原值 / lite ×0.5 / off 0 */
  function dur(key) {
    var base = typeof key === 'number' ? key : (DUR[key] || DUR.base);
    if (isOff()) return 0;
    if (isLite()) return Math.round(base * 0.5);
    return base;
  }

  /** 把 CSS 缓动串采样成 JS 函数，供 rAF 通道与 WAAPI 通道共用同一条曲线。
      三次贝塞尔牛顿迭代求解，精度 1e-6，足够逐帧几何使用。 */
  function bezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    function sx(t) { return ((ax * t + bx) * t + cx) * t; }
    function sy(t) { return ((ay * t + by) * t + cy) * t; }
    function dx(t) { return (3 * ax * t + 2 * bx) * t + cx; }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var e = sx(t) - x;
        if (Math.abs(e) < 1e-6) return sy(t);
        var d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= e / d;
      }
      var lo = 0, hi = 1; t = x;
      for (var j = 0; j < 40; j++) {
        var v = sx(t);
        if (Math.abs(v - x) < 1e-6) break;
        if (v < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
        if (hi - lo < 1e-7) break;
      }
      return sy(t);
    };
  }
  var easeFn = bezier(_ease.pts[0], _ease.pts[1], _ease.pts[2], _ease.pts[3]);
  var easeOutFn = bezier(_easeOut.pts[0], _easeOut.pts[1], _easeOut.pts[2], _easeOut.pts[3]);

  /* ---------- ② 预模糊双层（机制④） ----------
     不动画 blur：准备好清晰层与预模糊层，只交叉切 opacity。
     大尺寸常驻 blur 是性能红线，这里彻底规避。 */
  function ensureBlurLayer(host, opts) {
    opts = opts || {};
    var cls = opts.className || 'motion-blur-layer';
    var layer = null;
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].classList.contains(cls)) { layer = host.children[i]; break; }
    }
    if (!layer) {
      layer = document.createElement('div');
      layer.className = cls;
      layer.setAttribute('aria-hidden', 'true');
      host.appendChild(layer);
    }
    return layer;
  }

  /** 背景虚化开关：只切 opacity，blur 值恒定 */
  function setBackdropBlur(host, on, ms) {
    var layer = ensureBlurLayer(host);
    var d = ms == null ? dur('base') : ms;
    layer.style.transition = d ? ('opacity ' + d + 'ms ' + EASE) : 'none';
    layer.style.opacity = on ? '1' : '0';
    return layer;
  }

  /* ---------- ③ 飞行克隆层 FLIP（机制①②③） ----------
     只用于内容静态的转场。调用方给出 from / to 两个矩形，
     本函数克隆源元素、绝对定位、用 WAAPI 插值几何，落定后移除克隆。 */

  var flySeq = 0;
  var activeFlies = new Map();

  function localRect(el, host) {
    // 响应式缩放下换算到 host 的局部坐标（demo 的 localRect 思路）
    var hr = host.getBoundingClientRect();
    var scale = host.offsetWidth ? (hr.width / host.offsetWidth) : 1;
    if (!scale) scale = 1;
    var r = el.getBoundingClientRect();
    return {
      x: (r.left - hr.left) / scale,
      y: (r.top - hr.top) / scale,
      w: r.width / scale,
      h: r.height / scale
    };
  }

  function makeFly(source, rect, host, radius) {
    var fly = document.createElement('div');
    fly.className = 'motion-fly';
    fly.dataset.flyId = String(++flySeq);
    fly.style.position = 'absolute';
    fly.style.left = rect.x + 'px';
    fly.style.top = rect.y + 'px';
    fly.style.width = rect.w + 'px';
    fly.style.height = rect.h + 'px';
    fly.style.borderRadius = (radius != null ? radius : 12) + 'px';
    fly.style.overflow = 'hidden';
    fly.style.pointerEvents = 'none';
    fly.style.zIndex = '60';
    fly.style.willChange = 'transform, opacity';
    // 克隆内容（静态快照）：去掉 id 避免重复，去掉 script
    var inner = source.cloneNode(true);
    inner.removeAttribute('id');
    inner.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    inner.querySelectorAll('script').forEach(function (n) { n.remove(); });
    inner.style.margin = '0';
    inner.style.width = '100%';
    inner.style.height = '100%';
    fly.appendChild(inner);
    host.appendChild(fly);
    return fly;
  }

  /**
   * FLIP 转场。
   * @param {Object} cfg
   *   source   源元素（提供静态内容快照）
   *   from     起始矩形 {x,y,w,h}（host 局部坐标）
   *   to       终止矩形
   *   host     承载克隆层的定位容器（默认 document.body）
   *   duration 时长键或毫秒（默认 'base'）
   *   radius   [fromRadius, toRadius]
   *   reveal   落定时要显示的真实元素（飞行期间它 opacity:0）
   *   onDone   落定回调
   * @returns {Promise}
   */
  function flip(cfg) {
    var host = cfg.host || document.body;
    var D = dur(cfg.duration || 'base');
    var reveal = cfg.reveal || null;

    // off 档：直切，不建克隆层
    if (!D || !cfg.source || !cfg.from || !cfg.to) {
      if (reveal) { reveal.style.opacity = ''; reveal.style.transform = ''; }
      if (cfg.onDone) cfg.onDone();
      return Promise.resolve();
    }

    var r0 = cfg.radius ? cfg.radius[0] : 12;
    var r1 = cfg.radius ? cfg.radius[1] : r0;
    var fly = makeFly(cfg.source, cfg.from, host, r0);
    var f = cfg.from, t = cfg.to;

    if (reveal) { reveal.style.opacity = '0'; }

    // 主几何：唯一参与变形的层
    var a1 = fly.animate([
      { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px', borderRadius: r0 + 'px' },
      { left: t.x + 'px', top: t.y + 'px', width: t.w + 'px', height: t.h + 'px', borderRadius: r1 + 'px' }
    ], { duration: D, easing: EASE, fill: 'forwards' });

    // 错峰层一：克隆内容放大淡出（demo 的 glyph）
    var inner = fly.firstElementChild;
    var a2 = null;
    if (inner && cfg.glyph !== false) {
      a2 = inner.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(' + (cfg.glyphScale || 1.6) + ')', opacity: 0 }
      ], { duration: D * BEAT.flipGlyph, delay: D * STAGGER.mid, easing: EASE_INOUT, fill: 'forwards' });
    }

    // 错峰层二：真实内容浮现
    var a3 = null;
    if (reveal) {
      a3 = reveal.animate([
        { opacity: 0, transform: 'scale(1.02)' },
        { opacity: 1, transform: 'scale(1)' }
      ], { duration: D * BEAT.flipReveal, delay: D * STAGGER.trail, easing: EASE_OUT, fill: 'forwards' });
    }

    var id = fly.dataset.flyId;
    activeFlies.set(id, { fly: fly, anims: [a1, a2, a3].filter(Boolean) });

    var all = [a1, a2, a3].filter(Boolean).map(function (a) { return a.finished; });
    return Promise.all(all).then(function () {
      cleanupFly(id);
      if (reveal) { reveal.style.opacity = ''; reveal.style.transform = ''; }
      if (cfg.onDone) cfg.onDone();
    }).catch(function () {
      cleanupFly(id);
      if (reveal) { reveal.style.opacity = ''; reveal.style.transform = ''; }
    });
  }

  function cleanupFly(id) {
    var rec = activeFlies.get(id);
    if (!rec) return;
    rec.anims.forEach(function (a) { try { a.cancel(); } catch (e) {} });
    if (rec.fly.parentNode) rec.fly.parentNode.removeChild(rec.fly);
    activeFlies.delete(id);
  }

  /** 中断所有在途飞行（Tab 连点 / 路由突变时防竞态） */
  function cancelFlies() {
    Array.from(activeFlies.keys()).forEach(cleanupFly);
  }

  /* ---------- ④ 单 rAF 逐帧通道（内容必须活着时用） ----------
     与 FLIP 共用缓动与时长令牌，但几何由调用方逐帧写真实 DOM。
     内含 demo 没有、但本项目实测必需的两条保护：
       · 首帧时间戳锚定（rAF 的 now 可能早于调用时刻，否则首帧 raw 为负→缓动外插→反向回弹）
       · 末帧用 performance.now() 复核（rAF 的 now 是帧起始时间戳，
         直接用会让最后一帧停在 0.96~0.99，opacity 差一截造成落定「啪」地亮起） */

  var dollyState = { gen: 0, raf: 0 };

  /**
   * @param {Object} cfg
   *   duration 时长键或毫秒
   *   ease     缓动函数（默认统一缓动）
   *   onFrame(t, now)  逐帧回调，t 为已缓动进度
   *   onSettle()       落定回调（同帧调用，交还 CSS）
   *   onStart()        起镜同帧回调（钉住起点，避免目标布局闪现）
   * @returns {number} 本次镜头代号
   */
  function dolly(cfg) {
    var D = dur(cfg.duration == null ? 'macro' : cfg.duration);
    var ease = cfg.ease || easeFn;

    // 中断安全：先停旧时钟再自增代号，过期 step 凭代号自动退出
    if (dollyState.raf) { cancelAnimationFrame(dollyState.raf); dollyState.raf = 0; }
    var gen = ++dollyState.gen;

    if (!D) {
      if (cfg.onStart) cfg.onStart();
      if (cfg.onFrame) cfg.onFrame(1, performance.now());
      if (cfg.onSettle) cfg.onSettle();
      return gen;
    }

    if (cfg.onStart) cfg.onStart();
    if (cfg.onFrame) cfg.onFrame(0, performance.now());

    var t0 = 0;
    function step(now) {
      if (gen !== dollyState.gen) return;
      if (!t0) t0 = now;            // 首帧锚定
      var raw = Math.max(0, Math.min(1, (now - t0) / D));
      var t = ease(raw);
      if (cfg.onFrame) cfg.onFrame(t, now);

      if (raw < 1) {
        // 末帧复核：真实时间没走完就继续飞
        var realRaw = (performance.now() - t0) / D;
        if (realRaw < 1) { dollyState.raf = requestAnimationFrame(step); return; }
        // 真实时间已到但本帧 raw 未到 1：同帧补精确终值
        if (cfg.onFrame) cfg.onFrame(1, performance.now());
      }
      if (gen !== dollyState.gen) return;   // 落定前再验代号
      dollyState.raf = 0;
      if (cfg.onSettle) cfg.onSettle();
    }
    dollyState.raf = requestAnimationFrame(step);
    return gen;
  }

  function cancelDolly() {
    if (dollyState.raf) { cancelAnimationFrame(dollyState.raf); dollyState.raf = 0; }
    dollyState.gen++;
  }

  /* ---------- ⑤ 通用入场 / 退场（只走合成层） ---------- */

  /** 元素入场：translate + opacity，绝不 scale 大尺寸常驻层 */
  function enter(el, opts) {
    opts = opts || {};
    var D = dur(opts.duration || 'base');
    if (!el) return Promise.resolve();
    if (!D) { el.style.opacity = ''; el.style.transform = ''; return Promise.resolve(); }
    var dy = opts.dy == null ? 8 : opts.dy;
    var dx = opts.dx || 0;
    var a = el.animate([
      { opacity: 0, transform: 'translate(' + dx + 'px,' + dy + 'px)' },
      { opacity: 1, transform: 'translate(0,0)' }
    ], { duration: D, delay: opts.delay || 0, easing: EASE_OUT, fill: 'both' });
    return a.finished.then(function () {
      try { a.cancel(); } catch (e) {}
      el.style.opacity = ''; el.style.transform = '';
    }).catch(function () {});
  }

  function leave(el, opts) {
    opts = opts || {};
    var D = dur(opts.duration || 'micro');
    if (!el) return Promise.resolve();
    if (!D) { el.style.opacity = '0'; return Promise.resolve(); }
    var dy = opts.dy == null ? -6 : opts.dy;
    var a = el.animate([
      { opacity: 1, transform: 'translate(0,0)' },
      { opacity: 0, transform: 'translate(0,' + dy + 'px)' }
    ], { duration: D, easing: EASE, fill: 'forwards' });
    return a.finished.catch(function () {});
  }

  /** 列表错峰入场：每项延迟 index×step，上限 maxDelay 防长列表拖尾。
      step 默认取令牌 --motion-base-stagger（28ms），与 CSS 侧 --stagger-step 同源。
      maxDelay 用 8×step（216ms ≈ 原 220）：长列表到第 8 项就不再往后推，
      否则 60 条语料会拖出 1.7 秒的尾巴，末项还没出来用户已经滚走了。 */
  function staggerEnter(els, opts) {
    opts = opts || {};
    var step = opts.step == null ? STAGGER.step : opts.step;
    var maxDelay = opts.maxDelay == null ? step * 8 : opts.maxDelay;
    var arr = Array.from(els || []);
    return Promise.all(arr.map(function (el, i) {
      return enter(el, Object.assign({}, opts, { delay: Math.min(i * step, maxDelay) }));
    }));
  }

  /* ---------- ⑥ v2.1 页面级转场（手机应用式，纯合成层） ----------
     两条通道，同一节奏源（EASE + 时长令牌），开与关互逆呼应：

     · pageCross(out, inn, dir)  栏目/页面切换的双页交叉：
         旧页反向快速淡出（0.45D），新页错峰 0.12D 方向性淡入（余下 0.88D）。
         旧页退场期间 position:absolute 脱流（新页立即占据布局位），
         避免两页同屏纵向堆叠 causing 滚动条闪跳。
         代际号防竞态：连切时旧动画立即 cancel 并把上一轮的两页钉回终值，
         任何时候至多一对页面在飞，杜绝叠加与残影。

     · sheetIn/sheetOut(panel, anchor)  设置页开合：
         开：从入口卡片的位置与尺寸感（translate + scale 0.96）展开到面板本体；
         关：沿同一曲线收回入口方向（时长 0.72D，方向互逆）。
         移动端（面板贴底全宽）自动改底部抽屉语义：translateY 滑入滑出。
         面板内容是活的（表单/取色器），故不建克隆层，只对面板本体做合成层变换。 */

  /* 页面转场按「作用域」分组：Tab 级（.wrap 下的 page-*）与页内级
     （#page-daily 的三分段、课程菜单↔文章列表）是不同父容器下的独立切换，
     共享单例会互相误杀 —— Tab 入场播到一半时页内切分段，不该把 Tab 动画取消。
     每个 scope 独立代际号与在途记录，同 scope 连切才取消上一轮。 */
  var pageStates = new WeakMap();   // scopeEl -> {gen, anims:[{el,anim}]}
  function pageState(scope) {
    var st = pageStates.get(scope);
    if (!st) { st = { gen: 0, anims: [] }; pageStates.set(scope, st); }
    return st;
  }

  function pageKill(scope) {
    var st = pageState(scope);
    st.gen++;
    st.anims.forEach(function (rec) {
      try { rec.anim.cancel(); } catch (e) {}
      // 钉终值：cancel 会回滚 fill 效果，必须显式清掉退场期挂的内联样式
      rec.el.style.opacity = '';
      rec.el.style.transform = '';
      rec.el.style.position = '';
      rec.el.style.left = '';
      rec.el.style.top = '';
      rec.el.style.right = '';
      rec.el.style.width = '';
      rec.el.style.pointerEvents = '';
      rec.el.style.zIndex = '';
      // 被中断的退场页必须立即隐藏 —— 它的「加 hidden」回调因代际过期不会再执行，
      // 不补这一刀会残留一个脱流的幽灵页（新页已可见，旧页还叠在上面）。
      if (rec.role === 'out') rec.el.classList.add('hidden');
    });
    st.anims = [];
  }

  /**
   * 双页交叉转场。调用方先完成显隐类切换（新页已可见），再调本函数。
   * @param {Element|null} out 旧页（可为 null：首次进入）
   * @param {Element} inn 新页
   * @param {number} dir +1 前进 / -1 后退（决定位移方向）
   * @param {Object} opts { duration, dx, scope } scope 缺省取 inn.parentNode
   */
  function pageCross(out, inn, dir, opts) {
    opts = opts || {};
    if (!inn) return Promise.resolve();
    var scope = opts.scope || inn.parentNode;
    pageKill(scope);
    var st = pageState(scope);
    var gen = st.gen;
    var D = dur(opts.duration || 'base');
    if (!D) {
      if (out && out !== inn) out.classList.add('hidden');
      return Promise.resolve();
    }
    var dx = (opts.dx == null ? 22 : opts.dx) * (dir >= 0 ? 1 : -1);
    var anims = [];

    // 旧页：脱流叠在原位反向淡出。宽度锁到父容器内容宽，避免脱流后 shrink。
    // 顺序契约：先量 offsetLeft/Top（流内真实位置），再挂 absolute。
    if (out && out !== inn && !out.classList.contains('hidden')) {
      var parent = out.parentNode;
      var ox = out.offsetLeft, oy = out.offsetTop;
      out.style.position = 'absolute';
      out.style.left = ox + 'px';
      out.style.top = oy + 'px';
      out.style.right = 'auto';
      out.style.width = parent.clientWidth + 'px';
      out.style.pointerEvents = 'none';
      out.style.zIndex = '1';
      var aOut = out.animate([
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(' + (-dx * BEAT.pageOutShift) + 'px)' }
      ], { duration: D * BEAT.pageOut, easing: EASE, fill: 'forwards' });
      var recOut = { el: out, anim: aOut, role: 'out' };
      st.anims.push(recOut);
      anims.push(aOut.finished.then(function () {
        if (gen !== st.gen) return;   // 已被新一轮接管，不再写 DOM
        out.classList.add('hidden');
        out.style.opacity = ''; out.style.transform = '';
        out.style.position = ''; out.style.left = ''; out.style.top = '';
        out.style.right = ''; out.style.width = '';
        out.style.pointerEvents = ''; out.style.zIndex = '';
        try { aOut.cancel(); } catch (e) {}
        // 从在途表移除：finished 的动画若留在表里，_pageAnims 会把已完成的也算成在途
        var i = st.anims.indexOf(recOut);
        if (i >= 0) st.anims.splice(i, 1);
      }).catch(function () {}));
    }

    // 新页：错峰 0.12D 方向性淡入（demo 错峰机制的页面版）
    var aIn = inn.animate([
      { opacity: 0, transform: 'translateX(' + dx + 'px)' },
      { opacity: 1, transform: 'translateX(0)' }
    ], { duration: D * BEAT.pageIn, delay: D * BEAT.pageInDelay, easing: EASE_OUT, fill: 'both' });
    var recIn = { el: inn, anim: aIn, role: 'in' };
    st.anims.push(recIn);
    anims.push(aIn.finished.then(function () {
      if (gen !== st.gen) return;
      inn.style.opacity = ''; inn.style.transform = '';
      try { aIn.cancel(); } catch (e) {}
      var i = st.anims.indexOf(recIn);
      if (i >= 0) st.anims.splice(i, 1);
    }).catch(function () {}));

    return Promise.all(anims);
  }

  /* 每个面板独立代际与在途记录：设置页与分享卡可先后/交错开合，
     共享单例会让「关分享」误杀「开设置」的在途动画。 */
  var sheetStates = new WeakMap();   // panel -> {gen, anim, anchorRect, fly, flyAnims}
  function sheetState(panel) {
    var st = sheetStates.get(panel);
    if (!st) { st = { gen: 0, anim: null, anchorRect: null, fly: null, flyAnims: null }; sheetStates.set(panel, st); }
    return st;
  }

  function sheetKill(panel) {
    // 不传 panel：清全部（logout / 401 强制下线路径）
    if (!panel) {
      sheetAll.forEach(function (p) { sheetKill(p); });
      return;
    }
    var st = sheetState(panel);
    st.gen++;
    if (st.anim) {
      try { st.anim.cancel(); } catch (e) {}
      panel.style.opacity = '';
      panel.style.transform = '';
      st.anim = null;
    }
    /* 飞行层：中断时可能正挂在 body 上。不摘会留在屏幕上当一个假面板。 */
    sheetFlyKill(st);
    /* 子内容与遮罩上也有在途动画（错峰浮现 / 遮罩渐变）：
       cancel 会回滚 fill，必须连带清掉内联值，否则中断后会留下半透明的面板内容。 */
    sheetContentKill(panel);
    var scrim = panel.parentNode;
    if (scrim && scrim !== document.body) {
      scrim.getAnimations().forEach(function (a) { try { a.cancel(); } catch (e) {} });
      scrim.style.backgroundColor = '';
    }
  }
  var sheetAll = [];   // 见过的面板（数量级：个位数，线性遍历即可）

  /** 面板是否处于「贴底全宽抽屉」布局（≤650px 断点由 CSS 决定，这里量实际几何） */
  function sheetIsDrawer(panel) {
    var r = panel.getBoundingClientRect();
    var pr = panel.parentNode.getBoundingClientRect();
    return r.width >= pr.width - 2 && Math.abs(r.bottom - pr.bottom) < 4;
  }

  /* ---------- 面板开合的分工：飞行层管几何，本体管显影 ----------
     demo 的 openFLIP 是两套东西并行：
       ① makeFly 克隆层：left/top/width/height 从图标矩形**非等比**插值到全屏
       ② appEl：opacity 0→1 + scale(1.03)→1，delay 0.34D
     几何全压在克隆层上，所以非等比不会把 App 里的文字拉变形 —— 壳里没有真文字。

     面板不能整体克隆（内容是活的：输入框、Tab、开关），早先就让**本体**去承担
     几何，做成「等面积等比缩放」。结果是中心对上了、轮廓对不上：入口是 193×59 的
     横条，等比后起点却成了 85×133 的竖条。等比缩放 26 倍面积时，本来就不可能同时
     贴合非等比的入口形状 —— 这是几何上的死结，不是参数没调好。

     现在照 demo 分工：飞行层是一个**纯壳**（底色/边框/圆角/阴影，无子节点）做非等比
     几何；面板本体全程不动几何，等壳长到接近终态再交叉淡入。末帧两者矩形几乎重合，
     接缝看不出来。 */

  /* 交叉淡入的分拍。**全部用绝对时间（delay + duration）表达，不用 keyframe offset。**
     WAAPI 的 easing 作用于整条时间轴而非单个关键帧段：若把「offset 0.74 处还是 1」
     写进带 EASE_OUT 的 keyframes，缓动会把进度整体提前，实测在 36% 进度就开始淡出；
     而本体的 delay 是绝对时间不受缓动影响，两边一错位，中间会有约 120ms 屏幕上什么
     都没有（壳已淡完、本体还没显）。拆成两条独立动画，交叠区才是真的。 */
  var FLY_HOLD = 0.68;   // 壳开始淡出的时间（× D）
  var FLY_GONE = 0.92;   // 壳彻底消失
  var PANEL_START = 0.64; // 本体开始显影（比壳早一点，保证有交叠）
  var PANEL_FULL = 0.90;  // 本体完全不透明
  /* 内容错峰：几何落定之后再归位，观感是「先有卡、后有内容」 */
  var KID_AT = 0.80;
  var KID_DUR = 0.30;
  var KID_STEP = 0.04;

  /** 面板的视觉壳（飞行层要长得和本体一模一样，交接才无缝） */
  function sheetShell(panel) {
    var cs = getComputedStyle(panel);
    return {
      bg: cs.backgroundColor,
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow
    };
  }

  /** 造飞行层。用 position:fixed + 视口矩形，所以挂 body
      （挂进遮罩会被它的 padding 平移，矩形就对不上了）。
      z-index 高于 #settingsModal(105)，语义同 demo 的 .fly{40} 压在 .app{30} 之上。 */
  function sheetFlyMake(rect, shell, radius) {
    var el = document.createElement('div');
    el.className = 'sheet-fly';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;margin:0;padding:0;box-sizing:border-box;' +
      'pointer-events:none;z-index:210;' +
      'background:' + shell.bg + ';border:' + shell.border + ';' +
      'box-shadow:' + shell.shadow + ';' +
      'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
      'width:' + rect.width + 'px;height:' + rect.height + 'px;' +
      'border-radius:' + radius + ';';
    document.body.appendChild(el);
    return el;
  }

  function sheetFlyKill(st) {
    if (!st || !st.fly) return;
    st.fly.getAnimations().forEach(function (a) { try { a.cancel(); } catch (e) {} });
    if (st.fly.parentNode) st.fly.parentNode.removeChild(st.fly);
    st.fly = null;
    st.flyAnims = null;
  }

  /** 遮罩渐变：从「同色但透明」起步/收尾，换主题不会残留写死的 rgba */
  function sheetScrim(scrim, D, showing) {
    if (!scrim || scrim === document.body) return null;
    var bg = getComputedStyle(scrim).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return null;
    var zero = withAlphaZero(bg);
    return scrim.animate(
      showing ? [{ backgroundColor: zero }, { backgroundColor: bg }]
              : [{ backgroundColor: bg }, { backgroundColor: zero }],
      { duration: D, easing: showing ? EASE_OUT : EASE, fill: 'both' });
  }

  /** 开合形态判定：贴底抽屉 / 有入口（飞行层几何） / 无入口（就地淡入） */
  function sheetPlan(panel, anchorRect, opening) {
    var r = panel.getBoundingClientRect();
    if (sheetIsDrawer(panel)) {
      // 抽屉：滑出屏底（opening 时是「起点」，closing 时是「终点」）
      var dy = Math.max(60, r.height * 0.6);
      return { mode: 'slide', transform: 'translateY(' + dy + 'px)', opacity: opening ? 0.4 : 0 };
    }
    if (anchorRect && anchorRect.width && r.width && r.height) {
      return { mode: 'fly', rect: r };
    }
    // 无入口（如分享卡）：保底从下方 24px 处淡入并略微放大
    return { mode: 'fade', transform: 'translate(0,24px) scale(0.94)', opacity: 0 };
  }

  /* 把 #rrggbb / rgb() / rgba() 统一降成同色但 alpha=0 的串。
     遮罩渐隐渐显要用它：从「同色透明」起步而不是写死一个 rgba，
     主题换色时不用回来改这里。 */
  function withAlphaZero(color) {
    var m = color.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return 'transparent';
    var p = m[1].split(',').map(function (s) { return s.trim(); });
    if (p.length === 4) { p[3] = '0'; return 'rgba(' + p.join(',') + ')'; }
    return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',0)';
  }

  /* 面板内容的错峰浮现。
     几何在「一个空壳长大」，文字若全程跟着缩放会被压成一团糊；
     demo 的做法是克隆层里换成放大的字形再淡出，面板不能用克隆（内容是活的），
     所以改成：本体（底色/边框/阴影）全程实体，文字延后到快长成时才浮现。
     这就是 demo reveal 的等效，也是「先有形状、后有内容」的观感来源。
     @param {boolean} late 飞行层模式：本体在 0.72D 才开始显影，
                           内容若还从 0.30D 起就会在「本体还透明」时先浮出来。 */
  function sheetContentIn(panel, D, late) {
    var kids = Array.prototype.slice.call(panel.children);
    var at = late ? KID_AT : 0.30;
    var dur0 = late ? KID_DUR : 0.42;
    var step = late ? KID_STEP : 0.045;
    return kids.map(function (k, i) {
      return k.animate([
        { opacity: 0, transform: 'translateY(9px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], {
        duration: Math.max(1, Math.round(D * dur0)),
        delay: Math.round(D * (at + Math.min(i, 6) * step)),
        easing: EASE_OUT,
        fill: 'both'
      });
    });
  }

  function sheetContentKill(panel) {
    Array.prototype.slice.call(panel.children).forEach(function (k) {
      k.getAnimations().forEach(function (a) {
        try { a.cancel(); } catch (e) {}
      });
      k.style.opacity = '';
      k.style.transform = '';
    });
  }

  /**
   * 设置页展开。调用方先摘 hidden 再调本函数（面板须已可量测）。
   * @param {Element} panel 面板本体（.appearance-panel）
   * @param {Element|null} anchor 入口元素（settingsEntry），量其视口矩形
   */
  function sheetIn(panel, anchor, opts) {
    opts = opts || {};
    if (!panel) return Promise.resolve();
    sheetKill(panel);
    if (sheetAll.indexOf(panel) < 0) sheetAll.push(panel);
    var st = sheetState(panel);
    var gen = st.gen;
    var D = dur(opts.duration || 'base');
    var anchorRect = anchor && anchor.getClientRects().length ? anchor.getBoundingClientRect() : null;
    st.anchorRect = anchorRect;
    if (!D) { panel.style.opacity = ''; panel.style.transform = ''; return Promise.resolve(); }

    var plan = sheetPlan(panel, anchorRect, true);
    var scrim = panel.parentNode;
    var scrimAnim = sheetScrim(scrim, D, true);
    var shell = sheetShell(panel);
    var panelAnim;
    var flyMetas = [];

    if (plan.mode === 'fly') {
      var pr = plan.rect;
      /* 本体先隐着：几何由壳接管，本体只等壳快长成时交叉淡入。
         壳的起点用**入口矩形的非等比形状**（不是等面积的等比方块）——
         这一步就是 demo 的 a1，也是轮廓能对上的唯一办法。 */
      panel.style.opacity = '0';
      var fly = sheetFlyMake(anchorRect, shell, Math.min(8, anchorRect.height / 2) + 'px');
      st.fly = fly;
      /* 壳做非等比几何：left/top/width/height 直接插值（同 demo a1）。
         终点用面板矩形，末帧两者重合，接缝不可见。 */
      var flyGeo = fly.animate([
        { left: anchorRect.left + 'px', top: anchorRect.top + 'px',
          width: anchorRect.width + 'px', height: anchorRect.height + 'px',
          borderRadius: Math.min(8, anchorRect.height / 2) + 'px' },
        { left: pr.left + 'px', top: pr.top + 'px',
          width: pr.width + 'px', height: pr.height + 'px',
          borderRadius: shell.radius }
      ], { duration: D, easing: EASE, fill: 'forwards' });
      /* 壳退场：等到几何接近终态才化，且用**绝对时间**（delay 表达），
         不用 keyframe offset —— 见上方 FLY_HOLD 注释里那段缓动错位。 */
      var flyFade = fly.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: Math.max(1, Math.round(D * (FLY_GONE - FLY_HOLD))),
        delay: Math.round(D * FLY_HOLD),
        easing: EASE_INOUT, fill: 'forwards'
      });
      flyMetas = [flyGeo, flyFade];
      st.flyAnims = flyMetas;

      /* 本体：只做「显影 + 极轻微放大回正」（demo 的 a3 是 scale 1.03→1）。
         起点比壳开始淡出**更早**，两段交叠，屏幕上始终有东西。 */
      panelAnim = panel.animate([
        { opacity: 0, transform: 'scale(1.03)' },
        { opacity: 1, transform: 'scale(1)' }
      ], {
        duration: Math.max(1, Math.round(D * (PANEL_FULL - PANEL_START))),
        delay: Math.round(D * PANEL_START),
        easing: EASE_OUT, fill: 'both'
      });
    } else {
      panelAnim = panel.animate([
        { opacity: plan.opacity, transform: plan.transform },
        { opacity: 1, transform: 'translate(0,0) scale(1)' }
      ], { duration: D, easing: EASE_OUT, fill: 'both' });
    }

    /* 内容错峰：几何落定后再归位。抽屉形态内容已在屏外，不需要叠一层。 */
    var kids = plan.mode === 'slide' ? [] : sheetContentIn(panel, D, plan.mode === 'fly');

    st.anim = panelAnim;
    var all = [panelAnim.finished].concat(flyMetas.map(function (a) { return a.finished; }),
                                          kids.map(function (k) { return k.finished; }));
    return Promise.all(all).then(function () {
      if (gen !== st.gen) return;
      panel.style.opacity = ''; panel.style.transform = '';
      try { panelAnim.cancel(); } catch (e) {}
      flyMetas.forEach(function (a) { try { a.cancel(); } catch (e) {} });
      sheetFlyKill(st);
      kids.forEach(function (k) { try { k.cancel(); } catch (e) {} });
      if (scrimAnim) { try { scrimAnim.cancel(); } catch (e) {} }
      st.anim = null;
    }).catch(function () {});
  }

  /**
   * 设置页收回（与 sheetIn 互逆：同方向、同曲线族、时长 0.72D）。
   * 动画结束才回调 onDone（调用方在 onDone 里加 hidden），期间面板保持可见。
   */
  function sheetOut(panel, opts) {
    opts = opts || {};
    if (!panel) { if (opts.onDone) opts.onDone(); return Promise.resolve(); }
    sheetKill(panel);
    var st = sheetState(panel);
    var gen = st.gen;
    var D = dur(opts.duration || 'base');
    if (!D) { if (opts.onDone) opts.onDone(); return Promise.resolve(); }
    var plan = sheetPlan(panel, st.anchorRect, false);
    var OUT = D * BACK;

    /* 内容先退：比几何快得多，文字不会跟着被压扁。
       这是 demo closeApp 里 appEl.animate(opacity 1→0, D*0.38) 的同一手法。
       注意这里不能用 sheetContentIn —— 那是「进场」方向，会在收回时反向错峰浮现。 */
    sheetContentKill(panel);
    var kidsOut = plan.mode === 'slide' ? [] : Array.prototype.slice.call(panel.children).map(function (k) {
      return k.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: Math.max(1, Math.round(OUT * 0.38)), easing: EASE_INOUT, fill: 'forwards'
      });
    });

    var scrim = panel.parentNode;
    var scrimAnim = sheetScrim(scrim, OUT, false);
    var shell = sheetShell(panel);
    var panelAnim;
    var flyMetas = [];

    if (plan.mode === 'fly') {
      var pr = plan.rect;
      /* 收回是进场的逆序：壳**先**出现（本体仍在原位），壳缩回入口，本体跟着化掉。
         比本体直接缩回入口可靠：本体缩回入口会被压成 193×59 的竖条 —— 文字全毁。 */
      panel.style.opacity = '0';
      var fly = sheetFlyMake(pr, shell, shell.radius);
      st.fly = fly;
      var flyGeo = fly.animate([
        { left: pr.left + 'px', top: pr.top + 'px',
          width: pr.width + 'px', height: pr.height + 'px', borderRadius: shell.radius },
        { left: st.anchorRect.left + 'px', top: st.anchorRect.top + 'px',
          width: st.anchorRect.width + 'px', height: st.anchorRect.height + 'px',
          borderRadius: Math.min(8, st.anchorRect.height / 2) + 'px' }
      ], { duration: OUT, easing: EASE, fill: 'forwards' });
      /* 壳入场：开头一小段就显形，接住正在化掉的本体。
         同样用绝对时间，避免缓动把「立刻出现」推到别处。 */
      var flyFade = fly.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: Math.max(1, Math.round(OUT * 0.16)),
        easing: EASE_OUT, fill: 'forwards'
      });
      flyMetas = [flyGeo, flyFade];

      /* 本体：即刻开始化掉（内容已在 0.38×OUT 内退干净，化的是空壳）。
         时长比壳显形稍长，两者交叠。 */
      panelAnim = panel.animate([
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(1.02)' }
      ], {
        duration: Math.max(1, Math.round(OUT * 0.22)),
        easing: EASE_INOUT, fill: 'forwards'
      });
    } else {
      panelAnim = panel.animate([
        { opacity: 1, transform: 'translate(0,0) scale(1)' },
        { opacity: plan.opacity, transform: plan.transform }
      ], { duration: OUT, easing: EASE, fill: 'forwards' });
    }

    st.anim = panelAnim;
    var all = [panelAnim.finished].concat(flyMetas.map(function (a) { return a.finished; }));
    return Promise.all(all).then(function () {
      if (gen !== st.gen) return;
      panel.style.opacity = ''; panel.style.transform = '';
      try { panelAnim.cancel(); } catch (e) {}
      flyMetas.forEach(function (a) { try { a.cancel(); } catch (e) {} });
      sheetFlyKill(st);
      kidsOut.forEach(function (k) { try { k.cancel(); } catch (e) {} });
      Array.prototype.slice.call(panel.children).forEach(function (k) {
        k.style.opacity = ''; k.style.transform = '';
      });
      if (scrimAnim) { try { scrimAnim.cancel(); } catch (e) {} }
      st.anim = null;
      if (opts.onDone) opts.onDone();
    }).catch(function () {});
  }

  /* ---------- ⑦ 弹窗开合（v2.1 统一：与 sheet 同节奏，开合互逆） ----------
     成绩结算 / 改密等居中弹窗。入场 base、退场 base×0.72（与 sheetOut 同比例），
     曲线族一致（入 EASE_OUT / 出 EASE），位移方向互逆（下进下出）。
     每面板独立在途记录（WeakMap），代际号防「关到一半又开」的竞态。
     onDone 契约：退场动画结束才回调（调用方在回调里加 hidden）。 */
  var modalStates = new WeakMap();   // panel -> {gen, anim}
  function modalState(panel) {
    var st = modalStates.get(panel);
    if (!st) { st = { gen: 0, anim: null }; modalStates.set(panel, st); }
    return st;
  }
  function modalKill(panel) {
    var st = modalState(panel);
    st.gen++;
    if (st.anim) {
      try { st.anim.cancel(); } catch (e) {}
      panel.style.opacity = '';
      panel.style.transform = '';
      st.anim = null;
    }
  }

  function modalIn(panel, opts) {
    opts = opts || {};
    if (!panel) return Promise.resolve();
    modalKill(panel);
    var st = modalState(panel);
    var gen = st.gen;
    var D = dur(opts.duration || 'base');
    if (!D) { panel.style.opacity = ''; panel.style.transform = ''; return Promise.resolve(); }
    var a = panel.animate([
      { opacity: 0, transform: 'translateY(12px) scale(0.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: D, easing: EASE_OUT, fill: 'both' });
    st.anim = a;
    return a.finished.then(function () {
      if (gen !== st.gen) return;
      try { a.cancel(); } catch (e) {}
      panel.style.opacity = ''; panel.style.transform = '';
      st.anim = null;
    }).catch(function () {});
  }

  function modalOut(panel, opts) {
    opts = opts || {};
    if (!panel) { if (opts.onDone) opts.onDone(); return Promise.resolve(); }
    modalKill(panel);
    var st = modalState(panel);
    var gen = st.gen;
    var D = dur(opts.duration || 'base');
    if (!D) { if (opts.onDone) opts.onDone(); return Promise.resolve(); }
    var a = panel.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(10px) scale(0.985)' }
    ], { duration: D * BACK, easing: EASE, fill: 'forwards' });
    st.anim = a;
    return a.finished.then(function () {
      if (gen !== st.gen) return;
      try { a.cancel(); } catch (e) {}
      panel.style.opacity = ''; panel.style.transform = '';
      st.anim = null;
      if (opts.onDone) opts.onDone();
    }).catch(function () {});
  }

  /* ---------- 导出 ---------- */
  window.StudioMotionEngine = {
    EASE: EASE, EASE_OUT: EASE_OUT, EASE_INOUT: EASE_INOUT,
    DUR: DUR, STAGGER: STAGGER, BEAT: BEAT, BACK: BACK,
    ease: easeFn, easeOut: easeOutFn, bezier: bezier,
    mode: motionMode, isOff: isOff, isLite: isLite, dur: dur,
    // 通道
    flip: flip, cancelFlies: cancelFlies, dolly: dolly, cancelDolly: cancelDolly,
    // v2.1 页面级转场
    pageCross: pageCross, pageKill: pageKill,
    sheetIn: sheetIn, sheetOut: sheetOut, sheetKill: sheetKill,
    // 合成层
    enter: enter, leave: leave, staggerEnter: staggerEnter,
    modalIn: modalIn, modalOut: modalOut, modalKill: modalKill,
    // 预模糊
    setBackdropBlur: setBackdropBlur, ensureBlurLayer: ensureBlurLayer,
    // 工具
    localRect: localRect,
    // 探针钩子
    _flies: function () { return activeFlies.size; },
    _dollyGen: function () { return dollyState.gen; },
    _pageGen: function (scope) { return scope ? pageState(scope).gen : null; },
    _pageAnims: function (scope) { return scope ? pageState(scope).anims.length : null; },
    _sheetGen: function (panel) { return panel ? sheetState(panel).gen : sheetAll.map(function (p) { return sheetState(p).gen; }); }
  };
})();