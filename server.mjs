// 屏幕那扇窗。跟 bot 分开的独立程序，项目书在同目录 项目书.md。
// 两扇门：
//   127.0.0.1:5260 —— 只给本机（我的手、眼、字幕），永远不往外接。
//   127.0.0.1:5261 —— 操控台读账用的，经 frpc-screen 接到 VPS，<你的域名>/api/agent/*；
//                     看状态、看步骤、按接手/还手，要配对过的钥匙；连接器、住在 VPS 上的 Agent（desk，d 不填就关着）各带各的钥匙来动手。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HandClient } from './hand-client.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SCREEN_PORT || 5260);
const PUBLIC_PORT = Number(process.env.SCREEN_PUBLIC_PORT || 5261);
// mac 上换 hand-mac / overlay-mac（hand\*.swift，同一套一问一答；没编译过、没在 mac 上跑过）
const MAC = process.platform === 'darwin';
const HAND = path.join(DIR, 'hand', MAC ? 'hand-mac' : 'hand-v2.exe');
const LOG = path.join(DIR, 'log');
const SHOTS = path.join(DIR, 'shots');
const STEPS_DIR = path.join(SHOTS, 'steps');
const JOBS_DIR = path.join(SHOTS, 'jobs');   // 聊天页那张图：每一趟活做完那一刻
const TOKENS = path.join(DIR, 'deploy', 'console_tokens.json');
// 信令门上的钥匙（w＝网页带的那把）。每回现读，换钥匙不用重开小程序
const DOOR = path.join(DIR, 'deploy', 'door.json');
function doorKey() { try { return String(JSON.parse(fs.readFileSync(DOOR, 'utf8').replace(/^﻿/, '')).w || ''); } catch { return ''; } }
fs.mkdirSync(LOG, { recursive: true });
fs.mkdirSync(STEPS_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

// —— hand.exe：一问一答，排队 ——
const handClient = new HandClient(HAND, { note: o => note(o), fault: e => {
  agent.hold = true; controlEpoch++; lookNext = null; persistHold();
} });
function startHand() { handClient.start(); }
function ask(...args) { return handClient.ask(args, { priority: args[0] === 'frame' ? 2 : 1 }); }
function controlCheck(epoch) {
  if (agent.hold || epoch !== controlEpoch) { const e = new Error('人接手了'); e.code = 409; throw e; }
}
function input(epoch, ...args) {
  return handClient.ask(args, { mutation: true, priority: 0, validate: () => controlCheck(epoch) });
}

function note(o) {
  fs.appendFile(path.join(LOG, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n', () => {});
}

// —— 最上面那层「我」：overlay.exe，字幕＋点下去的涟漪（CrossDesk 抓屏不带光标）——
const OVERLAY = path.join(DIR, 'hand', MAC ? 'overlay-mac' : 'overlay.exe');
let overlay = null, captionTimer = null;
function startOverlay() {
  overlay = spawn(OVERLAY, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  overlay.on('error', e => note({ ev: 'overlay-error', msg: e.message }));
  overlay.on('exit', code => { note({ ev: 'overlay-exit', code }); overlay = null; setTimeout(startOverlay, 1000); });
  overlay.stdin.on('error', () => {});
}
function ov(...args) {
  if (!overlay) return;
  try { overlay.stdin.write(args.map(a => String(a).replace(/[\t\n\r]/g, ' ')).join('\t') + '\n'); } catch {}
}
// 操控台要的账：AI 在说什么、做到第几步、有没有被人按住
const agent = { caption: '', captionAt: 0, lastActAt: 0, waitingAt: 0, hold: true, holdAt: 0 };
const HOLD_FILE = path.join(DIR, 'deploy', 'hold.json');
try { agent.hold = !!JSON.parse(fs.readFileSync(HOLD_FILE, 'utf8')).hold; } catch {}
let controlEpoch = 0;
const ocLeases = new Map();
function persistHold() {
  fs.mkdirSync(path.dirname(HOLD_FILE), { recursive: true });
  fs.writeFileSync(HOLD_FILE + '.tmp', JSON.stringify({ hold: agent.hold }));
  fs.renameSync(HOLD_FILE + '.tmp', HOLD_FILE);
}
async function ocStatus() {
  try {
    const r = await fetch('http://127.0.0.1:19825/kael-guard', { headers: { 'X-OpenCLI': '1' }, signal: AbortSignal.timeout(1000) });
    const o = await r.json(); return r.ok && o.guard === 1 ? o : null;
  } catch { return null; }
}
async function handover() {
  const oc = await ocStatus();
  return { hold: agent.hold, pending: agent.hold && (handClient.busyMutation || ocLeases.size > 0 || !oc || !!oc.pending || !!oc.uncertain),
    guardReady: !!oc, revision: controlEpoch };
}
// OpenCLI 一条命令结果不确定：停手，等人看过按「还给你」
function ocUnsure() {
  agent.hold = true; agent.holdAt = Date.now(); controlEpoch++; lookNext = null; persistHold();
  clearTimeout(captionTimer); ov('wait', '动作结果不确定，已停手');
  note({ ev: 'held', from: 'oc-uncertain' });
}
async function setHold(on, from) {
  if (typeof on !== 'boolean') { const e = new Error('on must be boolean'); e.code = 400; throw e; }
  agent.hold = !!on; agent.holdAt = Date.now(); controlEpoch++; lookNext = null; persistHold();
  if (on) { clearTimeout(captionTimer); ov('wait', '正在松手…'); }
  else {
    say('还给我了，我接着来', 6000);
    // 人按「还给你」＝看过了：后台那边没报上来的「不确定」清掉；十分钟还没还的租约是后台半路倒了，不再算在途
    try { await fetch('http://127.0.0.1:19825/kael-guard/clear', { method: 'POST', headers: { 'X-OpenCLI': '1' }, signal: AbortSignal.timeout(1000) }); } catch {}
    for (const [t, l] of ocLeases) if (Date.now() - l.at > 10 * 60000) ocLeases.delete(t);
  }
  note({ ev: on ? 'held' : 'released', from });
  const state = await handover();
  if (on && !state.pending) ov('wait', '你接手了，我松开');
  return state;
}
const steps = []; let stepSeq = Date.now();
function say(text, ms = 20000) {
  ov('say', text || '');
  agent.caption = text || ''; agent.captionAt = Date.now();
  clearTimeout(captionTimer);
  if (text) captionTimer = setTimeout(() => ov('say', ''), ms);
}
function agentStatus() {
  const now = Date.now();
  if (agent.hold) return 'held';
  if (now - agent.waitingAt < 15000) return 'waiting';
  if (now - agent.lastActAt < 90000) return 'working';
  return 'idle';
}
// —— 聊天页里那张会动的图 ——
// 一趟活＝我从动第一下到 /agent/done（或闲过五分钟；我截图看也算在干）。每一步动手之前，先把我要碰的那一扇窗拍下来（<步号>c.jpg，
// 不带我那层字幕），聊天页就照这张画、在我要点的那一点上亮我的光；做完那一刻再拍一张（jobs/<趟号>f.jpg）。
// 头一回真干活时，AI 停下来查东西两分多钟，90 秒一到这趟就被当成干完了，聊天页那张图停在一行空的「做完了」
const JOB_IDLE_MS = 5 * 60000;
const JOBS_LOG = path.join(LOG, 'jobs.jsonl');
let job = null;                                 // { id, startedAt, lastAt, endedAt, summary, n, last }
// 重开以后接上最后一趟：不然聊天页最底下那张图问 /agent/live 只拿到空的，写成「这一趟没留下画面」
try { const l = fs.readFileSync(JOBS_LOG, 'utf8').trim().split('\n').pop(); if (l) job = JSON.parse(l); } catch {}
// 截图不久留：一趟干完，步骤图全删，只留收尾那两张给聊天里的小图；
// 收尾图留三天，到期删掉，那张旧图收成一行字（present 把没了的图从账上摘掉，页面就不去要）。字（jobs/steps.jsonl）留着。
const KEEP_MS = 3 * 24 * 3600e3;
function wipeSteps(wait = 1500) {
  setTimeout(() => {   // 等最后一步「做完后」那两张落了再删（动作后 500ms 才拍）
    if (job && !job.endedAt) return;   // 这期间又开了一趟就不动，等它干完一起删
    for (const s of steps) s.thumb = false;   // 操控台那溜账别再去要图
    try { for (const f of fs.readdirSync(STEPS_DIR)) fs.unlink(path.join(STEPS_DIR, f), () => {}); } catch {}
  }, wait);
}
function sweep() {
  const cut = Date.now() - KEEP_MS;
  for (const [d, only] of [[JOBS_DIR, null], [STEPS_DIR, null], [SHOTS, /^agent/]]) {
    let names = []; try { names = fs.readdirSync(d); } catch {}
    for (const n of names) {
      if (only && !only.test(n)) continue;
      try { const p = path.join(d, n); const st = fs.statSync(p); if (st.isFile() && st.mtimeMs < cut) fs.unlinkSync(p); } catch {}
    }
  }
}
function present(j) {
  if (!j) return j;
  const o = { ...j };
  if (o.final && !fs.existsSync(path.join(JOBS_DIR, o.id + 'f.jpg'))) o.final = false;
  if (o.last?.crop && !fs.existsSync(path.join(STEPS_DIR, o.last.id + 'c.jpg'))) o.last = { ...o.last, crop: false };
  return o;
}
sweep(); setInterval(sweep, 3600e3);
if (!job || job.endedAt) wipeSteps(0);   // 重开时没有正在干的活：上回剩下的步骤图都是干完的
function liveJob() {
  if (job && !job.endedAt && !ocLeases.size && Date.now() - job.lastAt > JOB_IDLE_MS) endJob('', false);
  return job;
}
function touchJob(turnId) {
  const now = Date.now();
  if (!liveJob() || job.endedAt) job = { id: now, startedAt: now, lastAt: now, endedAt: 0, summary: '', n: 0, last: null, final: false };
  job.lastAt = now;
  if (turnId && /^[\w.-]{1,100}$/.test(turnId)) { job.turnIds ||= []; if (!job.turnIds.includes(turnId)) job.turnIds.push(turnId); }
  return job;
}
function endJob(summary, shoot) {
  if (!job || job.endedAt) return;
  job.endedAt = Date.now(); job.finalState = 'pending';
  job.summary = String(summary || '').slice(0, 200);
  const done = job;
  const finalEpoch = controlEpoch;
  const validateFinal = () => { if (agent.hold || finalEpoch !== controlEpoch || job !== done) throw new Error('final capture revoked'); };
  const write = () => { done.finalState = done.final ? 'ready' : 'failed'; fs.appendFile(JOBS_LOG, JSON.stringify(done) + '\n', () => {}); };
  if (!shoot) {   // 闲着收的：这会儿再拍已经不是那一刻了，拿最后一步动手前那两张当收尾
    const l = done.last;
    try {
      if (l?.crop) {
        fs.copyFileSync(path.join(STEPS_DIR, l.id + 'c.jpg'), path.join(JOBS_DIR, done.id + 'f.jpg'));
        done.final = true; done.finalWin = l.win;
        if (l.whole) { fs.copyFileSync(path.join(STEPS_DIR, l.id + 'w.jpg'), path.join(JOBS_DIR, done.id + 'g.jpg')); done.finalWhole = l.whole; }
      }
    } catch (e) { note({ ev: 'final-fail', msg: e.message }); }
    write(); wipeSteps(); return;
  }
  (async () => {
    try {   // 做完那一刻：前台那扇窗（/agent/done 先收了我那层，等它真收干净再拍）
      await new Promise(r => setTimeout(r, 90));
      validateFinal();
      // 最后一步是 OpenCLI 那种只报一句的：拍我最后看的那扇（焦点可能没抢到，前台还是人的窗）
      const l = done.last;
      const r = l?.t === 'say' && l.win ? l.win
        : await ask('win', -1, -1).then(w => [+w.head[1], +w.head[2], +w.head[3], +w.head[4]]);
      const img = await shootWin(r);
      validateFinal();
      fs.writeFileSync(path.join(JOBS_DIR, done.id + 'f.jpg'), img);
      done.final = true; done.finalWin = r;
      done.finalWhole = await shootWhole(path.join(JOBS_DIR, done.id + 'g.jpg'), validateFinal);   // 铺满时看的整块屏幕
      const keep = fs.readdirSync(JOBS_DIR).sort().slice(0, -400);   // 一趟两张，留最近两百趟
      for (const f of keep) fs.unlink(path.join(JOBS_DIR, f), () => {});
    } catch (e) { note({ ev: 'final-fail', msg: e.message }); }
    write(); wipeSteps();
  })();
}
function findJob(near, id = '', turn = '') {
  // 聊天页里一张旧图认它那一趟：那条话落下之前三十分钟内开始的最后一趟
  const hit = (j) => j && (id ? String(j.id) === String(id) : turn ? j.turnIds?.includes(turn) : j.startedAt <= near + 60000 && j.startedAt >= near - 30 * 60000);
  if (hit(liveJob())) return job;
  let best = null;
  try {
    const lines = fs.readFileSync(JOBS_LOG, 'utf8').trim().split('\n').slice(-400);
    for (const l of lines) { try { const j = JSON.parse(l); if (hit(j) && (!best || j.startedAt > best.startedAt)) best = j; } catch {} }
  } catch {}
  return best;
}
// 拍一扇窗：长边不超过 1100（手机 dpr 3 下 250 宽要 750 上下，留点余量）
async function shootWin([x0, y0, x1, y1]) {
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0), k = Math.min(1, 1100 / Math.max(w, h));
  const r = await ask('frame', x0, y0, w, h, Math.round(w * k), Math.round(h * k), 62, '');
  return r.body;
}
// 整块屏幕一张（不带我那层，1280 宽）：聊天页点图铺满看的就是它。回 [屏宽, 屏高]，前端拿它把我的光放回原处
async function shootWhole(file, validate = () => {}) {
  try {
    const sc = await ask('screen');
    const W = +sc.head[1], H = +sc.head[2];
    const image = (await ask('frame', 0, 0, W, H, 1280, Math.round(H * 1280 / W), 60, '')).body;
    validate(); fs.writeFileSync(file, image);
    return [W, H];
  } catch (e) { note({ ev: 'whole-fail', msg: e.message }); return null; }
}
// 动手之前：拍我要碰的那一扇（点、滚有落点就认落点底下那扇，打字、按键认前台那扇）
async function shootBefore(b, sid, validate = () => {}) {
  try {
    const pt = (b.t === 'click' || b.t === 'scroll') && b.x != null;
    const w = await ask('win', pt ? Math.round(b.x) : -1, pt ? Math.round(b.y) : -1);
    const r = [+w.head[1], +w.head[2], +w.head[3], +w.head[4]];
    const image = await shootWin(r); validate();
    fs.writeFileSync(path.join(STEPS_DIR, sid + 'c.jpg'), image);
    return r;
  } catch (e) { note({ ev: 'crop-fail', msg: e.message }); return null; }
}

let thumbTimer = null, thumbBusy = false;
function recordStep(b, sid, win, whole, owner = job) {
  const epoch = controlEpoch;
  const s = { id: sid || ++stepSeq, at: Date.now(), t: b.t, say: b.say || agent.caption || '', k: b.k, thumb: false,
    x: b.x != null ? Math.round(b.x) : null, y: b.y != null ? Math.round(b.y) : null, w: null, h: null,
    win: win || null, crop: !!win, whole: whole || null, job: owner ? owner.id : null };
  steps.push(s); if (steps.length > 120) steps.shift();
  if (owner && !owner.endedAt) { owner.n++; owner.last = s; }
  fs.appendFile(path.join(LOG, 'steps.jsonl'), JSON.stringify(s) + '\n', () => {});
  // 动作落定一会儿再拍一张小图，给操控台当这一步的样子
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    if (thumbBusy || agent.hold || epoch !== controlEpoch || !owner || owner !== job || owner.endedAt || owner.last !== s) return;
    thumbBusy = true;
    try {
      const sc = await ask('screen');
      const W = +sc.head[1], H = +sc.head[2];
      // 大的给操控台顶上那块（手机 dpr 3 下 369 宽要 1100 多像素才不糊），小的给账里那一溜
      const big = await ask('frame', 0, 0, W, H, 1280, Math.round(H * 1280 / W), 52, '', 'layers');
      if (agent.hold || epoch !== controlEpoch || owner !== job || owner.endedAt || owner.last !== s) return;
      fs.writeFileSync(path.join(STEPS_DIR, s.id + '.jpg'), big.body);
      const small = await ask('frame', 0, 0, W, H, 320, Math.round(H * 320 / W), 60, '', 'layers');
      if (agent.hold || epoch !== controlEpoch || owner !== job || owner.endedAt || owner.last !== s) return;
      fs.writeFileSync(path.join(STEPS_DIR, s.id + 's.jpg'), small.body);
      s.thumb = true; s.w = W; s.h = H;
      const old = steps.length > 0 ? steps[0].id : 0; // 只留账上还在的那些图
      for (const f of fs.readdirSync(STEPS_DIR)) { const id = parseInt(f, 10); if (id && id < old) fs.unlink(path.join(STEPS_DIR, f), () => {}); }
    } catch (e) { note({ ev: 'thumb-fail', msg: e.message }); } finally { thumbBusy = false; }
  }, 500);
}

// 人一碰就让：最后一次输入比 AI 最后一次注入还新、而且就在几秒内，那就是人（在电脑前，或从 CrossDesk 里点）
const YIELD_MS = 4000;
async function herHandsOn() {
  const r = await ask('lastinput');
  const idle = +r.head[1], ours = +r.head[2];
  const other = Number(r.head[3]);
  if (!Number.isFinite(other)) throw new Error('hand input monitor unavailable; update hand.exe');
  const hers = other >= 0 && other < YIELD_MS;
  return { hers, idle, ours };
}

// —— 动手：网页和我都走这一个口子 ——
async function act(b, who) {
  if (!['move', 'click', 'scroll', 'key', 'text'].includes(b.t)) {
    const e = new Error('unsupported action; use an atomic click/key/text gesture'); e.code = 400; throw e;
  }
  const epoch = controlEpoch;
  const n = v => Math.round(Number(v));
  if (who === 'kael') {
    if (agent.hold) { const e = new Error('人接手了'); e.code = 409; throw e; }
    const h = await herHandsOn();
    if (h.hers && !b.force) {
      ov('wait', '你在用，我等着');
      agent.waitingAt = Date.now();
      clearTimeout(captionTimer); captionTimer = setTimeout(() => ov('say', ''), 8000);
      note({ ev: 'yield', idle: h.idle, ours: h.ours, t: b.t });
      const e = new Error('人在用'); e.code = 409; throw e;
    }
    if (b.say && (b.quiet || b.t === 'move')) say(b.say);   // 不进账的照旧先换字幕
    agent.lastActAt = Date.now();
  }
  let sid = null, win = null, whole = null, owner = null;
  if (who === 'kael' && !b.quiet && b.t !== 'move') {
    controlCheck(epoch); owner = touchJob(b.turnId);
    sid = ++stepSeq;
    // 拍之前先把字幕那层（字幕胶囊、落点）收起来：普通截屏也会把它拍进去，
    // 聊天页那张图要干净，这一步在干嘛已经写在图底下了。拍完再亮出来，屏幕上只眨一下
    ov('hide'); await new Promise(r => setTimeout(r, 90));
    win = await shootBefore(b, sid, () => controlCheck(epoch));
    whole = await shootWhole(path.join(STEPS_DIR, sid + 'w.jpg'), () => controlCheck(epoch));
    if (b.say) say(b.say);
    else if (agent.caption && Date.now() - agent.captionAt < 20000) ov('say', agent.caption);
  }
  const dispatch = (...args) => input(epoch, ...args);
  controlCheck(epoch);
  switch (b.t) {
    case 'move': await dispatch('move', n(b.x), n(b.y)); break;
    case 'click': await dispatch('click', n(b.x), n(b.y), b.btn || 'left', n(b.n || 1)); break;
    case 'scroll': await dispatch('scroll', n(b.x), n(b.y), n(b.dy || 0), b.h ? 'h' : ''); break;
    case 'key': await dispatch('key', String(b.k)); break;
    case 'text': await dispatch('text', Buffer.from(String(b.s), 'utf8').toString('base64')); break;
    default: throw new Error('unknown t ' + b.t);
  }
  if (who === 'kael') {
    if (b.t === 'click') ov('tap', n(b.x), n(b.y));
    else if ((b.t === 'move' || b.t === 'scroll') && !b.quiet) ov('at', n(b.x), n(b.y));
    if (!b.quiet && b.t !== 'move') recordStep(b, sid, win, whole, owner);
  }
  note({ ev: 'act', who, t: b.t, x: b.x, y: b.y, k: b.k, len: b.s ? String(b.s).length : undefined, say: b.say });
}

// 只报一句、不碰鼠标键盘的一步（OpenCLI 在干的时候）：跟 act 一样先藏我那层再拍，拍的是前台那扇窗。
// 带 front（窗口标题里的一截）就先按标题把那扇拎到最前面再拍：OpenCLI 说开在前台，Windows 常常不让
async function look(b) {
  const epoch = controlEpoch; controlCheck(epoch);
  const hands = await herHandsOn(); controlCheck(epoch);
  if (hands.hers) { const e = new Error('人在用'); e.code = 409; throw e; }
  agent.lastActAt = Date.now();
  const owner = touchJob(b.turnId);
  const sid = ++stepSeq;
  let fronted = null;
  if (b.front) {
    try { const f = await input(epoch, 'front', String(b.front)); fronted = [+f.head[1], +f.head[2], +f.head[3], +f.head[4]]; }
    catch (e) { note({ ev: 'front-fail', want: b.front, msg: e.message }); }
  }
  ov('hide'); await new Promise(r => setTimeout(r, 90));
  let win = null;
  if (fronted) {
    try { const image = await shootWin(fronted); controlCheck(epoch); if (owner.endedAt) return; fs.writeFileSync(path.join(STEPS_DIR, sid + 'c.jpg'), image); win = fronted; }
    catch (e) { note({ ev: 'crop-fail', msg: e.message }); }
  } else win = await shootBefore({ t: 'say' }, sid, () => controlCheck(epoch));
  const whole = await shootWhole(path.join(STEPS_DIR, sid + 'w.jpg'), () => controlCheck(epoch));
  controlCheck(epoch);
  if (owner.endedAt || owner !== job) return;
  say(b.s, b.ms || 20000);
  recordStep({ t: 'say', say: b.s }, sid, win, whole, owner);
  note({ ev: 'look', say: b.s, win });
}

// 一步接一步报得快时，图不排队：正在拍就只记下最新那一句，拍完补拍它一张，中间的跳过（不然一串排着，最后那张落后好几秒、屏幕上的字一直眨）
let lookRun = null, lookNext = null;
function lookSoon(b) {
  if (agent.hold) return;
  agent.lastActAt = Date.now();
  touchJob(b.turnId);
  if (lookRun) { lookNext = b; return; }
  lookRun = look(b).catch(e => note({ ev: 'look-fail', msg: e.message })).finally(() => {
    lookRun = null;
    const n = lookNext; lookNext = null;
    if (n && !agent.hold && job && !job.endedAt) lookSoon(n);   // done 之后不补，免得又开出一趟
  });
}

// —— 网页 ——
function guard(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== '127.0.0.1:' + PORT && host !== 'localhost:' + PORT) return 'bad host';
  const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  if (origin && origin !== 'http://' + host) return 'bad origin';
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-origin';
  // Native APIs have no browser caller, including same-origin pages.
  if (req.url.startsWith('/agent/') && (origin || site)) return 'native API';
  if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return 'json required';
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('error', reject); req.on('aborted', () => reject(new Error('request aborted')));
    req.on('data', c => { s += c; if (s.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const bad = guard(req);
  if (bad) { note({ ev: 'refused', why: bad, url: req.url }); res.writeHead(403).end(); return; }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/screen') {
      const r = await ask('screen');
      return send(res, 200, { w: +r.head[1], h: +r.head[2], cx: +r.head[3], cy: +r.head[4] });
    }
    if (u.pathname === '/api/frame') {
      const q = k => u.searchParams.get(k);
      const r = await ask('frame', q('x') || 0, q('y') || 0, q('w') || 99999, q('h') || 99999, q('tw') || 0, q('th') || 0, q('q') || 60, q('since') || '');
      const hdr = { 'Cache-Control': 'no-store', 'X-Hash': r.head[r.head[0] === 'JPEG' ? 2 : 1], 'X-Cursor': r.head.slice(-2).join(',') };
      if (r.head[0] === 'SAME') { res.writeHead(204, hdr); return res.end(); }
      res.writeHead(200, { ...hdr, 'Content-Type': 'image/jpeg', 'Content-Length': r.body.length });
      return res.end(r.body);
    }
    if (u.pathname === '/api/input' && req.method === 'POST') {
      await act(await readJson(req), 'kael');
      return send(res, 200, { ok: true });
    }
    // 给我自己用：截一张存成文件，我拿 Read 看；回 scale 方便把图上的坐标换回屏幕坐标
    if (u.pathname === '/agent/shot') {
      const lj = liveJob(); if (lj && !lj.endedAt) lj.lastAt = Date.now();   // 我在看＝还在干
      const sc = await ask('screen');
      const W = +sc.head[1], H = +sc.head[2];
      const tw = Math.min(W, Number(u.searchParams.get('w') || 1280));
      const th = Math.round(H * tw / W);
      const r = await ask('frame', 0, 0, W, H, tw, th, u.searchParams.get('q') || 70, '', u.searchParams.get('layers') ? 'layers' : '');
      const file = path.join(SHOTS, u.searchParams.get('layers') ? 'agent_layers.jpg' : 'agent.jpg');
      fs.writeFileSync(file, r.body);
      return send(res, 200, { path: file, w: tw, h: th, scale: W / tw, cursor: [+r.head[3], +r.head[4]] });
    }
    if (u.pathname === '/agent/act' && req.method === 'POST') {
      const b = await readJson(req);
      if (b.scale && b.x != null) { b.x *= b.scale; b.y *= b.scale; } // 图上的坐标 → 屏幕坐标
      await act(b, 'kael');
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/agent/idle') {
      const h = await herHandsOn();
      return send(res, 200, { idleMs: h.idle, sinceOursMs: h.ours, hersNow: h.hers });
    }
    // 换字幕不动手；done 收起。
    // OpenCLI 干活时小图也要亮：OpenCLI 不经过这儿，AI 每步先报一句 say，
    // 带字的 say 就算 AI 在干——开（续）这一趟、拍前台那扇窗记一步，小图照这扇窗裁直播。quiet 或被人按住时只换字幕。
    // 拍图不等，先回话，拍在后台（touchJob 在 look 第一个 await 之前，回出去的趟号是对的）
    if (u.pathname === '/agent/say' && req.method === 'POST') {
      const b = await readJson(req);
      if (b.s && !b.quiet && !agent.hold) lookSoon(b);
      else say(b.s, b.ms || 20000);
      return send(res, 200, { ok: true, job: job && !job.endedAt ? job.id : null });
    }
    // done 收起字幕、收这一趟活；带一句 s（GET ?s= 或 POST {s}）＝聊天页那张图收起来以后那一行写的「做成了什么」
    if (u.pathname === '/agent/done') {
      const b = req.method === 'POST' ? await readJson(req) : {};
      controlEpoch++;
      clearTimeout(captionTimer); ov('hide'); agent.caption = ''; agent.lastActAt = 0; lookNext = null;
      endJob(b.s || u.searchParams.get('s') || '', !agent.hold);
      for (const n of ['agent.jpg', 'agent_layers.jpg']) fs.unlink(path.join(SHOTS, n), () => {});   // 我看过的那张也不留
      return send(res, 200, { ok: true, job: job ? job.id : null });
    }
    // —— 给 bot 转进聊天页的（只本机）：这一趟活现在什么样、某条话对应哪一趟、图 ——
    if (u.pathname === '/agent/live') {
      const j = liveJob();
      // door：信令门的钥匙，聊天页开直播时递给那扇框（bot 把这条放在聊天页暗号门后面才转出去）
      return send(res, 200, { protocol: 2, now: Date.now(), status: agentStatus(), ...(await handover()), caption: agent.caption, job: present(j), door: doorKey() || undefined });
    }
    if (u.pathname === '/agent/job') {
      return send(res, 200, { now: Date.now(), job: present(findJob(Number(u.searchParams.get('near') || Date.now()), u.searchParams.get('id') || '', u.searchParams.get('turn') || '')) });
    }
    // c＝动手前那扇窗、w＝动手前整块屏幕（一步一张）；f＝做完那扇窗、g＝做完整块屏幕（一趟一张）
    const im = /^\/agent\/img\/(\d+)([cwfg])\.jpg$/.exec(u.pathname);
    if (im) {
      const f = path.join('fg'.includes(im[2]) ? JOBS_DIR : STEPS_DIR, im[1] + im[2] + '.jpg');
      if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    if (u.pathname === '/agent/hold' && req.method === 'POST') {
      const b = await readJson(req);
      const state = await setHold(b.on, 'chat');
      return send(res, state.pending ? 202 : 200, state);
    }
    if (u.pathname === '/agent/oc/acquire' && req.method === 'POST') {
      const b = await readJson(req), epoch = controlEpoch; controlCheck(epoch);
      const hands = await herHandsOn(); controlCheck(epoch);
      if (hands.hers) { const e = new Error('人在用'); e.code = 409; throw e; }
      const token = crypto.randomBytes(24).toString('hex');
      ocLeases.set(token, { id: String(b.id || ''), at: Date.now() });
      if (b.turnId) touchJob(b.turnId);
      return send(res, 200, { token });
    }
    // 结果不确定＝停手等人看，这把租约本身已经还回来了，照样摘掉（原来留着，pending 永远是真，「还给你」也解不开）
    if (u.pathname === '/agent/oc/release' && req.method === 'POST') {
      const b = await readJson(req);
      const had = ocLeases.delete(b.token);
      if (b.uncertain && had) ocUnsure();
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/agent/oc/uncertain' && req.method === 'POST') {
      ocUnsure();
      return send(res, 200, { ok: true });
    }
    // 给一个六位配对码（十分钟有效、只能用一次、错五回作废），在操控台填上换一把长钥匙
    if (u.pathname === '/agent/paircode') {
      pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), until: Date.now() + 10 * 60 * 1000, tries: 0 };
      return send(res, 200, { code: pairing.code, validMinutes: 10 });
    }
    if (u.pathname === '/typetest') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(DIR, 'typetest.html')));
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e.code >= 400 && e.code < 500) return send(res, e.code, { error: e.message, waitForHer: e.code === 409 });
    note({ ev: 'error', url: req.url, msg: e.message });
    send(res, 500, { error: e.message });
  }
});

// —— 给远程 AI 的手：经 VPS 上的连接器来的（ChatGPT、Claude 这类官端聊天应用）——
// 门用 OAuth；整块屏幕、登着号的站都给。工具都不标只读，每一下先不先问人看聊天应用自己（ChatGPT 是每一下都弹确认）。
// 只从 VPS 上的连接器进来：VPS 上的 Caddy 把外面来的 /api/agent/remote 一律 403，连接器在 VPS 本机直接敲 39260，带一把只有它和我知道的 g（door.json）。
// 每一下跟本机 AI 的手守同一套：人按着「我来」不动；人在电脑前一碰（4 秒内）不动；屏幕上的字幕写「AI：…」；一次只做一件。
// 网页那几样走 OpenCLI 的 browser 命令（会话 remote、开在前台）：编号、真鼠标点、看不见不点都是它现成的；前台命令还会再过一道 OpenCLI 后台那道闸。
// npm 全局目录：Windows 在 %APPDATA%\npm；mac 上 Homebrew 的 node 在 /opt/homebrew，官网装的在 /usr/local。都不对就设 OPENCLI_MAIN
const OPENCLI = process.env.OPENCLI_MAIN || [
  process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
  '/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules',
].filter(Boolean).map(r => path.join(r, '@jackwener', 'opencli', 'dist', 'src', 'main.js')).find(p => fs.existsSync(p))
  || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
function relayKey() { try { return String(JSON.parse(fs.readFileSync(DOOR, 'utf8').replace(/^\uFEFF/, '')).g || ''); } catch { return ''; } }
function opencliRun(args, ms = 45000) {
  return new Promise((resolve) => {
    const env = { ...process.env, KAEL_SCREEN_TURN: '' };
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) delete env[k];
    const p = spawn(process.execPath, [OPENCLI, ...args], { env, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; if (out.length > 400000) p.kill(); });
    p.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => { p.kill(); err += '\n(超时)'; }, ms);
    p.on('close', code => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
  });
}
const remoteErr = (code, msg) => Object.assign(new Error(msg), { code });
const plain = (v, max, what) => {   // 不许以 - 开头（会被当成 opencli 的选项）、不许太长
  const s = String(v ?? '').trim();
  if (!s || s.length > max || s.startsWith('-')) throw remoteErr(400, what + ' 不对');
  return s;
};
const REMOTE_TOOLS = {
  open: (a) => {
    const url = plain(a.url, 2000, 'url');
    let h; try { h = new URL(url); } catch { throw remoteErr(400, 'url 不对'); }
    if (!/^https?:$/.test(h.protocol)) throw remoteErr(400, '只开 http/https');
    return { say: '打开 ' + h.hostname, args: ['open', url] };
  },
  state: () => ({ say: '读这一页', args: ['state'] }),
  extract: () => ({ say: '读这一页的字', args: ['extract'] }),
  click: (a) => { const t = plain(a.target, 300, 'target'); return { say: '点 ' + (/^\d+$/.test(t) ? '[' + t + ']' : t.slice(0, 30)), args: ['click', t] }; },
  type: (a) => {
    const t = plain(a.target, 300, 'target'), text = String(a.text ?? '');
    if (!text || text.length > 4000) throw remoteErr(400, 'text 不对');
    return { say: '往 ' + (/^\d+$/.test(t) ? '[' + t + ']' : '那格') + ' 里打字', args: ['type', '--', t, text] };
  },
  keys: (a) => { const k = plain(a.key, 40, 'key'); return { say: '按 ' + k, args: ['keys', k] }; },
  scroll: (a) => ({ say: a.direction === 'up' ? '往上翻' : '往下翻', args: ['scroll', a.direction === 'up' ? 'up' : 'down'] }),
  back: () => ({ say: '后退', args: ['back'] }),
  close: () => ({ say: '关掉它开的那扇', args: ['close'] }),
};
const inBox = (v, max, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) throw remoteErr(400, what + ' is outside the screenshot'); return n; };
const DESK_TOOLS = {
  sclick: (a, tw, th) => {
    const x = inBox(a.x, tw, 'x'), y = inBox(a.y, th, 'y'), btn = a.button === 'right' ? 'right' : 'left';
    return { t: 'click', x, y, btn, n: a.double ? 2 : 1, say: (a.double ? '双击' : btn === 'right' ? '右键点' : '点') + ` (${Math.round(x)}, ${Math.round(y)})` };
  },
  sscroll: (a, tw, th) => {
    const x = inBox(a.x, tw, 'x'), y = inBox(a.y, th, 'y'), dy = Math.max(-20, Math.min(20, Math.round(Number(a.amount ?? 3)) || 3));
    return { t: 'scroll', x, y, dy, say: dy > 0 ? '往下滚' : '往上滚' };
  },
  skey: (a) => {
    const k = String(a.key ?? '').trim().toLowerCase();
    if (!/^[a-z0-9+\-=,./;'`[\]\\]{1,40}$/.test(k)) throw remoteErr(400, 'key 不对');
    return { t: 'key', k, say: '按 ' + k };
  },
  stype: (a) => {
    const s = String(a.text ?? '');
    if (!s || s.length > 4000) throw remoteErr(400, 'text 不对');
    return { t: 'text', s, say: '打字' };
  },
};
let remoteBusy = false;
async function remoteDo(tool, a) {
  const epoch = controlEpoch;
  const check = () => { if (agent.hold || epoch !== controlEpoch) throw remoteErr(409, 'The user took control. Wait until they give it back.'); };
  if (agent.hold) throw remoteErr(409, 'The user is holding control (pressed 我来). Wait until they give it back.');
  const h = await herHandsOn(); check();
  if (h.hers) throw remoteErr(409, 'The user is using the computer right now (touched mouse/keyboard in the last few seconds). Try again shortly.');
  if (tool === 'look') {
    say('AI：看了一眼屏幕', 6000);
    const sc = await ask('screen');
    const W = +sc.head[1], H = +sc.head[2], tw = Math.min(W, 1280), th = Math.round(H * tw / W);
    const r = await ask('frame', 0, 0, W, H, tw, th, 62, '');
    check();
    note({ ev: 'remote', tool, w: tw, h: th, bytes: r.body.length });
    return { ok: true, text: `Screenshot of the whole screen, ${tw}x${th} (real screen ${W}x${H}).`, image: r.body.toString('base64') };
  }
  // 桌面那四样走跟本机那只手同一个 act（「我来」、四秒、没有 force），
  // 坐标是 look 那张 1280 宽的图上的；做完等一下再拍一张交回去，它不用再单独看一眼
  if (DESK_TOOLS[tool]) {
    const sc = await ask('screen');
    const W = +sc.head[1], H = +sc.head[2], tw = Math.min(W, 1280), th = Math.round(H * tw / W), s = W / tw;
    const b = DESK_TOOLS[tool](a || {}, tw, th);
    check();
    b.say = 'AI：' + b.say;
    if (b.x != null) { b.x *= s; b.y *= s; }
    await act(b, 'kael');
    note({ ev: 'remote', tool, t: b.t });
    await new Promise(r => setTimeout(r, 600));
    check();
    const r = await ask('frame', 0, 0, W, H, tw, th, 62, '');
    check();
    return { ok: true, text: `Done. Screenshot right after it, ${tw}x${th}.`, image: r.body.toString('base64') };
  }
  const mk = REMOTE_TOOLS[tool];
  if (!mk) throw remoteErr(400, 'unknown tool');
  const c = mk(a || {});
  say('AI：' + c.say, 15000);
  const t0 = Date.now();
  check();
  const r = await opencliRun(['browser', '--session', 'remote', '--window', 'foreground', ...c.args]);
  remoteWinTouched(tool, r.code);
  note({ ev: 'remote', tool, code: r.code, ms: Date.now() - t0, say: c.say });
  if (agent.hold) say('', 0);
  const text = (r.out || '').slice(0, 60000);
  if (r.code !== 0) return { ok: false, error: ((r.err || r.out || 'failed').slice(-1500)) };
  return { ok: true, text: text || '(done)' };
}

// 远程 AI 开的那扇 Chrome 窗它多半不关（不调 close），十分钟没碰浏览器就家里替它关。
// OpenCLI 的 close 就是 page.closeWindow()；只在它真开过窗、之后没关的时候才去关，免得为了关先开出一扇。
// 人按着「我来」、刚碰过电脑、或远程 AI 正在干，就再往后推十分钟：人可能正接着用那扇窗。
const REMOTE_WIN_IDLE = 10 * 60 * 1000;
let remoteWinTimer = null;
function remoteWinTouched(tool, code) {
  clearTimeout(remoteWinTimer); remoteWinTimer = null;
  if (tool === 'close' && code === 0) return;
  remoteWinTimer = setTimeout(remoteWinSweep, REMOTE_WIN_IDLE);
}
async function remoteWinSweep() {
  remoteWinTimer = null;
  let busy = remoteBusy || agent.hold;
  if (!busy) { try { busy = (await herHandsOn()).hers; } catch { busy = true; } }
  if (busy || remoteBusy) { remoteWinTimer = setTimeout(remoteWinSweep, REMOTE_WIN_IDLE); return; }
  remoteBusy = true;
  try {
    say('收起 AI 开的那扇窗（十分钟没动）', 5000);
    const r = await opencliRun(['browser', '--session', 'remote', '--window', 'foreground', 'close'], 20000);
    note({ ev: 'remote-autoclose', code: r.code, err: r.code ? (r.err || r.out).slice(-300) : undefined });
  } finally { remoteBusy = false; }
}

// 聊天应用里的直播卡没有操控台 cookie，用已经配对的门钥匙读/写同一把控制锁。
// 钥匙留在 screen 的子框里，父卡只收到布尔状态与版本，不经 bot。
async function cardControl(body) {
  const expected = Buffer.from(doorKey(), 'utf8');
  const supplied = Buffer.from(typeof body?.k === 'string' ? body.k : '', 'utf8');
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
    throw remoteErr(403, '先给这台设备配对');
  const write = Object.prototype.hasOwnProperty.call(body, 'on');
  if (write && typeof body.on !== 'boolean') throw remoteErr(400, 'on must be boolean');
  const state = write ? await setHold(body.on, 'remote-card') : await handover();
  return { ...state, pending: state.pending || (state.hold && remoteBusy) };
}

// —— 住在 VPS 上的 Agent 的手 ——
// 跟本机那只手（/agent/shot、act、say、done、idle）同一套，从隧道进来，认 door.json 的 d；d 不填＝这扇门关着。
// 只认 VPS 本机敲 39260 进来的（Host 是 127.0.0.1）：经域名来的该被 Caddy 挡掉（第 5 章），漏过来这里也不认。
// 跟本机那只手不一样的三处：截图直接回 jpg（它在 VPS 上，读不到电脑上的文件）；没有 force，人四秒内碰过就是 409；
// 按着「我来」时连截图也不给。browser 跟连接器的看屏幕、网页那几样是同一套（同一个会话、一次一件）。
// 例子文件里 d 是一句尖括号说明，照抄忘了改就等于钥匙人人知道：不是 16 位以上的字母数字就当没填
function deskKey() {
  try { const k = String(JSON.parse(fs.readFileSync(DOOR, 'utf8').replace(/^﻿/, '')).d || ''); return /^[A-Za-z0-9_-]{16,}$/.test(k) ? k : ''; }
  catch { return ''; }
}
const sameKey = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };
async function desk(op, req, u, res) {
  const d = deskKey();
  if (!d) return send(res, 404, { error: 'desk door is closed (no d in deploy/door.json)' });
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test((req.headers.host || '').toLowerCase())) { note({ ev: 'desk-refused', why: 'host', op }); return send(res, 403, { error: 'no' }); }
  if (!sameKey(req.headers['x-desk-key'] || '', d)) { note({ ev: 'desk-refused', why: 'key', op }); return send(res, 403, { error: 'no' }); }
  const post = async () => { if (req.method !== 'POST') throw remoteErr(405, 'POST required'); return readJson(req); };
  try {
    if (op === 'shot') {
      const epoch = controlEpoch;
      if (agent.hold) throw remoteErr(409, 'The user is holding control (pressed 我来). Wait until it is given back.');
      if ((await herHandsOn()).hers) throw remoteErr(409, 'The user is using the computer right now. Try again shortly.');
      const lj = liveJob(); if (lj && !lj.endedAt) lj.lastAt = Date.now();
      const sc = await ask('screen');
      const W = +sc.head[1], H = +sc.head[2];
      const tw = Math.max(320, Math.min(W, Number(u.searchParams.get('w')) || 1280)), th = Math.round(H * tw / W);
      const r = await ask('frame', 0, 0, W, H, tw, th, 70, '');
      if (agent.hold || epoch !== controlEpoch) throw remoteErr(409, 'The user took control. Wait until it is given back.');
      note({ ev: 'desk', op, w: tw, h: th });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': r.body.length,
        'X-Width': tw, 'X-Height': th, 'X-Scale': String(W / tw), 'X-Cursor': (+r.head[3]) + ',' + (+r.head[4]) });
      return res.end(r.body);
    }
    if (op === 'act') {
      const b = await post();
      delete b.force;   // 这扇门没有「硬来」
      if (['click', 'move', 'scroll'].includes(b.t) && !(Number.isFinite(+b.x) && Number.isFinite(+b.y))) throw remoteErr(400, 'x and y are required');
      if (b.scale && b.x != null) { const s = Number(b.scale); if (!(s > 0)) throw remoteErr(400, 'bad scale'); b.x *= s; b.y *= s; }
      await act(b, 'kael');
      note({ ev: 'desk', op, t: b.t });
      return send(res, 200, { ok: true });
    }
    if (op === 'say') {
      const b = await post();
      if (b.s && !b.quiet && !agent.hold) lookSoon(b);
      else say(b.s, b.ms || 20000);
      return send(res, 200, { ok: true, job: job && !job.endedAt ? job.id : null });
    }
    if (op === 'done') {
      const b = req.method === 'POST' ? await readJson(req) : {};
      controlEpoch++;
      clearTimeout(captionTimer); ov('hide'); agent.caption = ''; agent.lastActAt = 0; lookNext = null;
      endJob(String(b.s || u.searchParams.get('s') || ''), !agent.hold);
      return send(res, 200, { ok: true, job: job ? job.id : null });
    }
    if (op === 'idle') {
      const h = await herHandsOn();
      return send(res, 200, { idleMs: h.idle, sinceOursMs: h.ours, humanNow: h.hers, hold: !!agent.hold });
    }
    if (op === 'browser') {
      const b = await post();
      if (remoteBusy) return send(res, 429, { ok: false, error: 'The previous action is still running.' });
      remoteBusy = true;
      try { return send(res, 200, await remoteDo(String(b.tool || ''), b.args || {})); }
      finally { remoteBusy = false; }
    }
  } catch (e) {
    if (e.code >= 400 && e.code < 500) return send(res, e.code, { ok: false, error: e.message, waitForHuman: e.code === 409 });
    if (e instanceof SyntaxError) return send(res, 400, { ok: false, error: 'bad json' });
    note({ ev: 'desk-error', op, msg: e.message });
    return send(res, 500, { ok: false, error: e.message });
  }
}

// —— 操控台那扇门（经 VPS 进来）——
let pairing = null;
function loadTokens() { try { return JSON.parse(fs.readFileSync(TOKENS, 'utf8')); } catch { return {}; } }
function saveTokens(t) { fs.mkdirSync(path.dirname(TOKENS), { recursive: true }); fs.writeFileSync(TOKENS, JSON.stringify(t, null, 1)); }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function tokenOf(req) {
  const m = /(?:^|;\s*)ks=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function authed(req) {
  const t = tokenOf(req);
  if (!t) return false;
  const all = loadTokens();
  const hit = all[sha(t)];
  if (!hit) return false;
  hit.seen = new Date().toISOString(); saveTokens(all);
  return true;
}
// 认哪个域名、哪些外层不写死，读 deploy/site.json（跟 VPS 上的连接器、网页首页同一份）
const SITE = (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'deploy', 'site.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; } })();
const SITE_HOST = String(SITE.domain || '').toLowerCase();
const PUBLIC_ORIGINS = [SITE_HOST && 'https://' + SITE_HOST, ...(SITE.chatOrigins || []).filter(o => /^https:\/\//.test(o))].filter(Boolean);
if (!SITE_HOST) note({ ev: 'site-missing', msg: 'deploy/site.json 没有 domain：外面那扇门只认本机' });
function publicGuard(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (!(SITE_HOST && host === SITE_HOST) && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin && ![...PUBLIC_ORIGINS, 'http://' + host].includes(origin)) return 'bad origin';
  if (req.method === 'POST' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return 'json required';
  return null;
}

const publicServer = http.createServer(async (req, res) => {
  const bad = publicGuard(req);
  if (bad) { note({ ev: 'public-refused', why: bad, url: req.url }); res.writeHead(403).end(); return; }
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/agent/pair' && req.method === 'POST') {
      const b = await readJson(req);
      if (!pairing || Date.now() > pairing.until) return send(res, 410, { error: '配对码过期了，去进过门的设备点「新设备的码」再拿一个' });
      if (String(b.code || '') !== pairing.code) {
        if (++pairing.tries >= 5) pairing = null;
        note({ ev: 'pair-fail' });
        return send(res, 401, { error: '配对码不对' });
      }
      pairing = null;
      const token = crypto.randomBytes(32).toString('hex');
      const all = loadTokens(); all[sha(token)] = { made: new Date().toISOString(), ua: String(req.headers['user-agent'] || '').slice(0, 120) }; saveTokens(all);
      note({ ev: 'paired' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Set-Cookie': `ks=${token}; Path=/api/agent; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` });
      return res.end(JSON.stringify({ ok: true }));
    }
    // 信令门的钥匙：拿配对码换（聊天应用里的直播卡、直接打开的网页版头一回用）。跟操控台共用一个码，用掉就没了
    if (u.pathname === '/api/agent/doorpair' && req.method === 'POST') {
      const b = await readJson(req);
      if (!pairing || Date.now() > pairing.until) return send(res, 410, { error: '配对码过期了，去进过门的设备点「新设备的码」再拿一个' });
      if (String(b.code || '') !== pairing.code) {
        if (++pairing.tries >= 5) pairing = null;
        note({ ev: 'door-pair-fail' });
        return send(res, 401, { error: '配对码不对' });
      }
      pairing = null;
      const k = doorKey();
      if (!k) return send(res, 503, { error: '门上还没有钥匙' });
      note({ ev: 'door-paired', ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      return send(res, 200, { k });
    }
    // 远程 AI 的手：只认 VPS 上连接器带来的 g；外面来的 Caddy 已经挡了，这里再挡一回
    const relayOk = () => { const g = relayKey(), got = String(req.headers['x-kael-relay'] || ''); return !!g && got.length === g.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(g)); };
    // 授权页那一下：人在聊天应用弹的授权页输「新设备的码」，连接器拿来这儿核（跟 doorpair 同一个码，用掉就没了）
    if (u.pathname === '/api/agent/remotepair' && req.method === 'POST') {
      if (!relayOk()) { note({ ev: 'remote-refused' }); return send(res, 403, { ok: false }); }
      const b = await readJson(req);
      if (!pairing || Date.now() > pairing.until) return send(res, 410, { ok: false, error: '配对码过期了，去进过门的设备点「新设备的码」再拿一个' });
      if (String(b.code || '') !== pairing.code) {
        if (++pairing.tries >= 5) pairing = null;
        note({ ev: 'remote-pair-fail' });
        return send(res, 401, { ok: false, error: '配对码不对' });
      }
      pairing = null;
      note({ ev: 'remote-paired', client: String(b.client || '').slice(0, 80) });
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/agent/remote' && req.method === 'POST') {
      if (!relayOk()) { note({ ev: 'remote-refused' }); return send(res, 403, { ok: false, error: 'no' }); }
      const b = await readJson(req);
      if (remoteBusy) return send(res, 429, { ok: false, error: 'The previous action is still running.' });
      remoteBusy = true;
      try { return send(res, 200, await remoteDo(String(b.tool || ''), b.args || {})); }
      catch (e) { note({ ev: 'remote-error', tool: b.tool, msg: e.message }); return send(res, [400, 409].includes(e.code) ? e.code : 500, { ok: false, error: e.message }); }
      finally { remoteBusy = false; }
    }
    // 住在 VPS 上的 Agent 的手（desk 那扇门），细的在 desk() 上面
    const dm = /^\/api\/agent\/desk\/(shot|act|say|done|idle|browser)$/.exec(u.pathname);
    if (dm) return await desk(dm[1], req, u, res);
    // 配过的设备给新设备发码。
    // 手上有门钥匙的（聊天页、操控台里那扇框）来要，发一个跟 /agent/paircode 一样的码（十分钟、一次、错五回作废，新的顶掉旧的）
    if (u.pathname === '/api/agent/newcode' && req.method === 'POST') {
      const b = await readJson(req), k = doorKey(), got = String(b.k || '');
      if (!k || got.length !== k.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(k))) { note({ ev: 'newcode-refused' }); return send(res, 403, { error: '钥匙不对' }); }
      pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), until: Date.now() + 10 * 60 * 1000, tries: 0 };
      note({ ev: 'newcode', ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      return send(res, 200, { code: pairing.code, validMinutes: 10 });
    }
    if (u.pathname === '/api/agent/card-control') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
      try {
        const state = await cardControl(await readJson(req));
        return send(res, state.pending ? 202 : 200, state);
      } catch (e) {
        const code = [400, 403].includes(e.code) ? e.code : e instanceof SyntaxError ? 400 : 503;
        return send(res, code, { error: code === 503 ? '家里暂时没回音' : e.message });
      }
    }
    if (!authed(req)) return send(res, 401, { error: '没配对', needPair: true });
    // 操控台配对过的，同站直接换信令门的钥匙
    if (u.pathname === '/api/agent/door') {
      const k = doorKey();
      return k ? send(res, 200, { k }) : send(res, 503, { error: '门上还没有钥匙' });
    }
    if (u.pathname === '/api/agent/state') {
      return send(res, 200, { status: agentStatus(), caption: agent.caption, captionAt: agent.captionAt, lastActAt: agent.lastActAt,
        hold: agent.hold, steps: steps.length, lastStep: steps.length ? steps[steps.length - 1].id : null, now: Date.now() });
    }
    if (u.pathname === '/api/agent/steps') {
      const since = Number(u.searchParams.get('since') || 0);
      return send(res, 200, { steps: steps.filter(s => s.id > since).slice(-60) });
    }
    const m = /^\/api\/agent\/thumb\/(\d+)(s?)\.jpg$/.exec(u.pathname);
    if (m) {
      const f = path.join(STEPS_DIR, m[1] + m[2] + '.jpg');
      if (!fs.existsSync(f)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    if (u.pathname === '/api/agent/hold' && req.method === 'POST') {
      const b = await readJson(req);
      const state = await setHold(b.on, 'console');
      return send(res, state.pending ? 202 : 200, state);
    }
    res.writeHead(404).end();
  } catch (e) {
    note({ ev: 'public-error', url: req.url, msg: e.message });
    send(res, 500, { error: 'oops' });
  }
});

startHand();
startOverlay();
publicServer.listen(PUBLIC_PORT, '127.0.0.1', () => note({ ev: 'listen-public', port: PUBLIC_PORT }));
server.listen(PORT, '127.0.0.1', () => note({ ev: 'listen', port: PORT, pid: process.pid }));
