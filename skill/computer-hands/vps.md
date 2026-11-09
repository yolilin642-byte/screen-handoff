# 你跑在 VPS 上的话（desk 门）

只给住在 VPS 上的 AI 看。SKILL.md 里的规矩照旧，这里只换「手从哪儿伸过去」。

- 够不着 5260，就在 VPS 本机走同一套：`http://127.0.0.1:39260/api/agent/desk/<shot|act|say|done|idle|browser>`，每一下带头 `X-Desk-Key: <~/.desk.key 里那串>`。不走域名。
- `shot` 直接回 jpg，`scale` 在回头的 `X-Scale` 里；`act`／`say`／`done` 的 JSON 跟 SKILL.md 里屏幕那只手一样。
- 你那边的 OpenCLI（要是装了）开的是 VPS 自己的浏览器，够不着主人的 Chrome。上网用 `POST browser {tool, args}`（open／state／click／type……，跟连接器的 browser_* 一样），先 `state` 读编号再点。
- 409 跟 SKILL.md 里一样：停手等。404＝主人把门关了，别找别的路进来。
