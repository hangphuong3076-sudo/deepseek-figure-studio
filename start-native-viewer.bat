@echo off
rem 一键打开「原生窗口」版科研绘图工作台（无需浏览器）。
rem 优先 pywebview 原生窗口，其次 Chrome/Edge --app 模式，最后默认浏览器。
cd /d "%~dp0"
where python >nul 2>nul || (
  echo [错误] 未找到 python，请先安装 Python 3.10+。
  pause
  exit /b 1
)
python mcp\native_viewer.py --serve --port 8770
if errorlevel 1 (
  echo [错误] 工作台启动失败，请按提示排查。
  pause
)
