# GLB 模型接入报告（Meshy 兔子 · glb-model 渲染器）

> 日期：2026-10-15；执行：GLB 模型接入 Agent。
> 目标：把外网 Meshy 生成的兔子 GLB 接进桌宠（外观还原度第一），新增 `glb-model` 渲染器并设为缺省。
> 状态：**完成**（贴图压缩达标 / 渲染器全接口实现 / typecheck 通过 / 真机 HMR 验证通过 / 性能实测比 three-d 略低）。
> 截图与对比图：**`/tmp/pet-glb-rabbit/`**（`shots/` 39+10 张、`cmp/` 对比图、`work/` 中间产物）。

---

## 0. 输入变更说明（重要）

用户先后给了两个文件，最终采用后者：

| | 66MB 版（弃用） | **50k 官方重拓扑版（采用）** |
|---|---|---|
| 文件 | `bc4cb73a…glb` 66MB | `4b8dc94a…glb` 22.5MB |
| 面数 | 1,500,000（单网格烘焙） | **50,000**（Meshy 官方重拓扑） |
| UV | 150 万面原始碎片化 UV | 重拓扑后干净大 UV 岛（可读的部件区） |

切换原因（主会话指示）：官方重拓扑版几何质量专业、面数更低。**两版贴图 UV 布局不同、不可互换**（做过提取对比：`work/tex-15m-*` vs `work/tex-50k-*`）。66MB 版的完整减面链产物保留在 `work/02-simplify.glb`（12 万面）与 `work/04-webp.glb`（4.73MB）可回查。

## 1. 贴图压缩数据（几何无损）

原始 22.52MB 中 **20.3MB 是 3 张 4096² PNG**；几何仅 1.22MB。处理链：

```
weld（无损，顶点 28,749 → 28,749 不变）→ resize 2048 → webp --quality 98 --effort 100
```

| 项 | 处理前 | 处理后（`public/models/meshy-rabbit.glb`） |
|---|---|---|
| 总文件 | 22.52 MB | **1.67 MB**（目标 ≤5MB ✓） |
| 三角面 / 顶点 | 50,000 / 28,749 | 50,000 / 28,749（**不变**） |
| baseColor | 4096² PNG · 9.86 MB | 2048² WebP · 242 KB |
| normal | 4096² PNG · 3.58 MB | 2048² WebP · 74 KB |
| metallicRoughness | 4096² PNG · 7.86 MB | 2048² WebP · 129 KB |
| 几何数据 | 1.22 MB | 1.22 MB（f32 顶点 + u16 索引） |

档位选择依据：预算宽松 → 别用 1K q92（1.32MB）省那 0.35MB，直接上 **2K q98**（1.67MB）保贴图质量；q98 下 WebP 已接近无损观感，体积仍远低于 5MB。未用 Draco/meshopt（避免 decoder 依赖，50k 面自身可控）。贴图观感与 66MB 版不同烘焙，50k 版为干净大 UV、无碎片化压缩伪影（对比见 `work/tex-*`）。

## 2. 渲染器接入（新 kind `'glb-model'`，已设为缺省）

### 文件
- `frontend/src/modules/pet/renderers/glb-model/index.ts`（新）——渲染器主体：GLTFLoader 异步加载、包围盒归一化（x/z 居中、脚底贴 y=0）、姿态阻尼合成、渲染循环、生命周期（mount/unmount/dispose + 加载竞态 token）
- `frontend/src/modules/pet/renderers/glb-model/pose.ts`（新）——**姿态层**（纯数据）：8 情绪 + 6 状态 + 反应曲线 + 速度感知合成
- `frontend/src/modules/pet/renderers/index.ts`——工厂注册 + `DEFAULT_PET_RENDERER = 'glb-model'`（localStorage `pet-renderer` 可覆盖回 three-d / part-animation）
- `frontend/src/modules/pet/renderers/types.ts`——`PetRendererName` 增 `'glb-model'`（接口零改动）
- `frontend/src/modules/pet/PetView.tsx`——仅注释更新（缺省说明）
- `frontend/public/models/meshy-rabbit.glb`（新，1.67MB，随 git 走）

### 光照与色调（两轮实验定档，见 `shots/lt-*`、`shots/hi-B-*`）
- 光照：Ambient 1.7 + Hemi 0.95 + Key 0.45 + Fill 0.2（正面照度 ≈ π，白毛干净不过曝；照度 3.8 时腮红被冲淡）
- **ACESFilmicToneMapping + exposure 1.2**（模拟胶片滚降，绿色/腮红饱和度最接近原型；0.9 偏灰、1.5 转黄）
- 相机：fov 30、模型占视锥 0.83、lookAt 高度比例 0.518（实测兔子 171px @ 208 容器，与现役 three-d 兔子 170px 观感一致；脚底留 11px 下沉余量、顶部留 26px 弹跳余量）

### 接口映射（无骨骼 → 整体姿态，幅度克制）
| 接口 | 实现 |
|---|---|
| `setEmotion`（8 情绪） | 姿态字典：happy 弹跳+抬头 / sad 低头下沉 / angry 前倾高频微颤 / surprised 上浮微胀 / shy 微缩低头 / thinking 歪头 / sleepy 缓慢下沉 / neutral 静息微呼吸；intensity 缩幅度 |
| `setState` | walking=轻快起伏+前倾（无腿，注释待骨骼版换真步态）/ sleeping=下沉+慢呼吸 / thinking=侧倾 / speaking=轻点头 / dragging=轻晃 |
| `setMouth` | **no-op**（无嘴部件；注释说明待骨骼/形态键版驱动） |
| `playReaction` | pet=两次衰减弹跳；look_around=左右转头 |
| tick 速度感知 | 复用 three-d 做法：`window.screenX/screenY` 差分测窗口速度 → 移动时前倾 + 起伏频率/幅度匹配步速（步幅 90px 同参） |

动态起伏"同一时刻只播一种"（反应 > 状态 > 移动 > 情绪），静态通道相加后统一阻尼（位移 τ0.22s / 旋转 τ0.28s / 缩放 τ0.35s），避免叠加打架与廉价晃动。

## 3. 验证

- **typecheck**：通过（`npm run typecheck`）。
- **真机**：应用启动后日志 `renderer(glb-model) mounted → 模型就绪：高 1.08，相机距离 2.42，三角面 50000`，无报错；真机抓屏 `shots/real-desktop.png` / `real-pet-final.png`（兔子在桌面上正常显示、透明穿透正常）。
- **真机行为实测（日志统计，glb-model 缺省生效后）**：行为引擎/用户实际操作下 **walk 完成 ×26、look_around 反应 ×18、sleeping ×3、摸头弹跳 ×2、拖拽多次**，全部正常执行、无渲染错误；期间用户直接与宠物互动（摸头/拖拽/移动多屏），显示与交互均正常。
- **离屏截图**（esbuild 打包 + 独立 Electron offscreen，复用上轮方案）：`shots/` 39 张（8 情绪×2、5 状态、walk 相位 7、反应 4、dark 2、回归 4）+ hires 416px 10 张 + 拼图 4 张（`emotions-8` / `states-5` / `walk-phases` / `reaction`）。
- **原型对比**（尺寸对齐）：`cmp/compare-neutral.png`（耳尖→脚底等高并排）、`cmp/compare-emotions.png`（原型 + happy/sad/angry/thinking 五格）。
- **回归**：three-d 企鹅、three-d 程序化兔子、part-animation 截图均正常；真机上临时把缺省切到 three-d（HMR 生效、日志确认）再切回，两端均正常。
- 已知无害日志：HMR 切换浏览器窗口期间出现过 1 次 `SharedImageManager::ProduceSkia` 警告（Electron 切换 WebGL 合成时的瞬时警告，仅 1 次、后续渲染正常）。

## 4. 性能数据（真机 idle，top 瞬时采样）

| 渲染器 | GPU 进程 | Renderer 进程 |
|---|---|---|
| **glb-model（本版）** | **7.5%** | **7.0%** |
| three-d（A/B 对照） | 8.2% | 9.5% |

- **glb-model 比 three-d 略低**（GPU −0.7pp、renderer −2.5pp）——50k 面 + 4 光源在核显上无压力，不引入新的常驻开销。
- 离屏 rAF 帧率：**60fps 满帧**（208px idle / walking / 416px 2x 三档均 60.0–60.2），无掉帧。
- 离屏四渲染器 CPU 对照（`app.getAppMetrics`）：glb 0.7/0.5% vs three-d 0.8/0.8%——同档。
- 内存：GPU 进程 ~124MB、renderer ~166–222MB（全应用口径，未做逐渲染器拆分）。

## 5. 诚实限制

1. **无骨骼 → 不能真走路**：walking 是"轻快起伏 + 前倾"的位移表达（注释已标待骨骼版换真步态）；情绪也是整体姿态语言，**静帧区分度有限**（thinking 歪头、sleepy 下沉最明显；happy/surprised 偏弱）。
2. **无嘴**：`setMouth` no-op，speaking 用轻点头表达（接口契约保持：不抛错、可后续接形态键）。
3. **速度前倾的视觉未逐帧留档**：真机上 walk（窗口移动 ~140px/s）已发生 26 次、走的是与 three-d 同款的速度感知路径，但未录到移动中的姿态特写；建议用户按 W 观察"前倾 + 小起伏"手感。
4. **生产构建的模型加载**：dev（http）已验证；打包后 `file://` 下相对路径 XHR 可能被 CORS 拦（Electron 生产环境），本轮未验证——若发布时加载失败，需在 Electron 侧注册自定义协议或放开 webSecurity。
5. 贴图依赖 `EXT_texture_webp`（Chromium 支持，无风险）；`KHR_materials_specular` 已由 GLTFLoader 处理。

## 6. 下一步建议（骨骼版路线）

**建议用户回 Meshy 对同一模型做 Smart-Rig（绑骨）+ 生成走路/待机动画，导出带动画的 GLB**，替换 `public/models/meshy-rabbit.glb` 后按以下接入点改造（`glb-model/index.ts` 文件头已写注释）：

1. 加载完成后 `new THREE.AnimationMixer(gltf.scene)`，按 clip 名注册 idle/walk；
2. `setState('walking')` → 播 walk clip，`AnimationAction.timeScale` 与窗口测速挂钩（等效现在的速度匹配）；
3. `setEmotion` → 骨骼姿态覆盖层（或 clip 混合），`setMouth` → 下颌骨骼/形态键；
4. 整体姿态层（本版 pose.ts）保留作为"无动画 clip 时"的兜底，两者可逐级降级（有 clip 用 clip，无则回退整体姿态）。
