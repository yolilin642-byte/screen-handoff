# 第 6 章 · 本地 Agent 用它

> 适合：Claude Code、Codex 这类**跑在被控的这台电脑上**的 AI。
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

屏幕底下出一行「还给我了，我接着来」＝放开了。以后在手机上按「我来」／「还给你」就行（操控台网页、你的聊天页、ChatGPT 卡上都有那颗按钮）。

> **这道闸拦的是小程序和 OpenCLI，拦不住一个存心绕路的本机程序。** 上面这条放开的命令，本机上谁都能敲，AI 也敲得到；动手的接口还有一个 `force` 参数，带上就不管你是不是刚碰过鼠标（「我来」按着时照样拦）。说明书里写了这两样都不许，靠的是它守规矩。所以交给它的权限，按「它是你电脑上的一个用户」来想。

## 5. 试一下

跟 AI 说：

- 「看一眼我的屏幕」：它调 `GET /agent/shot`，读那张图，告诉你屏幕上有什么。
- 「去 example.com 看看标题是什么」：它用 OpenCLI 开一扇自己的 Chrome 窗，读完告诉你，屏幕底下的字幕跟着它一步步走。
- 它干着的时候，你动一下鼠标：四秒之内它的每一下都不做、被退回来，字幕换成锈色的「你在用，我等着」。

## 6. 在哪儿看它干活

- 手机上开操控台网页 `https://<你的域名>/console/`（配过对的设备）：看直播、看它这一趟做了哪几步、按「我来」。（操控台还带着我们家的样子，待整理。）
- 你自己的聊天页：第 4 章最后一节，把小屏嵌进去。
- 只想看画面：CrossDesk 的 App 或网页版直接连。

---

Mac 上：`oc.ps1` 是 PowerShell 写的，mac 上要装 PowerShell 才能用，或者另写一份。**还没写。**
