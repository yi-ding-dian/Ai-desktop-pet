@echo off
setlocal
chcp 936 >nul
rem 脚本在 deploy\ 下，先回到项目根目录（pyinstaller / npm / electron-builder 都要在项目根跑）
cd /d "%~dp0.."

rem ============================================
rem  Windows 一键打包：PyInstaller 后端 + electron-builder 前端
rem  产物（落在 deploy\release\）：
rem    ai-desktop-pet-<版本>-x64-setup.exe     安装包（NSIS，装到 %LOCALAPPDATA%\Programs\）
rem    ai-desktop-pet-<版本>-x64-portable.exe  免安装单文件，双击即跑（对标 Linux 的 AppImage）
rem  目标机免装 Node/Python（Electron 运行时 + Python 后端都打进包里）
rem
rem  用法：双击运行；或 build.bat [1|3|5|9]
rem        数字 = 7z 压缩级别（默认 3）：越小打包越快、体积越大；越大越慢、越小
rem  注意：**Windows 包必须在 Windows 上打**——PyInstaller 不支持交叉编译，
rem        后端 backend.exe 只能在 Windows 上构建（electron-builder 那半倒是能交叉）
rem ============================================

rem --------------------------------------------
rem  压缩级别：不传参则默认 3
rem  （Windows 打包之所以比 Linux 慢：electron-builder 对 Windows 的 7z 载荷默认用最慢档
rem    -mx=9，243MB 的 Electron 运行时要压好几分钟；调小这一档能明显提速、代价是产物变大）
rem --------------------------------------------
set "LEVEL=%~1"
if "%LEVEL%"=="" set "LEVEL=3"
if not "%LEVEL%"=="1" if not "%LEVEL%"=="3" if not "%LEVEL%"=="5" if not "%LEVEL%"=="9" (
  echo [警告] 压缩级别只支持 1/3/5/9，收到 "%LEVEL%"，改用默认 3
  set "LEVEL=3"
)
set ELECTRON_BUILDER_COMPRESSION_LEVEL=%LEVEL%

rem --------------------------------------------
rem  国内网络：electron-builder 首次运行要从 GitHub 下 winCodeSign / nsis 工具包（会卡死），
rem  未显式指定镜像时走 npmmirror。想用官方源就自己先 set 同名变量。
rem --------------------------------------------
if not defined ELECTRON_BUILDER_BINARIES_MIRROR (
  set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
)

echo ============================================
echo  AI 桌面宠物 Windows 打包（压缩级别 %LEVEL%）
echo ============================================
echo.

if not exist "frontend\node_modules" (
  echo [1/4] 首次打包，先装前端依赖 npm install ...
  pushd frontend
  call npm install
  if errorlevel 1 (popd & goto :err_npm)
  popd
) else (
  echo [1/4] 前端依赖已存在，跳过安装
)

if not exist "backend\.venv\Scripts\pyinstaller.exe" (
  echo [错误] 缺少 PyInstaller：backend\.venv\Scripts\pyinstaller.exe
  echo        先准备打包用的 Python 环境（在项目根执行）：
  echo          python -m venv backend\.venv
  echo          backend\.venv\Scripts\python.exe -m pip install -e "backend[dev]" openai keyring pyinstaller
  goto :fail
)
if not exist "backend\.venv\Scripts\python.exe" (
  echo [错误] 缺少后端虚拟环境：backend\.venv（见上一条命令）
  goto :fail
)

echo.
echo [2/4] PyInstaller 打后端 =^> frontend\resources\backend\ ...
if exist "frontend\resources\backend" rmdir /s /q "frontend\resources\backend"
call backend\.venv\Scripts\pyinstaller.exe --noconfirm --clean --distpath frontend\resources --workpath deploy\.pyinstaller-build deploy\backend.spec
if errorlevel 1 goto :err_pyi
if not exist "frontend\resources\backend\backend.exe" (
  echo [错误] PyInstaller 未产出 frontend\resources\backend\backend.exe
  goto :fail
)

echo.
echo [3/4] electron-vite build（前端）...
pushd frontend
call npm run build
if errorlevel 1 (popd & goto :err_build)
popd

echo.
echo [4/4] electron-builder 打 Windows 包（nsis + portable）...
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
:err_pyi
echo [失败] PyInstaller 打包后端失败，请查看上方日志。
goto :fail
:err_build
echo [失败] 前端构建失败，请查看上方日志。
goto :fail
:err_pack
echo [失败] electron-builder 打包失败。
echo        若是首次运行卡在下载 nsis/winCodeSign，确认镜像变量生效：
echo          ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%
goto :fail
:fail
pause
exit /b 1
