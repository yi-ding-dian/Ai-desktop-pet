# SVG 表情层（glb-model 渲染器）实现报告

> 2026-10-15 · 由 SVG 表情层 Agent 交付。**未提交版本控制**（按约定等用户指令）。
> 目标：解决"GLB 兔子面部是静态贴图、情绪只在整体姿态上表现"的问题——用 SVG/DOM 叠加层给
> 3D 模型的脸做**眨眼 + 情绪表情**（2D 表情叠 3D 角色的混搭风格），跟随头姿投影。

## 1. 改了什么

| 文件 | 说明 |
| --- | --- |
| `frontend/src/modules/pet/renderers/glb-model/face/config.ts` | **新增**：锚点标定数据 + 全部可调参数（颜色/时长/每情绪表情表） |
| `frontend/src/modules/pet/renderers/glb-model/face/overlay.ts` | **新增**：SVG 叠加层（DOM 构建、每帧跟随、眨眼状态机、情绪切换） |
| `frontend/src/modules/pet/renderers/glb-model/index.ts` | 接线：mount 建 stage 挂 SVG 层、每帧投影 3 点、setEmotion/setState 转发、unmount/dispose 清理 |

约束遵守：`PetRenderer` 接口零改动（`setEmotion/setMouth` 签名不变）；未碰 `App.tsx` /
`styles.css` / `PetView.tsx` / backend / `代码设计文档/` / `record.md`；零新依赖（SVG/DOM 原生）；
样式全部内联 + 注入到本层 SVG 内部 `<style>`（不污染全局）。**未重启应用**（靠 HMR 生效）。

## 2. 锚点标定方法（如何重标定）

1. **静态基准截图**：独立 Electron 离屏页（`/tmp/pet-svg-face/calibrate-entry.ts`）用与渲染器
   **完全一致**的相机/光照参数（fov30 / 距离 2.42 / lookAt 0.518 / ACES 1.2）渲染 832² 中性帧；
2. **像素定位**：Python 聚类——绿色虹膜（`g>r+12 & g>b+12`）、暗描边（`lum<110`）、淡粉鼻/嘴
   （`r-g>16`，腮红被 ACES 冲淡需放宽）；得出每只眼睛/鼻/嘴/腮红的像素中心与半轴（`analyze_face*.py`）；
3. **反算脸坐标系**：从相机向像素发射射线与模型求交（`THREE.Raycaster`），命中点投影到
   **脸坐标系**（原点 O=两眼中点、+x=观察者右、+y=屏幕下；法线 ez 用 +Z 对 ex 正交化得到——
   实测用 (eyeR-eyeL)×(nose-O) 会因鼻子"向下"分量把法线带偏 0.7）；
4. **标度**：832² 下 703 px/世界单位（x/y 各向同性，误差 <0.1%）；**真机 208 容器下 ≈176 px/单位**。

标定结果（写死在 `config.ts`，换模型时只改这里）：

```
FACE_ORIGIN = (0.0527, 0.5864, 0.2178)        // 两眼中点（模型本地坐标）
FACE_EX     = (0.9967, 0.0801,-0.0151)        // 观察者右
FACE_EY_DOWN= (0.0802,-0.9968, 0)             // 屏幕下
eyeL (-0.1156, 0,      rx .0569 ry .0455)     eyeR (+0.1156, 0, rx .0526 ry .0426)
nose (0, 0.057,        rx .0327 ry .0256)     mouth (-0.0032, 0.0971, rx .0569 ry .0270)
cheekL (-0.2094, 0.0666)  cheekR (+0.1849, 0.1079)   headTop (0.032, -0.2372)
```

## 3. 元素与参数结构（怎么调）

**坐标系**：全部"脸坐标系"（单位=世界单位，1 单位 ≈ 真机 176px）。渲染器每帧把
O、O+ex×0.05、O+eyDown×0.05 三点投影到屏幕，得到 2D 仿射矩阵写给根组 → **所有元素自动跟随**
头部/整体姿态（弹跳、歪头、转头、缩放、透视）。DOM 约定：**定位用属性 transform（外层），
动画/缩放用 CSS transform（内层）**——CSS 会覆盖属性，混用会跑位。

| 参数组（config.ts） | 作用 | 调整示例 |
| --- | --- | --- |
| `ANCHORS` | 各特征中心/半径 | "眼皮没盖住眼睛"→ 增大对应 eye 的 rx/ry；"腮红偏上"→ 调 cheek*.y |
| `COLORS` | 眼皮/眼睑线/眉线/腮红/符号色 | 眼皮取自标定截图眼周实测色（#ded8ce），改深/改浅都影响"贴脸感" |
| `EMOTION_FACES` | 每情绪 9 个参数：`lidTop`(上眼皮闭合 0–1) `lidBot`(下眼皮上抬，笑眼用) `blush`(0–1) `brow`(none/sad/angry/raise/one) `tears` `squiggle` `openMouth` `eyeRing` `symbol`(question/anger/zzz) | happy 想笑得更眯 → `lidBot 0.6→0.7`；快乐腮红更红 → `blush 0.62→0.8` |
| `BLINK` | 眨眼时长/间隔/双眨概率 | `duration 0.15s`；想更频繁 → `maxGap 6→4` |
| `LID` | 眼皮行程（相对 ry 倍数）+ 眼睑线渐显区间 | 闭眼留缝 → 增大 `closedBase`；眼睑线更早出现 → 减小 `lineFrom` |
| `BROW` | 眉位置（-1.78ry 眼睛上方）/倾斜/线宽 | 眉太高/太低改 `BROW.y` |
| `SYMBOLS` | ？/井/Zzz 位置与字号（相对 headTop） | 符号压到耳朵上 → 减小 x（已按"两耳之间"校准） |
| `TEAR/SQUIGGLE/OPEN_MOUTH/EYE_RING` | 泪光/斜线/张嘴/瞪眼外圈几何 | — |
| `TAU_LID` | 眼皮切换阻尼（0.12s） | 情绪切换眼皮太生硬 → 调大 |
| `INTENSITY` | setEmotion 的 intensity 对 blush/lid 的缩放 | — |
| `SLEEP_OVERRIDE` | state=sleeping 时半合眼下限 + Zzz | — |

**性能**：每帧只写 1 次矩阵 + 眼皮最多 4 次属性（差分写，变化 <阈值不碰 DOM），其余走 CSS
过渡；实测 60.3fps（静息/弹跳/持续半合三态均无掉帧）。**调试钩子**：`__pet.face.debugForceBlink(0…1)`
冻结眨眼相位（截图/调参用），`debugForceBlink(null)` 恢复。

## 4. 验证与截图

| 内容 | 路径 |
| --- | --- |
| 8 情绪 + 眨眼三相 + 姿态跟随（**全身 4×4 拼图**） | `/tmp/pet-svg-face/shots/montage-svg-face-overview.png` |
| 同上**脸部特写拼图**（看表情细节用这张） | `/tmp/pet-svg-face/shots/montage-svg-face-closeup.png` |
| **208×208 真机尺寸** 7 态拼图 | `/tmp/pet-svg-face/shots/montage-svg-face-208.png` |
| 单张：`face-e-*.png`（8 情绪）、`face-blink-open/half/closed.png`、`face-follow-*.png`、`face-state-sleeping.png` | `/tmp/pet-svg-face/shots/` |
| 标定基准：`calib-grid.png`（带 64px 网格）/ `calib-clean.png` | 同上 |
| 真机 HMR 抓屏：`real-thinking-zoom.png`（头顶"？"）、`real-happy-zoom.png`（"？"消失） | 同上 |

**对位精度**：量化验证（832²，眼部窗口绿色=虹膜像素数）：睁眼 4540 → 半合 3339 → 全闭 126
（全闭残留 2.8% 为下缘抗锯齿，目视干净）；像素级核对锚点椭圆与 3D 眼睛/腮红吻合（见拼图特写）。
**真机**：应用 HMR 已生效（抓屏出现"Zzz / ？"且随情绪切换消失，证明 SVG 层在运行中的应用里工作）；
注意当前应用窗口正被**另一位 Agent 的 UI 实验**影响（宠物视图被输入框区域遮挡，兔脸不可见），
故脸部元素（眼皮/腮红）未能真机目视，已在 208 离屏（同一份代码/同尺寸）验证等价路径。

## 5. 需用户确认清单

1. **表情观感**（重点看面部特写拼图）：8 情绪是否够可爱、够克制？——现设计：happy 眯眼笑（下眼睑上抬 + 腮红加深）、
   sad 八字眉 + 泪光、angry 怒眉 + 井号、surprised 挑眉 + 瞪眼圈 + 小张嘴、shy 大红脸 + "///"、
   thinking 单侧挑眉 + "？"、sleepy 半合眼 + Zzz、neutral 仅极淡腮红；
2. **眨眼自然度**：0.15s 全程、2–6s 随机、18% 双眨——真机上体验是否自然/是否要更频繁；
3. **人工感**：模型本身没有眉毛，眉是 SVG 补的（浅棕 #a07c5b）——颜色/粗细是否要调；
4. **符号风格**：？/井/Zzz 的位置（头顶两耳之间）与颜色是否 OK；
5. **neutral 是否保留极淡腮红**（当前 0.22 强度，可设 0 完全素颜）；
6. intensity（后端情绪强度）目前只缩放眼皮/腮红幅度——是否需要更强区分。

## 6. 坑与遗留

- **CSS transform 覆盖 SVG 属性 transform**：导致首版所有定位元素跑位——已用"外层属性定位 +
  内层 CSS 动画"双层结构规避（overlay.ts 头部有 DOM 约定注释）；
- **CSS `translateY(%)` 在 SVG 元素上按包含块(容器 832px)解析**而非自身高度 → Zzz 被甩出画面
  （实测 -316px）——改用 SMIL `animateTransform`（绝对用户单位）；
- **差分写的 NaN 陷阱**：`Math.abs(p - NaN) > 阈值` 恒 false → 首帧不写 DOM、眼皮停在"盖住眼睛"
  的初始位（首轮截图整个脸没眼睛）——初值改 -2 即可；
- **眼皮行程与闭合度的非线性**：p=0.55 ≈ 盖住一半、p=0.4 ≈ 盖 60%（因眼睛只占行程的一部分）——
  调 `EMOTION_FACES.*.lidTop/lidBot` 时按此心算；
- **遗留**：① 表情是"叠加层"风格（肤色眼皮遮 3D 眼 + 2D 线），不是贴图烘焙——凑近看有矢量感，
  这是方案固有特性；② 眨眼只动上眼皮（下眼睑只用于笑眼）；③ true 3D 视角下（大角度转头）
  叠加层是平面近似（当前姿态 yaw ≤0.14rad 完全够用）；④ 待骨骼版模型到位后，本层可作为
  "骨骼表情的补充/兜底"保留，或按用户意愿移除（删 `face/` + index.ts 三处接线即可，无其它影响）。

## 附：临时工具（不在项目内，/tmp/pet-svg-face/）

`calibrate-entry.ts`+`calibrate.html`+`calibrate-main.js`（重标定）、`verify-entry.ts`+`verify.html`
+`verify-main.js`（832 验证）、`verify-208.html`+`verify-208.js`（真机尺寸验证）、
`analyze_face*.py`（像素分析）、`quantify_and_montage.py`（量化+拼图）、`fps-face.js`（帧率）、
`debug-zzz.js`（DOM 调试）。打包命令见各 `.js` 头部注释（esbuild + 项目内 electron）。
