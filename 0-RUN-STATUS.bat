@echo off
setlocal
REM ============================================================
REM  What is actually provisioned in Google Cloud?
REM
REM  Read-only. Answers the questions you cannot answer by
REM  reading the code, because the code being correct says
REM  nothing about whether the cloud resources it needs exist:
REM
REM    * Is the reminder-sweep scheduler job real, and enabled?
REM      (lib/reminders.js is tested and deployed, but if no job
REM       calls the endpoint, no reminder has ever been sent and
REM       nothing looks broken.)
REM    * Is the Vertex AI API still enabled, and does the runtime
REM      account still hold aiplatform.user? Both are leftovers
REM      from the removed manuscript assistant.
REM    * Which revision is serving, and is a custom domain
REM      attached to Hosting yet?
REM
REM  Writes _status.txt.
REM ============================================================

set "OUT=%~dp0_status.txt"
set "GC=%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
set "PROJECT=aaranya-scholarly"
set "REGION=asia-south1"
set "SERVICE=aaranya-website"
set "RUNTIME_SA=aaranya-website-runtime@aaranya-scholarly.iam.gserviceaccount.com"

title Project status
cd /d "%~dp0"
> "%OUT%" echo checked_at=%DATE% %TIME%

echo.
echo  Reading project status (about 30 seconds)...
echo.

>> "%OUT%" echo.
>> "%OUT%" echo === CLOUD SCHEDULER JOBS ===
>> "%OUT%" echo (expect a reminder-sweep job, state ENABLED)
call "%GC%" scheduler jobs list --location=%REGION% --project=%PROJECT% --format="table(name,schedule,state,lastAttemptTime)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === CLOUD RUN: SERVING REVISION ===
call "%GC%" run services describe %SERVICE% --region=%REGION% --project=%PROJECT% --format="value(status.latestReadyRevisionName,status.url)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === CLOUD RUN: ENVIRONMENT ===
call "%GC%" run services describe %SERVICE% --region=%REGION% --project=%PROJECT% --format="value(spec.template.spec.containers[0].env)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === LEFTOVER AI: is the Vertex API still enabled? ===
>> "%OUT%" echo (no output below means it is NOT enabled - nothing to clean up)
call "%GC%" services list --enabled --project=%PROJECT% --filter="config.name:aiplatform.googleapis.com" --format="value(config.name)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === LEFTOVER AI: does the runtime account hold aiplatform.user? ===
>> "%OUT%" echo (no output below means it does NOT - nothing to clean up)
call "%GC%" projects get-iam-policy %PROJECT% --flatten="bindings[].members" --filter="bindings.role:roles/aiplatform.user AND bindings.members:%RUNTIME_SA%" --format="value(bindings.role)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === FIREBASE HOSTING: custom domains ===
call firebase hosting:sites:list --project %PROJECT% >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === SECRETS ===
call "%GC%" secrets list --project=%PROJECT% --format="value(name)" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- END ---

echo  Done. Results are in _status.txt
echo.
timeout /t 10 /nobreak >nul
endlocal
