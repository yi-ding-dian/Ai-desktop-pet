"""记忆域（§4.3 三层设计）。

- ``store.py``   ← 长期记忆（memories 表）：CRUD + 规则召回（向量实现接入点见其文件头）
- ``profile.py`` ← 用户画像（profile 表）：KV 读写
- ``format.py``  ← 上下文注入格式（画像 + 记忆 → system 文本）
- ``extractor.py`` ← 会话空闲后的记忆提取（提示词/补全回调由 application 层注入）

依赖约定：本域不 import llm 域任何模块——对话模型能力与提示词资产均由
application 装配层以注入方式提供（设计文档 §2.3 依赖方向）。
"""
