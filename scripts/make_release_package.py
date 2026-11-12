# -*- coding: utf-8 -*-
"""构建本地发布候选包（R09）。

白名单打包：只收明确允许的源文件/目录；排除 .venv、用户工程、密钥、
缓存、日志、测试输出、__pycache__、.git、index.js.orig-backup 等。
产物：dist/deepseek-figure-studio-1.1.0-rc1.zip + SHA-256。
许可未决（LICENSE 由权利人决定）已在包内 RELEASE-NOTES.md 记录。
运行：python scripts/make_release_package.py
"""
import hashlib
import json
import sys
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "dist"
NAME = "deepseek-figure-studio-1.1.0-rc1"

# 允许的顶层文件
TOP_FILES = [
    "package.json", "plugin.json", "cordis.patch.yml", "index.js", "client.js",
    "README.md", "INSTALL.md", "SKILL.md", "pyproject.toml", "uv.lock",
    "start-native-viewer.bat", "start-viewer.bat",
]
# 允许的目录（整目录收，内部再按扩展名/名称排除）
DIRS = [
    "mcp", "presets", "skills", "commands", "examples", "docs", "scripts",
]
# 目录内排除规则
EXCLUDE_DIRS = {"__pycache__", "projects", "node_modules", ".venv", ".git",
                "dist", ".pytest_cache"}
EXCLUDE_NAMES = {"index.js.orig-backup"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".bak"}

RELEASE_NOTES = """# 发布候选 {name}

日期：{date}。本包为本地可审查候选（RC1），未推送远程、未创建 Release。

## 内容
- 完整插件源代码（DSH bundle / MCP / 可视化工作台，同一核心）；
- 锁定依赖：pyproject.toml + uv.lock（Python）；Node 22 系列由系统安装；
- 三组教学示例（examples/teaching，合成演示数据，已标注 demo）；
- 优化状态矩阵与证据：docs/optimization/progress.md。

## 快速开始
1. python scripts/doctor.py        # 本地诊断（依赖/桥/预设/窗口/数据目录）
2. start-native-viewer.bat         # 打开可视化工作台（或 dsh plugin add 本目录）
3. 空文档任务卡三步开始；教学示例可直接打开
4. 回归：python -B mcp/selftest.py && python -B -m unittest discover -s mcp -p "test_*.py"

## 已验证（本地）
- selftest 142 PASS / 0 FAIL；unittest 133 OK（2026-11-12，Windows/Python 3.13.5/Node 22.19.0）
- C01/C02/C03 端到端（真实导出+独立解码）；A01-A07 内核级测试全过

## 未决项（须权利人/用户决定）
- 项目 LICENSE 类型与 PyMuPDF（AGPL/商业）分发方式；
- 完全离线安装包（Python/Node/wheels/WebView2 打包来源与体积）；
- Science 期刊官方页（HTTP 403）规则再核实；真实账号模型调用；
  原生窗口人工视觉复核；期刊合规人工核对。

## 用户数据
工程/设置/日志存于用户数据目录（FIGURE_DATA_DIR 可指定），不在本包内；
旧 mcp/projects 未包含在包内（迁移在目标机器上按提示显式执行）。
""".format(name=NAME, date=date.today().isoformat())


def iter_allowed():
    for name in TOP_FILES:
        p = ROOT / name
        if p.is_file():
            yield p
    for d in DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(ROOT)
            if any(part in EXCLUDE_DIRS for part in rel.parts):
                continue
            if p.name in EXCLUDE_NAMES or p.suffix in EXCLUDE_SUFFIXES:
                continue
            yield p


def main():
    OUT_DIR.mkdir(exist_ok=True)
    zip_path = OUT_DIR / (NAME + ".zip")
    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(NAME + "/RELEASE-NOTES.md", RELEASE_NOTES)
        for p in iter_allowed():
            zf.write(p, NAME + "/" + p.relative_to(ROOT).as_posix())
            count += 1
    digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    (OUT_DIR / (NAME + ".zip.sha256")).write_text(
        digest + "  " + zip_path.name + "\n", encoding="utf-8")
    print(json.dumps({
        "zip": str(zip_path), "files": count,
        "bytes": zip_path.stat().st_size, "sha256": digest,
    }, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
