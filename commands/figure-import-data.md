---
description: 从 CSV/JSON/Excel 数据建图（工作表/表头选择 → 推荐模板 → 生成图表元素 → 写入文档）
argument-hint: "<数据文件路径.csv|.json|.xlsx|.xlsm|.xls> [模板id] [配色id] [期刊id]"
---

# /figure-import-data — 由数据建图

## 用途

把用户的 CSV/JSON/TSV 或 Excel 数据变成图：解析数据 → 列统计 → 推荐模板 → 生成图表元素并写入文档。这是"给数据、出图"的主命令。

## 入参（来自 $ARGUMENTS）

1. `数据文件路径`（必填）：`.csv`、`.json`、`.tsv`、`.xlsx`、`.xlsm` 或 `.xls`，不支持 `.xlsb`。相对路径按当前工作目录解析，找不到时问用户要绝对路径。
2. `template_id`（可选）：如 `tpl-bar`、`tpl-bar-grouped`、`tpl-line`、`tpl-scatter`、`tpl-box`、`tpl-heatmap`。缺省用推荐第 1 个；`unsupported` 示意模板不能应用。
3. `palette_id`（可选）：配色，如 `npg`、`aaas`、`nejm`、`lancet`、`okabe-ito`、`viridis`。缺省由模板/期刊决定。
4. `journal_id`（可选）：期刊预设，影响字号与画布。

## 执行步骤

1. 调用 MCP 工具 `figure_open_data`（`{"path":"<绝对路径>"}`；CSV/JSON 文本也可分别用 `csv` / `json`）。工作簿另传 `sheet` 或 `sheet_name` 与 1 起始 `header_row`，得到 `data`（工作簿）、`columns`、`stats`、`recommended`、`notices` 与 `source_info`；
2. 多工作表工作簿先确认工作表与表头行；改变选择后用同一文件的 path 或原始工作簿 Base64 重读，只更新预览，不写文档或历史。转述公式缺缓存位置和其他 notices；
3. 把前 3 个推荐（`template_id` + 推荐理由）转述给用户；用户未指定模板时采用推荐第 1 个，并在回复中说明理由；
4. 若当前没有文档，先调用 `figure_create`（有期刊 id 则套用）；
5. 调用 MCP 工具 `figure_create_chart`。工作簿把步骤 1 的返回 `data` 原样放在 `data.inline`，或传入同一 `path` / `xlsx_base64` 及已选 `sheet` / `header_row`；文本使用 `data.csv` / `data.json`。其余参数为 `template_id`、可选 `palette_id` / `journal_id`；
6. 取返回的新 `doc` 为当前文档；把 `warnings`（含自动推断说明）完整转述给用户；
7. 建议顺手给图表区域调 `figure_add_anchor` 建锚点，便于后续"把 XX 移到 YY"式改图。

## 调用的工具

- MCP：`figure_open_data`、`figure_create`、`figure_create_chart`、`figure_add_anchor`（可选）

## 备注

- `figure_create_chart` 的 `data` 必须且只能含 `csv` / `json` / `inline` / `path` / `xlsx_base64` 一个源，禁止混传；工作簿应使用用户确认的工作表与表头 rows。
- .xlsx/.xlsm 使用 openpyxl、.xls 使用 xlrd；不执行宏/公式或加载外部工作簿，公式只取保存缓存，缺缓存用 null 而不是自动算术补齐。
- GUI 的 Excel 上传需要正在运行的图工作台服务；无需模型或 API key。CSV/JSON/TSV 仍走原解析流程。
- 数据列缺失、类型不明时向用户确认，不猜测填充；不伪造数据。
- 建图后可接 `/figure-export` 导出；没有 XLSX 导出能力。
