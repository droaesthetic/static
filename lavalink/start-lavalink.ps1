$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$jarPath = Join-Path $PSScriptRoot "Lavalink.jar"
if (-not (Test-Path $jarPath)) {
  Write-Host "Lavalink.jar is missing." -ForegroundColor Yellow
  Write-Host "Run .\\download-lavalink.ps1 first." -ForegroundColor Yellow
  exit 1
}

# Optional: load repo-root .env so Lavalink can pick up secrets via env (overrides application.yml).
# See https://lavalink.dev/configuration/config/environment-variables.html
$rootEnv = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (Test-Path $rootEnv) {
  foreach ($line in Get-Content $rootEnv) {
    $t = $line.Trim()
    if ($t.Length -eq 0 -or $t.StartsWith("#")) {
      continue
    }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) {
      continue
    }
    $key = $t.Substring(0, $eq).Trim()
    $value = $t.Substring($eq + 1).Trim()
    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
  }

  if ($env:SPOTIFY_CLIENT_ID -and $env:SPOTIFY_CLIENT_SECRET) {
    $env:PLUGINS_LAVASRC_SPOTIFY_CLIENTID = $env:SPOTIFY_CLIENT_ID
    $env:PLUGINS_LAVASRC_SPOTIFY_CLIENTSECRET = $env:SPOTIFY_CLIENT_SECRET
    $env:PLUGINS_LAVASRC_SOURCES_SPOTIFY = "true"
    $env:PLUGINS_LAVASRC_LYRICS_SOURCES_SPOTIFY = "true"
    Write-Host "LavaSrc: Spotify credentials loaded from .env (SPOTIFY_CLIENT_*)" -ForegroundColor DarkGray
  }
}

Write-Host "Starting local Lavalink on http://127.0.0.1:2333" -ForegroundColor Green
& java -jar $jarPath
