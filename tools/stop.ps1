[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$receiptPath = Join-Path $root '.local\install\server-receipt.json'
$expectedServer = [IO.Path]::GetFullPath((Join-Path $root 'src\server.ts'))

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { Write-Host '没有本安装根创建的运行记录；未终止任何进程。'; return }
$receipt = [IO.File]::ReadAllText($receiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($receipt.root -ne $root) { throw '运行记录的安装根不匹配；未终止任何进程。' }
if ([IO.Path]::GetFullPath([string]$receipt.serverPath) -ne $expectedServer) { throw '运行记录的核心入口不属于本安装根；未终止任何进程。' }
if ($receipt.status -ne 'running' -or $null -eq $receipt.pid) { Write-Host 'XLDB 已停止；未终止任何进程。'; return }
$pidValue = [int]$receipt.pid
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
if ($null -eq $process) {
  $receipt.status = 'stopped'
  $receipt.pid = $null
  $receipt | Add-Member -NotePropertyName stoppedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
  Write-JsonAtomic $receiptPath $receipt
  Write-Host '记录中的进程已不存在；未终止其它进程。'
  return
}
$actualNode = if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { '' } else { [IO.Path]::GetFullPath($process.ExecutablePath) }
$expectedNode = [IO.Path]::GetFullPath([string]$receipt.nodePath)
if (-not $actualNode.Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase) -or
    [string]::IsNullOrWhiteSpace($process.CommandLine) -or
    $process.CommandLine.IndexOf($expectedServer, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "PID $pidValue 不再是本安装根启动的 XLDB；未终止该进程。"
}
$listener = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$receipt.port) -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' })
if ($listener.Count -gt 0) {
  if (@($listener | Where-Object { $_.OwningProcess -ne $pidValue }).Count -gt 0) { throw '核心端口已属于其它进程；未发送认证资料或终止进程。' }
  $localToken = [IO.File]::ReadAllText((Join-Path ([string]$receipt.privateDirectory) 'local-token.txt'), [Text.Encoding]::UTF8).Trim()
  $null = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($receipt.port)/v1/install/shutdown" -Headers @{ Authorization = "Bearer $localToken" } -ContentType 'application/json' -Body '{}' -TimeoutSec 10
}
try { Wait-Process -Id $pidValue -Timeout 10 -ErrorAction Stop } catch {
  if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { throw "XLDB 未在 10 秒内停止；未强制终止 PID $pidValue。" }
}
$receipt.status = 'stopped'
$receipt.pid = $null
$receipt | Add-Member -NotePropertyName stoppedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
Write-JsonAtomic $receiptPath $receipt
Write-Host 'XLDB 已停止。'
