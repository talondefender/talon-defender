Param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("chrome", "edge")]
  [string]$Channel,

  [Parameter(Mandatory = $true)]
  [string]$ZipPath,

  [Parameter(Mandatory = $true)]
  [string]$BuildInfoPath,

  [Parameter(Mandatory = $true)]
  [string]$SourceArchivePath,

  [Parameter(Mandatory = $true)]
  [string]$SourceManifestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$controlCenterRoot = Split-Path -Parent $repoRoot
$latestRoot = Join-Path $controlCenterRoot "Talon Defender Latest"
$channelDir = Join-Path $latestRoot $Channel
$sourceDir = Join-Path $latestRoot "source"

foreach ($dir in @($latestRoot, $channelDir, $sourceDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

foreach ($dir in @($channelDir, $sourceDir)) {
  Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne ".gitkeep" } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Copy-Item -LiteralPath $ZipPath -Destination (Join-Path $channelDir (Split-Path -Leaf $ZipPath)) -Force
Copy-Item -LiteralPath $BuildInfoPath -Destination (Join-Path $channelDir (Split-Path -Leaf $BuildInfoPath)) -Force
Copy-Item -LiteralPath $SourceArchivePath -Destination (Join-Path $sourceDir (Split-Path -Leaf $SourceArchivePath)) -Force
Copy-Item -LiteralPath $SourceManifestPath -Destination (Join-Path $sourceDir (Split-Path -Leaf $SourceManifestPath)) -Force

Write-Host "Synced latest artifacts to $latestRoot"
