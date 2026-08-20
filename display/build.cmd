@echo off
rem Build dsh-display.exe (WebView2 display host) with the built-in
rem .NET Framework C# compiler. No SDK / internet required (DLLs bundled).
setlocal
cd /d "%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [build] csc.exe not found. .NET Framework 4.8 required.
  exit /b 1
)
"%CSC%" /nologo /target:winexe /platform:x64 /win32icon:"..\dsh-shell.ico" /out:dsh-display.exe /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll dsh-display.cs
if errorlevel 1 (
  echo [build] FAILED
  exit /b 1
)
echo [build] OK: %~dp0dsh-display.exe
