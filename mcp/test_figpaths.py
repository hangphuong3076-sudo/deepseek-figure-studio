"""test_figpaths.py — R08 用户数据目录与显式迁移回归

覆盖：
- 数据目录解析优先级（显式参数 > FIGURE_DATA_DIR > 平台默认），绝不回退插件目录；
- ensure_layout 目录布局；
- 旧目录迁移：复制不移动、原文件保留、内容相同跳过、冲突不覆盖；
- docio 完整性检查：坏工程列入 invalid，不复制、不中断其余条目；
- viewer.PROJECT_DIR 使用 figpaths（隔离环境变量下）。

全部使用临时目录；旧目录通过 monkeypatch 指向临时目录，不读取真实
mcp/projects 下用户工程。运行方式与既有套件一致：
    python -B -m unittest test_figpaths -v   （在 mcp/ 下）
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "py"))

import figpaths  # noqa: E402


def _write_project(path: Path, doc_id: str = "doc-1") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    project = {
        "format": "figure-project",
        "format_version": "1.0",
        "doc": {
            "schema_version": "1.0",
            "id": doc_id,
            "title": "test",
            "canvas": {"width_mm": 120, "height_mm": 90, "dpi": 300,
                       "background": "#FFFFFF"},
            "elements": [], "anchors": [], "panels": [], "history": [],
            "meta": {"created": "2026-01-01T00:00:00.000Z",
                     "updated": "2026-01-01T00:00:00.000Z"},
        },
        "history": [],
        "assets": {},
    }
    path.write_text(json.dumps(project, ensure_ascii=False), encoding="utf-8")


class _LegacySandbox:
    """把 figpaths.LEGACY_PROJECT_DIR 指向临时目录，保护真实用户工程。"""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.legacy = Path(self._tmp.name) / "legacy" / "projects"
        self.legacy.mkdir(parents=True)
        self._orig = figpaths.LEGACY_PROJECT_DIR
        figpaths.LEGACY_PROJECT_DIR = self.legacy
        return self

    def __exit__(self, *exc):
        figpaths.LEGACY_PROJECT_DIR = self._orig
        self._tmp.cleanup()
        return False


class TestDataDirResolution(unittest.TestCase):
    def test_explicit_argument_wins(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(figpaths.data_dir(td), Path(td))

    def test_env_var_second(self):
        with tempfile.TemporaryDirectory() as td:
            old = os.environ.get(figpaths.ENV_VAR)
            os.environ[figpaths.ENV_VAR] = td
            try:
                self.assertEqual(figpaths.data_dir(), Path(td).resolve())
            finally:
                if old is None:
                    os.environ.pop(figpaths.ENV_VAR, None)
                else:
                    os.environ[figpaths.ENV_VAR] = old

    def test_platform_default_is_outside_plugin(self):
        old = os.environ.pop(figpaths.ENV_VAR, None)
        try:
            base = figpaths.data_dir()
        finally:
            if old is not None:
                os.environ[figpaths.ENV_VAR] = old
        self.assertNotIn("deepseek-figure-bundle", str(base).lower().replace(
            "deepseek-figure-studio", ""))
        self.assertEqual(base.name, figpaths.APP_DIR_NAME)

    def test_ensure_layout(self):
        with tempfile.TemporaryDirectory() as td:
            root = figpaths.ensure_layout(Path(td))
            for sub in ("projects", "settings", "logs", "cache"):
                self.assertTrue((root / sub).is_dir(), sub)


class TestLegacyMigration(unittest.TestCase):
    def test_copy_keeps_original_and_skips_identical(self):
        with _LegacySandbox() as sandbox, tempfile.TemporaryDirectory() as td:
            src = sandbox.legacy / "current.figureproj.json"
            _write_project(src)
            res = figpaths.migrate_legacy(td)
            self.assertEqual(len(res["copied"]), 1)
            self.assertTrue(src.is_file(), "原文件必须保留（复制不移动）")
            dst = Path(td) / "projects" / "current.figureproj.json"
            self.assertTrue(dst.is_file())
            self.assertEqual(dst.read_bytes(), src.read_bytes())
            # 再次迁移：内容相同 → 跳过，不重复复制
            res2 = figpaths.migrate_legacy(td)
            self.assertEqual(res2["copied"], [])
            self.assertEqual(len(res2["skipped_identical"]), 1)

    def test_conflict_not_overwritten_by_default(self):
        with _LegacySandbox() as sandbox, tempfile.TemporaryDirectory() as td:
            src = sandbox.legacy / "a.figureproj.json"
            _write_project(src, "doc-legacy")
            dst = Path(td) / "projects" / "a.figureproj.json"
            _write_project(dst, "doc-new")
            new_bytes = dst.read_bytes()
            res = figpaths.migrate_legacy(td)
            self.assertEqual(res["copied"], [])
            self.assertEqual(len(res["conflicts"]), 1)
            self.assertEqual(dst.read_bytes(), new_bytes, "冲突时不得覆盖")

    def test_conflict_overwrite_backs_up(self):
        with _LegacySandbox() as sandbox, tempfile.TemporaryDirectory() as td:
            src = sandbox.legacy / "a.figureproj.json"
            _write_project(src, "doc-legacy")
            dst = Path(td) / "projects" / "a.figureproj.json"
            _write_project(dst, "doc-new")
            res = figpaths.migrate_legacy(td, overwrite=True)
            self.assertEqual(len(res["copied"]), 1)
            backups = list((Path(td) / "projects").glob("*.bak-*.json"))
            self.assertEqual(len(backups), 1, "覆盖前必须备份现有目标")

    def test_invalid_project_rejected_others_continue(self):
        with _LegacySandbox() as sandbox, tempfile.TemporaryDirectory() as td:
            (sandbox.legacy / "bad.figureproj.json").write_text(
                "{ not json", encoding="utf-8")
            _write_project(sandbox.legacy / "good.figureproj.json")
            res = figpaths.migrate_legacy(td, docio=__import__("docio"))
            self.assertEqual(len(res["invalid"]), 1)
            self.assertEqual(len(res["copied"]), 1)
            self.assertFalse((Path(td) / "projects" / "bad.figureproj.json").exists())

    def test_plan_is_read_only(self):
        with _LegacySandbox() as sandbox, tempfile.TemporaryDirectory() as td:
            _write_project(sandbox.legacy / "a.figureproj.json")
            plan = figpaths.legacy_migration_plan(td)
            self.assertEqual(len(plan), 1)
            self.assertEqual(plan[0]["name"], "a.figureproj.json")
            self.assertFalse(plan[0]["target_exists"])
            self.assertFalse((Path(td) / "projects" / "a.figureproj.json").exists(),
                             "探测不得产生复制副作用")


class TestViewerWiring(unittest.TestCase):
    def test_viewer_project_dir_follows_figpaths(self):
        import viewer
        # viewer.PROJECT_DIR 必须等于 figpaths.project_dir()（同一模块级解析）
        self.assertEqual(str(viewer.PROJECT_DIR),
                         str(figpaths.project_dir(viewer.PROJECT_DIR.parent)))


if __name__ == "__main__":
    unittest.main()
