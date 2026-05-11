@echo off
setlocal

cd /d "%~dp0"
node "%~dp0scripts\start-current-server.mjs" %*
set "CURRENT_EXIT_CODE=%ERRORLEVEL%"

if not "%CURRENT_EXIT_CODE%"=="0" (
  echo.
  echo Current server stopped with exit code %CURRENT_EXIT_CODE%.
  pause
)

exit /b %CURRENT_EXIT_CODE%
