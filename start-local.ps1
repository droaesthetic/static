$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

if (-not (Test-Path ".env")) {
  Write-Host "Missing .env file. Copy .env.example to .env and fill in your Discord token first." -ForegroundColor Yellow
  exit 1
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

Write-Host "Starting ـ٨ﮩﮩـ٨ﮩ 𝕊𝕥𝕒𝕥𝕚𝕔 ﮩ٨ـﮩﮩ٨ـ locally..." -ForegroundColor Green
Write-Host "Dashboard: http://localhost:$port" -ForegroundColor Cyan

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
