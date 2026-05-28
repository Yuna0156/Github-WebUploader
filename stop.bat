@echo off
cd /d "%~dp0"

set "PIDFILE=%~dp0server.pid"

if not exist "%PIDFILE%" (
    echo [INFO] PID file not found, trying port-based cleanup...
    goto killbyport
)

set /p PID=<"%PIDFILE%"
tasklist /FI "PID eq %PID%" 2>NUL | find /I "node.exe" >NUL
if errorlevel 1 (
    echo [INFO] PID %PID% not found, cleaning up PID file...
    del "%PIDFILE%" 2>NUL
    goto killbyport
)

taskkill /PID %PID% /F >NUL 2>&1
if not errorlevel 1 (
    echo [OK] server process killed, PID=%PID%
) else (
    echo [WARN] Failed to kill PID=%PID%
)
del "%PIDFILE%" 2>NUL
goto end

:killbyport
REM fallback: kill any node.exe listening on port 4000 or 8443
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":4000.*LISTENING" 2^>NUL') do (
    taskkill /PID %%a /F >NUL 2>&1
    echo [OK] Killed process on port 4000, PID=%%a
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":8443.*LISTENING" 2^>NUL') do (
    taskkill /PID %%a /F >NUL 2>&1
    echo [OK] Killed process on port 8443, PID=%%a
)

:end
pause
