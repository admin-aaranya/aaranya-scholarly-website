@echo off
setlocal
REM ============================================================
REM  Put SITE_URL back to the address that actually works.
REM
REM  SITE_URL must always point at a hostname that resolves and
REM  serves this app. Everything user-facing is built from it:
REM  canonical links, Google Scholar citation URLs, the sitemap,
REM  and every link in every editorial email.
REM
REM  Pointing it at a domain that does not resolve is worse than
REM  pointing it at an ugly one - reviewers get invitations they
REM  cannot open, and search engines index canonical URLs that
REM  404.
REM
REM  TARGET is the custom domain, which went live on 10-08-2026.
REM  If it ever stops serving, point this at
REM  https://aaranya-scholarly.web.app instead - the script refuses
REM  to set SITE_URL to a host that is not answering.
REM ============================================================

set "OUT=%~dp0_siteurl.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "SERVICE=aaranya-website"
set "TARGET=https://journals.aaranyascholarly.com"

title Fix SITE_URL
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%

echo.
echo  Checking %TARGET% actually serves the app...
>> "%OUT%" echo --- target reachable? ---
curl -s -o nul -w "HTTP=%%{http_code}" "%TARGET%/api/auth/journals" >> "%OUT%" 2>&1
>> "%OUT%" echo.

REM Refuse to set SITE_URL to something that isn't serving. That is
REM the whole mistake this script exists to undo.
curl -s -o nul -f "%TARGET%/api/auth/journals"
if errorlevel 1 (
  >> "%OUT%" echo RESULT=TARGET_NOT_SERVING
  echo  [X] %TARGET% is not serving the app - not changing anything.
  echo      See _siteurl.txt
  timeout /t 20 /nobreak >nul
  exit /b 1
)
echo  [OK] It serves the app.

echo.
echo  Setting SITE_URL=%TARGET% ...
>> "%OUT%" echo --- update SITE_URL ---
call "%GC%" run services update %SERVICE% --region=%REGION% --project=%PROJECT% --update-env-vars="SITE_URL=%TARGET%" --quiet >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=FAILED
  echo  [X] Failed - see _siteurl.txt
  timeout /t 20 /nobreak >nul
  exit /b 1
)

>> "%OUT%" echo --- current env ---
call "%GC%" run services describe %SERVICE% --region=%REGION% --project=%PROJECT% --format="value(spec.template.spec.containers[0].env)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- sitemap hostname (this is the proof) ---
curl -s "%TARGET%/sitemap.xml" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo RESULT=OK
>> "%OUT%" echo --- END ---

echo.
echo  Done - see _siteurl.txt
timeout /t 10 /nobreak >nul
endlocal
