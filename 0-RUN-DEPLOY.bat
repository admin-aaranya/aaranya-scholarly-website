@echo off
setlocal
REM ============================================================
REM  Rebuild and deploy the current code to Cloud Run.
REM
REM  Keep this one - it is how you ship any future code change
REM  until the GitHub Actions pipeline is connected.
REM ============================================================

set "OUT=%~dp0_deploy.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "SERVICE=aaranya-website"
set "RUNTIME_SA=aaranya-website-runtime@aaranya-scholarly.iam.gserviceaccount.com"
set "DEPLOY_SA=aaranya-website-deployer@aaranya-scholarly.iam.gserviceaccount.com"

title Deploy to Cloud Run
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%

echo.
echo  Syncing dependencies (keeps package-lock.json in step with
echo  package.json - the Dockerfile uses "npm ci", which fails if
echo  the two disagree)...
call npm install --no-audit --no-fund >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=NPM_INSTALL_FAILED
  echo  [X] npm install failed - see _deploy.txt
  pause
  exit /b 1
)
echo  [OK] Dependencies in sync.

echo.
echo  Running tests before deploying...
call npm test >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=TESTS_FAILED
  echo  [X] Tests failed - not deploying. See _deploy.txt
  pause
  exit /b 1
)
echo  [OK] Tests passed.

echo.
echo  Building and deploying (4-8 minutes)...
>> "%OUT%" echo --- deploy ---
call "%GC%" run deploy %SERVICE% ^
  --source=. ^
  --region=%REGION% ^
  --project=%PROJECT% ^
  --service-account=%RUNTIME_SA% ^
  --build-service-account="projects/%PROJECT%/serviceAccounts/%DEPLOY_SA%" ^
  --quiet >> "%OUT%" 2>&1

if errorlevel 1 (
  >> "%OUT%" echo RESULT=DEPLOY_FAILED
  echo  [X] Deploy failed - see _deploy.txt
  timeout /t 20 /nobreak >nul
  exit /b 1
)

>> "%OUT%" echo --- revision now serving ---
call "%GC%" run services describe %SERVICE% --region=%REGION% --project=%PROJECT% --format="value(status.latestReadyRevisionName)" >> "%OUT%" 2>&1

>> "%OUT%" echo --- site check ---
curl -s -o nul -w "web.app HTTP=%%{http_code}" "https://aaranya-scholarly.web.app/api/auth/journals" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo RESULT=DEPLOYED
>> "%OUT%" echo --- END ---

echo.
echo  ============================================
echo   Deployed. https://aaranya-scholarly.web.app
echo  ============================================
timeout /t 12 /nobreak >nul
endlocal
