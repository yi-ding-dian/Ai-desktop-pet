@echo off
setlocal
chcp 936 >nul
rem 快速打包：只重打前端与安装包，复用已有 frontend\resources\backend\
rem 适用：只改了前端（渲染/主进程/预加载）；改过 backend\ 请用 build.bat 全量
cd /d "%~dp0.."

rem ============================================
rem  AI 桌面宠物 Windows 快速打包（跳过 PyInstaller）
rem  前置：frontend\resources\backend\backend.exe 已存在（先跑过一次 build.bat）
rem  产物：deploy\release\ 下的 setup.exe + portable.exe
rem  说明：PyInstaller 是打包里最慢的一段；前端改动不需要重打后端
rem ============================================

rem 国内网络镜像（与 build.bat 一致）
if not defined ELECTRON_BUILDER_BINARIES_MIRROR (
  set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
)
if not defined ELECTRON_MIRROR (
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
)

echo ============================================
echo  AI 桌面宠物 Windows 快速打包（复用已有后端）
echo ============================================
echo.

rem --------------------------------------------
rem  工具链与运行态预检（同 build.bat）
rem --------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node：请先安装 Node.js 并加入 PATH
  goto :fail
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npm：请先安装 Node.js（含 npm）并加入 PATH
  goto :fail
)
where npx >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 npx：请先安装 Node.js（含 npx）并加入 PATH
  goto :fail
)

tasklist /FO CSV 2>nul | "%SystemRoot%\System32\findstr.exe" /I /C:"ai-desktop-pet" /C:"AI 桌面宠物.exe" >nul
if not errorlevel 1 (
  echo [错误] 检测到 AI 桌面宠物正在运行（安装版/便携版），请先从托盘菜单退出再打包。
  goto :fail
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "if (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Ai-desktop-pet*' }) { exit 1 }"
if errorlevel 1 (
  echo [错误] 检测到开发态 Electron 正在运行（npm run dev），请先停掉再打包。
  goto :fail
)

if not exist "frontend\node_modules" (
  echo [1/3] 首次运行，先装前端依赖 npm install ...
  pushd frontend
  call npm install
  if errorlevel 1 (popd & goto :err_npm)
  popd
) else (
  echo [1/3] 前端依赖已存在，跳过安装
)
if not exist "frontend\node_modules\.bin\electron-builder.cmd" (
  echo [错误] 缺少 electron-builder（npm install 可能未完成）
  echo        删掉 frontend\node_modules 后重新运行本脚本，让依赖完整安装。
  goto :fail
)
if not exist "frontend\resources\backend\backend.exe" (
  echo [错误] 缺少 frontend\resources\backend\backend.exe
  echo        请先完整运行一次 build.bat；改过 backend 时也必须跑全量。
  goto :fail
)

echo.
echo [2/3] electron-vite build（前端）...
pushd frontend
call npm run build
if errorlevel 1 (popd & goto :err_build)
popd

echo.
echo [3/3] electron-builder 打 Windows 包（nsis + portable）...
pushd frontend
call npx electron-builder --win nsis portable
if errorlevel 1 (popd & goto :err_pack)
popd

echo.
echo ============================================
echo  打包完成，产物在 deploy\release\：
echo ============================================
dir /b "deploy\release\*.exe" 2>nul
echo.
echo 目录：%CD%\deploy\release
echo 提示：exe 未签名，首次运行若被 SmartScreen 拦，点「更多信息 → 仍要运行」即可。
pause
exit /b 0

:err_npm
echo [失败] npm install 失败，请检查网络后重试。
goto :fail
:err_build
echo [失败] 前端构建失败，请查看上方日志。
goto :fail
:err_pack
echo [失败] electron-builder 打包失败。
echo        如果是首次运行，可能是 nsis/winCodeSign 下载问题；确认镜像可用：
echo          ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%
goto :fail
:fail
pause
exit /b 1
