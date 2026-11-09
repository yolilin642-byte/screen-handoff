# 第 6 章 · 本地 Agent 用它

> 适合：**跑在被控的这台电脑上**、能执行命令的 AI，哪家都行（Claude Code、Codex、Cursor、Gemini CLI……）。
> 这一章做完：你跟它说「看一眼我的屏幕」，它截一张图来看；让它去网页上办件事，它在你的 Chrome 里点，屏幕底下一行字幕写着它在干嘛；你一按「我来」，它就停手。

它有两只手：

| 手 | 怎么动 | 什么时候用 |
|---|---|---|
| 屏幕那只手 | 第 5 章的小程序，`127.0.0.1:5260` | 网页以外的软件、网页走不通的时候、你想看着它干 |
| OpenCLI | 驱动你已经登录着的 Chrome | 上网：读页面、点、填，不碰你的鼠标 |

挑哪只手、怎么用、什么不做，都写在仓库的说明书 `skill/computer-hands/SKILL.md` 里，交给 AI 读。

---

## 1. 装 OpenCLI

[OpenCLI](https://github.com/jackwener/opencli)（Apache-2.0）是一个命令行工具，配一个 Chrome 扩展，让程序能借你已经登录着的 Chrome 上网。

```bash
npm install -g @jackwener/opencli@2.0.2
```

**先锁在 2.0.2**：下一步那处改动是照这一版做的，别的版本对不上。它会一直提示有新版，先别升。

Chrome 扩展、守护进程怎么装怎么起，照 OpenCLI 自己的说明走。装好以后：

```bash
opencli list
```

能列出它认识的网站＝装好了。

## 2. 给 OpenCLI 补上「我来」那道闸

屏幕那只手被「我来」拦着，可 OpenCLI 是另一条路，原版不经过小程序，你按了「我来」它照样点。我们改了 OpenCLI 的三个文件：每一条要在前台碰你屏幕的命令，发出去之前先问小程序一声，按着就不做；问不到也不做。

改过的三个文件和一份补丁在 `tools/opencli-2.0.2-guard/`（那里的 README 写了每个文件改了什么），拷进 OpenCLI 的安装目录（Windows 上在 `%APPDATA%\npm\node_modules\@jackwener\opencli\dist\src\`），然后重起 OpenCLI 的守护进程。

验：

```powershell
Invoke-RestMethod http://127.0.0.1:19825/kael-guard -Headers @{ 'X-OpenCLI' = '1' }
```

回 `guard: 1`＝闸装上了。**OpenCLI 一升级，这三个文件就被冲掉**，闸也跟着没了；小程序会发现（`guardReady` 变成 false），这时它不会说「你接手了」，Windows 上的 `oc.ps1` 也会拒绝动。

**后台窗不过闸**：带 `--window background` 的命令开的是另一扇不在你眼前的窗，闸不问它，好让 AI 在后台读网页时不被你打断。可后台窗里一样登着你的号，「我来」拦不住它在那儿点「发送」。说明书里写了后台窗只读不点，靠的还是它守规矩。

## 3. 把说明书交给 AI

- **Claude Code**：把 `skill/computer-hands/` 整个拷进 `~/.claude/skills/`。它要动你电脑之前会自己读。
- **别的 Agent**：把 `SKILL.md` 的正文贴进它的长期说明里（Codex 是 `AGENTS.md`）。

说明书里的路径，比如 `<小程序目录>`，换成你自己的。

## 4. 放开「我来」

小程序第一次起来时，「我来」是按着的，AI 什么都动不了。你自己放开一次：

```powershell
Invoke-RestMethod http://127.0.0.1:5260/agent/hold -Method Post -ContentType 'application/json' -Body '{"on":false}'
```

屏幕底下出一行「还给我了，我接着来」＝放开了。以后在手机上按「我来」／「还给你」就行（操控台网页、你的聊天页、聊天应用的直播卡上都有那颗按钮）。

> **这道闸拦的是小程序和 OpenCLI，拦不住一个存心绕路的本机程序。** 上面这条放开的命令，本机上谁都能敲，AI 也敲得到；动手的接口还有一个 `force` 参数，带上就不管你是不是刚碰过鼠标（「我来」按着时照样拦）。说明书里写了这两样都不许，靠的是它守规矩。所以交给它的权限，按「它是你电脑上的一个用户」来想。

## 5. 试一下

跟 AI 说：

- 「看一眼我的屏幕」：它调 `GET /agent/shot`，读那张图，告诉你屏幕上有什么。
- 「去 example.com 看看标题是什么」：它用 OpenCLI 开一扇自己的 Chrome 窗，读完告诉你，屏幕底下的字幕跟着它一步步走。
- 它干着的时候，你动一下鼠标：四秒之内它的每一下都不做、被退回来，字幕换成锈色的「你在用，我等着」。

## 6. 在哪儿看它干活

- 手机上开操控台网页 `https://<你的域名>/console/`（配过对的设备）：看直播、看它这一趟做了哪几步、按「我来」。（操控台的样子是照我们家配的，想换自己改 `web/console/index.html`。）
- 你自己的聊天页：第 4 章最后一节，把小屏嵌进去。
- 只想看画面：CrossDesk 的 App 或网页版直接连。

## 7. AI 住在 VPS 上

> 适合：AI 跑在 VPS 上（Claude Code、Codex、自己写的 Agent……），要动的是家里这台电脑。

它够不着电脑上的 `127.0.0.1:5260`，可它跟隧道的另一头在同一台 VPS 上：VPS 本机的 `39260` 就是电脑上小程序的 `5261`（第 5 章）。小程序在那头留了一扇 **desk 门**，给的跟屏幕那只手是同一套：截图、点、滚、按键、打字、字幕，外加网页那十样。

**这扇门默认关着。** 要开：

1. 生成一把桌面钥匙，写进电脑上 `deploy/door.json` 的 `d`：

   ```bash
   openssl rand -hex 16
   ```

   不到 16 位字母数字的不算数，照抄例子文件里那句尖括号说明也不算，门照样关着。小程序每一下都现读这个文件，不用重起。
2. VPS 上把同一把钥匙存成只有 Agent 读得到的文件，比如 `~/.desk.key`，`chmod 600`。
3. Caddy 上把 `/api/agent/desk*` 挡在外面（第 5 章那段已经写了）。小程序自己也只认从 VPS 本机进来的请求，经域名来的就算漏过了 Caddy，也是 403。

在 VPS 上这么用（`K=$(cat ~/.desk.key)`，POST 都要带 `-H 'Content-Type: application/json'`）：

| | 怎么敲 | 回什么 |
|---|---|---|
| 看屏幕 | `curl -s -H "X-Desk-Key: $K" -D - -o shot.jpg 'http://127.0.0.1:39260/api/agent/desk/shot?w=1280'` | 一张 jpg。头里有 `X-Scale`（图上的坐标乘它＝屏幕坐标）、`X-Width`、`X-Height`、`X-Cursor` |
| 动手 | `POST /api/agent/desk/act`，跟本机 `/agent/act` 一样：`{"t":"click","x":640,"y":400,"scale":2,"say":"点开始菜单"}`，`t` 有 click／scroll／key／text／move | `{"ok":true}` |
| 换字幕 | `POST /api/agent/desk/say`：`{"s":"在干嘛"}` | |
| 收尾 | `POST /api/agent/desk/done`：`{"s":"做成了什么"}` | |
| 人在不在 | `GET /api/agent/desk/idle` | 离人上次碰鼠标键盘多久、「我来」按没按着 |
| 网页 | `POST /api/agent/desk/browser`：`{"tool":"open","args":{"url":"https://example.com"}}`。tool 有 look、open（url）、state、extract、click（target）、type（target、text）、keys（key）、scroll（direction：up／down）、back、close，跟第 7 章那十样是同一套 | 跟连接器回的一样 |

被挡回来的样子：

- **409**，带 `waitForHuman: true`：你按着「我来」，或者四秒内碰过鼠标键盘。让它等，别一直重试。
- **403**：钥匙不对，或者是从域名进来的。
- **404**：门关着（`d` 没填，或者不算数）。

跟本机那只手比，这条路更硬：

- 没有 `force`，带了也会被扔掉。你一碰，它就停。
- 「我来」按着的时候，连截图也不给。
- 它手里没有放开「我来」的口子：本机那条 `/agent/hold` 不经隧道。只能你在手机上按「还给你」。
- 截图直接回给它，不在电脑上落文件。它看得见屏幕，看不见你电脑上的文件，除非你把文件开在屏幕上。

> **拿到 `d` 的，能点你整块屏幕。** 它跟连接器钥匙 `g` 一样，只该待在 VPS 上；VPS 被人登进去，这把钥匙也就丢了。不用了就把 `d` 那行删掉，门当场关上。

看它干活还是第 6 节那几处，最顺手的是操控台网页。

我们自己没有住在 VPS 上的 AI。这扇门是照着这一章写的，在电脑上起了一份测试副本试过：没钥匙、钥匙不对、从域名进来，都被挡回去；截图、挪鼠标能通；按着「我来」时截图、动手都被挡。**真从 VPS 经隧道敲过来，还没试过。**

---

Mac 上：`oc.ps1` 是 PowerShell 写的，mac 上要装 PowerShell 才能用，或者另写一份。**还没写。**
