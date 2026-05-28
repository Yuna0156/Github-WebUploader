@echo off
cd /d "%~dp0"

set "PIDFILE=%~dp0server.pid"

REM check if already running
if exist "%PIDFILE%" (
    set /p OLD_PID=<"%PIDFILE%"
    tasklist /FI "PID eq !OLD_PID!" 2>NUL | find /I "node.exe" >NUL
    if not errorlevel 1 (
        echo [WARN] server is already running, PID=!OLD_PID!
        pause
        exit /b
    )
    del "%PIDFILE%" 2>NUL
)

REM start node in background (hidden window)
powershell -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru; $p.Id | Out-File -FilePath '%~dp0server.pid' -Encoding ASCII"

timeout /t 2 /nobreak >NUL

if exist "%PIDFILE%" (
    set /p PID=<"%PIDFILE%"
    echo [OK] server started, PID=!PID!
    echo       http://localhost:8443
    echo.
    echo You can close this window.
) else (
    echo [ERROR] Failed to start server
)

pause
