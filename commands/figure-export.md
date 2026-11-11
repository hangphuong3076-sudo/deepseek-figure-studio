---
description: 检查并导出当前图（PNG/JPEG/TIFF/PDF/SVG，期刊投稿位图建议 TIFF）
argument-hint: "<格式 png|jpeg|tiff|pdf|svg> [输出路径] [dpi]"
---

# /figure-export — 审阅并导出成图文件

## 用途

把当前 FigureDocument 导出为成品文件。所有格式先经同一内核生成 SVG：SVG 直接写盘，PDF 与栅格化由 PyMuPDF 完成，PNG/JPEG/TIFF 再由 Pillow 编码并写尺寸/DPI 元数据。Pillow 不承担科学映射；位图/PDF 导出需要安装 PyMuPDF 与 Pillow（本机实测 PyMuPDF 1.27.2.2），不能只装 Pillow。

## 入参（来自 $ARGUMENTS）

1. `格式`（必填）：`png` | `jpeg` | `tiff` | `pdf` | `svg`。
2. `输出路径`（可选）：建议绝对路径；缺省按 `图题_宽x高mm_dpi.ext` 落在当前目录。
3. `dpi`（可选）：缺省用 `doc.canvas.dpi`（期刊预设通常 300；出版级位图可用 600）。

## 执行步骤

1. 调用 MCP 工具 `figure_check`（参数 `{"doc":<doc>}`）：有 `warnings` 时先转述（字号过小/面板越界/DPI 过低等），问用户是继续导出还是先修；
2. （可选）调用 `figure_render` 生成 SVG 字符串供用户预览或另存 `.svg`；
3. 调用 MCP 工具 `figure_export`，参数 `{"doc":<doc>,"format":"<格式>","dpi":<dpi>,"out_path":"<输出路径>"}`；
4. 向用户报告返回的 `path` / `bytes` / `px`（像素尺寸 = ceil(mm × dpi / 25.4)）。

## 调用的工具

- MCP：`figure_check`（必用）、`figure_render`（可选）、`figure_export`（必用）

## 备注

- 期刊投稿位图推荐 TIFF（本插件写入正确的 XResolution/YResolution 标签）；矢量编辑推荐 SVG/PDF。
- 自动导出不等同于数据真实性或出版质量验收；最终 PDF 的字体、科学表达和逐面板视觉效果仍需人工校对。
- `format` 缺失时不要猜：列出五种格式让用户选。
- 导出前不要手改 `doc.elements`；需要改图走 `figure_apply_edits`。
- 直接调用 `figure_export` 时可传 `panel_id=<一个 panel 或 chart 的实际元素 id>` 单独导出：panel 保留后代和标签范围；chart 按 transform 对 canonical SVG 做 viewBox 裁剪，不改源 doc/canvas/data。未知 id、rect/group 或不可见元素会拒绝且不回退整图。scoped 文件名区分 `_panel-id`/`_chart-id`，返回 `px` 按裁后物理范围计算；`transparent=true` 仍仅 PNG 可用。
