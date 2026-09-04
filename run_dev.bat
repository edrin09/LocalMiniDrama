@echo off
rem ============================================================
rem  LocalMiniDrama - 开发模式一键启动脚本 (run_dev.bat)
rem  -----------------------------------------------------------
rem  - 固定端口: 后端 5679 / 前端 3013
rem  - 先杀掉占用端口的旧进程，再启动（严格 PID 校验，避免误杀）
rem  - 删除旧构建产物后重新构建，避免缓存错误
rem  - 在同一终端（Windows Terminal）内以两个标签页启动前后端
rem    tab1 = backend, tab2 = frontend（标题用 PROJECT-backend/-frontend）
rem  - 后端就绪后自动打开浏览器
rem ============================================================
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "PROJECT=LocalMiniDrama"
set "PORT_BACKEND=5679"
set "PORT_FRONTEND=3013"
set "MAX_WAIT=120"

rem 覆盖父 shell 残留 PORT，确保 backend 永远拿到 5679
set "PORT=%PORT_BACKEND%"

rem 临时文件目录
set "TMPDIR=%TEMP%\lmd-startup"
if not exist "%TMPDIR%" mkdir "%TMPDIR%" 2>nul
set "TMP_BAT=%TMPDIR%\run_backend_dev.bat"
set "TMP_BAT_FRONTEND=%TMPDIR%\run_frontend_dev.bat"

echo.
echo ================================================================
echo  %PROJECT%  [开发模式] 一键启动
echo ----------------------------------------------------------------
echo  Backend  : http://localhost:%PORT_BACKEND%/api
echo  Frontend : http://localhost:%PORT_FRONTEND%
echo ================================================================

rem ---- 杀端口 ----
echo.
echo [1/4] 清理占用端口的旧进程 ...
call :kill_project_nodes
call :kill_port %PORT_BACKEND%
call :kill_port %PORT_FRONTEND%
call :wait 1

rem ---- 清理构建产物 ----
echo.
echo [2/4] 删除旧构建产物 ...
call :clean_dir "%ROOT%backend\dist"
call :clean_dir "%ROOT%frontend\dist"

rem ---- 生成后端临时 .bat ----
echo.
echo [3/4] 生成前后端启动脚本 ...

>  "%TMP_BAT%" echo @echo off
>> "%TMP_BAT%" echo cd /d "%ROOT%backend"
>> "%TMP_BAT%" echo set "PORT=%PORT_BACKEND%"
>> "%TMP_BAT%" echo npm run start:dev

>  "%TMP_BAT_FRONTEND%" echo @echo off
>> "%TMP_BAT_FRONTEND%" echo cd /d "%ROOT%frontend"
>> "%TMP_BAT_FRONTEND%" echo npm run dev -- --port %PORT_FRONTEND% --strictPort

rem ---- 用 Windows Terminal 在同一窗口开两个标签 ----
rem  - wt 存在时：单窗口双标签（tab1=backend, tab2=frontend）
rem  - wt 不存在时：退化为两个独立 cmd 窗口
echo [4/4] 启动前后端 ...

where wt >nul 2>&1
if errorlevel 1 goto :fallback_windows

rem 新建一个 Windows Terminal 窗口，开两个标签页（tab1=backend, tab2=frontend）
rem --suppressApplicationTitle 让标题保持自定义标题，不被应用/进程标题覆盖
wt -w _new new-tab --title "%PROJECT%-backend:%PORT_BACKEND%" --suppressApplicationTitle -d "%ROOT%backend" cmd /k call "%TMP_BAT%" ^; new-tab --title "%PROJECT%-frontend:%PORT_FRONTEND%" --suppressApplicationTitle -d "%ROOT%frontend" cmd /k call "%TMP_BAT_FRONTEND%"
if errorlevel 1 goto :fallback_windows
goto :after_launch

:fallback_windows
rem wt 不可用时的兜底：两个独立窗口（保持老行为）
start "%PROJECT%-backend" cmd /c call "%TMP_BAT%"
start "%PROJECT%-frontend" cmd /c call "%TMP_BAT_FRONTEND%"

:after_launch
rem 等待后端就绪
echo   -- 等待后端就绪 (最多 %MAX_WAIT%s) ...
set /a WAITED=0
:wait_backend_loop
netstat -ano 2>nul | findstr /C:"LISTENING" | findstr ":%PORT_BACKEND% " >nul
if not errorlevel 1 goto backend_ready
set /a WAITED+=1
if %WAITED% GEQ %MAX_WAIT% (
  echo.
  echo   [WARN] %MAX_WAIT%s 内未检测到后端端口 %PORT_BACKEND% 监听。
  echo          请查看 "%PROJECT%-backend" 标签页的 nest 启动日志排查。
  goto :eof
)
call :wait 1
goto :wait_backend_loop

:backend_ready
echo   -- Backend is ready.

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

rem 杀掉监听指定端口的所有进程（严格校验 PID 是数字且 >=1）
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
if !KILLED! GTR 0 (
  ping -n 2 127.0.0.1 >nul
)
goto :eof

rem 删除目录（忽略不存在）
:clean_dir
if exist "%~1" (
    echo   -- removing "%~1"
    rmdir /s /q "%~1" 2>nul
)
goto :eof

rem 等待 N 秒（用 ping，永不卡死；ping -n N+1 才是 N 秒）
:wait
set /a WPING=%~1+1
ping -n %WPING% 127.0.0.1 >nul
goto :eof
