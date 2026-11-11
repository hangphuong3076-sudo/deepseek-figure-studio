# dsh-figure-studio — 科研绘图完整插件（DeepSeek Harness 官方 bundle）

按 **DeepSeek Harness 官方插件规范**打包的绘图插件：`package.json`（`dsh.bundle` + `dsh.client`）+
`cordis.patch.yml` + `index.js`（Host 插件）+ `client.js`（浏览器半）。用户给 CSV/JSON/TSV 或 Excel 数据，agent
完成建图、自然语言改图、按期刊预设排版、导出 PNG/JPEG/TIFF/PDF/SVG，全部 26 个 `figure_*` 工具
直接注册进 DSH 的 tool registry。**同时保留**通用 MCP 服务器 + 斜杠命令 + 可视化工作台，可独立运行。

> 安装：`dsh plugin --profile demo add ./deepseek-figure-bundle`（详见 `INSTALL.md`「路线 A」）。

本插件**自带可视化双栏工作台**（`mcp/viewer.py` + `mcp/viewer_static/`）：**左边是可拖拽/编辑的 SVG 画布，右边是 AI 对话面板**（自然语言改图 + AI 审阅 + 锚点/图层/属性/模板/期刊/历史/工程 9 个标签页），类 Illustrator 的直接操作（点选/框选/拖动/缩放/旋转/编组/对齐/文字/图片）。启动方式见下文「可视化工作台」。

## 科学论证工作流

在「论证」标签页先填写整图的科学问题、图级结论和反证条件，再为每个面板填写证据角色、决定性比较、独立推断增益与目的地。面板按 a、b、c… 的阅读顺序组织，但不机械分配 a=示意、d=验证；主图由关键证据决定。所有声明经 `set_scientific_contract` 写入历史和工程，可撤销恢复。

柱图/分组柱图可根据重复观测计算 SD、SEM、95CI、范围，或读取用户明确申明的误差列；单位、n 的定义、检验、校正方式、比较对象和来源文件均可申报。审计和 AI 审阅会把缺失信息标出，不会从图形推断统计显著性或自行补造结论。「物理尺寸预览」以 96 CSS px/in 临时显示最终尺寸，不改变稿件内容。

参考 `nature-skills/nature-figure` 的 figure contract、multi-panel evidence architecture 与 QA contract；它们是方法指南，不等同于 Nature 官方投稿硬性规则。自动审计与自测不能证明原始数据真实性，也不能取代最终 PDF 的逐面板人工检查；字体显示、科学表达和视觉质量仍需人工校对。

配套接口：`figure_scientific_contract`（查询/保存）、`figure_scientific_audit`（审计）。误差线的原生渲染当前覆盖 `bar`、`bar_grouped`，其余类型不会在无法验证时标为已通过。

## 实体关系、数据映射与可审计结果包

`figure_schematic` 接受明确 `{id,nodes,relations,sources,canvas?,layout?}` 合同，生成原生 group、rect/ellipse/text 和动态 connector。节点 role、label、shape/kind、颜色与关系方向经合同编辑；只有显式 `kind:'chart'` 或 `shape:'chart'` 才声明数据 slot，不按 role 猜实体为图表。slot 保留原生主体和虚线数据区，随后 `figure_create_chart` 唯一自动绑定或多 slot 以 `scene_id/node_id` 明确绑定真实模板 chart，不再放入满画板默认 panel；场景重建保留同 slot chart、用户内容和稳定 id。关系支持激活箭头、抑制 T、包含层级、并列线和顺序箭头。连接线每次渲染按节点真实 bbox 和父 panel frame 重算，同侧多连接按稳定 connector id 分散端点，不把固定路径残留冒充可编辑图形。相同合同使用确定性元素 ID 与布局和真实提交时间；时间不进入图形几何。默认保留同语义节点的手动位置；只有明确 `auto_layout` 才重排，新计算位置、旧位置和采用依据保存在 `meta.layout.resolution` 与物化历史。完整合同、`layout/source_sha256`、物化元素及历史可长期回溯和重放。`auditLayout` 另给普通 chart/panel 与实体遮挡的实际相交区域和改善路径，不把 chart 内部每个图元当成独立碰撞。

`figure_lineage` 查询实体与关系的来源，以及普通 chart 的字段映射、原始数据零起始行号与图元的双向 lookup；不支持的类型明确报告覆盖限制。`set_chart_data` 只有 `approved=true` 才可替换内联数据，原数据、版本及完整 raw source 身份保存在 `chart.data_history` 和完整历史中；未提供合格的新 raw SHA/source_info 时当前 SHA 明确为 unknown，绝不沿用旧文件或 inline 内容哈希；显式提供并经格式、字段一致性校验的来源声明可保留，包括明确仍适用同一 raw 文件的分支。locator/version 冲突按值给出 chart 定位 warning，unknown 保持未验证检查项。mapping/style/既有统计声明不变，替换后仍强制复核统计定义、n 和单位，不因沿用了旧声明就视为有效。

`figure_export_bundle` 需要明确的实际 `output_directory`，保留输入 `output_contract` 的公开字段，交付工程、真实 SVG/PNG/PDF/TIFF、lineage 及含 `case_id/source/uncertainty/changes/checks/artifacts` 的 `result.json`。文件有实际 SHA-256；位图/DPI 由解码器复核，PDF 校验 MediaBox。目录错误、未知扩展名、缺来源、hash 不匹配与导出失败均为诚实 `partial`，不提前写成功。未明确提供模型 id/config 或人类复核时为 `null`，不把环境变量、自动检查或 DeepSeek 调用冒称为实际视觉验收。

当前没有挑战固定论文、固定白板或官方三例结果。接口默认只处理用户提供的来源文字、实体及数据，缺少材料不猜测生物学，不执行来源中的代码；旧 `figure_export` 的输出目录约定和行为不变。

## 表征模板的使用

在模板页选择「表征」筛选。导入数据后，检测到的结合能/拉曼位移列也可用于推荐相应模板，但只按列名推断测量形式，不推断元素或峰的归属。

- **XPS 全谱**：需要结合能列和强度列，默认高结合能在左。
- **XPS 高分辨**：原始强度之外，可带来的总拟合、基线、组分曲线列。**这些拟合结果必须由用户或外部分析软件提供，本插件不自己拟合**。缺少拟合列时会明确提示，可在「属性 → 表征图表参数」中补选列、增加峰标注。
- **Raman**：需要拉曼位移和强度列；多样品比较可通过分组列区分样品。归一化只有在模板或用户明确选择后才执行；叠加偏移只改变视觉位置，不代表真实强度差。
- **普通编辑**：修改表征参数统一经 `set_chart_properties` 提交，保留一条可撤销历史，并确保 chartType 和原始数据行不被替换。

`nature-figure` 的正式模板目录没有现成的 XPS/Raman 模板可照搬；本次表征实现沿用其真实 CSV、数据来源记录及最终尺寸审查原则，而非声称这些谱图来自该模板库。

## 模板能力表（第五阶段）

60 个模板不是 60 种真实渲染器。数据图按 `FigData` 的实际 renderer 判定，示意图按 `FigDiagram.supportsTemplate` 的真实 builder 判定。泛化模板名不能代替原始 nodes/relations/sources；旧 `apply_template` 默认行为不变，只有显式 `opts.schematic` 才生成示意图。

| 能力 | 数量 | 含义与使用规则 |
|---|---:|---|
| `full` | 27 | 23 个真实数据图/表征模板，加 4 个只接受原始实体关系合同的示意图模板；后者 `auto_generate=false`，不推断科学内容 |
| `layout` | 12 | 只创建复合空版式，不自动填图 |
| `unsupported` | 21 | 仅保留示意预览或缺少明确合同；默认不推荐、隐藏，禁止应用为真实导出 |

AI、模板调用及 `apply_template` EditOp 也必须经过同一能力校验，不能只依赖按钮的 `disabled` 状态。尤其 ROC/PCA 等模板的存在**不表示**插件会从真值+得分计算 ROC/AUC，或从高维矩阵计算主成分；本阶段不会用映射列名假装完成这些统计计算。真实原生图型数量与模板数量不是一回事；`full` 的 27 个模板中，多项是同一原生图型的科学坐标/表征参数派生。

EIS Nyquist 使用用户提供的 Z′ 与**已取负的** −Z″ 列，按真实单位标注坐标；横纵轴采用相同 px/Ω 比例，较窄方向只扩展显示数据域，不非等比拉伸数据。原始 CSV 行不被取负以外的后处理、等比换算或拟合改写，插件也不擅自做等效电路拟合。Bode 频率轴使用 log10；非正频率不计入并明确提示排除数。

## 特性

- **SVG 逐元素导入**：图形/文本/路径/分组分别成为可编辑图元；支持移动、改色、改字号、图层与历史，默认清理脚本、事件属性和外部引用；复杂滤镜等会明确提示简化；
- **可调整双栏与淡蓝工作区**：拖动中间分隔手柄改变左右宽度，重开保持，支持键盘方向键与双击复位；工作区使用淡蓝色，文档纸面仍保持白色；
- **图表拆分为图元**：选中图表后点「拆为图元」，柱子、坐标轴、文字、图例分别可编辑；原始 spec/data 保存在新分组的 `source_chart` 中，可撤销完整恢复；

- **期刊预设**：28 套（Nature / Science / Cell / IEEE / Elsevier / ACS / PNAS / 学位论文 / 海报 / 幻灯…），自动设定栏宽画布、基准字号、推荐 DPI；
- **模板推荐与能力标注**：60 个模板概念/表征/复合模板，不是 60 种真实渲染器。按 FigData/真实 FigDiagram builder 分为 27 `full`、12 `layout`、21 `unsupported`；示意图原始参数不会自动关联数据；默认推荐与展示排除 unsupported，空版式明确“不自动填图”，unsupported 只能预览且禁止应用；可按「表征」筛选，按数据列名推荐；
- **表征绘图**：XPS 全谱/高分辨拟合/双区域，Raman 单谱/多谱，XRD、FTIR、UV–Vis/PL、NMR、EIS、CV、应力应变、粒径分布。支持真实轴方向与单位、用户拟合/基线/组分曲线、峰标注、声明式归一化与叠加偏移、log10 守卫；曲线都由真实 CSV 列绘制，原始行不因归一化、偏移或参数修改而改变；
- **配色**：43 套（期刊 / ColorBrewer / Okabe-Ito / Paul Tol / viridis…），提供真实色块预览和分类浏览，支持 `byOrder/byHue/byRole` 重着色；
- **自然语言改图**：一切变更以 EditOp 数组经校验后应用，整批应用、可追溯、可回滚（`figure_history` / `figure_revert`）；
- **编号选框定位**：用「锚点」工具连续框选多个区域，自动在 AI 输入框追加 `[1]`、`[2]`，已经输入指令也不会吞掉后续编号；输入“把1的字号改成 8pt、把2移到右上”会精确路由到对应局部，支持联合指令与清除引用；
- **常驻 AI 对话区**：右栏下半部分固定显示 AI，可自然语言讨论当前图形、局部修改与审阅；上半栏继续保留工具与属性。上下高度可拖动并保存。不是新建 DSH agent 会话；
- **右键发送给 AI**：在画布上选中元素或框选区域后，右键选择「发送给 AI」，会创建/复用对应原生锚点，并在下栏追加编号及坐标，不重复生成历史；
- **AI 阶段进度**：收集文档、等待模型、流式返回及拆分为待应用操作时显示真实阶段与字符/增量数，失败显示原因；点击“应用”才提交修改，不把生成预览误写成已完成；
- **自定义画布**：设置中直接输入宽高（mm），可等比调整现有图形与编号选框，原始数据、字号 pt 和 DPI 不变；也可只调整画布、保留原布局；
- **AI 零 key（DSH 内，工具 + 窗口）**：复用 DSH 的 `ctx.llm` 与本机 `llm 桥`，当前桥是**文本聊天**路径，不转换附图；
  `figure_review` 依据结构化文档和规则生成意见，不把不支持附图的文本审阅冒称为视觉/审美验收。
  现有 7 个 multimodal 单测只验证模拟 HTTP 的消息角色、`image_url` 结构、PNG/JPEG 校验和错误分支，**未发送真实模型请求，不能作为视觉质量或真实账号多模态能力证明**。视觉直连仍须用用户实际模型与账号另测；
  独立窗口/MCP 可配置 key 或 `proxyUrl`，无 key 时明确回退到离线规则；
- **统一导出链与范围**：服务端 MCP/HTTP 的 SVG/PNG/JPEG/TIFF/PDF 都以同一份 canonical `FigRender` SVG 为唯一真源；SVG 直接输出，PDF 与栅格化由 PyMuPDF 完成（PDF 保留矢量路径，浏览器本地 PDF 回退仍是栅格单页）。
  Pillow 只负责位图编码与尺寸/DPI 校验。位图/PDF 导出需要 PyMuPDF 与 Pillow，本机实测 PyMuPDF 1.27.2.2；
  依赖见 `INSTALL.md`。TIFF 写 282/283 标签，PDF MediaBox 来自导出范围的 mm→pt。
  `panel_id` 可参照一个 `type=panel` 或 `type=chart` 元素。panel 导出只含该 panel 及后代，范围含完整 transform 与 padding，不带画布 bleed；top-left/top-right 外置标签向上扩 0.6mm + 一个标签字号，below 标签向下扩 1.2 个字号。chart 子图导出复用完整 canonical SVG，仅修改根 `width/height/viewBox` 为该 chart 的实际 mm 范围，不改源 doc、canvas、data、映射或图元坐标；画幅外矢量可以保留在 SVG 中，但 PNG/PDF 最终画幅不得混入另一 chart。
  未知 id、`rect`/`group` 等其他类型、重复 id 或不可见元素均精确拒绝，不回退整图。默认文件名区分 `_panel-id` 与 `_chart-id`，MCP `px` 与 PNG 尺寸均从裁后物理 root 计算，PDF MediaBox 使用相同范围。**透明仅用于 PNG**，只去默认画布底色，保留显式白色图元；其他格式不会暗中改成透明。未绑定数据、未知图型或真实渲染异常必须导出失败，不再以“需 v2”占位图报告成功。
  自动检查不等于数据真实性、字体或视觉出版验收；
- **Excel 工作簿真实导入**：「导入数据」真实接受 .xlsx/.xlsm/.xls（不支持 .xlsb）；GUI 用 `File.arrayBuffer` 或 `readAsArrayBuffer` 分块转 Base64，POST 到本机 `POST /api/import-spreadsheet`，不把二进制交给 CSV parser。先在模板推荐前显示文件名、工作表、1 起始表头行、列统计、前几行和 notices；切换工作表/表头重读只更新预览，不写画布或历史。用户确认后经现有 `App.commit` 一次导入，note 记录文件名、工作表、表头行和 SHA-256，绘图使用已选 rows。
  .xlsx/.xlsm 由 openpyxl 只读打开且不加载外部链接，.xls 由 xlrd 读取 BIFF 存储值；数字和布尔值保持类型。**不执行宏或公式**，OOXML 公式只取保存的缓存，缺缓存置空并在 notices 中给出单元格位置（超过 50 个才截断）；旧 .xls 无法提供逐公式缓存诊断，不隐瞒这一边界。无需模型或 API key，单工作簿限 20 MiB，并限制行列/单元格和 XML 解压资源。**没有 XLSX 导出能力**。
- **静态导入边界**：SVG 静态置入是“先 sanitize，再 rasterize 为 PNG”，不把原始标记挂到活动 DOM。
  若引入 HTML 静态导入，也必须沿用“先 sanitize、后 rasterize”的隔离链，HTML 不得直接执行或作为活动 DOM/远程资源嵌入。
  旧 Pillow-only renderer 仅为显式调用旧 `document-to-image` API 的兼容保留，其有限图型和占位输出不属于 canonical SVG 能力表，也不是正式导出的回退。
- **自包含**：`mcp/lib/`（JS 内核）、`mcp/py/`（光栅器 + 工程读写）、`presets/` 与全部编辑器功能均打包在插件内，拷走即用；无需从网络下载模板或图片资源。

## 目录结构

```
deepseek-figure-bundle/
├── package.json            # DSH bundle 清单：dsh.bundle.patch + dsh.client + engines.dsh
├── cordis.patch.yml        # 插入 figure-studio 插件行（viewerPort 等配置）
├── index.js                # Host 插件：注册 26 个 figure_* 工具 → 转发 Python 后端
├── client.js               # Client 浏览器半（脚手架：设置卡 + 插件页 section）
├── plugin.json             # 通用 harness 兼容清单：skills + mcpServers + commands + viewer
├── SKILL.md                # 技能文档（与 skills/figure-drawing/SKILL.md 同内容）
├── INSTALL.md              # 路线 A（DSH bundle）/ 路线 B（通用 MCP）安装与验证
├── README.md               # 本文件
├── skills/figure-drawing/SKILL.md
├── commands/               # 斜杠命令
│   ├── figure-new.md          # /figure-new        新建文档（可套期刊预设）
│   ├── figure-import-data.md  # /figure-import-data 由数据建图
│   ├── figure-export.md       # /figure-export     检查并导出
│   └── figure-viewer.md       # /figure-viewer     打开可视化工作台
├── presets/                # journals / palettes / templates 预设
├── examples/sample.csv     # 样例数据（端到端示例用）
├── start-native-viewer.bat # 一键打开「原生窗口」工作台（无需浏览器，Windows）
├── start-viewer.bat        # 旧方式：一键打开浏览器网页（Windows）
└── mcp/                    # 后端：MCP 服务器 + 可视化工作台
    ├── server.py           # MCP 服务入口（stdio JSON-RPC 2.0，python mcp/server.py）
    ├── tools_spec.py       # 26 个 figure_* 工具的清单（单一来源）
    ├── tools.json          # 由 tools_spec.py 生成的工具清单（Host index.js 同步读入）
    ├── bridge.js           # Node 桥（加载 mcp/lib 内核）
    ├── selftest.py         # 端到端自测脚本
    ├── viewer.py           # 可视化工作台 HTTP 服务（左编辑 + 右 AI 双栏 UI）
    ├── native_viewer.py    # 原生窗口启动器（pywebview → Chrome/Edge --app → 浏览器兜底）
    ├── viewer_static/      # 双栏 UI 前端（index.html + app/*.js + styles/）
    ├── lib/                # 图形内核（13 个 JS；含 diagram/science/lineage 扩展）
    └── py/                 # figraster.py（位图/PDF）+ docio.py（工程）+ spreadsheet.py（Excel 只读解析）
```

## 可视化工作台（左编辑 + 右 AI 双栏 UI，原生窗口）

这是本插件对"左边可以修改图、右边可以和 AI 对话"需求的实现，并且**不再依赖浏览器网页**：
工作台用 `mcp/native_viewer.py` 以「原生窗口」打开（pywebview/WebView2 → Chrome/Edge `--app`
→ 默认浏览器兜底）。**作为 DSH bundle 安装时，`startViewer` 默认 `true`，`dsh --profile demo`
一启动就自动弹出原生窗口**；不想随插件起改成 `false`。独立打开：

```bash
# 方式 A：一键原生窗口（Windows，无需浏览器，推荐）
start-native-viewer.bat

# 方式 B：命令行原生窗口
cd mcp && python native_viewer.py --serve --port 8770

# 方式 C：旧方式（浏览器网页）
start-viewer.bat          # 或 cd mcp && python viewer.py --port 8770

# 方式 D：MCP 工具（agent 调用后返回 URL；已起窗口时直接推文档）
#   figure_open_viewer({"doc": <doc>})  → {ok:true, url:"http://127.0.0.1:8770/"}
```

> 原生窗口体验请先装一次依赖：`python -m pip install pywebview`（不装也能回退到 Chrome/Edge `--app` 窗口）。

工作台能力（已实测）：

- **左栏 SVG 画布**：点选/框选（选框）/拖动/8 向缩放/旋转/就地编辑/吸附网格与参考线；工具栏含选择、框选、建锚点、文本、矩形、椭圆、直线、箭头、置入图片；顶部含编组/解组、6 种对齐、水平/垂直等距、置顶/置底/上移/下移、撤销/重做。
- **右栏 AI 面板**：自然语言 → 生成 EditOp 列表 → 应用/放弃；「审阅当前图」产出逐条可应用/忽略的意见；另有论证、锚点、图层、属性、模板、期刊、历史、工程 8 个标签页。
- **导入与出图**：左栏「导入数据/导入图片」→ CSV/JSON/TSV 原流程或 Excel 工作表/表头/统计预览 → 数据列统计自动推荐模板 → 确认后生成图表；「导出」选 TIFF/PNG/JPG/SVG/PDF 与 DPI。Excel 必须使用正在运行的工作台服务，独立静态 HTML 会明确提示服务要求，不调用模型也不传 API key。
- **可追溯与冲突保护**：每次编辑写入 rev 历史（sha256），「历史」标签页可命名/还原；`meta.history_origin` 随工程保存真实文档检查点，JSON 重开后旧版本仍可前向重放、预览与对比。早于检查点的旧版历史会明确标为有限兼容，不伪造内容。编辑回写到服务端 `mcp/projects/current.figureproj.json`。保存携带 `base_token`，版本过期返回 HTTP 409 / `save_conflict` 后停止自动覆盖；先导出本页工程备份，再刷新核对并手动合并，不承诺常驻同步自动合并。
- **AI 后端**：右栏下半部分是常驻 AI 对话区，上方保留工具与属性面板。可配置 DeepSeek key，或由 DSH 插件探测本机 `llm 桥` 后走文本聊天；审阅基于结构化文档与规则，不支持附图时不宣称审美检查。视觉直连待用户实际模型能力验证，不承诺已完成真实账号连接；无 key 且无桥时明确标注「离线模式（未调用模型）」。

## 快速开始

1. 见 `INSTALL.md`：拷贝文件夹 → 把 `plugin.json` 的 `mcpServers.figure.args` 填成绝对路径 → 合并进 harness 的 MCP 配置；
2. 验证：`python -B mcp/selftest.py`（退出码 0；强制离线，独立进程/临时目录，结束后清理，不读取正式 current 工程）；
3. 在 agent 里直接说"用这份 sample.csv 画一张 Nature 单栏分组柱状图，导出 TIFF"，或用斜杠命令 `/figure-new` → `/figure-import-data` → `/figure-export`。

## 26 个 MCP 工具（前缀 `figure_`）

`figure_create`、`figure_templates`、`figure_journals`、`figure_open_data`、`figure_create_chart`、`figure_apply_edits`、`figure_apply_journal`、`figure_recolor`、`figure_add_anchor`、`figure_anchors`、`figure_place`、`figure_panel_layout`、`figure_check`、`figure_render`、`figure_export`、`figure_review`、`figure_history`、`figure_revert`、`figure_save_project`、`figure_load_project`、`figure_open_viewer`、`figure_scientific_contract`、`figure_scientific_audit`、`figure_schematic`、`figure_lineage`、`figure_export_bundle`。

入参/出参 schema 以 `tools/list` 返回为准（来源 `mcp/tools_spec.py`）。

## 与其他形态的关系

- 只想要技能（无 MCP）：本包的 `SKILL.md` + `presets/` + `mcp/` 即是完整内核，单独的纯技能插件可用脚本直接驱动同一批内核文件；
- MCP 单件：`mcp/` 目录就是标准 MCP 服务器，可整体复制后单独注册。

## 注意事项

- 期刊预设数值是默认值（"待核对"），投稿前必须核对目标期刊官方 Author Guidelines；
- 未设置 `DEEPSEEK_API_KEY` 时 `figure_review` 走确定性规则回退（`mode:"fallback"`），汇报时如实说明；
- `mcp/lib/`、`mcp/py/` 是本 bundle 独立扩展，不声称与其他工程副本逐字节一致；修改需同步 API/加载顺序及回归。
- 本目录没有官方固定论文、PDF 或白板，也未进行挑战提交；不得将 DEMO、解码自检或工具数量冒称官方案例、金奖、评分、科学复核或出版验收。
