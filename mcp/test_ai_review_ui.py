# -*- coding: utf-8 -*-
"""test_ai_review_ui.py — 「检查整图」审阅链路 Playwright 验收（C 项）。

viewer.py 以 FIGURE_LLM_BRIDGE 指向测试内桩 HTTP 服务（ThreadingHTTPServer，
POST /chat 返回 OpenAI 形状应答），走真实桥接路径：页面 → /api/ai/chat → 桩。
覆盖：
  1) 桩响应慢于 工作台设置的超时→ 显示「模型响应超时
     （未断开）」，绝不显示「DSH 桥未连接」；
  2) 桩连续返回非 JSON → 「无法解析」措辞，且桩恰好收到 2 次请求
     （首答 + 一次自我修正）；
  3) 桩返回合法审阅数组 → model 模式，意见渲染到审阅列表；
  4) 杀掉 viewer → [data-backend-down] 常驻横幅在 ~20s 内出现。
     （本用例必须最后运行，排序靠方法名 test_1..test_4 保证。）
"""
import json
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from test_modal_layout import (
    HAS_PLAYWRIGHT, SAMPLE_CSV, _ViewerServer, _launch_chromium,
)

HERE = Path(__file__).resolve().parent

REVIEW_ITEM = {
    "severity": "medium",
    "target": "doc",
    "issue": "测试审阅问题：坐标轴标题缺失",
    "suggestion": "补充坐标轴标题",
    "op": None,
}


class _BridgeStub:
    """本机 llm 桥桩：viewer.py 把 /api/ai/chat 原样转发到 {url}/chat。"""

    def __init__(self):
        self.mode = "ok"            # ok | sleep | badjson | http500
        self.sleep_seconds = 5.0
        self.requests = []
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send_json(self, obj, status=200):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                # /progress 等轻量查询：返回空任务即可
                self._send_json({"ok": True, "task": None})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                with outer._lock:
                    outer.requests.append(
                        {"path": self.path, "body": raw.decode("utf-8", "replace")})
                mode = outer.mode
                if mode == "http500":
                    self._send_json({"error": "stub upstream failure"}, status=500)
                    return
                if mode == "sleep":
                    time.sleep(outer.sleep_seconds)
                if mode == "badjson":
                    content = "这不是 JSON，无法解析"
                else:
                    content = json.dumps([REVIEW_ITEM], ensure_ascii=False)
                self._send_json({
                    "choices": [{"message": {"content": content}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                })

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def count(self):
        with self._lock:
            return len(self.requests)

    def shutdown(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


@unittest.skipUnless(HAS_PLAYWRIGHT, "Python playwright + chromium 不可用，跳过")
class AiReviewUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SAMPLE_CSV.exists():
            raise unittest.SkipTest("缺少 examples/sample.csv")
        cls.stub = _BridgeStub()
        cls.datadir = tempfile.mkdtemp(prefix="fig-review-data-")
        cls.server = _ViewerServer(
            cls.datadir, env_extra={"FIGURE_LLM_BRIDGE": cls.stub.url})
        try:
            cls.server.wait_ready()
        except Exception:
            cls.server.stop()
            cls.stub.shutdown()
            shutil.rmtree(cls.datadir, ignore_errors=True)
            raise

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.stub.shutdown()
        shutil.rmtree(cls.datadir, ignore_errors=True)

    def setUp(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self.browser = _launch_chromium(self._pw)

    def tearDown(self):
        try:
            self.browser.close()
        finally:
            self._pw.stop()

    def open_page(self):
        ctx = self.browser.new_context(viewport={"width": 1280, "height": 860})
        page = ctx.new_page()
        page.goto(self.server.base + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#ai-review-btn", timeout=20000)
        # 等 DSH 桥探测完成、bridgeMode 生效（否则 review 走离线分支）
        page.wait_for_function(
            "window.Settings && typeof Settings.bridgeMode === 'function' && "
            "Settings.bridgeMode() === true",
            timeout=15000)
        page.evaluate(
            "App.publishDoc(FigDoc.create({width_mm:120,height_mm:90,title:'t'}))")
        page.wait_for_timeout(300)
        return ctx, page

    def status_text(self, page):
        return page.evaluate(
            "window.AiPanel && typeof AiPanel.statusText === 'function'"
            " ? AiPanel.statusText() : ''")

    def set_timeout(self, page, seconds):
        page.click("#btn-settings")
        modal = page.locator(".ui-modal-settings")
        modal.locator(".settings-advanced summary").click()
        field = modal.get_by_role("spinbutton", name="AI 请求超时（秒）")
        field.fill(str(seconds))
        field.press("Tab")
        modal.get_by_role("button", name="关闭", exact=True).click()

    def test_0_chat_timeout_persists_and_probe_keeps_its_deadline(self):
        ctx, page = self.open_page()
        self.assertEqual(page.evaluate("Settings.timeoutMs()"), 60000)
        self.set_timeout(page, 240)
        page.reload()
        page.wait_for_function("window.Settings && Settings.bridgeMode()")
        self.stub.mode = "http500"
        page.evaluate("AiPanel.chat('测试问答').catch(() => {})")
        self.assertEqual(page.evaluate("Settings.lastModelCall().timeoutMs"), 240000)
        page.evaluate("Settings.testConnection().catch(() => {})")
        self.assertEqual(page.evaluate("Settings.lastModelCall().timeoutMs"), 20000)
        ctx.close()

    # ------------------------------------------------------------- 1
    def test_1_review_timeout_shows_timeout_not_bridge_down(self):
        ctx, page = self.open_page()
        self.stub.mode = "sleep"
        self.stub.sleep_seconds = 12.0
        self.set_timeout(page, 10)
        n0 = self.stub.count()
        page.click("#ai-review-btn")
        page.wait_for_function(
            "window.AiPanel && typeof AiPanel.statusText === 'function' && "
            "/模型响应超时/.test(AiPanel.statusText())",
            timeout=20000)
        txt = self.status_text(page)
        self.assertEqual(page.evaluate("Settings.lastModelCall().timeoutMs"), 10000)
        self.assertIn("模型响应超时", txt)
        self.assertIn("未断开", txt)
        self.assertNotIn("桥未连接", txt)
        # 桥接路径确实发起了请求（桩收到 ≥1 次 /chat 转发）
        self.assertGreaterEqual(self.stub.count() - n0, 1)
        ctx.close()

    # ------------------------------------------------------------- 2
    def test_2_review_unparsable_repairs_once(self):
        ctx, page = self.open_page()
        self.stub.mode = "badjson"
        n0 = self.stub.count()
        page.click("#ai-review-btn")
        page.wait_for_function(
            "window.AiPanel && typeof AiPanel.statusText === 'function' && "
            "/无法解析|已回退/.test(AiPanel.statusText())",
            timeout=20000)
        txt = self.status_text(page)
        self.assertTrue(
            "无法解析" in txt or "已回退" in txt,
            "应显示解析失败措辞，实际：%r" % txt)
        self.assertNotIn("桥未连接", txt)
        # 首答不可解析 → 一次自我修正 → 仍不合法 → 共 2 次模型请求
        self.assertEqual(self.stub.count() - n0, 2,
                         "桩应恰好收到 2 次 /chat 请求（首答+一次修正）")
        ctx.close()

    # ------------------------------------------------------------- 3
    def test_3_review_valid_array_renders_items(self):
        ctx, page = self.open_page()
        self.stub.mode = "ok"
        page.click("#ai-review-btn")
        page.wait_for_function(
            "document.body.innerText.indexOf('测试审阅问题') >= 0",
            timeout=20000)
        txt = self.status_text(page)
        self.assertIn("模型", txt)
        self.assertNotIn("桥未连接", txt)
        self.assertNotIn("已回退", txt)
        ctx.close()

    # ------------------------------------------------------------- 3b
    def test_3b_review_http500_is_model_error_not_bridge_down(self):
        """桥可达但返回 HTTP 500 → 「模型请求失败」，绝不是「DSH 桥未连接」。"""
        ctx, page = self.open_page()
        self.stub.mode = "http500"
        page.click("#ai-review-btn")
        page.wait_for_function(
            "window.AiPanel && typeof AiPanel.statusText === 'function' && "
            "/模型请求失败|已回退/.test(AiPanel.statusText())",
            timeout=20000)
        txt = self.status_text(page)
        self.assertIn("模型请求失败", txt)
        self.assertNotIn("桥未连接", txt)
        self.assertNotIn("模型响应超时", txt)
        ctx.close()

    # ------------------------------------------------------------- 4
    def test_4_backend_down_banner_after_viewer_killed(self):
        ctx, page = self.open_page()
        # 先确认服务正常时没有横幅
        self.assertFalse(
            page.evaluate("!!document.querySelector('[data-backend-down]')"))
        self.server.stop()  # 杀掉 viewer.py；页面本身仍在浏览器里
        page.wait_for_selector("[data-backend-down]", state="visible",
                               timeout=25000)
        banner = page.inner_text("[data-backend-down]")
        self.assertIn("后台服务已断开", banner)
        self.assertIn("保存、导出、拆分和 AI 暂不可用", banner)
        ctx.close()


if __name__ == "__main__":
    unittest.main()
