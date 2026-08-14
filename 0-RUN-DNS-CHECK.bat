@echo off
setlocal
REM ============================================================
REM  Where does aaranyascholarly.com actually point?
REM
REM  Owning a domain and pointing it at your site are two
REM  different things. This reads the live DNS records and writes
REM  them to _dns.txt. It changes nothing.
REM
REM  What to look for:
REM
REM    A records   -> 199.36.158.100 means Firebase Hosting.
REM                   Anything in the 34.102.x / 3.33.x / 15.197.x
REM                   range, or a GoDaddy IP, means the domain is
REM                   still parked or pointed elsewhere.
REM
REM    NS records  -> whoever answers for the domain. GoDaddy
REM                   nameservers are fine; they just have to
REM                   carry the right A records.
REM
REM    MX records  -> Google Workspace shows aspmx.l.google.com.
REM                   Empty or GoDaddy defaults means journal email
REM                   is not going where the app assumes.
REM ============================================================

set "OUT=%~dp0_dns.txt"
set "DOMAIN=aaranyascholarly.com"

title DNS check
cd /d "%~dp0"

> "%OUT%" echo checked_at=%DATE% %TIME%
>> "%OUT%" echo domain=%DOMAIN%

echo.
echo  Looking up %DOMAIN% ...
echo.

REM Queried against 8.8.8.8 rather than the local resolver, so a
REM cached or hijacked local answer cannot mislead us.

>> "%OUT%" echo.
>> "%OUT%" echo --- A records (root) ---
nslookup -type=A %DOMAIN% 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- A / CNAME (www) ---
nslookup -type=A www.%DOMAIN% 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- NS (who answers for this domain) ---
nslookup -type=NS %DOMAIN% 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- MX (where email goes) ---
nslookup -type=MX %DOMAIN% 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- TXT (SPF, domain verification) ---
nslookup -type=TXT %DOMAIN% 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- for comparison: the Firebase site ---
nslookup -type=A aaranya-scholarly.web.app 8.8.8.8 >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- what the root domain actually serves ---
curl -s -i "https://%DOMAIN%/" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- does the bare-domain forward PRESERVE THE PATH? ---
>> "%OUT%" echo (A citation shortened to the bare domain + path must land on the
>> "%OUT%" echo  article, not the homepage. Look at the Location: header below --
>> "%OUT%" echo  it should end in /archive/alstm, not just the domain.)
curl -s -i "https://%DOMAIN%/archive/alstm" >> "%OUT%" 2>&1

>> "%OUT%" echo.
>> "%OUT%" echo --- END ---

echo  Done. Results are in _dns.txt
echo.
timeout /t 8 /nobreak >nul
endlocal
