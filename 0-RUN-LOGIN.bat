@echo off
setlocal
REM ============================================================
REM  Refresh your Google Cloud credentials.
REM
REM  Run this when a deploy stops with:
REM     "Reauthentication failed. cannot prompt during
REM      non-interactive execution."
REM
REM  It opens your browser. Sign in as the account that owns the
REM  aaranya-scholarly project, approve the access, and come back
REM  to this window.
REM
REM  Uses the full path to gcloud rather than relying on PATH,
REM  which is not always set for a double-clicked script.
REM ============================================================

set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"

title Google Cloud - sign in
cd /d "%~dp0"

if not exist "%GC%" (
  echo.
  echo  [X] Could not find gcloud at:
  echo      %GC%
  echo.
  echo      If the Cloud SDK is installed somewhere else, open a
  echo      terminal and run:  gcloud auth login
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   GOOGLE CLOUD - SIGN IN
echo  ============================================
echo.
echo  A browser window is about to open.
echo.
echo  Sign in as the account that owns the "%PROJECT%"
echo  project, then approve the access request.
echo.

call "%GC%" auth login
if errorlevel 1 (
  echo.
  echo  [X] Sign-in did not complete. Nothing has changed - you can
  echo      close this window and try again.
  echo.
  pause
  exit /b 1
)

call "%GC%" config set project %PROJECT% >nul 2>&1

echo.
echo  Signed in as:
call "%GC%" auth list --filter=status:ACTIVE --format="value(account)"
echo.

REM Prove the credentials actually work against this project, rather
REM than just reporting that a login happened. A deploy takes 4-8
REM minutes to fail; this takes two seconds.
echo  Checking the credentials work...
call "%GC%" run services list --region=asia-south1 --project=%PROJECT% --format="value(metadata.name)" >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!] Signed in, but this account cannot read the Cloud Run
  echo      services in "%PROJECT%". You may have signed in with the
  echo      wrong Google account. Run this again and pick the other one.
  echo.
  pause
  exit /b 1
)

echo  [OK] Credentials work.
echo.
echo  ============================================
echo   Done. Now run 0-RUN-DEPLOY.bat
echo  ============================================
echo.
pause
endlocal
