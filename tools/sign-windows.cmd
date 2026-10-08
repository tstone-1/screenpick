@echo off
rem Tauri's sign command (src-tauri/tauri.signing.conf.json). It is a .cmd
rem because the uninstaller is signed from inside makensis, which starts the
rem command through the shell and from another directory. The work is in
rem sign-windows.ps1.
rem
rem The script is named by SCREENPICK_SIGN_SCRIPT and not found beside this
rem file: makensis starts this file by its quoted name through PATH, and cmd
rem then gives %~dp0 as the current folder. A wrapper that looked beside
rem itself left an uninstaller unsigned: makensis printed "UninstFinalize
rem command returned 64" and did not treat it as an error.
if not defined SCREENPICK_SIGN_SCRIPT (
  echo SCREENPICK_SIGN_SCRIPT is not set 1>&2
  exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCREENPICK_SIGN_SCRIPT%" %1
exit /b %ERRORLEVEL%
