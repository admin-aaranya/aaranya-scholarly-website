@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  What is actually public right now?
REM
REM  Run this after publishing an article and releasing its issue
REM  (see docs\first-publication-walkthrough.md). Read-only.
REM
REM  It follows the same path a reader or a search engine would:
REM  the journal's issue list, then the issue, then each article
REM  in it, then the article's own page and citation metadata.
REM  Nothing is read from the database - only from public URLs,
REM  which is the point. Anything this cannot see, Google cannot
REM  see either.
REM
REM  Writes _article.txt.
REM ============================================================

set "OUT=%~dp0_article.txt"
set "SITE=https://journals.aaranyascholarly.com"
set "JOURNAL=%~1"
if "%JOURNAL%"=="" set "JOURNAL=alstm"

title Check the published article
cd /d "%~dp0"

> "%OUT%" echo checked_at=%DATE% %TIME%
>> "%OUT%" echo site=%SITE%
>> "%OUT%" echo journal=%JOURNAL%

echo.
echo  Reading the public archive for "%JOURNAL%" ...
echo.

>> "%OUT%" echo.
>> "%OUT%" echo === 1. RELEASED ISSUES ===
>> "%OUT%" echo (empty list means no issue has been released yet)
curl -s "%SITE%/api/public/journals/%JOURNAL%/issues" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo.
>> "%OUT%" echo === 2. LATEST PUBLISHED ARTICLES ===
>> "%OUT%" echo (this is what the journal page's archive strip shows)
curl -s "%SITE%/api/public/latest?journal=%JOURNAL%^&limit=5" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo.
>> "%OUT%" echo === 3. THE ARCHIVE PAGE ===
curl -s -o nul -w "GET /archive/%JOURNAL% -> HTTP %%{http_code}" "%SITE%/archive/%JOURNAL%" >> "%OUT%" 2>&1
>> "%OUT%" echo.

>> "%OUT%" echo.
>> "%OUT%" echo === 4. SITEMAP ===
>> "%OUT%" echo (a published article should appear here as /article/<id>)
curl -s "%SITE%/sitemap.xml" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo === 5. ARTICLE PAGE DETAIL ===
>> "%OUT%" echo (pass an article id as the second argument for the full check:)
>> "%OUT%" echo    0-RUN-CHECK-ARTICLE.bat %JOURNAL% ^<article-id^>
if not "%~2"=="" (
  set "ID=%~2"
  >> "%OUT%" echo.
  >> "%OUT%" echo --- article JSON ---
  curl -s "%SITE%/api/public/articles/!ID!" >> "%OUT%" 2>&1
  >> "%OUT%" echo.
  >> "%OUT%" echo.
  >> "%OUT%" echo --- Google Scholar citation tags on the page ---
  >> "%OUT%" echo (citation_title, citation_author, citation_volume, citation_firstpage
  >> "%OUT%" echo  and citation_pdf_url are the ones Scholar actually needs)
  curl -s "%SITE%/article/!ID!" | findstr /C:"citation_" >> "%OUT%" 2>&1
  >> "%OUT%" echo.
  >> "%OUT%" echo --- is the full text on the page? ---
  >> "%OUT%" echo (count of ^<h2^> headings from the generated HTML galley)
  curl -s "%SITE%/article/!ID!" | find /c "<h2>" >> "%OUT%" 2>&1
  >> "%OUT%" echo.
  >> "%OUT%" echo --- nothing confidential leaked? ---
  >> "%OUT%" echo (each count below MUST be 0)
  curl -s "%SITE%/article/!ID!" > "%TEMP%\_art.html" 2>&1
  <nul set /p "=cover letter occurrences: " >> "%OUT%"
  find /c /i "coverLetter" "%TEMP%\_art.html" >> "%OUT%" 2>&1
  <nul set /p "=storage key occurrences: " >> "%OUT%"
  find /c /i "storedFileName" "%TEMP%\_art.html" >> "%OUT%" 2>&1
  <nul set /p "=suggested reviewer occurrences: " >> "%OUT%"
  find /c /i "suggestedReviewers" "%TEMP%\_art.html" >> "%OUT%" 2>&1
  del "%TEMP%\_art.html" >nul 2>&1
)

>> "%OUT%" echo.
>> "%OUT%" echo --- END ---

echo  Done. Results are in _article.txt
echo.
timeout /t 10 /nobreak >nul
endlocal
