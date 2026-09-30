[CmdletBinding()]
param(
  # Longest wait for the response headers or for any single read of a download; a stalled connection ends the attempt.
  [ValidateRange(1, 3600)][int]$TimeoutSec = 30,
  # Overall budget for this run; past it the run stops and a later run resumes from the verified bytes.
  [ValidateRange(1, 604800)][int]$BudgetSec = 7200,
  # Launcher mode: returns within seconds. When the model or runtime is not verified yet it starts a detached,
  # time-boxed download (LaunchBudgetSec) and exits 1, so the core starts at once in degraded mode.
  [switch]$Launch,
  [ValidateRange(1, 86400)][int]$LaunchBudgetSec = 600,
  # Also append progress and errors to this file (used by the detached download).
  [string]$LogPath,
  # Do not download or install anything (same as the .local\agentjev\skip marker).
  [switch]$Skip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$assets = Join-Path $root '.local\agentjev'
function Say([string]$Text) {
  Write-Host $Text
  if ($LogPath) { try { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ('{0:o} {1}' -f [DateTime]::UtcNow, $Text) } catch {} }
}
if ($Skip -or (Test-Path -LiteralPath (Join-Path $assets 'skip') -PathType Leaf)) {
  Say 'AgentJev installation skipped (.local\agentjev\skip or -Skip). NPC emotion ranking uses the deterministic fallback.'
  exit 0
}
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'agent-assets.json') | ConvertFrom-Json
$cache = Join-Path $root '.local\cache\agent-release'
$model = Join-Path $assets 'model\model.safetensors'
$modelReceipt = Join-Path $assets 'model.sha256'
$runtimeReceipt = Join-Path $assets 'release-runtime.sha256'
$python = Join-Path $assets 'runtime\python.exe'
$lockPath = Join-Path $assets 'install.lock'

# Cheap readiness check without hashing: the model receipt records the verified hash with the file's length and
# last-write time, the runtime receipt names the manifest's runtime hash.
function Model-Ready {
  if (-not ((Test-Path -LiteralPath $model -PathType Leaf) -and (Test-Path -LiteralPath $modelReceipt -PathType Leaf))) { return $false }
  $file = Get-Item -LiteralPath $model
  return ([IO.File]::ReadAllText($modelReceipt).Trim() -eq ('{0} {1} {2}' -f $manifest.model.sha256, $file.Length, $file.LastWriteTimeUtc.Ticks))
}
function Write-ModelReceipt {
  $file = Get-Item -LiteralPath $model
  [IO.File]::WriteAllText($modelReceipt, ('{0} {1} {2}' -f $manifest.model.sha256, $file.Length, $file.LastWriteTimeUtc.Ticks), [Text.UTF8Encoding]::new($false))
}
function Runtime-Ready {
  return ((Test-Path -LiteralPath $runtimeReceipt) -and (Test-Path -LiteralPath $python) -and ([IO.File]::ReadAllText($runtimeReceipt).Trim() -eq $manifest.runtime.sha256))
}
function Lock-Free {
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $true }
  try { ([IO.File]::Open($lockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)).Dispose(); return $true } catch { return $false }
}

New-Item -ItemType Directory -Force -Path $cache, (Join-Path $assets 'model') | Out-Null
if ($Launch) {
  if ((Model-Ready) -and (Runtime-Ready)) { Say 'AgentJev model and portable runtime are ready.'; exit 0 }
  $log = Join-Path $assets 'install.log'
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $PSCommandPath + '"'),
    '-BudgetSec', [string]$LaunchBudgetSec, '-TimeoutSec', [string]$TimeoutSec, '-LogPath', ('"' + $log + '"'))
  # An install from before the model receipt existed: the model has the manifest length and the runtime is verified,
  # so the core already uses AgentJev. Only the receipt is missing; a detached run hashes the model once to write it.
  if ((Runtime-Ready) -and (Test-Path -LiteralPath $model -PathType Leaf) -and ((Get-Item -LiteralPath $model).Length -eq [long]$manifest.model.bytes)) {
    if (Lock-Free) {
      $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -WindowStyle Hidden -PassThru
      Say ('AgentJev model found; verifying the existing model once in the background (no download, PID {0}, log .local\agentjev\install.log).' -f $child.Id)
    } else { Say 'AgentJev model found; verifying the existing model once in the background is already running.' }
    exit 0
  }
  if (-not (Lock-Free)) { Say 'AgentJev is still downloading in the background; XLDB starts now in degraded mode.'; exit 1 }
  $child = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Say ('AgentJev is not ready; downloading in the background for at most {0} s (PID {1}, log .local\agentjev\install.log).' -f $LaunchBudgetSec, $child.Id)
  exit 1
}

$lock = $null
try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { Say 'Another AgentJev installation is running.'; exit 1 }
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$deadline = [DateTime]::UtcNow.AddSeconds($BudgetSec)
function Remaining-Ms {
  $left = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($left -lt 1) { throw 'download_budget_exceeded' }
  return [int][Math]::Min([double]$TimeoutSec * 1000, [double]$left)
}
function Valid-File([string]$Path, $Spec) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or ((Get-Item -LiteralPath $Path).Length -ne $Spec.bytes)) { return $false }
  $inputFile = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($inputFile)).Replace('-','').ToLowerInvariant() -eq $Spec.sha256 }
  finally { $inputFile.Dispose(); $sha.Dispose() }
}
# One bounded attempt: the headers and every read wait at most TimeoutSec, and the budget is checked after each chunk,
# so a slow 256 MB body cannot outlive the run. An interrupted download resumes with an HTTP range request.
function Receive-Part([string]$Uri, [string]$Partial, [long]$Expected) {
  $offset = 0L
  if (Test-Path -LiteralPath $Partial -PathType Leaf) { $offset = (Get-Item -LiteralPath $Partial).Length }
  if ($offset -ge $Expected) { Remove-Item -LiteralPath $Partial -Force; $offset = 0L }
  $wait = Remaining-Ms
  $request = [Net.HttpWebRequest]::Create($Uri)
  $request.Timeout = $wait; $request.ReadWriteTimeout = $wait
  if ($offset -gt 0) { $request.AddRange($offset) }
  try { $response = $request.GetResponse() }
  catch [Net.WebException] {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 416) { Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue }
    throw
  }
  try {
    if ($offset -gt 0 -and [int]$response.StatusCode -ne 206) { $offset = 0L } # The server ignored the range: start over.
    $mode = if ($offset -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
    $output = [IO.File]::Open($Partial, $mode, [IO.FileAccess]::Write)
    try {
      $body = $response.GetResponseStream()
      $buffer = New-Object byte[] 1048576
      while (($count = $body.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $output.Write($buffer, 0, $count)
        if ([DateTime]::UtcNow -ge $deadline) { throw 'download_budget_exceeded' }
      }
    } finally { $output.Dispose() }
  } finally { $response.Dispose() }
}
function Fetch-Asset($Spec) {
  $target = Join-Path $cache $Spec.name
  if (Valid-File $target $Spec) { return $target }
  $partial = $target + '.download'
  for ($attempt=0; $attempt -lt 5; $attempt++) {
    try {
      Receive-Part ($manifest.baseUrl + $Spec.name) $partial ([long]$Spec.bytes)
      if (-not (Valid-File $partial $Spec)) { Remove-Item -LiteralPath $partial -Force; throw 'download_hash_mismatch' }
      Move-Item -LiteralPath $partial -Destination $target -Force
      return $target
    } catch {
      if ($attempt -eq 4 -or [DateTime]::UtcNow -ge $deadline -or "$_" -eq 'download_budget_exceeded') { throw }
      Start-Sleep -Seconds 2
    }
  }
}

try {
  if (-not (Model-Ready)) {
    if (Valid-File $model $manifest.model) { Write-ModelReceipt }
    else {
      # Verified parts are appended in order and deleted once appended, so disk use peaks near the model size plus one
      # part. The assembling file only ever grows by whole verified parts; an interrupted run resumes after the last
      # complete part and never downloads an appended part again.
      $parts = @($manifest.model.parts)
      $assembling = $model + '.assembling'
      $done = 0; $length = 0L
      if (Test-Path -LiteralPath $assembling -PathType Leaf) {
        $have = (Get-Item -LiteralPath $assembling).Length
        while ($done -lt $parts.Count -and $length + [long]$parts[$done].bytes -le $have) { $length += [long]$parts[$done].bytes; $done++ }
        if ($have -ne $length) { $stream = [IO.File]::Open($assembling, [IO.FileMode]::Open); try { $stream.SetLength($length) } finally { $stream.Dispose() } }
      }
      for ($index = 0; $index -lt $done; $index++) { Remove-Item -LiteralPath (Join-Path $cache $parts[$index].name) -Force -ErrorAction SilentlyContinue }
      for ($index = $done; $index -lt $parts.Count; $index++) {
        Say ('Downloading model asset ' + $parts[$index].name)
        $partPath = Fetch-Asset $parts[$index]
        $stream = [IO.File]::Open($assembling, [IO.FileMode]::Append, [IO.FileAccess]::Write)
        try { $inputStream = [IO.File]::OpenRead($partPath); try { $inputStream.CopyTo($stream) } finally { $inputStream.Dispose() }; $stream.Flush($true) }
        finally { $stream.Dispose() }
        Remove-Item -LiteralPath $partPath -Force
      }
      if (-not (Valid-File $assembling $manifest.model)) { Remove-Item -LiteralPath $assembling -Force; throw 'model_hash_mismatch' }
      Move-Item -LiteralPath $assembling -Destination $model -Force
      Write-ModelReceipt
    }
  }
  if (-not (Runtime-Ready)) {
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
    [IO.File]::WriteAllText($runtimeReceipt,$manifest.runtime.sha256,[Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $zipPath -Force
  }
  Say 'AgentJev model and portable runtime are ready.'
} catch {
  Say ('AgentJev installation stopped: ' + $_)
  throw
} finally { $lock.Dispose() }
