[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'agent-assets.json') | ConvertFrom-Json
$assets = Join-Path $root '.local\agentjev'
$cache = Join-Path $root '.local\cache\agent-release'
New-Item -ItemType Directory -Force -Path $cache, (Join-Path $assets 'model') | Out-Null
$ProgressPreference = 'SilentlyContinue'
function Valid-File([string]$Path, $Spec) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or ((Get-Item -LiteralPath $Path).Length -ne $Spec.bytes)) { return $false }
  $inputFile = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($inputFile)).Replace('-','').ToLowerInvariant() -eq $Spec.sha256 }
  finally { $inputFile.Dispose(); $sha.Dispose() }
}
function Fetch-Asset($Spec) {
  $target = Join-Path $cache $Spec.name
  if (Valid-File $target $Spec) { return $target }
  $partial = $target + '.download'
  for ($attempt=0; $attempt -lt 5; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ($manifest.baseUrl + $Spec.name) -OutFile $partial
      if (-not (Valid-File $partial $Spec)) { throw 'download_hash_mismatch' }
      Move-Item -LiteralPath $partial -Destination $target -Force
      return $target
    } catch { if ($attempt -eq 4) { throw }; Start-Sleep -Seconds 2 }
  }
}
$model = Join-Path $assets 'model\model.safetensors'
if (-not (Valid-File $model $manifest.model)) {
  $partialModel = $model + '.assembling'
  $stream = [IO.File]::Open($partialModel,[IO.FileMode]::Create)
  try {
    foreach ($part in $manifest.model.parts) {
      Write-Host ('Downloading model asset ' + $part.name)
      $partPath = Fetch-Asset $part
      $inputStream = [IO.File]::OpenRead($partPath)
      try { $inputStream.CopyTo($stream) } finally { $inputStream.Dispose() }
      Remove-Item -LiteralPath $partPath -Force
    }
  } finally { $stream.Dispose() }
  if (-not (Valid-File $partialModel $manifest.model)) { throw 'model_hash_mismatch' }
  Move-Item -LiteralPath $partialModel -Destination $model -Force
}
$receipt = Join-Path $assets 'release-runtime.sha256'
$python = Join-Path $assets 'runtime\python.exe'
if (-not ((Test-Path -LiteralPath $receipt) -and (Test-Path -LiteralPath $python) -and ((Get-Content -Raw -LiteralPath $receipt).Trim() -eq $manifest.runtime.sha256))) {
  $zipPath = Fetch-Asset $manifest.runtime
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($entry in $zip.Entries) {
      if (-not $entry.FullName.StartsWith('.local/agentjev/') -or $entry.FullName.Contains('..') -or $entry.FullName.Contains(':')) { throw 'invalid_runtime_path' }
      $destination = [IO.Path]::GetFullPath((Join-Path $root $entry.FullName))
      if (-not $destination.StartsWith($assets + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'runtime_path_escape' }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$true)
    }
  } finally { $zip.Dispose() }
  [IO.File]::WriteAllText($receipt,$manifest.runtime.sha256,[Text.UTF8Encoding]::new($false))
}
Write-Host 'AgentJev model and portable runtime are ready.'
