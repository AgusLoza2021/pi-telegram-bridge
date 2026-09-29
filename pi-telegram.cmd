@echo off
setlocal
title Pi with Telegram Bridge

rem Starts Pi with the Telegram bridge loaded for THIS window only.
rem
rem Nothing of this project is installed in Pi's auto-discovery folders,
rem so every other Pi window starts exactly as before: no bridge, no
rem extra tool, no extra prompt cost. Use this file when you DO want the
rem phone in the loop.
rem
rem The window still starts DISCONNECTED: use /tg (or "telegram on") when
rem you want the phone connected.
rem
rem Unlike telegram.cmd this file does NOT cd to its own folder: Pi must
rem open the project you are standing in. The launcher resolves the
rem installed payload itself and forwards every argument you pass.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch-pi-with-bridge.ps1" %*
set "PI_EXIT=%ERRORLEVEL%"

exit /b %PI_EXIT%
