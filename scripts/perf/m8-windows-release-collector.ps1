param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("host", "cold", "steady")]
    [string]$Mode,
    [string]$ExecutablePath = "",
    [string]$ArgumentsBase64 = "W10=",
    [int]$Run = 1,
    [int]$ReadyTimeoutSeconds = 30,
    [int]$WarmupSeconds = 10,
    [int]$SampleSeconds = 60,
    [int]$SampleIntervalMs = 1000
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-JsonResult {
    param([Parameter(Mandatory = $true)]$Value)
    $Value | ConvertTo-Json -Depth 10 -Compress
}

function Read-TargetArguments {
    if ([string]::IsNullOrWhiteSpace($ArgumentsBase64)) {
        return @()
    }
    $bytes = [Convert]::FromBase64String($ArgumentsBase64)
    $json = [System.Text.Encoding]::UTF8.GetString($bytes)
    $values = ConvertFrom-Json -InputObject $json
    return @($values | ForEach-Object { [string]$_ })
}

function Assert-TargetInput {
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        throw "cold/steady 模式必须提供 ExecutablePath"
    }
    if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "目标程序不存在: $ExecutablePath"
    }
}

function Start-TargetProcess {
    $arguments = @(Read-TargetArguments)
    if ($arguments.Count -eq 0) {
        return Start-Process -FilePath $ExecutablePath -PassThru
    }
    return Start-Process -FilePath $ExecutablePath -ArgumentList $arguments -PassThru
}

function Wait-ForMainWindow {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutMs = $ReadyTimeoutSeconds * 1000
    while ($watch.ElapsedMilliseconds -lt $timeoutMs) {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "目标程序在主窗口就绪前退出，exitCode=$($Process.ExitCode)"
        }
        if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
            return [double]$watch.Elapsed.TotalMilliseconds
        }
        Start-Sleep -Milliseconds 25
    }
    throw "等待主窗口超时（${ReadyTimeoutSeconds}s）"
}

function Stop-TargetProcessTree {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    if ($Process.Id -le 0) {
        return
    }
    try {
        $current = Get-Process -Id $Process.Id -ErrorAction Stop
        if ($current.StartTime.ToUniversalTime() -ne $Process.StartTime.ToUniversalTime()) {
            return
        }
    }
    catch {
        return
    }
    # 只终止本 runner 启动且 creation identity 仍匹配的根进程树。
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
}

function Get-ProcessTreeIds {
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $processRows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $known = [System.Collections.Generic.HashSet[int]]::new()
    [void]$known.Add($RootPid)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($row in $processRows) {
            $processId = [int]$row.ProcessId
            $parentPid = [int]$row.ParentProcessId
            if ($known.Contains($parentPid) -and -not $known.Contains($processId)) {
                [void]$known.Add($processId)
                $changed = $true
            }
        }
    }
    return @($known)
}

function Get-ProcessTreeMetrics {
    param([Parameter(Mandatory = $true)][int]$RootPid)
    $ids = @(Get-ProcessTreeIds -RootPid $RootPid)
    $processes = @($ids | ForEach-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
    })
    if ($processes.Count -eq 0) {
        throw "目标进程树已经退出"
    }
    $cpuMs = 0.0
    $workingSetBytes = [long]0
    $privateBytes = [long]0
    foreach ($process in $processes) {
        $cpuMs += $process.TotalProcessorTime.TotalMilliseconds
        $workingSetBytes += [long]$process.WorkingSet64
        $privateBytes += [long]$process.PrivateMemorySize64
    }
    return [pscustomobject]@{
        capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        processCount = $processes.Count
        cpuMs = $cpuMs
        workingSetBytes = $workingSetBytes
        privateBytes = $privateBytes
    }
}

if ($Mode -eq "host") {
    $operatingSystem = Get-CimInstance Win32_OperatingSystem
    $computerSystem = Get-CimInstance Win32_ComputerSystem
    Write-JsonResult ([pscustomobject]@{
        platform = "win32"
        release = "$($operatingSystem.Caption) $($operatingSystem.Version) build $($operatingSystem.BuildNumber)"
        arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
        logicalProcessors = [int]$computerSystem.NumberOfLogicalProcessors
    })
    exit 0
}

Assert-TargetInput

if ($Mode -eq "cold") {
    $process = $null
    try {
        $process = Start-TargetProcess
        $readyMs = Wait-ForMainWindow -Process $process
        Write-JsonResult ([pscustomobject]@{
            run = $Run
            readyMs = $readyMs
            readiness = "main-window"
        })
    }
    finally {
        if ($null -ne $process) {
            Stop-TargetProcessTree -Process $process
        }
    }
    exit 0
}

$process = $null
try {
    $process = Start-TargetProcess
    [void](Wait-ForMainWindow -Process $process)
    Start-Sleep -Seconds $WarmupSeconds

    $logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
    $sampleCount = [Math]::Floor(($SampleSeconds * 1000) / $SampleIntervalMs)
    if ($sampleCount -le 0) {
        throw "采样窗口不足一个 sample interval"
    }
    $samples = [System.Collections.Generic.List[object]]::new()
    $previous = Get-ProcessTreeMetrics -RootPid $process.Id
    $runWatch = [System.Diagnostics.Stopwatch]::StartNew()
    for ($index = 0; $index -lt $sampleCount; $index += 1) {
        $targetOffsetMs = ($index + 1) * $SampleIntervalMs
        $remainingMs = $targetOffsetMs - $runWatch.Elapsed.TotalMilliseconds
        if ($remainingMs -gt 0) {
            Start-Sleep -Milliseconds ([Math]::Floor($remainingMs))
        }
        $current = Get-ProcessTreeMetrics -RootPid $process.Id
        $elapsedMs = [Math]::Max(1.0, $current.capturedAtMs - $previous.capturedAtMs)
        $cpuDeltaMs = [Math]::Max(0.0, $current.cpuMs - $previous.cpuMs)
        $cpuPercent = ($cpuDeltaMs / $elapsedMs / $logicalProcessors) * 100.0
        $samples.Add([pscustomobject]@{
            offsetMs = [double]$runWatch.Elapsed.TotalMilliseconds
            processCount = $current.processCount
            cpuPercent = $cpuPercent
            workingSetBytes = $current.workingSetBytes
            privateBytes = $current.privateBytes
        })
        $previous = $current
    }
    Write-JsonResult ([pscustomobject]@{
        warmupSeconds = $WarmupSeconds
        sampleSeconds = $SampleSeconds
        sampleIntervalMs = $SampleIntervalMs
        samples = @($samples)
    })
}
finally {
    if ($null -ne $process) {
        Stop-TargetProcessTree -Process $process
    }
}
