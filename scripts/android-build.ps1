#requires -Version 7.2
param(
    [ValidateSet('prepare', 'resolve', 'build', 'all')]
    [string]$Phase = 'all',
    [switch]$AcceptAndroidSdkLicense
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [Runtime.InteropServices.Architecture]::X64) {
    throw 'This isolated toolchain script targets Windows x64. Use the documented native toolchain on other hosts.'
}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolchainRoot = Join-Path $projectRoot '.toolchains'
$gradleCache = Join-Path $projectRoot '.gradle-cache'
$sdkRoot = Join-Path $toolchainRoot 'android-sdk'
$archiveRoot = Join-Path $toolchainRoot 'downloads'
$jdkRoot = Join-Path $toolchainRoot 'jdk-21.0.12.1+1'
$gradleRoot = Join-Path $toolchainRoot 'gradle-8.14.3'
$sdkToolsRoot = Join-Path $sdkRoot 'cmdline-tools\22.0'
$androidUserRoot = Join-Path $toolchainRoot 'android-user'
$javaUserRoot = Join-Path $toolchainRoot 'java-user'
$temporaryRoot = Join-Path $toolchainRoot 'tmp'
$androidProject = Join-Path $projectRoot 'mobile\android'

function Assert-ProjectPath([string]$Candidate) {
    $absolute = [IO.Path]::GetFullPath($Candidate)
    if (-not $absolute.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside project: $absolute"
    }
    # Refuse existing junctions or symbolic links at every descendant component.
    $relative = [IO.Path]::GetRelativePath($projectRoot, $absolute)
    $current = $projectRoot
    foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing linked toolchain path: $current"
            }
        }
    }
    return $absolute
}

function New-ProjectDirectory([string]$Directory) {
    $checked = Assert-ProjectPath $Directory
    [IO.Directory]::CreateDirectory($checked) | Out-Null
}

function Get-VerifiedArchive([string]$Url, [string]$FileName, [string]$Sha256) {
    if ($Sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Expected a complete pinned SHA256.' }
    $destination = Assert-ProjectPath (Join-Path $archiveRoot $FileName)
    if (Test-Path -LiteralPath $destination) {
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256) {
            Write-Host "Verified cached archive: $FileName"
            return $destination
        }
        throw "Cached archive hash mismatch; inspect and remove this exact file before retrying: $destination"
    }
    $partial = Assert-ProjectPath ($destination + '.partial')
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    Write-Host "Downloading official archive: $FileName"
    try {
        # Stream directly to the project-local partial file; do not buffer large ZIPs in memory.
        $httpHandler = [Net.Http.SocketsHttpHandler]::new()
        $httpHandler.ConnectTimeout = [TimeSpan]::FromSeconds(30)
        $httpHandler.MaxAutomaticRedirections = 10
        $httpClient = [Net.Http.HttpClient]::new($httpHandler)
        $downloadTimeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(10))
        $httpResponse = $null
        $inputStream = $null
        $outputStream = $null
        try {
            $httpResponse = $httpClient.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $downloadTimeout.Token).GetAwaiter().GetResult()
            $httpResponse.EnsureSuccessStatusCode() | Out-Null
            if ($httpResponse.Content.Headers.ContentLength -gt 536870912) { throw 'Unexpected archive larger than 512 MiB.' }
            $inputStream = $httpResponse.Content.ReadAsStream()
            $outputStream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            $buffer = [byte[]]::new(1048576)
            $received = 0L
            $lastReported = 0L
            while (($read = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $downloadTimeout.Token).GetAwaiter().GetResult()) -gt 0) {
                $received += $read
                if ($received -gt 536870912) { throw 'Unexpected archive larger than 512 MiB.' }
                $outputStream.Write($buffer, 0, $read)
                if ($received - $lastReported -ge 26214400) {
                    Write-Host ("Downloaded {0}: {1:N0} MiB" -f $FileName, ($received / 1MB))
                    $lastReported = $received
                }
            }
            $outputStream.Flush($true)
        } finally {
            if ($outputStream) { $outputStream.Dispose() }
            if ($inputStream) { $inputStream.Dispose() }
            if ($httpResponse) { $httpResponse.Dispose() }
            $downloadTimeout.Dispose()
            $httpClient.Dispose()
            $httpHandler.Dispose()
        }
        $actual = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $Sha256) { throw "SHA256 mismatch for $FileName. Expected $Sha256, received $actual" }
        Move-Item -LiteralPath $partial -Destination $destination
    } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        throw
    }
    Write-Host "SHA256 verified: $FileName"
    return $destination
}

function Expand-VerifiedArchive([string]$Archive, [string]$Destination, [string]$ExpectedEntry) {
    $destinationPath = Assert-ProjectPath $Destination
    $expectedPath = Assert-ProjectPath $ExpectedEntry
    if (Test-Path -LiteralPath $expectedPath) { return }
    New-ProjectDirectory $destinationPath
    $archiveHandle = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $archiveHandle.Entries) {
            $entryPath = [IO.Path]::GetFullPath((Join-Path $destinationPath $entry.FullName))
            if (-not $entryPath.StartsWith($destinationPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Archive contains an escaping path.'
            }
        }
    } finally { $archiveHandle.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $destinationPath, $true)
    if (-not (Test-Path -LiteralPath $expectedPath)) { throw "Expected tool missing after extraction: $expectedPath" }
}

function Invoke-Tool([string]$Executable, [string[]]$Arguments, [string[]]$InputLines = @()) {
    if ($InputLines.Count) { $InputLines | & $Executable @Arguments }
    else { & $Executable @Arguments }
    if ($LASTEXITCODE -ne 0) { throw "Tool failed with exit code $LASTEXITCODE`: $Executable" }
}

function Get-WebAssetSnapshot([string]$Directory) {
    $checkedDirectory = Assert-ProjectPath $Directory
    $snapshot = [ordered]@{}
    foreach ($entry in Get-ChildItem -LiteralPath $checkedDirectory -Recurse -Force | Sort-Object FullName) {
        Assert-ProjectPath $entry.FullName | Out-Null
        if (-not $entry.PSIsContainer) {
            $relative = [IO.Path]::GetRelativePath($checkedDirectory, $entry.FullName).Replace('\', '/')
            $snapshot[$relative] = (Get-FileHash -LiteralPath $entry.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    if (-not $snapshot.Contains('index.html')) { throw 'Synchronized mobile web assets have no index.html.' }
    return $snapshot
}

function Assert-ApkWebAssets([string]$Apk, [string]$SourceDirectory, [System.Collections.IDictionary]$Snapshot) {
    $currentSnapshot = Get-WebAssetSnapshot $SourceDirectory
    if ($currentSnapshot.Count -ne $Snapshot.Count) { throw 'Mobile web assets changed during the build; synchronize and build again.' }
    $apkArchive = [IO.Compression.ZipFile]::OpenRead($Apk)
    try {
        foreach ($asset in $Snapshot.Keys) {
            if (-not $currentSnapshot.Contains($asset) -or $currentSnapshot[$asset] -ne $Snapshot[$asset]) {
                throw "Mobile web asset changed during the build: $asset"
            }
            $packedEntry = $apkArchive.GetEntry('assets/public/' + $asset)
            if (-not $packedEntry) { throw "APK is missing synchronized mobile web asset: $asset" }
            $entryStream = $packedEntry.Open()
            try { $packedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($entryStream)).ToLowerInvariant() }
            finally { $entryStream.Dispose() }
            if ($packedHash -ne $Snapshot[$asset]) { throw "APK web asset does not match synchronized source: $asset" }
        }
    } finally { $apkArchive.Dispose() }
}

function Get-AndroidVersionInfo {
    $versionTool = Assert-ProjectPath (Join-Path $projectRoot 'mobile\android-version.mjs')
    $result = & $nodeExecutable $versionTool 'check-build'
    if ($LASTEXITCODE -ne 0) { throw 'Android version preflight failed. No APK was copied.' }
    return (($result -join "`n") | ConvertFrom-Json)
}

# Validate before creating toolchain directories or invoking Gradle. Configuration
# is mandatory; sync must already have applied it to the generated project.
$nodeExecutable = $null
$androidVersion = $null
if ($Phase -in @('build', 'all')) {
    $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $androidVersion = Get-AndroidVersionInfo
}

$changedEnvironment = @('JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_USER_HOME', 'ANDROID_SDK_HOME', 'GRADLE_USER_HOME', 'JAVA_TOOL_OPTIONS', 'JAVA_OPTS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS', 'TEMP', 'TMP')
$originalEnvironment = @{}
foreach ($name in $changedEnvironment) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$originalLocation = Get-Location

try {
    foreach ($folder in @($toolchainRoot, $archiveRoot, $sdkRoot, $gradleCache, $androidUserRoot, $javaUserRoot, $temporaryRoot)) { New-ProjectDirectory $folder }
    $env:JAVA_HOME = $jdkRoot
    $env:ANDROID_HOME = $sdkRoot
    $env:ANDROID_SDK_ROOT = $sdkRoot
    $env:ANDROID_USER_HOME = $androidUserRoot
    # AGP rejects differing legacy/new preferences overrides. Only use the modern one.
    $env:ANDROID_SDK_HOME = $null
    $env:GRADLE_USER_HOME = $gradleCache
    # Avoid inherited JVM options overriding the project-local homes or loading agents.
    foreach ($optionName in @('JAVA_OPTS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'GRADLE_OPTS')) { [Environment]::SetEnvironmentVariable($optionName, $null, 'Process') }
    $env:JAVA_TOOL_OPTIONS = "-Duser.home=`"$javaUserRoot`" -Djava.io.tmpdir=`"$temporaryRoot`""
    $env:TEMP = $temporaryRoot
    $env:TMP = $temporaryRoot

    if ($Phase -in @('prepare', 'all')) {
        if (-not $AcceptAndroidSdkLicense) { throw 'Preparation requires explicit -AcceptAndroidSdkLicense authorization. Review https://developer.android.com/studio#terms before proceeding.' }
        $jdkArchive = Get-VerifiedArchive 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip' 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip' 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e'
        Expand-VerifiedArchive $jdkArchive $toolchainRoot (Join-Path $jdkRoot 'bin\java.exe')
        $cliArchive = Get-VerifiedArchive 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' 'commandlinetools-win-15859902_latest.zip' '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
        $cliExtractRoot = Join-Path $toolchainRoot 'cli-extracted'
        Expand-VerifiedArchive $cliArchive $cliExtractRoot (Join-Path $cliExtractRoot 'cmdline-tools\bin\sdkmanager.bat')
        if (-not (Test-Path -LiteralPath (Join-Path $sdkToolsRoot 'bin\sdkmanager.bat'))) {
            New-ProjectDirectory $sdkToolsRoot
            foreach ($item in Get-ChildItem -LiteralPath (Join-Path $cliExtractRoot 'cmdline-tools') -Force) {
                Copy-Item -LiteralPath $item.FullName -Destination $sdkToolsRoot -Recurse -Force
            }
        }
        $gradleArchive = Get-VerifiedArchive 'https://services.gradle.org/distributions/gradle-8.14.3-all.zip' 'gradle-8.14.3-all.zip' 'ed1a8d686605fd7c23bdf62c7fc7add1c5b23b2bbc3721e661934ef4a4911d7c'
        Expand-VerifiedArchive $gradleArchive $toolchainRoot (Join-Path $gradleRoot 'bin\gradle.bat')
        Invoke-Tool (Join-Path $jdkRoot 'bin\java.exe') @('-version')
        $sdkManager = Join-Path $sdkToolsRoot 'bin\sdkmanager.bat'
        $licenseLog = Assert-ProjectPath (Join-Path $toolchainRoot 'android-sdk-license-review.log')
        Invoke-Tool $sdkManager @("--sdk_root=$sdkRoot", '--licenses') (@('y') * 100) | Set-Content -LiteralPath $licenseLog -Encoding utf8
        $acceptedLicenses = @(Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'licenses') -File | ForEach-Object { [ordered]@{ id = $_.Name; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } })
        $receipt = [ordered]@{
            timestampUtc = [DateTime]::UtcNow.ToString('o')
            authorization = 'Explicit user authorization to accept Android SDK licenses and build a local APK.'
            requestedPackages = @('platforms;android-36', 'build-tools;35.0.0')
            licensesAccepted = $acceptedLicenses
            jdk = 'Temurin 21.0.12.1+1'
            commandLineTools = '22.0 (15859902)'
            gradle = '8.14.3'
            sdkPrepared = $false
            scope = 'Project-local development tools only; no publication or device installation.'
        }
        $receiptPath = Assert-ProjectPath (Join-Path $toolchainRoot 'android-preparation.json')
        $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8
        Write-Host ("Accepted SDK license records: " + (($acceptedLicenses | ForEach-Object { $_.id }) -join ', '))
        Invoke-Tool $sdkManager @("--sdk_root=$sdkRoot", '--channel=0', 'platforms;android-36', 'build-tools;35.0.0') (@('y') * 100)
        $receipt.sdkPrepared = $true
        $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8
        Write-Host 'Project-local Android toolchain preparation complete.'
    }

    if ($Phase -eq 'resolve') {
        if (-not (Test-Path -LiteralPath (Join-Path $toolchainRoot 'android-preparation.json'))) { throw 'Run the prepare phase first.' }
        Set-Location -LiteralPath $androidProject
        $gradleExecutable = Assert-ProjectPath (Join-Path $gradleRoot 'bin\gradle.bat')
        $resolveLog = Assert-ProjectPath (Join-Path $toolchainRoot 'android-resolve.log')
        Invoke-Tool $gradleExecutable @(':app:dependencies', '--configuration', 'debugRuntimeClasspath', '--no-daemon', '--console=plain', '--no-scan', '--stacktrace', '--max-workers=2', '-Dorg.gradle.java.installations.auto-download=false') 2>&1 | Tee-Object -FilePath $resolveLog
        Write-Host 'Android dependencies resolved; no APK compilation was requested.'
    }

    if ($Phase -in @('build', 'all')) {
        if (-not (Test-Path -LiteralPath (Join-Path $toolchainRoot 'android-preparation.json'))) { throw 'Run the prepare phase with explicit SDK license authorization first.' }
        foreach ($expected in @((Join-Path $jdkRoot 'bin\java.exe'), (Join-Path $gradleRoot 'bin\gradle.bat'), (Join-Path $sdkRoot 'platforms\android-36\android.jar'), (Join-Path $sdkRoot 'build-tools\35.0.0\aapt2.exe'))) {
            Assert-ProjectPath $expected | Out-Null
            if (-not (Test-Path -LiteralPath $expected)) { throw "Required build tool is missing: $expected" }
        }
        $webAssetRoot = Join-Path $androidProject 'app\src\main\assets\public'
        if (-not (Test-Path -LiteralPath (Join-Path $webAssetRoot 'index.html'))) { throw 'Mobile web assets have not been synchronized. Run mobile prepare/sync first.' }
        $webAssetSnapshot = Get-WebAssetSnapshot $webAssetRoot
        Set-Location -LiteralPath $androidProject
        $buildLog = Assert-ProjectPath (Join-Path $toolchainRoot 'android-build.log')
        Invoke-Tool (Join-Path $gradleRoot 'bin\gradle.bat') @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug', '--no-daemon', '--console=plain', '--no-scan', '--stacktrace', '--max-workers=2', '-Dorg.gradle.java.installations.auto-download=false') 2>&1 | Tee-Object -FilePath $buildLog
        $apk = Assert-ProjectPath (Join-Path $androidProject 'app\build\outputs\apk\debug\app-debug.apk')
        if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle did not produce the expected debug APK.' }
        $afterVersion = Get-AndroidVersionInfo
        if (($androidVersion | ConvertTo-Json -Depth 8 -Compress) -cne ($afterVersion | ConvertTo-Json -Depth 8 -Compress)) {
            throw 'Android version inputs changed during the build. No APK was copied.'
        }
        $versionLog = Assert-ProjectPath (Join-Path $toolchainRoot 'android-apk-version.log')
        Invoke-Tool (Join-Path $sdkRoot 'build-tools\35.0.0\aapt2.exe') @('dump', 'badging', $apk) | Tee-Object -FilePath $versionLog
        $apkVersion = & $nodeExecutable (Join-Path $projectRoot 'mobile\android-version.mjs') 'verify-apk' $versionLog
        if ($LASTEXITCODE -ne 0) { throw 'APK version verification failed. No APK was copied.' }
        $apkVersion = ($apkVersion -join "`n") | ConvertFrom-Json
        if ($apkVersion.versionCode -ne $androidVersion.versionCode -or $apkVersion.versionName -cne $androidVersion.versionName) {
            throw 'APK version changed after preflight. No APK was copied.'
        }
        $signatureLog = Assert-ProjectPath (Join-Path $toolchainRoot 'android-apk-signature.log')
        Invoke-Tool (Join-Path $sdkRoot 'build-tools\35.0.0\apksigner.bat') @('verify', '--verbose', '--print-certs', $apk) 2>&1 | Tee-Object -FilePath $signatureLog
        Assert-ApkWebAssets $apk $webAssetRoot $webAssetSnapshot
        $releaseRoot = Join-Path $projectRoot 'release'
        New-ProjectDirectory $releaseRoot
        $output = Assert-ProjectPath (Join-Path $releaseRoot $androidVersion.artifactName)
        Copy-Item -LiteralPath $apk -Destination $output -Force
        $apkHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
        $hashOutput = Assert-ProjectPath ($output + '.sha256')
        "$apkHash  $($androidVersion.artifactName)" | Set-Content -LiteralPath $hashOutput -Encoding ascii
        $buildReceipt = [ordered]@{
            timestampUtc = [DateTime]::UtcNow.ToString('o')
            artifact = $androidVersion.artifact
            versionCode = $androidVersion.versionCode
            versionName = $androidVersion.versionName
            versionInputs = $androidVersion
            apkVersionVerified = $apkVersion
            sha256 = $apkHash
            bytes = (Get-Item -LiteralPath $output).Length
            tasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug')
            apkSignatureVerified = $true
            embeddedWebAssets = $webAssetSnapshot
            nativeDeviceTested = $false
            distribution = 'Local debug build; no device installation or publication.'
        }
        $buildReceiptPath = Assert-ProjectPath (Join-Path $toolchainRoot 'android-build-receipt.json')
        $buildReceipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $buildReceiptPath -Encoding utf8
        Write-Host "APK: $output"
        Write-Host "SHA256: $apkHash"
    }
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    foreach ($name in $changedEnvironment) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
}
