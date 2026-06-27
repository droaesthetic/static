param(
  [switch]$SkipLavalink
)

$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$logPath = Join-Path $PSScriptRoot "start-high-priority.log"
$transcriptStarted = $false

try {
  Start-Transcript -Path $logPath -Append | Out-Null
  $transcriptStarted = $true

  if (-not (Test-Path ".env")) {
    throw "Missing .env file. Copy .env.example to .env and fill in your Discord token first."
  }

  function Get-NextFreePort {
    param(
      [int]$StartPort = 3000,
      [int]$EndPort = 3100
    )

    for ($port = $StartPort; $port -le $EndPort; $port++) {
      $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
      if (-not $inUse) {
        return $port
      }
    }

    throw "No free port found between $StartPort and $EndPort."
  }

  $nodePath = "C:\Program Files\nodejs\node.exe"
  if (-not (Test-Path $nodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
      throw "Node.js was not found. Install Node.js 22+ or add node.exe to PATH."
    }

    $nodePath = $nodeCommand.Source
  }

  $tsxPath = Join-Path $PSScriptRoot "node_modules\tsx\dist\cli.mjs"
  if (-not (Test-Path $tsxPath)) {
    throw "Missing tsx dependency. Run npm install before starting the bot."
  }

  $port = Get-NextFreePort
  $env:DASHBOARD_PORT = "$port"
  $env:DASHBOARD_PUBLIC_URL = "http://localhost:$port"

  $ensureLavalinkScript = Join-Path $PSScriptRoot "lavalink\ensure-lavalink.ps1"
  if ($SkipLavalink) {
    Write-Host "Lavalink auto-start skipped for this launcher." -ForegroundColor Yellow
  } elseif (Test-Path $ensureLavalinkScript) {
    Write-Host "Ensuring local Lavalink is running with high priority..." -ForegroundColor Cyan
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ensureLavalinkScript
    if ($LASTEXITCODE -ne 0) {
      throw "Local Lavalink could not be started. Check the Lavalink terminal for details."
    }
  } else {
    Write-Host "Lavalink auto-start skipped because lavalink\ensure-lavalink.ps1 is missing." -ForegroundColor Yellow
  }

  Write-Host "Starting Static locally with high-priority Node.js..." -ForegroundColor Green
  Write-Host "Dashboard: http://localhost:$port" -ForegroundColor Cyan
  Write-Host "Startup log: $logPath" -ForegroundColor DarkGray

  $restartDelaySeconds = 5
  $botRestartExitCode = 42

  while ($true) {
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = $nodePath
    $processInfo.Arguments = "`"$tsxPath`" `"src\index.ts`""
    $processInfo.WorkingDirectory = $PSScriptRoot
    $processInfo.UseShellExecute = $false

    foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
      $processInfo.Environment[$entry.Key] = "$($entry.Value)"
    }

    $process = [System.Diagnostics.Process]::Start($processInfo)
    $process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High

    Write-Host "Node.js process $($process.Id) is running with priority: $($process.PriorityClass)" -ForegroundColor Cyan

    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()

    if ($exitCode -eq $botRestartExitCode) {
      Write-Host "Bot requested a reboot. Restarting in $restartDelaySeconds seconds..." -ForegroundColor Yellow
      Start-Sleep -Seconds $restartDelaySeconds
      continue
    }

    if ($exitCode -eq 0) {
      Write-Host "Bot stopped cleanly." -ForegroundColor Yellow
      break
    }

    Write-Host "Bot exited with code $exitCode. Restarting in $restartDelaySeconds seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds $restartDelaySeconds
  }
} catch {
  Write-Host ""
  Write-Host "Static could not start:" -ForegroundColor Red
  Write-Host $_ -ForegroundColor Red
  Write-Host ""
  Write-Host "The error was saved to: $logPath" -ForegroundColor Yellow
  Read-Host "Press Enter to close this window"
  exit 1
} finally {
  if ($transcriptStarted) {
    Stop-Transcript | Out-Null
  }
}
