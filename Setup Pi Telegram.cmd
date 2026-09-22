@echo off
setlocal
cd /d "%~dp0"
title Pi Telegram Setup

echo Setting up Pi Telegram. This usually takes a minute or two.
echo.

rem Dependency preflight: verify the local tools and files before anything
rem that could prompt for a credential, so a clean checkout fails friendly.
where node.exe >nul 2>&1
if errorlevel 1 goto missing-tools
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing-tools
if not exist "package.json" goto missing-tools
if not exist "package-lock.json" goto missing-tools

rem Node.js version gate: this setup needs Node.js 24 or newer. It runs
rem before the dependency comparison so an old Node never reaches the
rem dependency install step.
node -e "if(!(parseInt(process.versions.node.split('.')[0],10)>=24)){process.exit(1)}"
if errorlevel 1 goto node-too-old

rem Compare the expected qrcode-terminal version in package.json against the
rem locally installed copy; when they agree there is no network access.
node -e "const fs=require('fs');const expected=JSON.parse(fs.readFileSync('package.json','utf8')).dependencies['qrcode-terminal'];let installed=null;try{installed=JSON.parse(fs.readFileSync('node_modules/qrcode-terminal/package.json','utf8')).version}catch(e){}if(expected&&installed===expected){process.exit(0)}process.exit(1)"
if errorlevel 1 goto install-dependencies
goto launch-setup

:install-dependencies
echo One moment. Getting one small helper package from the internet. This only happens when it is missing.
if not exist ".local\logs" mkdir ".local\logs"
npm ci --ignore-scripts --omit=dev --no-audit --no-fund >".local\logs\setup-dependencies.log" 2>&1
set "NPM_EXIT=%ERRORLEVEL%"
if not "%NPM_EXIT%"=="0" goto dependencies-failed
goto launch-setup

:missing-tools
echo This setup needs Node.js on this computer.
echo Install Node.js from nodejs.org, then try this setup again.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:node-too-old
echo This setup needs a newer Node.js on this computer.
echo Get the current version from nodejs.org, install it, then try this setup again.
echo.
echo Press any key to close this window.
pause >nul
exit /b 1

:dependencies-failed
echo Setup couldn't prepare the required local files. Check your internet connection and try again.
echo For help, open the README file in this folder and look for the "Fix problems" section.
echo.
echo Press any key to close this window.
pause >nul
exit /b %NPM_EXIT%

:launch-setup
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\setup.ps1" -Beginner
set "SETUP_EXIT=%ERRORLEVEL%"

echo.
if "%SETUP_EXIT%"=="0" (
    echo Setup complete.
    echo Open or restart Pi, type /tg, choose Connect, then send a normal Telegram message.
) else (
    echo Setup stopped before it could finish.
    echo Your existing link and settings were kept safe.
    echo For help, open the README file in this folder and look for the "Fix problems" section.
)

echo.
echo Press any key to close this window.
pause >nul
exit /b %SETUP_EXIT%
