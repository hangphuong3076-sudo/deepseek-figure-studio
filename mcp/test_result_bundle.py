# -*- coding: utf-8 -*-
"""Real synthetic result-bundle I/O and decoder boundaries; no official case/score."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


MCP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(MCP_DIR))
import server  # noqa: E402


class ResultBundleTests(unittest.TestCase):
    def diagram(self):
        doc = server.tool_figure_create({"title": "synthetic only"})["doc"]
        result = server.tool_figure_schematic({
            "doc": doc,
            "contract": {
                "id": "synthetic-result",
                "nodes": [{"id": "q", "label": "Synthetic question", "role": "question", "evidence": ["note"]}],
                "relations": [],
                "sources": [{"id": "note", "locator": "synthetic note", "version": "v1"}],
            },
        })
        self.assertTrue(result["ok"])
        return result["doc"]

    def test_real_exports_contract_fields_hashes_source_and_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "given.csv"
            original = b"group,value\r\nalpha,2\r\nalpha,4\r\n"
            source.write_bytes(original)
            expected_hash = hashlib.sha256(original).hexdigest()
            output = root / "actual-output"
            result = server.tool_figure_export_bundle({
                "doc": self.diagram(), "output_directory": str(output),
                "input_source": [{"path": str(source), "sha256": expected_hash}],
                "output_contract": {
                    "case_id": "synthetic-not-official", "custom_nested": {"retained": 17},
                    "uncertainty": "caller-native uncertainty must remain a string",
                    "apiKey": "never-leak-12345", "model_config_key": "not-a-model", "dpi": 24,
                    "artifacts": [
                        "svg", {"extension": ".png", "dpi": 24}, {"ext": "pdf"}, {"format": "tiff", "dpi": 24}],
                },
                "model_config": {"temperature": 0},
            })
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "ready_for_review")
            self.assertTrue((output / "figure.figureproj.json").is_file())
            result_json = json.loads((output / "result.json").read_text(encoding="utf-8"))
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(result_json["custom_nested"], {"retained": 17})
            self.assertEqual(result_json["case_id"], "synthetic-not-official")
            self.assertEqual(result_json["uncertainty"], "caller-native uncertainty must remain a string")
            self.assertIsInstance(result_json["audit_uncertainty"], list)
            self.assertEqual(result_json["model"], {"id": None, "config": {"temperature": 0}})
            self.assertIsNone(result_json["human_review"])
            self.assertEqual(result_json["ui_native_result_status"], "not_observed")
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(result_json["source"][0]["actual_sha256"], expected_hash)
            self.assertFalse(result_json["source"][0]["content_copied"])
            self.assertFalse((output / "given.csv").exists())
            self.assertEqual(len(result_json["artifacts"]), 6)
            self.assertIn("version", result_json)
            for artifact in result_json["artifacts"]:
                path = Path(artifact["path"])
                self.assertTrue(path.parent.samefile(output), artifact)
                self.assertTrue(path.is_file(), artifact)
                self.assertRegex(artifact["sha256"], r"^[a-f0-9]{64}$")
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), artifact["sha256"])
                self.assertGreater(path.stat().st_size, 0)
            formats = {item["format"] for item in result_json["artifacts"]}
            self.assertIn("figureproj.json", formats)
            self.assertTrue({"svg", "png", "pdf", "tiff"}.issubset(formats))
            for path, fmt in [(output / "figure.png", "PNG"), (output / "figure.tiff", "TIFF")]:
                from PIL import Image
                with Image.open(path) as image:
                    self.assertEqual(image.format, fmt)
                    self.assertGreater(image.width, 0)
                    self.assertAlmostEqual(float(image.info["dpi"][0]), 24, delta=0.05)
            import fitz
            with fitz.open(output / "figure.pdf") as pdf:
                self.assertGreaterEqual(pdf.page_count, 1)
                self.assertTrue(pdf[0].get_text().strip())
                self.assertAlmostEqual(pdf[0].rect.width, 120 * 72 / 25.4, delta=0.2)
            decoded = {item["format"]: item["decoded"] for item in result_json["artifacts"] if item.get("decoded")}
            self.assertEqual(decoded["png"]["mime_type"], "image/png")
            self.assertEqual(decoded["pdf"]["mime_type"], "application/pdf")
            self.assertTrue(decoded["pdf"]["text_available"])
            svg = (output / "figure.svg").read_text(encoding="utf-8")
            self.assertIn("<text", svg)
            self.assertNotIn("<image", svg)
            for text in (manifest, result_json, svg):
                self.assertNotIn("never-leak-12345", json.dumps(text) if not isinstance(text, str) else text)
            self.assertEqual(manifest["status"], "ready_for_review")
            self.assertNotIn("DeepSeek", json.dumps(result_json["model"]))

    def test_missing_source_and_unknown_extension_stay_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "partial"
            result = server.tool_figure_export_bundle({
                "doc": self.diagram(), "output_directory": str(output),
                "output_contract": {"formats": ["unfamiliar-extension"], "unknown_result_field": ["preserved"]},
                "input_source": [str(Path(tmp) / "missing-paper.pdf")],
            })
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["unknown_result_field"], ["preserved"])
            self.assertTrue((output / "figure.figureproj.json").is_file())
            self.assertTrue((output / "lineage.json").is_file())
            self.assertFalse((output / "figure.unfamiliar-extension").exists())
            self.assertTrue(result["errors"])
            self.assertTrue(any("SOURCE" in check["code"] for check in result["checks"] if "code" in check))
            self.assertTrue(any("paper" in item or "SOURCE" in item for item in result["uncertainty"]))
            self.assertIsNone(result["human_review"])

    def test_bad_directory_contract_and_approved_chart_data_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file_boundary = root / "not-a-directory"
            file_boundary.write_text("do not overwrite", encoding="utf-8")
            with self.assertRaises(server.ToolError):
                server.tool_figure_export_bundle({"doc": self.diagram(), "output_directory": str(file_boundary)})
            self.assertEqual(file_boundary.read_text(encoding="utf-8"), "do not overwrite")
            self.assertFalse((root / "result.json").exists())
            with self.assertRaises(server.ToolError):
                server.tool_figure_export_bundle({"doc": self.diagram(), "output_directory": "  "})
            raw = root / "rows.csv"
            raw.write_text("arm,response\ncontrol,2\ncontrol,4\n", encoding="utf-8")
            raw_before = raw.read_bytes()
            direct = server.bcall("data.parse_csv", text=raw_before.decode("utf-8"))
            doc = server.tool_figure_create_chart({
                "doc": server.tool_figure_create({})["doc"], "chart_type": "bar",
                "data": {"inline": direct},
            })
            element = next(item for item in doc["doc"]["elements"] if item["type"] == "chart")
            mapping = json.dumps(element["chart"]["mapping"], sort_keys=True)
            result = server.tool_figure_apply_edits({
                "doc": doc["doc"],
                "ops": [{"op": "set_chart_data", "targets": [element["id"]],
                         "data": {"columns": ["arm", "response"], "rows": [["changed", 10]]}}],
            })
            self.assertFalse(result["ok"])
            self.assertTrue(result["errors"])
            self.assertEqual(raw.read_bytes(), raw_before)
            chart = next(item for item in result["doc"]["elements"] if item["type"] == "chart")
            self.assertEqual(json.dumps(chart["chart"]["mapping"], sort_keys=True), mapping)
            self.assertEqual(chart["chart"]["data"]["inline"], direct)


if __name__ == "__main__":
    unittest.main()
