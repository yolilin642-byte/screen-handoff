# 第 1 章 · VPS：信令、Caddy、证书

> 这一章做完：手机打开 `https://<你的域名>/stats` 能看到一串数字，说明信令活着、证书对了。
> 我们家是这么走通的：甲骨文东京的免费机（1 核、1G 内存），Ubuntu 24.04，Caddy 2.6.2（Ubuntu 自带的那版），CrossDesk 信令 v1.1.38。信令常驻大约 17MB 内存，小机器够用。

信令是干嘛的：手机和电脑互相不认识，信令替它们牵个线，告诉对方「我在这儿」。牵完线，画面就由手机和电脑直接传，不再经过它，所以它吃不了多少流量。

为什么非要域名和证书：网页客户端是 https 打开的，浏览器不许 https 页面去连不加密的 `ws://`，只许连带证书的 `wss://`。聊天应用里的卡也一样。证书最省事的拿法是：有个域名，让 Caddy 自己去签。

---

## 要准备的

- 一台 VPS：Ubuntu 22.04 或 24.04，有公网 IP，能用 SSH 登进去。**国内的机器：没备案的域名，443 端口会被掐**，信令请放国外。
- 一个域名，能加 DNS 记录。下文写作 `<你的域名>`，比如 `screen.example.com`。

---

## 1. DNS：让域名指向 VPS

在你买域名的地方（或者 Cloudflare）加一条记录：

| 类型 | 名字 | 值 |
|---|---|---|
| A | `screen`（或者你想用的前缀） | VPS 的公网 IP |

用 Cloudflare 的话，那朵云点成**灰的**（只做 DNS，不代理）。我们家是灰云；橙云代理能不能用，没测过。

等几分钟，在电脑上 `ping <你的域名>`，回来的 IP 是 VPS 的就对了。

## 2. 防火墙：只开 22、80、443

**这一步不能省。** 信令自己在 9099 口上听着，那个口要是对外开着，别人就能绕过第 3 章挂的门，直接去敲信令。

VPS 上只放这三个口进来：

- 22：SSH
- 80：Caddy 签证书要用
- 443：网页和信令都从这儿进

（第 5 章接隧道时还要再开一个 7000，到时候再加。）

用 ufw 的：

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

云厂商的控制台通常还有一层「安全组／安全列表」，那边也只放这三个口。甲骨文的机器两层都有：控制台的安全列表，加上机器里自带的 iptables 规则。

做完以后，从**另一台机器**上试一下 9099 是不是真进不来（第 3 步起了信令以后再试）：

```bash
nc -vz -w 5 <VPS 的 IP> 9099     # 应该连不上
```

## 3. 装 CrossDesk 信令

去 [crossdesk-server 的 Releases](https://github.com/kunkundi/crossdesk-server/releases) 下 Linux x64 那个文件，放到 `/opt/crossdesk/crossdesk_server`：

```bash
sudo mkdir -p /opt/crossdesk
# 把下载下来的文件传上去，改名成 crossdesk_server，然后：
sudo chmod +x /opt/crossdesk/crossdesk_server
```

写一份 systemd 服务，让它开机自己起、挂了自己拉起来：

```bash
sudo nano /etc/systemd/system/crossdesk.service
```

```ini
[Unit]
Description=CrossDesk signaling
After=network-online.target

[Service]
ExecStart=/opt/crossdesk/crossdesk_server 9099
Restart=always
RestartSec=3
MemoryMax=300M
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
```

> 要中继（第 8 章）的话，这里还要加几行 `Environment=`，那时候再回来改。**不配中继能不能这样直接起，我们没试过**（我们家是一开始就配了中继），起不来的话看第 9 章怎么查日志。

```bash
sudo chmod 600 /etc/systemd/system/crossdesk.service   # 以后这里会放中继的密钥，别让别人读
sudo systemctl daemon-reload
sudo systemctl enable --now crossdesk
sudo systemctl status crossdesk        # 看到 active (running) 就对了
sudo ss -ltnp | grep 9099              # 看到它在 9099 上听着
```

信令自己用的是一张给 127.0.0.1 的自签证书，所以下一步 Caddy 转给它的时候，要跳过证书检查。

## 4. 装 Caddy，让它签证书、转给信令

```bash
sudo apt update
sudo apt install -y caddy
```

打开 `/etc/caddy/Caddyfile`，在最后加上一段（`<你的域名>` 换成你的）：

```caddy
<你的域名> {
	# 信令（这一章先这样全放进来，第 3 章会在前面挂上门）
	@signal header_regexp Upgrade (?i)websocket
	handle @signal {
		reverse_proxy https://127.0.0.1:9099 {
			transport http {
				tls_insecure_skip_verify
			}
		}
	}
	handle /stats {
		reverse_proxy https://127.0.0.1:9099 {
			transport http {
				tls_insecure_skip_verify
			}
		}
	}
	# 网页客户端放在这里（第 4 章）
	handle {
		root * /var/www/screen
		file_server
	}
}
```

```bash
sudo mkdir -p /var/www/screen
sudo caddy validate --config /etc/caddy/Caddyfile   # 先验一下写得对不对
sudo systemctl reload caddy
```

Caddy 会自己去 Let's Encrypt 签证书，第一次要等十几秒到一分钟。

## 5. 验

手机或电脑浏览器打开：

```
https://<你的域名>/stats
```

- 出来一串数字（在线的设备数之类）＝成了。
- 证书报错：多半是 DNS 还没生效，或者 80 口没开，Caddy 签不下来。`sudo journalctl -u caddy -n 50` 看它说了什么。
- 502：Caddy 好了，信令没起来。`sudo systemctl status crossdesk` 看看。

---

下一章：第 3 章 · 门，给信令挂上钥匙。**在挂门之前，信令对整个网开着，谁知道地址谁就能来连**（还得猜中你电脑的 CrossDesk 密码才看得见画面，但只有这一把锁）。别在这一步停太久。
