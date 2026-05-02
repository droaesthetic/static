@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0start-local.ps1"
if errorlevel 1 pause
