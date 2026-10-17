@echo off
rem ============================================================
rem  Ollama Model Board - one-click launcher
rem  Starts a local HTTP server and opens the dashboard.
rem  A local http origin is REQUIRED: Ollama's CORS allowlist
rem  rejects "Origin: null", which is what browsers send from
rem  file:// pages. Double-clicking the HTML directly will not work.
rem ============================================================
setlocal
cd /d "%~dp0"

set "PORT=5173"
set "TRY=0"

:port
netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 goto free
set /a TRY+=1
if %TRY% GTR 20 goto noport
set /a PORT+=1
goto port

:free
echo.
echo   Ollama Model Board
echo   ------------------
echo   Serving  : http://127.0.0.1:%PORT%/
echo   File     : ollama-model-board.html
echo   API      : http://127.0.0.1:11434
echo.
echo   Keep this window open while using the dashboard.
echo   Press Ctrl+C or close this window to stop the server.
echo.

rem --- open browser after a short delay so the server is ready ---
rem NOTE: do NOT use backslash-escaped quotes here. CMD does not treat
rem       backslash as an escape character, so \" would be parsed as a
rem       literal file name and trigger a "cannot find file" dialog.
rem ping gives a ~2s delay without relying on timeout.exe.
ping -n 3 127.0.0.1 >nul
start "" "http://127.0.0.1:%PORT%/ollama-model-board.html"

rem --- try python first (fast, no install) ---
python -m http.server %PORT% --bind 127.0.0.1
if errorlevel 1 goto try_py3

goto done

:try_py3
echo.
echo   Python not available, trying "py -3"...
echo.
py -3 -m http.server %PORT% --bind 127.0.0.1
if errorlevel 1 goto try_node

goto done

:try_node
echo.
echo   Python not available, trying Node.js "npx serve"...
echo   (first run may take a moment to download)
echo.
npx --yes serve . -l %PORT%
goto done

:noport
echo.
echo   Could not find a free port in range 5173-5193.
echo   Close whatever is using those ports and try again.
echo.
pause
exit /b 1

:done
echo.
echo   Server stopped.
endlocal
