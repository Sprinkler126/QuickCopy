<#
  简历速取 —— 托盘启动器（Windows / PowerShell 5.1 及以上）

  通常由 start-tray.vbs 双击调用，全程不出现控制台窗口：
    · 挑一个空闲端口
    · 用隐藏窗口启动 node server.js（输出写进 logs\）
    · 在系统托盘放一个图标：左键打开页面，右键出菜单
    · 退出时一并结束 node（node 也会在托盘消失后自行退出，不留僵尸进程）

  手动调试也可以：powershell -ExecutionPolicy Bypass -File tray.ps1
#>

param(
  [int]$Port = 5178,
  # 默认配置文件（透传给 node 的 --data）；留空表示用 server.js 默认的 data\resume.json
  # 注意：这里不能叫 $DataFile —— PowerShell 变量名大小写不敏感，会与下面的 $dataFile 撞成同一个变量
  [string]$ConfigFile = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$logDir = Join-Path $root 'logs'
$dataDir = Join-Path $root 'data'
$dataFile = Join-Path $dataDir 'resume.json'
if ($ConfigFile) {
  if ([System.IO.Path]::IsPathRooted($ConfigFile)) { $dataFile = $ConfigFile }
  else { $dataFile = Join-Path $root $ConfigFile }
}
$stateFile = Join-Path $logDir 'tray.state.json'
$iconFile = Join-Path $root 'assets\quickcopy.ico'
$serverOut = Join-Path $logDir 'server.log'
$serverErr = Join-Path $logDir 'server.err.log'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$script:nodeExe = ''
$script:serverProc = $null
$script:chosenPort = 0

# ------------------------------------------------------------ 小工具

function Show-Message([string]$Text, [string]$Caption = '简历速取', [string]$Kind = 'Information') {
  [System.Windows.Forms.MessageBox]::Show($Text, $Caption, 'OK', $Kind) | Out-Null
}

function Test-PortFree([int]$p) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}

function Find-FreePort([int]$Start) {
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-PortFree ($Start + $i)) { return ($Start + $i) }
  }
  return 0
}

function Get-PageUrl { 'http://127.0.0.1:{0}/' -f $script:chosenPort }
function Get-ApiUrl { 'http://127.0.0.1:{0}/api/meta' -f $script:chosenPort }

function Wait-Server([int]$TimeoutSec = 20) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($script:serverProc -and $script:serverProc.HasExited) { return $false }
    try {
      $r = Invoke-WebRequest (Get-ApiUrl) -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Start-Server {
  # --parent-pid：node 盯着这个 pid，托盘一没，服务跟着退
  $arguments = @(
    (Join-Path $root 'server.js'),
    '--no-open',
    '--port', $script:chosenPort,
    '--parent-pid', $PID
  )
  # 默认配置文件（未指定 -ConfigFile 时用 server.js 自己的默认值 data\resume.json）
  if ($script:dataFile) { $arguments += @('--data', $script:dataFile) }
  return Start-Process -FilePath $script:nodeExe -ArgumentList $arguments `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
}

function Stop-Server {
  if ($script:serverProc -and -not $script:serverProc.HasExited) {
    try {
      $script:serverProc.Kill()
      $script:serverProc.WaitForExit(5000) | Out-Null
    } catch { }
  }
}

function Open-Page {
  try { Start-Process (Get-PageUrl) }
  catch { Show-Message "打不开浏览器，请手动访问：`n$(Get-PageUrl)" }
}

function Open-Thing([string]$Target, [string]$Fallback = '') {
  try { Start-Process $Target }
  catch {
    if ($Fallback) { try { Start-Process $Fallback $Target } catch { } }
  }
}

function Write-StateFile {
  $serverPid = 0
  if ($script:serverProc) { $serverPid = $script:serverProc.Id }
  $state = [ordered]@{
    port      = $script:chosenPort
    trayPid   = $PID
    serverPid = $serverPid
    startedAt = (Get-Date).ToString('s')
  }
  [System.IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
}

function Remove-StateFile {
  if (Test-Path $stateFile) { Remove-Item $stateFile -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------ 单实例

$mutex = New-Object System.Threading.Mutex($false, 'QuickCopyTrayMutex')
if (-not $mutex.WaitOne(0)) {
  # 已经有一个托盘在跑：把它的页面打开，然后本进程直接退出
  $knownPort = $Port
  if (Test-Path $stateFile) {
    try { $knownPort = (Get-Content $stateFile -Raw | ConvertFrom-Json).port } catch { }
  }
  try { Start-Process ('http://127.0.0.1:{0}/' -f $knownPort) } catch { }
  exit 0
}

# ------------------------------------------------------------ 启动前检查

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Show-Message "没有找到 Node.js。`n`n请先安装 18 或更高版本：https://nodejs.org/`n装好后重新双击 start-tray.vbs。" '简历速取' 'Error'
  $mutex.ReleaseMutex()
  exit 1
}
$script:nodeExe = $nodeCmd.Source

$nodeVersion = (& $script:nodeExe -v) -replace '^v', ''
$nodeMajor = 0
[void][int]::TryParse(($nodeVersion -split '\.')[0], [ref]$nodeMajor)
if ($nodeMajor -lt 18) {
  Show-Message "Node.js 版本过低：v$nodeVersion`n本工具需要 18 或更高版本，请升级后再试。" '简历速取' 'Error'
  $mutex.ReleaseMutex()
  exit 1
}

$script:chosenPort = Find-FreePort $Port
if ($script:chosenPort -eq 0) {
  Show-Message "从 $Port 起的 60 个端口都被占用，没找到可用端口。" '简历速取' 'Error'
  $mutex.ReleaseMutex()
  exit 1
}

# ------------------------------------------------------------ 启动服务

$script:serverProc = Start-Server

if (-not (Wait-Server)) {
  Stop-Server
  $tail = ''
  if (Test-Path $serverErr) {
    $tail = (Get-Content $serverErr -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
  }
  Show-Message "服务没能启动。`n`n日志：$serverOut`n$tail" '简历速取' 'Error'
  $mutex.ReleaseMutex()
  exit 1
}
Write-StateFile

# ------------------------------------------------------------ 托盘图标与菜单

$notify = New-Object System.Windows.Forms.NotifyIcon
$hasIcon = $false
if (Test-Path $iconFile) {
  try {
    $notify.Icon = New-Object System.Drawing.Icon($iconFile)
    $hasIcon = $true
  } catch { }
}
if (-not $hasIcon) { $notify.Icon = [System.Drawing.SystemIcons]::Application }
$notify.Text = '简历速取 · 左键打开页面，右键看菜单'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开页面')
$miOpen.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold)
$miCopyUrl = $menu.Items.Add('复制服务地址')
[void]$menu.Items.Add('-')
$miData = $menu.Items.Add('打开数据文件（resume.json）')
$miFolder = $menu.Items.Add('打开数据文件夹')
$miLog = $menu.Items.Add('查看服务日志')
[void]$menu.Items.Add('-')
$miRestart = $menu.Items.Add('重启服务')
$miExit = $menu.Items.Add('退出')
$notify.ContextMenuStrip = $menu

$miOpen.add_Click({ Open-Page })
$miData.add_Click({ Open-Thing $dataFile 'notepad.exe' })
$miFolder.add_Click({ Open-Thing $dataDir 'explorer.exe' })
$miLog.add_Click({ Open-Thing $serverOut 'notepad.exe' })
$miCopyUrl.add_Click({
    [System.Windows.Forms.Clipboard]::SetText((Get-PageUrl))
    $notify.ShowBalloonTip(2000, '已复制服务地址', (Get-PageUrl), [System.Windows.Forms.ToolTipIcon]::Info)
  })
$miRestart.add_Click({
    Stop-Server
    for ($i = 0; $i -lt 25 -and -not (Test-PortFree $script:chosenPort); $i++) { Start-Sleep -Milliseconds 200 }
    $script:serverProc = Start-Server
    if (Wait-Server) {
      Write-StateFile
      $notify.ShowBalloonTip(3000, '服务已重启', (Get-PageUrl), [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
      Show-Message "重启后服务没有起来，看看日志：`n$serverOut" '简历速取' 'Error'
    }
  })
$miExit.add_Click({
    $notify.Visible = $false
    $notify.Dispose()
    Stop-Server
    Remove-StateFile
    [System.Windows.Forms.Application]::Exit()
  })

# 左键单击图标 = 打开页面
$notify.add_MouseClick({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Page }
  })

$notify.ShowBalloonTip(4000, '简历速取已启动',
  ('服务地址 ' + (Get-PageUrl) + "`n左键图标打开页面，右键看菜单；不退出的话服务会一直开着。"),
  [System.Windows.Forms.ToolTipIcon]::Info)

# ------------------------------------------------------------ 消息循环

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  Stop-Server
  Remove-StateFile
  if ($notify) { try { $notify.Dispose() } catch { } }
  try { $mutex.ReleaseMutex() } catch { }
}
