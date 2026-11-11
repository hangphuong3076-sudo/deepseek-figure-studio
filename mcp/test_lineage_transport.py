# -*- coding: utf-8 -*-
"""Real stdio MCP lineage checks using synthetic data only."""

import collections
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path


MCP_DIR = Path(__file__).resolve().parent


class StdioMCP:
    def __init__(self):
        env = dict(os.environ)
        env.pop("DEEPSEEK_API_KEY", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        self.process = subprocess.Popen(
            [sys.executable, "-B", str(MCP_DIR / "server.py")], cwd=str(MCP_DIR), env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        self.responses = queue.Queue()
        self.errors = collections.deque(maxlen=20)
        self.serial = 0
        threading.Thread(target=self._stdout, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def _stdout(self):
        for line in self.process.stdout:
            self.responses.put(line)
        self.responses.put(None)

    def _stderr(self):
        for line in self.process.stderr:
            self.errors.append(line.rstrip()[:400])

    def call(self, name, arguments):
        self.serial += 1
        request = {"jsonrpc": "2.0", "id": self.serial, "method": "tools/call",
                   "params": {"name": name, "arguments": arguments}}
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            line = self.responses.get(timeout=max(0.1, deadline - time.monotonic()))
            if line is None:
                raise AssertionError("MCP stopped: " + " | ".join(self.errors))
            response = json.loads(line)
            if response.get("id") != self.serial:
                continue
            if "error" in response:
                raise AssertionError(response["error"])
            payload = json.loads(response["result"]["content"][0]["text"])
            if not payload.get("ok"):
                raise AssertionError(payload)
            return payload
        raise TimeoutError(name)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream:
                stream.close()


def chart(identifier, chart_type, columns, rows, mapping, statistics=None):
    spec = {"chartType": chart_type, "data": {"inline": {"columns": columns, "rows": rows}, "ref": None},
            "mapping": mapping}
    if statistics is not None:
        spec["statistics"] = statistics
    return {"id": identifier, "type": "chart", "chart": spec}


class LineageTransportTests(unittest.TestCase):
    def test_real_stdio_unsupported_partial_and_fallback_survive_json_round_trip(self):
        client = StdioMCP()
        try:
            created = client.call("figure_create", {"title": "synthetic lineage transport"})
            doc = created["doc"]
            columns = ["Category", "Group", "Measurement"]
            rows = [["A", "g1", 1], ["A", "g2", 2], ["A", "g3", 3],
                    ["A", "g4", 4], ["A", "g5", 5], ["A", "g1", 1.5]]
            doc["elements"].extend([
                chart("heat-transport", "heatmap", columns, rows,
                      {"x": "Group", "y": "Category", "color": "Measurement"}),
                chart("fallback-transport", "bar", ["Category", "Measurement"],
                      [["A", 20], ["A", 30]], {"x": "Category", "y": "missing"},
                      {"unit_x": {"invalid": True}, "unit_y": ["invalid"]}),
                chart("bar-transport", "bar", ["Category", "Measurement"],
                      [["A", 20], ["A", 30]], {"x": "Category", "y": "Measurement"}),
            ])
            report = client.call("figure_lineage", {"doc": doc})
            self.assertEqual(report["schema_version"], "figure-lineage/1.0")
            self.assertEqual(report["scope"], "structured_figure")
            self.assertEqual(report["coverage"], "partial")
            self.assertFalse(report["complete"])
            self.assertEqual(report["scientific_validation"], "not_performed")
            self.assertIsNone(report["human_visual_review"])
            records = {record["element_id"]: record for record in report["charts"]}
            heat = records["heat-transport"]
            self.assertEqual(heat["status"], "unsupported")
            self.assertEqual(heat["coverage"], "partial")
            self.assertEqual(heat["row_count"], 6)
            self.assertEqual(heat["row_mapping_status"], "not_performed")
            self.assertIsInstance(heat["field_matrix"], list)
            self.assertIsInstance(heat["field_matrix_by_role"], dict)
            self.assertIsInstance(heat["columns"], list)
            self.assertEqual(heat["field_matrix_by_role"]["color"]["column"], "Measurement")
            self.assertEqual(heat["points"], [])
            self.assertTrue(any(issue["code"] == "LINEAGE_UNSUPPORTED"
                                for issue in heat["issues"]))
            fallback = records["fallback-transport"]
            self.assertEqual(fallback["status"], "error")
            self.assertEqual(fallback["row_count"], 2)
            self.assertEqual(fallback["row_mapping_status"], "error")
            self.assertIsInstance(fallback["field_matrix"], list)
            self.assertEqual(fallback["field_matrix_by_role"]["y"]["column"], "missing")
            self.assertTrue(any(issue["code"] == "MAPPING_COLUMN_MISSING"
                                for issue in fallback["issues"]))
            lookup = client.call("figure_lineage", {"doc": doc, "lookup": {
                "element_id": "bar-transport", "source_row": 0}})
            self.assertEqual(lookup["charts"][2]["points"][0]["value"], 25)
            self.assertEqual(lookup["lookup"]["count"], 1)
            self.assertEqual(lookup["lookup"]["matches"][0]["raw_point"]["y"], 20)
            self.assertEqual(lookup["lookup"]["matches"][0]["source_rows"], [0, 1])
            json.loads(json.dumps(report, ensure_ascii=False))
        finally:
            client.close()


    def test_replacement_source_identity_unknown_then_explicit_hash_with_chart_isolation(self):
        client = StdioMCP()
        try:
            created = client.call("figure_create", {"title": "synthetic source identity transport"})
            csv_v1 = "condition,response\nA,20\nA,30\n"
            raw_v1_sha = hashlib.sha256(csv_v1.encode("utf-8")).hexdigest()
            made = client.call("figure_create_chart", {
                "doc": created["doc"], "chart_type": "bar", "data": {"csv": csv_v1}})
            changed_id = next(el["id"] for el in made["doc"]["elements"] if el["type"] == "chart")
            original = next(el for el in made["doc"]["elements"] if el["id"] == changed_id)
            original["chart"]["data"]["source_ref"] = "synthetic-v1.csv"
            original["chart"]["data"]["ref"] = "synthetic-v1.csv"
            original["chart"]["data"]["version"] = "v1"
            original["chart"]["data"]["raw_source_sha256"] = raw_v1_sha
            original["chart"]["data"]["source_info"].update({
                "locator": "synthetic-v1.csv", "file_name": "synthetic-v1.csv", "version": "v1"})
            other = json.loads(json.dumps(original))
            other["id"] = "same-original-unchanged"
            other["transform"] = {"x": 5, "y": 65, "w": 70, "h": 40}
            panel = {"id": "unrelated-panel", "type": "panel",
                     "transform": {"x": 90, "y": 5, "w": 10, "h": 10, "rotation": 0}}
            prepared = client.call("figure_apply_edits", {"doc": made["doc"], "ops": [
                {"op": "add_element", "element": other},
                {"op": "add_element", "element": panel}]})
            prepared_other = next(el for el in prepared["doc"]["elements"]
                                  if el["id"] == other["id"])
            prepared_panel = next(el for el in prepared["doc"]["elements"]
                                  if el["id"] == panel["id"])
            values_v2 = {"columns": ["condition", "response"], "rows": [["A", 20], ["A", 40]]}
            replaced = client.call("figure_apply_edits", {"doc": prepared["doc"], "ops": [{
                "op": "set_chart_data", "targets": [changed_id], "approved": True,
                "data": values_v2, "source_ref": "synthetic-v2.csv", "version": "v2"}]})
            chart = next(el for el in replaced["doc"]["elements"] if el["id"] == changed_id)["chart"]
            self.assertEqual(chart["data"]["raw_source_sha256"], "unknown")
            self.assertNotIn("source_info", chart["data"])
            self.assertRegex(chart["data"]["content_sha256"], r"^[0-9a-f]{64}$")
            self.assertNotEqual(chart["data"]["content_sha256"], raw_v1_sha)
            archived = chart["data_history"][0]["data"]
            self.assertEqual(archived["raw_source_sha256"], raw_v1_sha)
            self.assertEqual(archived["source_info"]["file_name"], "synthetic-v1.csv")
            self.assertEqual(archived["source_info"]["sha256"], raw_v1_sha)
            self.assertEqual(chart["data_history"][0]["data"]["inline"]["rows"][1][1], 30)
            self.assertEqual(next(el for el in replaced["doc"]["elements"]
                                  if el["id"] == other["id"]), prepared_other)
            self.assertEqual(next(el for el in replaced["doc"]["elements"]
                                  if el["id"] == panel["id"]), prepared_panel)
            report = client.call("figure_lineage", {"doc": replaced["doc"]})
            records = {record["element_id"]: record for record in report["charts"]}
            self.assertEqual(records[changed_id]["points"][0]["value"], 30)
            self.assertEqual(records[changed_id]["source"]["raw_source_sha256"], "unknown")
            self.assertEqual(records[changed_id]["value_comparison"]["status"], "not_recorded")
            self.assertEqual(records[other["id"]]["source"]["raw_source_sha256"], raw_v1_sha)
            self.assertEqual(records[other["id"]]["points"][0]["value"], 25)
            self.assertEqual(records[other["id"]]["value_comparison"]["status"], "match")
            self.assertTrue(any(issue["code"] == "RAW_SOURCE_SHA_UNKNOWN" and
                                issue["element_id"] == changed_id and
                                issue["severity"] == "warning" and
                                issue["verification"] == "not_verified"
                                for issue in report["issues"]))
            self.assertFalse(any(issue["code"] == "SOURCE_KEY_UNK" for issue in report["issues"]))
            raw_v2 = b"synthetic v2 raw bytes; no fixed example hash"
            raw_v2_sha = hashlib.sha256(raw_v2).hexdigest()
            verified = client.call("figure_apply_edits", {"doc": replaced["doc"], "ops": [{
                "op": "set_chart_data", "targets": [changed_id], "approved": True,
                "data": values_v2, "source_ref": "synthetic-v2.csv", "version": "v2",
                "raw_source_sha256": raw_v2_sha,
                "source_info": {"kind": "csv", "locator": "synthetic-v2.csv",
                                "file_name": "synthetic-v2.csv", "version": "v2",
                                "sha256": raw_v2_sha, "bytes": len(raw_v2)}}]})
            verified_chart = next(el for el in verified["doc"]["elements"]
                                  if el["id"] == changed_id)["chart"]
            self.assertEqual(verified_chart["data"]["raw_source_sha256"], raw_v2_sha)
            self.assertEqual(verified_chart["data"]["source_info"]["sha256"], raw_v2_sha)
            self.assertEqual(verified_chart["data_history"][-1]["data"]["raw_source_sha256"], "unknown")
            self.assertEqual(next(el for el in verified["doc"]["elements"]
                                  if el["id"] == other["id"]), prepared_other)
            verified_report = client.call("figure_lineage", {"doc": verified["doc"]})
            verified_record = next(record for record in verified_report["charts"]
                                   if record["element_id"] == changed_id)
            self.assertEqual(verified_record["source"]["raw_source_sha256"], raw_v2_sha)
            self.assertFalse(any(issue["code"] == "RAW_SOURCE_SHA_UNKNOWN" and
                                 issue["element_id"] == changed_id
                                 for issue in verified_report["issues"]))
            replace_rev = replaced["doc"]["history"][-1]["rev"]
            replace_base = replaced["doc"]["history"][-1]["base_rev"]
            reverted = client.call("figure_revert", {
                "doc": verified["doc"], "rev": replace_base})
            old_chart = next(el for el in reverted["doc"]["elements"]
                             if el["id"] == changed_id)["chart"]
            self.assertNotEqual(replace_rev, replace_base)
            self.assertFalse(old_chart.get("data_history"))
            self.assertEqual(old_chart["data"]["source_info"]["sha256"], raw_v1_sha)
            old_record = client.call("figure_lineage", {"doc": reverted["doc"],
                "lookup": {"element_id": changed_id, "source_row": 0}})
            self.assertEqual(old_record["lookup"]["matches"][0]["value"], 25)
            self.assertEqual(old_record["lookup"]["matches"][0]["raw_point"]["y"], 20)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
