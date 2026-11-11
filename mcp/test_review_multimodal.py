# -*- coding: utf-8 -*-
"""Offline unit tests for review, template capability and SVG failure gates.

HTTP responses, host model calls and bridge calls are in-memory fakes. Passing
these tests is not evidence of DeepSeek connectivity, model vision capability,
or the separate FigData EIS-coordinate implementation's numerical correctness.
"""

import base64
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MCP_DIR = Path(__file__).resolve().parent
if str(MCP_DIR) not in sys.path:
    sys.path.insert(0, str(MCP_DIR))

import server  # noqa: E402


PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
PNG_BASE64 = base64.b64encode(PNG_BYTES).decode("ascii")
JPEG_BASE64 = base64.b64encode(b"\xff\xd8\xff\xd9").decode("ascii")
DOC = {
    "schema_version": "1.0",
    "id": "review-test",
    "canvas": {
        "width_mm": 100,
        "height_mm": 80,
        "dpi": 300,
        "background": "#FFFFFF",
        "color_mode": "RGB",
    },
    "elements": [],
    "anchors": [],
    "meta": {},
}


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return json.dumps({
            "choices": [{"message": {"content": "[]"}}],
        }).encode("utf-8")


def review_messages(with_image):
    boundary = (
        "请求中包含当前渲染截图；仍不得据此保证真实视觉质量或审美/投稿验收"
        if with_image else
        "未提供渲染截图，只能依据结构化 FigureDocument、几何信息和规则告警；"
        "不得声称看过像素或完成视觉审美验收"
    )
    return [
        {"role": "system", "content": "请审阅给定的图形文档（%s）。" % boundary},
        {"role": "user", "content": "请审阅当前文档并列出问题。"},
        {"role": "assistant", "content": "仍须只返回 JSON 数组。"},
    ]


class ReviewMultimodalTests(unittest.TestCase):
    def capture_http(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["request"] = request
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse()

        return captured, fake_urlopen

    def test_png_reaches_openai_image_url_on_actual_last_user(self):
        captured, fake_urlopen = self.capture_http()
        source_messages = review_messages(with_image=True)
        original_messages = copy.deepcopy(source_messages)
        bridge_calls = []

        def fake_bcall(name, **kwargs):
            bridge_calls.append((name, kwargs))
            if name == "presets.check":
                return {"ok": True, "warnings": []}
            if name == "ai.build_review_messages":
                return source_messages
            self.fail("unexpected bridge call: " + name)

        expected_url = "data:image/png;base64," + PNG_BASE64
        with mock.patch.object(server, "get_api_key", return_value="offline-test-key"), \
                mock.patch.object(server, "bcall", side_effect=fake_bcall), \
                mock.patch.object(server.urllib.request, "urlopen", side_effect=fake_urlopen):
            result = server.tool_figure_review({"doc": DOC, "png_base64": PNG_BASE64})

        self.assertEqual(result, {"ok": True, "items": [], "mode": "model"})
        build_call = next(kwargs for name, kwargs in bridge_calls
                          if name == "ai.build_review_messages")
        self.assertEqual(build_call["image_data_url"], expected_url)
        messages = captured["body"]["messages"]
        self.assertTrue(any(message.get("role") == "system" for message in messages))
        self.assertIn("请求中包含当前渲染截图", messages[0]["content"])
        self.assertEqual(messages[-1]["content"], "仍须只返回 JSON 数组。")
        self.assertIsInstance(messages[-2]["content"], list)
        self.assertEqual(messages[-2]["content"][0], {
            "type": "text", "text": "请审阅当前文档并列出问题。",
        })
        self.assertEqual(messages[-2]["content"][1], {
            "type": "image_url", "image_url": {"url": expected_url},
        })
        self.assertEqual(messages[-2]["content"][1]["image_url"]["url"].split(",", 1)[1],
                         PNG_BASE64)
        self.assertEqual(source_messages, original_messages, "do not mutate builder messages")

    def test_text_only_payload_and_structural_prompt_stay_unchanged(self):
        captured, fake_urlopen = self.capture_http()
        messages = review_messages(with_image=False)
        with mock.patch.object(server, "get_api_key", return_value="offline-test-key"), \
                mock.patch.object(server.urllib.request, "urlopen", side_effect=fake_urlopen):
            server._deepseek_chat(messages)

        self.assertEqual(captured["body"]["messages"], messages)
        self.assertIsInstance(captured["body"]["messages"][-2]["content"], str)
        system = next(message for message in captured["body"]["messages"]
                      if message.get("role") == "system")
        self.assertIn("只能依据结构化 FigureDocument", system["content"])
        self.assertIn("不得声称看过像素", system["content"])
        self.assertNotIn("image_url", json.dumps(captured["body"]))

    def test_real_frontend_prompt_has_system_and_distinct_image_boundaries(self):
        script = r"""
const fs = require('fs');
const doc = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const file of ['./lib/figdoc.js', './lib/data.js', './lib/presets.js',
                     './lib/render.js', './lib/ops.js', './lib/ai.js']) require(file);
const reviewDoc = {...doc, elements: [{
  id: 'text-run', type: 'text', text: '待审阅文本',
  transform: {x: 10, y: 12, w: 60, h: 20, rotation: 0},
  style: {fontSizePt: 8, fontFamily: 'Arial'}
}]};
const options = {doc: reviewDoc,
  journalPreset: {id: 'nature-single', width_mm: 89, base_font_pt: 8, min_font_pt: 7},
  checkResult: {ok: false, warnings: [
    {code: 'FONT_TOO_SMALL', message: '运行规则：fontSizePt 小于 7pt', element_id: 'text-run'},
    {code: 'CANVAS_SIZE', message: '运行规则：尺寸须为 89mm', element_id: null}
  ]}};
const withoutImage = FigAI.buildReviewMessages(options);
const withImage = FigAI.buildReviewMessages({...options,
  imageDataUrl: 'data:image/png;base64,' + Buffer.alloc(4).toString('base64')});
console.log(JSON.stringify({withoutImage, withImage}));
"""
        completed = subprocess.run(
            ["node", "-e", script], cwd=str(MCP_DIR),
            input=json.dumps(DOC), capture_output=True, text=True,
            encoding="utf-8", timeout=30, check=True,
        )
        prompts = json.loads(completed.stdout)
        without_image = prompts["withoutImage"]
        with_image = prompts["withImage"]
        self.assertTrue(all(isinstance(message.get("content"), str)
                            for message in without_image + with_image))
        self.assertTrue(any(message.get("role") == "system" for message in without_image))
        self.assertTrue(any(message.get("role") == "system" for message in with_image))
        self.assertIn("只能依据结构化 FigureDocument", without_image[0]["content"])
        self.assertIn("不得声称看过像素", without_image[0]["content"])
        self.assertIn("请求中包含当前渲染截图", with_image[0]["content"])
        self.assertNotIn("请求中包含当前渲染截图", without_image[0]["content"])
        self.assertNotIn("只能依据结构化 FigureDocument", with_image[0]["content"])
        for expected in ("只输出一个 JSON 数组", "FONT_TOO_SMALL", "fontSizePt",
                         "最小字号 7pt", "栏宽 89mm", "10,12,60,20", "待审阅文本"):
            self.assertIn(expected, without_image[0]["content"])

    def test_jpeg_and_data_urls_are_accepted_and_mismatch_is_rejected(self):
        self.assertEqual(server._validate_review_image(JPEG_BASE64),
                         "data:image/jpeg;base64," + JPEG_BASE64)
        self.assertEqual(server._validate_review_image(
            "data:image/jpg;base64," + JPEG_BASE64),
            "data:image/jpeg;base64," + JPEG_BASE64)
        self.assertEqual(server._validate_review_image(
            "data:image/png;base64," + PNG_BASE64),
            "data:image/png;base64," + PNG_BASE64)
        with self.assertRaisesRegex(server.ToolError, "声明的 image/png.*实际 image/jpeg"):
            server._validate_review_image("data:image/png;base64," + JPEG_BASE64)

    def test_invalid_images_are_tool_errors_before_bridge_or_http(self):
        malformed_svg = base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode()
        cases = [
            "",
            42,
            "https://example.invalid/figure.png",
            "data:image/svg+xml;base64," + malformed_svg,
            malformed_svg,
            "data:image/png;base64,%%%not-base64%%%",
            "data:image/png;base64",
            "data:image/gif;base64," + JPEG_BASE64,
        ]
        for value in cases:
            with self.subTest(value=repr(value)[:100]), \
                    mock.patch.object(server, "get_api_key", return_value="offline-test-key"), \
                    mock.patch.object(server, "bcall") as bridge, \
                    mock.patch.object(server.urllib.request, "urlopen") as network:
                with self.assertRaises(server.ToolError) as raised:
                    server.tool_figure_review({"doc": DOC, "png_base64": value})
                self.assertIn("png_base64", str(raised.exception))
                bridge.assert_not_called()
                network.assert_not_called()

    def test_oversized_image_is_tool_error_before_decoding_or_bridge(self):
        oversized = base64.b64encode(PNG_BYTES + b"X").decode("ascii")
        with mock.patch.object(server, "MAX_REVIEW_IMAGE_BYTES", len(PNG_BYTES)), \
                mock.patch.object(server, "get_api_key", return_value="offline-test-key"), \
                mock.patch.object(server, "bcall") as bridge, \
                mock.patch.object(server.urllib.request, "urlopen") as network:
            with self.assertRaisesRegex(server.ToolError, "图片过大"):
                server.tool_figure_review({"doc": DOC, "png_base64": oversized})
            bridge.assert_not_called()
            network.assert_not_called()

    def test_image_requires_a_user_message_without_making_http_request(self):
        with mock.patch.object(server, "get_api_key", return_value="offline-test-key"), \
                mock.patch.object(server.urllib.request, "urlopen") as network:
            with self.assertRaisesRegex(server.ToolError, "必须至少有一条 user"):
                server._deepseek_chat(
                    [{"role": "system", "content": "review"}],
                    image_data_url="data:image/png;base64," + PNG_BASE64,
                )
            network.assert_not_called()


class HostMessageOnlyTests(unittest.TestCase):
    def test_host_rpc_receives_text_messages_before_key_model_or_fallback(self):
        doc = copy.deepcopy(DOC)
        doc["elements"] = [{
            "id": "text-run", "type": "text", "text": "run 文本",
            "transform": {"x": 10, "y": 12, "w": 60, "h": 20, "rotation": 0},
            "style": {"fontSizePt": 8, "fontFamily": "Arial"},
        }]
        check = {"ok": False, "warnings": [
            {"code": "FONT_TOO_SMALL", "message": "run 规则：字号小于 7pt",
             "element_id": "text-run"},
            {"code": "CANVAS_SIZE", "message": "run 规则：尺寸为 89mm"},
        ]}
        builder_messages = [
            {"role": "system", "content": (
                "输出要求：只输出 JSON 数组。run 规则 FONT_TOO_SMALL：fontSizePt=8pt；"
                "bbox_mm=10,12,60,20；text=run 文本；尺寸=89mm。")},
            {"role": "user", "content": "请审阅当前文档并列出问题。"},
        ]
        bridge_calls = []

        def fake_bcall(name, **kwargs):
            bridge_calls.append((name, kwargs))
            if name == "presets.check":
                return check
            if name == "ai.build_review_messages":
                return copy.deepcopy(builder_messages)
            self.fail("unexpected bridge call: " + name)

        request = {
            "jsonrpc": "2.0", "id": 41, "method": "tools/call",
            "params": {"name": "figure_review", "arguments": {
                "doc": doc, "journal_id": "nature-single",
                "build_messages_only": True,
            }},
        }
        with mock.patch.object(server, "bcall", side_effect=fake_bcall), \
                mock.patch.object(server, "get_api_key") as api_key, \
                mock.patch.object(server, "_deepseek_chat") as model, \
                mock.patch.object(server.urllib.request, "urlopen") as network:
            response = server._handle(request)

        payload = json.loads(response["result"]["content"][0]["text"])
        self.assertEqual(set(payload), {"ok", "messages"})
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["messages"], builder_messages)
        self.assertTrue(payload["messages"])
        self.assertTrue(all(isinstance(message.get("content"), str)
                            for message in payload["messages"]))
        combined = "\n".join(message["content"] for message in payload["messages"])
        for expected in ("run 规则", "只输出 JSON 数组", "fontSizePt", "89mm",
                         "10,12,60,20", "run 文本"):
            self.assertIn(expected, combined)
        self.assertNotIn("image_url", combined)
        self.assertEqual([name for name, _kwargs in bridge_calls],
                         ["presets.check", "ai.build_review_messages"])
        check_call = bridge_calls[1][1]
        self.assertIs(check_call["doc"], doc)
        self.assertIsNone(check_call["image_data_url"])
        self.assertEqual(check_call["journal_preset"]["id"], "nature-single")
        self.assertIs(check_call["check_result"], check)
        api_key.assert_not_called()
        model.assert_not_called()
        network.assert_not_called()

    def test_host_mode_rejects_png_and_unknown_journal_without_side_effects(self):
        cases = [
            ({"doc": DOC, "build_messages_only": True, "png_base64": PNG_BASE64},
             "不能与 png_base64"),
            ({"doc": DOC, "build_messages_only": True, "journal_id": "not-a-journal"},
             "未找到期刊预设"),
        ]
        for arguments, error in cases:
            with self.subTest(error=error), \
                    mock.patch.object(server, "bcall") as bridge, \
                    mock.patch.object(server, "get_api_key") as api_key, \
                    mock.patch.object(server, "_deepseek_chat") as model, \
                    mock.patch.object(server.urllib.request, "urlopen") as network:
                with self.assertRaisesRegex(server.ToolError, error):
                    server.tool_figure_review(arguments)
                bridge.assert_not_called()
                api_key.assert_not_called()
                model.assert_not_called()
                network.assert_not_called()

    def test_host_mode_rejects_nontext_builder_response_instead_of_fallback(self):
        def fake_bcall(name, **kwargs):
            if name == "presets.check":
                return {"ok": True, "warnings": []}
            if name == "ai.build_review_messages":
                return [{"role": "system", "content": [{"type": "text", "text": "bad"}]}]
            self.fail("unexpected fallback bridge call: " + name)

        with mock.patch.object(server, "bcall", side_effect=fake_bcall), \
                mock.patch.object(server, "get_api_key") as api_key, \
                mock.patch.object(server, "_deepseek_chat") as model:
            with self.assertRaisesRegex(server.ToolError, r"messages\[0\].*字符串"):
                server.tool_figure_review({"doc": DOC, "build_messages_only": True})
            api_key.assert_not_called()
            model.assert_not_called()


class TemplateCapabilityTests(unittest.TestCase):
    NATIVE_TYPES = frozenset((
        "bar", "bar_grouped", "line", "line_multi", "scatter", "area",
        "pie", "histogram", "heatmap", "box",
    ))

    def test_all_60_are_classified_but_unsupported_are_opt_in_preview_only(self):
        with mock.patch.object(server, "_render_chart_types", return_value=self.NATIVE_TYPES):
            default = server.tool_figure_templates({})
            preview = server.tool_figure_templates({"include_unsupported": True})
            unsupported = server.tool_figure_templates({"capability": "unsupported"})
            layout = server.tool_figure_templates({"capability": "layout"})

        self.assertLess(len(default["templates"]), 60)
        self.assertEqual(len(preview["templates"]), 60)
        self.assertTrue(all(item["can_apply"] for item in default["templates"]))
        self.assertTrue(all(item["capability"] in ("full", "layout", "unsupported")
                            for item in preview["templates"]))
        self.assertTrue(unsupported["templates"])
        self.assertTrue(all(item["capability"] == "unsupported"
                            and not item["can_apply"] and not item["auto_generate"]
                            for item in unsupported["templates"]))
        self.assertNotIn("unsupported",
                         {item["capability"] for item in default["templates"]})
        self.assertIn("tpl-violin",
                      {item["id"] for item in unsupported["templates"]})
        self.assertTrue(layout["templates"])
        self.assertTrue(all(item["capability"] == "layout" and item["can_apply"]
                            and not item["auto_generate"]
                            for item in layout["templates"]))
        self.assertIn("不会自动填入真实图表", layout["templates"][0]["capability_note"])
        raw_items = server._PRESETS_RAW["templates"]["templates"]
        self.assertNotIn("capability", raw_items[0])

    def test_discovery_prefers_figdata_and_falls_back_to_actual_render_definitions(self):
        with mock.patch.dict(server._RENDER_TYPE_CACHE, {"types": None}), \
                mock.patch.object(server, "bcall", return_value=["bar", "scatter"]) as bridge:
            self.assertEqual(server._render_chart_types(), frozenset(("bar", "scatter")))
            bridge.assert_called_once_with("data.chart_types")

        with mock.patch.dict(server._RENDER_TYPE_CACHE, {"types": None}), \
                mock.patch.object(server, "bcall",
                                  side_effect=server.BridgeCallError("route unavailable")):
            fallback = server._render_chart_types()
        source = (MCP_DIR / "lib" / "data.js").read_text(encoding="utf-8")
        actual = frozenset(server._RENDERER_DEFINITION_RE.findall(source))
        self.assertEqual(fallback, actual)
        self.assertTrue(fallback)

    def test_recommendations_default_filter_unsupported_and_annotate_opt_in_preview(self):
        def fake_bcall(name, **kwargs):
            if name == "data.parse_csv":
                return {"columns": ["x", "y"], "rows": [["a", 1]]}
            if name == "data.column_stats":
                return {"columns": []}
            if name == "presets.recommend":
                return [
                    {"template_id": "tpl-violin", "score": 99,
                     "capability": {"status": "unsupported"}},
                    {"template_id": "tpl-bar", "score": 80},
                ]
            self.fail("unexpected bridge call: " + name)

        with mock.patch.object(server, "_render_chart_types", return_value=frozenset(("bar",))), \
                mock.patch.object(server, "bcall", side_effect=fake_bcall):
            default = server.tool_figure_open_data({"csv": "x,y\na,1"})
            preview = server.tool_figure_open_data({
                "csv": "x,y\na,1", "include_unsupported": True,
            })
        self.assertEqual([item["template_id"] for item in default["recommended"]], ["tpl-bar"])
        self.assertEqual(default["recommended"][0]["capability"], "full")
        self.assertEqual([item["template_id"] for item in preview["recommended"]],
                         ["tpl-violin", "tpl-bar"])
        self.assertEqual(preview["recommended"][0]["capability"], "unsupported")
        self.assertFalse(preview["recommended"][0]["can_apply"])

    def test_unsupported_direct_apply_and_create_are_rejected_before_mutation(self):
        with mock.patch.object(server, "_render_chart_types", return_value=frozenset(("bar",))), \
                mock.patch.object(server, "_apply_ops_with_history") as apply_ops:
            rejected = server.tool_figure_apply_edits({
                "doc": DOC,
                "ops": [{"op": "apply_template", "template_id": "tpl-diagram-decision"}],
            })
            self.assertFalse(rejected["ok"])
            self.assertIn("禁止", rejected["error"])
            apply_ops.assert_not_called()

            with mock.patch.object(server, "bcall", return_value={"columns": []}):
                with self.assertRaisesRegex(server.ToolError, "禁止应用"):
                    server.tool_figure_create_chart({
                        "doc": DOC, "chart_type": "violin", "template_id": "tpl-violin",
                        "data": {"inline": {"columns": ["group", "value"], "rows": [["a", 1]]}},
                    })
            apply_ops.assert_not_called()

    def test_layout_apply_succeeds_with_explicit_empty_layout_warning(self):
        with mock.patch.object(server, "_apply_ops_with_history", return_value=(DOC, 1)) as apply_ops:
            result = server.tool_figure_apply_edits({
                "doc": DOC,
                "ops": [{"op": "apply_template", "template_id": "tpl-composite-2x2"}],
            })
        self.assertTrue(result["ok"])
        self.assertEqual(result["applied"], 1)
        self.assertIn("仅创建空白复合版式", result["warnings"][0])
        self.assertIn("不会自动填入真实图表", result["warnings"][0])
        apply_ops.assert_called_once()


class RenderFailureGateTests(unittest.TestCase):
    @staticmethod
    def document(chart):
        doc = copy.deepcopy(DOC)
        doc["elements"] = [{
            "id": "chart-run", "type": "chart", "chart": chart,
            "transform": {"x": 5, "y": 5, "w": 80, "h": 60, "rotation": 0},
            "style": {},
        }]
        return doc

    def test_unsupported_chart_type_fails_before_render_bridge(self):
        doc = self.document({"chartType": "violin", "data": {"inline": {
            "columns": ["x", "y"], "rows": [["a", 1]],
        }}})
        with mock.patch.object(server, "_render_chart_types", return_value=frozenset(("bar",))), \
                mock.patch.object(server, "bcall") as bridge:
            with self.assertRaisesRegex(server.ToolError, "不支持真实 SVG"):
                server._render_svg(doc)
            bridge.assert_not_called()

    def test_v2_placeholder_from_a_supported_type_is_a_render_error(self):
        doc = self.document({"chartType": "bar", "data": {"inline": {
            "columns": ["x", "y"], "rows": [],
        }, "ref": None}, "mapping": {}})
        placeholder = ('<svg width="100mm" height="80mm">'
                       '<text>该图表类型需 v2 服务端渲染</text></svg>')
        with mock.patch.object(server, "_render_chart_types", return_value=frozenset(("bar",))), \
                mock.patch.object(server, "bcall", return_value=placeholder):
            with self.assertRaisesRegex(server.ToolError, "不会把"):
                server._render_svg(doc)

    def test_unsupported_preview_is_never_a_render_or_export_success(self):
        doc = self.document({"chartType": "bar", "data": {"inline": {
            "columns": ["x", "y"], "rows": [["a", 1]],
        }}})
        preview = ('<svg width="100mm" height="80mm">'
                   '<g data-render="unsupported-preview" data-real-data="false"/></svg>')
        with mock.patch.object(server, "_render_chart_types", return_value=frozenset(("bar",))), \
                mock.patch.object(server, "bcall", return_value=preview):
            with self.assertRaisesRegex(server.ToolError, "只能用于界面示意"):
                server._render_svg(doc)

    def test_only_empty_composite_layout_may_replace_placeholder_label(self):
        placeholder = ('<svg width="100mm" height="80mm">'
                       '<text>该图表类型需 v2 服务端渲染</text></svg>')
        structured_empty = {
            "chartType": None, "mapping": {"x": None},
            "data": {"inline": {"columns": ["x"], "rows": []}},
        }
        with mock.patch.object(server, "bcall", return_value=placeholder):
            svg = server._render_svg(self.document({}))
            structured_svg = server._render_svg(self.document(structured_empty))
        self.assertNotIn("需 v2", svg)
        self.assertIn("空版式（未填图）", svg)
        self.assertIn("空版式（未填图）", structured_svg)

    def test_export_render_failure_does_not_create_an_output_file(self):
        doc = copy.deepcopy(DOC)
        doc["meta"] = {"created": "2026-01-01T00:00:00Z",
                       "updated": "2026-01-01T00:00:00Z"}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "must-not-exist.svg"
            with mock.patch.object(server, "_render_svg",
                                   side_effect=server.ToolError("unsupported")):
                with self.assertRaisesRegex(server.ToolError, "unsupported"):
                    server.tool_figure_export({
                        "doc": doc, "format": "svg", "out_path": str(output),
                    })
            self.assertFalse(output.exists())

    def test_tool_contract_explicitly_adds_three_tools_and_hides_host_internal_mode(self):
        self.assertEqual(len(server.tools_spec.TOOLS), 26)
        review = server.tools_spec.get_tool("figure_review")
        self.assertNotIn("build_messages_only", review["input_schema"]["properties"])
        generated = json.loads((MCP_DIR / "tools.json").read_text(encoding="utf-8"))
        self.assertEqual(generated, server.tools_spec.build_tools_json())


if __name__ == "__main__":
    unittest.main()
