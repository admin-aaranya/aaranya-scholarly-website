@echo off
setlocal
REM ============================================================
REM  Run this AFTER journals.aaranyascholarly.com shows
REM  "Connected" in the Firebase console.
REM
REM  Points the app at the custom domain. This matters because
REM  every link in every editorial email is built from SITE_URL
REM  - until this runs, reviewers get invitations pointing at
REM  aaranya-scholarly.web.app instead of your real domain.
REM ============================================================

set "OUT=%~dp0_domain.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "SERVICE=aaranya-website"
set "DOMAIN=https://journals.aaranyascholarly.com"

title Set custom domain
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%

echo.
echo  Checking the domain resolves and serves the site...
>> "%OUT%" echo --- domain reachable? ---
curl -s -o nul -w "HTTP=%%{http_code}" "%DOMAIN%/api/auth/journals" >> "%OUT%" 2>&1
>> "%OUT%" echo.

echo  Pointing the app at %DOMAIN% ...
>> "%OUT%" echo --- update SITE_URL ---
call "%GC%" run services update %SERVICE% --region=%REGION% --project=%PROJECT% --update-env-vars="SITE_URL=%DOMAIN%" --quiet >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=FAILED
  echo  [X] Failed - see _domain.txt
  timeout /t 20 /nobreak >nul
  exit /b 1
)

echo  Verifying...
>> "%OUT%" echo --- current env ---
call "%GC%" run services describe %SERVICE% --region=%REGION% --project=%PROJECT% --format="value(spec.template.spec.containers[0].env)" >> "%OUT%" 2>&1
>> "%OUT%" echo --- site check ---
curl -s -o nul -w "custom domain HTTP=%%{http_code}" "%DOMAIN%/" >> "%OUT%" 2>&1
>> "%OUT%" echo.
curl -s -o nul -w "web.app still works HTTP=%%{http_code}" "https://aaranya-scholarly.web.app/" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo RESULT=OK
>> "%OUT%" echo --- END ---

echo.
echo  Done - see _domain.txt
timeout /t 10 /nobreak >nul
endlocal
