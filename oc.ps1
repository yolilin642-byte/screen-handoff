# 直接跟 OpenCLI 常驻的后台（127.0.0.1:19825）说话，省掉每条 opencli 命令现起 Node 的那一秒半（实测 1650ms → 35ms）。
# 用法：. <仓库目录>\oc.ps1 之后——
#   Open 'https://…'           开页（第一回走 opencli 命令，会话和标签由它建；会话名默认 kael）
#   Go 'https://…'             换页
#   JS 'document.title'        在页里跑一段 JS，回结果
#   Scroll 800                 平滑往下滚（负数往上）
#   TypeIn '[data-testid=…]' '字' 点进那格、打字（走 CDP insertText，React 的框也认）
#   Say '这一步在干嘛' '/ X'    报一句给小屏，第二个参数是窗口标题里的一截（拎到最前面再拍）
#   Done '做成了什么'           收工（先于 Close）
#   Close                      放手
$script:OCSession = 'kael'
$script:ScreenTurn = $env:KAEL_SCREEN_TURN

# OpenCLI 不经过小程序那道 409：人按了「我来」，这只手照样往下翻、还会关窗。
# 所以每一下动手前先问一声按没按住，按住了就整段停下（throw），等人按「还给你」。
function Held { try { $state = Invoke-RestMethod http://127.0.0.1:5260/agent/live -TimeoutSec 3; if ($state.guardReady -ne $true) { throw 'OpenCLI 执行闸尚未就绪' }; $state.hold -eq $true } catch { throw '屏幕控制状态不可确认：停止操作，等连接恢复' } }
function Guard { if (Held) { throw '人接手了：停手，等人按「还给你」' } }

function OC([string]$action, [hashtable]$extra = @{}) {
  Guard
  $b = @{ id = "kael_$([guid]::NewGuid().ToString('N').Substring(0, 10))"; action = $action; session = $script:OCSession; surface = 'browser'; windowMode = 'foreground'; screenTurnId = $script:ScreenTurn } + $extra
  $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:19825/command -Headers @{ 'X-OpenCLI' = '1' } `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($b | ConvertTo-Json -Compress -Depth 6))) -TimeoutSec 30
  if (-not $r.ok) { throw "opencli ${action}: $($r.error)" }
  $r.data
}
function Open([string]$url) { Guard; opencli browser --session $script:OCSession --window foreground open $url 2>&1 | Out-Null }
function Go([string]$url) { OC navigate @{ url = $url } | Out-Null }
function JS([string]$code) { OC exec @{ code = $code } }
function Scroll([int]$px) { JS "window.scrollBy({top:$px,behavior:'smooth'}); 0" | Out-Null }
function TypeIn([string]$css, [string]$text) {
  $sel = $css | ConvertTo-Json
  JS "(()=>{const e=document.querySelector($sel); if(!e) return false; e.focus(); e.click(); if('value' in e){e.select&&e.select();} return true})()" | Out-Null
  OC insert-text @{ text = $text } | Out-Null
}
function Say([string]$s, [string]$front) {
  Guard
  $b = @{ s = $s; turnId = $script:ScreenTurn }; if ($front) { $b.front = $front }
  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5260/agent/say -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes(($b | ConvertTo-Json -Compress))) | Out-Null
}
function Done([string]$s) {
  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5260/agent/done -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes((@{ s = $s } | ConvertTo-Json -Compress))) | Out-Null
}
# 关窗在 Done 之后：不带这一趟的编号，不然取许可那一下又开出一趟空活
function Close { Guard; $t = $env:KAEL_SCREEN_TURN; $env:KAEL_SCREEN_TURN = ''; try { opencli browser --session $script:OCSession close 2>&1 | Out-Null } finally { $env:KAEL_SCREEN_TURN = $t } }
