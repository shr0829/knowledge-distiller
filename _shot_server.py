"""临时脚本：启动演示服务并打印审核 token，供无头浏览器截图核对视觉。
   仅用于本地视觉回归，不属于产品代码，验证后删除。"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "src"))

import uvicorn  # noqa: E402

from library_companion.api import create_app  # noqa: E402
from library_companion.controller import Controller  # noqa: E402
from library_companion.demo import seed_demo  # noqa: E402
from library_companion.store import Store  # noqa: E402

store = Store()
controller = Controller(store)
seed_demo(store, controller.service)
app = create_app(store.home)
port = int(os.environ.get("SHOT_PORT", "8799"))
print(f"TOKEN={app.state.bootstrap_token}", flush=True)
print(f"URL=http://127.0.0.1:{port}/#review-token={app.state.bootstrap_token}", flush=True)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
