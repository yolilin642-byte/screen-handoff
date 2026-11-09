# 改了 CrossDesk 网页客户端的哪些地方

上游：[kunkundi/crossdesk-web-client](https://github.com/kunkundi/crossdesk-web-client)，LGPL-3.0。我们照的是 `e00b64f`（2026-10-29，"[fix] clarify clipboard availability for legacy clients"）。

这个目录（`web/`）整个按 **LGPL-3.0** 发布，包括我们加的两个脚本。上游的 `LICENSE` 原样留着。

## 上游文件：只改了 `index.html`

别的上游文件一个字节都没动，`build.mjs` 原样拷过去。`index.html` 也不手改，由 `build.mjs` 照 `deploy/site.json` 生成，改了三处：

1. 上游自己的网址 `https://web.crossdesk.cn/` 换成你的域名（canonical、og、结构化数据那几处），不然搜索引擎和分享卡片会指回官方站。
2. 在 `control.js` 前面插一段 `window.CROSSDESK_CONFIG`：信令地址、STUN，另带一格 `kael`（认哪些外层，给下面两个脚本用）。这是上游 `docs/DEPLOYMENT.md` 里说的覆盖配置的写法。信令选 `self` 时，同一处再挂上 `kael_door.js`。
3. 在 `session_controls.js` 后面挂上 `kael_embed.js`。

两个脚本地址上的 `?v=` 取的是文件内容的哈希，脚本改了，版本号自己跟着换。

没带过去的上游文件：`README*`、`docs/`、`tests/`、`scripts/`、`CNAME`、`sitemap.xml`、`.gitignore`。它们不是网页运行要用的，看上游仓库就行。

## 加的：`kael_door.js`

信令门上的钥匙（第 3 章）。

- 钥匙从哪来：地址里 `#k=`（记下后从地址栏抹掉）→ 这台设备记着的 → 配过对的操控台换来的 → 都没有，就在密码格那个位置摆一格「配对码」，拿码去家里换。
- 连信令时把钥匙接到 `wss://…/?k=` 上；先问一声 `/door` 钥匙还对不对，不对就丢掉重配。
- 信令选 `public` 时不挂它。

## 加的：`kael_embed.js`

让这页能嵌进别的页面（你的聊天页、ChatGPT 的直播卡）里用。不改上游的代码，只在旁边听、在旁边调。

- **跟外层说话**：往外报 `kaelLive`（连接中、要密码、直播中、断了、卡不卡），收外层的 `kaelControl`（断开、「我来」）。只认 `CROSSDESK_CONFIG.kael` 里列着的外层。协议写在第 4 章。
- **自动连**：设备号由外层给，密码只在要的时候问（ChatGPT 卡里每回都问、不记）。
- **藏掉不用的**：嵌着的时候，密码屏上的大字水印、白纱、logo、设备号那格藏起来；小图模式只留画面，不接手指、静音。这些都是脚本插进去的 CSS，上游的 `styles.css` 没动。
- **画面设置**：连上以后调上游自己的 `CrossDeskSession.requestVideoSettings`，换成帧率优先（上游默认画质优先，网一紧就掉帧）。
- **直播卡**：半小时没碰、切出去一分钟、按「断开」就断，断了清空密码格。
