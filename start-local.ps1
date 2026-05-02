$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$logPath = Join-Path $PSScriptRoot "start-local.log"
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

  $port = Get-NextFreePort
  $env:DASHBOARD_PORT = "$port"
  $env:DASHBOARD_PUBLIC_URL = "http://localhost:$port"

  Write-Host "Starting Dro Tunes locally..." -ForegroundColor Green
  Write-Host "Dashboard: http://localhost:$port" -ForegroundColor Cyan
  Write-Host "Startup log: $logPath" -ForegroundColor DarkGray

  $restartDelaySeconds = 5

  while ($true) {
    & "C:\Program Files\nodejs\npm.cmd" run dev:local
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
      Write-Host "Bot stopped cleanly." -ForegroundColor Yellow
      break
    }

    Write-Host "Bot exited with code $exitCode. Restarting in $restartDelaySeconds seconds..." -ForegroundColor Yellow
    Start-Sleep -Seconds $restartDelaySeconds
  }
} catch {
  Write-Host ""
  Write-Host "Dro Tunes could not start:" -ForegroundColor Red
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
