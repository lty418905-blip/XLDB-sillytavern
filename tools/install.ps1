[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$minimumNode = [version]'24.18.1'
$portableVersion = '24.18.1'
$portableFolder = "node-v$portableVersion-win-x64"
$portableRoot = Join-Path $root ".local\node\$portableFolder"
$receiptPath = Join-Path $root '.local\install\install-receipt.json'

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Test-Node([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $versionText = (& $Path --version).Trim().TrimStart('v')
    $architecture = (& $Path -p 'process.arch').Trim()
    $version = [version]$versionText
    if ($version.Major -ne 24 -or $version -lt $minimumNode -or $architecture -ne 'x64') { return $null }
    return [pscustomobject]@{ Path = [IO.Path]::GetFullPath($Path); Version = $versionText; Architecture = $architecture }
  } catch { return $null }
}

function Get-CompatibleNode {
  $system = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $system) {
    $candidate = Test-Node $system.Source
    if ($null -ne $candidate) { return $candidate }
  }

  $portableNode = Join-Path $portableRoot 'node.exe'
  $candidate = Test-Node $portableNode
  if ($null -ne $candidate) { return $candidate }

  $cache = Join-Path $root '.local\cache\node'
  $temporary = Join-Path $root '.local\tmp'
  New-Item -ItemType Directory -Force -Path $cache, $temporary, (Split-Path -Parent $portableRoot) | Out-Null
  $env:TEMP = $temporary
  $env:TMP = $temporary
  $zipName = "$portableFolder.zip"
  $zipPath = Join-Path $cache $zipName
  $sumsPath = Join-Path $cache "SHASUMS256-v$portableVersion.txt"
  $baseUri = "https://nodejs.org/dist/v$portableVersion"
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUri/SHASUMS256.txt" -OutFile $sumsPath
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUri/$zipName" -OutFile $zipPath
  $pattern = '^([0-9a-fA-F]{64})\s+' + [regex]::Escape($zipName) + '$'
  $match = Select-String -LiteralPath $sumsPath -Pattern $pattern | Select-Object -First 1
  if ($null -eq $match) { throw "Node.js 官方校验清单不包含 $zipName。" }
  $expectedHash = $match.Matches[0].Groups[1].Value.ToLowerInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Node.js 便携包 SHA-256 与官方清单不一致。' }

  if (Test-Path -LiteralPath $portableRoot) { throw "现有便携 Node 目录无效，未自动覆盖：$portableRoot" }
  $stage = Join-Path $temporary ('node-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $stage
    $expanded = Join-Path $stage $portableFolder
    if (-not (Test-Path -LiteralPath (Join-Path $expanded 'node.exe'))) { throw 'Node.js 便携包内容不完整。' }
    Move-Item -LiteralPath $expanded -Destination $portableRoot
  } finally {
    $stageFull = [IO.Path]::GetFullPath($stage)
    $temporaryPrefix = [IO.Path]::GetFullPath($temporary).TrimEnd('\') + '\'
    if (-not $stageFull.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "拒绝清理工作区临时目录以外的路径：$stageFull" }
    if (Test-Path -LiteralPath $stageFull) { Remove-Item -LiteralPath $stageFull -Recurse -Force }
  }
  $candidate = Test-Node (Join-Path $portableRoot 'node.exe')
  if ($null -eq $candidate) { throw '下载的 Node.js 便携运行时未通过 Windows x64 / 版本检查。' }
  return $candidate
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '此安装脚本仅面向 Windows x64。' }
$node = Get-CompatibleNode
$nodeDirectory = Split-Path -Parent $node.Path
$npm = Join-Path $nodeDirectory 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw "兼容 Node.js 旁未找到 npm.cmd：$nodeDirectory" }

$cache = Join-Path $root '.local\cache\npm'
$tmp = Join-Path $root '.local\tmp'
$runtime = Join-Path $root '.local\runtime'
$tooling = Join-Path $root '.local\tooling'
New-Item -ItemType Directory -Force -Path $cache, $tmp, $runtime, $tooling, (Split-Path -Parent $receiptPath) | Out-Null

$env:npm_config_cache = $cache
$env:TEMP = $tmp
$env:TMP = $tmp

$expected = [ordered]@{
  schemaVersion = 1
  root = $root
  nodeMajor = 24
  minimumNode = $minimumNode.ToString()
  architecture = 'x64'
  packages = [ordered]@{
    '@lancedb/lancedb' = '0.39.0'
    '@lancedb/lancedb-win32-x64-msvc' = '0.39.0'
    'typescript' = '5.9.3'
    '@types/node' = '24.13.6'
  }
}

$checkScript = Join-Path $root 'tools\install-check.mjs'
$canSkip = $false
if ((Test-Path -LiteralPath $receiptPath -PathType Leaf) -and (Test-Path -LiteralPath $checkScript -PathType Leaf)) {
  try {
    $previous = [IO.File]::ReadAllText($receiptPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $shapeMatches = $previous.schemaVersion -eq 1 -and $previous.root -eq $root -and
      $previous.packages.'@lancedb/lancedb' -eq '0.39.0' -and
      $previous.packages.'@lancedb/lancedb-win32-x64-msvc' -eq '0.39.0' -and
      $previous.packages.typescript -eq '5.9.3' -and $previous.packages.'@types/node' -eq '24.13.6'
    if ($shapeMatches) {
      $null = & $node.Path $checkScript --root $root --quiet
      $canSkip = $LASTEXITCODE -eq 0
    }
  } catch { $canSkip = $false }
}

if (-not $canSkip) {
  $runtimePackages = @('@lancedb/lancedb@0.39.0', '@lancedb/lancedb-win32-x64-msvc@0.39.0')
  & $npm install --prefix $runtime --omit=optional --ignore-scripts --no-audit --no-fund --save-exact --fetch-retries=1 --fetch-timeout=30000 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 @runtimePackages
  if ($LASTEXITCODE -ne 0) { throw '本地 LanceDB 运行时安装失败。' }
  $toolingPackages = @('typescript@5.9.3', '@types/node@24.13.6')
  & $npm install --prefix $tooling --omit=optional --ignore-scripts --no-audit --no-fund --save-exact --fetch-retries=1 --fetch-timeout=30000 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 @toolingPackages
  if ($LASTEXITCODE -ne 0) { throw '本地 TypeScript 工具安装失败。' }
}

$checkOutput = & $node.Path $checkScript --root $root
if ($LASTEXITCODE -ne 0) { throw '安装后的 Tavern 运行时检查失败。' }
$check = $checkOutput | ConvertFrom-Json
$receipt = [ordered]@{} + $expected
$receipt.nodePath = $node.Path
$receipt.nodeVersion = $node.Version
$receipt.npmPath = [IO.Path]::GetFullPath($npm)
$receipt.verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
$receipt.checks = $check.checks
Write-JsonAtomic $receiptPath $receipt

if ($canSkip) { Write-Host '依赖版本与实际运行检查仍有效，已跳过重复 npm 安装。' }
Write-Host "XLDB 本地依赖安装完成：$root"
Write-Host "Node.js：v$($node.Version) x64"
Write-Host '未更改系统 Python，也未安装全局包或模型服务。'
