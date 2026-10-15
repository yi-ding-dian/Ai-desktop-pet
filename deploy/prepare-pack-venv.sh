#!/bin/bash
# 准备「打包专用 Python 环境」（幂等；由 deploy/build.sh 自动调用，也可手动跑）
#
# 背景（本机坑）：backend/.venv 的 Python 3.12 是源码编译安装（/usr/local，未开
# --enable-shared），PyInstaller 硬性要求 libpython*.so，直接报
#   "Python was built without a shared library, which is required by PyInstaller."
# 解法：下载带共享库的独立 CPython（python-build-standalone，与 .venv 同为 3.12.8），
# 在用户缓存目录建一个独立 venv 专供 PyInstaller 使用——不碰 backend/.venv，不改业务代码。
#
# 产出（默认 ~/.cache/ai-desktop-pet-build/，可用 PACK_CACHE 覆盖）：
#   python-3.12.8/   standalone CPython（自带 libpython3.12.so.1.0）
#   venv/            打包 venv（装齐后端依赖 + pyinstaller）
set -euo pipefail

PACK_CACHE="${PACK_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ai-desktop-pet-build}"
PY_DIST="$PACK_CACHE/python-3.12.8"
VENV="$PACK_CACHE/venv"

PY_VERSION=3.12.8
PBS_TAG=20241206   # python-build-standalone 发布标签（含 3.12.8）
# 国内可达镜像（GitHub 直连不通）；备选：https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone
PBS_MIRROR="${PBS_MIRROR:-https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone}"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"

# 依赖清单：与 backend/.venv 已装版本对齐（backend/pyproject.toml + 运行期实际 import：
# openai=llm provider 依赖，keyring=密钥读取链）
DEPS=(
  fastapi==0.143.0
  'uvicorn[standard]==0.54.0'
  pydantic==2.14.1
  loguru==0.7.3
  edge-tts==7.3.1
  openai==3.30.0
  keyring==25.7.0
  pyinstaller==6.22.3
)

# ---- 1) standalone Python ----
if [ ! -x "$PY_DIST/bin/python3" ]; then
  mkdir -p "$PACK_CACHE"
  # install_only_stripped：libpython 已 strip（未 strip 版 200MB+，strip 版 ~15MB，直接决定产物体积）
  ASSET="cpython-$PY_VERSION%2B$PBS_TAG-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
  TARBALL="$PACK_CACHE/cpython-$PY_VERSION-install_only_stripped.tar.gz"
  URL="$PBS_MIRROR/$PBS_TAG/$ASSET"
  echo "· 下载独立 CPython $PY_VERSION（带共享库；$PBS_MIRROR）…"
  curl -sL --fail -o "$TARBALL" "$URL"
  echo "· 校验 sha256 …"
  curl -sL --fail -o "$TARBALL.sha256" "$URL.sha256"
  (cd "$PACK_CACHE" && sha256sum -c <(awk -v f="$(basename "$TARBALL")" '{print $1"  "f}' "$TARBALL.sha256"))
  echo "· 解压到 $PY_DIST …"
  rm -rf "$PACK_CACHE/python" "$PY_DIST"
  tar -xzf "$TARBALL" -C "$PACK_CACHE"
  mv "$PACK_CACHE/python" "$PY_DIST"
fi
"$PY_DIST/bin/python3" -c 'import sysconfig,sys; sys.exit(0 if sysconfig.get_config_var("Py_ENABLE_SHARED") else 1)' \
  || { echo "独立 Python 仍无共享库，异常退出" >&2; exit 1; }

# ---- 2) 打包 venv + 依赖 ----
if [ ! -x "$VENV/bin/pyinstaller" ]; then
  echo "· 创建打包 venv：$VENV …"
  rm -rf "$VENV"
  "$PY_DIST/bin/python3" -m venv "$VENV"
  echo "· 安装后端依赖 + PyInstaller（清华镜像）…"
  "$VENV/bin/pip" install --disable-pip-version-check -q -i "$PIP_INDEX" "${DEPS[@]}"
fi

echo "✅ 打包环境就绪：$VENV/bin/pyinstaller"
"$VENV/bin/pyinstaller" --version
