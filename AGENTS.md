# 开发备忘

- 标准测试（在本目录）：`python -B mcp/selftest.py`；`python -B -m unittest discover -s mcp -p "test*.py"`。
- 单跑 UI 测试要先 `cd mcp`（`mcp` 不是 Python 包）：`python -B -m unittest test_wizard_ui -v`。没装 Playwright 会自动跳过。
- JS 语法检查：`node --check mcp/viewer_static/app/<文件>.js`。
- 改 `mcp/lib/*.js` 里的中文提示前，先在 `selftest.py`、`tools_spec.py`、`tools.json`、`test_*.py` 里搜原措辞；有断言就保留关键词（例如「不自动填图」）。
- 隔离实例：`FIGURE_DATA_DIR` 设成临时的 Windows 路径后 `python -B mcp\viewer.py --port 8791`；不要用 8770/8771（用户正在用的服务）。
- 启动前清掉环境变量 `ELECTRON_RUN_AS_NODE`。
- `docs/optimization/` 与 `dist/` 不提交。
- 全量 `unittest discover` 约 450 项、约 10 分钟；只在最后跑一次。
- 画布标签页：活动标签 = `projects/current.figureproj.json`，其余在 `projects/tabs/`（`index.json` + 每个文档一份），关闭的移到 `tabs/closed/`。
- 散点紧凑显示只用于画布（`compactMarks:true` 只由 `editor.js` 传入）；导出必须逐点。
- 取证拼图脚本在 `docs/optimization/shot_scripts/`（不提交）；拼图前确认文档画布能完整包住图表元素（默认图表 transform 是 (10,10) 起 120×90 mm）。
- 示意图质量门禁：`python -B -m unittest test_diagram_r9 -v`（模板 × 主题：对比度、徽标压字、越界、连线穿节点）。
- 模板能力计数（selftest、test_schematic_mcp、test_templates_r7 有断言）：增删模板后同步更新。
