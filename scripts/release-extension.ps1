Param(
  [switch]$SkipPackageStep,
  [switch]$StageOnly
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
$distExtension = Join-Path $repoRoot "dist\extension"
$distMirror = Join-Path $repoRoot "dist\talon-defender-extension"
$zipPath = Join-Path $repoRoot "dist\talon-defender-extension.zip"
$buildInfoPath = Join-Path $repoRoot "dist\extension-build-info.json"
$packagePublicSourceScript = Join-Path $scriptDir "package-public-source.ps1"
$syncLatestScript = Join-Path $scriptDir "sync-latest-artifacts.ps1"

Write-Host "Running quality gate (tests + public-safe audit + package + MV3 validation)..."
Push-Location $repoRoot
try {
  node scripts/verify-release.mjs --release --target chrome
  if ($LASTEXITCODE -ne 0) { throw "Required chrome release verification failed." }
}
finally {
  Pop-Location
}

# The gate verifies the exact package in Chrome; continue with release packaging steps.
$SkipPackageStep = $true

if (-not $SkipPackageStep) {
  Write-Host "Packaging extension from source..."
  Push-Location $repoRoot
  try {
    node scripts/package-extension.mjs
    if ($LASTEXITCODE -ne 0) { throw "package-extension.mjs failed." }
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $distExtension "manifest.json"))) {
  throw "Missing packaged extension manifest at $distExtension"
}

if (Test-Path $distMirror) {
  Remove-Item $distMirror -Recurse -Force
}
New-Item -ItemType Directory -Path $distMirror | Out-Null
Copy-Item -Path (Join-Path $distExtension "*") -Destination $distMirror -Recurse -Force

Write-Host "Running MV3 package validation..."
Push-Location $repoRoot
try {
  node scripts/validate-mv3-package.mjs --dir dist/extension
  if ($LASTEXITCODE -ne 0) { throw "validate-mv3-package.mjs failed." }
  node scripts/validate-mv3-package.mjs --dir dist/talon-defender-extension
  if ($LASTEXITCODE -ne 0) { throw "validate-mv3-package.mjs failed for mirror package." }
}
finally {
  Pop-Location
}

$criticalFiles = @(
  "manifest.json",
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
  "source-code.json"
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

if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

Push-Location $repoRoot
try {
  node scripts/verify-release.mjs --release --target chrome --check-evidence
  if ($LASTEXITCODE -ne 0) { throw "Verified artifact changed before handoff." }
} finally { Pop-Location }

Write-Host "Creating extension zip..."
New-ZipFromDirectoryFilesOnly -SourceDir $distExtension -DestinationZip $zipPath

$manifest = Get-Content (Join-Path $distExtension "manifest.json") -Raw | ConvertFrom-Json
$buildInfo = [ordered]@{
  builtAtUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
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

Push-Location $repoRoot
try {
  node scripts/verify-release.mjs --release --target chrome --record-handoff
  if ($LASTEXITCODE -ne 0) { throw "ZIP/source handoff verification failed." }
} finally { Pop-Location }

if (-not $StageOnly) {
Write-Host "Syncing latest artifact workspace..."
& $syncLatestScript `
  -Channel "chrome" `
  -ZipPath $zipPath `
  -BuildInfoPath $buildInfoPath `
  -SourceArchivePath $sourceArchivePath `
  -SourceManifestPath $sourceManifestPath
if ($LASTEXITCODE -ne 0) { throw "sync-latest-artifacts.ps1 failed." }
} else {
  Write-Host "Verified release artifacts staged in dist; Latest promotion deferred."
}

$zipItem = Get-Item $zipPath
Write-Host ""
Write-Host "Extension release package ready:"
Write-Host "  Unpacked: $distExtension"
Write-Host "  Zip:      $zipPath"
Write-Host "  Built:    $($zipItem.LastWriteTime)"
Write-Host "  Size:     $($zipItem.Length) bytes"
Write-Host "  Info:     $buildInfoPath"
if (-not $StageOnly) { Write-Host "  Latest:   $(Join-Path (Split-Path -Parent $repoRoot) 'Talon Defender Latest\chrome')" }
