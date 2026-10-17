> ⚠️ 历史快照（2026-10-14，**部分过期**）：默认配置已改为空 base_url（首启向导），文中 get/set/test 未接线的遗留均已闭环，embed() 仍为 NotImplementedError；reasoning_content 跳过、key 链与脱敏等结论仍有效。索引见 docs/reports/README.md。

# P1 步骤 5：后端 LLM 接入 报告

> 完成时间：2026-10-14 18:00
> 范围：openai 兼容真 provider + 密钥存储链 + 人格/情绪提示词 + 内存态多轮历史 + 真实冒烟
> 未触碰：`frontend/`、`代码设计文档/`、`record.md`；未做任何版本控制提交。

---

## 1. 改动清单

**新增**

| 文件 | 说明 |
|---|---|
| `backend/modules/llm/openai_compat.py` | `OpenAICompatProvider`：`stream_chat`（只取 `delta.content`，天然跳过推理模型的 `reasoning_content`）/ `test`（连通性）；超时/重试/错误码翻译（SDK 异常 → `LlmError`）；每次请求一次性客户端 |
| `backend/modules/llm/prompts/persona.md` | 默认人格"小豆"（**已注明将来由角色包覆盖，§4.6**） |
| `backend/modules/llm/prompts/emotion_directive.md` | 情绪指令：`<emo:xxx>` 标签用法 + v1 八种情绪值 + 缺标签容忍说明 |
| `backend/modules/llm/prompts/__init__.py` | `build_system_prompt(persona_text=None)`：人格 + 情绪指令组装；读文件失败有内置兜底 |
| `backend/shared/secrets.py` | key 读取链：`PET_LLM_KEY` 环境变量 > keyring > `PET_DATA_DIR/llm_secret.json`（600）；`mask_secret` / `register_secret` / `redact` 全链路脱敏工具 |
| `backend/tests/fakes.py` | `EchoLLMProvider`（原 chat_pipeline 迁入，测试替身）+ `ScriptedProvider`（可编程，可注入错误、记录入参） |
| `backend/tests/test_openai_compat.py` | mock SSE chunk（含 reasoning_content）、参数透传、错误码翻译、key 脱敏 |
| `backend/tests/test_secrets.py` | 读取链优先级、keyring 回退、600 权限、掩码/脱敏 |
| `backend/tests/test_prompts.py` | system prompt 组装、提示词情绪值与白名单一致性、角色包覆盖注记 |
| `backend/tests/test_session.py` | 内存历史保留上限与顺序 |

**修改**

| 文件 | 说明 |
|---|---|
| `backend/application/chat_pipeline.py` | 注入真 provider（Echo 移除，仅供测试）；`state:thinking` 在请求前推送；组装 system+最近 N 轮；缺标签补显式 `neutral`；失败收尾（`reply_end` → `error` → `state:idle`，前端不会卡 thinking）；中断记录半截回复 |
| `backend/application/session.py` | `Session` 增加内存态历史（deque，`HISTORY_MAX_TURNS=10` 轮） |
| `backend/interfaces/ws/server.py` | `ConnectionContext` 实现新增的 `ReplySink.error` 端口 |
| `backend/interfaces/ws/dispatcher.py` | `run_turn` 改传 `Session` 对象 |
| `backend/main.py` | 装配 `OpenAICompatProvider`（config 参数 + `get_llm_key` 惰性 key）；启动日志仅记 key 掩码 |
| `backend/shared/errors.py` | 新增 `LlmErrorCode`（NO_KEY/AUTH/TIMEOUT/NETWORK/RATE_LIMIT/BAD_REQUEST/UPSTREAM）+ `LlmError` |
| `backend/shared/config.py` | `[llm]` 默认改为本地网关 + `deepseek-flash`；新增 `max_tokens=768` |
| `backend/shared/logging.py` | 日志兜底脱敏 filter（已登记 key 出现即替换为掩码） |
| `backend/modules/llm/provider.py` | docstring 更新（真实现指向 openai_compat） |
| `backend/examples/ws_smoke.py` | Echo 冒烟 → 真实 LLM 冒烟（三轮对话 + 多轮记忆断言） |
| `backend/tests/{test_chat_pipeline,test_config,test_ws_e2e}.py` | 随接口更新（新增多轮历史/缺标签/失败收尾/thinking 前置等用例） |

**仓库外（本机用户数据）**
- `~/.config/ai-desktop-pet/config.toml` 的 `[llm]` 段同步为新默认（原为旧模板指向公网 `deepseek-chat`，不改的话真实启动会读旧值）。
- 实测 key 已持久化到系统 keyring（见 §4）。

---

## 2. 启动方式

```bash
# 1) 后端（项目根目录，开发模式：READY 行携带随机 WS token）
backend/.venv/bin/python -m backend.main

# 2) 真实全链路冒烟（拉起后端 → WS → 真实 LLM 三轮对话，验证完自动清理）
backend/.venv/bin/python backend/examples/ws_smoke.py

# 3) 单元测试
cd backend && .venv/bin/python -m pytest tests/ -q
```

配置（`PET_DATA_DIR/config.toml`，默认 `~/.config/ai-desktop-pet/`）：

```toml
[llm]
base_url    = "http://192.168.0.8:3000/v1"   # OpenAI 兼容网关
model       = "deepseek-flash"               # 推理型模型；max_tokens 给足 768
temperature = 0.8
max_tokens  = 768
```

---

## 3. 真实验证输出（冒烟摘要，不含任何 key 材料）

启动日志（脱敏）：

```
配置已加载：llm.model=deepseek-flash pet.name=小豆
LLM 装配：base_url=http://192.168.0.8:3000/v1 model=deepseek-flash key=sk-****nDz5
```

三轮对话（模型在正文中输出了 `<emo:happy>` 标签，后端已解析为 emotion 事件并剥离，正文无残渣）：

```
[第一轮] 用户：你好，你叫什么名字
  → emotion happy；校验：事件数=24 文本长度=25
  full_text = 嘿，我叫小豆！就住在你桌面上，以后有啥事都能喊我~

[第二轮] 用户：我叫张三，我最喜欢喝拿铁咖啡，请记住哦。
  → emotion happy；校验：事件数=34 文本长度=39
  full_text = 张三你好呀！拿铁是吧，我记住啦～下次你要是边喝拿铁边敲代码，我就在旁边闻个香。

[第三轮] 用户：我叫什么名字？我最喜欢喝什么？
  → emotion happy；校验：事件数=19 文本长度=20
  full_text = 你叫张三，最喜欢喝拿铁咖啡～我都记着呢！
```

断言结果（脚本自动校验，全部通过）：
- 时序：每轮均为 `state:thinking → reply_start → token/emotion… → reply_end → state:idle`；
- 流式回复非空；`token` 拼接 == `reply_end.full_text`；无 `<emo:` 标签残渣；
- `emotion` 事件存在且取值在 v1 八种集合内（模型有标签时按模型输出，无标签时后端补 `neutral`）；
- **多轮记忆接通**：第三轮正确答出"张三 / 拿铁咖啡"；
- 未实现事件（`get_config`）按预期回 `NOT_IMPLEMENTED`。

单元测试：`109 passed`（含 mock SSE 含 `reasoning_content` 只出 `content`、错误翻译、key 脱敏、
提示词组装、多轮历史、缺标签容忍、失败/中断收尾）。

---

## 4. key 存储位置（不含明文）

- **落点：系统 keyring**（Linux Secret Service，`keyring` 库已实测可读写）。
  service = `ai-desktop-pet`，username = `llm_api_key`。
- 读取链优先级：环境变量 `PET_LLM_KEY` > keyring > `PET_DATA_DIR/llm_secret.json`（写入时 600 权限）。
  keyring 不可用的环境（如无 Secret Service 的桌面）自动回退文件。
- 展示一律经掩码（形如 `sk-****nDz5`）；日志过滤器 + `redact()` 对第三方 SDK 错误信息兜底清洗；
  单测覆盖"异常信息夹带 key 时被替换为掩码"。
- 写入时间：2026-10-14（自测通过后从 `~/.claude/settings.json` 读出直接入库，全程未打印明文）。

---

## 5. 与设计文档的偏差

1. **错误码扩展**：§3.3 的 error 表未定义 LLM 类错误码，新增 `LLM_NO_KEY/LLM_AUTH/LLM_TIMEOUT/
   LLM_NETWORK/LLM_RATE_LIMIT/LLM_BAD_REQUEST/LLM_UPSTREAM`（走 error 事件透传给前端展示）。
   建议后续把该码表补进设计文档。
2. **失败路径**：§7.1 未规定 LLM 失败的收尾；实现为 `reply_end(已产出文本)` → `error(code,message)`
   → `state:idle`，并为 `ReplySink` 增加 `error` 端口。
3. **缺标签补 `neutral`**：文档只要求"容忍"，实现额外补发一个显式 `neutral` 事件（前端无副作用，
   让"默认情绪"在协议层可观测）。
4. **context 组装位置**：§2.3 规划的 `modules/chat/context.py` 本步骤未拆出，组装逻辑暂在
   `chat_pipeline._build_messages`（system 仅"人格+情绪指令"；画像/记忆注入后续接入时再拆分）。
5. **`embed()` 未实现**：抛 `NotImplementedError`，待 P3 记忆模块接入（§4.1 的 embedding 策略）。
6. 其余按计划：SQLite 落库、`sentence` 事件、`test_llm`/`get_config` WS 接线均属后续步骤。

---

## 6. 坑与遗留

- **推理型模型**：`deepseek-flash` 的思考在 `delta.reasoning_content`，标准写法（只取 `delta.content`）
  自动跳过；`max_tokens=768` 实测充足（三轮均正常收尾，无空回复）。思考期间前端已有
  `state:thinking` 兜底体验。
- **openai SDK 3.30**：底层 HTTP 依赖不可直接 `import httpx`（用的是 httpx2），测试中 HTTP 状态类
  异常改用 `Mock(spec=...)` 验证分派；`chat.completions.create` 仍支持 `max_tokens`。
- **真实用户目录 config.toml**：本次已同步新默认；若日后用户手改回公网地址，属预期行为。
- **遗留（后续步骤）**：
  1. 多轮历史在内存（进程重启丢失）→ 接 SQLite（§6.2 messages 表）；
  2. `LlmError` 失败后 `user` 消息保留在历史（无 assistant 配对），连续失败会轻微污染上下文（可接受）；
  3. `test_llm` / `get_config` / `set_config` 等设置面板闭环未接线（仍回 `NOT_IMPLEMENTED`）；
  4. 模型倾向每轮只输出一个情绪标签（实测均 happy 起手）——提示词已允许多次切换，观察后续真实
     对话表现再调。
