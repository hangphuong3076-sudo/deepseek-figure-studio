"""doctor.py — 安装与运行诊断（R08）

只做本地检查，不调用模型、不产生 API 费用、不输出密钥。
用法：
    python scripts/doctor.py            # 人读输出
    python scripts/doctor.py --json     # 机器可读输出（退出码 0=全部通过）

检查项（每项给出 ok 与具体下一步，不以“启动成功”概括）：
  python   实际解释器路径与版本
  node     Node 可执行路径与版本（Python 锁文件不证明 Node 已装）
  deps     PyMuPDF / Pillow / openpyxl / xlrd（导出与 Excel 必需）
  bridge   mcp/bridge.js 是否存在且语法可加载（node --check）
  viewer   viewer_static / presets 三件套 / lib 内核完整性
  window   窗口容器（pywebview → Chrome/Edge --app → 浏览器回退）
  datadir  用户数据目录、旧工程待迁移清单（figpaths）
  model    模型凭据状态：仅报告“已配置/未配置”与来源类别，不输出值
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mcp" / "py"))

REQUIRED_DEPS = [
    # (import 名, 用途说明)
    ("fitz", "PyMuPDF：矢量 PDF 与栅格化导出（必需）"),
    ("PIL", "Pillow：PNG/JPEG/TIFF 编码与尺寸/DPI 校验（必需）"),
    ("openpyxl", ".xlsx/.xlsm 只读导入（Excel 导入必需）"),
    ("xlrd", "旧 .xls 存储值读取（可选，仅 .xls 需要）"),
]
PRESET_FILES = ("journals.json", "templates.json", "palettes.json")
KERNEL_LIBS = ("figdoc.js", "ops.js", "presets.js", "data.js", "render.js", "ai.js")


def _run(cmd, timeout=15):
    try:
        p = subprocess.run(
            cmd, capture_output=True, timeout=timeout,
            encoding="utf-8", errors="replace",
            shell=sys.platform.startswith("win"))
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def check_python():
    ver = sys.version_info
    return {
        "ok": ver >= (3, 10),
        "path": sys.executable,
        "version": "%d.%d.%d" % (ver.major, ver.minor, ver.micro),
        "next_step": None if ver >= (3, 10) else
        "当前解释器版本过低；请使用 Python 3.10+（本机已验证环境为 3.13）",
    }


def check_node():
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        return {"ok": False, "path": None, "version": None,
                "next_step": "未找到 node：请安装 Node.js 22 系列（mcp/bridge.js 内核桥需要）"}
    code, out = _run("node --version")
    m = re.search(r"v(\d+)\.", out)
    major = int(m.group(1)) if m else 0
    return {
        "ok": code == 0 and major >= 18,
        "path": node,
        "version": out.strip(),
        "next_step": None if major >= 18 else
        "Node 主版本 %d 低于 18；请升级 Node.js（本机已验证 22.x）" % major,
    }


def check_deps():
    items = []
    for mod, why in REQUIRED_DEPS:
        try:
            m = __import__(mod)
            items.append({
                "module": mod, "ok": True, "version": getattr(m, "__version__", None)
                or (getattr(getattr(m, "__version__", None), "VersionBind", None) or "?"),
                "purpose": why, "next_step": None,
            })
        except Exception as exc:  # noqa: BLE001
            items.append({
                "module": mod, "ok": False, "version": None,
                "purpose": why,
                "next_step": "缺失 %s：%s。安装：python -m pip install %s"
                % (mod, exc, {"fitz": "PyMuPDF"}.get(mod, mod)),
            })
    return {"ok": all(i["ok"] for i in items), "items": items}


def check_bridge():
    bridge = ROOT / "mcp" / "bridge.js"
    if not bridge.is_file():
        return {"ok": False, "path": str(bridge),
                "next_step": "缺少 mcp/bridge.js：请核对插件目录完整性"}
    code, out = _run('node --check "%s"' % bridge)
    return {"ok": code == 0, "path": str(bridge),
            "next_step": None if code == 0 else "bridge.js 语法检查失败：%s" % out.strip()[:200]}


def check_viewer():
    problems = []
    static = ROOT / "mcp" / "viewer_static"
    if not (static / "index.html").is_file():
        problems.append("缺少 viewer_static/index.html")
    for name in KERNEL_LIBS:
        if not (ROOT / "mcp" / "lib" / name).is_file():
            problems.append("缺少内核 mcp/lib/%s" % name)
    for base in (ROOT / "mcp" / "presets", ROOT / "presets"):
        if all((base / f).is_file() for f in PRESET_FILES):
            return {"ok": True, "presets_dir": str(base),
                    "next_step": None}
        if (base / "journals.json").is_file():
            problems.append("预设目录 %s 缺少部分文件" % base)
    problems.append("未找到包含 %s 的预设目录" % "、".join(PRESET_FILES))
    return {"ok": False, "problems": problems,
            "next_step": "；".join(problems)}


def check_window():
    chain = []
    try:
        import webview  # noqa: F401
        chain.append({"container": "pywebview", "ok": True})
    except Exception:
        chain.append({"container": "pywebview", "ok": False,
                      "next_step": "可选：python -m pip install pywebview（原生窗口最佳体验）"})
    for name, exe in (("chrome", "chrome.exe"), ("msedge", "msedge.exe")):
        found = any(Path(p, exe).is_file() for p in os.environ.get("PATH", "").split(os.pathsep) if p)
        if not found:
            for cand in (r"C:\Program Files\Google\Chrome\Application",
                         r"C:\Program Files (x86)\Google\Chrome\Application",
                         r"C:\Program Files (x86)\Microsoft\Edge\Application",
                         r"C:\Program Files\Microsoft\Edge\Application"):
                if Path(cand, exe).is_file():
                    found = True
                    break
        chain.append({"container": name + " --app", "ok": found})
    return {"ok": any(c["ok"] for c in chain), "chain": chain,
            "next_step": None if any(c["ok"] for c in chain)
            else "未找到 pywebview/Chrome/Edge：将退回默认浏览器窗口"}


def check_datadir():
    try:
        import figpaths
        st = figpaths.status()
        return {
            "ok": True,
            "data_dir": st["data_dir"],
            "env_var": st["data_dir_env"],
            "env_set": st["data_dir_env_set"],
            "current_project_exists": st["current_project_exists"],
            "legacy_project_dir": st["legacy_project_dir"],
            "legacy_pending_migration": len(st["legacy_pending_migration"]),
            "next_step": None if not st["legacy_pending_migration"] else
            "旧目录有 %d 个工程待迁移；在工作台「历史」页显式复制迁移（保留原文件）"
            % len(st["legacy_pending_migration"]),
        }
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "next_step": "figpaths 不可用：%s" % exc}


def check_model():
    """只报告凭据是否配置与来源类别，绝不输出值。真实模型探测是独立显式动作。"""
    env_set = bool(os.environ.get("DEEPSEEK_API_KEY", "").strip())
    bridge = bool(os.environ.get("FIGURE_LLM_BRIDGE", "").strip())
    if env_set or bridge:
        source = "环境变量 DEEPSEEK_API_KEY" if env_set else "DSH llm 桥（FIGURE_LLM_BRIDGE）"
        return {"ok": True, "configured": True, "source": source,
                "next_step": None,
                "note": "凭据已配置；真实模型连通性需在工作台「设置」显式测试连接"}
    return {"ok": True, "configured": False, "source": None,
            "next_step": None,
            "note": "未配置模型凭据：手工编辑、导入与导出不受影响；审阅走离线规则"}


def collect():
    checks = {
        "python": check_python(),
        "node": check_node(),
        "deps": check_deps(),
        "bridge": check_bridge(),
        "viewer": check_viewer(),
        "window": check_window(),
        "datadir": check_datadir(),
        "model": check_model(),
    }
    return {
        "ok": all(c["ok"] for c in checks.values()),
        "checks": checks,
    }


_LABEL = {
    "python": "Python 解释器", "node": "Node 运行时", "deps": "导出/Excel 依赖",
    "bridge": "Node 内核桥", "viewer": "工作台与预设", "window": "窗口容器",
    "datadir": "用户数据目录", "model": "模型凭据（不外发请求）",
}


def print_human(report):
    print("== dsh-figure-studio 诊断 ==")
    for key, c in report["checks"].items():
        mark = "PASS" if c["ok"] else "FAIL"
        print("[%s] %s" % (mark, _LABEL[key]))
        for k, v in c.items():
            if k in ("ok", "next_step", "items", "chain", "problems"):
                continue
            print("    %s: %s" % (k, v))
        for item in c.get("items", []):
            status = "ok" if item["ok"] else "missing"
            print("    - %s: %s (%s)" % (item["module"], item.get("version") or "-", status))
        for link in c.get("chain", []):
            print("    - %s: %s" % (link["container"], "可用" if link["ok"] else "不可用"))
        for p in c.get("problems", []):
            print("    - %s" % p)
        if c.get("next_step"):
            print("    下一步：%s" % c["next_step"])
    print("总体：%s" % ("通过" if report["ok"] else "存在未通过项，见上方 FAIL"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="dsh-figure-studio 安装诊断")
    parser.add_argument("--json", action="store_true", help="机器可读 JSON 输出")
    args = parser.parse_args(argv)
    report = collect()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_human(report)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
