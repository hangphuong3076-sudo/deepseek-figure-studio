# -*- coding: utf-8 -*-
"""native_viewer.py — 把可视化工作台用「原生窗口」打开（不再依赖浏览器网页）。

对应需求：插件启动后内置一个工作台窗口，而不是让用户自己开浏览器访问 localhost。
参考 Tavotto 的做法：编辑器是一个原生桌面窗口，插件/agent 只负责起服务和 handoff。

用法：
  python native_viewer.py                        # 只开窗口，指向已运行的 http://127.0.0.1:8770/
  python native_viewer.py --port 8780            # 只开窗口，指向 8780
  python native_viewer.py --serve                # 先起 HTTP 服务，再开原生窗口（独立使用）
  python native_viewer.py --serve --no-window    # 只起服务不开窗口（headless 自测/CI）
  python native_viewer.py --url http://127.0.0.1:9999/   # 开窗口指向任意已运行 URL

窗口优先级（能出原生窗口就绝不落到浏览器网页）：
  1) pywebview —— 真原生窗口（Windows 用系统自带 WebView2 运行时，无地址栏/标签）
  2) Chrome / Edge 的 --app 模式 —— 无地址栏、无标签的独立应用窗口
  3) 默认浏览器（最后兜底，并明确打印提示）
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

DEFAULT_PORT = 8770
WINDOW_TITLE = "科研绘图工作台"


def _probe(url: str, timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _start_server(port: int) -> str:
    """复用 viewer.py 的 serve(port)，在后台线程起 HTTP 服务，返回就绪后的 URL。"""
    try:
        import viewer  # noqa: F401 —— 与 viewer.py 同目录
    except Exception as e:
        raise RuntimeError("无法导入 viewer.py：%s" % e)
    threading.Thread(target=viewer.serve, args=(port,), daemon=True).start()
    url = "http://127.0.0.1:%d/" % port
    for _ in range(40):
        if _probe(url):
            return url
        time.sleep(0.25)
    raise RuntimeError("工作台服务未能在 10 秒内就绪（端口 %d）" % port)


def _find_browser_exes():
    """Windows 常见 Chrome / Edge 路径。"""
    bases = [
        os.environ.get("PROGRAMFILES", r"C:\Program Files"),
        os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    names = [
        r"Microsoft\Edge\Application\msedge.exe",
        r"Google\Chrome\Application\chrome.exe",
        r"Google\Chrome SxS\Application\chrome.exe",
        r"Chromium\Application\chrome.exe",
    ]
    out = []
    for base in bases:
        for name in names:
            p = os.path.join(base, name)
            if p not in out and os.path.isfile(p):
                out.append(p)
    return out


def open_native_window(url: str, title: str = WINDOW_TITLE,
                       width: int = 1280, height: int = 860) -> str:
    """打开原生窗口；返回实际采用的方式名。"""
    # 1) pywebview（真原生窗口，WebView2）
    try:
        import webview
        webview.create_window(title, url, width=width, height=height, min_size=(960, 600))
        webview.start()
        return "pywebview"
    except Exception as e:
        print("[native_viewer] pywebview 不可用（%s），改用 app 模式窗口" % e, file=sys.stderr)

    # 2) Chrome / Edge --app（无地址栏、无标签的独立窗口）
    for exe in _find_browser_exes():
        try:
            subprocess.Popen([exe, "--app=%s" % url, "--new-window"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return "app-mode(%s)" % os.path.basename(exe)
        except Exception:
            continue

    # 3) 默认浏览器（兜底，明确提示这不是原生窗口）
    print("[native_viewer] 未找到 pywebview / Chrome / Edge，回退默认浏览器（网页）", file=sys.stderr)
    webbrowser.open(url)
    return "default-browser"


def main(argv=None):
    ap = argparse.ArgumentParser(description="原生窗口版科研绘图工作台")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口（默认 8770）")
    ap.add_argument("--url", default=None, help="已运行工作台 URL（缺省按 --port 拼）")
    ap.add_argument("--serve", action="store_true", help="先起 HTTP 服务再开窗口")
    ap.add_argument("--no-window", action="store_true", help="只起服务、不开窗口（headless 自测）")
    args = ap.parse_args(argv)

    url = args.url or ("http://127.0.0.1:%d/" % args.port)

    if args.serve:
        url = _start_server(args.port)
        print("[native_viewer] 服务已启动：%s" % url, file=sys.stderr)

    if args.no_window:
        print("[native_viewer] headless：工作台地址 %s" % url, file=sys.stderr)
        if args.serve:
            # 服务跑在 daemon 线程里，主线程保持存活即可持续对外服务。
            while True:
                time.sleep(3600)
        return 0

    how = open_native_window(url)
    print("[native_viewer] 已用「%s」打开 %s" % (how, url), file=sys.stderr)
    return 0


if __name__ == "__main__":
    main()
