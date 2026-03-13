Param(
  [switch]$SkipPackageStep
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression

function New-ZipFromDirectoryFilesOnly {
  Param(
    [Parameter(Mandatory = $true)][string]$SourceDir,
    [Parameter(Mandatory = $true)][string]$DestinationZip
  )

  if (Test-Path $DestinationZip) {
    Remove-Item $DestinationZip -Force
  }

  $resolvedSource = (Resolve-Path $SourceDir).Path
  $sourcePrefix = $resolvedSource.TrimEnd('\', '/')
  $files = Get-ChildItem -Path $resolvedSource -Recurse -File
  $zipStream = [System.IO.File]::Open($DestinationZip, [System.IO.FileMode]::CreateNew)
  try {
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourcePrefix.Length).TrimStart('\', '/')
        $entryName = $relative.Replace('\', '/')
        $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
        $input = [System.IO.File]::OpenRead($file.FullName)
        try {
          $output = $entry.Open()
          try {
            $input.CopyTo($output)
          } finally {
            $output.Dispose()
          }
        } finally {
          $input.Dispose()
        }
      }
    } finally {
      $archive.Dispose()
    }
  } finally {
    $zipStream.Dispose()
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$distExtension = Join-Path $repoRoot "dist\edge-extension"
$distMirror = Join-Path $repoRoot "dist\talon-defender-edge-extension"
$zipPath = Join-Path $repoRoot "dist\talon-defender-edge-extension.zip"
$buildInfoPath = Join-Path $repoRoot "dist\edge-extension-build-info.json"
$packagePublicSourceScript = Join-Path $scriptDir "package-public-source.ps1"
$syncLatestScript = Join-Path $scriptDir "sync-latest-artifacts.ps1"

Write-Host "Running Edge quality gate (tests + public-safe audit + Edge package + MV3 validation)..."
Push-Location $repoRoot
try {
  npm run lint:edge
  if ($LASTEXITCODE -ne 0) { throw "npm run lint:edge failed." }
}
finally {
  Pop-Location
}

# lint:edge already rebuilds and validates dist/edge-extension; continue with release packaging steps.
$SkipPackageStep = $true

if (-not $SkipPackageStep) {
  Write-Host "Packaging Edge extension from source..."
  Push-Location $repoRoot
  try {
    node scripts/package-edge-extension.mjs
    if ($LASTEXITCODE -ne 0) { throw "package-edge-extension.mjs failed." }
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $distExtension "manifest.json"))) {
  throw "Missing packaged Edge extension manifest at $distExtension"
}

if (Test-Path $distMirror) {
  Remove-Item $distMirror -Recurse -Force
}
New-Item -ItemType Directory -Path $distMirror | Out-Null
Copy-Item -Path (Join-Path $distExtension "*") -Destination $distMirror -Recurse -Force

Write-Host "Running MV3 package validation for Edge artifacts..."
Push-Location $repoRoot
try {
  node scripts/validate-mv3-package.mjs --dir dist/edge-extension
  if ($LASTEXITCODE -ne 0) { throw "validate-mv3-package.mjs failed for dist/edge-extension." }
  node scripts/validate-mv3-package.mjs --dir dist/talon-defender-edge-extension
  if ($LASTEXITCODE -ne 0) { throw "validate-mv3-package.mjs failed for dist/talon-defender-edge-extension." }
}
finally {
  Pop-Location
}

$criticalFiles = @(
  "js\background.js",
  "js\entitlement.js",
  "options\options.js",
  "popup\popup.js"
)

$hashes = @{}
foreach ($relative in $criticalFiles) {
  $sourcePath = Join-Path $repoRoot $relative
  $distPath = Join-Path $distExtension $relative

  if (-not (Test-Path $sourcePath)) { throw "Missing source file: $relative" }
  if (-not (Test-Path $distPath)) { throw "Missing packaged file: $relative" }

  $sourceHash = (Get-FileHash -Path $sourcePath -Algorithm SHA256).Hash
  $distHash = (Get-FileHash -Path $distPath -Algorithm SHA256).Hash

  if ($sourceHash -ne $distHash) {
    throw "Packaged file mismatch for $relative"
  }

  $hashes[$relative.Replace("\", "/")] = $distHash
}

$hasFirstPopup = (Select-String -Path (Join-Path $distExtension "js\background.js") -Pattern "maybeOpenFirstPopupWelcome" -SimpleMatch | Measure-Object).Count -gt 0
if ($hasFirstPopup -eq $false) {
  throw "Expected first-popup flow marker not found in packaged background.js"
}

$requiredComplianceFiles = @(
  "LICENSE.txt",
  "ATTRIBUTION.md",
  "THIRD_PARTY_NOTICES.md",
  "source-code.json",
  "edge-build-target.json"
)
foreach ($relative in $requiredComplianceFiles) {
  $distPath = Join-Path $distExtension $relative
  if (-not (Test-Path $distPath)) {
    throw "Missing required compliance artifact in package: $relative"
  }
}

$sourceCodeMetadataPath = Join-Path $distExtension "source-code.json"
$sourceCodeMetadata = Get-Content $sourceCodeMetadataPath -Raw | ConvertFrom-Json
$sourceCodeUrl = [string]$sourceCodeMetadata.sourceCodeUrl
if ([string]::IsNullOrWhiteSpace($sourceCodeUrl)) {
  throw "source-code.json is missing sourceCodeUrl"
}
if ([string]$sourceCodeMetadata.distributionTarget -ne "microsoft-edge-addons") {
  throw "source-code.json is missing distributionTarget=microsoft-edge-addons"
}

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

Write-Host "Creating Edge extension zip..."
New-ZipFromDirectoryFilesOnly -SourceDir $distExtension -DestinationZip $zipPath

$manifest = Get-Content (Join-Path $distExtension "manifest.json") -Raw | ConvertFrom-Json

if ([string]$manifest.background.service_worker -like "/*") {
  throw "Edge manifest must use relative background.service_worker path (no leading slash)."
}
foreach ($entry in $manifest.declarative_net_request.rule_resources) {
  if ([string]$entry.path -like "/*") {
    throw "Edge manifest must use relative DNR ruleset paths (no leading slash): $($entry.path)"
  }
}

$buildInfo = [ordered]@{
  builtAtUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  targetStore = "Microsoft Edge Add-ons"
  sourceRoot = $repoRoot
  packagedExtensionPath = $distExtension
  mirrorExtensionPath = $distMirror
  zipPath = $zipPath
  manifestVersion = $manifest.manifest_version
  extensionVersion = $manifest.version
  sourceRef = $sourceCodeMetadata.sourceRef
  sourceCodeUrl = $sourceCodeMetadata.sourceCodeUrl
  sourceTarballUrl = $sourceCodeMetadata.sourceTarballUrl
  firstPopupFlowDetected = $hasFirstPopup
  fileHashes = $hashes
}
$buildInfo | ConvertTo-Json -Depth 6 | Set-Content -Path $buildInfoPath -Encoding ASCII

Write-Host "Packaging public source release..."
& $packagePublicSourceScript
if ($LASTEXITCODE -ne 0) { throw "package-public-source.ps1 failed." }

$sourceArchivePath = Join-Path $repoRoot "dist\talon-defender-extension-source-v$($manifest.version).zip"
$sourceManifestPath = Join-Path $repoRoot "dist\source-release.json"

Write-Host "Syncing latest artifact workspace..."
& $syncLatestScript `
  -Channel "edge" `
  -ZipPath $zipPath `
  -BuildInfoPath $buildInfoPath `
  -SourceArchivePath $sourceArchivePath `
  -SourceManifestPath $sourceManifestPath
if ($LASTEXITCODE -ne 0) { throw "sync-latest-artifacts.ps1 failed." }

$zipItem = Get-Item $zipPath
Write-Host ""
Write-Host "Edge extension release package ready:"
Write-Host "  Unpacked: $distExtension"
Write-Host "  Zip:      $zipPath"
Write-Host "  Built:    $($zipItem.LastWriteTime)"
Write-Host "  Size:     $($zipItem.Length) bytes"
Write-Host "  Info:     $buildInfoPath"
Write-Host "  Latest:   $(Join-Path (Split-Path -Parent $repoRoot) 'Talon Defender Latest\edge')"
