@echo off
rem ============================================================
rem  dsh-shell launcher: start the hidden background shell.
rem  No console window is kept open. dsh keeps running even if
rem  this window/browser panel is closed.
rem ============================================================
cd /d "%~dp0"
if not exist data mkdir data
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Please install Node >= 20 first.
  pause
  exit /b 1
)
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'dsh-shell.mjs' -WorkingDirectory '%~dp0'"
echo dsh-shell started in background.
echo Control panel opens automatically (default http://127.0.0.1:3081, auto-switches if occupied).
echo Closing this window will NOT stop dsh.
exit /b 0