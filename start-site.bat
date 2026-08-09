@echo off
REM ============================================================
REM  Aaranya Scholarly — start the site locally
REM
REM  Double-click this file to run the journal site on this
REM  machine at http://localhost:4000
REM
REM  Runs against local files in data\ — no Google Cloud account
REM  or credentials needed. Close this window (or press Ctrl+C)
REM  to stop the server.
REM ============================================================

title Aaranya Scholarly - local site
cd /d "%~dp0"

echo.
echo  ============================================
echo   AARANYA SCHOLARLY - starting local site
echo  ============================================
echo.

REM --- Check Node.js is installed -------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed, or is not on your PATH.
  echo.
  echo      Download and install it from https://nodejs.org
  echo      ^(choose the "LTS" version^), then run this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo  [OK] Node.js %NODEVER% found.

REM --- Install dependencies on first run ------------------------
if not exist "node_modules" (
  echo.
  echo  [..] First run - installing dependencies.
  echo       This takes a couple of minutes. Please wait.
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [X] npm install failed. Check your internet connection
    echo      and try running this file again.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo  [OK] Dependencies installed.
) else (
  echo  [OK] Dependencies already installed.
)

REM --- Bootstrap the first editor account -----------------------
REM Registering with this address grants the editor role, so the
REM Editorial Dashboard appears. Change it to whichever address
REM you want to sign up with.
set EDITOR_EMAILS=chanchalauma@gmail.com

echo.
echo  ============================================
echo   Site starting at:  http://localhost:4000
echo.
echo   Register with %EDITOR_EMAILS%
echo   to get editor access.
echo.
echo   Emails are printed below instead of being
echo   sent - no mail account needed locally.
echo.
echo   Keep this window open. Close it to stop.
echo  ============================================
echo.

REM Give the server a moment to bind, then open a browser.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4000"

node server.js

REM If we get here the server exited - keep the window open so any
REM error message is readable rather than vanishing instantly.
echo.
echo  The server has stopped.
echo.
pause
