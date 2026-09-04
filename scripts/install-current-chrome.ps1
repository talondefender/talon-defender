param([Parameter(Mandatory=$true)][string]$DestinationDirectory)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not [System.IO.Path]::IsPathRooted($DestinationDirectory)) {
  throw 'Use an absolute private or temporary browser directory.'
}
$currentRoot = [System.IO.Path]::GetFullPath($DestinationDirectory).TrimEnd('\')
if ($currentRoot -eq $repoRoot -or $currentRoot.StartsWith($repoRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Browser binaries must stay outside the public Extension workspace.'
}
$feedUrl = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
$feed = Invoke-RestMethod -Uri $feedUrl -TimeoutSec 30
$stable = $feed.channels.Stable
if ($stable.channel -ne 'Stable' -or $stable.version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  throw 'Invalid official Stable Chrome metadata'
}
$download = @($stable.downloads.chrome | Where-Object platform -eq 'win64')
if ($download.Count -ne 1 -or $download[0].url -ne "https://storage.googleapis.com/chrome-for-testing-public/$($stable.version)/win64/chrome-win64.zip") {
  throw 'Unexpected official Chrome download reference'
}
New-Item -ItemType Directory -Path $currentRoot -Force | Out-Null
$currentArchive = Join-Path $currentRoot "chrome-win64-$($stable.version).zip"
curl.exe --fail --location --silent --show-error --retry 2 --output $currentArchive $download[0].url
if ($LASTEXITCODE -ne 0) { throw 'Current Stable Chrome download failed' }
$archiveHash = (Get-FileHash -LiteralPath $currentArchive -Algorithm SHA256).Hash.ToLowerInvariant()
Expand-Archive -LiteralPath $currentArchive -DestinationPath $currentRoot -Force
$currentExecutable = Join-Path $currentRoot 'chrome-win64\chrome.exe'
if (-not (Test-Path -LiteralPath $currentExecutable)) { throw 'Current Chrome executable missing' }
$executableVersion = (Get-Item -LiteralPath $currentExecutable).VersionInfo.ProductVersion
if ($executableVersion -ne $stable.version) { throw 'Downloaded Chrome version does not match the official Stable channel' }
[ordered]@{
  channel = 'Stable'
  version = $stable.version
  manifestTimestamp = $feed.timestamp
  manifestUrl = $feedUrl
  url = $download[0].url
  archiveSha256 = $archiveHash
  executable = $currentExecutable
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $currentRoot 'browser-provenance.json') -Encoding UTF8
Write-Output $currentExecutable
