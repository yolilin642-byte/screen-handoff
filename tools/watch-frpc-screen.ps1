# 隧道的看门任务（第 5 章）：frpc 把电脑上的 5261 接到 VPS 上，它断了，操控台、「新设备的码」、远程 AI 的工具、卡上的「我来」全都跟着断。
# 每次跑：从外面敲一下 https://<你的域名>/api/agent/card-control，家里回 405「POST required」＝隧道和家都通，什么都不做。
# 连着两回敲不开、而电脑上的 5261 自己活着，才杀了 frpc 重起（5261 倒了，换隧道没用，只记一笔）。frpc 没在跑就直接起。
# 起之前清掉代理变量：frpc 继承了代理，代理一关它就连不上（我们家断过一整天）。只在动手时写账。
#
# 装成计划任务（登录时跑一次、之后每 5 分钟一次，不弹窗）：
#   $a = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -WindowStyle Hidden -File "<仓库目录>\tools\watch-frpc-screen.ps1" -Frpc "<frpc 目录>\frpc-screen.exe"'
#   $t1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
#   $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
#   $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
#   Register-ScheduledTask -TaskName 'screen-frpc-watch' -Action $a -Trigger $t1,$t2 -Settings $s
# pwsh 那一闪的窗口还嫌烦的话，套一层 wscript 跑的 .vbs（我们家是这么做的）。
#
# 先试一下它会怎么做、但什么都不动：加 -DryRun
param(
  [Parameter(Mandatory)] [string]$Frpc,          # frpc 程序，比如 C:\frp\frpc-screen.exe
  [string]$Config = '',                          # frpc 的配置；不给就用 frpc 旁边同名的 .toml
  [string]$Site = (Join-Path $PSScriptRoot '..\deploy\site.json'),
  [string]$Log = '',                             # 不给就写在 frpc 旁边：<名字>-watch.log
  [switch]$DryRun
)
$ErrorActionPreference = 'Continue'
$name = [IO.Path]::GetFileNameWithoutExtension($Frpc)
$dir = Split-Path $Frpc -Parent
if (-not $Config) { $Config = Join-Path $dir ($name + '.toml') }
if (-not $Log) { $Log = Join-Path $dir ($name + '-watch.log') }
$domain = (Get-Content $Site -Raw | ConvertFrom-Json).domain
if (-not $domain) { throw "$Site 里没有 domain" }
function Note([string]$m) {
  if ($DryRun) { "[dry-run] $m"; return }
  Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8
}

function Through {
  try {
    $r = Invoke-WebRequest "https://$domain/api/agent/card-control" -TimeoutSec 20 -SkipHttpErrorCheck
    return ($r.StatusCode -eq 405 -and "$($r.Content)" -match 'POST required')
  } catch { return $false }
}
function HomeUp {
  try {
    $r = Invoke-WebRequest 'http://127.0.0.1:5261/api/agent/card-control' -TimeoutSec 5 -SkipHttpErrorCheck -NoProxy
    return ($r.StatusCode -eq 405)
  } catch { return $false }
}

$p = Get-Process $name -ErrorAction SilentlyContinue
if ($p) {
  if (Through) { if ($DryRun) { "[dry-run] $name 在跑，外面敲得通：什么都不做" }; exit 0 }
  Start-Sleep -Seconds 15
  if (Through) { if ($DryRun) { "[dry-run] 第二回敲通了：什么都不做" }; exit 0 }
  if (-not (HomeUp)) { Note "outside blocked, but 5261 itself is down -> $name left alone"; exit 0 }
  Note "$name alive (pid $($p.Id -join ',')) but outside blocked twice -> restart"
  if ($DryRun) { exit 0 }
  $p | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
} else {
  Note "$name not running -> start"
  if ($DryRun) { exit 0 }
}

foreach ($v in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy') {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue
}
Start-Process -FilePath $Frpc -ArgumentList '-c', "`"$Config`"" -WorkingDirectory $dir -WindowStyle Hidden
Start-Sleep -Seconds 6
$n = Get-Process $name -ErrorAction SilentlyContinue
if (-not $n) { Note "started but no process"; exit 1 }
if (Through) { Note "back: pid $($n.Id -join ','), outside ok" } else { Note "pid $($n.Id -join ',') running, outside not ok yet" }
