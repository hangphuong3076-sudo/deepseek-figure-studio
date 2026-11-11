# INSTALL — dsh-figure-studio 安装指南（DeepSeek Harness 官方 bundle）

本插件已按 **DeepSeek Harness 官方插件规范**改造成一个可安装的 **bundle**（npm 包），
同时保留**完全自包含**的可视化工作台与 MCP 后端。两条安装路线任选其一：

- **路线 A（推荐，官方）**：作为 DSH bundle 用 `dsh plugin add` 安装 —— 26 个
  `figure_*` 工具直接注册进 DSH 的 tool registry，agent 原生可调用；可视化双栏工作台
  通过 `figure_open_viewer` 工具（或 `start-native-viewer.bat`）打开。
- **路线 B（通用）**：不装 DSH bundle，把 `mcp/server.py` 作为普通 MCP 服务器注册进
  任意 harness（见下文「路线 B」）。

---

## 路线 A：安装为 DeepSeek Harness bundle（官方）

本目录就是一个合法的 DSH bundle 包：

```
deepseek-figure-bundle/
├── package.json          # dsh.bundle.patch + dsh.client + engines.dsh + peerDeps
├── cordis.patch.yml      # 插入 figure-studio 插件行（含 viewerPort 等配置）
├── index.js              # Host 插件：注册 26 个 figure_* 工具 → 转发到 Python 后端
├── client.js             # Client 浏览器半（脚手架：设置卡 + 插件页 section）
└── mcp/ tools.json …     # 后端：server.py（stdio JSON-RPC）+ viewer + 内核 + 预设
```

### 1. 安装

```bash
# 从本地目录安装（开发/本机直装）
dsh plugin --profile demo add ./deepseek-figure-bundle

# 或从 git / npm / tarball（发布后）
# dsh plugin --profile demo add github:you/dsh-figure-studio#<commit>
# dsh plugin --profile demo add dsh-figure-studio
# dsh plugin --profile demo add ./dsh-figure-studio-1.0.0.tgz
```

首次会初始化 profile（以 `@deepseek-ai/dsh-base` 为首个 bundle），`pnpm` 链接本包，
并因 `dsh.bundle` 声明把 `dsh-figure-studio` 追加进 `dsh.profile.bundles`。

### 2. 验证已加载

```bash
dsh --profile demo --dump-config        # 应看到 "# == dsh-figure-studio" 层
dsh --profile demo                       # 启动后，对 agent 说：
#   "用 figure_journals 列出期刊预设，再用 figure_create 建一张空图"
```

Host 插件启动时会打印 `[dsh-figure-studio] 已注册 26 个 figure_* 工具`。
**本机直装 / 修改 bundle 后请完全退出并重启 DSH，再关闭旧工作台窗口重开**，使 Host 的
模型桥和工作台前端都加载新版本；已运行的 Host 进程不会因文件变化自动更换模型适配代码。

> **AI 零 key（工具 + 窗口都复用 DSH DeepSeek）**：作为 DSH bundle 使用时，两条 AI 路径都
> 不再需要给插件单独配 key：
> - `figure_review` 工具复用 DSH 的 `ctx.llm.prepareCall()` / `stream()` 流式接口，
>   失败则回退到插件自持 key（`DEEPSEEK_API_KEY`）或离线规则；
> - **工作台窗口右栏 AI 面板同样零 key**：Host 插件加载时在本机起一个 `llm 桥`（默认端口
>   `llmBridgePort: 8771`），通过环境变量 `FIGURE_LLM_BRIDGE` 注入给工作台后端 `viewer.py`；
>   窗口把 AI 请求转发给桥，并以一次真实请求验证连接，成功后 badge 才显示绿色的
>   「DeepSeek 模型（DSH 桥）」。连接失败会显示具体错误，不伪装成模型成功。
> - 默认跟随 DSH 当前选中的 provider/model（`agentDefaultModel.currentSelection()`）。
>   如需固定模型，在 `cordis.patch.yml` 同时填写 `provider` 与 `model`；留空即自动跟随。
> - 独立窗口 / 通用 MCP 形态仍按原样：窗口「设置」里自填 key，或走 `proxyUrl`。
>
> 当前 DSH 桥支持文本聊天调用；`figure_review` 只根据结构化文档和规则生成意见，桥不转换附图。
> 不支持图像时不得冒称视觉/审美审查；视觉直连能力尚需用用户的实际模型与账号测试，不预先承诺
> 已完成真实账号连接。现有 7 个 multimodal 单测仅使用内存伪造 HTTP 验证真实消息的位置、
> `image_url` 结构、图片签名及失败边界，未发真实模型请求，不构成视觉 proof 或账号能力证明。
> 连接测试与 badge 只反映当次路径状态，不扩大为视觉能力证明。

### 3. 打开可视化双栏工作台（插件加载即自动起，原生窗口）

`startViewer` 默认 `true`：**`dsh --profile demo` 一启动，可视化双栏工作台就随插件一起
以「原生窗口」弹出**（左编辑 SVG 画布 + 右 AI 对话面板，不再需要自己开浏览器访问 localhost）。
拖动两栏中间的分隔手柄即可调整宽度，宽度会保存在本机；「导入 SVG」默认将图形、文字、
路径和分组转换为可分别选中/编辑的元素，也可选择整张静态置入。
「导入数据」支持 .xlsx/.xlsm/.xls（不支持 .xlsb）：先选择工作表和 1 起始表头行，刷新查看实际列统计、
前几行和公式缺缓存位置，再继续选择模板；预览阶段不写画布/历史，确认后才提交并记录文件、工作表、表头行与 SHA-256。
二进制通过本机工作台服务解析，需要该 HTTP 服务正在运行，不需要模型或 API key；CSV/JSON/TSV 沿用原解析流程。
选中数据图表后点「拆为图元」，每根柱子、坐标轴、图例文本都可单独编辑；原始 spec/data
会保留在新分组的 `source_chart` 中，撤销可完整恢复。连续框选锚点会自动向 AI 输入框加入
`[1]`、`[2]`，然后可以输入“把1的字号改成8pt、把2移到右上”。
模板页提供结构示意图与真实色板色块；当前内置 60 个模板、43 套配色。**60 不是可真实渲染图型数**：
27 个 `full` 模板可经真实数据或明确实体关系合同本地生成 SVG，12 个 `layout` 只创建空复合版式且不自动填图，
21 个 `unsupported` 仅有示意、默认不推荐/隐藏、预览时明确标注且禁止应用。AI 与 EditOp 直接应用同样校验能力；
其中仅 `tpl-diagram-flow`、`tpl-diagram-arch`、`tpl-diagram-pipeline`、`tpl-graphical-abstract` 支持声明式原生实体关系，且 `auto_generate=false`，不猜科学内容。ROC/PCA 等未实现统计计算，不得把概念模板当作已完成。
「表征」筛选内提供 XPS、拉曼、XRD、FTIR、NMR、EIS、CV、应力应变与粒径分布等 `full` 模板。
XPS 高分辨拟合采用用户自己的拟合/基线/组分曲线列，不会在插件内擅自做峰分解；
EIS Nyquist 按用户提供的 Z′、−Z″ 原始数值绘制，横纵坐标保持相同 px/Ω，不非等比拉伸，不自动做等效电路拟合；
Bode 的 log10 轴排除非正频率并提示数量。选中图表后，在「属性 → 表征图表参数」编辑轴向、曲线列和峰标注，
修改可撤销，原始数据不变。
点击 `T` 后单击已有文字，或直接双击文字（含编组内/被覆盖文字），即可就地修改；空白处仍可新建文字。

「设置 → 当前画布宽高」支持手动输入毫米，决定后可等比调整图形与选框，不改变字号、
原始数据或 DPI。锚点编号会在已有指令后继续追加，不会在第二次选框时丢失。
AI 对话固定显示在右栏下半部分，可与主画布同步讨论排版，也可生成、预览和应用编辑；
在画布元素或选框上右键选择「发送给 AI」，随即在下栏输入后续指令，避免重复创建锚点。
指令进度显示实际阶段及请求进度，模型失败或离线回退均给出真实原因。
窗口由 `mcp/native_viewer.py` 打开：优先 **pywebview 原生窗口**（Windows 用系统自带 WebView2），
其次 **Chrome/Edge `--app` 无地址栏窗口**，最后默认浏览器兜底。启动日志打印：

```
[dsh-figure-studio] 可视化工作台服务已启动：http://127.0.0.1:8770/
[dsh-figure-studio] 已打开原生窗口（native_viewer.py）
```

- 想关闭"插件加载即弹窗"，把 `cordis.patch.yml` 里的 `startViewer` 改成 `false`
  （此时仍可经 `figure_open_viewer` 或下面的手动命令开）。
- 窗口右栏 AI 面板复用的 `llm 桥` 端口由 `llmBridgePort` 指定（默认 `8771`，与工作台
  `viewerPort: 8770` 分开；若端口冲突可在 `cordis.patch.yml` 改）。
- 最佳体验请先装一次原生窗口依赖：`python -m pip install pywebview`（不装也能回退到
  Chrome/Edge `--app` 窗口）。
- agent 侧用 `figure_open_viewer`（可带 `doc`）把当前文档推给工作台窗口。

脱离 DSH 独立打开：

```bash
start-native-viewer.bat         # Windows 一键：原生窗口（无需浏览器）
start-viewer.bat                # 旧方式：开浏览器网页
# 或： cd mcp && python native_viewer.py --serve --port 8770
```

### 4. 依赖（本 bundle 的运行期依赖，与路线 B 相同）

Python 3.13 + Node 22（`mcp/bridge.js` 内核桥）+ **PyMuPDF + Pillow + openpyxl + xlrd**，无 npm 构建、无 CDN。
openpyxl 3.1.x 负责 .xlsx/.xlsm 只读导入，xlrd 2.x 负责旧 .xls 存储值读取；本机实测 3.1.5 / 2.0.2。
不需要 pandas、xlwt 或 Excel 桌面程序，不执行宏/公式，也不加载外部工作簿链接。
所有导出格式先生成同一内核 SVG；PyMuPDF 负责服务端 PDF 与栅格化，Pillow 负责 PNG/JPEG/TIFF
编码及尺寸/DPI 校验，不承担科学映射。位图/PDF 导出必须安装 PyMuPDF，本机实测版本为
`1.27.2.2`；不能只装 Pillow。DeepSeek key 可选；不填时审阅类功能回退到离线规则
（`mode:"fallback"`）。

canonical `FigRender` SVG 是服务端 MCP/HTTP 各导出格式的唯一真源：SVG 直出；PyMuPDF 生成矢量 PDF，
再栅格化为 PNG/JPEG/TIFF。`panel_id` 可参照一个 panel 或 chart。panel 裁剪含 transform/padding 与后代；
上方外置标签扩 0.6mm + 一字号，below 标签扩 1.2 字号。chart 子图按实际 transform 裁剪 canonical SVG 根
`width/height/viewBox`，不改源 doc/canvas/data；其他 chart 的画幅外矢量可保留，但不得进入最终 PNG/PDF 画幅。
未知 id、rect/group、重复 id 或不可见元素明确拒绝而不回退整图。scoped 文件名区分 `_panel-id`/`_chart-id`，
MCP 返回 `px` 与位图真实尺寸一致，PDF 使用同一物理范围。透明参数 **only PNG**，只移除默认画布底色，
JPEG/TIFF/PDF/SVG 不会暗中透明。未知图型、无数据行或真实 render 出错会拒绝导出，不再生成“需 v2”占位成功。
浏览器本地 PDF 为栅格单页；旧 Pillow-only renderer 只供显式旧 API 兼容，不是正式导出回退。
静态置入遵循先 sanitize 后 rasterize；HTML 若作为静态源导入也必须先净化再转 PNG，绝不直接成为活动 DOM。
**本阶段已真实支持 Excel 读取导入，但没有 XLSX 导出能力。** .xlsx/.xlsm 需要 openpyxl，.xls 需要 xlrd；GUI 依赖本机图工作台服务的 `POST /api/import-spreadsheet`，不能在脱离该服务的静态页面里假装完成解析。

> 说明：`ctx.llm` 的 `prepareCall` / `stream`、消息格式与流终态已按本机安装的
> **DSH 0.2.2-rc.1** 实际运行包核对，不再猜测 `chat()` 方法。模型适配层通过了模拟流契约测试；
> 工作台的 SVG 导入、分栏、历史及 Python 后端也经过真实端到端验证。首次更新到你的宿主后，
> 仍应重启并用一次「测试连接」确认你的 DSH 账号和模型服务可用。

---

## 路线 B：作为通用 MCP 服务器安装（无需 DSH）

本插件包（skill + MCP 服务器 + 斜杠命令 + **可视化工作台**）**完全自包含**：把整个文件夹拷贝到任何位置都能独立运行，运行期不依赖下载源目录的任何路径。

## 最快开始：可视化工作台（左编辑 + 右 AI 双栏 UI）

无需注册任何东西，Windows 下双击 `start-native-viewer.bat` 即可打开原生工作台；
也可在插件根目录运行：

```bash
cd mcp && python native_viewer.py --serve --port 8770
# 浏览器备选：python viewer.py --port 8770 或根目录 start-viewer.bat
```

工作台 = **左边可编辑 SVG 画布**（点选/框选/拖动/缩放/旋转/文字/编组/对齐/图片）+ **右栏工具与属性面板**，右栏下半部分为常驻 AI 对话区（自然语言改图与结构化审阅），不是旧式单一上栏标签页。不支持附图时不冒称视觉审美审阅，无 key 时明确走离线规则回退。

保存使用 `base_token` 检查版本；过期版本返回 HTTP 409 / `save_conflict`，本页修改保留且停止自动覆盖。
先用「历史 → 导出工程」备份，再刷新核对并手动合并，不承诺常驻同步自动合并。

## 安装地址（本机）

```
E:\绘图框架\plugins\deepseek-figure-bundle
```

## 依赖

| 依赖 | 版本 | 用途 | 验证命令 |
|---|---|---|---|
| Python | 3.13 | MCP 服务器（`mcp/server.py`）、导出编排 | `python --version` |
| PyMuPDF | 必需，本机实测 1.27.2.2 | 同一内核 SVG → 矢量 PDF / 栅格化 | `python -c "import fitz; print(fitz.VersionBind)"` |
| Pillow | 11.x | PNG/JPEG/TIFF 编码与尺寸/DPI 校验，不承担科学映射 | `python -c "import PIL; print(PIL.__version__)"` |
| openpyxl | 3.1.x，本机实测 3.1.5 | .xlsx/.xlsm 只读导入、缓存值和公式位置检查 | `python -c "import openpyxl; print(openpyxl.__version__)"` |
| xlrd | 2.x，本机实测 2.0.2 | 旧 .xls 的 BIFF 存储值读取 | `python -c "import xlrd; print(xlrd.__version__)"` |
| Node.js | 22.x | 图形内核 Node 桥（`mcp/bridge.js`） | `node --version` |

无 npm、无构建步骤、无 CDN 依赖。位图/PDF 导出明确要求 PyMuPDF 与 Pillow，不能只装 Pillow。
DeepSeek API key 可选（`DEEPSEEK_API_KEY`）；不设置时审阅类功能回退到离线规则
（`mode:"fallback"`），其余不依赖模型的功能不受影响。

### 本机安装路径、依赖与字体证据

当前开发验证目录为 `E:\绘图框架\plugins\deepseek-figure-bundle`；通用安装若复制到其他位置，MCP 配置和 `figure_export/out_path` 必须换成该机器真实路径，不能继续引用这个开发路径。2026-11-11 本机实测：Node `v22.19.0`、Python `3.13.5`、PyMuPDF `1.27.2.2`、Pillow `11.1.0`、openpyxl `3.1.5`、xlrd `2.0.2`。可被替换的唯一预设目录是插件内 `presets/`，不需访问框架之外的私人文档。

本机存在 `C:\Windows\Fonts\arial.ttf` 与 `C:\Windows\Fonts\simsun.ttc`，PyMuPDF Base14 查询 `helv` 返回 `Helvetica`；这只是当前机器字体现状。它**不保证**任意机器的字体可用、中文字形完整、PDF 字体嵌入或期刊许可。`FigRender` 默认 `Arial, sans-serif`，字体替代取决于渲染环境；导出 PNG/PDF 后仍需人工查看实际字形、乱码、字体替代和 PDF 字体信息，不能用文本可提取或自测通过替代视觉验收。字体缺失时须诚实记录具体材料/导出失败，不用方框像素冒充通过。

## 安装步骤

### 1. 拷贝插件文件夹

把整个 `deepseek-figure-bundle/` 文件夹复制到目标机器任意位置，例如：

```
D:\agent-plugins\deepseek-figure-bundle
```

拷贝后不需要任何构建或安装命令。

### 2. 注册 MCP 服务器

`plugin.json` 里的 `mcpServers.figure` 使用相对路径 `./mcp/server.py`。把其中的 `args` 换成**你机器上的绝对路径**（建议正斜杠），合并进 harness 的 MCP 配置（`mcpServers` 字段）：

```json
{
  "mcpServers": {
    "figure": {
      "command": "python",
      "args": ["D:/agent-plugins/deepseek-figure-bundle/mcp/server.py"],
      "env": {
        "DEEPSEEK_API_KEY": "<可选；不设置则审阅走离线回退>"
      }
    }
  }
}
```

需要人工复核查看器（可视化工作台）时，给 `args` 追加 `"--viewer", "--port", "8770"`；或直接运行根目录 `start-viewer.bat`（推荐，会自动打开浏览器）。

### 3. 注册技能与斜杠命令

- 技能：`plugin.json` 的 `skills` 指向 `./skills/figure-drawing`（`SKILL.md` 在插件根目录也有一份同内容副本，两种发现方式都能工作）；
- 斜杠命令：`plugin.json` 的 `commands` 指向 `./commands`（含 `/figure-new`、`/figure-import-data`、`/figure-export` 三个命令）。

**若你的 harness 清单字段不同，按名字对号入座即可**：技能发现读 `skills/*/SKILL.md`；MCP 配置读 `mcpServers`（或合并进 harness 自己的 `.mcp.json`）；斜杠命令读 `commands/*.md`。三者互相独立，只装其一也能用。

### 4. 安装后验证

在插件目录里运行：

```bash
node --version && python --version
python -B -c "import fitz, PIL, openpyxl, xlrd; print(fitz.VersionBind, PIL.__version__, openpyxl.__version__, xlrd.__version__)"

# 真实拉起 MCP，执行科学合同、表征、历史、Excel 与多格式导出回归
python -B mcp/selftest.py
```

`selftest.py` 退出码 0 = 全部通过；测试强制离线，scope/安全与 Excel 探针使用独立 MCP 进程、真实工作簿 bytes、
随机端口 HTTP 和最小 DOM 级导入 UI 函数；UI 自检不是完整 WebView 像素级 GUI 自动化，也不请求模型。
不读取正式 `projects/current.figureproj.json`。真实导出的 `fig1.tiff`、`fig1.png`、XPS 多格式产物及工作簿
写入系统隔离临时目录，测试结束必须清理；`--out` 仅指定临时目录的已存在父目录，不是长期输出目录。
自测通过不替代原始数据、字体与逐面板视觉人工验收，也不是实际模型视觉能力证明。

也可以手动单发一条 MCP 请求验证服务活着（在插件根目录）：

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | python mcp/server.py
```

## 常见问题排查

| 现象 | 处理 |
|---|---|
| 图形工具报"无法启动 Node 桥" | 确认 `node --version` ≥ 22 且在 PATH；在 `mcp/` 下手动 `node bridge.js` 看报错 |
| Excel 报缺 openpyxl / xlrd | 按上表确认现有依赖版本；仅导入不需要 pandas、xlwt 或 Excel 程序；.xlsb 不支持 |
| GUI 提示 Excel 需要图工作台服务 | 通过 `native_viewer.py --serve` / `viewer.py` 或 DSH 工作台服务打开页面；确认 `POST /api/import-spreadsheet` 可达，密钥与此导入无关 |
| 公式单元格为空 | 查看 notices 中的缺缓存坐标；在本机表格软件重算并保存后重试，插件不会计算公式 |
| 导出位图/PDF 报找不到 figraster 或 PyMuPDF | 确认 `mcp/py/figraster.py` 存在，且 PyMuPDF 与 Pillow 均已安装；只装 Pillow 不足够 |
| `figure_journals`/`figure_templates` 报读不到预设 | 确认 `presets/*.json` 三个文件在（服务器优先找 `mcp/presets/` 与插件根 `presets/`，最后才回退 `../shared/presets`） |
| 审阅报"未配置 DeepSeek API key" | 属预期回退：设置 `DEEPSEEK_API_KEY` 环境变量即可启用模型审阅 |
