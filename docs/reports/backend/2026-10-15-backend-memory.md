# P3 记忆与持久化 —— 交付报告（backend）

> 范围：SQLite 持久化（sessions/messages/memories/profile）+ `load_history` 事件 +
> memory 模块（store/profile/extractor）+ 上下文注入 + 真实冒烟。
> 约束遵守：只动后端；未提交版本控制；未动 `代码设计文档/`、`record.md`、
> `frontend/`、`modules/behavior/`、`application/voice.py`。

## 1. 状态

**完成**。单测 57 项新增全绿（全量 224 passed，含行为引擎 Agent 的测试）；
真实冒烟通过：真 LLM 对话 → 空闲自动提取落库 → **重启后端** → 历史回填 +
记忆注入（回复答出名字 + 日志条数双证据）。

## 2. 改动清单

### 新增文件

| 文件 | 职责 |
|---|---|
| `backend/shared/db.py` | SQLite 轻量封装：连接（WAL/外键/自动提交）+ §6.2 建表；`memories_vec` 按降级决策**不建**（接入点注释见文件头） |
| `backend/modules/chat/history.py` | sessions/messages 读写（`HistoryStore`）：`create_session` / `append_message` / `recent_messages`（时间正序、limit 夹取 ≤200）/ `last_message_at` / `end_session` |
| `backend/modules/memory/store.py` | memories 表 CRUD + **规则召回**（分档全量 / 关键词+importance+时间衰减 top-8）+ 关键词切分 + 相似度；向量实现接入点见文件头注释 |
| `backend/modules/memory/profile.py` | 画像 KV（UPSERT），key/value 长度上限 |
| `backend/modules/memory/extractor.py` | 提取编排：提示词拼装 → 注入的补全回调 → **容错 JSON 解析** → 去重（字符 bigram Dice ≥0.65 跳过）→ 入库；`ExtractionResult` 供观察 |
| `backend/modules/memory/format.py` | 注入格式：`build_memory_block(画像, 记忆)` → system 文本（空则 None 不注入） |
| `backend/modules/llm/prompts/memory_extract.md` | 记忆提取提示词（输出 `{memories:[{text,kind,importance}], profile:[{key,value}]}`）；兜底文本在 `prompts/__init__.py` |
| `backend/application/memory_service.py` | 空闲扫描 + 提取调度（`MemoryService`）：`start/stop` 后台循环、`extract_idle`、**`extract_now`（手动触发入口）**；非流式补全 `complete_via_provider` |
| `backend/examples/memory_smoke.py` | 真实冒烟：两轮对话 → 空闲自动提取 → 重启 → 历史回填 + 记忆注入断言 |
| `backend/tests/test_history.py`（9） | 建表/CRUD/持久化重开/**会话恢复**/水位初始化 |
| `backend/tests/test_memory_store.py`（14） | CRUD/相似度/召回分档与排序（全量、关键词优先、importance、时间衰减） |
| `backend/tests/test_memory_extractor.py`（15） | 解析容错（代码块/杂文/坏字段/整体不可解析）/去重（库内+批内）/画像/调用失败降级 |
| `backend/tests/test_memory_injection.py`（9） | `build_memory_block` 格式、pipeline 注入与降级、INFO 日志不含全文、落库含 emotion |
| `backend/tests/test_memory_service.py`（7） | 空闲判定/提取水位/失败推进/提取中新增消息不丢/后台循环 |
| `backend/tests/test_load_history_e2e.py`（3） | 真实 uvicorn：load_history 回填（limit/缺省 session_id/未知会话）、**模拟重启**后历史+记忆注入 |

### 修改文件（并发协作：行为引擎 Agent 也改过同文件，已合并验证）

| 文件 | 改动 |
|---|---|
| `backend/application/session.py` | `Session` 增量落库（`append_message` 写 messages，失败仅记日志）+ 活跃时间更新 + 提取水位；`SessionManager(store=...)` 支持**从库恢复**（重启后历史不丢、水位=最后消息时间防重复提取） |
| `backend/application/chat_pipeline.py` | `_build_messages` 变 async：system(人格) → system(画像+记忆，**有内容才注入**) → 最近 N 轮；召回失败降级不阻断；INFO 日志只记条数；assistant 消息随最后情绪落库（`messages.emotion`） |
| `backend/interfaces/ws/dispatcher.py` | 新增 `on_load_history`（`history{session_id, messages}`；缺省 session_id 用当前连接会话；未知会话返回空不报错）；`build_dispatcher(history=...)` |
| `backend/interfaces/ws/protocol.py` | `LoadHistoryData.session_id` 必填 → 可选（缺省回填当前连接会话；前端 TS 传值方式不受影响） |
| `backend/shared/config.py` | 新增 `[memory]` 段：`enabled` / `idle_seconds=300` / `check_interval_seconds=15`（模板同步） |
| `backend/main.py` | 装配：`connect_db` → HistoryStore/MemoryStore/ProfileStore → `SessionManager(store)` → pipeline 注入 → `MemoryService`（空闲服务，随 `_serve` 启停）→ dispatcher 注入 history |
| `backend/modules/llm/prompts/__init__.py` | `load_memory_extract_prompt()`（含兜底） |
| `backend/pyproject.toml` | packages 增加 `backend.modules.memory` |

## 3. 启动方式

不变：`backend/.venv/bin/python -m backend.main`（项目根目录）。
新增数据文件 `PET_DATA_DIR/pet.db`（首启自动建库建表；旧数据目录无影响）。
配置（可选）：`config.toml` 的 `[memory]` 段；旧配置文件缺该段时取默认值。

## 4. 真实验证（冒烟摘要）

命令：`backend/.venv/bin/python backend/examples/memory_smoke.py`
（独立 `PET_DATA_DIR` 临时目录 + `idle_seconds=2` 短空闲，真 LLM=内网 deepseek-flash）

```
[1] hello_ack ok session_id=af46ec93...
[对话-第一轮] 用户：你好呀！我叫李雷，是一名中学物理老师，住在杭州，特别喜欢喝拿铁咖啡。请记住我哦。
[对话-第一轮] 小豆：李雷你好呀！小豆记住啦——杭州的物理老师，拿铁爱好者！……
[对话-第二轮] 用户：我周末喜欢去西湖边跑步。 / 小豆：……李雷周末出没地点——西湖沿线
[3] 空闲 2s 自动触发提取（后端日志）：
    触发记忆提取 session=af46ec93... 消息数=4
    记忆提取完成：新增 5 条 / 跳过重复 0 条 / 画像更新 5 项
    memories: 用户叫李雷 / 用户是一名中学物理老师 / 用户住在杭州 /
              用户特别喜欢喝拿铁咖啡 / 用户周末喜欢去西湖边跑步
    profile : 姓名=李雷 职业=中学物理老师 城市=杭州 喜好=拿铁咖啡 爱好=周末去西湖边跑步
[4] 重启后端（同 PET_DATA_DIR）→
[4a] load_history 返回 4 条历史（与重启前逐字一致）
[4b] 旧会话继续问"你还记得我叫什么名字吗？"
     小豆：当然记得呀，李雷！杭州的物理老师，周末西湖边跑步的那位，怎么可能忘。   ← 记忆注入生效
     （另有 pytest 版重启场景：上下文 messages 含 [用户画像]/[长期记忆] 断言）
[5] 日志证据：记忆注入：画像 5 条 / 长期记忆 5 条（INFO 级不含记忆全文）
```

## 5. 与设计偏差（重点：向量 → 规则召回）

内网 LLM 网关不支持 embedding（实测 4 个模型名全 503），§4.3 的
"embed → sqlite-vec KNN top-k" 本次**降级为「结构化记忆 + 规则召回」**，偏差细节：

1. **`memories_vec` 虚拟表未建**（§6.2 表结构其余四表字段级一致）；建表与
   切换接入点写在 `shared/db.py` / `memory/store.py` 文件头注释。
2. **召回策略**（`MemoryStore.recall`，**async 签名按可替换设计**）：
   - 条数 ≤ 50：**全量返回**（importance 降序 + 时间倒序）——设计原为 KNN top-5；
   - 条数 > 50：**关键词命中（中文 bigram + 英文词，交集计数）×2.0 +
     importance×1.0 + 时间衰减（半衰期 30 天）×0.5** 打分取 **top-8**；
   - 将来向量实现：新增 `VectorRecaller`（`llm.provider.embed(query)` → KNN），
     经 application 注入替换，调用方（chat_pipeline/memory_service）零改动。
3. **去重相似度**：§4.3 "相似度 > 阈值则合并/跳过" → 用**字符 bigram Dice 系数
   ≥ 0.65** 近似（无向量），后续可换余弦。
4. **提取失败处理（设计外的实现取舍）**：LLM 调用失败时**水位照常推进**
   （避免每个扫描周期反复重试白烧 token）；该批对话原文仍在 messages 表。
5. `load_history.session_id` 由必填改为可选（缺省回填当前连接会话）——设计
   §3.2 写 `{session_id, limit}`，任务书为 `{session_id?, limit}`，取任务书。
6. 附带的两个小增强（设计未写但不冲突）：assistant 消息落库其**最后情绪**
   （§6.2 已有 emotion 列）；召回命中的记忆更新 `last_used_at`。

## 6. 坑与遗留

- **触发入口**：空闲自动（`[memory]` 可配）+ `MemoryService.extract_now(session)`
  程序化手动入口；冒烟脚本用"短空闲配置"走真实自动链路。**尚无**运行中手动
  触发的 WS 事件（协议未加）——"记忆管理页"（§4.3 可观测性）留 P3b/P4。
- **提取失败的内存代价**：失败也推进水位（取舍见 §5.4），失败批次的记忆需
  将来"重新提取"入口弥补。
- 召回全量模式（≤50 条）注入 token 量随记忆条数线性增长；条数逼近 50 时建议
  调低阈值（常量在 `store.py`），向量落地后自然解决。
- `embed` 仍为 `NotImplementedError` 占位（provider.py / openai_compat.py
  均未动）——按任务书保留。
- 前端尚未调用 `load_history`（TS 类型已就绪）；协议字段向后兼容（可选 session_id）。
- 并发协作提示：`dispatcher.py`/`main.py`/`config.py`/`pyproject.toml`/`protocol.py`
  与行为引擎 Agent 双方都改过，当前合并在同一工作区并通过全量测试；提交时注意
  不要按文件回滚对方的改动。
