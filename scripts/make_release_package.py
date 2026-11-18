# -*- coding: utf-8 -*-
"""在 Git 仓库中构建可分发的插件 ZIP。

白名单打包：只收明确允许的源文件/目录；排除 .venv、用户工程、密钥、
缓存、日志、测试输出、__pycache__、.git、index.js.orig-backup 等。
产物：dist/deepseek-figure-studio-<版本>.zip 和对应的 SHA-256 文件。
运行：python scripts/make_release_package.py
"""
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "dist"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
NAME = f"deepseek-figure-studio-{VERSION}"

# 发布所需的文件与目录
TOP_FILES = [
    "package.json", "plugin.json", "cordis.patch.yml", "index.js", "client.js",
    "llm-bridge.js",
    "README.md", "INSTALL.md", "SKILL.md", "pyproject.toml", "uv.lock",
    "start-native-viewer.bat", "start-viewer.bat",
    "docs/user-guide.md", "images/workbench.png",
]
DIRS = [
    "mcp", "presets", "skills", "commands", "examples", "docs/images/walkthrough", "scripts",
]
# 目录内排除规则
EXCLUDE_DIRS = {"__pycache__", "projects", "node_modules", ".venv", ".git",
                "dist", ".pytest_cache"}
EXCLUDE_NAMES = {"index.js.orig-backup"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".log", ".tmp", ".bak"}

RELEASE_NOTES = f"""# DeepSeek Figure Studio {VERSION}

## 安装与启动

1. 将 ZIP 完整解压到本地目录，准备 Python 3.10 或以上版本及 Node.js 22。
2. 在解压目录打开终端，按 [安装指南](INSTALL.md) 安装依赖。有 uv 时可执行 `uv sync --locked`。
3. Windows 用户双击 `start-viewer.bat` 打开工作台。使用 DeepSeek Harness 的用户可按安装指南注册插件。

[图文操作手册](docs/user-guide.md) 包含数据导入、手动调线宽、锚点框选与 AI 修改、组图和导出。
"""


def iter_allowed():
    tracked = subprocess.check_output(
        ["git", "ls-files", "-z", "--", *TOP_FILES, *DIRS], cwd=ROOT
    )
    for name in tracked.decode("utf-8").split("\0"):
        if not name:
            continue
        rel = Path(name)
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue
        if rel.name not in EXCLUDE_NAMES and rel.suffix not in EXCLUDE_SUFFIXES:
            yield ROOT / rel


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
