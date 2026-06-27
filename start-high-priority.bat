@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0start-high-priority.ps1" -SkipLavalink
if errorlevel 1 pause
