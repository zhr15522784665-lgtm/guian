@echo off
rem ---------------------------------------------------------------
rem  ASCII-only on purpose. Chinese is printed by node, not by cmd.
rem  See the comment in the launcher file.
rem ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo.
  echo   [ERROR] runtime\node.exe was not found, cannot save settings.
  echo   Make sure there is a "runtime" subfolder with node.exe inside.
  echo.
  pause
  exit /b 1
)

"runtime\node.exe" "app\scripts\set-key.js"
