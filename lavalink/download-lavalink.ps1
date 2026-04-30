$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$jarUrl = "https://github.com/lavalink-devs/Lavalink/releases/download/4.2.2/Lavalink.jar"
$jarPath = Join-Path $PSScriptRoot "Lavalink.jar"

Write-Host "Downloading Lavalink.jar..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $jarUrl -OutFile $jarPath
Write-Host "Saved to $jarPath" -ForegroundColor Green
