"""figpaths.py — 用户数据目录解析（R08：工程与插件代码分离）

职责（唯一事实来源，供 viewer.py / server.py / doctor.py / 启动脚本共用）：
  1. 解析用户数据目录 FIGURE_DATA_DIR：
     显式参数 > 环境变量 FIGURE_DATA_DIR > 平台默认目录。
     - Windows：%LOCALAPPDATA%\\DeepSeekFigureStudio
     - 其他平台：~/.local/share/DeepSeekFigureStudio（XDG_DATA_HOME 优先）
     绝不回退到插件目录——卸载/替换插件代码不删除用户工程。
  2. 目录布局：projects/ settings/ logs/ cache/（运行缓存与正式导出分开）。
  3. 旧目录探测与**显式**复制迁移：旧 mcp/projects 只探测并生成待迁移清单；
     迁移是独立动作（migrate_legacy），复制不移动、保留原文件、目标冲突不覆盖。
     迁移使用与正式装载同一套 docio 工程解码与完整性检查。

不做的事：不做自动迁移、不做文件监听、不做多客户端同步。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_DIR_NAME = "DeepSeekFigureStudio"
ENV_VAR = "FIGURE_DATA_DIR"

_SUBDIRS = ("projects", "settings", "logs", "cache")

# 插件目录 = 本文件上三级（mcp/py/figpaths.py -> mcp/py -> mcp -> 插件根）；
# 旧版工程目录嵌在 mcp/ 内（mcp/projects）。
PLUGIN_DIR = Path(__file__).resolve().parent.parent.parent
LEGACY_PROJECT_DIR = PLUGIN_DIR / "mcp" / "projects"
CURRENT_PROJECT_NAME = "current.figureproj.json"


def data_dir(explicit: str | os.PathLike | None = None) -> Path:
    """解析用户数据目录（不创建目录；创建见 ensure_layout）。

    优先级：explicit 参数 > 环境变量 FIGURE_DATA_DIR > 平台默认。
    """
    if explicit:
        p = Path(str(explicit)).expanduser()
        if not p.is_absolute():
            p = (Path.cwd() / p).resolve()
        return p
    env = os.environ.get(ENV_VAR, "").strip()
    if env:
        return Path(env).expanduser().resolve()
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIR_NAME
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "share"
    return base / APP_DIR_NAME


def ensure_layout(base: Path | None = None) -> Path:
    """创建 projects/settings/logs/cache 子目录，返回数据目录。"""
    root = Path(base) if base else data_dir()
    for name in _SUBDIRS:
        (root / name).mkdir(parents=True, exist_ok=True)
    return root


def project_dir(base: Path | None = None) -> Path:
    return (Path(base) if base else data_dir()) / "projects"


def current_project_path(base: Path | None = None) -> Path:
    return project_dir(base) / CURRENT_PROJECT_NAME


def settings_dir(base: Path | None = None) -> Path:
    return (Path(base) if base else data_dir()) / "settings"


def logs_dir(base: Path | None = None) -> Path:
    return (Path(base) if base else data_dir()) / "logs"


def cache_dir(base: Path | None = None) -> Path:
    return (Path(base) if base else data_dir()) / "cache"


# ---------------------------------------------------------------------------
# 旧目录探测与显式复制迁移
# ---------------------------------------------------------------------------

def legacy_project_dir() -> Path:
    """旧版内嵌工程目录（插件内 mcp/projects），仅探测，不再写入。"""
    return LEGACY_PROJECT_DIR


def _project_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(
        p for p in directory.glob("*.figureproj.json")
        if p.is_file()
    )


def legacy_migration_plan(base: Path | None = None) -> list[dict]:
    """生成待迁移清单（只读探测，不执行复制）。

    每项：{name, source, target, target_exists, conflict}
    conflict=True 表示目标已存在且内容不同（复制前必须让用户决定）。
    """
    target_root = project_dir(base)
    plan = []
    for src in _project_files(LEGACY_PROJECT_DIR):
        dst = target_root / src.name
        target_exists = dst.is_file()
        conflict = False
        if target_exists:
            try:
                conflict = dst.read_bytes() != src.read_bytes()
            except OSError:
                conflict = True  # 读不到就无法确认一致，按冲突处理
        plan.append({
            "name": src.name,
            "source": str(src),
            "target": str(dst),
            "target_exists": target_exists,
            "conflict": conflict,
        })
    return plan


def migrate_legacy(
    base: Path | None = None,
    overwrite: bool = False,
    docio=None,
) -> dict:
    """把旧 mcp/projects 下的工程**复制**到新数据目录（显式动作）。

    - 复制不移动：原文件完整保留；
    - 目标已存在且内容相同 → 跳过（kept_identical）；
    - 目标已存在且内容不同 → 默认跳过（conflict），overwrite=True 才覆盖，
      且覆盖前把现有目标备份为 <name>.bak-<n>.figureproj.json；
    - 迁移前用 docio.load_project 做同一套解码与完整性检查，失败列入
      invalid（不复制坏文件，不中断其余条目）。

    返回 {copied, skipped_identical, conflicts, invalid, plan}。
    """
    root = data_dir() if base is None else Path(base)
    ensure_layout(root)
    target_root = project_dir(root)
    result = {"copied": [], "skipped_identical": [], "conflicts": [], "invalid": [], "plan": []}
    for entry in legacy_migration_plan(root):
        result["plan"].append(entry)
        src = Path(entry["source"])
        dst = Path(entry["target"])
        if entry["conflict"] and not overwrite:
            result["conflicts"].append(entry)
            continue
        if entry["target_exists"] and not entry["conflict"]:
            result["skipped_identical"].append(entry)
            continue
        if docio is not None and callable(getattr(docio, "load_project", None)):
            try:
                docio.load_project(str(src))
            except Exception as exc:  # noqa: BLE001 — 坏工程如实列入 invalid
                result["invalid"].append({**entry, "error": str(exc)})
                continue
        if entry["conflict"] and overwrite and dst.is_file():
            n = 1
            backup = dst.with_name(dst.stem + ".bak-1" + dst.suffix)
            while backup.is_file():
                n += 1
                backup = dst.with_name(dst.stem + ".bak-%d" % n + dst.suffix)
            shutil.copy2(dst, backup)
        tmp = dst.with_suffix(dst.suffix + ".tmp-migrate")
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
        result["copied"].append(entry)
    return result


def status(base: Path | None = None) -> dict:
    """机器可读的状态摘要（doctor/启动诊断共用；不泄露任何密钥）。"""
    root = data_dir() if base is None else Path(base)
    legacy = legacy_project_dir()
    legacy_files = _project_files(legacy)
    return {
        "data_dir": str(root),
        "data_dir_env": ENV_VAR,
        "data_dir_env_set": bool(os.environ.get(ENV_VAR, "").strip()),
        "subdirs": {name: str(root / name) for name in _SUBDIRS},
        "current_project_path": str(current_project_path(root)),
        "current_project_exists": current_project_path(root).is_file(),
        "legacy_project_dir": str(legacy),
        "legacy_project_count": len(legacy_files),
        "legacy_pending_migration": [
            e for e in legacy_migration_plan(root)
            if not e["target_exists"]
        ],
    }


if __name__ == "__main__":  # pragma: no cover — 手动检查入口
    import json

    print(json.dumps(status(), ensure_ascii=False, indent=2))
