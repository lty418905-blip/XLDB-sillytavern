[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Agent','Tavern')][string]$Mode,
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
# Reuse this installation's last successful launch; omitted arguments must not
# silently switch an existing user to an empty private/data directory.
# A record from another root (a moved or copied folder) is never followed silently either: an interactive run asks,
# a non-interactive run exits and prints both explicit commands. A folder without a record gets a first-run notice.
$defaultPrivateDirectory = Join-Path $rootParent ($rootLeaf + '-private')
$defaultDataDirectory = Join-Path $root '.local\data'
$interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and
  -not @([Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }).Count
function Get-SavedValue([object]$Saved, [string]$Name) {
  if ($Saved.PSObject.Properties.Name -contains $Name) { return $Saved.$Name }
  return $null
}
function Show-Directory([string]$Label, [string]$Path) {
  $state = if ([string]::IsNullOrWhiteSpace($Path)) { '未记录' } elseif (Test-Path -LiteralPath $Path) { '已存在' } else { '不存在，将新建' }
  Write-Host "  ${Label}：$Path（$state）"
}
if ($Mode -eq 'Tavern') {
  $savedLaunchPath = Join-Path $root '.local\install\server-receipt.json'
  $useSaved = $false
  $savedLaunch = $null
  if (Test-Path -LiteralPath $savedLaunchPath -PathType Leaf) {
    $savedLaunch = [IO.File]::ReadAllText($savedLaunchPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $savedRoot = [string](Get-SavedValue $savedLaunch 'root')
    if (-not [string]::IsNullOrWhiteSpace($savedRoot) -and [IO.Path]::GetFullPath($savedRoot) -eq $root) { $useSaved = $true }
    elseif (-not $PSBoundParameters.ContainsKey('PrivateDirectory')) {
      $savedPrivate = [string](Get-SavedValue $savedLaunch 'privateDirectory')
      $savedData = [string](Get-SavedValue $savedLaunch 'dataDirectory')
      Write-Host "本目录的运行记录来自另一个安装位置：$savedRoot"
      Write-Host '1 沿用记录中的目录：'
      Show-Directory '私有目录' $savedPrivate
      Show-Directory '数据目录' $savedData
      Write-Host '2 使用本安装位置的默认目录：'
      Show-Directory '私有目录' $defaultPrivateDirectory
      Show-Directory '数据目录' $defaultDataDirectory
      Write-Host '未复制 .local\agentjev 时需要重新下载约 2.4 GB 的 AgentJev 模型；酒馆端需要重新配对。'
      if (-not $interactive) {
        Write-Host '非交互运行不会替你选择。请改用下面任一命令重新运行：'
        Write-Host "  START-XLDB.cmd -PrivateDirectory `"$savedPrivate`" -DataDirectory `"$savedData`""
        Write-Host "  START-XLDB.cmd -PrivateDirectory `"$defaultPrivateDirectory`" -DataDirectory `"$defaultDataDirectory`""
        Write-Host '未启动核心，未创建目录。'
        exit 3
      }
      $choice = Read-Host '输入 1 或 2，其他键取消'
      if ($choice -eq '1') { $useSaved = $true }
      elseif ($choice -eq '2') {
        $PrivateDirectory = $defaultPrivateDirectory
        if (-not $PSBoundParameters.ContainsKey('DataDirectory')) { $DataDirectory = $defaultDataDirectory }
      } else { Write-Host '已取消；未启动核心，未创建目录。'; exit 1 }
    }
  } elseif (-not $PSBoundParameters.ContainsKey('PrivateDirectory')) {
    $firstData = if ($PSBoundParameters.ContainsKey('DataDirectory')) { $DataDirectory } else { $defaultDataDirectory }
    Write-Host '首次在此位置启动 XLDB，将使用以下目录：'
    Show-Directory '私有目录（令牌、模型设置、配对）' $defaultPrivateDirectory
    Show-Directory '数据目录（数据库、索引）' $firstData
    Write-Host '从 0.1.3 或更早版本升级：请先在旧目录执行 tools\stop.ps1 并备份，然后把新版覆盖解压到原安装目录再启动，不要换新文件夹。'
    if ($interactive) {
      $choice = Read-Host '按 Y 继续，其他键取消'
      if ($choice -notmatch '^[Yy]$') { Write-Host '已取消；未启动核心，未创建目录。'; exit 1 }
    }
  }
  if ($useSaved) {
    if (-not $PSBoundParameters.ContainsKey('PrivateDirectory')) { $PrivateDirectory = [string](Get-SavedValue $savedLaunch 'privateDirectory') }
    if (-not $PSBoundParameters.ContainsKey('DataDirectory')) { $DataDirectory = [string](Get-SavedValue $savedLaunch 'dataDirectory') }
    $savedPort = Get-SavedValue $savedLaunch 'port'
    if (-not $PSBoundParameters.ContainsKey('Port') -and $null -ne $savedPort) { $Port = [int]$savedPort }
    $savedOrigins = @(Get-SavedValue $savedLaunch 'allowedOrigins' | Where-Object { $_ })
    if (-not $PSBoundParameters.ContainsKey('AllowedOrigins') -and $savedOrigins.Count) { $AllowedOrigins = $savedOrigins }
    if (-not $PSBoundParameters.ContainsKey('TavernOrigin')) {
      $savedTavern = Get-SavedValue $savedLaunch 'tavernOrigin'
      if ($savedTavern) { $TavernOrigin = [string]$savedTavern }
      elseif ($savedOrigins.Count -eq 1) { $TavernOrigin = [string]$savedOrigins[0] }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($PrivateDirectory)) { $PrivateDirectory = $defaultPrivateDirectory }

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

& (Join-Path $PSScriptRoot 'install.ps1')

$setupReceiptPath = Join-Path $root '.local\install\setup-receipt.json'
if ($Mode -eq 'Agent') {
  if (-not [string]::IsNullOrWhiteSpace($PairingCode) -or -not [string]::IsNullOrWhiteSpace($TavernOrigin) -or $OpenTavern) {
    throw 'Agent 模式不使用 PairingCode、TavernOrigin 或 OpenTavern。'
  }
  $receipt = [ordered]@{
    schemaVersion = 1
    mode = 'Agent'
    root = $root
    status = 'ready'
    checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
    httpStarted = $false
    modelApiConfigured = $false
  }
  Write-JsonAtomic $setupReceiptPath $receipt
  Write-Host 'XLDB Agent 模式已就绪；未启动 HTTP 服务，也未配置或请求模型 API。'
  return
}

$startParameters = @{
  PrivateDirectory = $PrivateDirectory
  Port = $Port
  AllowedOrigins = $AllowedOrigins
}
if (-not [string]::IsNullOrWhiteSpace($DataDirectory)) { $startParameters.DataDirectory = $DataDirectory }
if (-not [string]::IsNullOrWhiteSpace($PairingCode)) { $startParameters.PairingCode = $PairingCode }
if (-not [string]::IsNullOrWhiteSpace($TavernOrigin)) { $startParameters.TavernOrigin = $TavernOrigin }
if ($OpenTavern) { $startParameters.OpenTavern = $true }
& (Join-Path $PSScriptRoot 'start.ps1') @startParameters
$receipt = [ordered]@{
  schemaVersion = 1
  mode = 'Tavern'
  root = $root
  privateDirectory = [IO.Path]::GetFullPath($PrivateDirectory)
  port = $Port
  status = 'ready'
  checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
  httpStarted = $true
}
Write-JsonAtomic $setupReceiptPath $receipt
Write-Host 'XLDB Tavern 模式已就绪。'
