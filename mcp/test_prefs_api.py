# -*- coding: utf-8 -*-
"""test_prefs_api.py — R5 /api/prefs 用户偏好接口。

覆盖：GET 默认值、POST patch 持久化、跨 viewer 重启仍在、
校验（未知键拒绝 / custom_styles ≤50 / id 必须 my- 前缀 / token 校验）、
原子写 prefs.json。
"""
import json
import shutil
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from test_modal_layout import _ViewerServer

HERE = Path(__file__).resolve().parent


def _req(base, method, path, payload=None):
    url = base + path
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"ok": False, "raw": body}


def _style(sid="my-test-style", name="测试风格"):
    return {
        "id": sid,
        "name": name,
        "tags": ["测试"],
        "font": {"family": "Arial", "basePt": 8},
        "palette": "npg",
        "plot": {"frame": "box", "axisWidthPt": 0.6},
        "legend": {"position": "right", "frame": False},
        "grid": {"show": True},
        "background": None,
    }


class PrefsApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.datadir = tempfile.mkdtemp(prefix="fig-prefs-data-")
        cls.server = _ViewerServer(cls.datadir)
        cls.server.wait_ready()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.datadir, ignore_errors=True)

    def setUp(self):
        # 每个用例前重置偏好，避免用例间状态污染（unittest 按字母序执行）
        _req(self.server.base, "POST", "/api/prefs",
             {"patch": {"default_style_id": None, "custom_styles": []}})

    def test_get_default_empty(self):
        code, body = _req(self.server.base, "GET", "/api/prefs")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertIsNone(body["prefs"]["default_style_id"])
        self.assertEqual(body["prefs"]["custom_styles"], [])

    def test_post_and_persist_file(self):
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": {"default_style_id": "acs-bold"}})
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["prefs"]["default_style_id"], "acs-bold")
        prefs_file = Path(self.datadir) / "prefs.json"
        self.assertTrue(prefs_file.exists(), "prefs.json 应已写入数据目录")
        data = json.loads(prefs_file.read_text(encoding="utf-8"))
        self.assertEqual(data["default_style_id"], "acs-bold")

    def test_patch_merges_not_replaces(self):
        # 先写 default_style_id，再 POST custom_styles → default 保留
        _req(self.server.base, "POST", "/api/prefs",
             {"patch": {"default_style_id": "acs-bold"}})
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": {"custom_styles": [_style()]}})
        self.assertEqual(code, 200)
        self.assertEqual(body["prefs"]["default_style_id"], "acs-bold",
                         "patch 应合并而非整体替换")
        self.assertEqual(len(body["prefs"]["custom_styles"]), 1)

    def test_persist_across_restart(self):
        _req(self.server.base, "POST", "/api/prefs",
             {"patch": {"default_style_id": "acs-bold",
                        "custom_styles": [_style()]}})
        cls = self.__class__
        cls.server.stop()
        cls.server = _ViewerServer(cls.datadir)
        cls.server.wait_ready()
        try:
            code, body = _req(cls.server.base, "GET", "/api/prefs")
            self.assertEqual(code, 200)
            self.assertEqual(body["prefs"]["default_style_id"], "acs-bold",
                             "重启后 default_style_id 应保留")
            self.assertEqual(len(body["prefs"]["custom_styles"]), 1,
                             "重启后 custom_styles 应保留")
        finally:
            pass  # tearDownClass 统一 stop

    def test_unknown_key_rejected(self):
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": {"evil_key": 1}})
        self.assertNotEqual(code, 200, "未知键应被拒绝")
        self.assertFalse(body.get("ok", True))

    def test_non_dict_patch_rejected(self):
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": "not-an-object"})
        self.assertNotEqual(code, 200)

    def test_default_style_id_validation(self):
        for bad in ["", "x" * 81, 123, ["a"]]:
            code, _ = _req(self.server.base, "POST", "/api/prefs",
                           {"patch": {"default_style_id": bad}})
            self.assertNotEqual(code, 200, "default_style_id=%r 应被拒绝" % (bad,))
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": {"default_style_id": None}})
        self.assertEqual(code, 200, "null 应允许（清除默认）")
        self.assertIsNone(body["prefs"]["default_style_id"])

    def test_custom_styles_limit_50(self):
        styles = [_style("my-s%02d" % i, "风格%d" % i) for i in range(50)]
        code, body = _req(self.server.base, "POST", "/api/prefs",
                          {"patch": {"custom_styles": styles}})
        self.assertEqual(code, 200, "50 个应允许")
        self.assertEqual(len(body["prefs"]["custom_styles"]), 50)
        styles51 = styles + [_style("my-s50", "第51个")]
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": styles51}})
        self.assertNotEqual(code, 200, "51 个应被拒绝")

    def test_custom_style_id_must_be_my_prefix(self):
        bad = _style("acs-bold", "冒充内置")
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": [bad]}})
        self.assertNotEqual(code, 200, "非 my- 前缀 id 应被拒绝")
        bad2 = _style("my-Bad_ID", "非法字符")
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": [bad2]}})
        self.assertNotEqual(code, 200, "非法字符 id 应被拒绝")

    def test_custom_style_token_validation(self):
        bad = _style()
        bad["plot"] = {"axisWidthPt": -5}
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": [bad]}})
        self.assertNotEqual(code, 200, "非法 token 应被拒绝")
        bad2 = _style()
        bad2["unknown_token"] = True
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": [bad2]}})
        self.assertNotEqual(code, 200, "未知 token 键应被拒绝")
        bad3 = _style()
        bad3["name"] = "x" * 41
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": [bad3]}})
        self.assertNotEqual(code, 200, "name 超 40 字应被拒绝")

    def test_duplicate_custom_style_id_rejected(self):
        dup = [_style("my-dup", "A"), _style("my-dup", "B")]
        code, _ = _req(self.server.base, "POST", "/api/prefs",
                       {"patch": {"custom_styles": dup}})
        self.assertNotEqual(code, 200, "重复 id 应被拒绝")

    def test_get_after_rejected_patch_unchanged(self):
        # 先写入合法状态，再发被拒绝的 patch → GET 应仍是合法状态
        styles = [_style("my-k%02d" % i, "风格%d" % i) for i in range(3)]
        _req(self.server.base, "POST", "/api/prefs",
             {"patch": {"default_style_id": "acs-bold",
                        "custom_styles": styles}})
        _req(self.server.base, "POST", "/api/prefs",
             {"patch": {"unknown_key": 1}})
        code, body = _req(self.server.base, "GET", "/api/prefs")
        self.assertEqual(code, 200)
        self.assertEqual(body["prefs"]["default_style_id"], "acs-bold")
        self.assertEqual(len(body["prefs"]["custom_styles"]), 3,
                         "被拒绝的 patch 不应改变已存偏好")


if __name__ == "__main__":
    unittest.main()
