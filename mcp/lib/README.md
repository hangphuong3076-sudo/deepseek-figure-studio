# `shared/lib` — 三版本共享图形内核

纯 JS 图形编辑内核，供 v1 / v2 / v3 三个版本共用。**无构建步骤、无模块系统（不用 import/export）、无第三方依赖、不引 CDN**；每个文件用 IIFE 把对象挂到 `globalThis`（`typeof globalThis !== 'undefined' ? globalThis : this`），浏览器与 Node 下均可加载，`file://` 协议下可直接运行。

接口唯一事实来源是 [`API.md`](./API.md)（冻结版 v1.0）。函数签名、返回结构、抛错行为以它为准；如需变更，先改 `API.md` 再改实现。数据契约见 [`../schema/figure-document.schema.json`](../schema/figure-document.schema.json) 与 [`../schema/edit-op.schema.json`](../schema/edit-op.schema.json)，期刊/配色/模板预设见 [`../presets/`](../presets/)。

## 加载方式

各版本页面用 `<script src="lib/xxx.js">` 顺序加载，**顺序不可变**（后加载的模块在调用期依赖先加载的模块）：

```html
<script src="lib/figdoc.js"></script>
<script src="lib/diagram.js"></script>
<script src="lib/ops.js"></script>
<script src="lib/science.js"></script>
<script src="lib/palette.js"></script>
<script src="lib/presets.js"></script>
<script src="lib/data.js"></script>
<script src="lib/lineage.js"></script>
<script src="lib/render.js"></script>
<script src="lib/tiff.js"></script>
<script src="lib/export.js"></script>
<script src="lib/ai.js"></script>
<script src="lib/storage.js"></script>
```

加载完成后全局对象依次为：`FigDoc`、`FigDiagram`、`FigOps`、`FigScience`、`FigPalette`、`FigPresets`、`FigData`、`FigLineage`、`FigRender`、`FigTiff`、`FigExport`、`FigAI`、`FigStore`。所有函数默认同步，标注 `async` / 返回 Promise 的除外；非法输入一律抛 `Error`（消息为中文），不做静默降级。

## 各文件一览

| 文件 | 全局对象 | 职责 | DOM 依赖 |
|---|---|---|---|
| `figdoc.js` | `FigDoc` | 文档模型、mm/pt 换算、结构变更与查询 | 无 |
| `diagram.js` | `FigDiagram` | 严格实体—关系合同、原生 group/text/shape/connector 与来源元数据 | 无 |
| `ops.js` | `FigOps` | EditOp 校验与应用、历史/撤销、diff、批准的数据替换 | 无 |
| `science.js` | `FigScience` | 科学合同、统计和数据变更复核审计 | 无 |
| `palette.js` | `FigPalette` | 调色板载入与颜色工具 | 无 |
| `presets.js` | `FigPresets` | 期刊预设、模板推荐、合规检查 | 无 |
| `data.js` | `FigData` | CSV/JSON 解析、列统计、真实图元映射与轻量图表 SVG | 无 |
| `lineage.js` | `FigLineage` | 字段/0 起始 inline 行与真实图元双向反查 | 无 |
| `render.js` | `FigRender` | 文档 → 确定性 SVG；connector 每次按真实 bbox 渲染 | 无 |
| `tiff.js` | `FigTiff` | 无依赖 baseline TIFF 编码/解码 | 无 |
| `export.js` | `FigExport` | SVG/Blob/位图/TIFF/PDF 导出与下载 | 栅格导出需要（见下） |
| `ai.js` | `FigAI` | DeepSeek 客户端与离线回退 | 无（fetch 即可） |
| `storage.js` | `FigStore` | 工程持久化适配器（IndexedDB/http 等） | 取决于适配器 |

`export.js` 依赖 `FigRender` 与 `FigTiff`，并且栅格导出（PNG/JPEG/TIFF/PDF、下载）依赖浏览器 DOM（canvas / Image / Blob / 下载锚点）。在无 DOM 的环境（如 Node）下 `FigExport.isAvailable()` 返回 `false` 而不抛错；`toSVGString` 等纯文本路径仍然可用。

## 当前 bundle 的内核范围

本目录以 `shared/lib` 的基础接口为兼容基线，并为 `deepseek-figure-bundle` 提供自包含扩展，**不声称与其他工程目录逐字节一致**。当前版本标记为 `lib/VERSION = 1.2`。加载顺序扩展为 `figdoc → diagram → ops → science → palette → presets → data → lineage → render → tiff → export → ai → storage`；实体关系、connector 与图表 lineage 以本 bundle 的模块为准。

基础图元、操作和输出格式保持兼容；科学协议、表征渲染与右键发送操作需结合本目录的 `ops.js`、`science.js` 与 `data.js` 的白名单约束使用。其他工程是否同步由各自维护范围决定，不能把本目录的实现版本当作整个框架的统一版本。

## 导出用法示例（FigExport）

```js
var doc = FigDoc.create({ width_mm: 120, height_mm: 90, dpi: 300 });

// SVG
var svg = FigExport.toSVGString(doc);          // 完整 <svg> 字符串
var svgBlob = FigExport.toSVGBlob(doc);        // Blob: image/svg+xml

// 位图（PNG / JPEG，SVG → Image → canvas 白底 → toBlob）
FigExport.toRasterBlob(doc, { format: "png", dpi: 600 }).then(function (blob) {
  FigExport.download(blob, FigExport.suggestFilename(doc, "png"));
});

// TIFF（栅格化后经 FigTiff.encodeRGBA 编码）
FigExport.toTIFFBlob(doc, { dpi: 300 }).then(function (blob) { /* image/tiff */ });

// PDF（v1 简实现：单页 PDF 内嵌渲染图）
FigExport.toPDFBlob(doc).then(function (blob) { /* application/pdf */ });
```

文件名规则：`suggestFilename(doc, ext)` → `` `${title||id}_${width}x${height}mm_${dpi}dpi.${ext}` ``，例如 `figure1_120x90mm_300dpi.png`。
