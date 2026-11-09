# OpenCLI 2.0.2 上的「我来」闸

[OpenCLI](https://github.com/jackwener/opencli)（`@jackwener/opencli`，Apache-2.0）是另一个项目，这里只放我们改过的三个文件和一份补丁。原作者的版权和许可证照旧，改动部分同样按 Apache-2.0。

**只对 2.0.2。** 别的版本文件不一样，别往上套。

## 改了什么

原版 OpenCLI 不认识屏幕小程序：你按了「我来」，它照样在你的 Chrome 里点。补上以后：

- 每一条碰你屏幕的命令（前台窗口的，或者带着这一趟活的），发出去之前先找小程序（`127.0.0.1:5260`）要一张通行证，做完还回去。「我来」按着就要不到，不做；小程序不在也不做。
- 超时、断线这种不知道到底做没做的，报给小程序，小程序停手，等你看过按「还给你」。当时报不上去，就记着，下一条前台命令先补报，补报不上就不动。
- 守护进程多一个 `GET /kael-guard`（要带 `X-OpenCLI: 1` 头），回 `guard: 1`，小程序拿它确认闸在。没有这道闸，小程序不会对你说「你接手了」。

> **后台窗不过闸。** 带 `--window background` 的命令开的是另一扇不在你眼前的窗，这道闸不问它。这是故意的：AI 在后台读网页、查东西，不该被你在屏幕上的手打断。可后台窗里一样登着你的号、一样点得了「发送」，「我来」拦不住它。

| 文件 | |
|---|---|
| `dist/src/daemon.js` | 改：加 `/kael-guard`；碰屏幕的命令放行前要通行证、做完还；结果不确定时报 |
| `dist/src/browser/daemon-transport.js` | 改：命令带上环境变量 `KAEL_SCREEN_TURN`（这一趟活是谁的） |
| `dist/src/kael-screen-guard.js` | 加：跟小程序要、还通行证的那几行 |
| `guard.patch` | 上面三处跟原版 2.0.2 的差别，`git apply` 用 |

## 装

```bash
npm install -g @jackwener/opencli@2.0.2
```

找到它装在哪（Windows 上一般是 `%APPDATA%\npm\node_modules\@jackwener\opencli\`），二选一：

- 把这里的 `dist/` 整个盖进去；
- 或者在那个目录里 `git apply <这里>/guard.patch`。

然后重起 OpenCLI 的守护进程，验：

```powershell
Invoke-RestMethod http://127.0.0.1:19825/kael-guard -Headers @{ 'X-OpenCLI' = '1' }
```

**`npm i -g` 一升级，这三个文件就被冲掉。** OpenCLI 会一直提示有新版，先别升。
