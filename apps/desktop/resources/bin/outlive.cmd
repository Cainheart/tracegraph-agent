@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
set "ELECTRON_RUN_AS_NODE="
set "PATH=%~dp0..\runtime;%PATH%"
"%~dp0..\runtime\node.exe" "%~dp0..\app\apps\cli\dist\index.js" %*
exit /b %errorlevel%
