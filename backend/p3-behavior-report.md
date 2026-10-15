# P3 步骤 2 —— 自主行为引擎（后端）报告

> 日期：2026-10-14 ｜ 范围：设计文档 §4.5（自主行为引擎 v1 主体）、§7.4（自主行为时序）、§3.2/§3.3（behavior / behavior_done / env_update 事件）
> 结论：**后端决策链路已落地并实测通过**——引擎自动下发行为指令、等待回报（含超时兜底）、软状态记账、情境调制、摸头响应全链路可用。

---

## 1. 改动清单（后端）

| 文件 | 类型 | 说明 |
|---|---|---|
| `backend/modules/behavior/__init__.py` | 新增 | 模块出口（引擎/行为表/软状态/规则） |
| `backend/modules/behavior/engine.py` | 新增 | asyncio 主循环：空闲计时 → 掷骰 → 下发 → 等 done（超时兜底）→ 记账 → 冷却；连接断开自检清理 |
| `backend/modules/behavior/behaviors.py` | 新增 | v1 四行为权重表（walk / look_around / nap / sleep）+ 前置条件 + 参数工厂（含屏幕边界感知） |
| `backend/modules/behavior/mood.py` | 新增 | mood / energy 软状态（0–1，**内存态**，持久化留待后续） |
| `backend/modules/behavior/rules.py` | 新增 | 情境调制（时段 / 精力 / 心情 / 用户离开）与免打扰 / 唤醒检测（纯函数） |
| `backend/interfaces/ws/protocol.py` | 改 | `EnvUpdateData` 增加 `system_idle_seconds`、`pet_state`（behavior/behavior_done 模型此前已就位，未动） |
| `backend/interfaces/ws/dispatcher.py` | 改 | `_ConnectionSink`（引擎↔连接适配）；`build_dispatcher(engine=…)`；注册 `pet_event` / `behavior_done` / `env_update` 三个 handler |
| `backend/main.py` | 改 | 装配 `BehaviorEngine`（全局单例）；`_serve` 启动/停止引擎生命周期 |
| `backend/shared/config.py` | 改 | `BehaviorConfig` 扩展：`enabled`（默认 true）、`quiet_hours`（默认空）、`idle_min/max_seconds`（10/40s）；配置模板同步 |
| `backend/pyproject.toml` | 改 | packages 列表注册 `backend.modules.behavior`（一行） |
| `backend/tests/test_behavior.py` | 新增 | 18 个用例（单测 + 真 uvicorn 集成） |
| `backend/examples/behavior_smoke.py` | 新增 | 冒烟脚本：真后端 + 脚本模拟客户端（集成实测用） |

> 未动：`chat_pipeline.py` / `modules/chat/` / `modules/memory/`（另一位 Agent 领地）；`server.py` 一行未改（断开清理由引擎自检完成）。

## 2. 设计要点

- **后端决策、前端执行**：`behavior {id, name, params}` 为指令级消息（如 `{direction:"right", distance:220, duration_ms:1586}`），**不传位置流**；前端本地缓动 + 动画，完成/被打断后回报 `behavior_done {id, interrupted}`。
- **主循环**（engine.py）：空闲计时 `uniform(idle_min, idle_max)`（默认 10–40s，配置可调）→ 权重掷骰 × 情境调制 → 下发 → 等回报 → energy 记账 → 冷却。
  - **超时兜底**：等待 = 行为预期时长 + 5s，超时按"未完成"继续（不卡死引擎）；
  - **连接断开清理**：等待期间每秒轮询 `sink.is_closed()`（starlette `client_state`），断开即清状态；不依赖 server 层回调（`server.py` 未改）；
  - **分层**：modules 不依赖 interfaces——连接以 `BehaviorSink` 协议注入，WS 适配在 dispatcher 的 `_ConnectionSink`。
- **软状态**（mood.py，内存态，重启重置）：
  - 被摸头 mood +0.15；被聊 +0.08（对话开始由 dispatcher 调 `note_conversation`）；
  - 活动耗 energy（walk −0.02 / look_around −0.01），nap/sleep 恢复（+0.15 / +0.35）；
  - 30 分钟无互动后 mood 每分钟 −0.02（下限 0.2，不做惩罚机制）。
- **情境调制**（rules.py）：白天 walk×1.3；深夜 nap×1.6 / sleep×2.2；低精力 nap×1.8 / sleep×1.6；用户离开（idle>15min）nap×1.5 / sleep×1.8；**用户回来**（idle>15min → <2min）→ mood 回升 + 偏活跃 + 唤醒（睡眠中推 `state:idle`）+ 轻问候表情（`emotion:happy`，v1 不调 LLM）。
- **静默规则**：对话中（`pet_state` 为 thinking/speaking/dragging，经 env_update 旁路上报，**引擎不读 chat_pipeline**）与免打扰时段（`quiet_hours`，默认空）完全静默。
- **pet_event**：`tap_head` → mood ↑ + 推 `emotion{happy, 0.9}`（v1 不调 LLM）；`drag_end`/`idle_touch` 只记录（行为引擎不依赖）。
- **energy 记账规则**：完成全额；**恢复型**行为被打断/超时按半额（睡了/歇了部分）；消耗型行为全额（活动已发生）。
- **walk 边界感知**：params 生成时若某方向剩余空间不足，翻转方向或缩短距离（利用 env_update 的 window_pos/work_area）；主进程移动端还会再 clamp 一次（双保险）。

## 3. 测试结果

```
backend/.venv/bin/python -m pytest -q  →  224 passed（全量，含另一位 Agent 的用例）
其中 tests/test_behavior.py：18 passed
```

test_behavior.py 覆盖（要点）：
- 权重掷骰：前置过滤（白天不选 sleep、深夜+低精力可选且会出现）、全零权重返回 None；
- 情境调制：深夜 sleep 权重 > 白天、低精力 → sleep 升、用户离开 → sleep 升、用户回来 → walk 升；
- 免打扰：`23:00-07:00` 跨午夜命中/不命中、非法格式抛错、空列表恒不命中；
- 指令超时兜底：不回 done → 超时后继续、恢复型半额记账（0.80→0.88）；
- 连接断开清理：closed 连接不下发任何行为、`_sink` 清空、等待中返回；
- mood：摸头/对话/衰减（30 分钟阈值 + 下限）/边界截断；
- 集成（真 uvicorn + websockets）：hello → env_update → **引擎自动下发 behavior** → 客户端回 done → 引擎继续下一轮（energy 0.80→0.78）→ tap_head → 收 emotion + mood 上升。

## 4. 集成实测（独立实例 + 脚本模拟客户端）

命令：`backend/.venv/bin/python backend/examples/behavior_smoke.py`（起真后端，临时 PET_DATA_DIR 里把 [behavior] 空闲间隔调为 1–2s），实测输出：

```
[3] 等引擎下发 behavior →  behavior look_around id=b_8bd5183b params={"duration_ms": 3868}
[4] 回报 behavior_done（b_8bd5183b 完成）
[5] 等第二条 behavior →    behavior look_around id=b_f081dfc1 params={"duration_ms": 4840}
[6] 回报 behavior_done（b_f081dfc1 被打断）
[7] pet_event tap_head →  emotion happy (intensity=0.9)
✔ 行为引擎冒烟通过：下发 → done → 继续 → 打断 → 摸头回应 全链路成立
```

引擎侧日志（同一进程 stdout，节选）：

```
行为引擎启动：空闲间隔 1–2s，免打扰=无
行为引擎已绑定连接
下发行为 b_8bd5183b look_around params={'duration_ms': 3868}（mood=0.60 energy=0.80）
行为 b_8bd5183b（look_around）结束：interrupted=False
行为 look_around 记账 energy -0.010（原始 -0.010）→ mood=0.60 energy=0.79
被摸头：mood=0.75 energy=0.81（软状态已更新）
tap_head：已推 emotion(happy)，mood={'mood': 0.75, 'energy': 0.81}
```

**真机（应用内后端）实测**：应用重启后引擎以默认配置（10–40s）随应用运行，日志确认自主下发 walk/look_around、前端回报、引擎记账全链路（详见前端报告第 5 节的真机日志与 xwininfo 证据）。

## 5. 需要用户肉眼确认（后端行为冒烟观感）

1. **走动频次与幅度**：默认 10–40s 一次空闲间隔、单次 120–320px；观察 10–30 分钟，是否觉得"太勤/太懒/走太多"。
2. **打盹/深睡观感**：默认只在精力低（<0.55 打盹 / <0.3 深睡）或深夜（23:00–07:00）出现——白天精力高时几乎看不到 nap/sleep；若希望"白天也偶尔打个盹"，需要调低 `NAP_ENERGY_THRESHOLD`（behaviors.py）。
3. **打扰感**：走动是否在专注工作时分散注意力（可通过 `[behavior].enabled=false` 整体关闭，或 `quiet_hours=["23:00-07:00"]` 设免打扰）。
4. **摸头回应**：摸头 → 心情上升 + 立刻 happy 表情；连续摸头是否"腻"（当前每次 +0.15 mood，上限 1）。
5. **用户离开时的睡觉倾向**：离开 >15 分钟宠物应逐渐转 nap/sleep；回来时（idle 骤降）应醒来 + 带 happy 表情——需要真实离开 15 分钟观察（自动测试已覆盖逻辑，观感需人眼）。

## 6. 坑与遗留

- **前端漏订阅 behavior 事件（已修）**：首轮真机实测发现引擎下发后前端不执行、8s 超时兜底；根因是前端执行器只订阅了 `state` 未订阅 `behavior`（前端侧 bug，已在 frontend 修复并复测通过）。此次也**实战验证了超时兜底**：两次超时后引擎未卡死，继续下一轮。
- **行为表时长与超时**：超时 = 预期时长 + 5s；若未来加长行为（如 sleep 到 5 分钟），超时同步加长，前端执行不受影响（按 duration_ms 执行）。
- **mood/energy 为内存态**：重启归零（默认 0.6/0.8）。持久化留待后续（对外接口不变，加存取层即可）。
- **sleep 与 nap 的区别目前仅体现在时长/恢复量与前置**（视觉上都是 sleeping）；如需要"打盹 vs 深睡"不同姿态，需前端加新状态（本轮按任务约定复用 sleeping）。
- **proactive（主动对话）未实现**：属于 §4.5.4，v1 范围外；engine 的"用户回来唤醒"只推 emote，不调 LLM。
- **多显示器**：walk 参数生成用 env_update 的工作区做边界感知，主进程再按"目标矩形重叠最大的显示器"clamp；跨屏走动受目标显示器工作区约束（实测符合预期，见前端报告）。
