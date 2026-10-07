# Usage: powershell -File scripts/package-windows.ps1   (`just package-windows`, on Windows)
#
# The Windows installers, from one release build packaged twice: an NSIS per-user installer
# (GitBolt_<version>_x64-setup.exe) and a per-machine MSI (GitBolt_<version>_x64.msi), in
# target\release\bundle\windows\. Steps:
#   1. the license notices (scripts/licenses.sh, in Git for Windows' bash), then the UI build;
#   2. gitbolt-app as a DLL, release, with the UI embedded;
#   3. the staged layout, target\release\windows\GitBolt\: CEF's bootstrap.exe as GitBolt.exe
#      (from the same CEF build as the one linked: checked) with our icon, version information
#      and manifest, the DLL as GitBolt.dll (the bootstrap loads <its name>.dll and runs it
#      sandboxed), the CEF runtime files, the spell-check dictionary and the notices in licenses\;
#   4. the installers from that folder (packaging\windows\gitbolt.nsi and gitbolt.wxs).
# The packaging tools (NSIS, WiX, rcedit) are pinned and downloaded into target\windows-tools on
# first use; nothing is installed system-wide. Needs Rust, Node with ui\node_modules (npm ci),
# Git for Windows, Python 3 ($env:PYTHON, else python3 or python on PATH), cargo-about 0.9.2,
# the .NET SDK (WiX is a .NET tool) and Visual Studio's C++ build tools with their Ninja on PATH
# (the CEF wrapper).
#
# Versions follow scripts/package-version.sh: tauri.conf.json's version with a build stamp
# (<version>+<UTC YYYYMMDDHHMM>.<commit>), or GITBOLT_RELEASE_VERSION for a release, which must
# equal it. Windows' numeric versions (the MSI's ProductVersion, the files' FILEVERSION) are
# X.Y.Z.0 for all of them: see docs/releasing.md.
#
# Signing (none yet): set GITBOLT_SIGN_COMMAND to a command that signs the file path appended to
# it in place, e.g. `signtool sign /fd sha256 /tr <timestamp url> /td sha256 /f <cert>`. It then
# signs GitBolt.exe and GitBolt.dll (the bootstrap only loads a DLL signed with its own
# certificate once it is signed itself), the NSIS installer and its uninstaller, and the MSI.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue' # Expand-Archive's progress bar slows it down

$root = Split-Path -Parent $PSScriptRoot
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'target' }
$tools = Join-Path $target 'windows-tools'
$stage = Join-Path $target 'release\windows\GitBolt'
$out = Join-Path $target 'release\bundle\windows'
$conf = Get-Content -Raw (Join-Path $root 'crates\gitbolt-app\tauri.conf.json') | ConvertFrom-Json

function Fail([string]$msg) { throw "package-windows: $msg" }

# Runs a native command and fails on a nonzero exit (Windows PowerShell 5.1 doesn't). Its output,
# stderr included, goes to the console as plain lines, never into the caller's return value.
function Run([string]$exe) {
  $ErrorActionPreference = 'Continue' # 5.1 turns a redirected stderr line into an error
  & $exe @args 2>&1 | ForEach-Object {
    if ($_ -is [Management.Automation.ErrorRecord]) { Write-Host "$($_.TargetObject)" } else { Write-Host "$_" }
  }
  if ($LASTEXITCODE -ne 0) { Fail "$(Split-Path -Leaf $exe) exited with $LASTEXITCODE" }
}

function Step([string]$msg) { Write-Host "== $msg" -ForegroundColor Cyan }

# A pinned download: fetched once into $tools, checked against its SHA-256.
function Get-Download([string]$url, [string]$file, [string]$sha256) {
  $path = Join-Path $tools $file
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Force $tools | Out-Null
    Write-Host "downloading $url"
    # Windows' curl.exe: SourceForge sends a browser-looking client (Invoke-WebRequest) a web page.
    Run curl.exe -fsSL --retry 3 -o "$path.part" $url
    Move-Item -Force "$path.part" $path
  }
  $actual = (Get-FileHash -Algorithm SHA256 $path).Hash
  if ($actual -ne $sha256) {
    Remove-Item -Force $path
    Fail "$file has SHA-256 $actual, expected $sha256 (deleted; run again to download it anew)"
  }
  $path
}

# --- Tools --------------------------------------------------------------------------------------

function Get-Nsis {
  $dir = Join-Path $tools 'nsis-3.11'
  $exe = Join-Path $dir 'makensis.exe'
  if (-not (Test-Path $exe)) {
    $zip = Get-Download 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip' `
      'nsis-3.11.zip' 'C7D27F780DDB6CFFB4730138CD1591E841F4B7EDB155856901CDF5F214394FA1'
    Expand-Archive -Force $zip $tools
  }
  $exe
}

function Get-Rcedit {
  Get-Download 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' `
    'rcedit-2.0.0-x64.exe' '3E7801DB1A5EDBEC91B49A24A094AAD776CB4515488EA5A4CA2289C400EADE2A'
}

# WiX v5, a .NET tool (NuGet checks the package's signature), installed into $tools only.
function Get-Wix {
  $dir = Join-Path $tools 'wix-5.0.2'
  $exe = Join-Path $dir 'wix.exe'
  if (-not (Test-Path $exe)) {
    if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Fail "the .NET SDK isn't installed (WiX needs it)" }
    # No telemetry, no first-run certificate, and NuGet's caches in $tools too.
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_NOLOGO = '1'
    $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
    $env:NUGET_PACKAGES = Join-Path $tools 'nuget\packages'
    $env:NUGET_HTTP_CACHE_PATH = Join-Path $tools 'nuget\http-cache'
    Run dotnet tool install wix --version 5.0.2 --tool-path $dir
  }
  $exe
}

# Git for Windows' usr\bin, with its bash (never WSL's C:\Windows\System32\bash.exe), sed, uname
# and the like.
function Get-GitUsrBin {
  $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $git) { Fail "Git for Windows isn't on PATH" }
  $usr = Join-Path (Split-Path -Parent (Split-Path -Parent $git.Source)) 'usr\bin'
  if (-not (Test-Path (Join-Path $usr 'bash.exe'))) { Fail "no usr\bin\bash.exe in $($git.Source)'s Git for Windows" }
  (Resolve-Path $usr).Path
}

function Get-Python {
  if ($env:PYTHON) { return $env:PYTHON }
  foreach ($name in @('python3', 'python')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    # Skip the Microsoft Store's placeholder, which only opens the Store.
    if ($cmd -and $cmd.Source -notlike '*\WindowsApps\*') { return $cmd.Source }
  }
  Fail "Python 3 isn't on PATH"
}

# --- Versions -----------------------------------------------------------------------------------

$python = Get-Python
$base = $conf.version
if ($env:GITBOLT_RELEASE_VERSION) {
  Run $python (Join-Path $root 'scripts\version.py') check $env:GITBOLT_RELEASE_VERSION
  if ($env:GITBOLT_RELEASE_VERSION -ne $base) {
    Fail "GITBOLT_RELEASE_VERSION=$env:GITBOLT_RELEASE_VERSION doesn't match tauri.conf.json's $base"
  }
  $version = $base
} else {
  $commit = (& git -C $root rev-parse --short HEAD)
  if ($LASTEXITCODE -ne 0) { Fail "git rev-parse failed" }
  $version = "$base+$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm')).$commit"
}
if ($base -notmatch '^(\d+)\.(\d+)\.(\d+)') { Fail "can't read X.Y.Z from tauri.conf.json's version $base" }
# Windows Installer compares only the first three fields, each at most 255.255.65535.
if ([int]$Matches[1] -gt 255 -or [int]$Matches[2] -gt 255 -or [int]$Matches[3] -gt 65535) { Fail "$base is out of Windows' version range" }
$numeric = "$($Matches[1]).$($Matches[2]).$($Matches[3]).0"
$product = $conf.productName
$copyright = (Select-String -Path (Join-Path $root 'LICENSE') -Pattern '^Copyright ' | Select-Object -First 1).Line
if (-not $copyright) { Fail "no Copyright line in LICENSE" }
$publisher = $product

# CEF: the version the cef crate in Cargo.lock builds against, in CEF_PATH (cargo tauri's default
# %LOCALAPPDATA%\tauri-cef), where the cef-dll-sys build script downloads and unpacks it.
$lock = Get-Content -Raw (Join-Path $root 'Cargo.lock')
if ($lock -notmatch 'name = "cef"\r?\nversion = "[^+"]*\+([^"]+)"') { Fail "no CEF version in Cargo.lock's cef entry" }
$cefVersion = $Matches[1]
if (-not $env:CEF_PATH) { $env:CEF_PATH = Join-Path $env:LOCALAPPDATA 'tauri-cef' }
$cefDir = Join-Path $env:CEF_PATH "$cefVersion\cef_windows_x86_64"
Write-Host "GitBolt $version (Windows $numeric), CEF $cefVersion"

# A CARGO_INCREMENTAL=0 from the caller would override the release profile's (Cargo.toml).
Remove-Item Env:CARGO_INCREMENTAL -ErrorAction SilentlyContinue
if (-not $env:CARGO_BUILD_JOBS) { $env:CARGO_BUILD_JOBS = '4' }

# --- Build --------------------------------------------------------------------------------------

if (-not (Test-Path (Join-Path $cefDir 'CREDITS.html'))) {
  Step "CEF $cefVersion (cef-dll-sys's build downloads it)"
  Push-Location $root
  try { Run cargo build --release --locked -p cef-dll-sys } finally { Pop-Location }
}

Step 'license notices (scripts/licenses.sh)'
$usr = Get-GitUsrBin
$env:PYTHON = $python
# Only for this step: Git's usr\bin also has a link.exe, which must not hide MSVC's from cargo.
$path, $cef = $env:PATH, $env:CEF_PATH
$env:PATH = "$usr;$env:PATH"
$env:CEF_PATH = $cef -replace '\\', '/'
Push-Location $root
try { Run (Join-Path $usr 'bash.exe') scripts/licenses.sh } finally { Pop-Location; $env:PATH, $env:CEF_PATH = $path, $cef }

Step 'UI build (npm run build)'
Push-Location (Join-Path $root 'ui')
try { Run npm.cmd run build } finally { Pop-Location }

Step 'gitbolt-app as a DLL, release, with the UI embedded'
# The version the app shows and compares updates against (the status bar, the update check).
$env:GITBOLT_BUILD_VERSION = $version
Push-Location $root
try {
  Run cargo rustc -p gitbolt-app --lib --release --locked --crate-type cdylib --features tauri/custom-protocol
} finally { Pop-Location }
$dll = Join-Path $target 'release\gitbolt_app.dll'
if (-not (Test-Path $dll)) { Fail "the build made no $dll" }

# --- Stage --------------------------------------------------------------------------------------

Step "staging $stage"
if (-not (Test-Path (Join-Path $cefDir 'libcef.dll'))) { Fail "no CEF $cefVersion in $cefDir" }
# The bootstrap must come from the CEF build we link: RunWinMain doesn't check.
$bootVer = (Get-Item (Join-Path $cefDir 'bootstrap.exe')).VersionInfo.FileVersion
$libVer = (Get-Item (Join-Path $cefDir 'libcef.dll')).VersionInfo.FileVersion
if ($bootVer -ne $libVer -or -not $libVer.StartsWith("$cefVersion+")) {
  Fail "bootstrap.exe ($bootVer) and libcef.dll ($libVer) aren't both CEF $cefVersion"
}
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage, (Join-Path $stage 'dictionaries'), (Join-Path $stage 'licenses') | Out-Null
Copy-Item (Join-Path $cefDir 'bootstrap.exe') (Join-Path $stage 'GitBolt.exe')
Copy-Item $dll (Join-Path $stage 'GitBolt.dll')
# CEF's runtime: its DLLs, resources and locales; not its headers, wrapper sources, import
# library, bootstrap executables or credits (those ship as notices).
Get-ChildItem $cefDir -File | Where-Object {
  $_.Extension -in '.dll', '.pak', '.dat', '.bin' -or $_.Name -eq 'vk_swiftshader_icd.json'
} | Copy-Item -Destination $stage
Copy-Item -Recurse (Join-Path $cefDir 'locales') $stage
Copy-Item (Join-Path $root 'crates\gitbolt-app\dictionaries\en-US-10-1.bdic') (Join-Path $stage 'dictionaries')
$licenses = Join-Path $target 'licenses'
foreach ($f in 'LICENSE', 'THIRD-PARTY-NOTICES-rust.txt', 'CEF-LICENSE.txt', 'CHROMIUM-CREDITS.html.gz', 'DICTIONARY-en-US-LICENSE.txt') {
  Copy-Item (Join-Path $licenses $f) (Join-Path $stage 'licenses')
}
Copy-Item (Join-Path $root 'ui\dist\licenses\THIRD-PARTY-NOTICES-ui.txt') (Join-Path $stage 'licenses')
Get-ChildItem (Join-Path $stage 'licenses') | ForEach-Object { if ($_.Length -eq 0) { Fail "$($_.FullName) is empty" } }

Step 'resources: icon, version information, manifest'
$rcedit = Get-Rcedit
$icon = Join-Path $root 'crates\gitbolt-app\icons\icon.ico'
$common = @(
  '--set-file-version', $numeric, '--set-product-version', $numeric,
  '--set-version-string', 'ProductName', $product,
  '--set-version-string', 'ProductVersion', $version,
  '--set-version-string', 'FileVersion', $version,
  '--set-version-string', 'CompanyName', $publisher,
  '--set-version-string', 'LegalCopyright', $copyright,
  '--set-version-string', 'Comments', $conf.bundle.shortDescription
)
Run $rcedit (Join-Path $stage 'GitBolt.exe') @common --set-icon $icon `
  --set-version-string FileDescription $product `
  --set-version-string InternalName GitBolt --set-version-string OriginalFilename GitBolt.exe `
  --application-manifest (Join-Path $root 'packaging\windows\GitBolt.exe.manifest')
Run $rcedit (Join-Path $stage 'GitBolt.dll') @common `
  --set-version-string FileDescription "$product application library" `
  --set-version-string InternalName GitBolt --set-version-string OriginalFilename GitBolt.dll

function Invoke-Sign([string]$path) {
  if (-not $env:GITBOLT_SIGN_COMMAND) { return }
  Write-Host "signing $path"
  & cmd.exe /d /c "$env:GITBOLT_SIGN_COMMAND `"$path`""
  if ($LASTEXITCODE -ne 0) { Fail "GITBOLT_SIGN_COMMAND failed on $path" }
}
# The same certificate for both: a signed bootstrap refuses a DLL signed by another.
Invoke-Sign (Join-Path $stage 'GitBolt.exe')
Invoke-Sign (Join-Path $stage 'GitBolt.dll')

# --- Installers ---------------------------------------------------------------------------------

New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter 'GitBolt_*' | Remove-Item -Force
$files = Get-ChildItem -Recurse -File $stage
$size = ($files | Measure-Object -Sum Length).Sum

Step 'NSIS installer (per user)'
# The uninstaller removes exactly the files installed, never the whole folder (the user picks it).
$work = Join-Path $target 'release\windows'
$list = @()
foreach ($f in $files) { $list += "Delete `"`$INSTDIR\$($f.FullName.Substring($stage.Length + 1))`"" }
$dirs = Get-ChildItem -Recurse -Directory $stage | Sort-Object { $_.FullName.Length } -Descending
foreach ($d in $dirs) { $list += "RMDir `"`$INSTDIR\$($d.FullName.Substring($stage.Length + 1))`"" }
$uninstallList = Join-Path $work 'uninstall-files.nsh'
[IO.File]::WriteAllLines($uninstallList, $list, (New-Object Text.UTF8Encoding $true))
$setup = Join-Path $out "GitBolt_${version}_x64-setup.exe"
$nsisArgs = @(
  '/V2', '/INPUTCHARSET', 'UTF8',
  "/DVERSION=$version", "/DVERSION_NUMERIC=$numeric", "/DPUBLISHER=$publisher", "/DCOPYRIGHT=$copyright",
  "/DSTAGE=$stage", "/DUNINSTALL_LIST=$uninstallList", "/DICON=$icon", "/DOUTFILE=$setup",
  "/DESTIMATED_SIZE_KB=$([math]::Ceiling($size / 1KB))"
)
if ($env:GITBOLT_SIGN_COMMAND) { $nsisArgs += "/DSIGN_COMMAND=$env:GITBOLT_SIGN_COMMAND" }
Run (Get-Nsis) @nsisArgs (Join-Path $root 'packaging\windows\gitbolt.nsi')
Invoke-Sign $setup

Step 'MSI (per machine)'
$msi = Join-Path $out "GitBolt_${version}_x64.msi"
Run (Get-Wix) build -nologo -arch x64 -d "Version=$numeric" -d "DisplayVersion=$version" `
  -d "Publisher=$publisher" -d "Icon=$icon" -d "InstallKind=$(Join-Path $root 'packaging\windows\install-kind-msi')" -bindpath "stage=$stage" `
  -intermediatefolder (Join-Path $work 'wix') -o $msi (Join-Path $root 'packaging\windows\gitbolt.wxs')
Remove-Item -Force -ErrorAction SilentlyContinue ([IO.Path]::ChangeExtension($msi, '.wixpdb'))
# Windows Installer's own consistency checks (ICE). ICE61 only notes AllowSameVersionUpgrades.
Run (Get-Wix) msi validate -nologo -sice ICE61 $msi
# The update check finds its installer by the MSI's install-kind file (crates/gitbolt-core/src/updates/install.rs).
$decompiled = Join-Path $work 'decompiled.wxs'
Run (Get-Wix) msi decompile $msi -o $decompiled
if (-not (Select-String -Quiet -SimpleMatch 'Name="install-kind"' $decompiled)) { Fail "the MSI has no install-kind file" }
Invoke-Sign $msi

Step 'done'
Write-Host ("staged: {0} files, {1:N0} MB" -f $files.Count, ($size / 1MB))
Get-ChildItem $out -Filter 'GitBolt_*' | ForEach-Object { Write-Host ("{0}  {1:N1} MB" -f $_.FullName, ($_.Length / 1MB)) }
