@echo off
setlocal
REM ============================================================
REM  Refresh your Firebase CLI credentials.
REM
REM  Run this when deploy-hosting.bat stops with:
REM     "Authentication Error: Your credentials are no longer
REM      valid. Please run firebase login --reauth"
REM
REM  This is a SEPARATE login from gcloud. The two tools keep
REM  their own credentials, so signing into one does nothing for
REM  the other -- which is why a working Cloud Run deploy can sit
REM  next to a failing hosting deploy.
REM
REM  It opens your browser. Sign in as the same account that owns
REM  the aaranya-scholarly project.
REM ============================================================

set "PROJECT=aaranya-scholarly"

title Firebase - sign in
cd /d "%~dp0"

where firebase >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] The Firebase CLI is not on your PATH.
  echo      Install it with:  npm install -g firebase-tools
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   FIREBASE - SIGN IN
echo  ============================================
echo.
echo  A browser window is about to open.
echo.
echo  Sign in as the account that owns the "%PROJECT%"
echo  project, then approve the access request.
echo.

call firebase login --reauth
if errorlevel 1 (
  echo.
  echo  [X] Sign-in did not complete. Nothing has changed - you can
  echo      close this window and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Checking the credentials work...
call firebase projects:list >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!] Signed in, but the CLI still cannot list your projects.
  echo      You may have picked the wrong Google account - run this
  echo      again and choose the other one.
  echo.
  pause
  exit /b 1
)

echo  [OK] Credentials work.
echo.
echo  ============================================
echo   Done. Now run deploy-hosting.bat
echo  ============================================
echo.
pause
endlocal
