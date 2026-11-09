// 生成放上 VPS 的那份网页（替掉原来手改的 patch_index.mjs）。地址一律从 site.json 来，首页不再手改。
// 上游 CrossDesk 网页客户端（crossdesk-web-client/，LGPL-3.0）只改 index.html 一个文件：
//   ① 上游自己的网址 https://web.crossdesk.cn/ 换成你的域名（canonical、og、结构化数据那几处）
//   ② 在 control.js 前面塞进 window.CROSSDESK_CONFIG（信令地址、STUN，外加 kael.* 给我们两个小脚本用）和 kael_door.js
//   ③ 在 session_controls.js 后面挂上 kael_embed.js
// 其余上游文件原样拷过去；kael_door.js、kael_embed.js 是我们自己的，就放在输出目录里，不经这里改。
// 两个小脚本的 ?v= 取文件内容的哈希，改了它们自己就换，不用再手改版本号。
// 用法：node web/build.mjs [site.json] [输出目录]      默认 ../deploy/site.json、./dist1
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(process.argv[2] || path.join(HERE, '..', 'deploy', 'site.json'));
const OUT = path.resolve(process.argv[3] || path.join(HERE, 'dist1'));
const UP = path.join(HERE, 'crossdesk-web-client');
const SKIP = new Set(['.git', '.gitignore', 'CNAME', 'README.md', 'README_EN.md', 'sitemap.xml', 'scripts', 'tests', 'docs', 'node_modules']);

const site = JSON.parse(fs.readFileSync(SITE, 'utf8'));
if (!site.domain || /[\/:\s]/.test(site.domain)) throw new Error('site.json 的 domain 只写域名，比如 screen.example.com');

// 上游文件原样拷（index.html 下面另算）
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name) || name === 'index.html' && from === UP) continue;
    const a = path.join(from, name), b = path.join(to, name);
    if (fs.statSync(a).isDirectory()) copyTree(a, b);
    else if (!fs.existsSync(b) || !fs.readFileSync(a).equals(fs.readFileSync(b))) fs.copyFileSync(a, b);
  }
}
copyTree(UP, OUT);

const ver = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(OUT, f))).digest('hex').slice(0, 10);
// 我们的两个小脚本住在 web/src/，生成时拷进输出目录
const OWN = path.join(HERE, 'src');
for (const f of site.signal === 'public' ? ['kael_embed.js'] : ['kael_door.js', 'kael_embed.js']) {
  if (path.resolve(OUT) !== path.resolve(OWN)) fs.copyFileSync(path.join(OWN, f), path.join(OUT, f));
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(f + ' 不在 ' + OUT);
}

// site.json 的 signal：
//   "self"（默认）：信令在你自己的 VPS（wss://你的域名），门上挂钥匙，带 kael_door.js
//   "public"：信令用 CrossDesk 官方的公共服务器（上游网页版默认那个），不用 VPS；那边挂不了门，不带 kael_door.js，
//            只剩 CrossDesk 自己的设备号＋密码一把锁。domain 写你放这份网页的地方（比如 xxx.pages.dev）。
const PUBLIC = site.signal === 'public';
if (site.signal && !['self', 'public'].includes(site.signal)) throw new Error('site.json 的 signal 只认 self 或 public');
const config = {
  signalingUrl: PUBLIC ? 'wss://api.crossdesk.cn:9099' : 'wss://' + site.domain,
  iceServers: site.iceServers || (PUBLIC ? [{ urls: ['stun:api.crossdesk.cn:3478'] }] : []),
  kael: { chatOrigins: site.chatOrigins || [], cardOrigins: site.cardOrigins || [] },
};
let html = fs.readFileSync(path.join(UP, 'index.html'), 'utf8');
html = html.split('https://web.crossdesk.cn/').join('https://' + site.domain + '/');

const control = /<script src="control\.js\?v=[^"]*"><\/script>/;
const session = /<script src="session_controls\.js\?v=[^"]*"><\/script>/;
if (!control.test(html) || !session.test(html)) throw new Error('control.js／session_controls.js 那一行找不到了，上游改过 index.html，先对一下再生成');
html = html.replace(control, (m) => `<script>
      // 由 web/build.mjs 照 site.json 生成，别手改
      window.CROSSDESK_CONFIG = ${JSON.stringify(config)};
    </script>${PUBLIC ? '' : `
    <!-- 信令门上的钥匙：赶在 web_client.js 头一回连信令之前接到地址上 -->
    <script src="kael_door.js?v=${ver('kael_door.js')}"></script>`}
    ${m}`);
html = html.replace(session, (m) => `${m}
    <script src="kael_embed.js?v=${ver('kael_embed.js')}"></script>`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('built', OUT, '→', site.domain);
