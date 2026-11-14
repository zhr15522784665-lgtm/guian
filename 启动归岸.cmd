@echo off
rem ---------------------------------------------------------------
rem  This file is intentionally ASCII-only.
rem  Batch files are parsed with the console code page, while node
rem  always writes UTF-8. Mixing the two turns Chinese into garbage,
rem  so every Chinese message is printed by node instead.
rem ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo.
  echo   [ERROR] runtime\node.exe was not found.
  echo   This folder looks incomplete or was moved.
  echo   Make sure there is a "runtime" subfolder with node.exe inside ^(~83 MB^).
  echo.
  pause
  exit /b 1
)

"runtime\node.exe" "app\scripts\launcher.js"
