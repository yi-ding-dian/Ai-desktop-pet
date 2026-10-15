# deploy — 打包与发布

把项目打成「目标机免装 Node / Python」的 Linux 分发包（AppImage / deb）。
打包脚本会先回到项目根目录（脚本自己 `cd`，不用手动切目录），再依次：PyInstaller 打后端 → electron-vite 打前端 → electron-builder 出安装包。

> **只想把应用跑起来看看**（源码运行、开发调试）：用 `frontend` 里的 `npm run dev`——那是另一件事，不在这个目录里。

| 脚本 | 用途 |
|---|---|
| `build.sh` | Linux 一键打包（AppImage；`--with-deb` 另出 deb） |
| `backend.spec` | PyInstaller 配置（后端 onedir 产物） |
| `prepare-pack-venv.sh` | 准备「打包专用 Python 环境」（见下文「坑 1」；build.sh 自动调用） |

| 产物（落在 `deploy/release/`，已 gitignore） | 大小（2026-10-15 实测） |
|---|---|
| `ai-desktop-pet-<版本>-<arch>.AppImage` | 128 MB（122 MiB）——免安装单文件，双击即跑 |
| `ai-desktop-pet-<版本>-<arch>.deb` | 103 MB（99 MiB）——`sudo dpkg -i` 安装，装到 `/opt/AI 桌面宠物/` |

> **文件名一律 ASCII，界面名称保持中文**：`productName`（应用菜单、窗口标题、安装目录）是「AI 桌面宠物」，而产物文件名写死前缀 `ai-desktop-pet-`（在 `frontend/electron-builder.yml` 的 `artifactName` 里）。原因：中文文件名在下载 URL 里会被百分号编码、命令行和传输环节容易乱码。
> 产物目录由 electron-builder.yml 的 `directories.output` 统一指定（已加进根 `.gitignore`）。目录里除最终产物外还有 `linux-unpacked/` 等中间文件，可以无视。

## Linux：`./build.sh`

```bash
./deploy/build.sh             # 只打 AppImage
./deploy/build.sh --with-deb  # AppImage + deb（deb 打一次约 3 分钟，首次要下 fpm）
```

命令行等价（不重打后端，仅重打前端；需 `frontend/resources/backend/` 已存在）：

```bash
cd frontend
npm run dist:linux       # electron-vite build + electron-builder --linux AppImage
npm run dist:linux-deb   # 同上 + deb
```

> **打包前先停掉 dev 应用**：`npm run dev`（electron-vite dev）与 `electron-vite build` 共用 `frontend/out/`，会互相污染。build.sh 检测到 dev 在跑会直接报错退出。停/恢复：
>
> ```bash
> pkill -f "[e]lectron-vite dev"          # 方括号技巧：防 pkill 误杀自身命令行
> pkill -f "[A]i-desktop-pet/frontend/node_modules/electron/dist"   # 清 Electron 主进程
> # ……打包……
> cd frontend && nohup npm run dev > /tmp/pet-dev.log 2>&1 &        # 恢复
> ```

## 产物怎么用

**AppImage**：下载后 `chmod +x`（或文件管理器直接双击），运行即开宠物窗口。无需安装、无需 root。
本机（Deepin/X11，双显示器）实测：不加 `--no-sandbox` 可直接跑（内核支持非特权 user namespace）。若目标机报 sandbox 相关错误，加 `--no-sandbox` 即可（或装 `libfuse2`/启用 userns）。

**deb**：`sudo dpkg -i ai-desktop-pet-0.1.0-amd64.deb`，从应用菜单启动。依赖已在包声明里（libgtk-3-0、libnss3、libsecret-1-0 等），缺失时 `sudo apt -f install` 补。

**数据目录**：应用数据（config.toml / pet.db / logs）在 `~/.config/ai-desktop-pet/`，正式包与 dev 共用同一目录——换包不丢数据。AppImage 支持 `--user-data-dir=<路径>` 指定独立数据目录（自测常用，避免碰真实数据）。

**Windows 侧**：暂无（NSIS/portable 后续按需补，见下文「遗留」）。

## 打包机前置条件

- Node（`npm` 在 PATH）+ `frontend/node_modules`（没有就 `cd frontend && npm install`）
- `backend/.venv`（dev 环境；`cd backend && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"`）
- **可用的 Python 带共享库**（PyInstaller 的硬性要求）——本机 `backend/.venv` 不够格，脚本会自动准备独立打包环境（见坑 1）
- 首次打包需联网：npm 装 electron-builder、pip 装 PyInstaller、下载独立 CPython（约 20 MB）、electron-builder 首次下载 fpm/appimage 工具（之后走 `~/.cache/electron-builder` 缓存）
- electron-builder 不会从 GitHub 重下 Electron：yml 里 `electronDist` 指到 `node_modules/electron/dist`

## 产物构成（AppImage 122 MiB 拆解，2026-10-15 实测）

| 部分 | 大小 | 说明 |
|---|---|---|
| Electron 运行时 | ≈ 223 MiB（解包后） | 含 chromium；只保留中英文语言包 |
| Python 后端（PyInstaller onedir） | 58 MiB | `resources/backend/`，最大头是 libpython 25 MiB（已 strip） |
| 前端代码（app.asar） | 3.6 MiB | out/main + out/preload + renderer bundle（1.85 MB JS）+ 兔子模型 glb（1.7 MB） |
| AppImage 自身 | 122 MiB | 以上经 gzip 压缩打包（mksquashfs） |

## 坑（都踩过，改前先看）

1. **本机 Python 无共享库，PyInstaller 直接罢工**。`backend/.venv` 的 Python 3.12 是源码编译（`/usr/local`，未开 `--enable-shared`），报
   `Python was built without a shared library, which is required by PyInstaller.`
   解法：`deploy/prepare-pack-venv.sh` 下载带共享库的独立 CPython（python-build-standalone，与 venv 同为 3.12.8；GitHub 不通走南京大学镜像），在 `~/.cache/ai-desktop-pet-build/` 建独立打包 venv（装齐后端依赖 + PyInstaller）。build.sh 会自动选择：`backend/.venv` 能用就用它，不能用就换打包 venv——**不碰 `backend/.venv`，不改业务代码**。
2. **PyInstaller 不收集 `.md` 数据文件**：`backend/modules/llm/prompts/*.md`（人格/情绪/记忆提取提示词）必须用 `backend.spec` 的 `datas` 带上，落位路径与源码目录一致（`prompts/__init__.py` 用 `Path(__file__).parent` 读同目录 md，onedir 下天然兼容，业务代码零改动）。代码里有内置兜底文案——就算漏了也不崩，但会丢提示词资产。
3. **PyInstaller 默认不 strip 调试符号**：产物 269 MB → 开 `strip=True` + 用 stripped 版独立 CPython 后 59 MB（uvloop 单个 `.so` 16 MB → 1.7 MB）。改体积先看这两处。
4. **dev 与打包共用 `frontend/out/`**：先停 dev 再 build（build.sh 有检测报错兜底）。`pkill -f` 请带方括号技巧（`"[e]lectron-vite dev"`），否则会误杀执行命令的 shell 自己。
5. **electron-builder 默认把 production dependencies 打进 asar**（本项目 24 MB 全是废话，react/three 已被 vite bundle 进 renderer）。已在 yml `files` 里显式 `!node_modules/**/*` 排除。若将来主进程直接 `import` 外部依赖，需要放开这条并补文件规则。
6. **deb 打包要 `homepage`**（fpm 强制），只能写在 `package.json`（electron-builder.yml 顶层不认这个字段）。首次打 deb 会下载 fpm（约 2 分钟），之后走缓存。
7. **AppImage 压缩算法保持 gzip**（electron-builder 默认）。样板项目实测：换 xz 产物小 22% 但冷启动 1s → 22s（每次启动都从 squashfs 惰性解压，不吃页缓存）。别改。
8. **后端产物能力边界**：PyInstaller onedir 里 `edge_tts`（动态导入多）、`keyring.backends`（entry points 动态发现，需 `copy_metadata`）、`uvicorn` 子模块（loops/protocols 全动态）都要在 spec 里显式收集，缺一个就是运行期 ImportError。excludes 里排掉了 pytest/pip/setuptools/tkinter 等无用大件。
