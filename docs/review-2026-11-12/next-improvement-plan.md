# 项目审查与下一步改进方案

审查日期：2026-11-12。范围：交接文档第 13 节、当前业务代码、优化进度、发布候选包与本地测评记录。

**结论：项目已有可继续迭代的绘图底座。下一步应先修正检查误报和编辑状态丢失，再打通安装迁移，最后建立三组公平对照。现阶段不宜用“已全面完成”“开箱即用”或“效果显著领先”作为宣传结论。**

本次只增加审查文档与复现材料，没有修改业务代码、安装依赖、调用收费模型或推送 GitHub。

## 1. 当前状态与证据边界

业务目录为 `E:\绘图框架\plugins\deepseek-figure-bundle`。本地 HEAD 与本次远程 `ls-remote` 返回值均为 `3f92b247cc2011d2f222a0b83033b61d2e8bec6d`；新增优化仍在未提交工作区，不能当作 GitHub 已发布能力。

| 可以确认的事项 | 证据及限制 |
|---|---|
| 数据映射向导、动态 AI 操作说明、前后 SVG 预览、保留数据绑定的展示覆盖已经实现 | 阅读当前源码，并重新运行对应测试；不等于所有 GUI 路径已验证 |
| 本次抽查 23 项全部通过 | [原始输出](evidence/targeted-tests.txt)，unittest 报告用时 1.995 秒；无模型调用 |
| C01/C02/C03 核心生成、修改与实际导出流程通过 | 作为上述 23 项的一部分重新运行；合成数据，经过实际 PNG/PDF 文件解码；不是科研结果或用户效率实验 |
| 交接记录的完整回归为 133 unittest、142 selftest | 这是上一轮记录；本次未重复跑全套，不把它们累加成新成绩 |
| RC 压缩包存在且哈希吻合 | SHA-256：`39b3893d55785fb9cd0bd013e139f61099b07e1c452659435d6236feddf9e02f`；有包不等于全新环境安装通过 |
| 真实宿主、新环境安装、当前版本真实模型、原生窗口完整交互仍待补验 | 早期版本的文本桥成功记录不能替代当前版本验收；本次未访问用户正式工程 |

测试选择依据：新功能跨越 AI、数据映射、历史与导出，应抽查这些主链路；五个测试模块执行成本低且直接支撑文章中的能力描述。已有全套记录无需机械重跑。另用五个小型反例覆盖现有测试未覆盖的明确问题。

测试覆盖需补一处：`test_c_workflows.py` 的 C02 用 `rowsSameLen` 检查 50 行仍存在，这不能独立证明每个数值都未改变。应改为变更前后逐值/哈希比较，并保留导出后的核对；介绍稿没有据此宣称数值完整性已被全面证明。

## 2. 审查发现与修复要求

### F01 / P0：期刊检查存在误报通过与错误适用

位置：[presets.js](../../mcp/lib/presets.js)，`_minFontSizeOf`（1246）、`_maxFontSizeOf`（1276）、`_minRasterDpiOf`（1298）、`checkJournalRules`（1312）。

本次反例结果：

| 输入 | 当前结果 | 应如何处理 |
|---|---|---|
| 1200×150 px 图片，放置为 50.8×50.8 mm | 报 600 dpi、PASS | 两轴分别为 600/75 dpi；不能忽略纵向分辨率 |
| 一张已知 600 dpi 图片，加一张缺失像素尺寸图片 | 整体仍报 600 dpi、PASS | 保留已测结果，同时标记未知对象；不能宣称整项检查完整通过 |
| 300 dpi 图片选择 ACS 预设，未确定图类别 | 同时运行线稿、灰度、彩色三条规则，产生两个 FAIL | 按明确的图类别和投稿阶段匹配；类别未确定时应要求确认或标未知 |
| 图表轴标题覆盖为 40 pt，另有一个 6 pt 文本 | 最大字号报 6 pt、PASS | 纳入图表实际生效样式；不能仅统计独立文字元素 |

**实现方式：**先返回逐对象测量记录 `{element_id, measured, coverage, reason}`，再汇总规则。DPI 使用 `min(pxWidth / widthInches, pxHeight / heightInches)`；不确定实际可见范围时如实标未知。字号和线宽从与渲染器一致的有效样式取得，避免重新维护一套默认值。用 `appliesTo` 匹配图类别与阶段，混合图保留逐素材结果。对含未知对象的规则显示“部分已检查”，而非整体 PASS；界面区分“没有已知硬错误”和“已完成全部检查”。

**验收：**上述四个反例均不再误报；已有宽度、低 DPI、未知规则用例仍通过；每个异常能定位到对象。这里属于已经复现的正确性修复，不需要新建通用规则平台。

### F02 / P0：表征编辑会丢失峰标注的稳定 ID

位置：[props.js](../../mcp/viewer_static/app/props.js) 的 `pendFromChart`（485 附近）与 `charDiffPatch`（786 附近）。

两处只复制 `{x, label}`。输入带 `id: "pk-user"` 的峰标注后，即使只切换反向轴，提交补丁也会包含已丢 ID 的峰列表；按原 ID 保存的 `presentation.peaks` 样式可能失去对应关系。本次直接调用源码中的草稿/差异函数复现了 ID 丢失，尚未通过真实鼠标事件复验。

**实现方式：**草稿、表单更新和提交全过程保留已有 ID；仅新建峰分配新 ID，复用内核校验；无关字段变化不得重写峰列表。修改峰位置或名称仍保留同一对象 ID。

**验收：**自定义峰颜色/字号后，修改反向轴、归一化、峰名称，再保存重开、撤销重做，ID 与对应样式保持；新增峰互不抢占旧样式。

### F03 / P0：锁文件尚未接通实际启动链

位置：[INSTALL.md](../../INSTALL.md) 开头、[index.js](../../index.js) 第 73 行、两个 `.bat` 启动器、[plugin.json](../../plugin.json)。

文档建议 `uv sync --locked`，但启动器仍直接调用 PATH 中的 `python`；DSH 默认也回退到 `python`。因此在未激活虚拟环境的新机器上，安装成功后仍可能启动另一个缺少依赖的解释器。doctor 检查的是执行 doctor 的解释器，不能证明宿主最终使用同一个解释器。pip 备用命令没有使用项目依赖声明。

**实现方式：**建立一个简单且一致的解释器选择顺序：用户显式配置 → 项目 `.venv` → 系统 Python。DSH、MCP 配置、启动器和 doctor 共用这个约定；失败提示真实路径及修复命令。默认安装使用 `uv sync --locked`；pip 路线从 `pyproject.toml` 安装并明确它不等于锁定安装。无需更换现有渲染后端。

**验收：**一台干净 Windows 环境，系统 Python 故意不装绘图依赖；依照文档安装后直接启动，doctor、服务端和窗口日志的解释器一致，Excel 导入和 PNG/PDF 导出均成功。原生窗口降级时显示实际容器。

### F04 / P1：迁移 API 已有，文档承诺的 UI 入口未接线

位置：[viewer.py](../../mcp/viewer.py) 的 `/api/data-dirs`、`/api/projects/migrate`；[INSTALL.md](../../INSTALL.md) 开头。

文档称可在“历史”页迁移，但当前 `viewer_static` 中未检索到调用上述端点的代码。默认工程目录已经改变，旧用户可能看到空白工程而不知道如何找回。

**实现方式：**首次打开且存在旧工程时，显示旧目录、待迁移数量和“复制旧工程”入口；复用现有 API，展示成功、跳过、冲突、无效文件。保留原文件，不自动覆盖。暂未接线前先修正文档。

**验收：**使用隔离的旧工程样本完成迁移；冲突可理解、可再次执行；没有旧工程时不打扰用户。无需新增同步或自动合并系统。

### F05 / P1：发布元数据与打包方式不一致

`pyproject.toml` 为 1.1.0，RC 文件名为 1.1.0-rc1，但 `package.json` 与 `plugin.json` 仍为 1.0.0。`package.json.files` 未包含新增 `scripts/`、`pyproject.toml`、`uv.lock`，因此 ZIP 检查通过不能替代 npm/tarball 安装验证。项目根目录尚无 LICENSE。

**实现方式：**统一版本与构建清单；选择一种主要交付渠道，按该渠道实际安装验证；记录源提交及补丁哈希。补 `THIRD_PARTY_NOTICES` 和资产出处清单，许可证由权利人选择。清理进度表中 R06“部分完成/未开始”并存，以及 R08“通过”与安装待验之间的歧义。

**验收：**主交付包包含全部运行和诊断必需文件，包内版本一致；从包启动完成一个真实示例。不能用开发机上已有依赖冒充干净安装结果。

### F06 / P0（效果宣传前）：本地测评对象不是本项目

当前 `E:\绘图框架\local-eval\runs` 共六个运行目录，全部 `condition=skill`。`run_meta.json` 的 `skill_source` 指向 `E:\AgentLab\玻尔绘图\build\{chart,schematic,ga}\submission`；随运行保存的是 `weekly-skill/toolkit`，如 `name: bohr-chart-figure`，并非本项目 `figure-drawing`。

例如 chart/mock-1 的 45/47 是另一个包的自动预检估算分，且耗时含人工等待；不能写成本项目得分、官方评分或对照增益。六份结果可用于参考检查项，不能换名沿用。现有 23/23、133、142 等测试数也不是效率或画质提升百分比。

## 3. 建议执行顺序

| 阶段 | 做什么 | 阶段完成条件 |
|---|---|---|
| A：修复正确性 | F01 期刊检查、F02 峰 ID | 反例转为回归测试；相关旧测试通过；一组真实界面交互验证 |
| B：让人装得上、找得到旧工程 | F03 安装、F04 迁移、F05 交付一致性 | 干净 Windows 安装记录、示例输出、解释器/版本/容器证据 |
| C：证明价值 | 按第 4 节做四条件对照 | 数据、产物、失败和成本均可核查；文章更新真实分母与增益 |
| D：改善多图工作流 | 共享图例、兼容坐标范围、最终尺寸下的局部重绘 | 先支持真实高频组合；只改目标子图，其余数据与样式不变 |

阶段 D 复用现有 FigureDocument/EditOp/canonical SVG。共享轴先检查量纲、范围和轴向；共享图例先检查语义键。12 个组超过 10 色时，当前实现会提示后循环配色；建议先预览映射，让用户补色或改线型后再提交，避免仅一闪而过的提示。暂不扩展复杂 SVG 全保真、图片恢复数据、完整印前系统或更多概念模板。

界面验收围绕三条完整任务：Excel→映射→编辑→导出；XPS→峰局部样式→调整参数→重开；四面板→更新单图→最终尺寸检查。保留截图/产物，并找 3 位目标用户试用；记录首次导出用时、卡点、返工次数，不把小样本结果推广成普遍结论。

## 4. 三组增益怎样补测

### 4.1 固定比较对象

| 条件 | 加载内容 |
|---|---|
| B0 白板 Agent | 仅统一任务说明，不加载任何领域 SKILL |
| B1 简单 Prompt | B0 + 下列固定短提示词，不加载 SKILL |
| B2 同领域优秀 SKILL | 首选 Yuan1z0825/nature-skills 的 nature-figure，冻结提交与资源版本 |
| S 本项目 | 当前待发布版本的 figure-drawing SKILL 与同一套已声明运行工具 |

B1 固定提示词：

> 请依据输入数据制作清晰的科研图。保留可编辑源文件，按指定毫米尺寸和分辨率导出 SVG、PNG、PDF。检查单位、标签、配色和遮挡；缺少的数据或统计依据请明确说明。

B2 的依据是任务相近、公开代码可检查且社区关注较高，并非“全球第一”的证明。2026-11-12 GitHub 页面显示 nature-skills 约 53.2k stars，K-Dense scientific-agent-skills 约 56.9k stars；数字属于整仓，不代表单个 SKILL 的效果排名。若增加第二个优秀方案，选择 K-Dense 的 scientific-visualization，单列结果，不挑有利案例替换主对照。

- [Yuan1z0825 / nature-figure](https://github.com/Yuan1z0825/nature-skills/blob/main/skills/nature-figure/SKILL.md)：已包含图件合同、多面板证据架构、最终 PDF 和碰撞检查；不能把这些概念称为本项目独创。
- [K-Dense Inc. / scientific-visualization](https://github.com/K-Dense-AI/scientific-agent-skills/blob/main/skills/scientific-visualization/SKILL.md)：强调真实数据、缺失值、可访问性、实际导出件及按投稿阶段核查规则。

本项目值得验证的差异是：将这些工作要求落到可交互、可撤销、保留数据绑定的工作台中，尤其是数据变更后的局部修改成本。这是待测的工程价值，不是已证明的画质领先。

### 4.2 控制变量与成本

第一轮只做 **1 个案例 × 4 条件 = 4 次试跑**，确认环境、产物采集和评分能工作。通过后做 **3 个新案例 × 4 条件 × 3 次独立重复 = 36 次**，已有有效试跑可计入，不机械重跑。增加 K-Dense 后为 45 次。正式执行前根据试跑实际 token、时长确定预算；本次没有执行这些模型实验。

所有条件固定模型/provider、推理设置、输入文件、字体和依赖、token/时间上限、重试规则、网络权限、基础工具权限；每次从干净工作目录开始、打乱顺序。对“SKILL 本身增益”的实验，各组均可使用相同的绘图工具/API，不强迫某组改用其不适合的后端，只改变加载的指导材料。若另做“完整产品 vs 通用 Agent”实验并增加本项目专用工具，必须单列，不能把工具差异解释成纯提示词增益。

三个案例建议：带缺失值和明确误差定义的统计图；已有 XPS 拟合列及明确峰标注的定向修改；四面板中只更新一个子图。避免直接使用已参与开发的 C01–C03 作为泛化测试。评估者保留答案文件，Agent 工作区不得读取；材料注明真实、脱敏或合成来源。

### 4.3 评价与报告

- **任务成功率**：在预算内满足预先冻结的必需项；数据值/单位/关系与输入一致，导出可打开、尺寸达标、源稿可继续编辑。超时和失败计入分母。
- **修改正确率**：目标改动生效，非目标对象与原始数据未被意外修改。
- **效率**：首次合格交付时间、修改轮数、token/费用、人工介入时间分别记录；安装时间另列，不混进绘图时间。
- **视觉质量**：两名不知条件的评阅者独立检查可读性、遮挡、层级和最终物理尺寸；数据错误不能被高审美分抵消。
- **可复核性**：保存输入哈希、版本、模型配置、完整执行记录、SVG/PNG/PDF、失败原因及逐项评分。

逐组报告 `S vs B0`、`S vs B1`、`S vs B2`。成功率增益用“百分点”；耗时改善用 `(基线耗时−S耗时)/基线耗时`，同时列绝对秒数。质量评分列量表与绝对分差。小样本报告每次结果与范围，不把 9 次重复当成 9 个独立任务；双方均成功的耗时对比要标明配对范围。没有数据的格子写“待测”，不是 0%。

## 5. 引用、原创与资产出处

审查能够确认的是本仓库实现了 FigureDocument/EditOp 集成、可视化工作台、DSH/MCP 接入、数据映射和展示覆盖等工程功能；本次没有逐文件证明全部代码原创，也没有完成完整资产许可审计。介绍稿宜写“本项目的开发贡献”，不宜写“全部自主原创”或“首创”。

以下来源由本地 README、`presets/palettes.json`、模板注记及当前依赖声明支持。作者以官方团队或仓库账号署名；没有证据确认的七个参考项目不补造名称或复用关系。

| 来源与作者 | 已确认的关联 | 后续需要补齐 |
|---|---|---|
| [Yuan1z0825 / nature-skills](https://github.com/Yuan1z0825/nature-skills) | figure contract、多面板证据与 QA 方法；部分模板参数与六色色板的来源注记 | 固定版本、对应文件与许可声明；[上游 LICENSE](https://github.com/Yuan1z0825/nature-skills/blob/main/LICENSE) 为 Apache-2.0 |
| [Nan Xiao / ggsci](https://nanx.me/ggsci/) | NPG、Lancet、JCO、JAMA 等配色来源注记，部分经 lcpmgh 整理 | 色值/资源来源与许可逐项核对，不把期刊命名色板当官方规范 |
| [Cynthia Brewer、Mark Harrower / ColorBrewer](https://colorbrewer2.org/) | 多组定性、连续、发散色板 | 资产条目的出处与声明 |
| [Masataka Okabe、Kei Ito / CUD](https://jfly.uni-koeln.de/color/) | Okabe–Ito 色板 | 保留原作者与来源 |
| [xuhangc / PythonResearchPaperPlot](https://github.com/xuhangc/PythonResearchPaperPlot)、[lcpmgh / colors](https://github.com/lcpmgh/colors)、[Winn1y / Show2Know](https://github.com/Winn1y/Show2Know) | 色板汇编/整理来源 | 区分原始配色作者与二次整理者，不仅致谢整理仓库 |
| Paul Tol、Matplotlib 团队 | 本地 source 字段标明 Tol 与 viridis/magma 色板 | 还需补精确原始文件链接、版本和许可；本次未完成这些条目的逐项核对 |
| DeepSeek Harness、PyMuPDF/Artifex、Pillow、openpyxl、xlrd、pywebview 维护者 | 宿主接口与实际运行依赖 | 按实际分发内容列第三方声明；[PyMuPDF 官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright) 由权利人据此确定分发方式 |
| K-Dense Inc. / scientific-visualization | 本次选定的对照候选 | 未找到其代码被本项目采用的证据，因此不写成既有依赖或抄用来源 |

## 6. 复核材料与下一位 Agent 的起点

- [反例脚本](evidence/audit-probes.cjs)：业务目录执行 `node docs/review-2026-11-12/evidence/audit-probes.cjs`；只读合成对象，无网络和模型调用。
- [反例输出](evidence/audit-probes.json)：四个期刊测量/适用性反例和一个峰 ID 草稿适配反例。
- [23 项测试原始输出](evidence/targeted-tests.txt)。复验命令在 `mcp` 目录运行：`python -X utf8 -B -m unittest test_ai_capabilities test_data_wizard test_ai_visual_preview test_chart_presentation test_c_workflows -v`。
- [被审查文件的哈希快照](evidence/audited-files.json)：绑定当前未提交源码；后续修改后应重新复验相关结论。
- [当前优化进度](../optimization/progress.md) 是上一轮实施记录；本方案中的实测发现应作为下一轮修正依据。

执行时先读交接文档第 13 节，保持现有未提交工作；从 F01/F02 建立失败复现和最小修复开始，每个修复附针对性验收。不要修改评估克隆、重构整个渲染器、替换用户数据，或借用其他 SKILL 的成绩。完成阶段 A/B 后再开展对照实验，并用结果更新介绍文章。
