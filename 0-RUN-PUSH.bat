@echo off
setlocal
REM ============================================================
REM  Push this repository to GitHub.
REM
REM  The first run opens a browser so Git Credential Manager can
REM  sign you in to GitHub. Sign in as the account that owns the
REM  repository. After that it stores the token in Windows
REM  Credential Manager and never asks again.
REM
REM  You are NOT typing a password into git -- GitHub stopped
REM  accepting account passwords for git operations in 2021. The
REM  browser flow issues a token instead.
REM
REM  The branch is "main", because .github/workflows/deploy.yml
REM  only triggers on main. Pushing a branch called "master"
REM  would upload the code and never run the pipeline.
REM ============================================================

set "OUT=%~dp0_push.txt"
set "REMOTE=https://github.com/aaranyapublishing/aaranya-scholarly-website.git"

title Push to GitHub
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%
>> "%OUT%" echo remote=%REMOTE%

echo.
echo  ============================================
echo   PUSH TO GITHUB
echo  ============================================
echo.
echo  Remote: %REMOTE%
echo.

>> "%OUT%" echo.
>> "%OUT%" echo --- local state before push ---
git log --oneline >> "%OUT%" 2>&1
>> "%OUT%" echo.
git status --short >> "%OUT%" 2>&1
>> "%OUT%" echo (nothing above means a clean tree)

echo  Pushing... a browser may open for sign-in.
echo.
>> "%OUT%" echo.
>> "%OUT%" echo --- push ---
git push -u origin main >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=PUSH_FAILED
  echo.
  echo  [X] Push failed - see _push.txt
  echo.
  echo      Most likely causes:
  echo        - the repository does not exist yet, or has a
  echo          different name ^(check the REMOTE line above^)
  echo        - you signed in as the wrong GitHub account
  echo        - the repository was created WITH a README, so it
  echo          already has a commit that conflicts with ours
  echo.
  pause
  exit /b 1
)

>> "%OUT%" echo.
>> "%OUT%" echo --- remote branches now ---
git branch -r >> "%OUT%" 2>&1

>> "%OUT%" echo RESULT=PUSHED
>> "%OUT%" echo --- END ---

echo.
echo  ============================================
echo   Pushed. Your code now exists somewhere
echo   other than this disk.
echo.
echo   https://github.com/aaranyapublishing/aaranya-scholarly-website
echo  ============================================
echo.
pause
endlocal
