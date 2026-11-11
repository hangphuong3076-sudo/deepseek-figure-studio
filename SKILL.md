---
name: figure-drawing
description: 科研绘图与改图技能（figure-drawing 完整插件包：skill + MCP 服务器 + 斜杠命令）。覆盖完整流程：导入 CSV/JSON/TSV 或 Excel → 工作表/表头预览 → 推荐模板 → 建图 → 建锚点 → 自然语言改图（EditOp）→ 审阅 → 导出 PNG/JPEG/TIFF/PDF/SVG；内置 28 套期刊/版式预设、43 套配色及 full/layout/unsupported 模板能力分级，文档模型为 figure-document（mm/pt 单位、可追溯历史、可回滚）。当用户要求"画图 / 作图 / 科研图 / 论文插图 / 按期刊要求排版 / 换配色 / 把标题移到左上等自然语言改图 / Excel 或 XLSX 导入 / 导出投稿格式（TIFF/PDF）"、或需要打开可视化双栏工作台（左编辑 SVG + 右 AI 对话）时使用。
---

# figure-drawing —— 科研绘图完整插件包技能

## 定位

本技能驱动本插件包内的 MCP 服务器（`mcp/server.py`，stdio JSON-RPC 2.0）。图形语义由 `mcp/bridge.js`（Node 桥）调用 `mcp/lib/` 内核完成。所有格式先生成同一内核 SVG；PDF 与栅格化由 `mcp/py/figraster.py` 调用 PyMuPDF，Pillow 只负责文件编码和尺寸/DPI 校验。整个插件文件夹自包含：拷到任何机器、任何目录都能独立运行，运行期不依赖框架仓库的任何路径。

- 工具清单唯一来源：`mcp/tools_spec.py`（`tools/list` 返回与之一致）
- 文档模型：figure-document（画布 mm、字号/线宽 pt；像素只在导出时按 `px = mm × dpi / 25.4` 计算）
- AI 的一切变更必须以 EditOp 数组经工具校验后应用，不得手改 `doc.elements`

## 实体—关系—来源—导出的可核验工作流

对用户提供或用户已明确提取的实体关系，使用 `figure_schematic`。合同使用 `{id,nodes,relations,sources,canvas?,layout?}`；不得用模板名臆造生物学，不把用户声明升级为已核实证据。节点 role 为 `question/method/evidence/conclusion`，shape/kind 等仅为通用图形声明；关系 source/target 必须有效，激活/时序用箭头，抑制用 T 端，include 为包含层级，associate 为并列线，不能用 direction 反转关系类型。

原始参数 builder 为 `mcp/lib/diagram.js` 的 `build(doc,spec)`、`supportsTemplate(tpl)` 与 `previewSVG(spec)`。提交使用 `apply_schematic`，同完整合同保持同一布局和元素 ID，提交时间仅进入历史/metadata；默认保留同语义节点的手工布局，明确要求 `auto_layout` 才重排。历史物化冻结首次元素 ID，普通 group/text 与动态 connector 可独立编辑，渲染按真实 bbox 更新关系而不是保留静态路径。

只有节点显式 `kind:"chart"` 或 `shape:"chart"` 才声明数据 slot，role/entity 绝不自动转数据。slot 保留原生 group、主体文字和虚线区域；随后 `figure_create_chart` 复用正常模板生成真实 chart 并填入区域。唯一 slot 可自动绑定；多 slot 必须同时给 `scene_id`、`node_id`，否则明确拒绝，slot 绑定与 `transform` 互斥。重新生成场景保留同 slot 的 chart/用户内容、稳定 element id 及完整数据/style；`meta.layout.resolution` 和历史物化保存可复现的新旧位置依据。

connector 在同节点同侧按稳定 connector id 分散：1 条取 50%，2 条以 25%/75% 为基准并最多偏移 12.5% 跟随真实方向，更多在距角至少 2mm（边长比例 10%–25%）的边带等距分布。自动折线与 renderer/audit 共用实际 points，箭头按端点切向绘制，不改变 source/target 或 activate/inhibit 的方向。全文档审计另报告普通 chart/panel 与实体的真实碰撞 bbox、面积和 slot 改绑路径；slot 内重叠只有显式声明才豁免。

用 `figure_lineage` 查节点、关系、图例相关来源，以及图表字段映射、零起始原始行号与图元 lookup。`set_chart_data` 仅在 `approved=true` 后替换 inline columns/rows，版本、原数据和 history 不可覆盖；mapping/style/旧统计声明不变，但统计、n、单位必须重新复核。用 `figure_export_bundle` 把 doc、四种导出、lineage 与 `result.json/manifest.json` 写入调用方指定的真实目录。完全保留 output_contract 的公开字段与 case_id；artifact 的 path/sha256、格式、DPI（位图）与 MediaBox（PDF）真实解码后才记录，未知扩展名、缺来源、不可读/不一致 hash 和失败导出保持 `partial`。无真实人类复核记录时 `human_review=null`，未知模型 id/config 同样为 `null`，没有自动视觉验收或官方评分。

合成调用示例（不是论文、固定案例或答案）：

```json
{"contract": {"id": "synthetic-demo", "nodes": [{"id": "q", "label": "合成问题", "role": "question", "evidence": ["note"]}, {"id": "m", "label": "合成方法", "role": "method", "evidence": ["note"]}], "relations": [{"id": "r", "source": "q", "target": "m", "kind": "sequence", "evidence": ["note"]}], "sources": [{"id": "note", "locator": "synthetic-note-v1", "version": "v1"}]}, "preview": true}
```

随后传 `doc`、`lookup` 或真实 `output_directory` 调用上述溯源/结果包工具。不要将 PDF 当背景截图，不执行来源脚本，不读正式 `current.figureproj.json`，不冒称完成官方三例。

## 何时触发

触发：

- 用户提供 CSV/JSON/TSV 或 .xlsx/.xlsm/.xls 工作簿，要求画柱状图、分组柱状图、折线图、散点图、箱线图、热图、火山图、ROC、生存曲线等科研图表；
- 要求画流程图 / 架构图 / 多面板复合主图；
- 要求"把标题移到左上""字号改 8pt""换成 NEJM 配色"之类的自然语言改图；
- 要求按期刊（Nature / Science / Cell / IEEE / Elsevier / ACS / PNAS…）栏宽、字号、分辨率排版；
- 要求导出投稿格式（TIFF / PDF / SVG 等）。

不触发：

- 只讨论"该用什么图"而不产出文件——先给建议，确认后再走本技能；
- 要求写 matplotlib / R 脚本本身——那是交付脚本，不是交付 figure-document；
- 纯文字排版、PPT 页面设计等与 figure-document 无关的工作。

## 前置条件

| 依赖 | 要求 | 检查命令 |
|---|---|---|
| Python | 3.13（标准库即可启动 MCP 服务） | `python --version` |
| PyMuPDF | 必需（服务端 PDF/栅格化，本机实测 1.27.2.2） | `python -c "import fitz; print(fitz.VersionBind)"` |
| Pillow | 11.x（PNG/JPEG/TIFF 编码与尺寸/DPI 校验，不承担科学映射） | `python -c "import PIL; print(PIL.__version__)"` |
| openpyxl | 3.1.x，本机实测 3.1.5（.xlsx/.xlsm 只读导入） | `python -c "import openpyxl; print(openpyxl.__version__)"` |
| xlrd | 2.x，本机实测 2.0.2（旧 .xls BIFF 存储值读取） | `python -c "import xlrd; print(xlrd.__version__)"` |
| Node.js | 22.x（`mcp/bridge.js` 必需；桥不联网） | `node --version` |
| DeepSeek key | 可选。未设置时审阅类功能回退到确定性规则（`mode:"fallback"`），功能不中断 | 环境变量 `DEEPSEEK_API_KEY` |

## 七步标准工作流

| 步骤 | MCP 工具 | 产出 / 要点 |
|---|---|---|
| 1. 打开数据 | `figure_open_data` | `data`（工作簿）/ `columns` / `stats` / `recommended`；入参 `csv`、`json`、`path`、`xlsx_base64` 四选一且禁止混传；工作簿另传 `file_name`、`sheet`（或 `sheet_name`）和 1 起始 `header_row`，选择改变后重读 |
| 2. 选模板 | `figure_templates`（可按 category/chart_type 过滤）+ 步骤 1 的 `recommended` | 模板 id 形如 `tpl-bar-grouped`；把推荐理由转述给用户，模板由用户确认 |
| 3. 建图 | `figure_create`（建画布，可套期刊预设）→ `figure_create_chart` | 返回带 chart 元素的完整 doc；`warnings` 必须转述给用户 |
| 4. 建锚点 | `figure_add_anchor`（`figure_anchors` 查看） | 锚点是后续 `@锚点id` 定位的载体；`bbox_norm`(0–1) 与 `bbox_mm` 二选一 |
| 5. 自然语言改图 | 组装 `EditOp[]` → `figure_apply_edits` | 整批校验、整批应用（不部分应用）；核对返回 `applied` / `errors` |
| 6. 审阅 | `figure_check` → `figure_review` | `figure_check` 给结构告警；`figure_review` 无 key 时 `mode:"fallback"`，必须如实告知是规则回退意见 |
| 7. 导出 | `figure_render`（SVG 预览）/ `figure_export` | 格式 `png\|jpeg\|tiff\|pdf\|svg`；期刊位图建议用其 `dpi_recommended` |

辅助工具：`figure_schematic`（明确实体—关系合同）、`figure_lineage`（图元—来源回溯）、`figure_export_bundle`（SVG/PNG/PDF 与来源清单）、`figure_journals`（列期刊预设）、`figure_apply_journal`（套期刊）、`figure_recolor`（换配色）、`figure_place` / `figure_panel_layout`（定位与多面板）、`figure_history` / `figure_revert`（历史与回滚）、`figure_save_project` / `figure_load_project`（工程文件）、`figure_open_viewer`（人工复核查看器）。

示意图使用结构化 `{id,nodes,relations,sources,canvas?,layout?}`：节点必须明确 label/role，关系必须明确 source/target/kind；include 表示原生包含分组，associate 为无向并列线，activate/sequence 为箭头，inhibit 为 T 端。提交走 `apply_schematic` 历史事务，移动节点时动态 connector 按真实 bbox 重算；同语义节点默认保留手动布局，只有 `layout.auto_layout=true` 才显式重排。`set_chart_data` 只有用户显式 `approved=true` 才可替换 inline 数据，并要求 source_ref/version；mapping/style 和统计 metadata 不变，原始版本归档，缺 n 或单位时要求统计重审。

侧栏「实体关系」支持结构化 JSON、实体/关系/来源逐行编辑、不确定性、真实人工记录、隔离 FigRender 预览和历史提交。来源文字只是用户提供内容，不执行代码、不声称 verified。手动文本/层叠/颜色保持原生可编辑；不能用像素外观冒充来源正确性、论文复现、GUI 视觉验收或官方评分。

## 模板能力与科学坐标限制

60 个模板不是 60 种均已实现的真实图型。图表能力以当前 `FigData.supportsChartType(type)` / `supportedChartTypes` 为准，不手写另一套支持清单。当前为 **27 `full` / 12 `layout` / 21 `unsupported`**；示意图另由 `FigDiagram.supportsTemplate` 的真实 builder 判定，只有 `tpl-diagram-flow`、`tpl-diagram-arch`、`tpl-diagram-pipeline`、`tpl-graphical-abstract` 支持原始参数生成，其他示意图仍为 `unsupported`。

- `full`：图表可从有效数据与映射本地真实生成 SVG；无数据行或 render 异常是失败，不是占位成功。已支持的示意图 `full` 仅表示可用明确 `contract.nodes/relations/sources` 生成原生可编辑矢量，`auto_generate=false`，不做数据自动关联或科学内容推断。四阶段 Graphical Abstract 内置标签仅为合成示例，不是论文、官方三例或评分结果。
- `layout`：**只创建复合空版式**，必须告诉用户不会自动填图，再逐面板提供数据与图表。
- `unsupported`：默认不推荐、图库默认隐藏；仅可预览示意图，明显标注且禁止应用。AI/MCP/`apply_template` 入口都必须实际校验，不能只禁用 UI。

ROC/PCA、火山图、生存曲线等未实现模板不表示会从原始数据计算 ROC/AUC、主成分、差异统计或生存模型；不要用列名映射或占位 SVG 假装这些统计已完成，也不要宣称 60 模板全部自动生成。

EIS Nyquist 只使用用户提供的 Z′ 和已经取负的 −Z″ 数值列，单位标签真实，横纵轴保持同一个 px/Ω 比例，非等比拉伸禁止；不擅自取负、改写原始行或做等效电路拟合。Bode 频率轴为 log10，非正值排除并明确报告数量。

服务端 MCP/HTTP 的所有格式都从 canonical `FigRender` SVG 生成：SVG 直出，PyMuPDF 生成矢量 PDF 并负责栅格化，Pillow 只编码/校验位图。`panel_id` 可参照一个 `type=panel` 或 `type=chart`：panel 仅包含目标及后代，范围含 transform/padding，top-left/top-right 标签向上扩 0.6mm + 一字号，below 标签扩 1.2 字号；chart 仅把完整 canonical SVG 的根 `width/height/viewBox` 裁成该 chart 的实际 mm 范围，不改源 doc/canvas/data/映射或图元坐标。其他 chart 的画幅外矢量可保留在 SVG，但最终 PNG/PDF 不得混入。未知 id、rect/group、重复 id 或不可见元素精确拒绝，不回退整图。默认文件名区分 `_panel-id` 与 `_chart-id`，MCP `px`、位图尺寸与 PDF 物理范围一致。透明 **only PNG**，只移除默认画布底色，不删除显式白色图元。浏览器本地 PDF 仍为栅格单页；旧 Pillow-only renderer 仅是旧 API 兼容，不是正式回退。

## Excel 工作簿导入

- `figure_open_data` 接受本机 .xlsx/.xlsm/.xls `path`，或真实工作簿 Base64 `xlsx_base64` + `file_name`；不支持 .xlsb。`sheet` / `sheet_name` 选择工作表，`header_row` 从 1 开始，改变后必须重新读取。返回遵守共同结构：`data:{columns,rows}`、`sheets`、`sheet_name`、`header_row`、`notices`、`source_info:{file_name,sha256,...}`，另有 `stats/recommended`。
- 后续 `figure_create_chart` 可将返回 `data` 原样放在 `data.inline`，也可直接在同一工具的 `data` 中传 `xlsx_base64/path` 及所选工作表、表头。数字和布尔值保持类型；只使用所选工作表的持久化 rows，不自动算术或重算公式。
- .xlsx/.xlsm 由 openpyxl 只读打开，不执行宏/公式、不加载外部工作簿链接。公式只取缓存；缺缓存置空，notices 显示实际单元格位置，最多列 50 个并报告余数。旧 .xls 由 xlrd 读取 BIFF 存储值，不能提供逐公式缓存缺失诊断。单文件最多 20 MiB，另限制工作表、行列、单元格与 XML 解压量。
- GUI 的「导入数据」在模板推荐前展示文件/工作表选择/表头行/刷新解析、notices、真实列统计及前几行；预览和重新解析不改 doc/history。用户确认后现有 `App.commit` 的 note 记录 file/sheet/header row/SHA-256。GUI 将实际文件字节分块转 Base64 发给本机 `POST /api/import-spreadsheet`，错误会明确说明需要正在运行的图工作台服务；preview 不请求模型、不传 API key。CSV/JSON/TSV 的本地 parse-modal 流程不变。**没有 XLSX 导出。**

SVG/HTML 静态导入必须遵循 **先 sanitize、后 rasterize**；不直接执行 HTML、嵌入活动 DOM 或加载远程资源。

## 关键调用示例（真实可复制）

协议：stdio 上一行一个 JSON-RPC 2.0 请求；`tools/call` 返回 `result.content[0].text`，是顶层含 `ok` 的 JSON 字符串；失败时 `ok:false` 且 `error` 为中文消息。单条命令示例（在插件根目录运行，`<doc>` 原样填入上一步返回的 doc 对象）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"figure_create","arguments":{"journal_id":"nature-single","title":"组间比较","dpi":300}}}' | python mcp/server.py
```

握手（每个会话一次）：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent","version":"1"}}}
```

1. 建画布（套 Nature 单栏预设 89×170mm）：

```json
{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"figure_create","arguments":{"journal_id":"nature-single","title":"组间比较","dpi":300}}}
```

2. 建图（`data` 使用单一 csv/json 文本源或 inline；工作簿使用 `figure_open_data` 返回的 `data` 作为 inline，或传 path/xlsx_base64 与选择项）：

```json
{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"figure_create_chart","arguments":{"doc":<doc>,"data":{"csv":"category,group,value,error,time,value2\nA,g1,11.270,0.568,2026-01-05,14.824\nA,g1,11.043,0.987,2026-01-12,12.697"},"template_id":"tpl-bar-grouped","journal_id":"nature-single","palette_id":"npg","transform":{"x":10,"y":12,"w":70,"h":60}}}}
```

3. 建锚点（之后可用 `@<锚点id>` 指代该区域）：

```json
{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"figure_add_anchor","arguments":{"doc":<doc>,"label":"(a) 主图","bbox_norm":{"x":0.06,"y":0.08,"w":0.6,"h":0.72},"note":"主论断：B 组均值显著高于 A 组"}}}
```

4. 自然语言改图（把用户指令解析成 EditOp[]；元素 id 以 doc 内实际 id 为准）：

```json
{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"figure_apply_edits","arguments":{"doc":<doc>,"ops":[{"op":"move","targets":["txt-title"],"x":6,"y":5,"reason":"标题移到左上角"},{"op":"set_style","targets":["txt-title"],"style":{"fontSizePt":8},"reason":"字号 8pt，高于 Nature 最小 5pt"}]}}}
```

5. 结构检查与审阅：

```json
{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"figure_check","arguments":{"doc":<doc>}}}
```

```json
{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"figure_review","arguments":{"doc":<doc>,"journal_id":"nature-single"}}}
```

6. 渲染 SVG 预览与导出（`out_path` 建议绝对路径）：

```json
{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"figure_render","arguments":{"doc":<doc>,"format":"svg"}}}
```

```json
{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"figure_export","arguments":{"doc":<doc>,"format":"tiff","dpi":300,"out_path":"out/fig1.tiff"}}}
```

7. 历史与回滚、工程文件：

```json
{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"figure_revert","arguments":{"doc":<doc>,"rev":2}}}
```

```json
{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"figure_save_project","arguments":{"doc":<doc>,"path":"out/fig1.figureproj.json"}}}
```

其余工具的入参/出参以 `tools/list` 返回的 inputSchema 为准。

## 最小合成 DEMO：从实体移动、来源回溯到真实导出

以下只是通用实体与虚构表格的 **DEMO**，没有论文、单位、官方三例或评分。图表替换中的 `approved:true` 只能由实际用户确认，DeepSeek 不得自行伪装授权。

```json
{"contract":{"id":"demo-flow","template":"flow","nodes":[{"id":"q","label":"DEMO question","role":"question","shape":"box","evidence":["s-demo"]},{"id":"m","label":"DEMO method","role":"method","shape":"process","evidence":["s-demo"]}],"relations":[{"id":"r","source":"q","target":"m","kind":"sequence","direction":"forward","evidence":["s-demo"]}],"sources":[{"id":"s-demo","locator":"DEMO synthetic narrative §1","version":"demo-v1","text":"Only synthetic user text; not a paper."}],"canvas":{"width_mm":120,"height_mm":60,"dpi":96}},"preview":true}
```

把该对象作为 `figure_schematic.arguments` 调用后：

1. 从返回 doc 确认实际 `q`、`m`、`r` 与来源，不把模板文案当科学结论；需要 Graphical Abstract 时另设 `template:"graphical_abstract"`，并明确提供 question/method/evidence/conclusion 四角色。
2. 调用 `figure_apply_edits`，`ops:[{"op":"move","targets":["q"],"dx":5,"dy":3}]`；重新 `figure_render`，普通节点的文字仍可编辑，connector 按新 bbox 生成而非残留静态路径。默认再次 `figure_schematic` 保留这个手动布局。
3. 调用 `figure_open_viewer({"doc":<doc>})` 人工检查。只有真实复核人完成检查后，才在合同 `human_review` 中记录 reviewer/checked_at/outcome/notes；自动 `not_recorded` 不得改写成“人类已通过”。
4. 替换已有 chart 时，实际用户批准后使用 `figure_apply_edits`，op 为 `{"op":"set_chart_data","targets":["<真实chart-id>"],"approved":true,"data":{"columns":["condition","response"],"rows":[["CONTROL",6],["TREATMENT",8]]},"source_ref":"DEMO-v2.csv","version":"v2"}`。保留 mapping/style/统计原声明；旧 rows 入 `data_history`，统计标为 required，inline 下标不冒称原文件行号。`figure_lineage` 的 `lookup` 再做实际字段/行反查。改变来源说明或外部对象本身绝不能更新已批准的 rows。
5. 用 `figure_export` 分别输出 `svg`、`png`、`pdf`；需要完整可追溯包时用 `figure_export_bundle`，明确 `output_directory`、实际 `input_source`、`case_id:"DEMO-not-official"` 与所需格式。检查真实文件、SHA-256、result/manifest 与解码结果；缺材料、非法形状、引用悬挂、转换失败必须分别保留失败状态，不能用预览占位代替成功。

## 端到端自测（安装后验证）

```bash
python mcp/selftest.py
python mcp/test_entity_relationships.py
(cd mcp && python -m unittest discover -v)
```

它真实拉起 `mcp/server.py`，执行科学合同、表征、历史、真实工作簿 bytes 与 PNG/JPEG/TIFF/PDF 等 MCP 回归，退出码 0 = 全部通过。Excel 另经随机端口 HTTP 与最小 DOM 运行真实导入 UI 函数，验证双工作表切换、表头重读、预览不提交、确认提交和失败不写历史；这是 DOM 级函数测试，不是完整 WebView 像素级 GUI 自动化。全程强制离线，工作簿只由 openpyxl 在内存生成，产物只写隔离临时目录并在结束后清理，不读取正式 current 工程。

## 单位与坐标约定

- 文档内一律 **mm**（位置、尺寸）与 **pt**（字号、线宽）。
- `bbox_norm` 是 0–1 归一化坐标（相对画布）；换算 `x_mm = norm.x × canvas.width_mm`。
- `transform` 的 x/y 是元素外接框**左上角**。

## 红线（不做的事）

1. **不伪造数据**：图表数据只来自用户提供的 csv/json/tsv、真实工作簿 path/bytes 或已解析 inline；缺失或列类型不明时向用户确认，公式缺缓存置空而非自动算术补齐。
2. **不冒充模型意见**：无 key 时审阅是 `mode:"fallback"` 的规则回退，汇报时必须如实说明。DSH 桥当前只支持文本聊天；review 依据结构化文档与规则，不支持附图时不宣称审美审阅。7 个 multimodal 单测仅用模拟 HTTP 核对真实消息格式与错误边界，未发真实模型请求，不能充当视觉 proof；视觉直连须另行实测用户模型与账号能力，不承诺真实账号已连接。
3. **不绕过 EditOp 直接改文档**：一切变更经工具校验应用，保证可追溯、可回滚。
4. **不泄露 key**：`DEEPSEEK_API_KEY` 不写入日志、返回值、导出文件；Node 桥不发起任何网络请求。
5. **不误称跨目录同步**：本 bundle 内核是独立扩展，不是其他工程目录的逐字节副本。修改必须同步本目录 API/加载顺序与回归，不把局部版本冒充整个框架版本。
6. **不承诺自动出版验收**：预设和自测不能证明科学数据真实性；投稿前核对目标期刊 Author Guidelines，并人工检查最终 PDF 的字体、科学表达和逐面板视觉效果。没有固定论文/白板时不得声称完成官方三例、金奖、分数或论文复现。
7. **不自动合并版本冲突**：条件保存携带 `base_token`；过期时接受 HTTP 409 / `save_conflict`，先导出本页备份，再刷新核对并手动合并，不承诺常驻同步自动合并。
