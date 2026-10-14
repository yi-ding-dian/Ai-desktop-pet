"""pytest 共享配置：确保 `import backend` 可用（项目根加入 sys.path）。"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]  # tests → backend → 项目根
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
