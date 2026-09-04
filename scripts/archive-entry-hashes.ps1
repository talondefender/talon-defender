param([Parameter(Mandatory=$true)][string]$ArchivePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
$hashes = [ordered]@{}
try {
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if ($name.EndsWith('/')) { continue }
    if ($name.StartsWith('/') -or $name.Contains(':') -or $name.Split('/') -contains '..' -or $hashes.Contains($name)) {
      throw "Invalid or duplicate archive path: $name"
    }
    $stream = $entry.Open()
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashes[$name] = [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
      $stream.Dispose()
    }
  }
} finally { $archive.Dispose() }
$hashes | ConvertTo-Json -Depth 3 -Compress
