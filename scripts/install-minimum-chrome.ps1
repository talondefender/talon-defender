param([Parameter(Mandatory=$true)][string]$DestinationDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not [System.IO.Path]::IsPathRooted($DestinationDirectory)) {
  throw 'Use an absolute private or temporary browser directory.'
}
$minimumRoot = [System.IO.Path]::GetFullPath($DestinationDirectory).TrimEnd('\')
if ($minimumRoot -eq $repoRoot -or $minimumRoot.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Browser binaries must stay outside the public Extension workspace.'
}
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'minimum-chrome.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Path $minimumRoot -Force | Out-Null
$minimumArchive = Join-Path $minimumRoot 'chrome-win64.zip'
if (-not (Test-Path -LiteralPath $minimumArchive) -or
    (Get-FileHash -LiteralPath $minimumArchive -Algorithm SHA256).Hash -ne $pin.sha256) {
  curl.exe --fail --location --silent --show-error --retry 2 --output $minimumArchive $pin.url
  if ($LASTEXITCODE -ne 0) { throw 'Minimum Chrome download failed' }
}
if ((Get-FileHash -LiteralPath $minimumArchive -Algorithm SHA256).Hash -ne $pin.sha256) {
  throw 'Minimum Chrome archive hash mismatch'
}
Expand-Archive -LiteralPath $minimumArchive -DestinationPath $minimumRoot -Force
$minimumExecutable = Join-Path $minimumRoot 'chrome-win64\chrome.exe'
if (-not (Test-Path -LiteralPath $minimumExecutable)) { throw 'Minimum Chrome executable missing' }
Write-Output $minimumExecutable
