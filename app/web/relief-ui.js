/**
 * 归岸 · 解压练习渲染器。
 *
 * 来源：从「见岸」的 core/web/relief-ui.js 迁移，配色已从青绿改为归岸的纸墨。
 * 用法：GuianReliefUI.mount(root, data, { onSos }) / .open(root, data, id) / .close(root)
 *
 * 保留原实现里三条花钱买来的细节，不要「顺手简化」：
 *   1) 练习弹层是全屏 fixed，宿主页的求助入口会被盖住，所以弹层内部必须自带 SOS 按钮；
 *      点它要**先关弹层再开热线面板**，否则热线面板会被压在下面，看起来像点了没反应。
 *   2) Escape 监听器每次 open 重新绑、close 时解绑，否则反复开关会攒一串。
 *   3) 说明区默认收起（<details>），否则小屏上第一个选项要滚一下才看得到。
 *
 * 全部文本走 textContent / createElement，唯一的 innerHTML = '' 是清空容器。
 */

(function (global) {
  'use strict';

  var STYLE_ID = 'ga-relief-style';
  var CSS = `
.jn-relief,.jr-panel{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#2e2a26;}
.jn-relief *,.jr-panel,.jr-panel *{box-sizing:border-box;}
.jr-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}
.jr-card{background:#fff;border:1px solid #e6dfd4;border-radius:16px;padding:14px;text-align:left;cursor:pointer;transition:transform .12s;}
.jr-card:hover{transform:translateY(-2px);border-color:#b4671f;}
.jr-card .e{font-size:24px;display:block;margin-bottom:6px;}
.jr-card .n{font-size:14px;font-weight:700;display:block;}
.jr-card .t{font-size:11.5px;color:#635b53;display:block;margin-top:3px;}
.jr-panel{position:fixed;inset:0;z-index:90;background:rgba(46,42,38,.5);display:flex;align-items:center;justify-content:center;padding:18px;}
/* 弹层改成 flex 纵向两段：pin（标题、机制、说明、引语）固定在顶部不滚，
   scroll（选项、步骤、安全边界）自己滚。
   原来整体滚动 + 引语 sticky，滚到内容末尾时 sticky 会被父容器顶走，
   结果是引语只剩半行露在标题下面——比看不见更糟。 */
.jr-box{display:flex;flex-direction:column;background:#fff;border-radius:20px;width:100%;max-width:440px;max-height:86vh;overflow:hidden;padding:0 20px;}
/* 移动端浏览器地址栏收放会改变可视高度；86vh 按大视口算，地址栏在时底部会被切掉，
   求助入口和「返回全部练习」正好是最后两个元素。有 dvh 就用 dvh。 */
@supports (height:100dvh){.jr-box{max-height:86dvh;}}
.jr-pin{flex:0 0 auto;}
.jr-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 0 22px;border-top:1px solid #efe8dd;overscroll-behavior:contain;}
.jr-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;padding:12px 0 8px;margin:0 -20px 10px;padding-left:20px;padding-right:20px;border-bottom:1px solid #e6dfd4;}
.jr-head .h{font-size:16px;font-weight:700;margin:0;}
/* 视觉直径 33，点击区 44（WCAG 2.5.5）。用双层 radial-gradient 画圆，
   这样按钮盒子够大、看上去不笨重。 */
.jr-x{position:relative;flex:0 0 44px;width:44px;height:44px;border:0;padding:0;border-radius:50%;
  background:radial-gradient(circle at 50% 50%,#f5f0e8 0 15.5px,#e6dfd4 15.5px 16.5px,transparent 16.5px);
  color:#635b53;font-size:15px;line-height:1;cursor:pointer;}
.jr-x:hover{background:radial-gradient(circle at 50% 50%,#b4671f 0 16.5px,transparent 16.5px);color:#fff;}
/* #b4671f 在白底只有 3.74，正文级文字不达 AA；#8a4c15 是同一色的加深版（5.56） */
.jr-mech{font-size:12px;color:#8a4c15;letter-spacing:.5px;margin-bottom:8px;}
.jr-intro{font-size:14px;line-height:1.7;margin:0 0 12px;}
.jr-steps{font-size:13px;color:#635b53;line-height:1.8;margin:0 0 14px;padding-left:18px;}
.jr-area{width:100%;min-height:78px;border:1px solid #e6dfd4;border-radius:12px;padding:10px;font-size:14px;resize:vertical;font-family:inherit;}
.jr-area:focus{outline:none;border-color:#b4671f;box-shadow:0 0 0 3px rgba(180,103,31,.12);}
.jr-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;
  border:0;border-radius:999px;background:#9c5618;color:#fff;padding:0 20px;
  font-size:14px;font-weight:600;cursor:pointer;margin-top:10px;font-family:inherit;}
.jr-btn.ghost{background:#f5f0e8;color:#635b53;border:1px solid #e6dfd4;}
.jr-btn:disabled{opacity:.45;cursor:default;}
.jr-drop{position:relative;height:86px;margin-top:12px;text-align:center;}
.jr-ball{display:inline-block;font-size:34px;animation:jrFall 1.6s ease-in forwards;}
@keyframes jrFall{0%{transform:translateY(-40px) scale(1);opacity:0}25%{opacity:1}100%{transform:translateY(54px) scale(.45);opacity:0}}

/* 情绪垃圾桶：写下的字先变成一张纸，再揉成团丢进桶里 */
.jr-area-hidden{opacity:0;pointer-events:none;}
.jr-bin-bar{display:flex;align-items:center;gap:10px;margin-top:10px;}
.jr-bin-bar .jr-btn{margin-top:0;}
.jr-bin{flex:0 0 34px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;
  font-size:19px;line-height:1;border-radius:50%;background:#f5f0e8;border:1px solid #e6dfd4;
  transition:transform .18s ease-out;}
.jr-bin-bump{transform:translateY(3px) scale(1.16);}
/* 外层只走抛掷，内层走揉皱，避免两段动画抢同一个 transform */
/* flex 居中：纸被揉小之后仍停在输入框正中，不会缩向左上角 */
.jr-paper{position:fixed;z-index:96;transform-origin:50% 50%;will-change:transform;
  display:flex;align-items:center;justify-content:center;
  animation:jrPaperIn .26s cubic-bezier(.2,.85,.3,1) both;}
@keyframes jrPaperIn{
  0%{opacity:0;transform:translateY(7px) scale(.975);}
  100%{opacity:1;transform:translateY(0) scale(1);}
}
.jr-sheet{position:relative;flex:0 0 auto;width:100%;height:100%;box-sizing:border-box;padding:10px 12px;
  border:1px solid #e6dfd4;border-radius:4px;background-color:#fdfaf4;
  background-image:linear-gradient(176deg,#fdfaf4 0%,#f7f2e9 62%,#efe8dc 100%);
  box-shadow:0 1px 0 rgba(90,70,50,.05),0 10px 24px rgba(90,70,50,.15);
  font-size:14px;line-height:1.6;color:#4a423a;overflow:hidden;transform-origin:50% 50%;}
/* 纸纤维：两层极淡的斑点，避免纸张看起来像纯色块 */
.jr-sheet::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.55;
  background-image:radial-gradient(circle at 20% 30%,rgba(90,70,50,.055) 0 1.4px,transparent 1.4px),
                   radial-gradient(circle at 71% 66%,rgba(90,70,50,.04) 0 1.9px,transparent 1.9px);
  background-size:23px 23px,37px 37px;}
.jr-paper-line{position:relative;z-index:1;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;
  transition:opacity .45s ease,filter .45s ease;}
/* 揉团时字跟着模糊淡出，团到后面就只剩纸，看不见内容 */
.jr-sheet-crumple .jr-paper-line{opacity:.22;filter:blur(.7px);
  transition:opacity .4s ease .3s,filter .4s ease .3s;}
.jr-sheet-crumple{animation:jrCrumple .72s cubic-bezier(.45,.05,.4,1) both;}
/* 前半段只把纸揉皱（clip-path + 旋转 + 内阴影），后半段才收成小方团，
   宽高用 --w/--h 的绝对像素起算，避免百分比与 px 混插值时的跳变 */
@keyframes jrCrumple{
  0%{width:var(--w);height:var(--h);border-radius:4px;
     clip-path:polygon(0 0,100% 0,100% 100%,0 100%);transform:rotate(0deg);
     box-shadow:0 10px 24px rgba(90,70,50,.15),inset 0 0 0 rgba(90,70,50,0);}
  34%{width:calc(var(--w) * .93);height:calc(var(--h) * .9);border-radius:6px;
     clip-path:polygon(2% 1%,98% 0,100% 97%,0 100%);transform:rotate(-3deg);
     box-shadow:0 8px 20px rgba(90,70,50,.17),inset 0 0 14px rgba(90,70,50,.1);}
  64%{width:calc(var(--w) * .66);height:calc(var(--h) * .62);border-radius:12px;
     clip-path:polygon(5% 3%,96% 0,99% 90%,6% 99%,0 46%);transform:rotate(7deg);
     box-shadow:0 5px 14px rgba(90,70,50,.2),inset 0 0 20px rgba(90,70,50,.18);}
  86%{width:74px;height:74px;border-radius:26px;
     clip-path:polygon(9% 7%,93% 2%,97% 86%,12% 96%,1% 43%);transform:rotate(-9deg);
     box-shadow:0 3px 10px rgba(90,70,50,.24),inset 0 0 22px rgba(90,70,50,.26);}
  100%{width:30px;height:30px;border-radius:46%;
     clip-path:polygon(12% 10%,90% 4%,96% 82%,14% 92%,2% 40%);transform:rotate(-13deg);
     box-shadow:0 2px 8px rgba(90,70,50,.3),inset 0 0 10px rgba(90,70,50,.34);}
}
.jr-paper-toss{animation:jrToss .88s cubic-bezier(.38,.06,.6,1) both;}
@keyframes jrToss{
  0%{transform:translate(0,0) rotate(0deg) scale(1);opacity:1;}
  30%{transform:translate(calc(var(--tx) * .3),calc(var(--ty) * .3 - 26px)) rotate(58deg) scale(1.06);}
  66%{transform:translate(calc(var(--tx) * .78),calc(var(--ty) * .78 - 8px)) rotate(238deg) scale(.95);}
  92%{transform:translate(var(--tx),var(--ty)) rotate(378deg) scale(.55);opacity:.92;}
  100%{transform:translate(var(--tx),var(--ty)) rotate(404deg) scale(.22);opacity:0;}
}

.jr-bubble{width:110px;height:110px;border-radius:50%;margin:14px auto;background:radial-gradient(circle at 32% 30%,#f3e7d5,#d9b184);box-shadow:0 8px 24px rgba(180,103,31,.25);transition:transform 1s linear;}
.jr-bubble.in{transform:scale(1.12);}
.jr-bubble.out{transform:scale(.72);}
.jr-phase{text-align:center;font-size:14px;font-weight:600;color:#8a4c15;min-height:22px;}
.jr-opts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.jr-opt-hint{flex:0 0 100%;font-size:12px;color:#635b53;letter-spacing:.04em;margin-top:6px;font-weight:600;}
/* 每个词至少 44px 高——这是触摸目标的下限，原来 35px 在小屏上很容易点空。
   词本身不内部断行，"好几种混在一起" 这种长词整块换行才对。 */
.jr-opt{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;
  border:1px solid #e6dfd4;background:#f7fbfa;border-radius:999px;
  font-size:14px;color:#14211f;white-space:nowrap;cursor:pointer;
  transition:background .16s,border-color .16s,transform .16s;}
.jr-opt:hover{border-color:#b4671f;}
/* 轻的一组给一点颜色：正面感受也该在视野里被一眼看见 */
.jr-opt.is-light{border-color:#b7e0d9;background:#eefaf7;color:#8a4c15;font-weight:600;}
.jr-opt.is-light:hover{border-color:#b4671f;background:#e2f6f1;}
/* 「还分不清」不做视觉弱化。原来是虚线＋浅灰字（对比度 3.4，全组最不显眼），
   但难以命名情绪恰恰是强迫人群的常见特征——最需要的那个出口被做成了最不起眼的。
   现在它与沉组同等重量，只用边色区分。 */
.jr-opt.is-none{border-color:#cfe0dc;background:#f7fbfa;color:#14211f;}
.jr-opt.is-none:hover{border-color:#b4671f;}
/* 点下去的那一下要有反馈，否则像没点中。
   白字配 #b4671f 只有 3.74，跟主按钮一起加深到 #9c5618（5.01）。 */
.jr-opt.is-tapped{background:#9c5618;border-color:#9c5618;color:#fff;transform:scale(.96);}
/* 跳过：弱化成文字按钮，不跟选词抢视线，但它确实存在——
   intro 写着「都不合适也可以跳过」，界面就必须给得出来 */
.jr-skip{display:block;margin:12px auto 0;min-height:44px;padding:0 16px;border:0;background:none;
  color:#635b53;font-size:13px;text-decoration:underline;text-underline-offset:3px;
  cursor:pointer;font-family:inherit;}
.jr-skip:hover{color:#8a4c15;}
/* 引语：挂在固定区里，不参与滚动，永远停在那儿。
   小屏上滚到选项区时，要读的那句还在，才谈得上「看见句子→给它命名」。 */
.jr-quote{font-size:15px;line-height:1.7;background:#f7fbfa;border-radius:12px;padding:12px;margin-bottom:10px;
  transition:background .3s,color .3s;}
.jr-quote.jr-quote-done{background:#eefaf7;border:1px solid #d3ede6;color:#8a4c15;}
/* 一轮走完后的去向：由用户主动选，收束屏不会因为下一次点击就消失 */
.jr-wrap-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;}
.jr-wrap-actions .jr-btn{margin-top:0;}
/* 说明区默认收起。18 句 × 13 个词的内容量下，把机制/intro/5 条步骤全铺开，
   320 屏上会占掉 71% 的首屏，第一个选项要滚一下才看得到。 */
.jr-howto{border:1px solid #e6dfd4;border-radius:12px;background:#fbfdfc;margin:0 0 12px;}
.jr-howto summary{display:flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;
  font-size:13px;font-weight:600;color:#8a4c15;cursor:pointer;list-style:none;}
.jr-howto summary::-webkit-details-marker{display:none;}
.jr-howto summary::before{content:"▸";font-size:11px;transition:transform .18s;}
.jr-howto[open] summary::before{transform:rotate(90deg);}
.jr-howto[open] summary{border-bottom:1px solid #e6dfd4;}
.jr-howto-body{padding:12px;}
.jr-howto .jr-intro{margin:0 0 10px;}
.jr-howto .jr-steps{margin:0;}
.jr-grid{display:flex;flex-wrap:nowrap;gap:6px;margin:8px 0 12px;}
/* 原来 30×30，窄屏上不好点。改成一行的等分：flex:1 让 5 个格子均分整行
   （320 屏弹层内容宽约 244px，正好每个 44px），max-width 防止 1-2 个格子被拉成大方块。
   不使用固定 44px —— 5 个固定 44 加上 gap 会超出 244，把「看见 5 样」挤成两行。 */
.jr-cell{flex:1 1 0;min-width:0;max-width:56px;height:44px;border:1px solid #e6dfd4;border-radius:9px;background:#fff;cursor:pointer;font-size:13px;color:#b4671f;}
.jr-cell.on{background:#b4671f;color:#fff;border-color:#b4671f;}
.jr-group{font-size:13px;font-weight:600;margin-top:10px;}
.jr-group small{font-weight:400;color:#635b53;display:block;margin-top:2px;}
.jr-closing{font-size:14px;line-height:1.7;background:#e6f4f1;border-radius:12px;padding:12px;margin:14px 0;}
.jr-safety{font-size:11.5px;color:#635b53;line-height:1.7;margin:0 0 10px;padding-left:16px;}
.jr-ev{margin-top:10px;font-size:11.5px;color:#635b53;}
/* summary 是 details 的开关，属于交互控件，不能只有 11.5px 字那么高的点击区 */
.jr-ev summary{cursor:pointer;font-weight:600;display:flex;align-items:center;min-height:44px;}
.jr-ev li{margin-bottom:5px;line-height:1.6;}
.jr-ip{font-size:11px;color:#635b53;line-height:1.6;margin-top:10px;}
/* 弹层里的求助入口。练习弹层是 position:fixed 全屏覆盖，
   打开之后页面上原有的「需要立刻帮助」全部点不到 —— 而「某句话让你很不舒服」
   恰恰是练这类练习时最容易发生的时刻。小程序端 p-relief 一直有这个入口，Web 端漏了。
   用 #c62c2c 而不是 --danger #e23b3b：后者在白底 4.27，够不上 AA。 */
.jr-sos{display:flex;align-items:center;justify-content:center;gap:6px;
  width:100%;min-height:44px;margin-top:14px;padding:0 12px;
  border:1px solid #f2d9ae;border-radius:999px;background:#fdf3e3;
  color:#c62c2c;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}
.jr-sos:hover{background:#fbe9cf;}
/* 前庭敏感、易晕动、或单纯不想看动画的人：纸团、气泡、下落全部降级。
   状态照样变，但不做位移。纸团动画整整 2 秒，对这类用户不是小事。 */
@media (prefers-reduced-motion: reduce){
  .jr-paper,.jr-ball,.jr-bubble,.jr-opt,.jr-card,.jr-paper-line{animation:none!important;transition:none!important;}
  .jr-paper{display:none!important;}
  .jr-ball{opacity:.55;}
}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mount(root, data, opts) {
    if (!root || !data) return;
    // opts 是可选扩展点（目前只有 onSos），不传也能用，两个运行时的现有调用无需改动
    if (opts) root.__jnOpts = opts;
    injectStyle();
    root.classList.add('jn-relief');
    renderList(root, data);
  }

  function renderList(root, data) {
    root.innerHTML = '';
    var list = el('div', 'jr-list');
    (data.RELIEF_EXERCISES || []).forEach(function (x) {
      var c = el('button', 'jr-card');
      c.type = 'button';
      c.appendChild(el('span', 'e', x.emoji));
      c.appendChild(el('span', 'n', x.name));
      c.appendChild(el('span', 't', x.tagline));
      c.addEventListener('click', function () { open(root, data, x.id); });
      list.appendChild(c);
    });
    root.appendChild(list);
  }

  function close(root) {
    // 弹层挂在 body 上，不在 root 里；同时只会有一个，直接按类清
    var ps = document.querySelectorAll('.jr-panel');
    for (var k = 0; k < ps.length; k++) ps[k].remove();
    // 纸团动画是挂在 body 上的，动画中途关闭面板要顺手清掉，别留个纸片在屏幕上
    var papers = document.querySelectorAll('.jr-paper');
    for (var i = 0; i < papers.length; i++) papers[i].remove();
    // Escape 监听器是每次 open 新绑的。原来只有「按 Escape 关闭」这一条路径会解绑，
    // 点 ✕ 或点遮罩关闭的都会残留 —— 反复开关就攒下一串监听器，而且下一次按 Escape
    // 会把已经被移除的面板再关一遍。
    if (root.__jnEsc) { document.removeEventListener('keydown', root.__jnEsc); root.__jnEsc = null; }
    // 恢复打开前的值而不是一律清空：宿主页面自己可能设过 overflow
    var prev = root.__jnPrevOverflow || '';
    root.__jnPrevOverflow = null;
    document.body.style.overflow = prev;
  }

  // 求助入口。练习弹层是 position:fixed 全屏覆盖，打开之后宿主页面上所有
  // 「需要立刻帮助」入口都点不到 —— 而「某句话让你很不舒服」正是练这类练习时
  // 最容易发生的时刻。小程序端 pages/relief 一直有这个入口，Web 端漏了。
  // 优先交给宿主自己的热线面板；宿主没有可调用入口时退化成直接给出号码，
  // 不允许出现「点了没反应」。
  function buildSos(root) {
    var opts = root.__jnOpts || {};
    var host = (typeof opts.onSos === 'function' && opts.onSos) ||
      (typeof global.__JN_OPEN_SOS === 'function' && global.__JN_OPEN_SOS) ||
      (typeof global.openSos === 'function' && global.openSos) || null;
    var b = el('button', 'jr-sos', host ? '🆘 需要立刻帮助' : '🆘 全国心理援助热线 12356');
    b.type = 'button';
    b.addEventListener('click', function () {
      if (!host) { global.location.href = 'tel:12356'; return; } // onSos 由 app.js 挂载时传入
      // 先关练习弹层再叫热线：热线层在宿主里的 z-index 通常低于练习弹层（公网站 70 < 90），
      // 不关的话热线会开在练习弹层底下，用户只看到一层没反应的遮罩。
      close(root);
      host.call(global);
    });
    return b;
  }

  function open(root, data, id) {
    var x = (data.reliefById && data.reliefById(id)) ||
      (data.RELIEF_EXERCISES || []).filter(function (v) { return v.id === id; })[0];
    if (!x) return;
    close(root);
    injectStyle();
    var panel = el('div', 'jr-panel');
    var box = el('div', 'jr-box');
    var head = el('div', 'jr-head');
    head.appendChild(el('h3', 'h', x.emoji + ' ' + x.name));
    var xb = el('button', 'jr-x', '✕');
    xb.type = 'button';
    xb.setAttribute('aria-label', '关闭');
    xb.addEventListener('click', function () { close(root); });
    head.appendChild(xb);
    box.appendChild(head);
    panel.appendChild(box);
    panel.addEventListener('click', function (e) { if (e.target === panel) close(root); });
    // 每次 open 只保留一个 Escape 监听器
    if (root.__jnEsc) document.removeEventListener('keydown', root.__jnEsc);
    root.__jnEsc = function (e) { if (e.key === 'Escape') close(root); };
    document.addEventListener('keydown', root.__jnEsc);

    var pin = el('div', 'jr-pin');
    var body = el('div', 'jr-scroll');
    pin.appendChild(el('div', 'jr-mech', x.mechanism));

    // 说明区默认为收起状态。18 句散句 + 15 个情绪词的内容量下，把机制、intro
    // 和 5 条步骤全铺开会占掉小屏 71% 的首屏；第一个选项要滚一下才露出。
    // 收起来只留一行摘要，想看的点开，不想看的直接开始。
    var howto = document.createElement('details');
    howto.className = 'jr-howto';
    var sum = document.createElement('summary');
    var mins = Math.max(1, Math.round((x.durationSec || 120) / 60));
    // tagline 不放在这里：列表卡片上已经有了，弹层里再占一行，
    // 窄屏上会把摘要挤成两行，白白吃掉半行选项的空间
    sum.textContent = '怎么做 · 约 ' + mins + ' 分钟';
    howto.appendChild(sum);
    var howtoBody = el('div', 'jr-howto-body');
    howtoBody.appendChild(el('p', 'jr-intro', x.intro));
    var steps = el('ol', 'jr-steps');
    (x.steps || []).forEach(function (s) { steps.appendChild(el('li', '', s)); });
    howtoBody.appendChild(steps);
    howto.appendChild(howtoBody);
    pin.appendChild(howto);

    box.appendChild(pin);
    box.appendChild(body);
    renderExercise(body, x, root, pin);

    var closing = el('div', 'jr-closing', x.closing);
    body.appendChild(closing);
    var safe = el('ul', 'jr-safety');
    (x.safety || []).forEach(function (s) { safe.appendChild(el('li', '', s)); });
    body.appendChild(safe);

    var ev = document.createElement('details');
    ev.className = 'jr-ev';
    ev.appendChild(el('summary', '', '科学依据与适用边界（' + (x.evidence || []).length + ' 条）'));
    var ul = document.createElement('ul');
    (x.evidence || []).forEach(function (e) {
      ul.appendChild(el('li', '', e.ref + ' ｜ ' + e.locator + ' ｜ ' + e.note));
    });
    ev.appendChild(ul);
    body.appendChild(ev);
    body.appendChild(el('div', 'jr-ip', '版权说明：' + x.ip));
    // 求助入口放在「返回全部练习」之前：刚读完安全边界，是最可能想找人的时刻
    body.appendChild(buildSos(root));
    var back = el('button', 'jr-btn ghost', '返回全部练习');
    back.type = 'button';
    back.addEventListener('click', function () { close(root); renderList(root, data); });
    body.appendChild(back);

    // 挂 body 而不是 root：root 是宿主页面里的一个区块，祖先一旦有 transform / z-index，
    // position:fixed 就会被锁在那个层叠上下文里。公网站的 .page 就是这种情况 ——
    // 弹层看着盖满全屏，实际点不到（elementFromPoint 命中的是 .page 本身）。
    if (root.__jnPrevOverflow == null) root.__jnPrevOverflow = document.body.style.overflow;
    document.body.appendChild(panel);
    document.body.style.overflow = 'hidden';
  }

  // 情绪垃圾桶：输入框里的字先「印」到一张纸上，纸再揉成团丢进桶里
  function renderEmotionBin(body, x) {
    var ta = el('textarea', 'jr-area');
    ta.placeholder = '写一句就好，随时可以停';
    body.appendChild(ta);

    var bar = el('div', 'jr-bin-bar');
    var btn = el('button', 'jr-btn', '丢进去');
    btn.type = 'button';
    var bin = el('div', 'jr-bin', '🗑️');
    bar.appendChild(btn);
    bar.appendChild(bin);
    body.appendChild(bar);

    var busy = false;

    btn.addEventListener('click', function () {
      if (busy) return;
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }

      // 先把两处坐标量好：纸从输入框原位长出来，最后落到桶上
      var r = ta.getBoundingClientRect();
      var br = bin.getBoundingClientRect();

      busy = true;
      btn.disabled = true;

      var paper = el('div', 'jr-paper');
      paper.style.left = Math.round(r.left) + 'px';
      paper.style.top = Math.round(r.top) + 'px';
      paper.style.width = Math.round(r.width) + 'px';
      paper.style.height = Math.round(r.height) + 'px';
      // 揉皱动画的起点尺寸，交给 CSS 插值用
      paper.style.setProperty('--w', Math.round(r.width) + 'px');
      paper.style.setProperty('--h', Math.round(r.height) + 'px');

      var sheet = el('div', 'jr-sheet');
      sheet.appendChild(el('div', 'jr-paper-line', text));
      paper.appendChild(sheet);
      document.body.appendChild(paper);

      ta.value = '';
      ta.classList.add('jr-area-hidden');

      // 1) 字落在纸上，停一下让人看清「这就是刚才那句话」
      setTimeout(function () {
        // 2) 揉成一团
        sheet.classList.add('jr-sheet-crumple');
        setTimeout(function () {
          // 3) 抛进纸篓，桶跟着沉一下
          var cx = r.left + r.width / 2;
          var cy = r.top + r.height / 2;
          paper.style.setProperty('--tx', Math.round(br.left + br.width / 2 - cx) + 'px');
          paper.style.setProperty('--ty', Math.round(br.top + br.height / 2 - cy) + 'px');
          paper.classList.add('jr-paper-toss');
          // 抛到 92% 才落进桶，之前加 bump 会提前跳
          setTimeout(function () { bin.classList.add('jr-bin-bump'); }, 810);
          setTimeout(function () {
            if (paper.parentNode) paper.remove();
            bin.classList.remove('jr-bin-bump');
            busy = false;
            btn.disabled = false;
            ta.classList.remove('jr-area-hidden');
            ta.focus();
          }, 940);
        }, 660);
      }, 500);
    });
  }

  function renderExercise(body, x, root, pin) {
    if (x.kind === 'write') {
      if (x.id === 'emotion-bin') return renderEmotionBin(body, x);
      var ta = el('textarea', 'jr-area');
      ta.placeholder = '写一句就好，随时可以停';
      body.appendChild(ta);
      var btn = el('button', 'jr-btn', '放它走');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        if (!ta.value.trim()) return;
        ta.value = '';
        var d = el('div', 'jr-drop');
        d.appendChild(el('span', 'jr-ball', '🛶'));
        body.appendChild(d);
        setTimeout(function () { if (d.parentNode) d.remove(); }, 1700);
      });
      body.appendChild(btn);
      return;
    }

    if (x.kind === 'paced') {
      var bub = el('div', 'jr-bubble');
      var phase = el('div', 'jr-phase', '准备好了再开始');
      var start = el('button', 'jr-btn', '开始');
      var stop = el('button', 'jr-btn ghost', '结束');
      var timer = null;
      var running = false;
      var inhale = (x.pace && x.pace.inhaleMs) || 4000;
      var exhale = (x.pace && x.pace.exhaleMs) || 6000;
      var cycles = (x.pace && x.pace.cycles) || 8;
      var n = 0;
      function step(inPhase) {
        if (!running) return;
        if (n >= cycles) { phase.textContent = '这一轮做完了'; running = false; start.textContent = '再来一轮'; n = 0; return; }
        if (inPhase) {
          bub.className = 'jr-bubble in';
          phase.textContent = x.id === 'tense-release'
            ? '轻轻绷紧 · ' + ((x.groups || [])[n % (x.groups || [1]).length] || '')
            : '慢慢吸气';
          timer = setTimeout(function () { step(false); }, inhale);
        } else {
          bub.className = 'jr-bubble out';
          phase.textContent = x.id === 'tense-release' ? '一下松开，感受那股沉' : '慢慢呼气';
          n++;
          timer = setTimeout(function () { step(true); }, exhale);
        }
      }
      start.type = 'button'; stop.type = 'button';
      start.addEventListener('click', function () {
        if (running) { running = false; clearTimeout(timer); start.textContent = '继续'; phase.textContent = '已暂停'; return; }
        running = true; start.textContent = '暂停'; step(true);
      });
      stop.addEventListener('click', function () { running = false; clearTimeout(timer); start.textContent = '再来一轮'; phase.textContent = '随时可以停'; });
      body.appendChild(bub); body.appendChild(phase); body.appendChild(start); body.appendChild(stop);
      return;
    }

    if (x.kind === 'choice') {
      var all = (x.prompts || []).filter(Boolean);
      if (!all.length) all = ['做完了，随时可以停。'];

      // 起点随机。固定从第一句开始，等于每次打开都撞上同一句，
      // 而它往往是最不贴合当下状态的那一句（对强迫思维型尤其如此）。
      // 只随机起点、不洗牌，一轮下来仍然完整覆盖每一句。
      function rotate() {
        var s = Math.floor(Math.random() * all.length);
        return all.slice(s).concat(all.slice(0, s));
      }
      var list = rotate();

      var quote = el('div', 'jr-quote', list[0]);
      var opts = el('div', 'jr-opts');
      var skip = el('button', 'jr-skip', '跳过这句');
      skip.type = 'button';
      var idx = 0;

      // 有分组就分组显示；旧数据只有扁平 options 时退回平铺
      var groups = (Array.isArray(x.optionGroups) && x.optionGroups.length)
        ? x.optionGroups
        : [{ tone: '', hint: '', items: x.options || [] }];

      function buildOpts() {
        opts.innerHTML = '';
        skip.style.display = '';
        groups.forEach(function (g) {
          var items = (g.items || []).filter(Boolean);
          if (!items.length) return;
          if (g.hint) opts.appendChild(el('span', 'jr-opt-hint', g.hint));
          items.forEach(function (o) {
            var b = el('button', 'jr-opt' + (g.tone ? ' is-' + g.tone : ''), o);
            b.type = 'button';
            b.addEventListener('click', function () { advance(b); });
            opts.appendChild(b);
          });
        });
      }

      // 走完一整轮：把选项区换成去向选择。
      // 旧写法是「显示收束语、下一次点击就回第一句」，实测连点 16 次里，
      // 收束语只活了 1 次点击的窗口——等于写了没人看得到。
      function showWrap() {
        quote.textContent = x.wrapUp || '一轮走完了。想再来一轮也行，停下来也行。';
        quote.classList.add('jr-quote-done');
        opts.innerHTML = '';
        skip.style.display = 'none';
        var again = el('button', 'jr-btn', '再来一轮');
        again.type = 'button';
        again.addEventListener('click', function () {
          list = rotate();       // 第二遍也换起点，否则顺序和第一遍一模一样
          idx = 0;
          quote.textContent = list[0];
          quote.classList.remove('jr-quote-done');
          buildOpts();
        });
        var done = el('button', 'jr-btn ghost', '到这儿就好');
        done.type = 'button';
        done.addEventListener('click', function () { close(root); });
        var acts = el('div', 'jr-wrap-actions');
        acts.appendChild(again);
        acts.appendChild(done);
        opts.appendChild(acts);
        // 收束屏出现时把滚动区拉回顶部，否则按钮可能停在视口外
        if (body.scrollTop) body.scrollTop = 0;
      }

      function advance(pickedBtn) {
        if (pickedBtn) {
          pickedBtn.classList.add('is-tapped');
          setTimeout(function () { pickedBtn.classList.remove('is-tapped'); }, 220);
        }
        if (idx < list.length - 1) {
          idx++;
          quote.textContent = list[idx];
          return;
        }
        showWrap();
      }

      // intro 承诺「都不合适也可以跳过」，那就必须真的给得出这个入口。
      // 弱化成文字按钮，不跟选词抢视线。
      skip.addEventListener('click', function () { advance(null); });

      buildOpts();
      // 引语挂在固定区而不是滚动区：它是这个练习里唯一必须一直看得见的东西
      pin.appendChild(quote);
      body.appendChild(opts); body.appendChild(skip);
      return;
    }

    if (x.kind === 'checklist') {
      (x.groups || []).forEach(function (g) {
        var t = el('div', 'jr-group', g.count + ' · ' + g.sense);
        t.appendChild(el('small', '', g.hint));
        body.appendChild(t);
        var row = el('div', 'jr-grid');
        for (var k = 0; k < g.count; k++) {
          (function (cell) {
            cell.addEventListener('click', function () { cell.classList.toggle('on'); });
            row.appendChild(cell);
          })(el('button', 'jr-cell', '✓'));
        }
        body.appendChild(row);
      });
    }
  }

  global.GuianReliefUI = { mount: mount, open: open, close: close };
})(typeof window !== 'undefined' ? window : globalThis);
