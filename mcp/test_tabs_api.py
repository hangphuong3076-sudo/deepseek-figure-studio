# -*- coding: utf-8 -*-
"""多画布标签页 API 测试（viewer.py /api/tabs*）。

每个用例使用独立临时数据目录与 viewer 进程，互不依赖顺序。
覆盖：new/switch/close、409 冲突、重复 id、最后一个标签不可关、
关闭归档到 tabs/closed/、index 跨重启持久化、活动标签 == /api/current、
空服务器 base_token:null、并发保存冲突、出站标签文件写失败中止、
关闭活动标签时邻居文件缺失中止、MCP /api/doc 推送后活动 id 替换。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_modal_layout import _ViewerServer  # noqa: E402


def _doc(doc_id, title=""):
    return {
        "id": doc_id,
        "schema_version": "1.0",
        "title": title,
        "canvas": {"width_mm": 210, "height_mm": 297, "unit": "mm",
                   "dpi": 300, "background": "#FFFFFF"},
        "elements": [],
        "anchors": [],
        "meta": {"created": "2026-01-01T00:00:00Z",
                 "updated": "2026-01-01T00:00:00Z"},
        "history": [],
    }


def _post(base, path, payload):
    req = urllib.request.Request(
        base + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {"ok": False, "error": "http %s" % e.code}


def _get(base, path):
    with urllib.request.urlopen(base + path, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


class TabsApiTest(unittest.TestCase):
    """每个用例独立 server + 数据目录，setUp/tearDown 成对出现。"""

    def setUp(self):
        self.datadir = tempfile.mkdtemp(prefix="fig-tabs-data-")
        self.server = _ViewerServer(self.datadir)
        self.server.wait_ready()
        self.base = self.server.base
        self.projects = Path(self.datadir) / "projects"
        self.tabs_dir = self.projects / "tabs"

    def tearDown(self):
        try:
            self.server.stop()
        finally:
            shutil.rmtree(self.datadir, ignore_errors=True)

    # --------------------------------------------------------------- helpers
    def _save_current(self, doc, token):
        return _post(self.base, "/api/current",
                     {"doc": doc, "base_token": token})

    def _current(self):
        return _get(self.base, "/api/current")

    def _tabs(self):
        return _get(self.base, "/api/tabs")

    def _closed(self):
        return _get(self.base, "/api/tabs/closed")

    def _restore(self, file_name, token):
        return _post(self.base, "/api/tabs/restore",
                     {"file": file_name, "base_token": token})

    def _new_tab(self, doc_id, token, title=""):
        return _post(self.base, "/api/tabs/new",
                     {"doc": _doc(doc_id, title), "base_token": token})

    def _seed_two_tabs(self):
        """空服务器 → doc-a（当前）→ doc-b（新活动）。返回 token_b。"""
        st, res = self._save_current(_doc("doc-a", "A"), None)
        self.assertEqual(st, 200, res)
        st, res = self._new_tab("doc-b", res["save_token"], "B")
        self.assertEqual(st, 200, res)
        return res["save_token"]

    # --------------------------------------------------------------- 用例
    def test_full_lifecycle(self):
        # 初始：无文档 → GET /api/current exists:false
        cur = self._current()
        self.assertFalse(cur.get("exists"))
        st, res = self._save_current(_doc("doc-a", "A"), None)
        self.assertEqual(st, 200, res)
        token_a = res["save_token"]
        # GET /api/tabs：单标签，active == current
        tabs = self._tabs()
        self.assertEqual(tabs["active_id"], "doc-a")
        self.assertEqual([t["id"] for t in tabs["tabs"]], ["doc-a"])
        self.assertEqual(tabs["tabs"][0]["title"], "A")
        # 新建第二个标签
        st, res = self._new_tab("doc-b", token_a, "B")
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-b")
        token_b = res["save_token"]
        # /api/current 现在是 doc-b
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-b")
        self.assertEqual(cur["save_token"], token_b)
        # doc-a 的标签文件已落盘
        self.assertTrue((self.tabs_dir / "doc-a.figureproj.json").is_file())
        # 切回 doc-a
        st, res = _post(self.base, "/api/tabs/switch",
                        {"to_id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-a")
        token_a2 = res["save_token"]
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-a")
        # 再建第三个，关闭中间的 doc-b（非活动）
        st, res = self._new_tab("doc-c", token_a2, "C")
        self.assertEqual(st, 200, res)
        token_c = res["save_token"]
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-b", "base_token": token_c})
        self.assertEqual(st, 200, res)
        ids = [t["id"] for t in res["tabs"]]
        self.assertNotIn("doc-b", ids)
        self.assertIn("doc-a", ids)
        self.assertIn("doc-c", ids)
        # 关闭的文件在 tabs/closed/
        closed = list((self.tabs_dir / "closed").glob("doc-b-*.figureproj.json"))
        self.assertTrue(closed, "关闭的标签应归档到 tabs/closed/")

    def test_409_conflict(self):
        token_b = self._seed_two_tabs()
        # 用过期 token 建新标签 → 409 save_conflict
        st, res = self._new_tab("doc-x", "0" * 64)
        self.assertEqual(st, 409)
        self.assertTrue(res.get("save_conflict"))
        # 缺 base_token 视为不匹配 → 409（绝不静默覆盖）
        st, res = _post(self.base, "/api/tabs/new",
                        {"doc": _doc("doc-y")})
        self.assertEqual(st, 409)
        # 正确 token 不受影响
        st, res = self._new_tab("doc-z", token_b)
        self.assertEqual(st, 200, res)

    def test_duplicate_id_rejected(self):
        token_b = self._seed_two_tabs()
        st, res = self._new_tab("doc-b", token_b)  # doc-b 已是标签
        self.assertEqual(st, 400)
        self.assertIn("已存在", res.get("error", ""))
        # 状态未被破坏
        tabs = self._tabs()
        self.assertEqual([t["id"] for t in tabs["tabs"]], ["doc-a", "doc-b"])

    def test_last_tab_refused(self):
        token_b = self._seed_two_tabs()
        # 关掉非活动的 doc-a
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 200, res)
        # 现在只剩 doc-b（活动）—— 再关 → 400
        token2 = res["save_token"]
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-b", "base_token": token2})
        self.assertEqual(st, 400)
        self.assertIn("保留", res.get("error", ""))
        # 仍可正常读取
        tabs = self._tabs()
        self.assertEqual([t["id"] for t in tabs["tabs"]], ["doc-b"])

    def test_close_active_switches_neighbour(self):
        token_b = self._seed_two_tabs()
        # 再建 doc-c：order=[a,b,c]，活动=c
        st, res = self._new_tab("doc-c", token_b, "C")
        self.assertEqual(st, 200, res)
        token_c = res["save_token"]
        # 切到 doc-b（中间），再关它 → 应切到右邻居 doc-c
        st, res = _post(self.base, "/api/tabs/switch",
                        {"to_id": "doc-b", "base_token": token_c})
        self.assertEqual(st, 200, res)
        token_b2 = res["save_token"]
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-b", "base_token": token_b2})
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-c")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-c")
        self.assertEqual([t["id"] for t in res["tabs"]], ["doc-a", "doc-c"])

    def test_close_active_missing_neighbour_aborts(self):
        """关活动标签时邻居文件缺失 → 400 且什么都不改。"""
        token_b = self._seed_two_tabs()
        st, res = self._new_tab("doc-c", token_b, "C")
        self.assertEqual(st, 200, res)
        token_c = res["save_token"]
        # 切到 doc-b（中间），删掉右邻居 doc-c 的标签文件
        st, res = _post(self.base, "/api/tabs/switch",
                        {"to_id": "doc-b", "base_token": token_c})
        self.assertEqual(st, 200, res)
        token_b2 = res["save_token"]
        victim = self.tabs_dir / "doc-c.figureproj.json"
        self.assertTrue(victim.is_file())
        victim.unlink()
        before_tabs = self._tabs()
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-b", "base_token": token_b2})
        self.assertEqual(st, 400, res)
        # 状态未变：doc-b 仍是活动，order 不变，current 仍是 doc-b
        after = self._tabs()
        self.assertEqual([t["id"] for t in after["tabs"]],
                         [t["id"] for t in before_tabs["tabs"]])
        self.assertEqual(after["active_id"], "doc-b")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-b")
        # doc-b 的标签文件未被归档
        self.assertFalse(list((self.tabs_dir / "closed")
                              .glob("doc-b-*.figureproj.json")))

    def test_outgoing_file_write_failure_aborts(self):
        """当前标签文件写失败 → tabs/new 中止，状态不变。"""
        token_b = self._seed_two_tabs()
        # 把 doc-b（当前/活动）的标签路径占成目录，save_project 必然失败
        blocker = self.tabs_dir / "doc-b.figureproj.json"
        if blocker.exists():
            blocker.unlink()
        blocker.mkdir(parents=True, exist_ok=True)
        before = self._tabs()
        st, res = self._new_tab("doc-n", token_b)
        self.assertNotEqual(st, 200, res)
        # current 仍是 doc-b，order 未加 doc-n
        after = self._tabs()
        self.assertEqual([t["id"] for t in after["tabs"]],
                         [t["id"] for t in before["tabs"]])
        self.assertEqual(after["active_id"], "doc-b")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-b")

    def test_empty_server_new_tab_null_token(self):
        """空服务器：base_token 必须 null；null 可建首个标签。"""
        st, res = _post(self.base, "/api/tabs/new",
                        {"doc": _doc("doc-first"), "base_token": "0" * 64})
        self.assertEqual(st, 409)
        st, res = _post(self.base, "/api/tabs/new",
                        {"doc": _doc("doc-first", "首个"), "base_token": None})
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-first")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-first")
        tabs = self._tabs()
        self.assertEqual([t["id"] for t in tabs["tabs"]], ["doc-first"])

    def test_concurrent_save_conflict_aborts(self):
        """GET 与 switch 之间 current 被另一窗口更新 → 409 且不切换。"""
        token_b = self._seed_two_tabs()
        # 另一窗口/外部进程用 /api/doc 无条件推送替换 current
        st, res = _post(self.base, "/api/doc",
                        {"doc": _doc("doc-other", "外部")})
        self.assertEqual(st, 200, res)
        # 此时 order 里活动位已被归一化替换为 doc-other
        before = self._tabs()
        # 用旧 token 尝试切到 doc-a → 409
        st, res = _post(self.base, "/api/tabs/switch",
                        {"to_id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 409)
        self.assertTrue(res.get("save_conflict"))
        # 什么都没变
        after = self._tabs()
        self.assertEqual([t["id"] for t in after["tabs"]],
                         [t["id"] for t in before["tabs"]])
        self.assertEqual(after["active_id"], before["active_id"])
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-other")

    def test_mcp_doc_push_preserves_previous_active_tab(self):
        """MCP /api/doc 推送新 id 文档 → 旧活动标签保留，其标签文件含推送前
        最新内容（不再被原位替换吞掉）。"""
        token_b = self._seed_two_tabs()  # order=[a,b], active=b
        # 在 doc-b（活动）上条件保存一次：最新内容只在 current.figureproj.json，
        # tabs/doc-b 副本仍是建标签时的旧内容。
        st, res = self._save_current(_doc("doc-b", "B-最新"), token_b)
        self.assertEqual(st, 200, res)
        # MCP 风格推送：无 base_token 的整体替换，id=doc-mcp
        st, res = _post(self.base, "/api/doc", {"doc": _doc("doc-mcp", "MCP")})
        self.assertEqual(st, 200, res)
        tabs = self._tabs()
        self.assertEqual(tabs["active_id"], "doc-mcp")
        ids = [t["id"] for t in tabs["tabs"]]
        self.assertIn("doc-mcp", ids)
        self.assertIn("doc-a", ids)
        self.assertIn("doc-b", ids)  # 旧活动标签不再被 doc-mcp 原位替换
        # doc-b 标签文件 = 推送前 current 的最新内容
        tab_file = self.tabs_dir / "doc-b.figureproj.json"
        self.assertTrue(tab_file.is_file())
        saved = json.loads(tab_file.read_text(encoding="utf-8"))
        self.assertEqual(saved["doc"]["id"], "doc-b")
        self.assertEqual(saved["doc"]["title"], "B-最新")
        # doc-mcp 自己的标签文件同样已写入
        self.assertTrue((self.tabs_dir / "doc-mcp.figureproj.json").is_file())
        # current 即 doc-mcp
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-mcp")

    def test_closed_list_and_restore(self):
        """关闭 → /api/tabs/closed 列出 → restore 移回 tabs/ 并激活。"""
        token_b = self._seed_two_tabs()  # order=[a,b] active=b
        # 关非活动 doc-a
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 200, res)
        token2 = res["save_token"]
        # 空服务器视角的 closed 列表
        closed = self._closed()["closed"]
        self.assertEqual(len(closed), 1)
        self.assertEqual(closed[0]["id"], "doc-a")
        self.assertEqual(closed[0]["title"], "A")
        self.assertTrue(closed[0]["file"].endswith(".figureproj.json"))
        self.assertTrue(closed[0]["closed_at"])
        arch = self.tabs_dir / "closed" / closed[0]["file"]
        self.assertTrue(arch.is_file())
        # restore：归档移回并追加到 order 末尾、激活
        st, res = self._restore(closed[0]["file"], token2)
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-a")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-a")
        self.assertEqual(cur["doc"]["title"], "A")
        self.assertEqual([t["id"] for t in res["tabs"]], ["doc-b", "doc-a"])
        # 归档已移走，标签文件归位，closed 列表清空
        self.assertFalse(arch.is_file())
        self.assertTrue((self.tabs_dir / "doc-a.figureproj.json").is_file())
        self.assertEqual(self._closed()["closed"], [])

    def test_restore_already_open_switches_keeps_archive(self):
        """归档 doc id 已是打开标签 → 等价切换，归档保留原位。"""
        token_b = self._seed_two_tabs()  # order=[a,b] active=b
        # 关 doc-a → 归档 fa
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 200, res)
        token2 = res["save_token"]
        closed = self._closed()["closed"]
        fa = closed[0]["file"]
        # MCP 风格 /api/doc 推送 doc-a：order=[b] 中 active 槽被替换为 doc-a
        st, res = _post(self.base, "/api/doc", {"doc": _doc("doc-a", "A2")})
        self.assertEqual(st, 200, res)
        tabs = self._tabs()
        self.assertEqual(tabs["active_id"], "doc-a")
        # 再开一个标签使 doc-a 变为非活动
        token_cur = self._current()["save_token"]
        st, res = self._new_tab("doc-d", token_cur, "D")
        self.assertEqual(st, 200, res)
        token_d = res["save_token"]
        self.assertEqual(res["active_id"], "doc-d")
        # restore fa（id=doc-a 已打开但非活动）→ 切换过去，归档保留
        st, res = self._restore(fa, token_d)
        self.assertEqual(st, 200, res)
        self.assertEqual(res["active_id"], "doc-a")
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-a")
        # 归档仍在 closed/，列表仍含它
        self.assertTrue((self.tabs_dir / "closed" / fa).is_file())
        self.assertEqual([c["file"] for c in self._closed()["closed"]], [fa])
        # order 里 doc-a 只出现一次（没有重复追加）
        ids = [t["id"] for t in res["tabs"]]
        self.assertEqual(ids.count("doc-a"), 1)

    def test_restore_bad_filename_and_token(self):
        """非法文件名/不存在/错误 token → 400/409 且什么都不改。"""
        token_b = self._seed_two_tabs()
        st, res = _post(self.base, "/api/tabs/close",
                        {"id": "doc-a", "base_token": token_b})
        self.assertEqual(st, 200, res)
        token2 = res["save_token"]
        fname = self._closed()["closed"][0]["file"]
        before_tabs = self._tabs()
        before_closed = self._closed()["closed"]
        # 路径穿越 / 目录前缀 / 不存在 / 空 / 非归档后缀
        for bad in ("../index.json", "closed/x.figureproj.json",
                    "..", "nonexistent.figureproj.json", "",
                    "index.json", "a/b.figureproj.json"):
            st, res = self._restore(bad, token2)
            self.assertEqual(st, 400, (bad, res))
        # 错误 token → 409
        st, res = self._restore(fname, "0" * 64)
        self.assertEqual(st, 409)
        self.assertTrue(res.get("save_conflict"))
        # 状态未变：order、closed 列表、current 都不变
        after_tabs = self._tabs()
        self.assertEqual([t["id"] for t in after_tabs["tabs"]],
                         [t["id"] for t in before_tabs["tabs"]])
        self.assertEqual(after_tabs["active_id"], before_tabs["active_id"])
        self.assertEqual(len(self._closed()["closed"]),
                         len(before_closed))
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], "doc-b")

    def test_index_persists_across_restart(self):
        token_b = self._seed_two_tabs()
        st, res = self._new_tab("doc-c", token_b, "C")
        self.assertEqual(st, 200, res)
        before = self._tabs()
        self.server.stop()
        time.sleep(0.5)
        self.server = _ViewerServer(self.datadir)
        self.server.wait_ready()
        self.base = self.server.base
        after = self._tabs()
        self.assertEqual([t["id"] for t in after["tabs"]],
                         [t["id"] for t in before["tabs"]])
        self.assertEqual(after["active_id"], before["active_id"])
        cur = self._current()
        self.assertEqual(cur["doc"]["id"], after["active_id"])


if __name__ == "__main__":
    unittest.main()
