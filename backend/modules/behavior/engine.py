"""自主行为引擎（设计文档 §4.5.2 主循环 / §7.4 时序）。

职责（后端决策、前端执行）：
    空闲计时（10–40s 随机，配置可调）
      → 权重掷骰 × 情境调制（behaviors.py × rules.py）
      → 下发 ``behavior`` 指令（指令级：如"向右走 300px"）
      → 等待 ``behavior_done``（超时兜底）
      → energy 记账 → 冷却 → 下一轮

- **全局单例**：由 main 装配；向"当前连接"推送（无连接时跳过本轮）。
- **连接断开清理**：不依赖 server 层回调——等待期间与每轮开始前轮询
  ``sink.is_closed()``，断开即清空引擎状态（见 _wait_done / _skip_reason）。
- **分层**：本模块不依赖 interfaces/application；连接以 BehaviorSink 协议注入，
  适配器在 ``interfaces/ws/dispatcher.py``（_ConnectionSink）。
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from loguru import logger

from backend.modules.behavior import rules
from backend.modules.behavior.behaviors import (
    BehaviorContext,
    BehaviorSpec,
    build_params,
    choose_behavior,
)
from backend.modules.behavior.mood import MoodState
from backend.shared.config import BehaviorConfig

#: 等待 behavior_done 时轮询连接状态的间隔（秒）
CONNECTION_POLL_SECONDS = 1.0
#: 等待 done 的超时余量（秒）：预期时长 + 余量未收到回报则按兜底继续
DONE_TIMEOUT_BUFFER_SECONDS = 5.0
#: 用户回来标记的有效窗口（秒）：窗口内下一轮决策偏活跃
WAKE_BOOST_WINDOW_SECONDS = 5 * 60
#: 推给前端的"轻问候"情绪（用户回来 / 被摸头）
LIGHT_GREETING_EMOTION = "happy"


class BehaviorSink(Protocol):
    """行为指令的下行端口（WS 连接的适配抽象；实现见 dispatcher._ConnectionSink）。

    send_event 返回是否成功送达（连接已关闭时 False）；is_closed 供引擎轮询
    感知断开（WS 消息循环收到 disconnect 后 client_state 变为 DISCONNECTED）。
    """

    async def send_event(
        self, msg_type: str, data: Any = None, *, reply_to: str | None = None
    ) -> bool: ...

    def is_closed(self) -> bool: ...


@dataclass
class _EnvSnapshot:
    """最近一次 env_update 的环境快照（决策输入）。"""

    system_idle_seconds: float | None = None
    pet_state: str | None = None
    work_area: dict[str, Any] | None = None
    window_pos: dict[str, Any] | None = None
    window_size: dict[str, Any] | None = None


class BehaviorEngine:
    """自主行为引擎（全局单例，见 main 装配）。"""

    def __init__(
        self,
        config: BehaviorConfig,
        *,
        rng: random.Random | None = None,
        specs: dict[str, BehaviorSpec] | None = None,
    ) -> None:
        self._config = config
        self._rng = rng or random.Random()
        #: 行为表（缺省用模块内置 BEHAVIORS；测试/未来配置驱动可注入替身）
        self._specs = specs
        self._mood = MoodState()
        self._env = _EnvSnapshot()

        #: 当前连接（None = 无连接，跳过决策）
        self._sink: BehaviorSink | None = None
        #: 正在等待的完成回报： (behavior_id, Future[bool=interrupted])
        self._pending: tuple[str, asyncio.Future[bool]] | None = None
        #: 正在等待的行为 spec（用于"用户回来唤醒睡眠"判断）
        self._waiting_spec: BehaviorSpec | None = None
        #: 用户回来的时间戳（0 = 无）；决策时在窗口内则偏活跃
        self._wake_ts: float = 0.0

        self._running = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None
        self._wake_task: asyncio.Task[None] | None = None

    # ---------------------------------------------------------------- 装配

    def set_connection(self, sink: BehaviorSink | None) -> None:
        """设置当前连接（dispatcher 在 hello 鉴权通过后调用；None = 清除）。"""
        self._sink = sink
        if sink is not None:
            logger.info("行为引擎已绑定连接")

    def _connection_alive(self) -> bool:
        sink = self._sink
        return sink is not None and not sink.is_closed()

    def _clear_connection(self) -> None:
        """连接断开时的状态清理（等待中的行为交还 _wait_done 处理）。"""
        if self._sink is not None:
            logger.info("行为引擎：连接断开，清理连接状态")
        self._sink = None

    # ---------------------------------------------------------------- 生命周期

    def start(self) -> None:
        """启动主循环（需在运行中的事件循环里调用；main 装配）。"""
        if self._task is not None:
            return
        if not self._config.enabled:
            logger.info("自主行为引擎未启用（config [behavior].enabled=false）")
            return
        self._running = True
        self._loop = asyncio.get_running_loop()
        self._task = self._loop.create_task(self._run_loop(), name="behavior-engine")
        logger.info(
            "行为引擎启动：空闲间隔 {:.0f}–{:.0f}s，免打扰={}",
            self._config.idle_min_seconds,
            self._config.idle_max_seconds,
            self._config.quiet_hours or "无",
        )

    async def stop(self) -> None:
        """停止主循环并等待退出（进程退出/测试收尾）。"""
        self._running = False
        task = self._task
        self._task = None
        for pending_task in (task, self._wake_task):
            if pending_task is None:
                continue
            pending_task.cancel()
            try:
                await pending_task
            except asyncio.CancelledError:
                pass
            except Exception:  # 唤醒推送失败不应影响退出
                logger.exception("行为引擎任务收尾异常")
        self._wake_task = None

    # ---------------------------------------------------------------- 外部事件入口（dispatcher）

    def update_env(self, data: Any) -> None:
        """env_update 入口：更新环境快照；检测"用户回来"并唤醒。

        同步方法（消息循环直接调用）；唤醒推送放入后台任务（不阻塞消息循环）。
        """
        prev_idle = self._env.system_idle_seconds
        self._env.system_idle_seconds = getattr(data, "system_idle_seconds", None)
        self._env.pet_state = getattr(data, "pet_state", None)
        self._env.work_area = getattr(data, "work_area", None)
        self._env.window_pos = getattr(data, "window_pos", None)
        self._env.window_size = getattr(data, "window_size", None)
        cur_idle = self._env.system_idle_seconds

        logger.debug(
            "环境更新：system_idle={}s pet_state={} pos={}",
            cur_idle,
            self._env.pet_state,
            self._env.window_pos,
        )

        if (
            prev_idle is not None
            and cur_idle is not None
            and rules.user_returned(prev_idle, cur_idle)
        ):
            self._on_user_returned(prev_idle, cur_idle)

    def _on_user_returned(self, prev_idle: float, cur_idle: float) -> None:
        """用户回到电脑前：mood 回升 + 唤醒（睡眠中推 state:idle）+ 轻问候表情。"""
        self._wake_ts = time.time()
        self._mood.on_user_returned()
        logger.info(
            "检测到用户回来（idle {:.0f}s → {:.0f}s）：mood 回升、下一轮偏活跃",
            prev_idle,
            cur_idle,
        )
        loop = self._loop
        if loop is not None and not loop.is_closed() and self._connection_alive():
            self._wake_task = loop.create_task(self._push_wake(), name="behavior-wake")

    async def _push_wake(self) -> None:
        """唤醒推送：睡眠中推 state:idle（前端执行器据此中止睡眠并回报 interrupted），
        并推一个轻问候情绪（v1 不调 LLM——真正的主动问候属 proactive，后续版本）。"""
        sink = self._sink
        if sink is None or sink.is_closed():
            return
        waiting = self._waiting_spec
        if waiting is not None and waiting.name in ("nap", "sleep"):
            await sink.send_event("state", {"state": "idle"})
            logger.info("用户回来：唤醒睡眠（{} 进行中，推 state:idle）", waiting.name)
        await sink.send_event(
            "emotion",
            {"message_id": "", "emotion": LIGHT_GREETING_EMOTION, "intensity": 0.9},
        )

    def on_behavior_done(self, behavior_id: str, interrupted: bool) -> None:
        """behavior_done 入口：唤醒等待中的本轮行为（id 不匹配 = 迟到/未知，忽略）。"""
        pending = self._pending
        if pending is None or pending[0] != behavior_id:
            logger.info(
                "收到未知/迟到的 behavior_done id={}（当前等待 {}），已忽略",
                behavior_id,
                pending[0] if pending else None,
            )
            return
        future = pending[1]
        if not future.done():
            future.set_result(interrupted)

    def note_pet_event(self, kind: str) -> dict[str, float] | None:
        """pet_event 入口：tap_head → mood ↑（返回快照供日志）；其余 kind v1 只记录。"""
        if kind == "tap_head":
            self._mood.on_pet_tapped()
            snapshot = self._mood.snapshot()
            logger.info(
                "被摸头：mood={:.2f} energy={:.2f}（软状态已更新）",
                snapshot["mood"],
                snapshot["energy"],
            )
            return snapshot
        logger.debug("pet_event kind={}（v1 无副作用）", kind)
        return None

    def note_conversation(self) -> None:
        """一轮对话开始（dispatcher 在 user_message 时调用）：mood ↑。"""
        self._mood.on_conversation()

    def mood_snapshot(self) -> dict[str, float]:
        """软状态快照（日志/测试）。"""
        return self._mood.snapshot()

    # ---------------------------------------------------------------- 主循环

    async def _run_loop(self) -> None:
        logger.info("行为引擎主循环进入")
        try:
            while self._running:
                delay = self._rng.uniform(
                    self._config.idle_min_seconds, self._config.idle_max_seconds
                )
                await asyncio.sleep(delay)
                if not self._running:
                    break
                self._mood.apply_idle_decay()

                reason = self._skip_reason()
                if reason is not None:
                    logger.debug("跳过本轮行为：{}", reason)
                    continue

                spec = choose_behavior(self._context(), self._rng, self._specs)
                if spec is None:
                    logger.debug("无满足前置条件的行为（权重全零），跳过本轮")
                    continue
                await self._run_behavior(spec)
        except asyncio.CancelledError:
            raise
        finally:
            logger.info("行为引擎主循环退出")

    def _skip_reason(self) -> str | None:
        """本轮不动作的原因（None = 可以决策）。"""
        if self._config.enabled is False:
            return "自主行为已禁用"
        if not self._connection_alive():
            self._clear_connection()
            return "无活跃连接"
        now = datetime.now()
        if rules.in_quiet_hours(now, self._config.quiet_hours):
            return f"免打扰时段（{self._config.quiet_hours}）"
        if rules.is_engaged(self._env.pet_state):
            return f"用户交互中（pet_state={self._env.pet_state}）"
        return None

    def _context(self) -> BehaviorContext:
        """组装一次决策输入；顺带消费"用户刚回来"标记（窗口过期自动失效）。"""
        wake_boost = (
            self._wake_ts > 0.0 and time.time() - self._wake_ts < WAKE_BOOST_WINDOW_SECONDS
        )
        return BehaviorContext(
            now=datetime.now(),
            mood=self._mood.mood,
            energy=self._mood.energy,
            system_idle_seconds=self._env.system_idle_seconds,
            pet_state=self._env.pet_state,
            work_area=self._env.work_area,
            window_pos=self._env.window_pos,
            window_size=self._env.window_size,
            user_just_returned=wake_boost,
        )

    async def _run_behavior(self, spec: BehaviorSpec) -> None:
        """下发一条行为指令并完成记账 + 冷却。"""
        sink = self._sink
        if sink is None or sink.is_closed():
            self._clear_connection()
            return

        ctx = self._context()
        behavior_id = f"b_{uuid.uuid4().hex[:8]}"
        params = build_params(spec, ctx, self._rng)

        self._waiting_spec = spec
        interrupted: bool | None = None
        try:
            delivered = await sink.send_event(
                "behavior", {"id": behavior_id, "name": spec.name, "params": params}
            )
            if not delivered:
                logger.warning("行为 {} 下发失败（连接已关闭），本轮放弃", behavior_id)
                return
            logger.info(
                "下发行为 {} {} params={}（mood={:.2f} energy={:.2f}）",
                behavior_id,
                spec.name,
                params,
                ctx.mood,
                ctx.energy,
            )
            interrupted = await self._wait_done(
                behavior_id, spec.max_duration_seconds + DONE_TIMEOUT_BUFFER_SECONDS
            )
        finally:
            self._waiting_spec = None

        if interrupted is None:
            logger.warning(
                "行为 {}（{}）等待完成后未收到回报（超时/断线），按兜底继续", behavior_id, spec.name
            )
        else:
            logger.info(
                "行为 {}（{}）结束：interrupted={}",
                behavior_id,
                spec.name,
                interrupted,
            )
        self._settle_energy(spec, interrupted)
        await asyncio.sleep(spec.cooldown_seconds)

    async def _wait_done(self, behavior_id: str, timeout: float) -> bool | None:
        """等待 behavior_done；返回 interrupted 值。

        None = 超时或连接断开（两个兜底路径都不阻塞引擎继续运转）。
        连接断开检测：每 CONNECTION_POLL_SECONDS 轮询一次 sink 状态（WS 消息循环
        收到 disconnect 后 client_state 即变为 DISCONNECTED）。
        """
        loop = asyncio.get_running_loop()
        future: asyncio.Future[bool] = loop.create_future()
        self._pending = (behavior_id, future)
        deadline = loop.time() + timeout
        try:
            while True:
                if not self._connection_alive():
                    self._clear_connection()
                    logger.info("行为 {} 等待中止：连接已断开", behavior_id)
                    return None
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return None
                try:
                    # shield：轮询间隙的 wait_for 超时不取消 future 本体
                    return await asyncio.wait_for(
                        asyncio.shield(future), timeout=min(CONNECTION_POLL_SECONDS, remaining)
                    )
                except asyncio.TimeoutError:
                    continue
        finally:
            self._pending = None
            if not future.done():
                future.cancel()

    def _settle_energy(self, spec: BehaviorSpec, interrupted: bool | None) -> None:
        """精力记账：完成全额；恢复型行为被打断/超时按半额（睡了/歇了部分）。"""
        delta = spec.energy_delta
        if delta > 0 and interrupted is not False:
            delta *= 0.5
        self._mood.apply_energy_delta(delta)
        snapshot = self._mood.snapshot()
        logger.info(
            "行为 {} 记账 energy {:+.3f}（原始 {:+.3f}）→ mood={:.2f} energy={:.2f}",
            spec.name,
            delta,
            spec.energy_delta,
            snapshot["mood"],
            snapshot["energy"],
        )
