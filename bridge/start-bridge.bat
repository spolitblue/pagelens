@echo off
title PageLens Bridge
cd /d "%~dp0"

set "NODE_EXE="

rem Prefer a system Node.js installation.
where node >nul 2>nul
if not errorlevel 1 (
  node server.mjs %*
  goto :after
)

rem Fall back to the Node runtime bundled with DeepSeek Harness.
for %%D in (
  "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%ProgramFiles(x86)%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
) do (
  if not defined NODE_EXE if exist "%%~D" set "NODE_EXE=%%~D"
)

if defined NODE_EXE (
  "%NODE_EXE%" server.mjs %*
) else (
  echo.
  echo   [!] Node.js was not found.
  echo       Install Node.js 20+ from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

:after
echo.
echo   Bridge stopped. Press any key to close this window.
pause >nul
