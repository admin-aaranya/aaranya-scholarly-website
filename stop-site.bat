@echo off
REM ============================================================
REM  Aaranya Scholarly — stop the local site
REM
REM  Double-click this to shut down the server started by
REM  start-site.bat.
REM
REM  Targets ONLY the process listening on port 4000, so any
REM  other Node.js programs you have running are left alone.
REM ============================================================

title Aaranya Scholarly - stopping local site
echo.
echo  Stopping the Aaranya Scholarly local site...
echo.

set FOUND=0

REM --- Find whatever is listening on port 4000 and stop it -----
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000" ^| findstr "LISTENING"') do (
  echo  Stopping server process ^(PID %%p^)...
  taskkill /F /PID %%p >nul 2>nul
  if not errorlevel 1 set FOUND=1
)

REM --- Close the launcher window itself ------------------------
taskkill /F /FI "WINDOWTITLE eq Aaranya Scholarly - local site*" >nul 2>nul

echo.
if "%FOUND%"=="1" (
  echo  [OK] The site has been stopped.
  echo       http://localhost:4000 will no longer respond.
) else (
  echo  [i]  Nothing was listening on port 4000 —
  echo       the site was already stopped.
)
echo.
echo  Run start-site.bat to start it again.
echo.
echo  This window closes in 10 seconds.
timeout /t 10 /nobreak >nul
