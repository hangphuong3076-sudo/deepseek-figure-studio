# -*- coding: utf-8 -*-
"""test_current_endpoint.py — 空工程 GET /api/current|/api/doc 的 200 空态。

历史行为：无文档时 GET 返回 404，前端 console 出现资源错误。本测试锁定
新形状：空目录 → 200 {ok, exists:false, doc:null, save_token:null}；
POST base_token:null 首存成功；再 GET → exists:true + save_token；
再以 base_token:null POST → 409（条件保存冲突保护不变）。/api/svg 与
未知路径在空态下仍返回 404。
"""
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

MCP_DIR = Path(__file__).resolve().parent
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import viewer  # noqa: E402


def _doc(doc_id="current-endpoint-test"):
    stamp = "2026-11-14T00:00:00.000Z"
    return {
        "schema_version": "1.0",
        "id": doc_id,
        "title": "current-endpoint-test",
        "canvas": {"width_mm": 120, "height_mm": 90, "dpi": 300,
                   "background": "#FFFFFF"},
        "elements": [], "anchors": [], "panels": [], "history": [],
        "meta": {"created": stamp, "updated": stamp},
    }


class CurrentEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._sandbox = tempfile.TemporaryDirectory(prefix="fig-current-test-")
        cls.previous_paths = (viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH)
        cls.previous_state = viewer._STATE
        viewer.PROJECT_DIR = Path(cls._sandbox.name) / "isolated-project"
        viewer.CURRENT_PROJECT_PATH = (
            viewer.PROJECT_DIR / "current.figureproj.json")
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), viewer.ViewerHandler)
        cls.thread = threading.Thread(
            target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=10)
        viewer.PROJECT_DIR, viewer.CURRENT_PROJECT_PATH = cls.previous_paths
        viewer._STATE = cls.previous_state
        cls._sandbox.cleanup()

    def setUp(self):
        # 每个用例从空文档开始：GET 读 _STATE，POST 写盘+更新 _STATE。
        viewer._STATE = {"doc": None, "project_path": None}
        try:
            viewer.CURRENT_PROJECT_PATH.unlink()
        except OSError:
            pass

    # ------------------------------------------------------------ helpers

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def post(self, path, payload):
        raw = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.base + path, data=raw, method="POST",
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def save_doc(self, doc=None, base_token=None):
        return self.post("/api/current",
                         {"doc": doc or _doc(), "base_token": base_token})

    # -------------------------------------------------------------- tests

    def test_empty_state_returns_200_exists_false(self):
        for path in ("/api/current", "/api/doc"):
            with self.subTest(path=path):
                status, j = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(j.get("ok"), True)
                self.assertEqual(j.get("exists"), False)
                self.assertIsNone(j.get("doc"))
                self.assertIsNone(j.get("save_token"))

    def test_empty_state_keeps_404_for_svg_and_unknown(self):
        for path in ("/api/svg", "/api/no-such-endpoint"):
            with self.subTest(path=path):
                status, j = self.get(path)
                self.assertEqual(status, 404)
                self.assertEqual(j.get("ok"), False)

    def test_save_then_get_exists_true_with_token(self):
        doc = _doc()
        status, j = self.save_doc(doc)
        self.assertEqual(status, 200, j)
        self.assertEqual(j.get("ok"), True)
        token = j.get("save_token")
        self.assertIsInstance(token, str)
        self.assertTrue(token)

        for path in ("/api/current", "/api/doc"):
            with self.subTest(path=path):
                status, j = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(j.get("ok"), True)
                self.assertEqual(j.get("exists"), True)
                self.assertEqual((j.get("doc") or {}).get("id"), doc["id"])
                self.assertEqual(j.get("save_token"), token)

    def test_null_base_token_second_save_conflicts_409(self):
        status, j = self.save_doc()
        self.assertEqual(status, 200, j)
        status, j = self.save_doc(_doc("current-endpoint-test-b"))
        self.assertEqual(status, 409, j)
        self.assertEqual(j.get("ok"), False)
        self.assertEqual(j.get("save_conflict"), True)
        self.assertIsInstance(j.get("save_token"), str)

    def test_correct_base_token_save_still_works(self):
        # 冲突保护不变：拿到当前 save_token 后的条件保存仍应成功。
        status, j = self.save_doc()
        self.assertEqual(status, 200, j)
        status, cur = self.get("/api/current")
        self.assertEqual(status, 200)
        self.assertEqual(cur.get("exists"), True)
        token = cur.get("save_token")
        status, j = self.save_doc(
            _doc("current-endpoint-test-2"), base_token=token)
        self.assertEqual(status, 200, j)
        self.assertEqual(j.get("ok"), True)
        self.assertNotEqual(j.get("save_token"), token)


if __name__ == "__main__":
    unittest.main()
