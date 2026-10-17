@echo off
setlocal
chcp 936 >nul
rem 脚本在项目根：先 cd 过去（npm / python 的相对路径都依赖它）
cd /d "%~dp0"

rem ============================================
rem  AI 桌面宠物 —— 源码运行（热启动，不打包）
rem  做什么：准备依赖（首次）→ 启动 electron-vite dev（改代码即时生效，无需重新打包）
rem  后端不用手动起：Electron 主进程自己拉起 backend\.venv 里的 python -m backend.main
rem
rem  用法：双击运行；或命令行  run.bat deps  只准备依赖、不启动
rem ============================================

set "MODE=%~1"
rem 参数只接受空（启动）或 deps；拼错时不要悄悄启动应用
if not "%MODE%"=="" if /i not "%MODE%"=="deps" (
  echo [错误] 未知参数：%MODE%（用法：run.bat [deps]；不带参数=启动）
  goto :fail
)

echo == 1/3 检查 Node ==
where node >nul 2>nul
if errorlevel 1 (
  echo [失败] 未找到 node/npm。请先安装 Node（https://nodejs.org，建议 LTS），装完重开本窗口。
  goto :fail
)

echo == 2/3 前端依赖 ==
if not exist "frontend\node_modules" (
  echo · 首次运行：npm install（含 Electron 运行时下载，首次较慢）...
  rem 国内网络下 Electron 二进制要走镜像，否则会长时间静默卡住；已自行设置则不覆盖
  if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  pushd frontend
  call npm install
  if errorlevel 1 (popd & goto :err_npm)
  popd
) else (
  echo · 已存在，跳过
)

echo == 3/3 后端虚拟环境 ==
set "NEED_PIP="
if not exist "backend\.venv\Scripts\python.exe" (
  echo · 首次运行：建 venv + 装后端依赖（清华镜像）...
  python -m venv backend\.venv
  if errorlevel 1 goto :err_venv
  set "NEED_PIP=1"
) else (
  rem 依赖探针：venv 在但依赖不全（比如上次装到一半）也走安装分支
  backend\.venv\Scripts\python.exe -c "import fastapi, openai" >nul 2>nul
  if errorlevel 1 (
    echo · 虚拟环境在、但依赖不全（可能上次装到一半），补装...
    set "NEED_PIP=1"
  ) else (
    echo · 已存在，跳过
  )
)
if defined NEED_PIP (
  rem openai / keyring 未写进 pyproject 的 dependencies（已知待补），这里显式带上——
  rem 少了 openai，后端启动时 import 就会挂（deploy\build.bat 也是这么装的）
  backend\.venv\Scripts\python.exe -m pip install -e "backend[dev]" openai keyring -i https://pypi.tuna.tsinghua.edu.cn/simple
  if errorlevel 1 goto :err_pip
)

if /i "%MODE%"=="deps" (
  echo 依赖已就绪（deps 模式：不启动）。直接运行 run.bat 即可跑起来。
  pause
  exit /b 0
)

echo == 启动（后端由 Electron 自动拉起；关窗口或 Ctrl+C 结束）==
rem 控制台切 UTF-8：Electron/Node 的日志按 UTF-8 输出，chcp 936 下会显示成乱码
chcp 65001 >nul
pushd frontend
call npm run dev
if errorlevel 1 (popd & chcp 936 >nul & goto :err_dev)
popd
chcp 936 >nul
echo 已退出。
pause
exit /b 0

:err_npm
echo [失败] npm install 失败，检查网络后重试。
goto :fail
:err_venv
echo [失败] 创建 backend\.venv 失败。若提示找不到 python，请装 Python 3.11+ 并勾选 Add to PATH。
goto :fail
:err_pip
echo [失败] 后端依赖安装失败。若因网络中断，删掉 backend\.venv 目录后重跑本脚本。
goto :fail
:err_dev
echo [失败] electron-vite dev 启动失败，检查上方日志。
goto :fail
:fail
pause
exit /b 1
