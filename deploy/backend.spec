# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：AI 桌面宠物后端（onedir 模式）。

用法（由 deploy/build.sh 调用；也可手动跑，注意先 cd 项目根）：
    backend/.venv/bin/pyinstaller --noconfirm --clean \
        --distpath frontend/resources \
        --workpath deploy/.pyinstaller-build \
        deploy/backend.spec

产物：frontend/resources/backend/backend（可执行）+ frontend/resources/backend/_internal/

设计要点与踩坑备忘（设计文档 §8.2）：
- 入口是 backend/main.py；pathex 指到项目根，让 `import backend.*` 绝对导入可被静态分析。
- **提示词资产（.md）必须用 datas 带上**：PyInstaller 只自动收 .py/.so，不收 .md。
  落位目标 'backend/modules/llm/prompts' 与源码目录结构一致——因为 prompts/__init__.py
  用 `Path(__file__).resolve().parent` 读同目录 md；onedir 下 __file__ 指向
  `_internal/backend/modules/llm/prompts/__init__.pyc`，故 datas 收进同路径即被读到
  （业务代码零改动）。
- uvicorn / edge_tts / keyring.backends 大量动态导入，统一 collect_submodules 收全。
- keyring 经 importlib.metadata 的 entry points 发现后端，需 copy_metadata 随包带 dist-info。
- excludes 掉 pytest/pip/setuptools/tkinter 等运行时无关项，显著减体积。
"""
import os
from PyInstaller.utils.hooks import collect_submodules, copy_metadata

# SPECPATH 由 PyInstaller 注入 = 本 spec 所在目录（deploy/）
PROJECT_ROOT = os.path.abspath(os.path.join(SPECPATH, os.pardir))
PROMPTS_DIR = os.path.join(PROJECT_ROOT, 'backend', 'modules', 'llm', 'prompts')

# ---- 数据文件 ----
datas = [
    (os.path.join(PROMPTS_DIR, name), 'backend/modules/llm/prompts')
    for name in os.listdir(PROMPTS_DIR)
    if name.endswith('.md')
]
# keyring 后端发现走 entry points（importlib.metadata），不带 metadata 会找不到后端
datas += copy_metadata('keyring')

# ---- 隐藏导入 ----
hiddenimports = (
    collect_submodules('uvicorn')          # uvicorn.logging/loops/protocols.* 全为动态导入
    + collect_submodules('edge_tts')       # 7.x 子模块（drm/submaker/...）动态引用
    + collect_submodules('keyring.backends')  # Linux: SecretService/fail/chainer...
    + [
        'aiohttp',                         # edge_tts 运行期核心依赖（兜底显式声明）
        'certifi',                         # edge_tts TLS 证书
    ]
)

# ---- 排除项（运行时用不到的开发/无用大件）----
excludes = [
    'pytest',
    '_pytest',
    'py',
    'pip',
    'setuptools',
    'wheel',
    'tkinter',
    'numpy',
    'PIL',
    'matplotlib',
    'IPython',
]

a = Analysis(
    [os.path.join(PROJECT_ROOT, 'backend', 'main.py')],
    pathex=[PROJECT_ROOT],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,         # strip 收集到的二进制调试符号（实测 uvloop 16MB→1.7MB）
    upx=False,          # 不用 upx：环境未装 + 压缩会拖慢启动
    console=True,       # 必须 console：Electron 靠 stdout 的 PET_READY 行握手
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=True,
    upx=False,
    upx_exclude=[],
    name='backend',
)
