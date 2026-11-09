// 从外面敲几种门，看哪扇开（第 3 章第 4 步）。开了就 ping 一下，等它回话。
// 用法：在仓库目录里  node tools/door-check.mjs
// 域名读 deploy/site.json，门牌和钥匙读 deploy/door.json。只打印开没开，不打印钥匙。要 Node 22 以上（自带 WebSocket）。
import fs from 'node:fs';

const read = (f) => JSON.parse(fs.readFileSync(new URL('../deploy/' + f, import.meta.url), 'utf8').replace(/^﻿/, ''));
const site = read('site.json'), door = read('door.json');
if (!site.domain) throw new Error('deploy/site.json 里没有 domain');
if (!door.h || !door.w) throw new Error('deploy/door.json 里要有 h（门牌）和 w（钥匙）');
if (typeof WebSocket !== 'function') throw new Error('这个 Node 没有自带 WebSocket，换 22 以上');

const B = 'wss://' + site.domain;
const cases = [
  ['不带钥匙', B + '/', '关着'],
  ['错的钥匙', B + '/?k=0123456789abcdef0123456789abcdef', '关着'],
  ['网页钥匙', B + '/?k=' + door.w, '开了'],
  ['电脑门牌', B + '/h/' + door.h, '开了'],
  ['错的门牌', B + '/h/000000000000000000000000', '关着'],
];
const knock = (url) => new Promise((done) => {
  let ws;
  const end = (r) => { try { ws.close(); } catch {} done(r); };
  const timer = setTimeout(() => end('超时'), 8000);
  try { ws = new WebSocket(url); } catch (e) { clearTimeout(timer); return done('建不起来 ' + e.message); }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
  ws.onmessage = () => { clearTimeout(timer); end('开了'); };
  ws.onerror = () => { clearTimeout(timer); end('关着'); };
});

let bad = 0;
for (const [name, url, want] of cases) {
  const got = await knock(url);
  if (got !== want) bad++;
  console.log((got === want ? 'ok  ' : 'BAD ') + name.padEnd(5, '　') + got + (got === want ? '' : '（应该' + want + '）'));
}
for (const [name, k, want] of [['/door 对的钥匙', door.w, 204], ['/door 错的钥匙', 'nope', 403]]) {
  const r = await fetch('https://' + site.domain + '/door?k=' + encodeURIComponent(k), { cache: 'no-store' }).catch(e => ({ status: 'ERR ' + e.message }));
  if (r.status !== want) bad++;
  console.log((r.status === want ? 'ok  ' : 'BAD ') + name + ' ' + r.status + (r.status === want ? '' : '（应该 ' + want + '）'));
}
console.log(bad ? bad + ' 处不对' : '门都对');
process.exitCode = bad ? 1 : 0;
