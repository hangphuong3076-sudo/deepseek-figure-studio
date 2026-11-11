---
description: 新建一张科研图文档（可套期刊预设画布）
argument-hint: "[期刊预设id，如 nature-single] [图题]"
---

# /figure-new — 新建图表文档

## 用途

创建一个空的 FigureDocument 画布，作为后续建图/改图/导出的起点。可选套用期刊预设（自动设定栏宽画布、基准字号、推荐 DPI）。

## 入参（来自 $ARGUMENTS）

1. `journal_id`（可选）：期刊/版式预设 id。常见：`nature-single`（Nature 单栏 89×170mm）、`nature-double`、`science-double`、`cell`、`ieee-single`、`elsevier-single`、`acs-single`、`pnas`、`thesis-a4`、`poster-a0`、`slide-16x9`、`custom-blank`。不确定时先调 `figure_journals` 列出全部 28 个预设给用户选。
2. `title`（可选）：图题。缺省用"未命名图"。

## 执行步骤

1. （可选）调用 MCP 工具 `figure_journals` 列出预设，确认 id；
2. 调用 MCP 工具 `figure_create`，参数 `{"journal_id":"<id>","title":"<图题>","dpi":300}`；
3. 取返回的 `doc` 对象作为当前文档，后续所有步骤（建图、改图、导出）都以它为输入；
4. 向用户转述返回中的 `warnings`（如字号低于期刊下限的告警）。

## 调用的工具

- MCP：`figure_create`（必用）、`figure_journals`（列举预设时）

## 备注

- 若用户同时给了数据，直接改走 `/figure-import-data`，它会先建画布再建图，一步到位。
- 画布尺寸后续仍可用 `figure_apply_journal` 换期刊预设，或用 `figure_place` 微调元素位置。
