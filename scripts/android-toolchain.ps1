[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Build', 'Adb')]
    [string]$Action = 'Status',
    [switch]$AcceptAndroidLicense,
    [string]$ProjectPath = 'android',
    [string[]]$GradleTasks = @('assembleDebug'),
    [string[]]$AdbArguments = @('devices', '-l')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolchainRoot = Join-Path $repositoryRoot '.work/android-toolchain'
$downloadRoot = Join-Path $toolchainRoot 'downloads'
$jdkRoot = Join-Path $toolchainRoot 'jdk-17.0.21+9'
$gradleRoot = Join-Path $toolchainRoot 'gradle-8.11.1'
$sdkRoot = Join-Path $toolchainRoot 'sdk'
$sdkManager = Join-Path $sdkRoot 'cmdline-tools/latest/bin/sdkmanager.bat'
$gradle = Join-Path $gradleRoot 'bin/gradle.bat'
$adb = Join-Path $sdkRoot 'platform-tools/adb.exe'

# Official sources, pinned versions and published SHA-256 checksums. Nothing is
# installed globally; environment changes apply only to this script's process.
$archives = @(
    @{
        Name = 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip'
        Url = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21%2B9/OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip'
        Sha256 = '98518ecf554465057ee5509462631deeee374bc368c12a411d225cd29381f84b'
        ReadyPath = (Join-Path $jdkRoot 'bin/java.exe')
        Destination = $toolchainRoot
    },
    @{
        Name = 'gradle-8.11.1-bin.zip'
        Url = 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip'
        Sha256 = 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6'
        ReadyPath = $gradle
        Destination = $toolchainRoot
    },
    @{
        Name = 'commandlinetools-win-15859902_latest.zip'
        Url = 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip'
        Sha256 = '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
        ReadyPath = $sdkManager
        Destination = (Join-Path $toolchainRoot 'commandline-unpack')
    }
)

function Install-Archive([hashtable]$Archive) {
    if (Test-Path -LiteralPath $Archive.ReadyPath) { return }
    New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
    $archivePath = Join-Path $downloadRoot $Archive.Name
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Write-Host "Downloading $($Archive.Name) from its official publisher..."
        & curl.exe --fail --location --retry 2 --output $archivePath $Archive.Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($Archive.Name)" }
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $Archive.Sha256) {
        throw "SHA-256 mismatch for $($Archive.Name). Remove the incomplete download and retry."
    }
    Write-Host "Verified SHA-256: $($Archive.Name)"
    Expand-Archive -LiteralPath $archivePath -DestinationPath $Archive.Destination -Force
}

function Set-ToolchainEnvironment {
    $env:JAVA_HOME = $jdkRoot
    $env:ANDROID_HOME = $sdkRoot
    $env:ANDROID_SDK_ROOT = $sdkRoot
    $env:GRADLE_USER_HOME = Join-Path $toolchainRoot 'gradle-user-home'
    $env:ANDROID_USER_HOME = Join-Path $toolchainRoot 'android-user-home'
    $env:PATH = "$(Join-Path $jdkRoot 'bin');$(Join-Path $sdkRoot 'platform-tools');$env:PATH"
}

function Get-ToolchainStatus {
    [PSCustomObject]@{
        Jdk = (Test-Path -LiteralPath (Join-Path $jdkRoot 'bin/java.exe'))
        Gradle = (Test-Path -LiteralPath $gradle)
        SdkManager = (Test-Path -LiteralPath $sdkManager)
        Android36 = (Test-Path -LiteralPath (Join-Path $sdkRoot 'platforms/android-36/android.jar'))
        BuildTools35 = (Test-Path -LiteralPath (Join-Path $sdkRoot 'build-tools/35.0.0/aapt2.exe'))
        Adb = (Test-Path -LiteralPath $adb)
        SdkLicense = (Test-Path -LiteralPath (Join-Path $sdkRoot 'licenses/android-sdk-license'))
        JavaHome = $jdkRoot
        AndroidSdk = $sdkRoot
        GradleExecutable = $gradle
    }
}

switch ($Action) {
    'Install' {
        Install-Archive $archives[0]
        Install-Archive $archives[1]
        Set-ToolchainEnvironment
        if (-not $AcceptAndroidLicense) {
            Get-ToolchainStatus | Format-List
            throw 'Android SDK installation needs explicit acceptance of https://developer.android.com/studio#terms . After acceptance, rerun with -Action Install -AcceptAndroidLicense.'
        }
        Install-Archive $archives[2]
        if (-not (Test-Path -LiteralPath $sdkManager)) {
            $commandlineSource = Join-Path $toolchainRoot 'commandline-unpack/cmdline-tools'
            $commandlineTarget = Join-Path $sdkRoot 'cmdline-tools/latest'
            New-Item -ItemType Directory -Force -Path $commandlineTarget | Out-Null
            Copy-Item -LiteralPath (Join-Path $commandlineSource 'bin') -Destination $commandlineTarget -Recurse -Force
            Copy-Item -LiteralPath (Join-Path $commandlineSource 'lib') -Destination $commandlineTarget -Recurse -Force
            Copy-Item -LiteralPath (Join-Path $commandlineSource 'NOTICE.txt') -Destination $commandlineTarget -Force
            Copy-Item -LiteralPath (Join-Path $commandlineSource 'source.properties') -Destination $commandlineTarget -Force
        }
        # Only the selected base SDK packages are requested. Do not accept every
        # optional emulator/third-party license via sdkmanager --licenses.
        @('y', 'y') | & $sdkManager "--sdk_root=$sdkRoot" 'platforms;android-36' 'build-tools;35.0.0' 'platform-tools'
        if ($LASTEXITCODE -ne 0) { throw "sdkmanager failed with exit code $LASTEXITCODE" }
        Get-ToolchainStatus | Format-List
    }
    'Status' {
        Get-ToolchainStatus | Format-List
        if (Test-Path -LiteralPath (Join-Path $jdkRoot 'bin/java.exe')) {
            & (Join-Path $jdkRoot 'bin/java.exe') -version
        }
    }
    'Build' {
        $status = Get-ToolchainStatus
        if (-not ($status.Jdk -and $status.Gradle -and $status.Android36 -and $status.BuildTools35 -and $status.SdkLicense)) {
            throw 'Portable Android toolchain is incomplete. Run -Action Install first.'
        }
        Set-ToolchainEnvironment
        $androidProject = if ([IO.Path]::IsPathRooted($ProjectPath)) { $ProjectPath } else { Join-Path $repositoryRoot $ProjectPath }
        if (-not (Test-Path -LiteralPath $androidProject -PathType Container)) { throw "Project not found: $androidProject" }
        & $gradle --no-daemon --console=plain -p $androidProject @GradleTasks
        if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
    }
    'Adb' {
        if (-not (Test-Path -LiteralPath $adb)) { throw 'Portable platform-tools are not installed.' }
        Set-ToolchainEnvironment
        & $adb @AdbArguments
        if ($LASTEXITCODE -ne 0) { throw "adb failed with exit code $LASTEXITCODE" }
    }
}
