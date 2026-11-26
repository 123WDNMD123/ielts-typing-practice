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

   档位：StudioMotion full / lite / off（off 与 reduced-motion 直切）。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- ① 统一缓动与时长令牌 ---------- */
  // demo 原值：iOS 式「快起慢落」，尾段极平坦，落定观感柔和
  var EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  var EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
  var EASE_INOUT = 'cubic-bezier(0.65, 0, 0.35, 1)';

  var DUR = {
    micro: 180,   // 微交互：hover / 按键反馈 / 小徽章
    base: 320,    // 转场：Tab 切换 / 弹窗 / 卡片
    macro: 500    // 大几何：专注模式推近拉远
  };

  // 错峰比例（demo：0 / 0.18 / 0.34）
  var STAGGER = { lead: 0, mid: 0.18, trail: 0.34 };

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
  var easeFn = bezier(0.32, 0.72, 0, 1);
  var easeOutFn = bezier(0.22, 1, 0.36, 1);

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
      ], { duration: D * 0.72, delay: D * STAGGER.mid, easing: EASE_INOUT, fill: 'forwards' });
    }

    // 错峰层二：真实内容浮现
    var a3 = null;
    if (reveal) {
      a3 = reveal.animate([
        { opacity: 0, transform: 'scale(1.02)' },
        { opacity: 1, transform: 'scale(1)' }
      ], { duration: D * 0.62, delay: D * STAGGER.trail, easing: EASE_OUT, fill: 'forwards' });
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

  /** 列表错峰入场：每项延迟 index×step，上限 maxDelay 防长列表拖尾 */
  function staggerEnter(els, opts) {
    opts = opts || {};
    var step = opts.step == null ? 28 : opts.step;
    var maxDelay = opts.maxDelay == null ? 220 : opts.maxDelay;
    var arr = Array.from(els || []);
    return Promise.all(arr.map(function (el, i) {
      return enter(el, Object.assign({}, opts, { delay: Math.min(i * step, maxDelay) }));
    }));
  }

  /* ---------- ⑥ 弹窗开合（内容静态，走合成层） ---------- */
  function modalIn(panel, opts) {
    opts = opts || {};
    var D = dur(opts.duration || 'base');
    if (!panel) return Promise.resolve();
    if (!D) { panel.style.opacity = ''; panel.style.transform = ''; return Promise.resolve(); }
    var a = panel.animate([
      { opacity: 0, transform: 'translateY(12px) scale(0.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], { duration: D, easing: EASE_OUT, fill: 'both' });
    return a.finished.then(function () {
      try { a.cancel(); } catch (e) {}
      panel.style.opacity = ''; panel.style.transform = '';
    }).catch(function () {});
  }

  function modalOut(panel, opts) {
    opts = opts || {};
    var D = dur(opts.duration || 'micro');
    if (!panel) return Promise.resolve();
    if (!D) return Promise.resolve();
    var a = panel.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(8px) scale(0.99)' }
    ], { duration: D, easing: EASE, fill: 'forwards' });
    return a.finished.catch(function () {});
  }

  /* ---------- 导出 ---------- */
  window.StudioMotionEngine = {
    EASE: EASE, EASE_OUT: EASE_OUT, EASE_INOUT: EASE_INOUT,
    DUR: DUR, STAGGER: STAGGER,
    ease: easeFn, easeOut: easeOutFn, bezier: bezier,
    mode: motionMode, isOff: isOff, isLite: isLite, dur: dur,
    // 通道
    flip: flip, cancelFlies: cancelFlies, dolly: dolly, cancelDolly: cancelDolly,
    // 合成层
    enter: enter, leave: leave, staggerEnter: staggerEnter,
    modalIn: modalIn, modalOut: modalOut,
    // 预模糊
    setBackdropBlur: setBackdropBlur, ensureBlurLayer: ensureBlurLayer,
    // 工具
    localRect: localRect,
    // 探针钩子
    _flies: function () { return activeFlies.size; },
    _dollyGen: function () { return dollyState.gen; }
  };
})();