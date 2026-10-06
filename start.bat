@echo off
rem Double-click this file to run the app on this laptop.
start "" http://localhost:8000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
pause
