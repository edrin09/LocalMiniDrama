@echo off
rem ============================================================
rem  LocalMiniDrama - 生产模式一键启动脚本 (run_prod.bat)
rem  -----------------------------------------------------------
rem  - 固定端口: 后端 5679 / 前端 3013
rem  - 先杀掉占用端口的旧进程，再启动（严格 PID 校验）
rem  - 删除旧构建产物后重新构建（后端 nest build + 前端 vite build）
rem  - 以两个带标题的独立终端窗口启动前后端（通过临时 master .bat 派发）
rem  - 后端与前端都就绪后自动打开浏览器
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "PROJECT=LocalMiniDrama"
set "PORT_BACKEND=5679"
set "PORT_FRONTEND=3013"
set "MAX_WAIT=180"

rem 覆盖父 shell 残留 PORT，确保 backend 永远拿到 5679
set "PORT=%PORT_BACKEND%"

set "TMPDIR=%TEMP%\lmd-startup"
if not exist "%TMPDIR%" mkdir "%TMPDIR%" 2>nul
set "TMP_BAT=%TMPDIR%\run_backend_prod.bat"
set "TMP_BAT_FRONTEND=%TMPDIR%\run_frontend_prod.bat"
set "TMP_LAUNCHER=%TMPDIR%\launcher_backend.bat"
set "TMP_LAUNCHER_FRONTEND=%TMPDIR%\launcher_frontend.bat"

echo.
echo ================================================================
echo  %PROJECT%  [生产模式] 一键启动
echo ----------------------------------------------------------------
echo  Backend  : http://localhost:%PORT_BACKEND%/api
echo  Frontend : http://localhost:%PORT_FRONTEND%
echo  (前后端均会先执行 build，再启动服务)
echo ================================================================

echo.
echo [1/5] 清理占用端口的旧进程 ...
call :kill_project_nodes
call :kill_port %PORT_BACKEND%
call :kill_port %PORT_FRONTEND%
call :wait 1

echo.
echo [2/5] 删除旧构建产物 ...
call :clean_dir "%ROOT%backend\dist"
call :clean_dir "%ROOT%frontend\dist"

echo.
echo [3/5] 启动后端（先 build 再 node dist/main）...
>  "%TMP_BAT%" echo @echo off
>> "%TMP_BAT%" echo title %PROJECT%-backend
>> "%TMP_BAT%" echo cd /d "%ROOT%backend"
>> "%TMP_BAT%" echo set "PORT=%PORT_BACKEND%"
>> "%TMP_BAT%" echo npm run build
>> "%TMP_BAT%" echo if errorlevel 1 exit /b 1
>> "%TMP_BAT%" echo npm run start:prod

>  "%TMP_LAUNCHER%" echo @echo off
>> "%TMP_LAUNCHER%" echo title %PROJECT%-backend
>> "%TMP_LAUNCHER%" echo call "%TMP_BAT%"

start "%PROJECT%-backend" cmd /c "%TMP_LAUNCHER%"

echo   -- 等待后端就绪（最多 %MAX_WAIT%s，含构建时间）...
set /a WAITED=0
:wait_backend_loop
netstat -ano 2>nul | findstr /C:"LISTENING" | findstr ":%PORT_BACKEND% " >nul
if not errorlevel 1 goto backend_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT% (
  echo.
  echo   [WARN] %MAX_WAIT%s 内未检测到后端端口 %PORT_BACKEND% 监听，跳过前端启动。
  echo          请查看 "%PROJECT%-backend" 终端的 nest 构建/启动日志排查。
  goto :eof
)
call :wait 1
goto :wait_backend_loop

:backend_ready
echo   -- Backend is ready.

echo.
echo [4/5] 构建并启动前端 ...
>  "%TMP_BAT_FRONTEND%" echo @echo off
>> "%TMP_BAT_FRONTEND%" echo title %PROJECT%-frontend
>> "%TMP_BAT_FRONTEND%" echo cd /d "%ROOT%frontend"
>> "%TMP_BAT_FRONTEND%" echo npm run build
>> "%TMP_BAT_FRONTEND%" echo if errorlevel 1 exit /b 1
>> "%TMP_BAT_FRONTEND%" echo npm run preview -- --port %PORT_FRONTEND% --strictPort

>  "%TMP_LAUNCHER_FRONTEND%" echo @echo off
>> "%TMP_LAUNCHER_FRONTEND%" echo title %PROJECT%-frontend
>> "%TMP_LAUNCHER_FRONTEND%" echo call "%TMP_BAT_FRONTEND%"

start "%PROJECT%-frontend" cmd /c "%TMP_LAUNCHER_FRONTEND%"

echo   -- 等待前端就绪 (最多 %MAX_WAIT%s) ...
set /a FWAITED=0
:wait_frontend_loop
netstat -ano 2>nul | findstr /C:"LISTENING" | findstr ":%PORT_FRONTEND% " >nul
if not errorlevel 1 goto frontend_ready
set /a FWAITED+=1
if %FWAITED% GEQ %MAX_WAIT% (
  echo.
  echo   [WARN] %MAX_WAIT%s 内未检测到前端端口 %PORT_FRONTEND% 监听，跳过打开浏览器。
  echo          请查看 "%PROJECT%-frontend" 终端的 vite build/preview 日志排查。
  goto :eof
)
call :wait 1
goto :wait_frontend_loop

:frontend_ready
echo   -- Frontend is ready.

echo.
echo ================================================================
echo  启动完成！正在打开浏览器 ...
echo    Frontend : http://localhost:%PORT_FRONTEND%
echo    Backend  : http://localhost:%PORT_BACKEND%/api
echo ================================================================
call :wait 3
start "" "http://localhost:%PORT_FRONTEND%"
goto :eof

rem ============================================================
rem  子例程
rem ============================================================

rem 杀掉本项目残留的 node 进程（nest watch / vite / dist main），防止端口竞争与孤儿堆积
:kill_project_nodes
echo   -- scan orphaned project node processes
for /f "usebackq tokens=*" %%i in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*manhua-drama*' } | ForEach-Object { $_.ProcessId }"`) do (
    echo   -- kill orphan pid %%i
    taskkill /f /t /pid %%i >nul 2>&1
)
goto :eof

:kill_port
set "KPORT=%~1"
echo   -- scan port %KPORT%
set /a KILLED=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:"LISTENING" ^| findstr ":%KPORT% "') do (
    set "PID=%%p"
    if "!PID!" neq "" (
        for /f "delims=0123456789" %%x in ("!PID!") do set "NONNUM=%%x"
        if "!NONNUM!"=="" (
            if !PID! GEQ 1 (
                echo   -- kill pid !PID! on port %KPORT%
                taskkill /f /pid !PID! >nul 2>&1
                if not errorlevel 1 set /a KILLED+=1
            )
        )
    )
)
if !KILLED! GTR 0 ping -n 2 127.0.0.1 >nul
goto :eof

:clean_dir
if exist "%~1" (
    echo   -- removing "%~1"
    rmdir /s /q "%~1" 2>nul
)
goto :eof

:wait
set /a WPING=%~1+1
ping -n %WPING% 127.0.0.1 >nul
goto :eof