> ⚠️ 历史快照（2026-10-14，**部分过期**）：工厂缺省现为 glb-model，three-d 保留为可切换实现；WebGL 上下文耗尽、坐标语义混用等教训仍有效。索引见 docs/reports/README.md。

# Three.js 程序化 3D 渲染器报告（企鹅「小豆」3D 版）

> 日期：2026-10-14 20:1x–20:5x；分支工作区未提交。
> 形象：**程序化 3D 几何拼装**企鹅（Three.js，零外部素材），风格 = 软胶玩具感 / 可爱优先（chibi 大脑袋）。
> 依赖：`three@0.186` + `@types/three`（仅此两个新依赖）；应用未重启（Vite 自刷新 + HMR 生效，日志 `/tmp/pet-p3-dev.log`）。

---

## ① 实现说明（架构）

沿用设计文档 §5.3 的"可插拔渲染器"：新增 `three-d/` 作为 `PetRenderer` 的**第二个实现**，工厂缺省 kind 改为 `'three-d'`；`part-animation` 保留可切换。调用方（PetView）只改了一行（`createPetRenderer('part-animation')` → `createPetRenderer()`）。

```text
frontend/src/modules/pet/renderers/
├── types.ts                    PetRenderer 接口（新增 'three-d' 到 PetRendererName）
├── index.ts                    工厂：缺省 'three-d'；localStorage `pet-renderer` 可覆盖为 'part-animation'
└── three-d/
    ├── config.ts               造型参数（唯一事实来源：尺寸/位置/颜色/相机；同 2D 版纪律）
    ├── penguin.ts              几何拼装建模（球/椭球/圆头胶囊/圆弧 + 圆钝心形挤出体）
    ├── emotion-map.ts          8 情绪 → 3D 部件目标姿态（含强度插值）
    ├── animator.ts             动画驱动（缓动/微行为/状态/反应，纯计算不碰场景）
    └── index.ts                ThreeDRenderer：生命周期 + rAF 循环 + 相机/灯光 + applyFrame
```

**关键设计点**

- **渲染循环独立于 React**（同 2D 版）：rAF 自持，帧更新只改 Three.js 对象的 transform/opacity，无 React 重渲染，无几何/材质重建（性能：单场景 ~20 个网格）。
- **层级与动画轴心**（`penguin.ts` 顶部注释有图）：
  `group → root（呼吸/弹跳，原点=脚底）→ tilt（身体倾斜）→ {脚×2, 肉翅×2(肩部轴心), 身体, 肚子, head（原点=头中心：实时头倾斜/俯仰/偏转）→ {头球, 眼×2, 上下喙, 腮红×2, 呆毛(根部轴心)}}`；
  心形粒子挂在根（不受呼吸缩放影响，独立飘出）。
- **透明与排序**：眼/眉/腮红/心形用 `transparent + depthWrite:false`（避免 opacity→0 时的深度遮挡），Three 按相机距离排序渲染（眼白→瞳孔→高光自然分层）。
- **生命周期**：`mount` 幂等（重复调用先卸旧部件）；StrictMode 双挂载安全（日志 installed/disposed 成对）；`unmount` 保留 WebGL 上下文可复用，`dispose` 显式 `forceContextLoss()` 防上下文累积（见 ⑤ 坑 2）。
- **落地页联动**：hitbox/CSS 未动（208×208 @ 96,34），`interactive rects` 日志不变；截图验证 `.pet-view` 内 canvas 自适应容器（ResizeObserver）。

---

## ② 部件与参数结构

部件（全部圆钝几何，**无锐角**）：**头球（chibi 大脑袋，直径≈总高 48%）/身体（压扁拉长球）/白肚（前襟椭球）/眼×2（眼白球 + 大瞳孔球 + 高光球「各一、明显」）/笑眼弧×2（∩ 半圆环）/眉×2（圆头胶囊，仅 angry/sad 显示）/上喙 + 下喙（圆钝椭球，"扁宽小鸭嘴"）/腮红×2（柔粉半透明压扁球）/小肉翅×2（压扁椭球，肩部轴心）/圆球脚×2/呆毛（细锥 + 圆头小球吃尖角）/心形粒子×2（圆底心形挤出体 + 微发光）**。

参数全部集中在 `three-d/config.ts`（`PENGUIN_3D_CONFIG`）：

| 参数组 | 说明 |
|---|---|
| `camera` | 透视 fov 30 / 位置 (0,1.15,4.95) / 视线 (0,1.02,0)；构图留出弹跳与呆毛余量 |
| `body / belly / head` | 身体、白肚、头球（半径 + 头中心高） |
| `headParts.eyes` | 眼位、眼白/瞳孔/高光半径与前移、注视范围、笑眼弧（半径/粗细）、眉（位置/长度/怒眉倾角/悲眉提升） |
| `headParts.beak` | 上喙（中心/三轴/上翘角）、下喙（pivot 轴心/偏移/三轴）、`maxOpenAngle` 口型全开角 |
| `headParts.blush / hair` | 腮红（位置/大小/色/最大不透明度）、呆毛（根部/高/粗细/圆头/前倾角） |
| `wings / feet` | 小肉翅（肩部/偏移/三轴/静息角）、圆球脚 |
| `hearts` | 心形尺寸 + 每颗锚点/延迟/摆幅 |
| `colors` | 全部配色（软、暖、圆润：身体 #5A639B / 奶白肚 #FBF6EE / 暖橙喙脚 #F6A93B·#F6AE4A / 柔粉腮红 #FFADC2） |

**光照**（`three-d/index.ts`）：半球环境光（1.15）+ 暖色主光（1.65）+ 冷色补光（0.75）——没有阴影贴图（性能优先，软胶感靠材质 roughness 0.5–0.65 与高光）。

> 注：头部部件在 config 中用**相对头中心**的局部坐标；眼部下挂的 `arc/brow` 用**相对眼球中心**（字段注释已标明），改的时候别混。

---

## ③ 情绪 / 口型 / 状态映射（怎么调）

### 情绪（`emotion-map.ts` → `EMOTION_POSES`，8 种与后端白名单对齐）

| 情绪 | 眼 | 眉 | 喙 | 腮红 | 头/身 |
|---|---|---|---|---|---|
| neutral | 圆眼大瞳孔 | – | 平 | 淡 | – |
| happy | 眯眼笑弧 ∩ | – | 上翘 + 微张 | 深 | 翅拾起、呆毛后翘、微歪头 |
| sad | 半垂眼、视线下 | 八字眉 | 下压 | 无 | 低头、呆毛前耷、冷色偏 |
| angry | 眯眼瞪、瞳孔缩 | 怒眉（内压） | 下压微张 | 红（变色） | 翅炸起、红紫色偏 |
| surprised | 瞪大 + 瞳孔放大 | – | O 形大张 | 淡 | 微弹起、翅张开、呆毛后竖 |
| shy | 笑眼弧 + 视线躲 | 淡八字眉 | 微翘 | 最浓（大粉团） | 歪头 + 侧脸、身体微倾 |
| thinking | 视线右上飘 | – | 微撇 | 淡 | 歪头、呆毛前倾 |
| sleepy | 眯缝眼、视线下 | – | 小哈欠 | 中 | 低头、呆毛耷、紫偏 |

- **强度插值**：`resolveEmotionPose(emotion, intensity)` 在 neutral 基线与目标间线性插值（幅度变、种类不变）；白名单外回退 neutral。
- **改表情**：改 `EMOTION_POSES` 对应条目（字段含义见 `PetPose3D` 逐字段注释：eyeRound/eyeArc/eyeOpen/pupilScale/lookX/lookY/browAngry/browSad/mouthOpen/beakLift/blush/bodyTilt/headTilt/headPitch/headYaw/wingAngle/hairBend/restOffsetY/tint…）。

### 口型（`setMouth(0–1)`）

下喙绕根部（pivot）下旋 `mouthOpen × maxOpenAngle`（0.45 rad）——闭口时下喙**完全藏在上喙之后**（正面看不到第二层），张开才露出缝隙与深橙内侧。`state=speaking` 且无外部驱动时用内置振荡兜底（"模拟说话"）；voice 域音量包络驱动时外部值优先（调试键 M 在任意状态可强制张嘴）。

### 状态（`setState`，叠加在情绪之上）

| 状态 | 3D 表现 |
|---|---|
| idle | 呼吸（squash & stretch）+ 待机轻摇 + 随机眨眼（2–6s 含连眨）+ 呆毛轻摆 |
| walking | **可爱小碎步**：高频小幅颠步（周期 0.42s）+ 身体节奏摆 + 轻扭（yaw）+ 肉翅前后扇 |
| sleeping | 闭眼缝 + 低头 + 慢呼吸（3.6s 深 1.45×）+ 身体下沉 + 呆毛耷拉 |
| thinking | 头偏 7°+ 视线右上飘 + 身体微摆 |
| speaking | 口型（外部驱动优先/内置振荡兜底） |
| dragging | 眼睛睁大 + 肉翅展开（扑腾感） |

### 即时反应

- `playReaction('pet')`：Q 弹弹跳（欠阻尼弹簧 + 速度驱动拉伸/压缩 squash & stretch）+ 笑眼 + 脸红加深 + 开心抖动 + 呆毛甩动 + **两颗粉心形粒子上浮**（错开 0/240ms、上飘+左右摆+轻旋）。
- `playReaction('look_around')`：头部左右扫视（±24°）+ 视线扫（循环播放覆盖行为时长）。

**动画手感调参**：`animator.ts` 顶部常量（FAST/SLOW_TAU、眨眼时长、呼吸周期、走路步频/幅度、弹簧 k/c/初速、反应与心形时长）。

---

## ④ 验证结果

### 已通过（自动化）

1. **typecheck 通过**（tsconfig.node + tsconfig.web 全量）。
2. **真机挂载**（应用未重启，HMR 生效）：
   `[pet] renderer(three-d) WebGL 上下文已创建` → `renderer(three-d) mounted`；StrictMode/HMR 双挂载 disposed/mounted 成对；日志零 JS 报错。
3. **真机调试键链路（合成 KeyboardEvent 经真实监听走通，验证后注入已移除）**：
   ```text
   [pet] emotion -> happy (intensity=1)      ← 数字键 2
   [pet] debug emotion -> happy
   [pet] mouth -> 1.00                        ← 按住 M
   [pet] mouth -> 0.00                        ← 松开 M
   [pet] emotion -> surprised (intensity=1)  ← 数字键 5
   ```
   同时后端自主行为引擎的真实 state 流（walking/sleeping/idle）持续驱动渲染器。
4. **交互矩形未变**：`[pet] interactive rects = [{96,34,208,208}, …]`（hitbox 无破坏）。
5. **离屏截图验证**（esbuild 打包渲染器 + 独立 Electron offscreen，不影响运行中的应用）：
   - 拼图：`/tmp/pet-3d-preview/shots/` → `emotions-8.png`（8 情绪）/ `states-6.png`（idle/thinking/speaking/sleeping/dragging/walking）/ `mouth-3.png`（口型 0/0.5/1）/ `walk-3.png`（走路三相位）/ `reaction-pet.png`（摸头弹跳 + 心形粒子）/ `dark-bg.png`（深色背景）
   - 单张：`/tmp/pet-3d-preview/shots/*.png`（含 a/b 双帧：随机眨眼会让某帧眼睛闭合，挑睁眼帧）
   - 脚本：`/tmp/pet-3d-preview/{main.js,dark.js,index.html}`（在 /tmp 易失）
6. **真机桌面截图确认**（ffmpeg x11grab 抓屏，屏幕已解锁）：3D 企鹅已在桌面上正常运行——`/tmp/pet-3d-preview/shots/real-desktop.png`（窗口区特写）、`real-desktop-full.png`（全屏）；窗口透明背景正常（周围可见桌面/其他窗口内容，即穿透未受影响）。

### 待用户肉眼确认（⚠ 无法自动确认的主观项）

- [ ] **1. 3D 观感（第一眼"是否想捏一下"）**：软胶玩具感、圆钝无尖角、大眼萌是否达到预期（对照 `emotions-8.png` 与真机）。
- [ ] **2. 比例**：chibi 大脑袋（头≈48% 总高）+ 圆胖矮短身体；在 208×208 hitbox 里的占位是否合适（约 150px 高）+ 是否觉得偏小/偏大。
- [ ] **3. 颜色**：身体 #5A639B / 奶白肚 / 暖橙喙脚 / 柔粉腮红在真机桌面（含深色壁纸 `dark-bg.png`）的对比度与"软暖"感。
- [ ] **4. 动作自然度**：呼吸果冻感、走路小碎步幅度、摸头 Q 弹（弹跳+心形粒子）、睡觉/困倦的可读性——真机连续观察 10s。
- [ ] **5. 表情主观项**：8 情绪哪一个不到位/想改（随时可调 `emotion-map.ts`）；happy 的笑眼弧粗细、angry 怒眉角度、sleepy 缝眼。
- [ ] **6. 真机点击**：摸头反应 + 穿透/拖拽手感（hitbox 未变，预期同 2D 版）。

---

## ⑤ 坑与遗留

### 坑（本次踩到的）

1. **眉毛/笑眼弧"飘到头顶外"（shy/angry 图里的悬浮灰条）**：config 里这两件写的是"相对头中心"坐标，但实现把它们挂在眼睛组内（相对眼球中心）——两套坐标语义叠加导致外移。已统一为**相对眼球中心**并在字段注释里标明（`config.ts` eyes.arc/brow）。
2. **WebGL 上下文累积**：HMR 反复重建渲染器时出现 `Too many active WebGL contexts`（旧实例的上下文未被立即释放）。修复：`dispose()` 里 `dispose() → forceContextLoss()` 显式丢弃（`disposed` 先置位，让 contextlost 监听静默）。修复后日志不再出现。
3. **中性帧"眼睛像细缝"是随机眨眼**：首批截图恰逢眨眼窗口（0.16s/2–6s），误以为造型问题。预览脚本已改为每情绪连截 a/b 两帧人工挑选；造型本身未改（放大复核确认大眼正常）。
4. **透视下的"贴合"容错**：眼球/腮红等贴面件埋进头球的部分会被头球按深度裁掉（只露球冠），所以"正面看是完整圆"靠把球心放在头面附近实现——后续微调这些件的位置时注意 z 值（配置注释已标）。
5. **离屏预览的 headless WebGL**：本机 offscreen Electron 下 WebGL 可用（ANGLE/Mesa Intel），无需 swiftshader 开关；若换机器黑屏，可加 `--enable-unsafe-swiftshader` 试（`diag.js` 可先诊断）。

### 遗留（未做/待接）

- **WebGL 上下文丢失后的自动恢复**：目前只 preventDefault + 日志（真正丢上下文会黑画面、需刷新）；对桌面宠物场景概率极低，未做资源重建。
- **无交互降帧（30→10fps）**：未做（当前常驻 60fps；单场景 ~20 网格开销小）；窗口最小化时 rAF 由浏览器自动暂停。
- **软阴影**：未开启（性能优先）；若想要"落地阴影"可加一颗径向渐变阴影面片（不走 shadowMap）。
- **呆毛摆动是刚性旋转**（不是骨骼弯曲）；若要更柔软需两段式或曲线管。
- **旧 2D 渲染器保留**：`localStorage.setItem('pet-renderer','part-animation')` + 刷新可回退对比（工厂已支持，PetView 零改动）。
- **非 X11 平台**（Windows/macOS）未回归 3D 渲染；离屏预览方案仅在 Linux 验证。
- **离屏预览脚本在 `/tmp/pet-3d-preview/`（易失）**；如需长期保留可搬入项目（未搬：避免污染 `frontend/`）。
