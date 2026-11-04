$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$version = '24.18.0-0'
$expected = 'ceb86b0b8130006195a60cd37393ebe0fd665b644ce8d5674dfba1da65d3be28'
$archive = Join-Path ([IO.Path]::GetTempPath()) "nodejs-mobile-android-$version.zip"
$url = "https://github.com/gmaclennan/nodejs-mobile/releases/download/v$version/nodejs-mobile-android-$version.zip"
if (-not (Test-Path $archive)) { Invoke-WebRequest $url -OutFile $archive }
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Node Mobile archive SHA256 mismatch'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $wanted = @{
        'bin/arm64-v8a/libnode.so' = 'app/src/main/jniLibs/arm64-v8a/libnode.so'
        'bin/x86_64/libnode.so' = 'app/src/main/jniLibs/x86_64/libnode.so'
    }
    foreach ($entry in $zip.Entries) {
        $target = $wanted[$entry.FullName]
        if (-not $target -and $entry.FullName.StartsWith('include/node/') -and $entry.Name) {
            $target = 'app/src/main/cpp/node-include/' + $entry.FullName.Substring(13)
        }
        if ($target) {
            $path = Join-Path $root $target
            New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
        }
    }
} finally { $zip.Dispose() }
