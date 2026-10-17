# 报告索引（docs/报告/）

> **这些是"证据层"，不是"当前文档"**：每份记录的是**当时**实测到了什么、踩了什么坑、为什么这么做。
> 当前实现的权威描述在 `代码设计文档/项目详细设计.md`（结论层）——两者结论冲突时以设计文档 + 代码为准。
> 各报告的文件头有状态标注：**仍有效** / **部分过期** / **已过期**。

**怎么用**：动某块代码之前，先查下表有没有对应报告——多半能省掉一次重踩。
历史阶段（P1/P2/P3）的报告还能说明"为什么当初选了这个方案"。

---

## 前端（14 份）

| 报告 | 主题 | 状态 | 要点 / 结论去向 |
|---|---|---|---|
| `verify-report.md` | X11 窗口能力验证（P1-1/2） | 部分过期 | `setIgnoreMouseEvents(forward)` 在 X11 **不转发 mousemove**；`getCursorScreenPoint` 出窗**冻结**；`setShape([])` 会让输入区变空 → §5.1（而穿透主机制已被"空气让路"取代） |
| `p1-connect-report.md` | 前后端打通（P1-4） | 部分过期 | spawn→PET_READY→IPC→WS→hello 全链路；**后端收 SIGTERM 为默认终止（143）非优雅退出** → §3.4/§3.6/§5.2/§7.3，SIGTERM 记为风险 §10 #11 |
| `p2-voice-front-report.md` | 前端语音（P2-2） | 仍有效 | 音频帧与后端逐字段交叉验证；`stopAll` 后 isSpeaking 未复位的真机 bug → §3.5/§4.4/§5.5 |
| `p3-behavior-report.md` | 行为前端执行器 | 仍有效 | 逐帧 setBounds 移动 + clamp 防出屏；打断矩阵 4 触发；**首轮 bug：执行器漏订阅 behavior** → §4.5.5/§7.4 |
| `pet-prototype-report.md` | 部件动画企鹅原型 | 部分过期 | 可插拔渲染器接口落地；**离屏 Electron + capturePage 是唯一可靠视觉验证法**（被后续所有视觉报告沿用）；part-animation 已非缺省 |
| `three-d-report.md` | 程序化 3D 企鹅 | 部分过期 | **HMR 反复重建会耗尽 WebGL 上下文** → dispose 里 forceContextLoss；两套坐标语义混用致部件"飘头顶" |
| `three-d-rabbit-report.md` | 程序化毛绒兔子 v3 | 已过期 | **程序化几何做不到真实毛绒感，出路是引入真实 3D 模型**——正是这条结论导向了 glb-model 路线 → §0 #15 |
| `glb-rabbit-report.md` | GLB 兔子接入 | 仍有效 | 贴图链压到 1.67MB；真机性能略优于 three-d；无骨骼→整体姿态；**生产 file:// 下相对路径 XHR 可能被 CORS 拦（至今未解）** |
| `svg-face-report.md` | GLB 兔子 SVG 表情层 | 仍有效 | 锚点标定链（换模型只需重跑）；**CSS transform 会覆盖 SVG 属性 transform**；SVG `translateY(%)` 按包含块解析；差分写 NaN 陷阱 |
| `ears-v1-report.md` | 耳朵形变层 v1 | 仍有效 | **一体网格顶点形变 >15° 耳根会破洞**——真垂耳必须骨骼模型；mesh 本地空间带 +90° 节点旋转坑 |
| `fx-report.md` | 魔法球隐藏/显示动画 | 仍有效 | 球窗方案（全屏层被否决）；**托盘图标位置无 API → 抓屏 + 模板匹配，且纯灰度 NCC 会误配、必须叠 RGB 校验**；DDE 自动化坑（xdotool windowclose 会崩 GPU） |
| `tray-report.md` | 系统托盘 + Dock 隐藏 | 部分过期 | **DDE 忽略 skipTaskbar → `type:'toolbar'` 可消除 Dock 窗口格**（现被宠物窗/气泡窗沿用）；原生菜单已被自绘主题菜单取代 |
| `icon-report.md` | 应用图标（兔子头像） | 仍有效 | **neutral（大眼）优于 happy（眯眼）——小尺寸辨识度是选型判据**；透明窗 capturePage 在 Linux 也带完整 alpha |
| `hide-debug-bar-report.md` | 隐藏调试状态栏 | 仍有效 | 显隐状态单源在渲染侧（主进程只转发翻转事件）；条件渲染而非 CSS 隐藏（交互矩形随之增删） |

## 后端（4 份）

| 报告 | 主题 | 状态 | 要点 / 结论去向 |
|---|---|---|---|
| `p1-llm-report.md` | LLM 接入（P1-5） | 部分过期 | **推理型模型思考在 `delta.reasoning_content`，只取 content 天然跳过**；key 链 env>keyring>文件(600) + 全链路脱敏；openai SDK 底层是 httpx2 → 测试须 `Mock(spec=...)` → §4.1/§6.3 |
| `p2-voice-report.md` | TTS 流水线（P2-1） | 仍有效 | 分句器契约（弱边界 ≥6 字才切、小数点保护）；**音频帧永不超过 reply_end**；edge-tts 超时参数必须是 int；首帧 1.63–1.97s → §4.4/§3.5 |
| `p3-behavior-report.md` | 自主行为引擎 | 仍有效 | 超时兜底 = 预期时长 + 5s；**断开清理靠每秒轮询 `sink.is_closed()`**；恢复型行为被打断按半额记账 → §4.5.2/§4.5.3/§7.4 |
| `p3-memory-report.md` | 记忆与持久化 | 仍有效 | **网关 4 个 embedding 模型全 503 → 降级为"结构化记忆 + 规则召回"**（bigram Dice ≥0.65 去重）；提取失败也推进水位 → §4.3"实现状态"/§6.2 |

---

## 一、硬结论尚未进设计文档（这些报告最值得留）

| 报告 | 未吸收的结论 | 现状 |
|---|---|---|
| `glb-rabbit` | 生产 file:// 加载 GLB 的 CORS 风险；需自定义协议或放开 webSecurity | **未实现**，打包版风险仍在 |
| `fx` | 托盘位置无 API、NCC 需叠 RGB 校验、DDE 专用验证姿势、xdotool windowclose 崩 GPU | 仅活在代码注释里 |
| `ears-v1` | 顶点形变 >15° 破洞 → 真垂耳必须骨骼模型 | 文档无耳朵条目 |
| `svg-face` | SVG 表情层的三个硬坑与标定链 | 文档无 face 条目 |
| `verify-report` | `setShape([])` 输入区变空的陷阱（气泡窗仍用 setShape）；Wayland 降级未实测 | §5.1 只吸收了部分 |
| `tray` | DDE toolbar 实证 | 仅在 `linux.ts` 注释 |
| `p1-llm` | LLM 错误码表（报告自己就建议补进设计文档）；失败收尾时序 | 未补 |
| `p1-connect` | SIGTERM 非优雅退出（§10 #11 已登记，代码无显式处理） | 半吸收 |

## 二、报告里提过、今天还没做的待办

拖拽看门狗（§10 #12）· TTS provider 层重试（§4.4）· **前端 load_history 回填**（§3.6）· 记忆管理页的查看/删除（现只有一个开关）· 手动触发记忆提取的 WS 事件 · `embed()` 向量召回 · proactive 主动对话 / mood 持久化 · vitest 单测体系 · 从 Pydantic 生成 TS 协议类型 · Windows 子进程树清理（taskkill /T）· 生产构建 CSP · 生产 file:// 模型加载方案 · nap/sleep 视觉区分。

**已闭环的旧建议**（不必再提）：interrupt 按钮、pet_event 前后端闭环、get_config/set_config/test_llm 接线、错误提示走说话气泡、托盘图标快照同步、前端目录清理。
