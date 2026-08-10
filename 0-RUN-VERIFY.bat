@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  Smoke-test the live site after a deploy.
REM
REM  Writes everything to _verify.txt. Read-only - it only fetches
REM  public URLs, so it is safe to run at any time.
REM
REM  Checks BOTH hosts on purpose:
REM
REM    web.app  - Firebase Hosting in front of Cloud Run. This is
REM               the real site.
REM    custom   - journals.aaranyascholarly.com, live since
REM               10-08-2026 and now the canonical host. Both are
REM               checked so a divergence between them is visible.
REM
REM  The check that matters most is the sitemap hostname: every
REM  canonical link and Google Scholar citation URL on the public
REM  archive is built from SITE_URL on the Cloud Run service, and a
REM  wrong value there gets indexed before anyone notices.
REM ============================================================

set "OUT=%~dp0_verify.txt"
set "WEBAPP=https://aaranya-scholarly.web.app"
set "CUSTOM=https://journals.aaranyascholarly.com"

title Verify the live site
cd /d "%~dp0"

> "%OUT%" echo checked_at=%DATE% %TIME%

echo.
echo  Checking the live site...
echo.

for %%H in ("%WEBAPP%" "%CUSTOM%") do (
  set "H=%%~H"
  >> "%OUT%" echo.
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo  HOST: !H!
  >> "%OUT%" echo ============================================================
  >> "%OUT%" echo.
  >> "%OUT%" echo --- status codes ---

  for %%U in (
    "/"
    "/api/auth/journals"
    "/archive/alstm"
    "/sitemap.xml"
    "/robots.txt"
    "/api/public/journals"
    "/api/assistant/status"
  ) do (
    curl -s -o nul -w "%%~U -> HTTP %%{http_code}" "!H!%%~U" >> "%OUT%" 2>&1
    >> "%OUT%" echo.
  )

  >> "%OUT%" echo.
  >> "%OUT%" echo --- latest published articles ---
  curl -s "!H!/api/public/latest?journal=alstm" >> "%OUT%" 2>&1

  >> "%OUT%" echo.
  >> "%OUT%" echo --- robots.txt ---
  curl -s "!H!/robots.txt" >> "%OUT%" 2>&1

  >> "%OUT%" echo.
  >> "%OUT%" echo --- sitemap.xml  ^(CHECK THE HOSTNAME INSIDE ^<loc^>^) ---
  curl -s "!H!/sitemap.xml" >> "%OUT%" 2>&1
  >> "%OUT%" echo.
)

>> "%OUT%" echo.
>> "%OUT%" echo --- END ---

echo  Done. Results are in _verify.txt
echo.
timeout /t 8 /nobreak >nul
endlocal
