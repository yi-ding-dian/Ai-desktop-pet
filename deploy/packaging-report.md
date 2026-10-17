# Linux 打包报告（AppImage + deb）

- 日期：2026-10-15
- 结论：**打包体系建立完成，AppImage 与 deb 均实测可出、AppImage 已实机启动验证（应用窗口 + 生产态后端 + WS 鉴权全链路通过）**
- 产物：`deploy/release/ai-desktop-pet-0.1.0-x86_64.AppImage`（122.3 MiB）、`deploy/release/ai-desktop-pet-0.1.0-amd64.deb`（98.7 MiB）

## 一、完整流程（deploy/build.sh 的四个阶段）

| 阶段 | 做什么 | 实测耗时 |
|---|---|---|
| 0 | 前置检查：停 dev 检测 / node_modules / electron-builder / 打包解释器选择 | < 1s |
| 1 | PyInstaller 打后端 → `frontend/resources/backend/`（onedir） | ≈ 20s |
| 2 | electron-vite build → `frontend/out/`（main / preload / renderer） | ≈ 5s |
| 3 | electron-builder → `deploy/release/*.AppImage`（`--with-deb` 加打 deb） | AppImage ≈ 10s；deb 首次 ≈ 2m45s（含下 fpm），之后 ≈ 30s |

> `./deploy/build.sh` 端到端整跑实测（含第 0–4 步全部阶段、增量重建）：**31 秒**出 AppImage。
> 全量（首次、PyInstaller 无缓存）整跑 ≈ 1 分钟。

清理旧产物方式：PyInstaller `--noconfirm` 自动覆盖 `frontend/resources/backend/`；electron-builder 自动覆盖 `deploy/release/`。
中间产物：`deploy/.pyinstaller-build/`（PyInstaller 工作区，可随时删）、`deploy/release/linux-unpacked/`（electron-builder 解包目录）。

## 二、实测体积

| 产物/构件 | 大小 | 备注 |
|---|---|---|
| **AppImage** | **128,240,823 B（122.3 MiB）** | gzip 压缩；冷启动实测 < 3s |
| **deb** | **103,488,008 B（98.7 MiB）** | xz 压缩；Installed-Size 291 MB（解包） |
| Electron 运行时（解包） | ≈ 223 MiB | chromium + 原生库；仅保留 zh-CN/en-US 语言包 |
| Python 后端 `resources/backend/` | 58.3 MiB | 见下方拆解 |
| ├ libpython3.12.so.1.0 | 25 MiB | stripped 版独立 CPython；未 strip 时 38 MB，默认发行版 207 MB |
| ├ cryptography/_rust | 12 MiB | keyring→SecretStorage 的依赖，不可省 |
| ├ pydantic_core / uvloop / 其余 | ≈ 21 MiB | 已 strip（uvloop 从 16 MB → 1.7 MB） |
| └ 提示词等数据 | < 100 KB | persona/emotion/memory_extract 三个 md |
| 前端 app.asar | 3.6 MiB | main+preload 约 10 KB、renderer bundle 1.85 MB、兔子模型 glb 1.7 MB |

> 优化过程（供后续参考）：后端 269 MB（首版）→ 100 MB（换 stripped 发行版）→ **59 MB（PyInstaller strip=True）**；
> asar 24 MB（electron-builder 默认带 production deps）→ **3.6 MB（files 排除 node_modules）**。

## 三、启动验证记录（验收标准）

### 1) 后端产物独立可跑（直接执行 `frontend/resources/backend/backend`）

```
PET_READY {"port": 34405, "pid": 1146777, "token": "K6YyrFpX_..."}
```
stderr 日志确认：开发模式启动、配置加载、SQLite 就绪、LLM/TTS/行为引擎/记忆服务全部装配成功。
WS 复测（`/ws` + hello 鉴权）：`hello_ack {"ok": true, "session_id": ..., "protocol_version": 1}`。

### 2) AppImage 实机启动（Deepin/X11、双显示器，`--user-data-dir=/tmp/pet-appimage-data` 隔离数据）

```
[backend] 已拉起子进程 pid=1151021：/tmp/.mount_ai-desOSQKry/resources/backend/backend（生产态）
[main] 宠物窗口已显示
[backend] 启动后端（生产模式）
[backend] 后端就绪 127.0.0.1:35359
[backend] 状态 -> ready（127.0.0.1:35359 pid=1151021）
[backend] WS 连接建立 c_dd18f2f3 / 连接鉴权通过
[backend] 行为引擎已绑定连接 … 被摸头、walk、look_around 行为正常下发执行
```

- 窗口实测截图（第二显示器 +3411,531 处 400x400）：兔子 3D 模型、气泡输入框均正常渲染；
  窗口 WM_CLASS = `ai-desktop-pet`、标题 = 「AI 桌面宠物」（syncDesktopName / productName 生效）。
- **无需 `--no-sandbox`**（内核支持非特权 user namespace）；若目标机受限可加该参数。
- 退出清理：SIGTERM → 后端 `状态 -> stopped`，无僵尸进程。
- dev 停机窗口：约 70 秒（停 dev → 打包 → 启动验证 → 恢复 dev），恢复后 dev 正常运行。

### 3) 验收对照

| 验收项 | 结果 |
|---|---|
| `deploy/release/` 有 AppImage 且体积可描述 | ✅ 122.3 MiB，构成见上表 |
| 启动 AppImage → 窗口起来 + 后端就绪 | ✅ 见日志摘要 |
| `frontend/resources/backend/backend` 独立可跑 | ✅ PET_READY 一行输出 + WS 鉴权通过 |

## 四、踩的坑（详情与解法见 README「坑」一节）

1. **本机 Python 无共享库**（源码编译未开 `--enable-shared`），PyInstaller 硬性拒绝 → 用 python-build-standalone（NJU 镜像）建独立打包 venv，脚本自动准备（`prepare-pack-venv.sh`），不动业务代码。
2. **`.md` 提示词不被 PyInstaller 收集** → spec `datas` 落位 `backend/modules/llm/prompts/`，与代码的 `Path(__file__).parent` 读取法天然兼容（零代码改动）。
3. **体积三连** → stripped CPython + `strip=True` + 排除 node_modules（见上表）。
4. **dev 与 build 共用 out/** → build.sh 检测到 dev 直接报错；`pkill` 必须带方括号技巧（踩了两次自伤）。
5. **deb 打不出来**：先缺 `homepage`（要在 package.json，yml 顶层 schema 不认），再遇 fpm 首次下载（2 分钟）——均解。
6. **collect 清单**：uvicorn/edge_tts/keyring.backends 用 `collect_submodules`，keyring 还要 `copy_metadata`（entry points 动态发现后端）。

## 五、遗留与后续建议

| # | 项 | 说明/建议 |
|---|---|---|
| 1 | **Windows 包未做** | PyInstaller 不支持交叉编译，需在 Windows 机器上跑（同一套 `backend.spec` + electron-builder NSIS/portable）；建议后续上 **GitHub Actions 构建矩阵**（windows-latest + ubuntu-latest），一次 tag 出全部产物（设计文档 §8.2 原方案） |
| 2 | **CI/发版流（release.mjs 那套）未做** | 本期按任务书只做 build；样板 `release.mjs`（升版本号+tag+推+盯 CI）可作为后续模板 |
| 3 | **图标精度** | 当前 icon.png（512×512）从 GLB 高清渲染截图（640×640）裁剪+抠图而来，放大后偏糊；建议后续从 GLB 模型直接高分辨率重渲染或出美术资源 |
| 4 | **deb 安装未实测** | 包结构已验证（backend/asar/desktop/图标落位正确、依赖声明完整）；`dpkg -i` 需 sudo，留待用户实机装一次验证 |
| 5 | **首次使用体验** | 用户拿到包后没有 LLM key——设计文档 §8.3 的首启引导（选服务商/填 key/测试连接）尚未做，试用期需口头指导用户在 config/keyring 配好 key |
| 6 | **自动更新未接** | electron-updater（AppImage/deb 都支持）；首次发布后按需接 |
| 7 | **中文安装目录** | deb 装到 `/opt/AI 桌面宠物/`（productName 决定，与样板原则一致）；如介意可改 productName 或加 `directories`/`deb` 指定路径 |
| 8 | **Windows 杀软误报** | PyInstaller 产物在 Windows 常见误报，后期考虑代码签名（设计文档 §10 #6） |
