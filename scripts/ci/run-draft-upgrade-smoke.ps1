[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $PreviousInstaller,
    [Parameter(Mandatory = $true)]
    [string] $PreviousVersion,
    [Parameter(Mandatory = $true)]
    [string] $SmokeHarness,
    [Parameter(Mandatory = $true)]
    [string] $DraftStaging,
    [Parameter(Mandatory = $true)]
    [string] $TauriConfig,
    [Parameter(Mandatory = $true)]
    [string] $Tag,
    [Parameter(Mandatory = $true)]
    [string] $CommitSha,
    [Parameter(Mandatory = $true)]
    [string] $AppDataDirectory,
    [Parameter(Mandatory = $true)]
    [string] $EvidencePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$CredentialEnvironmentNamePattern = '(?i)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|ACCESS_KEY|API_KEY|CREDENTIAL|AUTHORIZATION)'
$CredentialCapabilityNames = @(
    "ACTIONS_CACHE_URL",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_RESULTS_URL",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "GH_TOKEN",
    "GITHUB_ENV",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_STATE",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_TOKEN",
    "SSH_AGENT_PID",
    "SSH_AUTH_SOCK",
    "VSS_NUGET_EXTERNAL_FEED_ENDPOINTS"
)

function Assert-CredentialEnvironmentAbsent {
    $credentialLike = @(
        Get-ChildItem Env: |
            ForEach-Object { [string] $_.Name } |
            Where-Object {
                $_ -match $CredentialEnvironmentNamePattern -or
                $CredentialCapabilityNames -ccontains $_
            }
    )
    if ($credentialLike.Count -ne 0) {
        # 不输出变量值或名称，避免把未知 CI credential 写入日志。
        throw "标准用户 child 继承了 credential-like CI 环境变量"
    }
}

function Assert-AbsoluteExistingFile([string] $Path, [string] $Label) {
    if (-not [System.IO.Path]::IsPathFullyQualified($Path) -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label 必须是已存在的绝对文件"
    }
}

function Assert-AbsoluteExistingDirectory([string] $Path, [string] $Label) {
    if (-not [System.IO.Path]::IsPathFullyQualified($Path) -or
        -not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label 必须是已存在的绝对目录"
    }
}

function Assert-ReadOnlyFile([string] $Path, [string] $Label) {
    Assert-AbsoluteExistingFile $Path $Label
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::Read
        )
    } catch [System.UnauthorizedAccessException] {
        return
    } catch [System.Security.SecurityException] {
        return
    } finally {
        if ($stream) { $stream.Dispose() }
    }
    throw "$Label 对标准用户不是只读"
}

function Assert-ReadOnlyDirectory([string] $Path, [string] $Label) {
    Assert-AbsoluteExistingDirectory $Path $Label
    $probe = Join-Path $Path ".mineradio-write-probe-$([Guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::WriteAllBytes($probe, [byte[]]::new(0))
    } catch [System.UnauthorizedAccessException] {
        return
    } catch [System.Security.SecurityException] {
        return
    } finally {
        if (Test-Path -LiteralPath $probe) {
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        }
    }
    throw "$Label 对标准用户可写"
}

function Assert-WritableDirectory([string] $Path, [string] $Label) {
    Assert-AbsoluteExistingDirectory $Path $Label
    $probe = Join-Path $Path ".mineradio-write-probe-$([Guid]::NewGuid().ToString('N'))"
    try {
        [System.IO.File]::WriteAllBytes($probe, [byte[]]::new(0))
        if (-not (Test-Path -LiteralPath $probe -PathType Leaf)) {
            throw "$Label 写入探针未落盘"
        }
    } finally {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-SmokeHarness([string[]] $Arguments) {
    $lines = @(& $SmokeHarness @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        $summary = ($lines | Select-Object -Last 8) -join [Environment]::NewLine
        throw "updater-smoke 失败: $summary"
    }
    $json = ($lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1)
    if (-not $json) {
        throw "updater-smoke 未返回 evidence"
    }
    try {
        return $json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "updater-smoke evidence 不是有效 JSON"
    }
}

function Get-StableProductVersion([string] $Executable) {
    $raw = (Get-Item -LiteralPath $Executable).VersionInfo.ProductVersion
    if ($raw -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\D.*)?$') {
        throw "安装后的 ProductVersion 不是稳定 SemVer"
    }
    return "$($Matches[1]).$($Matches[2]).$($Matches[3])"
}

function Resolve-InstalledExecutable([string] $ExpectedVersion) {
    $expected = Join-Path $env:LOCALAPPDATA "MineRadio-Tauri\MineRadio-Tauri.exe"
    if (Test-Path -LiteralPath $expected -PathType Leaf) {
        return $expected
    }

    $uninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    $matches = @(
        Get-ChildItem -LiteralPath $uninstallRoot -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
            Where-Object {
                $_.DisplayName -ceq "MineRadio-Tauri" -and
                $_.DisplayVersion -eq $ExpectedVersion -and
                $_.InstallLocation
            }
    )
    if ($matches.Count -ne 1) {
        throw "无法唯一定位 N-1 current-user 安装目录"
    }
    $resolved = Join-Path ([string] $matches[0].InstallLocation) "MineRadio-Tauri.exe"
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "N-1 安装记录未指向 MineRadio-Tauri.exe"
    }
    return $resolved
}

foreach ($required in @(
    @($PreviousInstaller, "N-1 installer"),
    @($SmokeHarness, "smoke harness"),
    @($TauriConfig, "Tauri config")
)) {
    Assert-AbsoluteExistingFile $required[0] $required[1]
}
Assert-AbsoluteExistingDirectory $DraftStaging "Draft staging"
Assert-CredentialEnvironmentAbsent

if (-not [System.IO.Path]::IsPathFullyQualified($AppDataDirectory) -or
    -not [System.IO.Path]::IsPathFullyQualified($EvidencePath)) {
    throw "app-data 与 evidence 必须是绝对路径"
}
if (Test-Path -LiteralPath $AppDataDirectory) {
    throw "smoke app-data 必须从不存在的目录开始"
}
if (Test-Path -LiteralPath $EvidencePath) {
    throw "smoke evidence 不允许覆盖"
}
$workDirectory = Split-Path -Parent $AppDataDirectory
if ((Split-Path -Parent $EvidencePath) -cne $workDirectory) {
    throw "app-data 与 evidence 必须位于同一独立 work 目录"
}
Assert-WritableDirectory $workDirectory "smoke work"

$toolsDirectory = Split-Path -Parent $SmokeHarness
$previousDirectory = Split-Path -Parent $PreviousInstaller
$inputsDirectory = Split-Path -Parent $DraftStaging
$rootDirectory = Split-Path -Parent $inputsDirectory
if ((Split-Path -Parent $toolsDirectory) -cne $inputsDirectory -or
    (Split-Path -Parent $previousDirectory) -cne $inputsDirectory -or
    (Split-Path -Parent $workDirectory) -cne $rootDirectory) {
    throw "tools、Draft、N-1 和 work 没有位于预期隔离边界"
}
Assert-ReadOnlyDirectory $rootDirectory "smoke root"
Assert-ReadOnlyDirectory $inputsDirectory "smoke inputs"
Assert-ReadOnlyDirectory $toolsDirectory "smoke tools"
foreach ($toolFile in @(Get-ChildItem -LiteralPath $toolsDirectory -File)) {
    Assert-ReadOnlyFile $toolFile.FullName "smoke tool"
}
foreach ($requiredTool in @($SmokeHarness, $TauriConfig, $PSCommandPath)) {
    Assert-ReadOnlyFile $requiredTool "required smoke tool"
}
Assert-ReadOnlyDirectory $DraftStaging "Draft staging"
foreach ($draftAsset in @(Get-ChildItem -LiteralPath $DraftStaging -File)) {
    Assert-ReadOnlyFile $draftAsset.FullName "Draft asset"
}
Assert-ReadOnlyDirectory $previousDirectory "N-1 staging"
foreach ($previousAsset in @(Get-ChildItem -LiteralPath $previousDirectory -File)) {
    Assert-ReadOnlyFile $previousAsset.FullName "N-1 asset"
}
if ($Tag -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "候选 tag 不是稳定 SemVer"
}
$targetVersion = $Tag.Substring(1)
if ($PreviousVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "N-1 version 不是稳定 SemVer"
}
if ([version]$PreviousVersion -ge [version]$targetVersion) {
    throw "N-1 version 必须严格低于候选版本"
}
if ($CommitSha -notmatch '^[0-9a-f]{40}$') {
    throw "候选 commit SHA 无效"
}

# GITHUB_TOKEN 只允许存在于此前的下载 step，绝不能继承到 harness、installer 或候选应用。
if ($env:GITHUB_TOKEN -or $env:GH_TOKEN) {
    throw "标准用户 smoke 进程继承了 GitHub token"
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "N-1 到 N smoke 必须在非管理员标准用户下运行"
}
$boundary = Invoke-SmokeHarness @("verify-process-boundary")
if ($boundary.processElevated -ne $false -or
    $boundary.githubTokenAbsent -ne $true -or
    $boundary.ghTokenAbsent -ne $true -or
    $boundary.ciCredentialsAbsent -ne $true) {
    throw "smoke 进程权限或 token 边界无效"
}

$env:MINERADIO_APP_DATA_DIR = $AppDataDirectory
$env:MINERADIO_LOG_DIR = Join-Path $AppDataDirectory "logs"
$candidateProcess = $null
try {
    $previousInstall = Start-Process -FilePath $PreviousInstaller -ArgumentList "/S" -PassThru -Wait
    if ($previousInstall.ExitCode -ne 0) {
        throw "N-1 安装失败，exit=$($previousInstall.ExitCode)"
    }
    $installedExecutable = Resolve-InstalledExecutable $PreviousVersion
    if ((Get-StableProductVersion $installedExecutable) -ne $PreviousVersion) {
        throw "N-1 安装后的 ProductVersion 不匹配"
    }

    # 初装不允许遗留应用进程；候选进程只能由 production NSIS `/R` 路径启动。
    Get-Process -Name "MineRadio-Tauri" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $installedExecutable } |
        Stop-Process -Force

    $seed = Invoke-SmokeHarness @("seed-state", $AppDataDirectory)
    $installStartedAt = Get-Date
    $install = Invoke-SmokeHarness @(
        "install-draft",
        $DraftStaging,
        $AppDataDirectory,
        $TauriConfig,
        $Tag,
        $CommitSha,
        $PreviousVersion
    )
    if ($install.version -ne $targetVersion -or
        $install.phase -ne "installer-spawned" -or
        $install.candidateId -notmatch '^[0-9a-f]{64}$') {
        throw "install-draft 未返回 exact spawned candidate evidence"
    }

    $deadline = (Get-Date).AddMinutes(6)
    $verified = $null
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $installedExecutable -PathType Leaf) -and
            (Get-StableProductVersion $installedExecutable) -eq $targetVersion) {
            $candidateProcess = @(
                Get-Process -Name "MineRadio-Tauri" -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Path -eq $installedExecutable -and
                        $_.StartTime -ge $installStartedAt
                    }
            ) | Sort-Object StartTime -Descending | Select-Object -First 1
            if ($candidateProcess) {
                try {
                    $verified = Invoke-SmokeHarness @(
                        "verify-state",
                        $AppDataDirectory,
                        [string] $install.candidateId,
                        $targetVersion,
                        [string] $seed.startupCount
                    )
                    break
                } catch {
                    # Candidate startup reconciliation 可能仍在进行；只做 bounded polling。
                }
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $verified) {
        throw "候选版本未在时限内完成 relaunch 与启动恢复"
    }

    $safeEvidence = [ordered]@{
        schema = "mineradio-draft-upgrade-smoke-v1"
        previousVersion = $PreviousVersion
        targetVersion = $targetVersion
        candidateId = [string] $install.candidateId
        releaseTag = $Tag
        commitSha = $CommitSha
        standardUser = $true
        processElevated = $false
        githubTokenAbsent = $true
        ciCredentialsAbsent = [bool] $boundary.ciCredentialsAbsent
        installedProductVersion = Get-StableProductVersion $installedExecutable
        candidateRelaunched = $true
        databasePreserved = [bool] $verified.databasePreserved
        typedPreferencePreserved = [bool] $verified.typedPreferencePreserved
        checkpointConsumed = [bool] $verified.checkpointConsumed
        updaterCacheClean = [bool] $verified.updaterCacheClean
        baselineStartupCount = [int64] $seed.startupCount
        verifiedStartupCount = [int64] $verified.startupCount
    }
    $safeEvidence | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM -NoNewline
    $safeEvidence | ConvertTo-Json -Compress
} finally {
    if ($candidateProcess) {
        Stop-Process -Id $candidateProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
