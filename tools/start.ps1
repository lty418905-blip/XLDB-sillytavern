[CmdletBinding()]
param(
  [string]$PrivateDirectory,
  [string]$DataDirectory,
  [ValidateRange(1, 65535)][int]$Port = 4318,
  [string[]]$AllowedOrigins = @(),
  [string]$PairingCode,
  [string]$TavernOrigin,
  [switch]$OpenTavern
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$rootParent = Split-Path -Parent $root
$rootLeaf = Split-Path -Leaf $root
if ([string]::IsNullOrWhiteSpace($rootLeaf)) { $rootLeaf = 'XLDB' }
if ([string]::IsNullOrWhiteSpace($PrivateDirectory)) { $PrivateDirectory = Join-Path $rootParent ($rootLeaf + '-private') }
if ([string]::IsNullOrWhiteSpace($DataDirectory)) { $DataDirectory = Join-Path $root '.local\data' }
$private = [IO.Path]::GetFullPath($PrivateDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
$receiptPath = Join-Path $root '.local\install\server-receipt.json'
$installReceiptPath = Join-Path $root '.local\install\install-receipt.json'
$serverPath = [IO.Path]::GetFullPath((Join-Path $root 'src\server.ts'))

function Write-JsonAtomic([string]$Path, [object]$Value) {
  if (Test-Path -LiteralPath $Path -PathType Container) { throw '运行记录目标是目录，无法保存。' }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Normalize-Origin([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Origin 不能为空。' }
  $uri = $null
  if (-not [Uri]::TryCreate($Value.Trim(), [UriKind]::Absolute, [ref]$uri)) { throw "Origin 不是有效绝对地址：$Value" }
  if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { throw "Origin 只支持 http/https：$Value" }
  if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.AbsolutePath -ne '/') {
    throw "Origin 只能包含 scheme、host 和 port：$Value"
  }
  return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Test-OwnedProcess([int]$Id, [string]$ExpectedNode, [string]$ExpectedServer) {
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.ExecutablePath) -or [string]::IsNullOrWhiteSpace($process.CommandLine)) { return $false }
    $actualNode = [IO.Path]::GetFullPath($process.ExecutablePath)
    return $actualNode.Equals([IO.Path]::GetFullPath($ExpectedNode), [StringComparison]::OrdinalIgnoreCase) -and
      $process.CommandLine.IndexOf($ExpectedServer, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch { return $false }
}

function Get-ListenerPid([int]$LocalPort) {
  try {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $listener) { return [int]$listener.OwningProcess }
  } catch {
    try {
      $client = [Net.Sockets.TcpClient]::new()
      $task = $client.ConnectAsync('127.0.0.1', $LocalPort)
      if ($task.Wait(250) -and $client.Connected) { $client.Dispose(); return -1 }
      $client.Dispose()
    } catch {}
  }
  return 0
}

function Test-Health([int]$LocalPort) {
  try {
    $response = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$LocalPort/health" -TimeoutSec 2
    return $response.status -eq 'ready'
  } catch { return $false }
}

function Write-Pairing([string]$Code, [string]$Origin) {
  if ($Code -notmatch '^[0-9a-fA-F]{64}$') { throw 'PairingCode 必须是 64 位十六进制字符串。' }
  if ([string]::IsNullOrWhiteSpace($Origin)) { throw 'PairingCode 必须同时提供 TavernOrigin。' }
  $normalized = Normalize-Origin $Origin
  $bytes = [Text.Encoding]::UTF8.GetBytes($Code)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $hashBytes = $algorithm.ComputeHash($bytes) } finally { $algorithm.Dispose() }
  $hash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
  $pairing = [ordered]@{ codeSha256 = $hash; origin = $normalized; expiresAtMs = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds() }
  Write-JsonAtomic (Join-Path $private 'install-pairing.json') $pairing
}

function Open-TavernPairing([string]$Code, [string]$Origin) {
  $encodedRoot = [Uri]::EscapeDataString($root)
  $launchUri = "$Origin/#xldb-pair=$Code&xldb-port=$Port&xldb-dir=$encodedRoot"
  Start-Process -FilePath $launchUri | Out-Null
}

if ($OpenTavern) {
  if ([string]::IsNullOrWhiteSpace($TavernOrigin)) { $TavernOrigin = 'http://localhost:8000' }
  if ([string]::IsNullOrWhiteSpace($PairingCode)) {
    $buffer = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    $PairingCode = ([BitConverter]::ToString($buffer)).Replace('-', '').ToLowerInvariant()
  }
}

if (-not (Test-Path -LiteralPath $installReceiptPath -PathType Leaf)) { throw '尚未完成安装，请先运行 tools/setup.ps1 或 tools/install.ps1。' }
$installReceipt = [IO.File]::ReadAllText($installReceiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$nodePath = [IO.Path]::GetFullPath([string]$installReceipt.nodePath)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw '安装记录中的 Node.js 已不存在，请重新运行 setup。' }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "缺少核心入口：$serverPath" }

$defaultOrigins = @('http://localhost:11451','http://127.0.0.1:11451','http://localhost:8000','http://127.0.0.1:8000')
$requestedOrigins = [Collections.Generic.List[string]]::new()
$originInputs = if ($AllowedOrigins.Count) { $AllowedOrigins } else { $defaultOrigins }
foreach ($value in $originInputs) {
  foreach ($part in $value.Split(',', [StringSplitOptions]::RemoveEmptyEntries)) {
    $normalized = Normalize-Origin $part
    if (-not $requestedOrigins.Contains($normalized)) { $requestedOrigins.Add($normalized) }
  }
}
if (-not [string]::IsNullOrWhiteSpace($TavernOrigin)) {
  $TavernOrigin = Normalize-Origin $TavernOrigin
  if (-not $requestedOrigins.Contains($TavernOrigin)) { $requestedOrigins.Add($TavernOrigin) }
}
if (-not [string]::IsNullOrWhiteSpace($PairingCode) -and [string]::IsNullOrWhiteSpace($TavernOrigin)) { throw 'PairingCode 必须同时提供 TavernOrigin。' }

if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
  try {
    $existing = [IO.File]::ReadAllText($receiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $existingPid = [int]$existing.pid
    if (Test-OwnedProcess $existingPid $nodePath $serverPath) {
      if ($existing.root -ne $root -or [int]$existing.port -ne $Port -or $existing.privateDirectory -ne $private -or $existing.dataDirectory -ne $data) {
        throw '已运行的 XLDB 属于同一安装根但启动参数不同；请显式 stop 后再按新参数启动。'
      }
      $existingOrigins = @($existing.allowedOrigins)
      $missing = @($requestedOrigins | Where-Object { $_ -notin $existingOrigins })
      if ($missing.Count) { throw ('已运行的 XLDB 未允许所需 Origin；请显式 stop 后重启。缺少：' + ($missing -join ', ')) }
      if (-not (Test-Health $Port)) { throw '已有同根 XLDB 进程仍在，但健康检查失败；未连接或终止该进程。' }
      if ($TavernOrigin) { $existing | Add-Member -NotePropertyName tavernOrigin -NotePropertyValue $TavernOrigin -Force; Write-JsonAtomic $receiptPath $existing }
      if (-not [string]::IsNullOrWhiteSpace($PairingCode)) { Write-Pairing $PairingCode $TavernOrigin }
      if ($OpenTavern) { Open-TavernPairing $PairingCode $TavernOrigin }
      Write-Host "XLDB 已在运行：http://127.0.0.1:$Port"
      return
    }
  } catch {
    if ($_.Exception.Message -like '已运行的 XLDB*' -or $_.Exception.Message -like '已有同根 XLDB*') { throw }
  }
}

if (Test-Path -LiteralPath $receiptPath -PathType Container) { throw '运行记录目标是目录，未启动核心。' }
$listenerPid = Get-ListenerPid $Port
if ($listenerPid -ne 0) { throw "端口 $Port 已被未知进程占用（PID $listenerPid）；未连接或终止该进程。" }

$logDirectory = Join-Path $root '.local\logs\server'
New-Item -ItemType Directory -Force -Path $private, $data, $logDirectory, (Split-Path -Parent $receiptPath) | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$stdoutPath = Join-Path $logDirectory "$stamp.stdout.log"
$stderrPath = Join-Path $logDirectory "$stamp.stderr.log"
$stdinPath = Join-Path $logDirectory 'empty.stdin'
if (-not (Test-Path -LiteralPath $stdinPath -PathType Leaf)) { [IO.File]::WriteAllText($stdinPath, '', [Text.UTF8Encoding]::new($false)) }
$environment = @{
  XLDB_PRIVATE_DIR = $private
  XLDB_DATA_DIR = $data
  XLDB_PORT = $Port.ToString([Globalization.CultureInfo]::InvariantCulture)
  XLDB_ALLOWED_ORIGINS = ($requestedOrigins -join ',')
}
$saved = @{}
foreach ($name in $environment.Keys) {
  $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
}
try {
  $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardInput $stdinPath -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
} finally {
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}

try {
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if ($process.HasExited) { break }
  if (Test-Health $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  throw "XLDB 未能在端口 $Port 通过健康检查。日志：$stderrPath"
}

$receipt = [ordered]@{
  schemaVersion = 1
  status = 'running'
  pid = $process.Id
  root = $root
  nodePath = $nodePath
  serverPath = $serverPath
  privateDirectory = $private
  dataDirectory = $data
  port = $Port
  allowedOrigins = @($requestedOrigins)
  tavernOrigin = $TavernOrigin
  startedAt = [DateTimeOffset]::UtcNow.ToString('o')
  stdoutPath = $stdoutPath
  stderrPath = $stderrPath
}
Write-JsonAtomic $receiptPath $receipt
if (-not [string]::IsNullOrWhiteSpace($PairingCode)) { Write-Pairing $PairingCode $TavernOrigin }
if ($OpenTavern) { Open-TavernPairing $PairingCode $TavernOrigin }
Write-Host "XLDB 已启动：http://127.0.0.1:$Port"
Write-Host "安装根：$root"
Write-Host "私有目录：$private"
} catch {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $receiptPath -PathType Leaf) { Remove-Item -LiteralPath $receiptPath -Force }
  throw
}
