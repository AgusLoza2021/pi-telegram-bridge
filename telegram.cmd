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
rem   (double-click)   open the interactive menu in scripts\telegram.ps1

rem An explicit argument keeps the plain forwarding behavior, including the
rem exit code.
if not "%~1"=="" goto forward

rem A double-click (no argument) opens the interactive menu instead.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\telegram.ps1" -Menu
set "SWITCH_EXIT=%ERRORLEVEL%"

rem Pause so the window stays readable after the menu is quit.
pause
exit /b %SWITCH_EXIT%

:forward
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\telegram.ps1" %*
set "SWITCH_EXIT=%ERRORLEVEL%"

exit /b %SWITCH_EXIT%
