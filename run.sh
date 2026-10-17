#!/usr/bin/env bash
# AI 桌面宠物 —— 源码运行（热启动，不打包）
# 做什么：准备依赖（首次）→ 启动 electron-vite dev（改代码即时生效，无需重新打包）
# 后端不用手动起：Electron 主进程自己拉起 backend/.venv 里的 python -m backend.main
#
# 用法：
#   ./run.sh          准备依赖并启动（默认；Ctrl+C 结束）
#   ./run.sh deps     只准备依赖、不启动（排查环境问题时用）
#
# 本脚本只自举这两处依赖，不碰其它：
#   frontend/node_modules  前端依赖（含 Electron 运行时，首次较慢）
#   backend/.venv          后端虚拟环境（Electron 启动后端时按这个路径找解释器）
#
# 对应 Windows 的 run.bat，两边做的是同一件事。Windows 下本脚本在 Git Bash / MSYS 里也能跑
# （venv 布局按平台认，见下）。
# 脚本名用 ASCII 而不是「运行.sh」：Linux 上这个脚本主要是敲的（./run.sh），
# 中文名每次都得切输入法；而 .bat 是双击的，名字永远不用敲。
set -euo pipefail
# 脚本在项目根：先 cd 过去（npm / python 的相对路径都依赖它）
cd "$(dirname "$0")"

MODE="${1:-run}"
case "$MODE" in
  run|deps) ;;
  *) echo "未知参数：$MODE（用法：./run.sh [deps]；不带参数=启动）" >&2; exit 2 ;;
esac

echo "== 1/3 检查 Node =="
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[失败] 未找到 node/npm。请先安装 Node（https://nodejs.org，建议 LTS），装完重开终端。" >&2
  exit 1
fi
echo "· node $(node -v)"

echo "== 2/3 前端依赖 =="
if [ ! -d frontend/node_modules ]; then
  echo "· 首次运行：npm install（含 Electron 运行时下载，首次较慢）…"
  # 国内网络下 Electron 二进制要走镜像，否则会长时间静默卡住；已自行设置则不覆盖
  export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
  if ! (cd frontend && npm install); then
    echo "[失败] npm install 失败，检查网络后重试。" >&2
    exit 1
  fi
else
  echo "· 已存在，跳过"
fi

echo "== 3/3 后端虚拟环境 =="
# 两种布局都要认：Linux/macOS 是 bin/python；Windows（Git Bash / MSYS）是 Scripts/python.exe
PY=backend/.venv/bin/python
[ -x "$PY" ] || PY=backend/.venv/Scripts/python.exe

if [ ! -x "$PY" ]; then
  echo "· 首次运行：建 venv + 装后端依赖（清华镜像）…"
  if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
    echo "[失败] 未找到 python3/python。请先安装 Python 3.11+，装完重开终端。" >&2
    exit 1
  fi
  PYTHON=python3
  command -v python3 >/dev/null 2>&1 || PYTHON=python
  if ! "$PYTHON" -m venv backend/.venv; then
    echo "[失败] 创建 backend/.venv 失败（检查 python 是否为 3.11+ 且能建 venv）。" >&2
    exit 1
  fi
  PY=backend/.venv/bin/python
  [ -x "$PY" ] || PY=backend/.venv/Scripts/python.exe
fi

# 依赖探针：venv 在但依赖不全（比如上次装到一半）也走安装分支
if "$PY" -c "import fastapi, openai" >/dev/null 2>&1; then
  echo "· 已存在，跳过"
else
  echo "· 安装后端依赖（清华镜像）…"
  # openai / keyring 未写进 pyproject 的 dependencies（已知待补），这里显式带上——
  # 少了 openai，后端启动时 import 就会挂（deploy/build.bat 也是这么装的）
  if ! "$PY" -m pip install -e "backend[dev]" openai keyring \
       -i https://pypi.tuna.tsinghua.edu.cn/simple; then
    echo "[失败] 后端依赖安装失败。若因网络中断，删掉 backend/.venv 后重跑本脚本。" >&2
    exit 1
  fi
fi

if [ "$MODE" = "deps" ]; then
  echo "依赖已就绪（deps 模式：不启动）。直接 ./run.sh 即可跑起来。"
  exit 0
fi

echo "== 启动（后端由 Electron 自动拉起；Ctrl+C 结束）=="
cd frontend && exec npm run dev
