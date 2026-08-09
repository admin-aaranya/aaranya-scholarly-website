@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  One-time setup for the manuscript assistant, then deploy.
REM
REM  What this does, in order:
REM    1. enables the Vertex AI API on the project
REM    2. grants the runtime service account roles/aiplatform.user
REM    3. asks Vertex which Gemini models this project can actually
REM       call -- AS THE RUNTIME SERVICE ACCOUNT, not as you, since
REM       an owner account can succeed where the service account
REM       fails and that difference has bitten this project before
REM    4. deploys the code with the confirmed model configured
REM
REM  Safe to re-run. Run it again after any Google model retirement.
REM ============================================================

set "OUT=%~dp0_ai-setup.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "SERVICE=aaranya-website"
set "RUNTIME_SA=aaranya-website-runtime@aaranya-scholarly.iam.gserviceaccount.com"
set "DEPLOY_SA=aaranya-website-deployer@aaranya-scholarly.iam.gserviceaccount.com"

title Set up the manuscript assistant
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%

echo.
echo  [1/5] Enabling the Vertex AI API...
>> "%OUT%" echo --- enable api ---
call "%GC%" services enable aiplatform.googleapis.com --project=%PROJECT% >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=ENABLE_FAILED
  echo  [X] Could not enable the API - see _ai-setup.txt
  pause
  exit /b 1
)
echo       [OK]

echo.
echo  [2/5] Granting the runtime account permission to call Vertex AI...
>> "%OUT%" echo --- grant aiplatform.user ---
call "%GC%" projects add-iam-policy-binding %PROJECT% ^
  --member="serviceAccount:%RUNTIME_SA%" ^
  --role="roles/aiplatform.user" ^
  --condition=None --quiet >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=IAM_FAILED
  echo  [X] Could not grant the role - see _ai-setup.txt
  pause
  exit /b 1
)
echo       [OK]

echo.
echo  [3/5] Getting a token for the RUNTIME account (not yours)...
REM  Impersonation is what makes this test meaningful. If it fails we fall
REM  back to your own identity, but then the probe only proves YOU can call
REM  Vertex -- which is not the question.
set "PROBE_AS=runtime service account"
set "TOKEN="
for /f "usebackq delims=" %%T in (`"%GC%" auth print-access-token --impersonate-service-account=%RUNTIME_SA% 2^>nul`) do set "TOKEN=%%T"
if "!TOKEN!"=="" (
  echo       [!] Could not impersonate the runtime account. Falling back to
  echo           your own login. NOTE: this proves less - see _ai-setup.txt.
  >> "%OUT%" echo WARNING=impersonation_failed_probing_as_user
  set "PROBE_AS=your own account"
  for /f "usebackq delims=" %%T in (`"%GC%" auth print-access-token 2^>nul`) do set "TOKEN=%%T"
)
if "!TOKEN!"=="" (
  >> "%OUT%" echo RESULT=NO_TOKEN
  echo  [X] Could not get an access token. Run: gcloud auth login
  pause
  exit /b 1
)
echo       [OK] Probing as !PROBE_AS!.

echo.
echo  [4/5] Asking Vertex which models this project can call...
>> "%OUT%" echo --- model probe (as !PROBE_AS!) ---
if exist "_gemini-model.txt" del "_gemini-model.txt"
set "GCP_PROJECT_ID=%PROJECT%"
set "GOOGLE_ACCESS_TOKEN=!TOKEN!"
call node scripts\probe-gemini.js >> "%OUT%" 2>&1
set "GOOGLE_ACCESS_TOKEN="

if not exist "_gemini-model.txt" (
  >> "%OUT%" echo RESULT=NO_WORKING_MODEL
  echo  [X] No model responded. Open _ai-setup.txt - it lists why each
  echo      candidate was refused.
  pause
  exit /b 1
)
set /p AI_LOCATION=<"_gemini-model.txt"
for /f "skip=1 delims=" %%M in (_gemini-model.txt) do set "AI_MODEL=%%M"
echo       [OK] Using !AI_MODEL! in !AI_LOCATION!.

echo.
echo  [5/5] Running tests, then deploying with the assistant enabled...
call npm install --no-audit --no-fund >> "%OUT%" 2>&1
call npm test >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=TESTS_FAILED
  echo  [X] Tests failed - not deploying. See _ai-setup.txt
  pause
  exit /b 1
)
echo       Tests passed. Building and deploying (4-8 minutes)...

>> "%OUT%" echo --- deploy ---
call "%GC%" run deploy %SERVICE% ^
  --source=. ^
  --region=%REGION% ^
  --project=%PROJECT% ^
  --service-account=%RUNTIME_SA% ^
  --build-service-account="projects/%PROJECT%/serviceAccounts/%DEPLOY_SA%" ^
  --update-env-vars="GEMINI_ENABLED=true,VERTEX_LOCATION=!AI_LOCATION!,GEMINI_MODEL=!AI_MODEL!" ^
  --quiet >> "%OUT%" 2>&1

if errorlevel 1 (
  >> "%OUT%" echo RESULT=DEPLOY_FAILED
  echo  [X] Deploy failed - see _ai-setup.txt
  pause
  exit /b 1
)

>> "%OUT%" echo RESULT=DEPLOYED model=!AI_MODEL! location=!AI_LOCATION!
>> "%OUT%" echo --- END ---

echo.
echo  ============================================
echo   Assistant live: !AI_MODEL! (!AI_LOCATION!)
echo   https://aaranya-scholarly.web.app/submit.html
echo  ============================================
echo.
echo   Sign in, go to step 4, attach a manuscript and
echo   look for the "Manuscript Assistant" panel.
echo.
timeout /t 20 /nobreak >nul
endlocal
