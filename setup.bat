@echo off
cd /d "%~dp0"
where npx >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
echo.
echo Step 1 of 3: sign in to Cloudflare in the browser window that opens.
call npx --yes wrangler@4 login
if errorlevel 1 goto failed
echo.
echo Step 2 of 3: publishing the site.
call npx --yes wrangler@4 deploy
if errorlevel 1 goto failed
echo.
echo Step 3 of 3: choose an admin password for adding and removing companies.
call npx --yes wrangler@4 secret put ADMIN_PASSWORD
if errorlevel 1 goto failed
echo.
echo Done. Your site address is the workers.dev address shown above.
pause
exit /b 0
:failed
echo.
echo Something stopped the setup. Copy the message above and send it to Claude.
pause
exit /b 1
