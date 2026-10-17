# 应用图标制作报告（兔子头像）

> 2026-10-15 · 应用图标 Agent 产出 · 复现脚本在 `/tmp/pet-icon/`（临时目录，未入版本控制）

## 生成方法

- **管线**：独立 Electron 离屏页（`/tmp/pet-icon/`）复用 `glb-model` 渲染器（esbuild 打包 `entry.ts`，`--define:import.meta.env.BASE_URL="file://…/frontend/public/"` 直读项目模型），与原验证页同款做法；**1024×1024 渲染 → nativeImage（quality=best）缩到 512/256/128**（超采样，边缘更平滑）。
- **相机（头部特写）**：FOV 30（渲染器缺省）。相机为**自动构图**：对世界 `y ≥ 0.46` 的网格顶点（= 头+双耳，已按 y 分层扫描确认 0.46 以下开始出现身体/手）做投影包围盒迭代校准，使其占画面高度 **85%**、居中。最终相机 `pos≈(0.018, 0.881, 1.496)`、`lookAt≈(0.018, 0.745, 0.200)`（即从脸中心抬高 6°，**微俯视偏正面**，与参考图的观感一致）。
- **表情**：`setEmotion('neutral'|'happy', 1)`；截图前调用渲染器内置调试钩子 `face.debugForceBlink(0)` 冻结眨眼，保证"大眼清晰"。
- **耳朵**：保持渲染器常驻姿态（耳朵形变层 idle 微动，未做额外调整——模型耳朵本身即"自然竖立"，右耳近竖直、左耳外张为模型固有造型）。
- **happy 相位**：happy 有 1.9Hz 弹跳（构图会上下浮动 ~6% 画面高），对弹跳周期连拍 8 帧，取谷值附近构图最饱满的一帧（`y=0.024`）。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `/tmp/pet-icon/raw/icon-neutral.png` | **主版** 512×512（大眼清晰） |
| `/tmp/pet-icon/raw/icon-happy.png` | 备选 512×512（眯眼笑） |
| `/tmp/pet-icon/raw/icon-neutral@1024.png`、`icon-happy@1024.png` | 1024 超采样源（可再导出其他尺寸） |
| `/tmp/pet-icon/preview.png` | 两版并排预览（棋盘格透明底） |
| `frontend/build/icon.png` | **应用主图 512×512**（electron-builder `linux.icon` 约定路径，已用精修版覆盖） |
| `frontend/build/icons/256x256.png`、`128x128.png` | 附加尺寸（electron-builder 多尺寸约定命名） |
| `frontend/build/icon-screenshot-backup.png` | 原 `icon.png`（全身截图版）备份 |

复现脚本：`/tmp/pet-icon/{entry.ts,index.html,compose.js,render-final.js,finalize.js}`。

## 两版对比与选择

- **neutral（大眼）**：眼睛大而清亮（绿瞳+高光），淡腮红。**推荐作为主图标**——缩到 64/32px 后眼睛仍清晰可辨，Dock/任务栏小尺寸辨识度显著更好。
- **happy（眯眼笑）**：笑眼弯月 + 深腮红 + 合十小手，更"甜"；但眯眼在 ≤32px 下几乎不可见（脸上一片白），适合大尺寸展示场景。
- 综合"缩到图标尺寸后的一眼可爱"取 neutral 为主；happy 已按任务一并产出供选。

## 透明背景达成情况

**已拿到真实透明背景**（非纯色底）：
- 主路径用「页面内 rAF 同帧合成」：先 `renderOnce()` 后立即读 WebGL 画布（同帧有效读取窗口），再叠加 SVG 表情层（序列化时补 `width/height`，规避无 viewBox 时 300×150 固有尺寸问题）；
- 同时**实测 offscreen + transparent 窗口的 `capturePage().toPNG()` 也带完整 alpha 通道**（Linux 下同样成立），两条路径输出已交叉比对、肉眼无差；
- 交付 PNG 均为 RGBA，透明区 `alpha=0`、边缘为平滑抗锯齿半透明。

## 坑与备注

1. 渲染器相机初值是全身构图，头部特写需自行校准（本次用"顶点投影包围盒迭代"自动完成，脚本可复用）。
2. happy 弹跳会让构图上下漂移 ±6%，必须连拍挑相位；neutral 的呼吸起伏（±0.006 世界单位）可忽略。
3. 随机眨眼会毁掉"大眼"帧——`face.debugForceBlink(0)` 冻结即可（渲染器自带钩子，零侵入）。
4. 模型左右耳不对称（左耳外张约 54°），画面上部水平视觉重心略偏左，属模型固有造型；构图已按整体包围盒居中，未强行"摆正"。
5. 本图标只改了 `frontend/build/`（图标文件）；应用运行代码、`electron-builder.yml` 均未改动，未提交版本控制。
