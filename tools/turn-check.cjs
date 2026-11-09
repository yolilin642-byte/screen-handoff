// 从外面验中继（第 8 章第 6 步）：先 STUN（UDP），再拿共享密钥真要一个 TURN 分配，看中继给不给口。
// 用法：TURN_HOST=<中继的公网 IP> KT_SECRET=<共享密钥> node tools/turn-check.cjs
//   PowerShell：$env:TURN_HOST='…'; $env:KT_SECRET='…'; node tools/turn-check.cjs
// 不打印密钥。UDP 会丢包，偶尔一回没回话不算坏，多跑几回。
const dgram = require('dgram'), crypto = require('crypto');
const HOST = process.env.TURN_HOST, PORT = Number(process.env.TURN_PORT || 3478);
const secret = process.env.KT_SECRET;
if (!HOST || !secret) { console.error('要 TURN_HOST 和 KT_SECRET 两个环境变量'); process.exit(2); }const user = String(Math.floor(Date.now() / 1000) + 600) + ':turn-check';
const pass = crypto.createHmac('sha1', secret).update(user).digest('base64');

function attr(type, val) {
  const pad = (4 - val.length % 4) % 4, h = Buffer.alloc(4);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(val.length, 2);
  return Buffer.concat([h, val, Buffer.alloc(pad)]);
}
function header(type, len, tid) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(len, 2); h.writeUInt32BE(0x2112A442, 4); tid.copy(h, 8);
  return h;
}
function msg(type, attrs, key) {
  const tid = crypto.randomBytes(12);
  let body = Buffer.concat(attrs);
  if (key) {
    const mi = crypto.createHmac('sha1', key).update(Buffer.concat([header(type, body.length + 24, tid), body])).digest();
    body = Buffer.concat([body, attr(0x0008, mi)]);
  }
  return Buffer.concat([header(type, body.length, tid), body]);
}
function parse(m) {
  const attrs = {}; let off = 20;
  while (off + 4 <= m.length) {
    const t = m.readUInt16BE(off), l = m.readUInt16BE(off + 2);
    attrs[t] = m.subarray(off + 4, off + 4 + l);
    off += 4 + l + ((4 - l % 4) % 4);
  }
  return { type: m.readUInt16BE(0), attrs };
}

const stun = dgram.createSocket('udp4');
stun.on('message', m => { console.log('udp stun reply type', m.readUInt16BE(0).toString(16)); stun.close(); });
stun.send(msg(0x0001, []), PORT, HOST);
setTimeout(() => { try { stun.close(); console.log('udp stun: no reply'); } catch {} }, 4000);

const s = dgram.createSocket('udp4');
const transport = attr(0x0019, Buffer.from([17, 0, 0, 0]));
let asked = false;
s.on('message', m => {
  const { type, attrs } = parse(m);
  console.log('turn got', type.toString(16));
  if (type === 0x0113 && !asked) {
    asked = true;
    const realm = attrs[0x0014], nonce = attrs[0x0015];
    const key = crypto.createHash('md5').update(user + ':' + realm.toString() + ':' + pass).digest();
    s.send(msg(0x0003, [transport, attr(0x0006, Buffer.from(user)), attr(0x0014, realm), attr(0x0015, nonce)], key), PORT, HOST);
    return;
  }
  if (type === 0x0103) {
    const x = attrs[0x0016];
    const port = x.readUInt16BE(2) ^ 0x2112;
    const ip = [0, 1, 2, 3].map(i => x[4 + i] ^ [0x21, 0x12, 0xA4, 0x42][i]).join('.');
    console.log('TURN allocate OK, relay', ip + ':' + port);
    s.close(); return;
  }
  console.log('TURN reply type', type.toString(16), attrs[0x0009] ? 'err ' + attrs[0x0009].subarray(4).toString() : '');
  s.close();
});
s.send(msg(0x0003, [transport]), PORT, HOST);
setTimeout(() => { try { s.close(); console.log('TURN: no final reply'); } catch {} }, 9000);

