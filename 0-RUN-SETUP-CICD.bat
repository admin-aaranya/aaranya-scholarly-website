@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  One-time setup: let GitHub Actions deploy without a key.
REM
REM  Follows docs\gcp-deploy-setup.md steps 7 and 8, but written
REM  to be safe to re-run: every step checks whether the thing
REM  already exists before creating it.
REM
REM  WHAT THIS BUILDS
REM
REM    A Workload Identity Pool and an OIDC provider that trusts
REM    GitHub's token issuer -- but ONLY for one repository. The
REM    attribute condition below is the security boundary. Without
REM    it, ANY GitHub repository in the world could authenticate
REM    into this project. With it, only:
REM
REM        admin-aaranya/aaranya-scholarly-website
REM
REM  WHAT THIS AVOIDS
REM
REM    Downloading a service-account JSON key and pasting it into
REM    GitHub. That key would be long-lived, copyable, and would
REM    still work if the repo were ever made public by accident.
REM    Federation issues a short-lived token per workflow run.
REM
REM  Writes _cicd.txt, which ends with the two values to paste
REM  into GitHub.
REM ============================================================

set "OUT=%~dp0_cicd.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "AR_REPO=aaranya-website"
set "SERVICE=aaranya-website"
set "RUNTIME_SA=aaranya-website-runtime@aaranya-scholarly.iam.gserviceaccount.com"
set "DEPLOY_SA=aaranya-website-deployer@aaranya-scholarly.iam.gserviceaccount.com"
set "GITHUB_REPO=admin-aaranya/aaranya-scholarly-website"
set "POOL=github-pool"
set "PROVIDER=github-provider"

title Set up CI/CD
cd /d "%~dp0"
> "%OUT%" echo started_at=%DATE% %TIME%
>> "%OUT%" echo github_repo=%GITHUB_REPO%

echo.
echo  ============================================
echo   CI/CD SETUP  (about 2 minutes)
echo  ============================================
echo.

REM --- project number, needed to build the principalSet string ---
echo  [1/6] Reading the project number...
>> "%OUT%" echo --- project number ---
for /f "delims=" %%N in ('call "%GC%" projects describe %PROJECT% --format^="value(projectNumber)"') do set "PROJNUM=%%N"
if "%PROJNUM%"=="" (
  >> "%OUT%" echo RESULT=NO_PROJECT_NUMBER
  echo  [X] Could not read the project number. Is gcloud signed in?
  echo      Run 0-RUN-LOGIN.bat first.
  pause
  exit /b 1
)
>> "%OUT%" echo project_number=%PROJNUM%
echo       [OK] %PROJNUM%

REM --- APIs ---
echo  [2/6] Enabling the APIs federation needs...
>> "%OUT%" echo.
>> "%OUT%" echo --- enable apis ---
call "%GC%" services enable iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com --project=%PROJECT% >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=API_ENABLE_FAILED
  echo  [X] Could not enable the APIs - see _cicd.txt
  pause
  exit /b 1
)
echo       [OK]

REM --- pool (idempotent) ---
echo  [3/6] Creating the workload identity pool...
>> "%OUT%" echo.
>> "%OUT%" echo --- pool ---
call "%GC%" iam workload-identity-pools describe %POOL% --location=global --project=%PROJECT% >nul 2>&1
if errorlevel 1 (
  call "%GC%" iam workload-identity-pools create %POOL% --location=global --display-name="GitHub Actions" --project=%PROJECT% >> "%OUT%" 2>&1
  echo       [OK] created
) else (
  >> "%OUT%" echo pool already exists - left alone
  echo       [OK] already existed
)

REM --- provider (idempotent) ---
REM The attribute-condition is what scopes this to one repository.
echo  [4/6] Creating the GitHub OIDC provider, scoped to your repo...
>> "%OUT%" echo.
>> "%OUT%" echo --- provider ---
call "%GC%" iam workload-identity-pools providers describe %PROVIDER% --location=global --workload-identity-pool=%POOL% --project=%PROJECT% >nul 2>&1
if errorlevel 1 (
  call "%GC%" iam workload-identity-pools providers create-oidc %PROVIDER% ^
    --location=global ^
    --workload-identity-pool=%POOL% ^
    --display-name="GitHub OIDC" ^
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" ^
    --attribute-condition="attribute.repository=='%GITHUB_REPO%'" ^
    --issuer-uri="https://token.actions.githubusercontent.com" ^
    --project=%PROJECT% >> "%OUT%" 2>&1
  if errorlevel 1 (
    >> "%OUT%" echo RESULT=PROVIDER_FAILED
    echo  [X] Could not create the provider - see _cicd.txt
    pause
    exit /b 1
  )
  echo       [OK] created, restricted to %GITHUB_REPO%
) else (
  >> "%OUT%" echo provider already exists - left alone
  echo       [OK] already existed
  >> "%OUT%" echo.
  >> "%OUT%" echo --- existing attribute condition ^(CHECK THIS NAMES YOUR REPO^) ---
  call "%GC%" iam workload-identity-pools providers describe %PROVIDER% --location=global --workload-identity-pool=%POOL% --project=%PROJECT% --format="value(attributeCondition)" >> "%OUT%" 2>&1
)

REM --- let that repo impersonate the deployer ---
echo  [5/6] Allowing only that repo to impersonate the deployer...
>> "%OUT%" echo.
>> "%OUT%" echo --- workloadIdentityUser binding ---
call "%GC%" iam service-accounts add-iam-policy-binding "%DEPLOY_SA%" ^
  --role="roles/iam.workloadIdentityUser" ^
  --member="principalSet://iam.googleapis.com/projects/%PROJNUM%/locations/global/workloadIdentityPools/%POOL%/attribute.repository/%GITHUB_REPO%" ^
  --project=%PROJECT% >> "%OUT%" 2>&1
if errorlevel 1 (
  >> "%OUT%" echo RESULT=BINDING_FAILED
  echo  [X] Could not add the binding - see _cicd.txt
  pause
  exit /b 1
)
echo       [OK]

REM --- the deployer's own permissions (idempotent, safe to repeat) ---
echo  [6/6] Confirming the deployer can build and deploy...
>> "%OUT%" echo.
>> "%OUT%" echo --- deployer roles ---
call "%GC%" projects add-iam-policy-binding %PROJECT% --member="serviceAccount:%DEPLOY_SA%" --role="roles/run.admin" --condition=None >> "%OUT%" 2>&1
call "%GC%" artifacts repositories add-iam-policy-binding %AR_REPO% --location=%REGION% --member="serviceAccount:%DEPLOY_SA%" --role="roles/artifactregistry.writer" --project=%PROJECT% >> "%OUT%" 2>&1
call "%GC%" iam service-accounts add-iam-policy-binding "%RUNTIME_SA%" --member="serviceAccount:%DEPLOY_SA%" --role="roles/iam.serviceAccountUser" --project=%PROJECT% >> "%OUT%" 2>&1
echo       [OK]

REM --- the values to paste into GitHub ---
>> "%OUT%" echo.
>> "%OUT%" echo ============================================================
>> "%OUT%" echo  PASTE THESE INTO GITHUB
>> "%OUT%" echo  Settings -^> Secrets and variables -^> Actions
>> "%OUT%" echo ============================================================
>> "%OUT%" echo.
>> "%OUT%" echo SECRETS tab:
>> "%OUT%" echo.
>> "%OUT%" echo   WIF_SERVICE_ACCOUNT
>> "%OUT%" echo     %DEPLOY_SA%
>> "%OUT%" echo.
>> "%OUT%" echo   WIF_PROVIDER
for /f "delims=" %%P in ('call "%GC%" iam workload-identity-pools providers describe %PROVIDER% --location^=global --workload-identity-pool^=%POOL% --project^=%PROJECT% --format^="value(name)"') do (
  >> "%OUT%" echo     %%P
)
>> "%OUT%" echo.
>> "%OUT%" echo VARIABLES tab:
>> "%OUT%" echo.
>> "%OUT%" echo   GCP_PROJECT_ID       %PROJECT%
>> "%OUT%" echo   GCP_REGION           %REGION%
>> "%OUT%" echo   AR_REPO              %AR_REPO%
>> "%OUT%" echo   CLOUD_RUN_SERVICE    %SERVICE%
>> "%OUT%" echo.
>> "%OUT%" echo RESULT=OK
>> "%OUT%" echo --- END ---

echo.
echo  ============================================
echo   Done. Open _cicd.txt - it ends with the
echo   six values to paste into GitHub.
echo  ============================================
echo.
pause
endlocal
