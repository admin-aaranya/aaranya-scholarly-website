@echo off
REM ============================================================
REM  Aaranya Scholarly — deploy Firebase Hosting config
REM
REM  Publishes firebase.json (the rewrite to Cloud Run, cache
REM  headers) and anything in public\ to Firebase Hosting.
REM
REM  You do NOT need this for ordinary code changes — those go
REM  out through the GitHub Actions pipeline to Cloud Run.
REM  Only run this when you change firebase.json or public\.
REM
REM  Prerequisites (see docs\firebase-deploy.md):
REM    - Firebase project created, on the Blaze plan
REM    - Cloud Run service already deployed
REM    - You have run: firebase login
REM ============================================================

title Aaranya Scholarly - deploy hosting
cd /d "%~dp0"

echo.
echo  ============================================
echo   FIREBASE HOSTING - deploy
echo  ============================================
echo.

REM --- Check the Firebase CLI is installed ----------------------
where firebase >nul 2>nul
if errorlevel 1 (
  echo  [X] The Firebase CLI is not installed.
  echo.
  echo      Install it by running this in a terminal:
  echo          npm install -g firebase-tools
  echo.
  echo      Then run: firebase login
  echo.
  pause
  exit /b 1
)
echo  [OK] Firebase CLI found.

REM --- Check the project is linked ------------------------------
if not exist ".firebaserc" (
  echo.
  echo  [X] This folder is not linked to a Firebase project yet.
  echo.
  echo      Open a terminal here and run:
  echo          firebase login
  echo          firebase use --add
  echo.
  echo      Then run this file again.
  echo.
  pause
  exit /b 1
)
echo  [OK] Firebase project linked.

REM --- Warn if firebase.json still has the sample values --------
findstr /C:"aaranya-website" firebase.json >nul 2>nul
if not errorlevel 1 (
  echo.
  echo  [!] Reminder: firebase.json points at Cloud Run service
  echo      "aaranya-website" in region "asia-south1".
  echo.
  echo      If you deployed under a different name or region,
  echo      close this window and edit firebase.json first -
  echo      a mismatch gives a 404 on every page.
  echo.
)

echo.
echo  Deploying hosting configuration...
echo.
call firebase deploy --only hosting

if errorlevel 1 (
  echo.
  echo  [X] Deploy failed. Common causes:
  echo      - not logged in            ^(run: firebase login^)
  echo      - project not on Blaze plan
  echo      - Cloud Run service does not exist yet
  echo.
  echo      See docs\firebase-deploy.md
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   [OK] Hosting deployed.
echo.
echo   Remember: if this is your first deploy, set
echo   SITE_URL on the Cloud Run service so emails
echo   link to the live site instead of localhost.
echo   See docs\firebase-deploy.md step 4.
echo  ============================================
echo.
pause
