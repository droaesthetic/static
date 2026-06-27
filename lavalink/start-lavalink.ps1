$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$jarPath = Join-Path $PSScriptRoot "Lavalink.jar"
if (-not (Test-Path $jarPath)) {
  Write-Host "Lavalink.jar is missing." -ForegroundColor Yellow
  Write-Host "Run .\\download-lavalink.ps1 first." -ForegroundColor Yellow
  exit 1
}

function Get-JavaPath {
  $javaCommand = Get-Command java -ErrorAction SilentlyContinue
  if (-not $javaCommand) {
    throw "Java was not found. Install Java 17+ or add java.exe to PATH."
  }

  return $javaCommand.Source
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

  if ($env:YOUTUBE_OAUTH_ENABLED -or $env:YOUTUBE_OAUTH_REFRESH_TOKEN) {
    $env:PLUGINS_YOUTUBE_OAUTH_ENABLED = if ($env:YOUTUBE_OAUTH_ENABLED) { $env:YOUTUBE_OAUTH_ENABLED } else { "true" }

    if ($env:YOUTUBE_OAUTH_REFRESH_TOKEN) {
      $env:PLUGINS_YOUTUBE_OAUTH_REFRESHTOKEN = $env:YOUTUBE_OAUTH_REFRESH_TOKEN
    }

    if ($env:YOUTUBE_OAUTH_SKIP_INITIALIZATION) {
      $env:PLUGINS_YOUTUBE_OAUTH_SKIPINITIALIZATION = $env:YOUTUBE_OAUTH_SKIP_INITIALIZATION
    } elseif ($env:YOUTUBE_OAUTH_REFRESH_TOKEN) {
      $env:PLUGINS_YOUTUBE_OAUTH_SKIPINITIALIZATION = "true"
    }

    Write-Host "YouTube source: OAuth settings loaded from .env (YOUTUBE_OAUTH_*)" -ForegroundColor DarkGray
  }
}

Write-Host "Starting local Lavalink on http://127.0.0.1:2333 with high-priority Java..." -ForegroundColor Green

$process = Start-Process `
  -FilePath (Get-JavaPath) `
  -ArgumentList @(
    "-Xms1G",
    "-Xmx2G",
    "-XX:+UseG1GC",
    "-XX:MaxGCPauseMillis=100",
    "-jar",
    "`"$jarPath`""
  ) `
  -WorkingDirectory $PSScriptRoot `
  -NoNewWindow `
  -PassThru

$process.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::High
Write-Host "Lavalink Java process $($process.Id) is running with priority: $($process.PriorityClass)" -ForegroundColor Cyan

$process.WaitForExit()
exit $process.ExitCode
