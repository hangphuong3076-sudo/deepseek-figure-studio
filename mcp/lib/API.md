# 绘图内核接口契约（deepseek-figure-bundle 扩展 v1.2）

本目录是 bundle 的自包含内核扩展，兼容 `shared/lib` 基础接口，并加入科学合同、表征渲染、实体关系、数据血缘和属性修改能力。**本目录不声称与其他工程副本逐字节同步。**已有图元、操作与输出协议保持兼容，新增能力以下文的约束为准。

## 通用约定

- **无构建、无模块系统**：每个文件在全局作用域挂一个对象（`window.FigDoc` 等），版本目录用 `<script src="lib/xxx.js">` 顺序加载，因此可在 `file://` 下运行。
- 加载顺序：`figdoc.js` → `diagram.js` → `ops.js` → `science.js` → `palette.js` → `presets.js` → `data.js` → `lineage.js` → `render.js` → `tiff.js` → `export.js` → `ai.js` → `storage.js`。
- 单位：文档内一律 **mm** 与 **pt**；转换函数集中在 `FigDoc`。
- 无第三方运行时依赖（不引 CDN、不引 npm）。
- 所有函数**同步**，除非显式标注 `async`。
- 所有函数遇非法输入**抛 `Error`**（消息为中文），不做静默降级。
- 本 bundle 目录内的 `lib/VERSION` 标记内核扩展版本（当前 `1.2`）；它不作为其他工程文件清单或同步状态的证明。

数据契约见 `shared/schema/figure-document.schema.json` 与 `shared/schema/edit-op.schema.json`。运行时实施本 bundle 的新增操作时，以本目录 `ops.js` 的白名单校验为准。

## Bundle 扩展约定

- `set_scientific_contract`：以补丁方式保存科学问题、证据角色与统计声明，可撤销。省略的顶层字段保留；标量显式 `null` 清除；`panels` 出现时整体替换。`statistics` 省略或为 `{}` 时保留各图统计，`statistics:null` 清除全部图统计；`statistics[id]` 的对象整体替换该图统计，`null` 或 `{}` 只清除该图，未列出的图不变。真实统计信息唯一存于每个 chart 的 `chart.statistics`，一个图已申报不能替代另一个图。
- `set_chart_properties`：`{targets, properties:{axes?, characterization?}}`，逐键合并图表轴与表征元数据，不改变 `chartType` 或 `data.inline`。
- `apply_schematic`：完整保存用户声明的 `{schema_version,id,nodes,relations,sources,canvas?,layout?,uncertainties?,human_review?}` 和物化 `materialized_schematic`，正常 commit 时间写 `generated_at/history`，但绝不进入 SVG 几何。contract 有纯白名单字段和枚举校验，兼容 `sourceRefs/from/to/sourceId/targetId`；不猜科学内容，不执行来源文字，不自动抓取 source。同语义节点默认保留手动布局，仅 `auto_layout=true` 或合同明确该字段时重排；历史重放使用首次物化的元素与 id。
- `layout_schematic`：`{diagram_id,auto_layout:true}` 按已保存合同显式重排，不读取/推断外部材料。
- `set_chart_data`：`{targets:[chartId],approved:true,data:{columns,rows,source_ref?,version?,raw_source_sha256?,source_info?},source_ref?,version?,raw_source_sha256?,source_info?}`，同时支持 `sourceRef` camel alias；调用方必须提供真实 `approved=true`、非空 source_ref/version。映射列必须仍存在，`mapping/style/chartType/既有 statistics` 不变。替换前完整 `chart.data`（含原 raw SHA、filename、source_info 和值指纹）写入 `chart.data_history`。未显式提供新 raw 证明时当前 `raw_source_sha256='unknown'` 且移除旧 source_info/raw_source；提供时严格校验 SHA 格式、各 SHA 别名、locator/version、bytes 及 `value_fingerprint` 与本次 columns/rows 一致，明确申报同一 raw 文件仍可保留其 SHA。新 `content_sha256` 只标识 inline 值，不冒充 raw 文件哈希；`source_row_index=null` 不伪造原文件行号。替换后 `statistics_review.status=required`，缺 n/单位列出缺口，科学审计不可直接 ready。
- `chart.characterization`：`technique`、`x_reverse`、`x_scale`（`linear/log10`）、`x_label`、`y_label`、`curves`、`fit_model`、`fit_source`、`peak_annotations`、`normalize`（`none/max_to_unity`）、`offset_each_series`、`equal_aspect`（布尔值；供 EIS 等科学坐标采用等比映射，不触发任何自动拟合）。
- `curves[]` 形如 `{role:'fit'|'component'|'baseline', column:'实际数据列名', label:'显示标签'}`，只使用真实列，不做前端拟合。XPS/NMR 反转结合能/化学位移轴；Raman 默认升序。绘制顺序为 component → baseline → fit → raw；fit 使用 `stroke-dasharray="6 3"`，baseline 使用 `"2 3"`，图例来自同样的原始/用户曲线序列。
- 除 CV 外，表征曲线按每个序列自身的 x 数值升序排序后再做轴映射；XPS/NMR 的映射使屏幕 x 随结合能/化学位移反向递减。CV 保留采集顺序以连接循环，不按 x 重排；两种处理都只排序/连接渲染副本，inline 原始行与数字循环值保持不变。
- `fit_source` 统一记录 `provided_by_user_fit`，表示来自用户提供的外部分析结果，不表示 plugin 已经执行拟合。存在 fit/component 曲线而未申报 `fit_source` 时，独立给出 `CHAR_FIT_SOURCE_MISSING`，不依赖该 chart 是否已有统计声明。
- 仅用户明确选择 `max_to_unity` 才归一化；`offset_each_series` 仅作位置偏移，线性差值不代表实验强度。log10 的非正 x 不计入曲线，但给出排除告警，inline 原始数据不被修改。审计 `coverage` 含 `question/panels/statistics/hero_panel/final_size` 布尔项；hero 引用悬挂或统计只覆盖部分图表时不得标为 ready。
- 表征模板覆盖 XPS（全谱、原始+拟合、双区域）、Raman（单谱、多样品）、XRD、FTIR、UV–Vis/PL、NMR、EIS、CV、应力应变、粒径分布。所有图卡只画结构示意，不把示意数据当作真实实验数据。

---

## `FigDoc`（`figdoc.js`）

文档模型与坐标工具。**不依赖 DOM。**

```js
FigDoc.SCHEMA_VERSION            // "1.0"
FigDoc.create(opts?) -> doc       // 建空文档
//   opts: { width_mm=120, height_mm=90, dpi=300, background="#FFFFFF",
//           journal_preset_id=null, title, app, app_version }
//   返回符合 figure-document.schema.json 的对象；meta.created/updated 为 ISO 字符串；
//   id 用 FigDoc.uid("doc") 生成；elements/anchors/panels/history 均为 []

FigDoc.uid(prefix) -> string      // `${prefix}-${8位base36}`，进程内不重复

// --- 单位换算 ---
FigDoc.mmToPx(mm, dpi) -> number          // mm * dpi / 25.4
FigDoc.pxToMm(px, dpi) -> number
FigDoc.ptToPx(pt, dpi) -> number          // pt * dpi / 72
FigDoc.normToMm(bboxNorm, canvas) -> {x,y,w,h}
FigDoc.mmToNorm(bboxMm, canvas) -> {x,y,w,h}

// --- 查询 ---
FigDoc.get(doc, id) -> element|null
FigDoc.byType(doc, type) -> element[]
FigDoc.children(doc, parentId) -> element[]       // 按 doc.elements 中 children 顺序
FigDoc.descendants(doc, id, {includeSelf=false}) -> element[]
FigDoc.ancestors(doc, id) -> element[]            // 由内向外
FigDoc.bbox(doc, id, {recursive=true}) -> {x,y,w,h}   // mm；group/panel 递归求并集
FigDoc.hitTest(doc, {x_mm, y_mm}) -> element|null     // 顶层优先(z 大者)，跳过 locked/visible=false
FigDoc.anchorsOf(doc, elementId) -> anchor[]
FigDoc.elementsInAnchor(doc, anchorId) -> element[]

// --- 结构变更（返回新 doc，均不改原对象：结构化克隆后修改） ---
FigDoc.addElement(doc, element) -> doc            // id 冲突抛错；parent_id 不存在抛错
FigDoc.removeElement(doc, id, {cascade=true}) -> doc   // cascade 连子元素、锚点引用一并清理
FigDoc.setParent(doc, childId, parentId|null, {keepWorldPosition=true}) -> doc
FigDoc.reorder(doc, id, {to: "front"|"back"|"forward"|"backward"}) -> doc
FigDoc.setCanvas(doc, patch) -> doc               // 部分字段合并；宽高变化不自动缩放元素
FigDoc.touch(doc) -> doc                          // 更新 meta.updated，返回新 doc
FigDoc.clone(doc) -> doc                          // 深拷贝
FigDoc.normalize(doc) -> doc                      // 补齐缺失默认值、按 z 排序、去除悬挂引用
FigDoc.validate(doc) -> {ok: boolean, errors: string[]}   // 轻量结构校验（非完整 JSON Schema）
FigDoc.serialize(doc) -> string                   // 稳定 JSON（键排序），用于 sha256
FigDoc.sha256(doc) -> Promise<string>             // 基于 serialize 的 SHA-256（hex）；用 WebCrypto
```

**分组与面板语义**
- `group` / `panel` 元素通过 `children: [id...]` 持有子元素；子元素 `parent_id` 反向指向。
- 移动父元素时子元素随之移动（由 `FigOps` 的 `move` 实现递归位移）。
- `FigDoc.setParent` 在 `keepWorldPosition` 下重算子元素 `transform`，保证屏幕位置不变。
- `panel` 的 `panelLayout` 定义格子；子元素可用**面板局部归一化坐标**：当元素 `style.panelRelative === true` 时，其 `transform` 的 x/y/w/h 视为相对父面板内边距的 0–1 比例，渲染时换算为 mm。越界（<0 或 >1）时 `FigDoc.validate` 报 `PANEL_OVERFLOW` 警告（不阻断）。
- `style.panelRelative` 与 `style.role`（供 `recolor` 的 `byRole` 使用）均已在 `figure-document.schema.json` 的 `$defs.style` 中声明为合法字段。

---

## `FigDiagram`（`diagram.js`）

```js
FigDiagram.build(doc, spec, {generated_at?, auto_layout=false}) -> {doc, warnings}
// 不修改传入 doc；doc.elements 为真实 group/rect/ellipse/text/connector。
// meta.diagrams[id] 保存完整 contract/spec、sources、contract_sha256、
// source_sha256、layout_sha256、generated_at、element_ids、review_status/uncertainties。
FigDiagram.normalize(spec) -> canonicalSpec // 严格 schema/未知字段/引用/枚举校验
FigDiagram.validateSpec(spec) -> {ok,errors,warnings,partial,spec,supported_templates}
FigDiagram.supportsTemplate(tplOrId) -> {supported,mode,requires_data,requires,reason}
// 仅具名通用 builder；不能按名称冒称其他模板均已实现。
FigDiagram.templateCapability(tplOrId) -> {supported,status,can_generate,can_apply,requires_schematic,reason}
FigDiagram.previewSVG(spec) -> string // FigDoc 隔离创建 + FigRender，不写当前工程
FigDiagram.example(id, synthetic=true) -> spec // 仅明确 DEMO 通用实体，不是论文答案
FigDiagram.connectorGeometry(doc, connector) -> {start,end,middle,points,source_port,target_port,...} // 按真实节点 bbox；不存 pathData
FigDiagram.chartSlots(doc, sceneId?) -> [{scene_id,node_id,slot_element_id,parent_id,transform,generated_chart_ids}]
FigDiagram.auditLayout(doc) -> 全文档版面风险；普通 chart/panel 覆盖 node_shape 时含 collision_area 和改善路径
```

- 节点 `role=question|method|evidence|conclusion`，shape 为 `box/ellipse/cell/molecule/material/process/outcome/sample/device/group/chart` 等明确通用声明。只有显式 `kind:'chart'` 或 `shape:'chart'` 才建立数据 slot，绝不按 role/entity 推断；slot 保留原生 group、label 与 `diagram_part=chart_slot` 的 rect，真实 chart 以稳定 `diagram-<scene>:slot:<node>:chart` id 作为其子元素。唯一 slot 可由 `figure_create_chart` 自动绑定；多 slot 必须同时明确 scene/node，slot 真实 bbox 与 transform 不混用；同 slot chart/用户内容在场景重建和 auto_layout 中保留，`meta.layout.resolution` 与物化历史记录新旧布局依据。
- 关系 `activate` 为激活箭头，`inhibit` 为 T，`include` 为原生父子容器，`associate` 为无向并列线，`sequence` 为方向箭头。source/target 必须唯一有效；include/associate 的 direction 为 none，方向冲突是结构错误。
- 来源 `{id,locator,version?,sha256?,text?,...}` 始终 `user_provided_unverified`，evidence 精确到声明来源与定位。MISSING_MATERIALS/EVIDENCE_MISSING、INVALID_ROLE/SHAPE、INVALID_SOURCE_REFERENCE、CANVAS_OVERFLOW 等不混成一个“预览失败”。
- connector 每次渲染按端点语义节点真实 bbox 与父 panel 归一化 frame 重算；关系文字仍是原生 text，在其 midpoint 动态定位。移动节点/容器即改变 SVG，且 source 的 text 只被作为用户文本保存、不执行。同节点同侧端口按 connector id 排序：1 条 50%，2 条 25%/75% 加最大 12.5% 方向微调，更多按距角至少 2mm、边长比例 10%–25% 的边带等距；折线与箭头切向使用实际 points。
- `auditLayout` 只按顶层 chart/panel 与 node_shape bbox 检查遮挡，不把 chart 内每个图元或普通父容器当成逐元素碰撞。显式 slot 的内容重叠豁免；其余风险给稳定 warning id、`collision_area` 及移动/明确 slot 改绑路径。旧未绑定路径可生成但保留 partial/layout review，不冒充视觉验收。

---

## `FigOps`（`ops.js`）

AI 与 UI 的唯一变更入口。**所有编辑都产出 `EditOp[]`，经校验后应用并写入 history。**

```js
FigOps.OP_TYPES -> string[]        // 与 edit-op.schema.json 的 enum 一致
FigOps.validate(op, doc) -> {ok, errors}      // 单条校验，含 target 是否存在
FigOps.validateAll(ops, doc) -> {ok, errors}
FigOps.apply(doc, op) -> {doc, changed: boolean}
//   落空（目标不存在且非 add_*）时 changed=false，不抛错
FigOps.applyAll(doc, ops, {label, source="ai", checkpoint=false, ts}) -> {doc, changed, applied: number}
//   1) validateAll 失败则抛错（不部分应用）
//   2) 逐条 apply
//   3) applied>0 才写入 doc.history 一条记录：{rev, ts, label, source, base_rev, ops, doc_sha256:null, checkpoint}
//      applied=0 原样返回 doc，不写历史、不初始化 origin/cache，也不截断 redo；doc_sha256 由调用方 async 补齐
FigOps.captureHistoryOrigin(doc, contentRev=当前内容播放头) -> doc
//   不修改输入；返回带 meta.history_origin={rev,doc} 的文档。rev 取真实内容播放头或调用方明确值。
//   origin.doc 是去除 history、递归 history_origin/__snapshots/key/DOM/saveToken 的完整文档内容快照。
FigOps.contentRev(doc) -> number                    // 当前内容播放头，供 UI 复用内核撤销/重做规则
FigOps.ensureSnapshot(doc, rev, cache) -> doc       // cache 未命中时从 origin 前放；早于 origin 明确报兼容错
FigOps.finalizeHistory(doc, rev) -> Promise<doc>   // 回填该 rev 的 doc_sha256
FigOps.undo(doc) -> doc            // 回到 base_rev 的快照（见下"历史实现"）
FigOps.redo(doc) -> doc
FigOps.revertTo(doc, rev) -> doc   // 回到指定 rev（在 history 里追加一条 revert 记录，不丢历史）
FigOps.diff(docA, docB) -> {ops: EditOp[], summary: string}   // 结构 diff → 可重放的 EditOp
FigOps.describe(op, doc) -> string // 人类可读中文，如 "把 a1 右移 5mm"

// --- 选择器解析 ---
FigOps.resolveTargets(doc, targets) -> string[]
//   targets 项可为：元素 id、"@anchor-x"（锚点内元素，若锚点无 element_ids 则按 bbox 命中）、
//   {kind:"all"}、{kind:"type", type:"text"}

// --- 历史实现（固定策略）---
// doc.__snapshots 为不可枚举的运行期缓存 {rev -> 文档深拷贝}，不写入 JSON；精确缓存命中优先。
// 首个真实 FigOps.apply/applyAll 变更完成后，以变更前真实内容播放头初始化 meta.history_origin；
// 新空文档因此是 rev0，若 legacy 在当前 revN 首次变更则基线就是 revN，不伪称 rev0。
// 恢复旧版本从 origin.doc 向前重放 events；不逆向执行不可逆反推 op。模板重放只使用历史已物化的
// materialized_template，元素、IDs、data/metadata 不重新生成。origin 本身不嵌套 history/origin，JSON/克隆体积有界。
// 没有 origin 的 legacy 在装载/导入时以当前内容播放头补建基线；早于 origin.rev 且没有该 rev 运行期
// older cache 时抛出明确检查点兼容错误，绝不把当前内容冒充旧版本。后期新基线只支持向前恢复其后历史。
// history 每条记录保存 ops 与 base_rev；undo = revertTo(上一条 base_rev)。
// 撤销栈上限 FigOps.MAX_HISTORY = 200，超出丢弃最旧的非 checkpoint 记录。
FigOps.MAX_HISTORY
```

**各 op 语义（必须逐条实现）**

| op | 语义 |
|---|---|
| `move` | 对每个 target 应用 `dx/dy`（mm）；若给了 `x`/`y` 则设为绝对值。父元素递归位移子元素。 |
| `resize` | 设 `w/h`（mm）。最小 0.1mm。父元素不自动缩放子元素。 |
| `rotate` | `rotation` 设绝对值；`angle` 为相对增量。 |
| `set_text` | 仅 `type=text`；写 `text`。 |
| `set_style` | 合并 `style` 补丁到元素（或 `targets` 内全部元素）。 |
| `set_color` | `color`→`style.fill`，`stroke`→`style.stroke`。 |
| `add_element` | 追加 `element`（缺 `id` 则生成）。首次生成的 id 必须回写历史 op；undo/redo、快照恢复及跨进程前向重放均保持这个 id，不重新生成。 |
| `delete` | 删除 target（cascade）。 |
| `group` | 用 targets 建 `group` 元素（id 取 op.id 或生成），子元素按当前 z 顺序入 children，父元素位置取并集 bbox。 |
| `ungroup` | 解除 target（须为 group/panel）的子元素，坐标换算为世界坐标，删除容器。 |
| `align` | 多 target 按 `mode`（left/center/right/top/middle/bottom）对齐到**共同包围盒**；单个 target 时对齐到画布。 |
| `distribute` | 按 `orientation` 等间距分布（≥3 个 target 才生效）。 |
| `z_order` | `to`：front/back/forward/backward。 |
| `add_anchor` | 追加 `anchor`（缺 `bbox_mm` 时由 `bbox_norm`×canvas 计算，反之亦然）。 |
| `remove_anchor` / `update_anchor` | 按 `anchor.id` 删除/合并更新。 |
| `apply_template` | `{template_id, data?, options?}`。validate 与 apply（含 replay/materialized_template）都先调用同一 `validateTemplateCapability`；`unsupported` 明确失败且原文档不变，不能用预物化 elements 绕过。`data` 直接为已解析 `{columns:string[],rows:any[][]}` 或 `null`，不再包 `csv/json/inline`；`options` 为 `{journal_id?,palette_id?}` 或 `null`。builder 归一化空输入后，与数据导入共用 `FigPresets.templateFromStats(templateId,data,options)` 生成链，从模板重建 elements/chart 骨架，保留 canvas、历史与锚点（清除已失效的元素引用）；多面板逐面板保持同一份 data 与表征配置。未传 data 不从旧元素抢救数据。 |
| `apply_journal` | 套用 `presets/journals.json` 预设：改 canvas 宽高/预设 id、把已有文本元素的 `fontSizePt` 按比例缩放到 `base_font_pt`（比例 = base/当前用户基准，见 presets 模块 `FigPresets.scaleFonts`）、写入 `meta.journal_preset_id`。返回告警见 `FigPresets.applyJournal`。 |
| `recolor` | 把文档内元素的 `style.fill/stroke` 按 `recolor_strategy` 映射到 `palette_id` 颜色。 |
| `panel_layout` | 设 target（type=panel）的 `panelLayout`，并按 cols/rows/gap 重排 `children` 的 transform（若子元素是 `panelRelative` 则写归一化值）。 |
| `set_canvas` | 同 `FigDoc.setCanvas`。 |
| `note` | 无副作用，只把 `reason` 写入 provenance（用于解释 AI 的说明性输出）。 |

**`recolor` 策略**
- `byHue`（默认）：收集文档内所有不重复的 fill（按首次出现顺序），按色相排序后与调色板按序配对；未在调色板长度内的循环使用。
- `byOrder`：按首次出现顺序直接顺序配色调色板。
- `byRole`：若元素 `style.role` 命中调色板 `roles` 键，则取对应色；否则回退 `byHue`。
- 白色/透明（`#FFF`、`none`、`null`）与黑色描边**不参与换色**。

---

## `FigPalette`（`palette.js`）

```js
FigPalette.load(palettesJson) -> void                 // 载入 palettes.json（由 presets 模块统一调用）
FigPalette.list({category?}) -> palette[]
FigPalette.get(id) -> palette|null
FigPalette.colors(id) -> string[]
FigPalette.roleColor(id, role) -> string|null
FigPalette.hexToRgb(hex) -> {r,g,b}                   // 支持 #rgb / #rrggbb
FigPalette.rgbToHex({r,g,b}) -> string
FigPalette.hue(hex) -> number                          // 0–360
FigPalette.sortByHue(colors) -> string[]
FigPalette.contrastText(hex) -> "#000000"|"#FFFFFF"    // 按 WCAG 相对亮度选可读文字色
FigPalette.nearest(paletteId, hex) -> string           // 调色板内最近色（RGB 欧氏距离）
FigPalette.isNeutral(hex) -> boolean                   // #fff/#000/#808080/none/null 视为中性，换色时跳过
FigPalette.luminance(hex) -> number
```

---

## `FigPresets`（`presets.js`）

```js
FigPresets.load({journals, templates, palettes}) -> void   // 三个 JSON 对象；内部转调 FigPalette.load
FigPresets.journals() -> preset[]
FigPresets.journal(id) -> preset|null
FigPresets.templates({category?, chart_type?, capability?}) -> template[]
FigPresets.template(id) -> template|null
//   返回的每个模板都有 capability；capability 过滤值为 full/layout/unsupported。
FigPresets.templateCapability(idOrTemplate) -> {
//   template_id, chart_type, status:"full"|"layout"|"unsupported", label,
//   can_generate, can_apply, requires_data, can_preview, reason
// } | null
//   full：当前 FigData.supportsChartType(chartType) 确认有实际 renderer，可在本地真实渲染；
//   layout：无 chartType 的复合模板，只创建空面板，不自动填图；
//   unsupported：示意图与未实现数据图，仅供示意预览，UI、Import 与 opApplyTemplate 均禁止应用。
//   full 的 can_generate/can_apply 为 true；layout 只有 can_apply 为 true；
//   unsupported 两者均 false。缺 supportsChartType 时只回退到旧内核已实际提供的 10 种 renderer，
//   不按模板名称、类别或图型字符串猜测支持能力。
FigPresets.validateTemplateCapability(idOrTemplate) -> {ok, errors, capability}
//   唯一模板应用校验入口；ok == capability.can_apply，失败 errors 含明确不可应用原因。
FigPresets.pxPerMm(dpi) -> number

FigPresets.applyCanvas( presetId, doc ) -> {doc, op: EditOp, warnings: string[] }
//   生成一条 apply_journal op；warnings 例："正文 7pt 低于 Nature 单栏 5pt 下限"

FigPresets.check(doc) -> {ok, warnings: [{code, message, element_id?}]}
//   码表：FONT_TOO_SMALL / WIDTH_MISMATCH / DPI_TOO_LOW / HEIGHT_TOO_TALL /
//        PANEL_OVERFLOW / LOW_CONTRAST / NO_ANCHOR
FigPresets.scaleFonts(doc, fromPt, toPt) -> doc

// --- 模板推荐 ---
FigPresets.inferColumns(columnStats) -> void            // 见 FigData.columnStats 的输出
FigPresets.recommend(columnStats, {n=5}) -> [{template_id, score, reasons: string[], capability}]
//   columnStats: FigData.columnStats(data) 的返回；同分按模板表顺序。
//   任何 status=unsupported 的模板一律在返回列表前剔除、不参与排序，因此 ROC/volcano/PCA/示意图等
//   未实现本地 renderer 的候选不会以高分进入默认推荐，也不承诺 60 个模板都可真实生成。
FigPresets.templateFromStats(templateId, data, {journal_id, palette_id}) -> {
//   elements, chart, warnings, capability, data_bound
// }
//   先执行 validateTemplateCapability，不可应用时抛 Error，不产生元素。
//   full 无 data/rows 时仍允许显式空骨架，data_bound=false 并明确提示“未绑定数据”，不代表已生成图表。
//   layout 只产生 chart={} 的空白复合骨架，data_bound=false；即使传 data 也不自动填图。
//   每个图表模板含 panel 容器、一个或多个 chart 元素及可选标题文本。
```

---

## `FigData`（`data.js`）

```js
FigData.parseCSV(text, {delimiter="auto", header=true}) -> {columns: string[], rows: value[][]}
//   auto 探测 , ; \t；带引号转义；空单元格为 null
FigData.parseJSON(text) -> {columns, rows}      // 支持 [{...}] 或 [[...]]
FigData.columnStats(data) -> {n_rows, columns: [{name, kind:"numeric"|"categorical"|"datetime"|"text",
    nunique, missing, min, max, mean, isOrderedCandidate, sampleValues}]}
FigData.inferChartType(columnStats) -> {chart_type, mapping, reasons: string[]}
FigData.makeChartElement(data, {chart_type, mapping, journal_id, palette_id, transform}) -> element
//   返回符合 schema 的 type=chart 元素（数据内联进 chart.data.inline）

FigData.supportsChartType(type) -> boolean    // 以实际 RENDERS 函数注册为准
FigData.supportedChartTypes() -> string[]

// 轻量渲染（供 v1/v3 预览；v2 可用 matplotlib 覆盖）
FigData.renderChartSVG(chartSpec, {width_mm, height_mm, dpi}) -> string   // 返回真实 <svg> 内容片段
//   当前支持：bar / bar_grouped / line / line_multi / scatter / area / pie / histogram / heatmap / box；
//   后续增删以 supportsChartType/supportedChartTypes 的运行时结果为准；模板层正常路径只调用该查询，
//   仅旧内核缺少探针函数时才使用 presets.js 已审计的兼容白名单，不维护 59 模板的静态支持映射。
//   不支持、缺数据或未绑定数据行均明确抛 Error；UnsupportedChartError 可携带仅用于模板示意的
//   svgFragment，但该片段不是成功渲染结果。FigRender 不再吞错转成“需 v2”占位成功输出。
```

---

## `FigLineage`（`lineage.js`）

```js
FigLineage.manifest(doc) -> {scope,charts,layout_elements,issues,coverage,limitations}
FigLineage.audit(doc) -> manifest + {issue_count,error_count,warning_count,status}
FigLineage.lookup(doc,{element_id?,source_row?}) -> {query,matches,count,points}
```

- 逐点映射仅覆盖 `bar/bar_grouped/line/line_multi/area/scatter`，值来自实际 `FigData.getChartPoints` 使用的同一渲染映射；其他图型明确 `unsupported`，不把只读反查包装成全图 scientific pass。
- `source_row` 为 inline 数组从 0 起始的位置。聚合柱含 `raw_values/source_rows/count/aggregate`；分组、series、端点、归一化、反向轴与用户 fit 列分列保留。缺统计 n、单位、来源 SHA、行空值或映射错误各自报告，不从颜色猜值或科学结论。
- mapping 反查只读、重复调用稳定，不修改文档。raw source hash/version 缺失为 unknown；inline 内容哈希不能冒充原始文件 SHA。外层 MCP 工具 `figure_lineage` 另合并 `meta.diagrams` 的来源、历史与科学复核边界。

---

## `FigRender`（`render.js`）

文档 → SVG。**确定性的**（同输入必同输出，函数内不用时间/随机）。

```js
FigRender.toSVG(doc, {scale=1, includeGuides=false}) -> string
//   返回完整 <svg> 字符串，含 viewBox="0 0 W H"（单位 mm）、width/height 为 mm、
//   内联 <defs>（箭头 marker）；元素按 z 升序；panel 有 clipPath。
//   includeGuides=true 时附加锚点虚线框与 id 文本（导出时必须为 false）。
FigRender.elementToSVG(doc, element, {scale=1}) -> string
FigRender.styleToAttrs(style, {dpi=96}) -> object       // pt→px 字号、字体族等
FigRender.anchorBoxes(doc) -> string                    // 锚点虚线框 SVG 片段（编辑器叠加层用）
```

---

## `FigTiff`（`tiff.js`）

**无依赖的 baseline TIFF 编码器**（Little-Endian，未压缩，RGB8，单 Strip 或多 Strip）。

```js
FigTiff.encodeRGBA(rgba, width, height, {dpi=300, multiStrip=true, stripHeight=64}) -> Uint8Array
//   rgba: Uint8ClampedArray|Uint8Array 长度 = w*h*4，RGBA 顺序
//   丢掉 alpha（不做透明合成；调用方先铺白底），输出 PhotometricInterpretation=2 (RGB)
//   必写标签：ImageWidth(256) ImageLength(257) BitsPerSample(258)=[8,8,8]
//   Compression(259)=1 PhotometricInterpretation(262)=2 StripOffsets(273)
//   SamplesPerPixel(277)=3 RowsPerStrip(278) StripByteCounts(279)
//   XResolution(282) YResolution(283) ResolutionUnit(296)=2(inch)
//   PlanarConfiguration(284)=1 Orientation(274)=1
//   分辨率写为 RATIONAL（numerator=round(dpi*100), denominator=100）
FigTiff.decode(bytes) -> {width, height, dpi, samples, rgba}   // 仅用于自测与校验，支持自产文件
FigTiff.isAvailable() -> boolean
```

---

## `FigExport`（`export.js`）

依赖 DOM（canvas / Blob）。v2/v3 可改用服务端导出，但接口保持一致。

MCP 服务端导出统一从同一内核 SVG 出发：`svg` 直接写盘，`pdf` 与位图交给 `mcp/py/figraster.py::export_svg`，由 **PyMuPDF** 完成矢量 PDF 和栅格化，再由 **Pillow** 编码 PNG/JPEG/TIFF、写尺寸与 DPI 元数据；Pillow 只用于编码/复核，不承担科学数据映射。位图/PDF 导出前置依赖是 PyMuPDF 与 Pillow，本机实测 PyMuPDF `1.27.2.2`；没有 PyMuPDF 时明确报错，不倒退到另一套 Pillow 科学绘图实现。自动检查不替代原始数据真实性、字体显示和逐面板视觉人工校对。

```js
FigExport.pixelSize(doc) -> {width, height}            // ceil(mm*dpi/25.4)
FigExport.toSVGBlob(doc) -> Blob                       // type: image/svg+xml
FigExport.toSVGString(doc) -> string
FigExport.toRasterBlob(doc, {format="png"|"jpeg", dpi, quality=0.92}) -> Promise<Blob>
//   流程：FigRender.toSVG → 载入 Image → 绘制到 canvas（白底）→ toBlob
FigExport.toTIFFBlob(doc, {dpi}) -> Promise<Blob>       // toRaster + FigTiff.encodeRGBA
FigExport.download(blob, filename) -> void
FigExport.suggestFilename(doc, ext) -> string           // `${title||id}_${width}x${height}mm_${dpi}dpi.${ext}`
FigExport.exportFormats -> ["png", "jpeg", "tiff", "svg", "pdf"]
FigExport.toPDFBlob(doc) -> Promise<Blob>               // v1 用 SVG 包 PDF 的简实现；v2 交给服务端
```

---

## `FigAI`（`ai.js`）

DeepSeek 客户端与提示词构建。**必须提供无 key 的确定性回退。**

当前 DSH `ctx.llm` 桥仅实现文本 block / `text-delta`：文本聊天可调用，`figure_review` 以结构化文档、期刊预设和检查结果组成提示并解析为结构化意见。本机桥不转换 `image_url`，不支持附图时必须报清能力边界，不能把文本意见冒称为视觉/审美验收。下面的浏览器直连 `FigAI.chat` 可构造图像消息，但视觉直连仍须按用户的实际模型与账号能力测试；不声称已完成真实账号连接。科学数据真实性与最终 PDF 字体/视觉质量始终需要人工复核。

```js
FigAI.DEFAULT_BASE_URL = "https://api.deepseek.com"
FigAI.DEFAULT_MODEL = "deepseek-flash"
FigAI.VISION_MODEL  = "deepseek-flash"

FigAI.config({apiKey, baseUrl, model, visionModel, proxyUrl}) -> void
//   key 为空时 enabled=false。proxyUrl 非空时请求发往 proxyUrl 而不是官方地址（v2 用它避免暴露 key）
FigAI.enabled() -> boolean

// --- 提示词 ---
FigAI.buildEditMessages({doc, instruction, anchors, selection, historyTail}) -> messages
//   system 里内嵌：edit-op.schema 的精简说明 + 当前元素清单(表格:id/type/bbox_mm/text 摘要)
//   + 锚点清单(表格:id/label/bbox_mm/note)；user 里是自然语言指令。
//   要求模型只输出 {"ops":[...],"explanation":"..."} JSON。
FigAI.buildReviewMessages({doc, imageDataUrl, journalPreset, checkResult}) -> messages
//   要求输出 [{"severity":"high|medium|low","target":"<element_id|anchor_id>",
//             "issue":"...","suggestion":"...","op": EditOp|null}] JSON

// --- 调用 ---
FigAI.chat(messages, {json=true, model, timeoutMs=60000, imageDataUrl}) -> Promise<{text, usage, raw}>
//   POST `${baseUrl}/chat/completions`，Authorization: Bearer <key>，body {model, messages, stream:false}
//   图片以 image_url data URL 形式附加在最后一条 user 消息
//   非 2xx 抛 FigAI.AIError（含 status 与响应体前 500 字符）

FigAI.requestOps({doc, instruction, anchors, selection}) -> Promise<{ops, explanation, mode:"model"|"fallback"}>
FigAI.requestReview({doc, imageDataUrl, journalPreset}) -> Promise<{items, mode:"model"|"fallback"}>
FigAI.explainError(err) -> string

// --- 离线确定性回退（无 key / 网络失败 / 解析失败时自动使用，mode="fallback"）---
FigAI.fallbackOps({doc, instruction, anchors, selection}) -> {ops, explanation}
//   解析中文指令中的可识别模式，至少覆盖：
//     "移动/移到 <目标> 到/往 左上|右上|左下|右下|居中" → move(+可选 align)
//     "字号 <n>pt / 字号 <n>" → set_style fontSizePt
//     "加粗/斜体/左对齐/居中/右对齐" → set_style
//     "换成 <palette_name|palette_id> 配色" → recolor
//     "颜色改为 <颜色名|#hex>" → set_color
//     "删除 <目标>" → delete ; "编组 <目标>" → group ; "对齐 <目标>" → align
//     "<目标>" 指 anchor label（如 a、(a)、标题）或元素 id 或 "全体/所有文本"
//   无法识别时返回空 ops 并在 explanation 里说明"离线模式无法理解该指令，请补充关键词"。
FigAI.fallbackReview({doc, journalPreset}) -> {items, explanation}
//   基于 FigPresets.check 的告警 + 规则（字号过小、无锚点、无标题、配色中性缺失、
//   元素越界、对比度不足、面板未对齐）生成意见条目。

FigAI.AIError                     // 错误类，含 .status .body
```

---

## `FigStore`（`storage.js`）

工程与历史的持久化抽象。**接口一致，适配器不同。**

```js
FigStore.use(adapter) -> void
//   adapter: { name, async open(), async saveProject(project), async loadProject(id),
//              async listProjects(), async deleteProject(id), async saveAsset(name, blob),
//              async loadAsset(name) }
FigStore.adapters.localStorage ?       // v1 提供：IndexedDB（主）+ localStorage（降级）
FigStore.adapters.http ?               // v1/v2/v3 提供：POST/GET 到 /api/projects

FigStore.projectFromDoc(doc, {assets={}}) -> project
//   {format:"figure-project", format_version:"1.0", doc, history: doc.history, assets}
//   doc 内的 history 被移到项目顶层（doc.history 置空数组），避免重复存储。
//   meta.history_origin 与其他 meta 一并保留；若 legacy 尚无 origin，只以当前内容播放头补建。
FigStore.docFromProject(project) -> doc
//   顶层 history 回填后，缺失 origin 的导入/重开文档同样以当前内容播放头初始化恢复基线。

FigStore.snapshot(doc, {label, source, checkpoint}) -> Promise<project>   // 落盘 + 生成缩略图
FigStore.thumbnail(doc) -> Promise<string>        // data URL PNG，宽 240px，复用 FigExport
FigStore.exportProjectFile(doc) -> Promise<Blob>  // *.figureproj.json
FigStore.importProjectFile(file) -> Promise<{doc, project}>
FigStore.MIGRATIONS                              // { "1.0": (project)=>project }
```

工作台条件保存另有版本防护：每次 POST 携带本次文档的 `base_token`，与当前服务端不一致时返回 HTTP 409 / `save_conflict` 并停止自动覆盖。本页未确认修改仍保留，先通过「历史 → 导出工程」备份，再刷新核对并手动合并。这是防丢失/防覆盖机制，不承诺常驻多端同步或自动合并冲突。

---

## 契约测试（Phase 2 将执行）

1. `FigDoc.create` → `FigDoc.validate` 通过；`serialize` 输出稳定。
2. `FigOps.applyAll` 对 20 类 op 各跑一条真实用例；非法 op 抛错且不部分应用。
3. `FigPalette` 对 18 套配色做 `hexToRgb`/`hue`/`nearest` 往返一致。
4. `FigRender.toSVG` 对同一 doc 连续两次输出完全相同的字符串。
5. `FigTiff.encodeRGBA` → 写文件 → Python Pillow 打开：尺寸、`tag 282/283` 分辨率（≈dpi）、`tag 259=1`、`tag 262=2` 全部正确。
6. `FigAI.fallbackOps` 对 12 条中文指令给出符合预期的 op。
7. 三版本对同一 `figure-document.json` 渲染出的 PNG 尺寸一致、像素差异 < 2%。
