$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$version = '24.18.0-0'
# 内嵌 small-icu（ICU 78.3）缺分词数据；Android payload 由 host-core/build-android.js
# 附带官方 icudt78l.dat 并经 NODE_ICU_DATA 生效。升级此版本时同步匹配 ICU 主版本与 dat 文件名。
$expected = 'ceb86b0b8130006195a60cd37393ebe0fd665b644ce8d5674dfba1da65d3be28'
$cacheDir = Join-Path $root 'build/cache'
New-Item -ItemType Directory -Force $cacheDir | Out-Null
$archive = Join-Path $cacheDir "nodejs-mobile-android-$version.zip"
$url = "https://github.com/gmaclennan/nodejs-mobile/releases/download/v$version/nodejs-mobile-android-$version.zip"
if (-not (Test-Path $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    Invoke-WebRequest $url -OutFile $archive
}
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
