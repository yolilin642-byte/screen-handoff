// 外面的聊天页把这一页嵌进去时（地址带 #embed）：设备号由外面给，密码记在这台手机上（只第一次要输），
// 连上、要密码、断了都告诉外面那层，外面据此决定什么时候把我最后那张图换成直播。不带 #embed 时什么都不做。
// #embed&mini：聊天里那张小图放直播。只要画面：不问密码、不出任何按钮、
// 不出声、不接手指（外面那层把它当一张会动的图）；没存过密码就报 needpwd，外面退回定格的图，等人在大的那扇里输过一次。
// 连上以后自己换成帧率优先（操作间中画质、小图低画质）；操作间每 10 秒报一回线路的数（kaelLive:'qos'），外面记进小账。
// #embed&card：长在 ChatGPT 对话框里的那张卡。那个框不一定带 referrer，
// 所以等外面先打一声招呼（kaelHello），认 e.origin——这是浏览器给的，冒充不了；只认登记过的那个框。
(() => {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('embed') || parent === window) return;
  let ref = '';
  try { ref = new URL(document.referrer).origin; } catch {}
  // 认哪些外层不写死，读首页那份配置的 kael.chatOrigins（嵌它的聊天页）、kael.cardOrigins（ChatGPT 卡那个框）
  const KC = (window.CROSSDESK_CONFIG && window.CROSSDESK_CONFIG.kael) || {};
  if ((KC.chatOrigins || []).includes(ref)) return kaelEmbedMain(h, ref);
  if (!h.has('card')) return;
  const CARD = KC.cardOrigins || [];
  const hi = (e) => {
    if (e.source !== parent || !CARD.includes(e.origin) || !e.data?.kaelHello) return;
    removeEventListener('message', hi);
    kaelEmbedMain(h, e.origin);
  };
  addEventListener('message', hi);
})();
function kaelEmbedMain(h, parentOrigin) {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const mini = h.has('mini');
  // ChatGPT 那张卡不记密码（以前记过的也删掉），
  // 半小时没碰、或切出去一分钟，就断开、清掉那格，要连再输；卡上那颗「断开」也走这条。
  // 嵌在自家聊天页里的照旧记着（聊天页自己有门）
  const card = h.has('card');
  let stopped = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!stopped) fn(); }, ms); timers.add(t); return t; };
  addEventListener('message', e => {
    if (e.origin !== parentOrigin || e.source !== parent || e.data?.kaelControl !== 'stop') return;
    stopped = true; for (const t of timers) clearTimeout(t); timers.clear();
    try { window.CrossDeskSession?.disconnect?.(); } catch {}
    tell('stopped', { requestId: e.data.requestId });
  });
  const tell = (s, extra) => { try { parent.postMessage({ kaelLive: s, ...(extra || {}) }, parentOrigin); } catch {} };
  const KEY = 'kael.crossdesk.pwd';
  const id = (h.get('id') || '').replace(/\D/g, '');
  const st = document.createElement('style');
  // 底透明：外面那层的底色透上来，画面四周不再是一圈黑。要密码那一屏只留一格密码和「连接」，
  // 样子跟外面聊天间的按钮走（半透明白底、细线、圆头），设备号外面给了、不再摆一遍
  root.classList.add('kael-embed');
  if (mini) root.classList.add('kael-mini');
  st.textContent = 'html,body,.app-container,#media,#video-container,#connection-overlay{background:transparent!important}'
    + 'html.kael-auto #connection-overlay{visibility:hidden}'
    + 'html.kael-embed .connection-panel{background:none!important;box-shadow:none!important;border:0!important;backdrop-filter:none!important;width:min(300px,86vw)!important;padding:0!important}'
    + 'html.kael-embed .connection-header,html.kael-embed #connection-form>.option:first-child,html.kael-embed #client-version,html.kael-embed label[for=transmission-pwd]{display:none!important}'
    + 'html.kael-embed #transmission-pwd{width:100%!important;height:52px!important;border-radius:99px!important;border:1px solid rgba(60,72,52,.24)!important;background:rgba(255,255,255,.58)!important;'
    + 'text-align:center!important;font-size:22px!important;letter-spacing:.42em!important;color:#33402f!important;box-shadow:none!important;outline:none!important}'
    + 'html.kael-embed #transmission-pwd::placeholder{font-size:15px;letter-spacing:.06em;color:#7d8875}'
    + 'html.kael-embed #transmission-pwd:focus{border-color:rgba(170,140,70,.6)!important;background:rgba(255,255,255,.72)!important}'
    + 'html.kael-embed .actions{justify-content:center!important;margin-top:14px!important}'
    + 'html.kael-embed #connect{border-radius:99px!important;border:1px solid rgba(60,72,52,.24)!important;background:rgba(255,255,255,.42)!important;color:#33402f!important;'
    + 'padding:9px 26px!important;font-size:15px!important;box-shadow:none!important;min-width:0!important;width:auto!important}'
    + 'html.kael-embed #connect:disabled{opacity:.45!important}'
    + 'html.kael-embed .connection-feedback{text-align:center!important;color:#8a5a3a!important;font-size:13px!important;min-height:18px!important;background:none!important;box-shadow:none!important;backdrop-filter:none!important}'
    // 底换成外面的墙纸以后，这行「正在连接服务器…」压在深色上看不清：有字的时候垫一块跟按钮一样的白底
    + 'html.kael-embed .connection-feedback.kael-has{width:fit-content!important;margin:10px auto 0!important;padding:3px 12px!important;border-radius:99px!important;background:rgba(255,255,255,.62)!important;color:#6b4a33!important}'
    // 原版面板底下那团糊影（#connection-overlay::before 一行大字水印「CrossDesk」，::after 一层白纱）、偏左的格子：拿掉、拍平、居中
    + 'html.kael-embed #connection-overlay::before,html.kael-embed #connection-overlay::after{content:none!important;display:none!important}'
    + 'html.kael-embed #connection-overlay{display:flex!important;align-items:center!important;justify-content:center!important}'
    // 连上的第一个卡片曾经留下一块消不掉、点不动的印子：上面那条 !important 把网页版连上时写的 display:none 压住了，
    // 头一回输密码那次（没有 kael-auto 隐身），密码格和红的「断开连接」一直压在画面上、挡手指。出画面就收，断了再摊开
    + 'html.kael-embed.kael-live #connection-overlay{display:none!important}'
    + 'html.kael-embed .connection-panel,html.kael-embed .connection-panel *{filter:none!important;text-shadow:none!important}'
    + 'html.kael-embed .connection-panel::before,html.kael-embed .connection-panel::after,html.kael-embed .option::before,html.kael-embed .option::after{content:none!important;display:none!important}'
    + 'html.kael-embed #connection-form,html.kael-embed #connection-form>.option{width:100%!important;margin:0!important;padding:0!important;display:block!important;box-shadow:none!important;background:none!important}'
    // 操作间：CrossDesk 自己那颗圆按钮（键盘、鼠标模式、断开都在它里头）默认蹲右上角，正好压在外面那颗 ✕ 底下。
    // 挪到右下角、跟外面的按钮一个样子（半透明白底、细线、灰的图标）。原先拿 !important 把 left/top 钉死，
    // 它自己拖动时写的位置全被盖掉。现在只管样子，起始位置在下面交给它自己那套（orbPosition），拖得动
    + 'html.kael-embed:not(.kael-mini) #panel-collapsed-bar{'
    + 'width:44px!important;height:44px!important;min-width:44px!important;padding:4px!important;background:rgba(255,255,255,.58)!important;border:1px solid rgba(60,72,52,.24)!important;box-shadow:none!important}'
    + 'html.kael-embed:not(.kael-mini) #panel-collapsed-bar .collapsed-bar-icon{width:34px!important;height:34px!important;filter:grayscale(1) opacity(.62)}'
    // 小图：只剩画面，铺满这一格（外面按整块屏幕的比例开这扇框，所以 contain 正好不留边）
    + 'html.kael-mini #connection-overlay,html.kael-mini #connecting-overlay,html.kael-mini #connected-overlay,html.kael-mini #virtual-mouse,'
    + 'html.kael-mini #virtual-keyboard,html.kael-mini .locked-pointer-cursor,html.kael-mini #session-menu-shield{display:none!important}'
    + 'html.kael-mini,html.kael-mini body{overflow:hidden!important;pointer-events:none!important}'
    + 'html.kael-mini video{transition:none!important}';
  document.head.appendChild(st);
  // 圆按钮头一回出来放右下角（离边 12px，跟原先钉的地方一样），之后拖到哪儿就在哪儿（session_controls.js 的 layout/orbPosition）
  const sc = window.CrossDeskSessionControls;
  if (!mini && sc && typeof sc.layout === 'function') {
    const lay = sc.layout.bind(sc);
    sc.layout = function () {
      if (this.active && !this.orbPosition) { const b = this.bounds(); this.orbPosition = { x: b.right - 48, y: b.bottom - 48 }; }
      return lay();
    };
  }
  const pwField = $('transmission-pwd');
  if (pwField) {
    pwField.placeholder = 'CrossDesk 的密码';
    pwField.style.setProperty('width', '100%', 'important');   // 原版样式表把它钉在 200px，样式表压不过，直接写在身上
    pwField.style.setProperty('display', 'block', 'important');
    pwField.style.setProperty('max-width', 'none', 'important');   // 钉它的是 max-width:200px
  }
  const idIn = $('transmission-id'), pwIn = $('transmission-pwd'), btn = $('connect'), video = $('video'),
    fb = $('connection-feedback'), media = $('media'), au = $('audio');
  if (mini) {   // 小图不出声：电脑的声音只在大的那扇里放
    if (video) video.muted = true;
    if (au) { au.muted = true; au.play = () => Promise.resolve(); }
  }
  const put = (el, v) => {
    if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (id) put(idIn, id);
  let saved = '';
  try { if (card) localStorage.removeItem(KEY); else saved = localStorage.getItem(KEY) || ''; } catch {}
  if (card && pwIn) pwIn.autocomplete = 'off';
  let typed = saved;
  pwIn?.addEventListener('input', () => { typed = pwIn.value; });
  const ask = (why) => { root.classList.remove('kael-auto', 'kael-live'); tell('needpwd', { why }); };
  const going = () => media && getComputedStyle(media).display !== 'none';
  // 信令门上挂了钥匙（kael_door.js）：没钥匙先摆配对码那格（报 needpwd/door，外面照「要人输东西」处理，小图退回定格），
  // 换到钥匙再走下面原来那套；记下的钥匙半路被告知不灵了，自动点「连接」那串也停下
  const door = window.KaelDoor;
  const noDoor = () => !!door && !door.key;
  let round = 0;
  const begin = () => {
    const my = ++round;
    if (id && saved) {
      root.classList.add('kael-auto');
      put(pwIn, saved);
      tell('connecting');
      let n = 0;
      const kick = () => {   // 信令登上之前点「连接」只会被打回来，半秒点一回，二十秒还没起来就让人自己来
        if (my !== round || noDoor() || going()) return;
        if (++n > 40) { root.classList.remove('kael-auto'); tell('failed', { why: 'timeout' }); return; }
        btn?.click();
        later(kick, 500);
      };
      later(kick, 300);
    } else ask('first');
  };
  // 配过的这扇给新设备发码：
  // 外面喊一声 kaelControl:'paircode'，这里拿着门钥匙去家里要一个六位码，原样回给外面。卡里不接这个
  if (!card) addEventListener('message', async (e) => {
    if (e.origin !== parentOrigin || e.source !== parent || e.data?.kaelControl !== 'paircode') return;
    const rid = e.data.requestId;
    if (!door?.key) return tell('paircode', { requestId: rid, err: '这扇门自己还没钥匙' });
    try {
      const r = await fetch('/api/agent/newcode', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ k: door.key }), cache: 'no-store', credentials: 'same-origin' });
      const o = await r.json().catch(() => ({}));
      tell('paircode', r.ok && o.code ? { requestId: rid, code: o.code, min: o.validMinutes || 10 }
        : { requestId: rid, err: r.status === 502 || r.status === 504 ? '家里没回音' : (o.error || String(r.status)) });
    } catch { tell('paircode', { requestId: rid, err: '家里没回音' }); }
  });
  // 父卡不能接触门钥匙，只能经这扇已认过来源的框请求接手/查询。
  if (card) addEventListener('message', async e => {
    if (stopped || e.origin !== parentOrigin || e.source !== parent) return;
    const command = e.data?.kaelControl;
    if (command !== 'hold' && command !== 'hold-state') return;
    const requestId = e.data.requestId;
    if (typeof requestId !== 'string' || requestId.length > 100) return;
    const reply = extra => { if (!stopped) tell('hold-state', { requestId, ...extra }); };
    if (command === 'hold' && typeof e.data.on !== 'boolean') return reply({ err: '接手请求不对' });
    if (!door?.key) return reply({ err: '请先配对这台设备', needPair: true });
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const r = await fetch('/api/agent/card-control', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'same-origin',
        signal: controller.signal, body: JSON.stringify({ k: door.key, ...(command === 'hold' ? { on: e.data.on } : {}) }) });
      const o = await r.json().catch(() => ({}));
      if (!r.ok || typeof o.hold !== 'boolean') return reply({ err: o.error || '接手状态没确认', needPair: r.status === 403 });
      if (command === 'hold') dispatchEvent(new Event('kael-card-activity'));
      reply({ hold: o.hold, pending: !!o.pending, guardReady: !!o.guardReady, revision: o.revision });
    } catch { reply({ err: '家里没回音，接手状态没确认' }); }
    finally { clearTimeout(timeout); }
  });
  addEventListener('kael-door-lost', () => { round++; ask('door'); });
  addEventListener('kael-door', () => { if (!stopped) begin(); });
  if (noDoor()) ask('door'); else begin();
  let live = false;
  // 网页版一连上就要「高画质＋画质优先」：网一紧它宁可掉帧也守着原尺寸（见过五分钟里主机一直发 2560×1600、2.45Mbps，
  // 一回没往下调，后两分钟手机那头一直在丢包）。这扇框连上以后自己换成「帧率优先」：网紧先降分辨率、不掉帧；操作间中画质，小图低画质。
  // 人在圆按钮里自己改了就听人的，下一回连上再换回来。
  const WANT = mini ? { quality: 0, frame_rate: 30, preference: 0 } : { quality: 1, frame_rate: 30, preference: 0 };
  let tuned = false, tuneN = 0;
  const tune = () => {
    if (stopped || tuned || !live) return;
    const s = window.CrossDeskVideoSettings;
    // 等主机说它认这一套（supported），默认那一下答完了再换；等十秒还在 pending 就直接换（新的会盖掉旧的）
    if (s?.supported && (s.status !== 'pending' || tuneN >= 20)) {
      tuned = true;
      const ok = window.CrossDeskSession?.requestVideoSettings?.(WANT);
      tell('qos', { ev: ok ? 'tuned' : 'tune-refused', want: WANT.quality + '/' + WANT.preference });
      return;
    }
    if (++tuneN < 60) later(tune, 500);
  };
  const onFrame = () => {
    if (stopped || live) return;
    live = true;
    root.classList.add('kael-live');
    if (typed && !mini && !card) try { localStorage.setItem(KEY, typed); } catch {}
    tell('live', video?.videoWidth ? { vw: video.videoWidth, vh: video.videoHeight } : null);
    tune();
  };
  video?.addEventListener('playing', onFrame);
  if (video?.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
  else video?.addEventListener('loadeddata', onFrame);
  // 操作间里每 10 秒把这条线的数报给外面（走哪条路、收多快、丢多少、几帧、多大、主机那头报的），外面记进小账；下回再卡我直接看卡在哪一段。只有数，没有画面
  if (!mini) setInterval(() => {
    const s = window.CrossDeskStats;
    if (stopped || !live || !s) return;
    const a = s.video_settings?.applied;
    tell('qos', {
      route: s.route + (s.relay_protocol && s.relay_protocol !== 'unknown' ? '/' + s.relay_protocol : ''),
      kbps: Math.round((s.received_bps || 0) / 1000), loss: s.packets ? Math.round(s.lost / s.packets * 1000) / 10 : 0,
      rtt: s.rtt_ms, fps: Math.round(s.fps || 0), w: s.width, h: s.height, dec: Math.round(s.decode_ms || 0),
      jit: Math.round(s.jitter_ms || 0), frz: s.frozen ? 1 : 0, set: a ? a.quality + '/' + a.preference + '/' + a.frame_rate : '',
      snd: s.sender ? JSON.stringify(s.sender).slice(0, 300) : undefined,
    });
  }, 10000);
  // 电脑那头握上手了、这头也报了 live，看着却还是一张图。
  // 小图连上后头半分钟每 3 秒报一回这扇框里的画面到底在不在走（暂停没、播到几秒、解出几帧、收多快），只有数；
  // 画面停着就推它一把 play()，推没推动也报回去。
  if (mini) {
    let n = 0;
    const iv = setInterval(() => {
      if (stopped || !live) return;
      if (++n > 10) return clearInterval(iv);
      const s = window.CrossDeskStats || {}, q = video?.getVideoPlaybackQuality?.();
      tell('qos', { ev: 'probe', n, p: video ? (video.paused ? 1 : 0) : -1, ct: video ? Math.round(video.currentTime * 10) / 10 : -1,
        rs: video?.readyState, fr: q ? q.totalVideoFrames : -1, fps: Math.round(s.fps || 0), kbps: Math.round((s.received_bps || 0) / 1000),
        w: video?.videoWidth, route: s.route, vis: document.visibilityState });
      if (video?.paused) video.play().then(() => tell('qos', { ev: 'play-ok', n }), (e) => tell('qos', { ev: 'play-err', n, msg: String(e?.name || e).slice(0, 60) }));
    }, 3000);
  }
  if (fb) new MutationObserver(() => {
    const t = (fb.textContent || '').trim();
    fb.classList.toggle('kael-has', !!t);
    if (noDoor()) return;   // 没钥匙时信令本来就进不去，那些「连接失败」不算数，配对码那格自己说话
    if (/密码错误/.test(t)) { try { localStorage.removeItem(KEY); } catch {} live = false; ask('wrong'); }
    else if (/失败|超时|断开|无法/.test(t)) { live = false; root.classList.remove('kael-auto', 'kael-live'); tell('failed', { msg: t.slice(0, 80) }); }
  }).observe(fb, { childList: true, subtree: true, characterData: true });
  fb?.classList.toggle('kael-has', !!(fb.textContent || '').trim());
  let cutWhy = '';
  if (media) new MutationObserver(() => {
    if (going() || !live) return;
    live = false; tuned = false; tuneN = 0; root.classList.remove('kael-live');
    // 卡上不是我断的（人点悬浮球里的「断开连接」、或者网断了）也一样：清空那格、改问密码，上面那行说「断开了」。
    // 原来只报 closed：悬浮球断开以后没有「重新连接」，那层又藏着，断了什么都不剩
    if (!cutWhy && !card) return tell('closed');
    const why = cutWhy || 'closed'; cutWhy = '';
    typed = ''; put(pwIn, ''); ask(why);   // 卡是闲断的：那格清空，再连再问
  }).observe(media, { attributes: true, attributeFilter: ['style'] });
  if (card) {
    // #…&idle=秒 只许往短里调（测试用），长不过半小时；切出去的限度跟着它，最多一分钟
    const IDLE = Math.min(1800, Number(h.get('idle')) || 1800) * 1000, HID = Math.min(60e3, IDLE), WARN = Math.min(30e3, IDLE / 2);
    let lastIn = Date.now(), hiddenAt = 0, warned = false;
    const cut = (why) => { if (!live || cutWhy) return; cutWhy = why; warned = false; try { window.CrossDeskSession?.disconnect?.(); } catch {} };
    const poke = () => { lastIn = Date.now(); if (warned) { warned = false; tell('idleok'); } };
    addEventListener('kael-card-activity', poke);
    // 卡上那颗「断开」：外面那层发 kaelControl:'cut'，只认登记过的那个框
    addEventListener('message', (e) => { if (e.origin === parentOrigin && e.source === parent && e.data?.kaelControl === 'cut') cut('manual'); });
    for (const ev of ['pointerdown', 'touchstart', 'keydown', 'wheel']) addEventListener(ev, poke, { capture: true, passive: true });
    const check = () => {
      if (stopped || !live) { lastIn = Date.now(); warned = false; return; }   // 没连着不算闲
      const now = Date.now();
      if (hiddenAt && now - hiddenAt > HID) return cut('hidden');
      if (now - lastIn > IDLE) return cut('idle');
      if (!warned && now - lastIn > IDLE - WARN) { warned = true; tell('idlewarn', { sec: Math.max(1, Math.round((IDLE - (now - lastIn)) / 1000)) }); }
    };
    // 切出去时页面的钟会被压慢甚至停，回来那一下先算一遍
    document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else { check(); hiddenAt = 0; } });
    setInterval(check, Math.min(5000, IDLE / 4));
  }
}
