$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$jarPath = Join-Path $PSScriptRoot "Lavalink.jar"
$startScript = Join-Path $PSScriptRoot "start-lavalink.ps1"

function Get-ConfiguredLavalinkPort {
  $rootEnv = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
  if (Test-Path $rootEnv) {
    foreach ($line in Get-Content $rootEnv) {
      $t = $line.Trim()
      if ($t.Length -eq 0 -or $t.StartsWith("#")) {
        continue
      }

      if ($t -match "^LAVALINK_URL\s*=\s*(.+)$") {
        $value = $matches[1].Trim()
        if ($value -match ":(\d+)$") {
          return [int]$matches[1]
        }
      }
    }
  }

  return 2333
}

function Test-IsLavalinkProcess($process) {
  if (-not $process -or -not $process.CommandLine) {
    return $false
  }

  return $process.CommandLine -match [Regex]::Escape($jarPath) -or
    ($process.CommandLine -match "Lavalink\.jar" -and $process.CommandLine -match [Regex]::Escape($PSScriptRoot))
}

function Get-LavalinkProcesses($port) {
  $byCommandLine = @(Get-CimInstance Win32_Process | Where-Object { Test-IsLavalinkProcess $_ })
  $byPort = @(Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" } |
    Where-Object { Test-IsLavalinkProcess $_ })

  @($byCommandLine + $byPort) |
    Where-Object { $_ } |
    Sort-Object ProcessId -Unique
}

function Set-LavalinkHighPriority($processes) {
  foreach ($process in $processes) {
    try {
      $runtimeProcess = Get-Process -Id $process.ProcessId -ErrorAction Stop
      $runtimeProcess.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High
      Write-Output "Lavalink process $($runtimeProcess.Id) priority: $($runtimeProcess.PriorityClass)"
    } catch {
      Write-Output "Could not set Lavalink process $($process.ProcessId) priority: $($_.Exception.Message)"
    }
  }
}

function Wait-ForLavalinkPortToOpen($port, $startedProcess) {
  $deadline = (Get-Date).AddSeconds(90)
  do {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
      return
    }

    if ($startedProcess.HasExited) {
      throw "Lavalink startup process exited before port $port opened. Exit code: $($startedProcess.ExitCode)."
    }

    Start-Sleep -Seconds 1
    $startedProcess.Refresh()
  } while ((Get-Date) -lt $deadline)

  throw "Lavalink did not start listening on port $port within 90 seconds."
}

if (-not (Test-Path $jarPath)) {
  Write-Error "Lavalink.jar is missing. Run .\download-lavalink.ps1 first."
}

if (-not (Test-Path $startScript)) {
  Write-Error "start-lavalink.ps1 is missing."
}

$port = Get-ConfiguredLavalinkPort
$lavalinkProcesses = Get-LavalinkProcesses $port

if ($lavalinkProcesses.Count -gt 0) {
  Write-Output "Lavalink is already running on port $port."
  Set-LavalinkHighPriority $lavalinkProcesses
  exit 0
}

$argumentList = @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "`"$startScript`""
)

$started = Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList $argumentList `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Normal `
  -PassThru

Write-Output "Started visible Lavalink terminal $($started.Id). Waiting for port $port..."
Wait-ForLavalinkPortToOpen $port $started
Set-LavalinkHighPriority (Get-LavalinkProcesses $port)
Write-Output "Lavalink is listening on port $port."
