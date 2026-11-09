// 信令那道门上挂了钥匙：VPS 上的 Caddy 只放带 ?k=<钥匙> 的网页进信令，
// 不带的连密码框都摸不到，CrossDesk 的密码退成第二把锁。（电脑上的 CrossDesk 自己走另一条藏起来的门牌，不经这里。）
// 这一页排在 web_client.js 前头，赶在它头一回连信令之前把钥匙接到地址上。钥匙从哪来：
//   ① 地址 #…&k=<钥匙>——嵌它的聊天页递进来（聊天页自己有门，钥匙从电脑上的小程序拿）；
//   ② 这台手机上回记下的（localStorage，分站存：你的聊天页里那扇框、聊天应用里的直播卡、直接打开这页，各记各的）；
//   ③ 操控台配对过的（同站的 ks 钥匙，问 /api/agent/door 换）；
//   ④ 都没有：在密码那格的位置摆一格「配对码」，Kael 发的六位数，经家里换回钥匙记下。小图（#mini）不出这格，只报缺钥匙。
// 记下的那把不灵了（钥匙换过）：/door 一问就知道，丢掉重来。
(() => {
  const STORE = 'kael.door';
  const root = document.documentElement;
  const cfg = window.CROSSDESK_CONFIG = window.CROSSDESK_CONFIG || {};
  // 信令地址不写死，读首页那份配置（web/build.mjs 照 site.json 生成）；没配就用这页自己的域名
  const BASE = String(cfg.signalingUrl || ('wss://' + location.host)).replace(/\?.*$/, '').replace(/\/?$/, '/');
  const hp = new URLSearchParams(location.hash.slice(1));
  const mini = hp.has('mini');
  const clean = (s) => String(s || '').replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 64);
  const save = (k) => { try { k ? localStorage.setItem(STORE, k) : localStorage.removeItem(STORE); } catch {} };
  let key = clean(hp.get('k')), fromHash = !!key;
  if (fromHash) {
    save(key);
    // 钥匙不留在地址里（后面 kael_embed.js 还要读 embed/id/card/mini，只摘 k）
    const h = location.hash.replace(/([#&])k=[^&]*/, '$1').replace(/&&+/, '&').replace(/[#&]$/, '').replace(/^#&/, '#');
    try { history.replaceState(history.state, '', location.pathname + location.search + h); } catch {}
  } else {
    try { key = clean(localStorage.getItem(STORE)); } catch {}
  }
  const url = (k) => BASE + '?k=' + (k || 'none');
  cfg.signalingUrl = url(key);

  const fire = (name) => { try { dispatchEvent(new Event(name)); } catch {} };
  const door = window.KaelDoor = { get key() { return key; }, mini };

  // 换上一把新钥匙：记下、改信令地址、立刻重连（web_client.js 的 CONFIG / connectSignaling 是全局的）
  function useKey(k) {
    key = clean(k); save(key);
    try { CONFIG.signalingUrl = url(key); } catch {}
    try { if (typeof connectSignaling === 'function') connectSignaling(false); } catch {}
    root.classList.remove('kael-nodoor');
    fire('kael-door');
  }
  door.useKey = useKey;

  // —— 配对码那一格 ——
  let box = null;
  function showPair(why) {
    key = ''; save('');
    fire('kael-door-lost');
    if (mini) return;   // 小图只要画面，缺钥匙让外面退回定格的图
    root.classList.add('kael-nodoor');
    if (box) return;
    const st = document.createElement('style');
    st.textContent = '#kael-door{display:none;width:min(300px,86vw);margin:0 auto;text-align:center;box-sizing:border-box}'
      + 'html.kael-nodoor #kael-door{display:block}'
      // 两个 id 压过 kael_embed.js 那条 html.kael-embed #connection-form{display:block!important}（谁后插进来谁赢，不能赌先后）
      + 'html.kael-nodoor #connection-overlay #connection-form,html.kael-nodoor #connection-overlay #connection-feedback{display:none!important}'
      + 'html.kael-nodoor #connection-overlay{display:flex!important;visibility:visible!important;align-items:center;justify-content:center}'
      + '#kael-door input{display:block;width:100%;height:52px;box-sizing:border-box;border-radius:99px;border:1px solid rgba(60,72,52,.24);background:rgba(255,255,255,.58);'
      + 'text-align:center;font-size:22px;letter-spacing:.42em;color:#33402f;outline:none;box-shadow:none;padding:0 12px;font-family:inherit}'
      + '#kael-door input::placeholder{font-size:15px;letter-spacing:.06em;color:#7d8875}'
      + '#kael-door input:focus{border-color:rgba(170,140,70,.6);background:rgba(255,255,255,.72)}'
      + '#kael-door button{margin-top:14px;border-radius:99px;border:1px solid rgba(60,72,52,.24);background:rgba(255,255,255,.42);color:#33402f;padding:9px 26px;font-size:15px;font-family:inherit}'
      + '#kael-door button:disabled{opacity:.45}'
      + '#kael-door .kd-msg{min-height:18px;margin-top:10px;font-size:13px;line-height:18px}'
      + '#kael-door .kd-msg span{display:inline-block;padding:3px 12px;border-radius:99px;background:rgba(255,255,255,.62);color:#6b4a33}';
    document.head.appendChild(st);
    box = document.createElement('div');
    box.id = 'kael-door';
    box.innerHTML = '<input id="kael-door-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="六位配对码">'
      + '<button type="button">开门</button><div class="kd-msg"></div>';
    const panel = document.querySelector('.connection-panel') || document.getElementById('connection-overlay') || document.body;
    panel.insertBefore(box, panel.firstChild);
    const inp = box.querySelector('input'), btn = box.querySelector('button'), msg = box.querySelector('.kd-msg');
    const say = (t) => { msg.innerHTML = ''; if (t) { const s = document.createElement('span'); s.textContent = t; msg.appendChild(s); } };
    say(why === 'stale' ? '门上的锁换过了：去进过门的设备点「新设备的码」' : '门上了锁：输「新设备的码」给的六位数');
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); });
    const go = async () => {
      const code = inp.value.replace(/\D/g, '');
      if (code.length !== 6) return say('是六位数');
      btn.disabled = true; say('开门中…');
      try {
        const r = await fetch('/api/agent/doorpair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }), cache: 'no-store', credentials: 'same-origin' });
        const o = await r.json().catch(() => ({}));
        if (r.ok && o.k) { inp.value = ''; say(''); useKey(o.k); return; }
        say(r.status === 401 ? '配对码不对' : r.status === 410 ? '配对码过期了，再要一个' : r.status === 502 || r.status === 504 ? '家里没回音，等会儿再试' : (o.error || '没开成（' + r.status + '）'));
      } catch { say('家里没回音，等会儿再试'); }
      btn.disabled = false;
    };
    btn.onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  // —— 进门时 ——
  if (fromHash) return;   // 聊天页刚递进来的，不用再问
  if (key) {
    // 记下的那把先照用（不耽误连），同时问一声还灵不灵
    fetch('/door?k=' + key, { cache: 'no-store' }).then((r) => { if (r.status === 403) showPair('stale'); }).catch(() => {});
    return;
  }
  // 操控台配对过的人，同站有 ks 钥匙：拿它换
  (mini ? Promise.resolve(null) : fetch('/api/agent/door', { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => r.ok ? r.json() : null).catch(() => null))
    .then((o) => { if (o && o.k) useKey(o.k); else showPair('none'); });
})();
