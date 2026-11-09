# 第 2 章 · 电脑上装 CrossDesk 主机端

> 这一章做完：你的电脑连上第 1 章那台信令，`https://<你的域名>/stats` 里 `online_device_count` 变成 1；CrossDesk 窗口上有一个设备号、一个密码，开机自己起来。
> 我们家用的是 Windows 11 上的**免安装版** v1.7.4。安装版没试过。

[CrossDesk](https://github.com/kunkundi/crossdesk)（LGPL-3.0）是一个开源的远程桌面：电脑这头把屏幕推出去、收远程的鼠标键盘，手机那头用 App 或网页看、点。这一整套的画面全靠它，我们一行没改，只改它的设置文件。

---

## 1. 下载，先别打开

去 [CrossDesk 的 Releases](https://github.com/kunkundi/crossdesk/releases) 下 Windows 免安装版（文件名像 `crossdesk-win-x64-portable-v1.7.4-….zip`），解压到一个你不会随手删的地方，比如 `D:\crossdesk\app\`。

**解压完先别双击。** 它头一回起来，没配过自建服务器的话，会直接去连 CrossDesk 官方的公共服务器。想全程只走自己的，就先把设置写好再开。（你本来就打算用公共信令的话，见 README「先认一认你家」第 3 种，这一步不用管。）

要 **v1.7.4 或更新**：第 3 章的门牌要靠它认「域名/路径」这种地址。

## 2. 先写设置

在解压出来的目录里建 `data\config.ini`（`data` 文件夹没有就建一个），写：

```ini
[Settings]
enable_self_hosted = true
signal_server_host = <你的域名>
signal_server_port = 443
lock_on_disconnect = false
enable_privacy_screen = false
```

| 这一格 | 为什么 |
|---|---|
| `enable_self_hosted`、`signal_server_host`、`signal_server_port` | 连你自己的信令。端口写 443：走的是 Caddy，不是信令自己的 9099 |
| `lock_on_disconnect = false` | 默认是远程一断开就锁屏。AI 干活时你会一会儿连、一会儿断，一锁它就什么都看不见了 |
| `enable_privacy_screen = false` | 隐私屏会在有人远程连着时把电脑本机的屏幕盖黑。我们家关着：坐在电脑前的人也该看得见 AI 在干嘛。开着的时候 AI 截图会拍到什么，没试过 |

第 3 章挂门以后，`signal_server_host` 会改成 `<你的域名>/h/<门牌>`。想一步到位，也可以先把第 3 章做完再回来，这里直接填带门牌的那条。

## 3. 打开它

双击 `CrossDesk.exe`。头一回会弹两样：

- **要不要装 CrossDesk Service**：要管理员。它管的是锁屏和 UAC 弹窗那一层（不装的话，锁屏以后、弹出要管理员的框时，远程看不见也点不了）。我们家**没装**，点了取消。想要的话以后再装。
- **Windows 防火墙问要不要放它上网**：允许。

窗口上会显示：

- **设备号**：一串九位数。记下来，第 4 章 `site.json` 的 `deviceId` 要填它。设备号存在它自己的缓存里，以后改服务器地址也不会变。
- **密码**：连进来要输的那个，最多六位。窗口里能看、能改。**别写进任何文档**，要用就去窗口里看。

## 4. 验

浏览器打开 `https://<你的域名>/stats`：

```json
{"online_device_count":1, "online_pc_client_count":1, ...}
```

`online_device_count` 是 1＝你的电脑连上信令了。还是 0 的话：

- 看 `logs\crossdesk.log` 里连的是哪个地址。写的是官方的地址，说明设置没读到（`data\config.ini` 的位置、`[Settings]` 那行）。
- 电脑开着代理或 VPN：把 `CrossDesk.exe` 排除在外面。我们家开着 Mullvad，在它的分流里排除了。代理绕一圈，画面多半打不通直连。

## 5. 开机自启

CrossDesk 里：菜单 → 设置 → 常规 → 启动与后台，打开开机自启。它会写进 Windows 的「启动」项（`HKCU\...\Run`），Windows 可能还会弹一句「CrossDesk Portable 试图开机启动」，允许。

> **在设置页里点保存之前，先看一眼「自托管」那个开关。** 我们家那回，`config.ini` 里明明是 `true`、实际连的也是自己的服务器，设置页上那个开关却显示关着。照原样保存，怕它把服务器换回公共的；我们先把开关拨开再存的。存完回 `config.ini` 看一眼，`enable_self_hosted` 还是 `true` 就对了。

保存后 `config.ini` 会多出一串别的设置（`enable_autostart = true`、`enable_turn` 之类的默认值），不用管。

## 6. 手机上的 CrossDesk App（可选）

只想在手机上看画面、不嵌进任何聊天的话，CrossDesk 的安卓 App 也能连：设置 → 服务器 → 使用自定义服务器，地址填 `<你的域名>`、端口 `443`。

- **那个开关不打开就去连，连的是官方公共服务器**，会报「访问密码错误」。我们家在这儿栽过一回。
- 第 3 章挂门以后，App 的地址也得改成带 `/h/<门牌>` 的。这条我们没在 App 上试过，我们平时都从网页进。

---

下一章：第 3 章 · 门。在那之前，信令对整个网开着，只有 CrossDesk 的密码一把锁，别停太久。
