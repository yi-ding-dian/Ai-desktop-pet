#!/bin/bash
# AI 桌面宠物 Linux 打包脚本（PyInstaller 后端 + electron-builder 前端）
# 产物：deploy/release/ai-desktop-pet-<版本>-<arch>.AppImage（免安装单文件；--with-deb 另出 deb）
# 说明：内置 Electron 运行时与 Python 后端，目标机无需安装 Node/Python
# 用法：./deploy/build.sh [--with-deb]
set -euo pipefail
# 脚本在 deploy/ 下，先回到项目根（pyinstaller / npm 都要求项目根为工作目录）
cd "$(dirname "$0")/.."

# 国内网络：Electron 运行时 / electron-builder 工具包默认走 npmmirror（首次打包会下载，
# 官方源在部分网络下会静默卡住）。想用官方源先自行 export 同名变量。
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

WITH_DEB=0
for arg in "$@"; do
  case "$arg" in
    --with-deb) WITH_DEB=1 ;;
    *) echo "未知参数：$arg（可用：--with-deb）" >&2; exit 2 ;;
  esac
done

echo "== 0/4 前置检查 =="

# 工具链预检：缺 node/npm/npx 直接报错，不再跑到一半才失败
for cmd in node npm npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[错误] 未找到 $cmd：请先安装 Node.js（含 npm/npx）并加入 PATH" >&2
    exit 1
  fi
done

# 应用运行中禁止打包：electron-builder 会读写 frontend/out 与资源目录，
# 运行中的实例还会占住产物文件（Linux 上表现是改名/删除失败）。
if pgrep -f "node_modules/electron/dist/electron" >/dev/null 2>&1 || pgrep -x ai-desktop-pet >/dev/null 2>&1; then
  echo "[错误] 检测到 AI 桌面宠物正在运行（开发态或已安装实例），请先退出再打包。" >&2
  exit 1
fi

# dev 应用与 electron-vite build 共用 frontend/out/，会互相污染（见 README「坑」）
if pgrep -f "[e]lectron-vite dev" >/dev/null; then
  echo "⚠️  检测到 electron-vite dev 正在运行：build 会覆盖它使用的 frontend/out/。" >&2
  echo "   请先停掉再打包：pkill -f \"[e]lectron-vite dev\"（打包完再 npm run dev 恢复）" >&2
  exit 1
fi

if [ ! -d frontend/node_modules ]; then
  echo "缺少 frontend/node_modules（先：cd frontend && npm install）" >&2
  exit 1
fi
if [ ! -x frontend/node_modules/.bin/electron-builder ]; then
  echo "· 首次打包：安装 electron-builder（npm install）…"
  (cd frontend && npm install)
fi
if [ ! -x frontend/node_modules/.bin/electron-builder ]; then
  echo "[错误] npm install 后仍找不到 electron-builder（检查网络/镜像与 package.json）" >&2
  exit 1
fi

# —— 后端打包解释器选择 ——
# PyInstaller 要求解释器带共享库（libpython*.so）；本机 backend/.venv 的 Python 是源码
# 编译（无 --enable-shared），此时自动准备独立打包 venv（见 prepare-pack-venv.sh 注释）。
PACK_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ai-desktop-pet-build"
PACK_VENV="$PACK_CACHE/venv"
PYTHON=backend/.venv/bin/python
if [ -x "$PYTHON" ] && "$PYTHON" -c 'import sysconfig,sys; sys.exit(0 if sysconfig.get_config_var("Py_ENABLE_SHARED") else 1)' 2>/dev/null; then
  if [ ! -x backend/.venv/bin/pyinstaller ]; then
    echo "· 首次打包：安装 PyInstaller 到 backend/.venv（清华镜像）…"
    "$PYTHON" -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
  fi
  PYINSTALLER=backend/.venv/bin/pyinstaller
else
  if [ ! -x "$PACK_VENV/bin/pyinstaller" ]; then
    echo "· backend/.venv 的 Python 无共享库（PyInstaller 不支持），准备独立打包环境…"
    deploy/prepare-pack-venv.sh
  fi
  PYINSTALLER="$PACK_VENV/bin/pyinstaller"
fi

echo "== 1/4 PyInstaller 打后端 → frontend/resources/backend/ =="
rm -rf frontend/resources/backend
"$PYINSTALLER" --noconfirm --clean \
  --distpath frontend/resources \
  --workpath deploy/.pyinstaller-build \
  deploy/backend.spec
if [ ! -x frontend/resources/backend/backend ]; then
  echo "[错误] PyInstaller 未产出 frontend/resources/backend/backend（检查上方日志）" >&2
  exit 1
fi

echo "== 2/4 electron-vite build（前端）=="
(cd frontend && npm run build)

echo "== 3/4 electron-builder 打 AppImage $([ "$WITH_DEB" = 1 ] && echo "+ deb") =="
if [ "$WITH_DEB" = 1 ] && ! command -v fakeroot >/dev/null; then
  echo "要打 deb 需要 fakeroot（sudo apt install fakeroot），本次跳过 deb" >&2
  WITH_DEB=0
fi
if [ "$WITH_DEB" = 1 ]; then
  (cd frontend && npx electron-builder --linux AppImage deb)
else
  (cd frontend && npx electron-builder --linux AppImage)
fi

echo "== 4/4 完成，产物在 deploy/release/ =="
ls -lh deploy/release/ | grep -Ei "appimage|\.deb" || ls -lh deploy/release/ || true
