@echo off
REM figure-drawing 可视化工作台一键启动（可传版本参数 A/B/C）
REM 用法：start-viewer.bat [A|B|C]   （默认 B=专业编辑）
REM   A=对话创作（AI 优先、简化工具栏） B=专业编辑（属性优先） C=投稿审阅（期刊/审阅优先）
chcp 65001 >nul
setlocal
set VARIANT=%~1
if "%VARIANT%"=="" set VARIANT=B
cd /d "%~dp0mcp"
echo 正在启动科研绘图工作台 %VARIANT% 版（http://127.0.0.1:8770/?variant=%VARIANT%）...
start "" "http://127.0.0.1:8770/?variant=%VARIANT%"
python viewer.py --port 8770
endlocal
