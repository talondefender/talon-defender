Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Remove-PathWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [int]$MaxAttempts = 10,
    [int]$DelayMilliseconds = 500
  )

  if (-not (Test-Path -LiteralPath $LiteralPath)) {
    return
  }

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      Remove-Item -LiteralPath $LiteralPath -Recurse -Force
      return
    }
    catch {
      if ($attempt -eq $MaxAttempts) {
        throw
      }
      Start-Sleep -Milliseconds $DelayMilliseconds
    }
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot "dist"
$stageRoot = Join-Path $distDir "source-release"
$manifestPath = Join-Path $repoRoot "manifest.json"
$packageJsonPath = Join-Path $repoRoot "package.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Missing manifest at $manifestPath"
}
if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  throw "Missing package.json at $packageJsonPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Manifest version is required for source packaging."
}

$sourceRef = "v$version"
$repositoryUrl = [string]$packageJson.repository.url
if ([string]::IsNullOrWhiteSpace($repositoryUrl)) {
  $repositoryUrl = "https://github.com/talondefender/talon-defender"
}
$repositoryUrl = $repositoryUrl.Trim()
$repositoryUrl = $repositoryUrl -replace '^git\+', ''
$repositoryUrl = $repositoryUrl -replace '\.git$', ''

$archiveName = "talon-defender-extension-source-$sourceRef.zip"
$stageDir = Join-Path $stageRoot "talon-defender-extension-source-$sourceRef"
$archivePath = Join-Path $distDir $archiveName
$metadataPath = Join-Path $distDir "source-release.json"

$sourceItems = @(
  ".gitignore",
  "AGENTS.md",
  "ATTRIBUTION.md",
  "CHANGE_PROCESS.md",
  "CURRENT_STATE.md",
  "GITHUB_PUBLISHING.md",
  "LICENSE.txt",
  "OPERATIONS.md",
  "PUBLIC_RELEASE_BOUNDARY.md",
  "README.md",
  "RELEASE.md",
  "THIRD_PARTY_NOTICES.md",
  "_locales",
  "automation",
  "css",
  "icons",
  "img",
  "js",
  "lib",
  "managed_storage.json",
  "manifest.json",
  "options",
  "package-lock.json",
  "package.json",
  "picker-ui.html",
  "popup",
  "rulesets",
  "scripts",
  "shared",
  "strictblock.html",
  "test/auto-backoff.test.js",
  "test/automation-directives.test.js",
  "test/breakage-policy.test.js",
  "test/default-rulesets.test.js",
  "test/entitlement-regression.test.js",
  "unpicker-ui.html",
  "web_accessible_resources"
)

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
  Remove-PathWithRetry -LiteralPath $stageRoot
}
if (Test-Path -LiteralPath $archivePath) {
  Remove-PathWithRetry -LiteralPath $archivePath
}
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

foreach ($item in $sourceItems) {
  $sourcePath = Join-Path $repoRoot $item
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    continue
  }
  $destinationPath = Join-Path $stageDir $item
  $destinationParent = Split-Path -Parent $destinationPath
  if (-not [string]::IsNullOrWhiteSpace($destinationParent)) {
    New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
  }
  Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
}

Compress-Archive -Path $stageDir -DestinationPath $archivePath -Force

$metadata = [ordered]@{
  generatedAtUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  version = $version
  sourceRef = $sourceRef
  repositoryUrl = $repositoryUrl
  sourceCodeUrl = "$repositoryUrl/tree/$sourceRef"
  sourceTarballUrl = "$repositoryUrl/archive/refs/tags/$sourceRef.tar.gz"
  sourceArchiveFileName = $archiveName
  sourceArchivePath = $archivePath
}

$metadata | ConvertTo-Json -Depth 4 | Set-Content -Path $metadataPath -Encoding ASCII
Write-Host "Public source archive ready: $archivePath"
