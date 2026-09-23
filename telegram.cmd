@echo off
setlocal
cd /d "%~dp0"
title Pi Telegram Connection

rem On-demand switch for the phone connection. The switch itself lives in
rem scripts\telegram.ps1: this file only forwards the argument, so the
rem enable/disable semantics have exactly one implementation.
rem
rem   telegram on      connect now, for when you leave home
rem   telegram off     disconnect and stay off, even after a restart
rem   telegram status  show whether the connection is on
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\telegram.ps1" %*
set "SWITCH_EXIT=%ERRORLEVEL%"

rem Started with no argument (a double-click) the switch prints the current
rem state; pause so the window stays readable.
if "%~1"=="" pause

exit /b %SWITCH_EXIT%
