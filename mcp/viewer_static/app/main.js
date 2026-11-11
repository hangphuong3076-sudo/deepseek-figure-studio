/*
 * main.js — v1-web-app bootstrap (last <script> in index.html).
 *
 * Responsibilities:
 *   1. attach the persistence adapter (Store.attach, FigStore fallback)
 *   2. load presets from ../shared/presets via fetch; on failure use the
 *      inline fallback copies below and tell the user
 *   3. create the default document and install it into App
 *   4. mount every app module in <script> load order
 *   5. mount the side-pane tabs, wire the topbar buttons and the keyboard
 *      shortcut fallback, init the draggable split pane (Editor fits once
 *      after the first mount; window resize never re-fits so the user's
 *      manual zoom survives)
 *   6. print a one-line startup banner to the console
 * All app modules attach to globalThis as IIFEs (no modules, no build).
 */
(function (global) {
    "use strict";

    // ------------------------------------------------------------------
    // Inline fallback preset copies (generated from the real presets/*.json).
    // Generated once from the source JSON; runtime needs no build step.
    // ------------------------------------------------------------------
    var FB_JOURNALS = {
  "version": "1.0",
  "disclaimer": "按公开投稿指南整理，数值可能随期刊更新变化。用于生成默认值，不替代投稿前对目标期刊 Author Guidelines 的核对。每条记录 source 字段给出出处。",
  "fields": {
    "width_mm": "栏宽（单栏/双栏/整页）",
    "height_mm": "推荐最大高度；null 表示未限定",
    "font_family": "正文与标签推荐字体族",
    "base_font_pt": "正文字号（成图后最终尺寸下的磅值）",
    "min_font_pt": "允许的最小学号，低于此值触发告警",
    "dpi_min": "位图最低分辨率",
    "dpi_recommended": "建议导出分辨率",
    "line_width_pt": "推荐线宽",
    "panel_label": "子图标签样式",
    "color_mode": "推荐色彩模式",
    "preferred_formats": "投稿首选格式，按优先级排序",
    "raster_formats": "允许的位图格式",
    "max_file_mb": "单文件大小上限；null 未限定",
    "notes": "补充说明"
  },
  "presets": [
    {
      "id": "nature-single",
      "name": "Nature 单栏",
      "publisher": "Springer Nature",
      "category": "journal",
      "width_mm": 89, "height_mm": 170,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.75,
      "panel_label": "8pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["AI", "EPS", "PDF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "notes": "线条与文字保持可编辑；位图正文 300dpi，照片建议 450dpi。",
      "source": "nature-skills references/nature-article-requirements.md（声称核对于 2026-08-08）；Nature 官网 Figure guidelines——待核对"
    },
    {
      "id": "nature-double",
      "name": "Nature 双栏",
      "publisher": "Springer Nature",
      "category": "journal",
      "width_mm": 183, "height_mm": 170,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.75,
      "panel_label": "8pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["AI", "EPS", "PDF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "notes": "整栏宽；高度上限 170mm。",
      "source": "同 nature-single——待核对"
    },
    {
      "id": "nature-machine-intelligence",
      "name": "Nature Machine Intelligence",
      "publisher": "Springer Nature",
      "category": "journal",
      "width_mm": 183, "height_mm": 200,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 0.75,
      "panel_label": "8pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "EPS", "AI"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": 10,
      "notes": "主图 6 项、Extended Data 最多 10 项。",
      "source": "nature-skills journal-formats/nature-machine-intelligence.md——待核对"
    },
    {
      "id": "nature-communications",
      "name": "Nature Communications",
      "publisher": "Springer Nature",
      "category": "journal",
      "width_mm": 183, "height_mm": 247,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.75,
      "panel_label": "8pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "EPS", "AI"], "raster_formats": ["TIFF", "JPEG", "PNG"],
      "max_file_mb": null,
      "notes": "开放式排版，单栏约 88mm。",
      "source": "nature-skills journal-formats/nature-communications.md——待核对"
    },
    {
      "id": "science-single",
      "name": "Science 单栏",
      "publisher": "AAAS",
      "category": "journal",
      "width_mm": 55, "height_mm": 240,
      "font_family": "Helvetica", "base_font_pt": 6, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["AI", "PDF", "EPS"], "raster_formats": ["TIFF"],
      "max_file_mb": null,
      "notes": "Science 栏宽较窄（1 栏 5.5cm、2 栏 12cm、3 栏 18.4cm）。",
      "source": "Science Author Guidelines（一般公开值）——待核对"
    },
    {
      "id": "science-double",
      "name": "Science 双栏",
      "publisher": "AAAS",
      "category": "journal",
      "width_mm": 120, "height_mm": 240,
      "font_family": "Helvetica", "base_font_pt": 6, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["AI", "PDF", "EPS"], "raster_formats": ["TIFF"],
      "max_file_mb": null,
      "source": "Science Author Guidelines——待核对"
    },
    {
      "id": "science-full",
      "name": "Science 整页 (3栏)",
      "publisher": "AAAS",
      "category": "journal",
      "width_mm": 184, "height_mm": 240,
      "font_family": "Helvetica", "base_font_pt": 6, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["AI", "PDF", "EPS"], "raster_formats": ["TIFF"],
      "max_file_mb": null,
      "source": "Science Author Guidelines——待核对"
    },
    {
      "id": "cell",
      "name": "Cell",
      "publisher": "Elsevier/Cell Press",
      "category": "journal",
      "width_mm": 174, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 0.75,
      "panel_label": "bold 大写 A/B/C",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "EPS", "AI"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "notes": "Cell Press 一般要求 Arial、最小 6pt。",
      "source": "Cell Press Figure Guidelines——待核对"
    },
    {
      "id": "ieee-single",
      "name": "IEEE 单栏",
      "publisher": "IEEE",
      "category": "journal",
      "width_mm": 88, "height_mm": null,
      "font_family": "Times New Roman", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "(a) 8pt",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "EPS"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "notes": "IEEE 单栏约 3.5in（88.9mm）。",
      "source": "IEEE Author Center Graphics Guide——待核对"
    },
    {
      "id": "ieee-double",
      "name": "IEEE 双栏",
      "publisher": "IEEE",
      "category": "journal",
      "width_mm": 182, "height_mm": null,
      "font_family": "Times New Roman", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "(a) 8pt",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "EPS"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "IEEE Author Center Graphics Guide——待核对"
    },
    {
      "id": "elsevier-single",
      "name": "Elsevier 单栏 (1 column)",
      "publisher": "Elsevier",
      "category": "journal",
      "width_mm": 90, "height_mm": null,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 500,
      "line_width_pt": 0.5,
      "panel_label": "a / A",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF", "TIFF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "notes": "Elsevier 常用 90 / 140 / 190 mm 三档。",
      "source": "Elsevier Artwork Guidelines——待核对"
    },
    {
      "id": "elsevier-1.5col",
      "name": "Elsevier 1.5 栏",
      "publisher": "Elsevier",
      "category": "journal",
      "width_mm": 140, "height_mm": null,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 500,
      "line_width_pt": 0.5,
      "panel_label": "a / A",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF", "TIFF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "source": "Elsevier Artwork Guidelines——待核对"
    },
    {
      "id": "elsevier-double",
      "name": "Elsevier 双栏 (2 column)",
      "publisher": "Elsevier",
      "category": "journal",
      "width_mm": 190, "height_mm": null,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 500,
      "line_width_pt": 0.5,
      "panel_label": "a / A",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF", "TIFF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "source": "Elsevier Artwork Guidelines——待核对"
    },
    {
      "id": "springer-single",
      "name": "Springer 单栏",
      "publisher": "Springer",
      "category": "journal",
      "width_mm": 84, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "a / A",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "Springer Artwork Guidelines——待核对"
    },
    {
      "id": "springer-double",
      "name": "Springer 双栏",
      "publisher": "Springer",
      "category": "journal",
      "width_mm": 174, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "a / A",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "Springer Artwork Guidelines——待核对"
    },
    {
      "id": "acs-single",
      "name": "ACS 单栏",
      "publisher": "American Chemical Society",
      "category": "journal",
      "width_mm": 82, "height_mm": 240,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 4.5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["TIFF", "EPS", "PDF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "notes": "ACS 单栏约 3.25in、双栏约 7in；字号可到 4.5pt。",
      "source": "ACS Guidelines for Preparing Graphics——待核对"
    },
    {
      "id": "acs-double",
      "name": "ACS 双栏",
      "publisher": "American Chemical Society",
      "category": "journal",
      "width_mm": 178, "height_mm": 240,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 4.5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["TIFF", "EPS", "PDF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "ACS Guidelines for Preparing Graphics——待核对"
    },
    {
      "id": "pnas",
      "name": "PNAS",
      "publisher": "NAS",
      "category": "journal",
      "width_mm": 87, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "10pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["TIFF", "EPS", "PDF"], "raster_formats": ["TIFF", "JPEG", "PNG"],
      "max_file_mb": 10,
      "notes": "PNAS 单栏 8.7cm、双栏 17.8cm，子图字母 10pt。",
      "source": "PNAS Information for Authors——待核对"
    },
    {
      "id": "pnas-double",
      "name": "PNAS 双栏",
      "publisher": "NAS",
      "category": "journal",
      "width_mm": 178, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "10pt bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["TIFF", "EPS", "PDF"], "raster_formats": ["TIFF", "JPEG", "PNG"],
      "max_file_mb": 10,
      "source": "PNAS Information for Authors——待核对"
    },
    {
      "id": "plos",
      "name": "PLOS ONE",
      "publisher": "PLOS",
      "category": "journal",
      "width_mm": 173, "height_mm": 233,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 0.5,
      "panel_label": "bold 小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF", "TIFF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": 10,
      "notes": "宽度 789–2250 px，300–600 dpi。",
      "source": "PLOS Figure Guidelines——待核对"
    },
    {
      "id": "wiley",
      "name": "Wiley 双栏",
      "publisher": "Wiley",
      "category": "journal",
      "width_mm": 174, "height_mm": 240,
      "font_family": "Arial", "base_font_pt": 7, "min_font_pt": 5,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["EPS", "PDF", "TIFF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "Wiley Data & Figure Guidelines——待核对"
    },
    {
      "id": "rsc",
      "name": "RSC 双栏",
      "publisher": "Royal Society of Chemistry",
      "category": "journal",
      "width_mm": 170, "height_mm": 233,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 600,
      "line_width_pt": 0.5,
      "panel_label": "小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["TIFF", "EPS", "PDF"], "raster_formats": ["TIFF", "PNG"],
      "max_file_mb": null,
      "source": "RSC Author Guidelines (Artwork)——待核对"
    },
    {
      "id": "mdpi",
      "name": "MDPI 整页",
      "publisher": "MDPI",
      "category": "journal",
      "width_mm": 174, "height_mm": 234,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 0.5,
      "panel_label": "小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "TIFF"], "raster_formats": ["TIFF", "PNG", "JPEG"],
      "max_file_mb": null,
      "source": "MDPI Instructions for Authors——待核对"
    },
    {
      "id": "thesis-a4",
      "name": "学位论文 A4 版心",
      "publisher": "generic",
      "category": "thesis",
      "width_mm": 150, "height_mm": 220,
      "font_family": "Times New Roman", "base_font_pt": 9, "min_font_pt": 7,
      "dpi_min": 300, "dpi_recommended": 400,
      "line_width_pt": 0.75,
      "panel_label": "小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "TIFF", "PNG"], "raster_formats": ["TIFF", "PNG", "JPEG"],
      "max_file_mb": null,
      "notes": "中文报告常与宋体/黑体搭配；此处给通用安全值。",
      "source": "通用排版惯例（非期刊官方）"
    },
    {
      "id": "poster-a0",
      "name": "海报 A0",
      "publisher": "generic",
      "category": "poster",
      "width_mm": 841, "height_mm": 1189,
      "font_family": "Arial", "base_font_pt": 28, "min_font_pt": 18,
      "dpi_min": 150, "dpi_recommended": 300,
      "line_width_pt": 3,
      "panel_label": "bold 大写 A/B/C",
      "color_mode": "RGB",
      "preferred_formats": ["PDF", "PNG"], "raster_formats": ["PNG", "JPEG", "TIFF"],
      "max_file_mb": null,
      "source": "通用海报惯例（非期刊官方）"
    },
    {
      "id": "magazine-a4",
      "name": "杂志 A4 整页",
      "publisher": "generic",
      "category": "magazine",
      "width_mm": 210, "height_mm": 297,
      "font_family": "Helvetica", "base_font_pt": 10, "min_font_pt": 8,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 1,
      "panel_label": "小写 a/b/c",
      "color_mode": "CMYK",
      "preferred_formats": ["PDF", "TIFF"], "raster_formats": ["TIFF", "JPEG"],
      "max_file_mb": null,
      "notes": "印刷杂志通常需要 CMYK 与 3mm 出血。",
      "source": "通用印刷惯例（非期刊官方）"
    },
    {
      "id": "slide-16x9",
      "name": "幻灯片 16:9",
      "publisher": "generic",
      "category": "presentation",
      "width_mm": 338.7, "height_mm": 190.5,
      "font_family": "Arial", "base_font_pt": 18, "min_font_pt": 12,
      "dpi_min": 96, "dpi_recommended": 192,
      "line_width_pt": 2,
      "panel_label": "bold 大写 A/B/C",
      "color_mode": "RGB",
      "preferred_formats": ["PNG", "PDF"], "raster_formats": ["PNG", "JPEG"],
      "max_file_mb": null,
      "source": "1920x1080 px @96dpi 换算"
    },
    {
      "id": "custom-blank",
      "name": "自定义空白",
      "publisher": "generic",
      "category": "custom",
      "width_mm": 120, "height_mm": 90,
      "font_family": "Arial", "base_font_pt": 8, "min_font_pt": 6,
      "dpi_min": 300, "dpi_recommended": 300,
      "line_width_pt": 0.75,
      "panel_label": "小写 a/b/c",
      "color_mode": "RGB",
      "preferred_formats": ["PNG", "SVG", "PDF"], "raster_formats": ["PNG", "JPEG", "TIFF"],
      "max_file_mb": null,
      "source": "generic"
    }
  ]
};
    var FB_TEMPLATES = {
  "version": "1.0",
  "disclaimer": "模板为参数化骨架，不含任何第三方仓库代码或图片素材；仅记录结构、映射与推荐规则。",
  "fields": {
    "id": "唯一标识",
    "name": "显示名",
    "category": "chart / diagram / composite",
    "chart_type": "对应 figure-document element.chart.chartType",
    "panels": "默认子图布局 [cols, rows]",
    "recommend_when": "数据特征匹配规则（供模板推荐器解释）",
    "default_mapping": "列角色默认映射",
    "characterization": "可选：表征谱图骨架（technique/x_reverse/x_scale/x_label/y_label/curves/fit_model/fit_source/peak_annotations/normalize/offset_each_series）；curves[].column 引用 default_mapping 的槽名，应用时解析为真实数据列",
    "journal_default": "默认套用的期刊预设 id",
    "palette_default": "默认配色 id",
    "notes": "使用说明"
  },
  "templates": [
    {
      "id": "tpl-bar",
      "name": "单系列柱状图",
      "category": "chart",
      "chart_type": "bar",
      "panels": [
        1,
        1
      ],
      "recommend_when": "1 个类别列(基数 2–12) 且 1 个数值列；类别基数小",
      "default_mapping": {
        "x": "第一列类别",
        "y": "数值列",
        "group": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "适合组间比较；>12 类建议改条形图或折叠。"
    },
    {
      "id": "tpl-bar-grouped",
      "name": "分组柱状图",
      "category": "chart",
      "chart_type": "bar_grouped",
      "panels": [
        1,
        1
      ],
      "recommend_when": "1 类别列 + 1 分组列(基数≤4) + 1 数值列",
      "default_mapping": {
        "x": "类别列",
        "y": "数值列",
        "group": "分组列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "分组数 >4 时改小多图。"
    },
    {
      "id": "tpl-bar-stacked",
      "name": "堆叠柱状图",
      "category": "chart",
      "chart_type": "bar_stacked",
      "panels": [
        1,
        1
      ],
      "recommend_when": "类别列 + 组分列 + 数值列，且组分求和有意义",
      "default_mapping": {
        "x": "类别列",
        "y": "数值列",
        "group": "组分列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "组分≤5；超出改百分比堆叠或拆图。"
    },
    {
      "id": "tpl-line",
      "name": "折线图",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "1 个有序/时间列 + 1 数值列",
      "default_mapping": {
        "x": "时间/序号列",
        "y": "数值列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "时间序列首选；点数 >2000 改抽稀或密度图。"
    },
    {
      "id": "tpl-line-multi",
      "name": "多折线图",
      "category": "chart",
      "chart_type": "line_multi",
      "panels": [
        1,
        1
      ],
      "recommend_when": "时间列 + 数值列 + 分组列(基数 2–6)",
      "default_mapping": {
        "x": "时间列",
        "y": "数值列",
        "group": "分组列"
      },
      "journal_default": "nature-single",
      "palette_default": "aaas",
      "notes": "线数 >6 改小多图或只高亮 1–2 条信号线。"
    },
    {
      "id": "tpl-scatter",
      "name": "散点图",
      "category": "chart",
      "chart_type": "scatter",
      "panels": [
        1,
        1
      ],
      "recommend_when": "2 个数值列",
      "default_mapping": {
        "x": "数值列 1",
        "y": "数值列 2"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "可叠加回归线与 R²/RMSE 注释。"
    },
    {
      "id": "tpl-marginal",
      "name": "边际散点图",
      "category": "chart",
      "chart_type": "marginal",
      "panels": [
        1,
        1
      ],
      "recommend_when": "2 个数值列且需要展示各自分布；n≥30",
      "default_mapping": {
        "x": "数值列 1",
        "y": "数值列 2"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "nature-skills 默认 120x105mm。"
    },
    {
      "id": "tpl-paired",
      "name": "配对比较图",
      "category": "chart",
      "chart_type": "paired",
      "panels": [
        1,
        1
      ],
      "recommend_when": "同一对象的两次测量（2 数值列或 1 数值列+2 水平）",
      "default_mapping": {
        "x": "条件列",
        "y": "数值列",
        "group": "个体 id 列"
      },
      "journal_default": "nature-single",
      "palette_default": "accent-duo",
      "notes": "nature-skills 默认 89x86mm；必须连线展示个体。"
    },
    {
      "id": "tpl-box",
      "name": "箱线图",
      "category": "chart",
      "chart_type": "box",
      "panels": [
        1,
        1
      ],
      "recommend_when": "类别列(基数 2–8) + 数值列",
      "default_mapping": {
        "x": "类别列",
        "y": "数值列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "必须同时显示散点(jitter)，否则审稿常被质疑。"
    },
    {
      "id": "tpl-violin",
      "name": "小提琴图",
      "category": "chart",
      "chart_type": "violin",
      "panels": [
        1,
        1
      ],
      "recommend_when": "类别列 + 数值列，每组 n≥20 且需看分布形状",
      "default_mapping": {
        "x": "类别列",
        "y": "数值列"
      },
      "journal_default": "nature-single",
      "palette_default": "colorbrewer-set2",
      "notes": "n<20 时改用箱线+散点。"
    },
    {
      "id": "tpl-histogram",
      "name": "直方/密度图",
      "category": "chart",
      "chart_type": "histogram",
      "panels": [
        1,
        1
      ],
      "recommend_when": "1 个数值列，看分布",
      "default_mapping": {
        "x": "数值列"
      },
      "journal_default": "nature-single",
      "palette_default": "blues",
      "notes": "需标注 n 与分组带宽。"
    },
    {
      "id": "tpl-heatmap",
      "name": "热图",
      "category": "chart",
      "chart_type": "heatmap",
      "panels": [
        1,
        1
      ],
      "recommend_when": "矩阵数据（2 类别列 + 1 数值列）且需看整体模式",
      "default_mapping": {
        "x": "列类别",
        "y": "行类别",
        "color": "数值列"
      },
      "journal_default": "nature-single",
      "palette_default": "rdbu",
      "notes": "必须给色标与单位；发散数据用发散色板。"
    },
    {
      "id": "tpl-pie",
      "name": "饼图",
      "category": "chart",
      "chart_type": "pie",
      "panels": [
        1,
        1
      ],
      "recommend_when": "类别列(基数 3–6) + 占比列，且占比和为 100%",
      "default_mapping": {
        "x": "类别列",
        "y": "占比列"
      },
      "journal_default": "nature-single",
      "palette_default": "colorbrewer-set2",
      "notes": "期刊常不推荐饼图；>6 类改条形图。"
    },
    {
      "id": "tpl-dotplot",
      "name": "点图 (dotplot)",
      "category": "chart",
      "chart_type": "dotplot",
      "panels": [
        1,
        1
      ],
      "recommend_when": "类别列 + 数值列 + 可选尺寸/颜色列（富信息摘要）",
      "default_mapping": {
        "x": "数值列",
        "y": "类别列",
        "size": "可选列",
        "color": "可选列"
      },
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "nature-skills 默认 183x105mm。"
    },
    {
      "id": "tpl-roc",
      "name": "ROC 曲线",
      "category": "chart",
      "chart_type": "roc",
      "panels": [
        1,
        1
      ],
      "recommend_when": "二分类预测：真值列 + 得分列",
      "default_mapping": {
        "x": "FPR",
        "y": "TPR",
        "group": "模型列"
      },
      "journal_default": "nature-single",
      "palette_default": "aaas",
      "notes": "nature-skills 默认 89x89mm；须标 AUC 与 n。"
    },
    {
      "id": "tpl-volcano",
      "name": "火山图",
      "category": "chart",
      "chart_type": "volcano",
      "panels": [
        1,
        1
      ],
      "recommend_when": "差异分析：log2FC 列 + 显著性列(p/q)",
      "default_mapping": {
        "x": "log2FC",
        "y": "-log10(p)",
        "label": "基因名列"
      },
      "journal_default": "nature-single",
      "palette_default": "accent-duo",
      "notes": "nature-skills 默认 89x82mm；须标阈值线。"
    },
    {
      "id": "tpl-forest",
      "name": "森林图",
      "category": "chart",
      "chart_type": "forest",
      "panels": [
        1,
        1
      ],
      "recommend_when": "效应量 + 置信区间 + 研究/模型列",
      "default_mapping": {
        "x": "效应量",
        "y": "研究列",
        "error": "CI 列"
      },
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "置信区间必须可读；含零线参考。"
    },
    {
      "id": "tpl-survival",
      "name": "生存曲线",
      "category": "chart",
      "chart_type": "survival",
      "panels": [
        1,
        1
      ],
      "recommend_when": "时间列 + 事件列 + 分组列",
      "default_mapping": {
        "x": "时间列",
        "y": "生存率",
        "group": "分组列"
      },
      "journal_default": "nature-single",
      "palette_default": "nejm",
      "notes": "须给风险人数表与 HR/95%CI。"
    },
    {
      "id": "tpl-pca",
      "name": "PCA / 降维散点",
      "category": "chart",
      "chart_type": "pca",
      "panels": [
        1,
        1
      ],
      "recommend_when": "≥3 数值列 + 分组列",
      "default_mapping": {
        "x": "PC1",
        "y": "PC2",
        "group": "分组列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "须标解释方差百分比。"
    },
    {
      "id": "tpl-venn",
      "name": "Venn / UpSet",
      "category": "chart",
      "chart_type": "venn",
      "panels": [
        1,
        1
      ],
      "recommend_when": "2–3 个集合成员标记列",
      "default_mapping": {
        "label": "集合列"
      },
      "journal_default": "nature-single",
      "palette_default": "colorbrewer-set2",
      "notes": ">4 集合改 UpSet。"
    },
    {
      "id": "tpl-sankey",
      "name": "桑基图",
      "category": "chart",
      "chart_type": "sankey",
      "panels": [
        1,
        1
      ],
      "recommend_when": "源列 + 目标列 + 权重列（流向）",
      "default_mapping": {
        "x": "源列",
        "y": "目标列",
        "size": "权重列"
      },
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "节点 ≤15，否则不可读。"
    },
    {
      "id": "tpl-taylor",
      "name": "Taylor 图",
      "category": "chart",
      "chart_type": "taylor",
      "panels": [
        1,
        1
      ],
      "recommend_when": "多模型评估：相关系数 + 标准差",
      "default_mapping": {
        "group": "模型列"
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "气象/海洋领域常用。"
    },
    {
      "id": "tpl-diagram-flow",
      "name": "流程示意图",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；用户提供步骤文字或参考图",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "内置原生形状（矩形/圆/箭头）+ 文本，禁止位图底图冒充矢量。"
    },
    {
      "id": "tpl-diagram-arch",
      "name": "模型/系统架构图",
      "category": "diagram",
      "chart_type": "diagram_architecture",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；用户提供模块清单或参考图",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "分层堆叠（数据层/编码器/解码器/输出）+ 实心箭头表示前向、虚线表示反馈。"
    },
    {
      "id": "tpl-composite-2x2",
      "name": "2x2 复合主图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        2,
        2
      ],
      "recommend_when": "多组数据且存在 1 个主论点 + 3 个支撑面板",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a) 承担主论点；(b)(c)(d) 依次为对照/分解/验证。面板标签 8pt bold。"
    },
    {
      "id": "tpl-composite-1x3",
      "name": "1x3 横向复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        3,
        1
      ],
      "recommend_when": "同类型指标在 3 个条件下的并列展示",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "aaas",
      "notes": "共享 y 轴；仅最左侧标注刻度值。"
    },
    {
      "id": "tpl-composite-schematic",
      "name": "示意图+量化 复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        2,
        1
      ],
      "recommend_when": "上方机制示意、下方定量证据",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "(a) 示意 (b) 量化；上下面板宽度必须对齐（1.5pt 容差）。"
    },
    {
      "id": "tpl-diagram-pipeline",
      "name": "数据处理流水线",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；用户提供采集→清洗→训练→输出等线性多步骤处理链",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "横向单行步骤节点（矩形+实心箭头）；步骤文字为可编辑矢量元素，流向由用户摆放，不自动生成路由。"
    },
    {
      "id": "tpl-diagram-decision",
      "name": "判断分支流程图",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；流程含条件判断与是/否分支走向",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "菱形判断节点 + 是/否两条分支；分支文字可编辑，走向为手动布置的示意，不做自动布局。"
    },
    {
      "id": "tpl-diagram-loop",
      "name": "闭环迭代流程图",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；需要强调迭代闭环（如训练-验证-更新）",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "前向实心箭头 + 虚线反馈回路；回路起止由用户拖拽调整，不自动推导反馈逻辑。"
    },
    {
      "id": "tpl-diagram-experiment",
      "name": "实验流程图",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；实验设计叙述（分组→处理→测定→分析）",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "样本节点分叉为处理/对照两组再汇合到测定与分析；组名可改，分组依据由用户文字补充。"
    },
    {
      "id": "tpl-diagram-swimlane",
      "name": "泳道职责流程图",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；跨阶段/跨角色需要划分职责边界",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "两条泳道（平台/实验）内布置职责节点；泳道为背景矩形，节点与跨泳道箭头均为示意。"
    },
    {
      "id": "tpl-diagram-timeline",
      "name": "阶段时间线",
      "category": "diagram",
      "chart_type": "diagram_flow",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；按时间阶段描述研究/项目推进",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "横向时间轴 + 阶段里程碑节点；阶段名可编辑，刻度非真实时间数据。"
    },
    {
      "id": "tpl-diagram-hierarchy",
      "name": "层级分解架构图",
      "category": "diagram",
      "chart_type": "diagram_architecture",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；研究任务/软件模块自顶向下分解",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "根节点→子模块→子项两层层级树；层级由用户布局，不自动排树。"
    },
    {
      "id": "tpl-diagram-model",
      "name": "网络模型结构图",
      "category": "diagram",
      "chart_type": "diagram_architecture",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；深度模型输入→编码器→解码器→输出结构",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "块内横线表示堆叠层；层数为示意，块与连线均可编辑，前向实心箭头由用户布置。"
    },
    {
      "id": "tpl-diagram-compare",
      "name": "方案对比架构图",
      "category": "diagram",
      "chart_type": "diagram_architecture",
      "panels": [
        1,
        1
      ],
      "recommend_when": "无数据；基线方案与改进方案并列对比",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "nature-skills-6",
      "notes": "左右两列堆叠块各表示一条方案流水线；中间虚线箭头仅作对比提示，非自动映射。"
    },
    {
      "id": "tpl-composite-1x2-v",
      "name": "上下两联复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        1,
        2
      ],
      "recommend_when": "主图在上、残差/延伸分析在下的两行版式",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a) 主结果 (b) 残差或次级分布；共享 x 轴时仅下面板标刻度。"
    },
    {
      "id": "tpl-composite-1x3-v",
      "name": "三行堆叠复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        1,
        3
      ],
      "recommend_when": "同一 x 轴下三个条件/指标纵向对齐比较",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "aaas",
      "notes": "三行共享 x 轴；仅最左列标 y 刻度，行间距保持一致。"
    },
    {
      "id": "tpl-composite-1x4-v",
      "name": "纵向四联复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        1,
        4
      ],
      "recommend_when": "四个时间点/处理梯度自上而下排列",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "okabe-ito",
      "notes": "(a)–(d) 纵向递进；适合条件逐级增强的展示。"
    },
    {
      "id": "tpl-composite-1x4-h",
      "name": "横向四联复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        4,
        1
      ],
      "recommend_when": "同一指标在四个条件下的并列展示",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a)–(d) 从左到右；共享 y 轴，仅最左列标刻度。"
    },
    {
      "id": "tpl-composite-3x2",
      "name": "六面板复合图 (3列×2行)",
      "category": "composite",
      "chart_type": null,
      "panels": [
        3,
        2
      ],
      "recommend_when": "1 个主论点 + 5 个支撑面板的双行版式",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a) 主论点；(b)–(f) 对照/分解/验证；标签按行优先。"
    },
    {
      "id": "tpl-composite-2x3",
      "name": "六面板复合图 (2列×3行)",
      "category": "composite",
      "chart_type": null,
      "panels": [
        2,
        3
      ],
      "recommend_when": "面板较多且画布偏竖（3 行 2 列），如多基因/多脑区",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "colorbrewer-set2",
      "notes": "行优先标签 a–f；竖排适合双栏图的纵向空间。"
    },
    {
      "id": "tpl-composite-4x2",
      "name": "八面板复合图 (4列×2行)",
      "category": "composite",
      "chart_type": null,
      "panels": [
        4,
        2
      ],
      "recommend_when": "大型主图（8 面板，2 行 4 列）",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "aaas",
      "notes": "(a)–(h)；建议 1–2 个放大面板承载主论点，字号不小于 7pt。"
    },
    {
      "id": "tpl-composite-2x4",
      "name": "八面板复合图 (2列×4行)",
      "category": "composite",
      "chart_type": null,
      "panels": [
        2,
        4
      ],
      "recommend_when": "竖版八面板（4 行 2 列），适合整页图版",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "colorbrewer-paired",
      "notes": "(a)–(h) 行优先；整页图版注意行间距与面板宽度一致。"
    },
    {
      "id": "tpl-composite-3x3",
      "name": "九面板全景复合图",
      "category": "composite",
      "chart_type": null,
      "panels": [
        3,
        3
      ],
      "recommend_when": "系统性结果总览（3×3 九面板）",
      "default_mapping": {},
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a)–(i)；建议按主题分行：测量/机制/验证。"
    },
    {
      "id": "tpl-xps-survey",
      "name": "XPS 全谱",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "结合能列 + 强度列（XPS 全谱）",
      "default_mapping": {
        "x": "结合能数值列",
        "y": "强度数值列",
        "group": null
      },
      "characterization": {
        "technique": "XPS survey",
        "x_reverse": true,
        "x_scale": "linear",
        "x_label": "Binding energy (eV)",
        "y_label": "Intensity (counts)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "结合能轴按惯例反转（高结合能在左）；单位为 XPS 惯例申报，如与你的数据不符请在属性面板修改。"
    },
    {
      "id": "tpl-xps-highres-fit",
      "name": "XPS 高分辨拟合谱",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "结合能列 + 原始强度列 + 用户已拟合的拟合/基线/组分列",
      "default_mapping": {
        "x": "结合能数值列",
        "y": "原始强度数值列",
        "fit": "拟合曲线数值列",
        "baseline": "基线数值列",
        "comp1": "组分1数值列",
        "comp2": "组分2数值列"
      },
      "characterization": {
        "technique": "XPS high-resolution",
        "x_reverse": true,
        "x_scale": "linear",
        "x_label": "Binding energy (eV)",
        "y_label": "Intensity (counts)",
        "curves": [
          {
            "role": "fit",
            "column": "fit",
            "label": "fit"
          },
          {
            "role": "baseline",
            "column": "baseline",
            "label": "baseline"
          },
          {
            "role": "component",
            "column": "comp1",
            "label": null
          },
          {
            "role": "component",
            "column": "comp2",
            "label": null
          }
        ],
        "fit_model": null,
        "fit_source": "provided_by_user_fit",
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "拟合/基线/组分全部来自你自己的曲线列（不在此拟合）；峰标注在属性面板按 {x, 标签} 添加，不给默认峰名。缺拟合列时该曲线移除并提示。"
    },
    {
      "id": "tpl-xps-two-regions",
      "name": "XPS 双区域对照 (2×1)",
      "category": "composite",
      "chart_type": "line",
      "panels": [
        2,
        1
      ],
      "recommend_when": "两个结合能区域各一张高分辨谱（复合版式）",
      "default_mapping": {
        "x": "结合能数值列",
        "y": "强度数值列",
        "group": null
      },
      "characterization": {
        "technique": "XPS high-resolution",
        "x_reverse": true,
        "x_scale": "linear",
        "x_label": "Binding energy (eV)",
        "y_label": "Intensity (counts)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-double",
      "palette_default": "npg",
      "notes": "(a)(b) 各映射一个区域：默认两面板映射同一数据列，请在属性面板把 (b) 的 mapping 与曲线列改为第二区域列；区域/元素名不做自动猜测。"
    },
    {
      "id": "tpl-raman-single",
      "name": "Raman 单谱",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "拉曼位移列 + 强度列",
      "default_mapping": {
        "x": "拉曼位移数值列",
        "y": "强度数值列",
        "group": null
      },
      "characterization": {
        "technique": "Raman",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Raman shift (cm⁻¹)",
        "y_label": "Intensity (a.u.)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "拉曼位移轴常规升序（左→右增大）；峰标注由用户在属性面板申报。"
    },
    {
      "id": "tpl-raman-multi-compare",
      "name": "Raman 多样品对比",
      "category": "chart",
      "chart_type": "line_multi",
      "panels": [
        1,
        1
      ],
      "recommend_when": "拉曼位移列 + 强度列 + 样品分组列",
      "default_mapping": {
        "x": "拉曼位移数值列",
        "y": "强度数值列",
        "group": "样品分组列"
      },
      "characterization": {
        "technique": "Raman",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Raman shift (cm⁻¹)",
        "y_label": "Intensity (a.u.)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "max_to_unity",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "aaas",
      "notes": "本模板显式申报 max_to_unity 渲染归一（原始数据不变）；需要堆叠时在属性面板设置 offset_each_series（仅视觉位移）。"
    },
    {
      "id": "tpl-xrd",
      "name": "XRD 衍射谱",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "2θ 列 + 强度列",
      "default_mapping": {
        "x": "2θ数值列",
        "y": "强度数值列",
        "group": null
      },
      "characterization": {
        "technique": "XRD",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "2θ (°)",
        "y_label": "Intensity (counts)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "2θ 升序；衍射峰位置标注由用户以 {x, 标签} 申报，不做物相自动指认。"
    },
    {
      "id": "tpl-ftir",
      "name": "FTIR 红外谱",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "波数列 + 透过率（或吸光度）列",
      "default_mapping": {
        "x": "波数数值列",
        "y": "透过率数值列",
        "group": null
      },
      "characterization": {
        "technique": "FTIR",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Wavenumber (cm⁻¹)",
        "y_label": "Transmittance (%)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "纵轴以你的列为准：透过率数据保留 Transmittance (%)，吸光度数据请在属性面板把 y_label 改为 Absorbance；轴向可按需反转。"
    },
    {
      "id": "tpl-uvvis-pl",
      "name": "UV-Vis / PL 光谱",
      "category": "chart",
      "chart_type": "line_multi",
      "panels": [
        1,
        1
      ],
      "recommend_when": "波长列 + 信号列 + 光谱类型分组列（吸收/发射）",
      "default_mapping": {
        "x": "波长数值列",
        "y": "信号强度数值列",
        "group": "光谱类型分组列"
      },
      "characterization": {
        "technique": "UV-Vis/PL",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Wavelength (nm)",
        "y_label": "Intensity (a.u.)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "aaas",
      "notes": "吸收/发射共用波长轴；纵轴标签按你的数据（吸光度/强度）修改。"
    },
    {
      "id": "tpl-eis-nyquist",
      "name": "EIS Nyquist 图",
      "category": "chart",
      "chart_type": "scatter",
      "panels": [
        1,
        1
      ],
      "recommend_when": "阻抗实部 Z′ 列 + 负虚部 −Z″ 列",
      "default_mapping": {
        "x": "实部Z′数值列",
        "y": "负虚部−Z″数值列",
        "group": null
      },
      "characterization": {
        "technique": "EIS Nyquist",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Z′ (Ω)",
        "y_label": "−Z″ (Ω)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "两轴同单位（Ω）等比呈现；请提供 −Z″（虚部取负后）列——框架不改写你的原始数值。"
    },
    {
      "id": "tpl-eis-bode",
      "name": "EIS Bode 图",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "频率列 + 阻抗模（或相位）列",
      "default_mapping": {
        "x": "频率数值列",
        "y": "阻抗模数值列",
        "group": null
      },
      "characterization": {
        "technique": "EIS Bode",
        "x_reverse": false,
        "x_scale": "log10",
        "x_label": "Frequency (Hz)",
        "y_label": "|Z| (Ω)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "频率轴 log10；非正频率点不计入并显式标注排除数；相位谱请另建面板并把 y 列改为相位。"
    },
    {
      "id": "tpl-cv",
      "name": "循环伏安 (CV) 曲线",
      "category": "chart",
      "chart_type": "line_multi",
      "panels": [
        1,
        1
      ],
      "recommend_when": "电位列 + 电流列 + 循环/样品分组列",
      "default_mapping": {
        "x": "电位数值列",
        "y": "电流数值列",
        "group": "循环分组列"
      },
      "characterization": {
        "technique": "CV",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Potential (V)",
        "y_label": "Current (A)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "多圈循环按分组列画多条线；单位按你的电化学工作站导出修改。"
    },
    {
      "id": "tpl-stress-strain",
      "name": "应力-应变曲线",
      "category": "chart",
      "chart_type": "line_multi",
      "panels": [
        1,
        1
      ],
      "recommend_when": "应变列 + 应力列 + 试样分组列",
      "default_mapping": {
        "x": "应变数值列",
        "y": "应力数值列",
        "group": "试样分组列"
      },
      "characterization": {
        "technique": "Tensile",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Strain (%)",
        "y_label": "Stress (MPa)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "每条试样曲线保留原始数据；模量/强度等统计另行申报，不在此自动计算。"
    },
    {
      "id": "tpl-particle-size",
      "name": "粒径分布直方图",
      "category": "chart",
      "chart_type": "histogram",
      "panels": [
        1,
        1
      ],
      "recommend_when": "粒径数值列（看分布）",
      "default_mapping": {
        "x": "粒径数值列"
      },
      "characterization": {
        "technique": "PSD",
        "x_reverse": false,
        "x_scale": "linear",
        "x_label": "Particle size (nm)",
        "y_label": "Count",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "blues",
      "notes": "直方图为真实计数；如需拟合分布（如 log-normal）请提供你自己的拟合列另建面板。"
    },
    {
      "id": "tpl-nmr",
      "name": "NMR 谱 (化学位移)",
      "category": "chart",
      "chart_type": "line",
      "panels": [
        1,
        1
      ],
      "recommend_when": "化学位移列 + 信号强度列",
      "default_mapping": {
        "x": "化学位移数值列",
        "y": "信号强度数值列",
        "group": null
      },
      "characterization": {
        "technique": "NMR",
        "x_reverse": true,
        "x_scale": "linear",
        "x_label": "Chemical shift (ppm)",
        "y_label": "Intensity (a.u.)",
        "curves": [],
        "fit_model": null,
        "fit_source": null,
        "peak_annotations": [],
        "normalize": "none",
        "offset_each_series": null
      },
      "journal_default": "nature-single",
      "palette_default": "npg",
      "notes": "化学位移轴按 NMR 惯例反转（高 ppm 在左）；峰归属由用户申报，不做自动指认。"
    }
  ]
};
    var FB_PALETTES = {
  "version": "1.0",
  "disclaimer": "配色数据来自公开仓库，已标注来源与许可。原仓库对色值的整理本身可能来自第三方文章，商用前请自行核对。",
  "fields": {
    "id": "唯一标识",
    "name": "显示名",
    "category": "journal / qualitative / sequential / diverging / categorical / accent",
    "colors": "hex 数组，按推荐使用顺序排列",
    "roles": "可选：把颜色映射到语义角色（primary/signal/neutral/accent...）",
    "source": "出处",
    "license": "许可"
  },
  "palettes": [
    {
      "id": "npg", "name": "NPG (Nature 系)", "category": "journal",
      "colors": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000", "#7E6148", "#B09C85"],
      "roles": { "primary": "#3C5488", "signal": "#E64B35", "accent": "#00A087", "neutral": "#8491B4" },
      "source": "xuhangc/PythonResearchPaperPlot 第1章 图1-2-10；前四色 #E64B35 #4DBBD5 #00A087 #3C5488，其余为 ggsci::pal_npg 常见扩展",
      "license": "MIT (仓库) / ggsci 原色表"
    },
    {
      "id": "aaas", "name": "AAAS (Science 系)", "category": "journal",
      "colors": ["#3B4992", "#EE0000", "#008B45", "#631879", "#008280", "#BB0021", "#5F559B", "#A20056", "#808180", "#1B1919"],
      "roles": { "primary": "#3B4992", "signal": "#EE0000", "accent": "#008B45", "neutral": "#808180" },
      "source": "xuhangc/PythonResearchPaperPlot 第1章 图1-2-10；前四色 #3B4992 #EE0000 #008B45 #631879",
      "license": "MIT (仓库)"
    },
    {
      "id": "nejm", "name": "NEJM", "category": "journal",
      "colors": ["#BC3C29", "#0072B5", "#E18727", "#20854E", "#7876B1", "#6F99AD", "#FFDC91", "#EE4C97"],
      "roles": { "primary": "#0072B5", "signal": "#BC3C29", "accent": "#20854E", "neutral": "#6F99AD" },
      "source": "xuhangc/PythonResearchPaperPlot 第1章 图1-2-10；前四色",
      "license": "MIT (仓库)"
    },
    {
      "id": "lancet", "name": "Lancet", "category": "journal",
      "colors": ["#00468B", "#ED0000", "#42B540", "#0099B4", "#925E9F", "#FDAF91", "#AD002A", "#ADB6B6", "#1B1919"],
      "source": "ggsci::pal_lancet（经由 lcpmgh/colors @palettes.csv 整理）",
      "license": "MIT (lcpmgh/colors)"
    },
    {
      "id": "jco", "name": "JCO", "category": "journal",
      "colors": ["#0073C2", "#EFC000", "#868686", "#CD534C", "#7AA6DC", "#003C67", "#8F7700", "#3B3B3B", "#A73030", "#4A6990"],
      "source": "ggsci::pal_jco（经由 lcpmgh/colors 整理）",
      "license": "MIT (lcpmgh/colors)"
    },
    {
      "id": "npg-classic", "name": "NPG 经典四色", "category": "journal",
      "colors": ["#E64B35", "#4DBBD5", "#00A087", "#3C5488"],
      "source": "xuhangc/PythonResearchPaperPlot 图1-2-10",
      "license": "MIT (仓库)"
    },
    {
      "id": "nature-skills-6", "name": "nature-skills 六色", "category": "journal",
      "colors": ["#2166AC", "#B2182B", "#1B7837", "#F1A340", "#762A83", "#666666"],
      "roles": { "primary": "#2166AC", "signal": "#B2182B", "accent": "#1B7837", "neutral": "#666666" },
      "source": "Yuan1z0825/nature-skills skills/nature-figure/scripts/plot_templates.py PALETTE",
      "license": "Apache-2.0"
    },
    {
      "id": "show2know-01", "name": "Show2Know 01", "category": "qualitative",
      "colors": ["#8ECFC9", "#FFBE7A", "#FA7F6F", "#82B0D2", "#BEB8DC", "#E7DAD2"],
      "source": "Winn1y/Show2Know 0 Collection and Color/Color/PaperColorTemple.md",
      "license": "Apache-2.0"
    },
    {
      "id": "show2know-05", "name": "Show2Know 05 (12色)", "category": "qualitative",
      "colors": ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD", "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF", "#AEC7E8", "#FFBB78"],
      "source": "Winn1y/Show2Know PaperColorTemple.md（等价 matplotlib tab20 子集）",
      "license": "Apache-2.0"
    },
    {
      "id": "okabe-ito", "name": "Okabe-Ito 色盲友好", "category": "qualitative",
      "colors": ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#666666"],
      "roles": { "primary": "#0072B2", "signal": "#D55E00", "accent": "#009E73", "neutral": "#666666" },
      "source": "Okabe & Ito (2008) 公开色板",
      "license": "public domain"
    },
    {
      "id": "colorbrewer-set2", "name": "ColorBrewer Set2", "category": "qualitative",
      "colors": ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
      "source": "ColorBrewer 2.0 (Cynthia Brewer)",
      "license": "Apache-2.0 (ColorBrewer)"
    },
    {
      "id": "colorbrewer-dark2", "name": "ColorBrewer Dark2", "category": "qualitative",
      "colors": ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
      "source": "ColorBrewer 2.0",
      "license": "Apache-2.0 (ColorBrewer)"
    },
    {
      "id": "viridis", "name": "Viridis", "category": "sequential",
      "colors": ["#440154", "#414487", "#2A788E", "#22A884", "#7AD151", "#FDE725"],
      "source": "matplotlib viridis（采样点）",
      "license": "CC0 / matplotlib BSD"
    },
    {
      "id": "magma", "name": "Magma", "category": "sequential",
      "colors": ["#000004", "#3B0F70", "#8C2981", "#DE4968", "#FE9F6D", "#FCFDBF"],
      "source": "matplotlib magma（采样点）",
      "license": "CC0 / matplotlib BSD"
    },
    {
      "id": "blues", "name": "Blues", "category": "sequential",
      "colors": ["#F7FBFF", "#DEEBF7", "#C6DBEF", "#9ECAE1", "#6BAED6", "#4292C6", "#2171B5", "#08519C", "#08306B"],
      "source": "ColorBrewer Blues",
      "license": "Apache-2.0 (ColorBrewer)"
    },
    {
      "id": "rdbu", "name": "RdBu (发散)", "category": "diverging",
      "colors": ["#67001F", "#B2182B", "#D6604D", "#F4A582", "#FDDBC7", "#F7F7F7", "#D1E5F0", "#92C5DE", "#4393C3", "#2166AC", "#053061"],
      "source": "ColorBrewer RdBu",
      "license": "Apache-2.0 (ColorBrewer)"
    },
    {
      "id": "grayscale", "name": "灰度（黑白印刷安全）", "category": "categorical",
      "colors": ["#000000", "#404040", "#737373", "#A6A6A6", "#D9D9D9", "#FFFFFF"],
      "source": "generic",
      "license": "public domain"
    },
    {
      "id": "accent-duo", "name": "中性+信号 双色（审阅友好）", "category": "accent",
      "colors": ["#666666", "#B2182B"],
      "roles": { "neutral": "#666666", "signal": "#B2182B" },
      "source": "nature-skills 配色指导：一中性 + 一信号 + 一强调，禁用红绿与彩虹色",
      "license": "Apache-2.0"
    }
  ]
};

    var PRESET_BASES = [
        "../shared/presets/",
        "../../shared/presets/",
        "shared/presets/",
        "/shared/presets/"
    ];
    var FETCH_TIMEOUT_MS = 4000;
    var ZOOM_STEP = 1.2;

    function msgOf(err) {
        return (err && err.message) ? err.message : String(err);
    }

    function warn(text) {
        console.warn("[main] " + text);
    }

    function has(name) {
        return !!global[name];
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function pickEl(ids) {
        for (var i = 0; i < ids.length; i++) {
            var el = byId(ids[i]);
            if (el) return el;
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Runtime capabilities and honest rendering. The small type list is a
    // conservative pre-T2 fallback only; FigData's live API is authoritative.
    // ------------------------------------------------------------------

    var FALLBACK_RENDER_TYPES = [
        "bar", "bar_grouped", "line", "line_multi", "scatter", "area",
        "pie", "histogram", "heatmap", "box"
    ];
    var CAPABILITY_TEXT = {
        full: "full：本地真实 SVG（需有效数据）",
        layout: "layout：仅创建空版式，不自动填图",
        unsupported: "unsupported：仅示意，暂不支持真实生成，禁止应用"
    };
    var runtimeInstalled = false;

    function liveRenderTypes() {
        var fd = global.FigData;
        if (!fd) return [];
        if (typeof fd.supportsChartType === "function") {
            var declared = [];
            var source = Array.isArray(fd.chartTypes) ? fd.chartTypes :
                Array.isArray(fd.supportedChartTypes) ? fd.supportedChartTypes :
                    Object.keys(FB_TEMPLATES.templates.reduce(function (out, tpl) {
                        if (tpl.chart_type) out[tpl.chart_type] = true;
                        return out;
                    }, {}));
            for (var i = 0; i < source.length; i++) {
                try {
                    if (fd.supportsChartType(source[i]) === true) declared.push(source[i]);
                } catch (err) { /* unknown types stay unsupported */ }
            }
            return declared;
        }
        var listed = Array.isArray(fd.chartTypes) ? fd.chartTypes : fd.supportedChartTypes;
        if (Array.isArray(listed)) {
            return listed.filter(function (type) { return typeof type === "string"; });
        }
        return FALLBACK_RENDER_TYPES.slice();
    }

    function capabilityOf(tpl) {
        if (tpl && tpl.capability && typeof tpl.capability.status === "string") return tpl.capability.status;
        if (tpl && tpl.category === "diagram" && global.FigDiagram &&
            typeof global.FigDiagram.supportsTemplate === "function" &&
            global.FigDiagram.supportsTemplate(tpl).supported) return "full";
        if (tpl && global.FigData && typeof global.FigData.templateCapability === "function") {
            try {
                var cap = global.FigData.templateCapability(tpl);
                if (cap && CAPABILITY_TEXT[cap.capability]) return cap.capability;
            } catch (err) { /* use the conservative structural fallback below */ }
        }
        var types = liveRenderTypes();
        if (tpl && tpl.chart_type && types.indexOf(tpl.chart_type) >= 0) return "full";
        if (tpl && tpl.category === "composite" && !tpl.chart_type) return "layout";
        return "unsupported";
    }

    function templateRecord(tpl) {
        if (!tpl) return null;
        var out = {};
        Object.keys(tpl).forEach(function (key) { out[key] = tpl[key]; });
        out.capability = capabilityOf(tpl);
        out.capability_description = CAPABILITY_TEXT[out.capability];
        return out;
    }

    function capabilityList() {
        return FB_TEMPLATES.templates.map(templateRecord);
    }

    function capabilityForId(id) {
        var tpl = null;
        if (has("FigPresets") && typeof FigPresets.template === "function") {
            try { tpl = FigPresets.template(id); }
            catch (err) { /* unloaded live presets: use the complete inline copy */ }
        }
        if (!tpl) {
            for (var i = 0; i < FB_TEMPLATES.templates.length; i++) {
                if (FB_TEMPLATES.templates[i].id === id) {
                    tpl = FB_TEMPLATES.templates[i];
                    break;
                }
            }
        }
        if (!tpl) throw new Error("未找到模板：" + id);
        return templateRecord(tpl);
    }

    function requireTemplateApplicable(id) {
        var tpl = capabilityForId(id);
        if (tpl.capability === "unsupported") {
            throw new Error("模板「" + tpl.name + "」仅为结构示意，当前没有本地真实 SVG 生成实现；已禁止应用，不会导出占位图");
        }
        if (tpl.capability === "layout") return tpl;
        if (tpl.category === "diagram" && global.FigDiagram &&
            global.FigDiagram.supportsTemplate(tpl).supported) return tpl;
        if (liveRenderTypes().indexOf(tpl.chart_type) < 0) {
            throw new Error("模板「" + tpl.name + "」所需 chartType=" + tpl.chart_type + " 当前不可真实渲染，已禁止应用");
        }
        return tpl;
    }

    function hasInlineRows(data) {
        return !!(data && Array.isArray(data.columns) && data.columns.length &&
            Array.isArray(data.rows) && data.rows.length);
    }

    function existingInlineData(doc) {
        var els = doc && Array.isArray(doc.elements) ? doc.elements : [];
        for (var i = 0; i < els.length; i++) {
            var chart = els[i] && els[i].type === "chart" && els[i].chart;
            if (chart && chart.data && hasInlineRows(chart.data.inline)) return chart.data.inline;
        }
        return null;
    }

    function checkTemplateData(tpl, data) {
        if (tpl.capability === "full" && tpl.category !== "diagram" && !hasInlineRows(data)) {
            throw new Error("模板「" + tpl.name + "」需要包含数据列与数据行的输入；不会生成无数据占位图。复合空版式请改用 layout 模板");
        }
    }

    function validateTemplateOps(ops) {
        if (!Array.isArray(ops)) return;
        ops.forEach(function (op) {
            if (op && op.op === "apply_template") requireTemplateApplicable(op.template_id);
        });
    }

    function phase5Error(chart, err) {
        var type = chart && chart.chartType ? chart.chartType : "?";
        var reason = msgOf(err).replace(/[，；]?该图表类型需 v2 服务端渲染/g, "");
        return new Error("图表 chartType=" + type + " 未能真实生成 SVG：" + reason + "；已禁止把占位图当作成功结果");
    }

    function scopedCharts(doc, panelId) {
        var els = doc && Array.isArray(doc.elements) ? doc.elements : [];
        if (panelId === undefined || panelId === null) {
            return els.filter(function (el) { return el && el.type === "chart"; });
        }
        var root = null;
        var rootCount = 0;
        for (var i = 0; i < els.length; i++) if (els[i].id === panelId) {
          root = els[i];
          rootCount += 1;
        }
        if (rootCount !== 1 || !root ||
            (root.type !== "panel" && root.type !== "chart")) {
          throw new Error("panel_id 必须指向唯一有效的 panel 或 chart：" + panelId);
        }
        if (root.type === "chart") return [root];
        var ids = {};
        function visit(id) {
            if (ids[id]) return;
            ids[id] = true;
            els.forEach(function (el) {
                if (el && el.parent_id === id) visit(el.id);
            });
        }
        visit(panelId);
        return els.filter(function (el) { return el && el.type === "chart" && ids[el.id]; });
    }

    function chartBoxMm(doc, el) {
        if (has("ChartRender") && typeof ChartRender.resolveBoxMm === "function") {
            return ChartRender.resolveBoxMm(doc, el);
        }
        return el.transform || { x: 0, y: 0, w: 0, h: 0 };
    }

    function isEmptyLayoutChart(chart) {
        if (!chart || (chart.chartType !== null && chart.chartType !== undefined)) return false;
        var mapping = chart.mapping || {};
        var hasMapping = Object.keys(mapping).some(function (key) {
            return mapping[key] !== null && mapping[key] !== undefined && mapping[key] !== "";
        });
        var inline = chart.data && chart.data.inline;
        return !hasMapping && (!inline || !Array.isArray(inline.rows) || !inline.rows.length);
    }

    function assertRenderable(doc, panelId) {
        var charts = scopedCharts(doc, panelId);
        charts.forEach(function (el) {
            if (el.visible === false) return;
            var chart = el.chart;
            if (isEmptyLayoutChart(chart)) return;
            if (!chart || typeof chart.chartType !== "string" || !chart.chartType) {
                throw new Error("图表缺少有效 chartType，也不是显式空版式，已停止导出（元素 " + el.id + "）");
            }
            if (liveRenderTypes().indexOf(chart.chartType) < 0) {
                throw phase5Error(chart, new Error("当前没有该图型的本地真实 SVG 实现"));
            }
            var box = chartBoxMm(doc, el);
            var style = el.style || {};
            var svg;
            try {
                svg = global.FigData.renderChartSVG(chart, {
                    width_mm: box.w,
                    height_mm: box.h,
                    dpi: doc.canvas && doc.canvas.dpi || 300,
                    fontFamily: style.fontFamily,
                    fontSizePt: style.fontSizePt
                });
            } catch (err) {
                throw phase5Error(chart, err);
            }
            if (typeof svg !== "string" || !svg.trim()) {
                throw phase5Error(chart, new Error("渲染器返回空结果"));
            }
            if (/data-render=["']placeholder["']|需 v2 服务端渲染/.test(svg)) {
                throw phase5Error(chart, new Error("渲染器只返回占位框"));
            }
        });
        return true;
    }

    function isNyquist(chart) {
        var ch = chart && chart.characterization;
        return !!(chart && chart.chartType === "scatter" && ch &&
            /eis\s*nyquist/i.test(String(ch.technique || "")));
    }

    function svgEsc(value) {
        return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function svgNum(value) {
        var n = Math.round(Number(value) * 100) / 100;
        return String(n === 0 ? 0 : n);
    }

    function finiteCell(value) {
        if (value === null || value === undefined || value === "") return NaN;
        var n = Number(value);
        return isFinite(n) ? n : NaN;
    }

    function tickStep(span) {
        var raw = span / 5;
        var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var n = raw / mag;
        return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
    }

    function drawNyquist(chartSpec, opts) {
        var fd = global.FigData;
        var inline = chartSpec.data && chartSpec.data.inline;
        if (!inline || !Array.isArray(inline.columns) || !Array.isArray(inline.rows)) {
            throw new Error("EIS Nyquist 需要 chart.data.inline 数据");
        }
        var check = typeof fd.normalizeCharacterization === "function"
            ? fd.normalizeCharacterization(chartSpec.characterization, inline.columns)
            : { ok: true, char: chartSpec.characterization };
        if (!check.ok) throw new Error("EIS characterization 校验失败：" + check.errors.join("；"));
        var ch = check.char;
        if (ch.x_scale !== "linear") throw new Error("EIS Nyquist 必须使用线性阻抗坐标，不能使用 " + ch.x_scale);
        var mapping = chartSpec.mapping || {};
        var xi = inline.columns.indexOf(mapping.x), yi = inline.columns.indexOf(mapping.y);
        if (xi < 0 || yi < 0) throw new Error("EIS Nyquist 需要 mapping.x=Z′ 与 mapping.y=−Z″ 的真实数据列");
        var ci = inline.columns.indexOf(mapping.color);
        var groups = {}, order = [], skipped = 0;
        inline.rows.forEach(function (row) {
            var x = finiteCell(row[xi]), y = finiteCell(row[yi]);
            if (!isFinite(x) || !isFinite(y)) { skipped++; return; }
            var group = ci >= 0 ? String(row[ci]) : "EIS";
            if (!groups[group]) { groups[group] = []; order.push(group); }
            groups[group].push({ x: x, y: y });
        });
        if (!order.length) throw new Error("EIS Nyquist 没有可绘制的有限 Z′/−Z″ 数据点");

        var lo = Infinity, hi = -Infinity;
        order.forEach(function (group) {
            groups[group].forEach(function (p) {
                lo = Math.min(lo, p.x, p.y);
                hi = Math.max(hi, p.x, p.y);
            });
        });
        if (lo === hi) { lo -= 0.5; hi += 0.5; }
        var margin = (hi - lo) * 0.05;
        lo -= margin; hi += margin;
        var span = hi - lo, step = tickStep(span);
        var first = Math.ceil(lo / step - 1e-9) * step;
        var ticks = [];
        for (var v = first; v <= hi + step * 1e-9 && ticks.length < 20; v += step) ticks.push(v);

        var dpi = opts.dpi > 0 ? opts.dpi : 300;
        var W = opts.width_mm * dpi / 25.4, H = opts.height_mm * dpi / 25.4;
        var font = (opts.fontSizePt > 0 ? opts.fontSizePt : 7) * dpi / 72;
        var xLabel = ch.x_label || mapping.x || "Z′", yLabel = ch.y_label || mapping.y || "−Z″";
        var left = Math.max(42, font * 7), right = ci >= 0 ? font * 10 : font * 2;
        var top = font * 1.5, bottom = font * 4.5;
        if (W - left - right < 30 || H - top - bottom < 30) {
            throw new Error("EIS Nyquist 画布过小，无法容纳等比坐标与单位标签");
        }
        var unit = Math.min((W - left - right) / span, (H - top - bottom) / span);
        var usedW = span * unit, usedH = span * unit;
        var x0 = left + (W - left - right - usedW) / 2;
        var y0 = top + (H - top - bottom - usedH) / 2;
        function sx(x) {
            var ratio = (x - lo) / span;
            return ch.x_reverse ? x0 + usedW - ratio * usedW : x0 + ratio * usedW;
        }
        function sy(y) { return y0 + usedH - (y - lo) / span * usedH; }
        function tickLabel(n) { return String(Math.round(n * 1e6) / 1e6); }
        var parts = [];
        parts.push('<rect x="' + svgNum(x0) + '" y="' + svgNum(y0) + '" width="' + svgNum(usedW) +
            '" height="' + svgNum(usedH) + '" fill="none" stroke="#222222" stroke-width="1"/>');
        ticks.forEach(function (tick) {
            var x = sx(tick), y = sy(tick);
            parts.push('<line x1="' + svgNum(x) + '" y1="' + svgNum(y0 + usedH) + '" x2="' + svgNum(x) + '" y2="' + svgNum(y0 + usedH + 4) + '" stroke="#222222"/>');
            parts.push('<text x="' + svgNum(x) + '" y="' + svgNum(y0 + usedH + font * 1.4) + '" text-anchor="middle" font-size="' + svgNum(font) + '">' + tickLabel(tick) + '</text>');
            parts.push('<line x1="' + svgNum(x0 - 4) + '" y1="' + svgNum(y) + '" x2="' + svgNum(x0) + '" y2="' + svgNum(y) + '" stroke="#222222"/>');
            parts.push('<text x="' + svgNum(x0 - 6) + '" y="' + svgNum(y + font * 0.35) + '" text-anchor="end" font-size="' + svgNum(font) + '">' + tickLabel(tick) + '</text>');
        });
        var palette = ["#3C5488", "#E64B35", "#00A087", "#4DBBD5", "#F39B7F", "#8491B4"];
        if (chartSpec.paletteId && has("FigPalette") && typeof FigPalette.colors === "function") {
            palette = FigPalette.colors(chartSpec.paletteId);
        }
        order.forEach(function (group, gi) {
            var color = palette[gi % palette.length];
            groups[group].forEach(function (p) {
                parts.push('<circle cx="' + svgNum(sx(p.x)) + '" cy="' + svgNum(sy(p.y)) + '" r="' + svgNum(Math.max(1.4, dpi / 150)) + '" fill="' + svgEsc(color) + '" fill-opacity="0.85"/>');
            });
            if (ci >= 0) {
                parts.push('<circle cx="' + svgNum(x0 + usedW + font) + '" cy="' + svgNum(y0 + font * (gi * 1.8 + 0.8)) + '" r="' + svgNum(font * 0.3) + '" fill="' + svgEsc(color) + '"/>');
                parts.push('<text x="' + svgNum(x0 + usedW + font * 1.6) + '" y="' + svgNum(y0 + font * (gi * 1.8 + 1.1)) + '" font-size="' + svgNum(font) + '">' + svgEsc(group) + '</text>');
            }
        });
        parts.push('<text x="' + svgNum(x0 + usedW / 2) + '" y="' + svgNum(H - font * 0.4) + '" text-anchor="middle" font-size="' + svgNum(font) + '">' + svgEsc(xLabel) + '</text>');
        parts.push('<text x="' + svgNum(font * 0.4) + '" y="' + svgNum(y0 + usedH / 2) + '" text-anchor="middle" font-size="' + svgNum(font) + '" transform="rotate(-90 ' + svgNum(font * 0.4) + ' ' + svgNum(y0 + usedH / 2) + ')">' + svgEsc(yLabel) + '</text>');
        if (skipped) parts.push('<text x="' + svgNum(x0) + '" y="' + svgNum(y0 - font * 0.4) + '" font-size="' + svgNum(font * 0.9) + '" fill="#A05A00">已排除 ' + skipped + ' 个非数值点（未计入）</text>');
        return '<g font-family="' + svgEsc(opts.fontFamily || "Arial, sans-serif") + '" data-chart-type="scatter" data-eis-equal-scale="true" data-eis-px-per-unit="' + svgNum(unit) + '" data-eis-domain="' + svgNum(lo) + ',' + svgNum(hi) + '" data-skipped-points="' + skipped + '">' + parts.join("") + '</g>';
    }

    function installRenderSafety() {
        var fd = global.FigData;
        if (fd && typeof fd.renderChartSVG === "function" && !fd.renderChartSVG.__phase5Eis) {
            var previousChart = fd.renderChartSVG;
            var wrappedChart = function (chartSpec, opts) {
                opts = opts || {};
                if (isNyquist(chartSpec)) {
                    var native = previousChart.call(fd, chartSpec, opts);
                    if (typeof native === "string" &&
                        (/data-eis-(?:equal-scale|aspect)=/.test(native) || /equal_aspect=true/.test(native))) {
                        return native;
                    }
                    return drawNyquist(chartSpec, opts);
                }
                return previousChart.call(fd, chartSpec, opts);
            };
            wrappedChart.__phase5Eis = true;
            wrappedChart.__phase5Previous = previousChart;
            fd.renderChartSVG = wrappedChart;
        }
        if (has("FigRender") && typeof FigRender.toSVG === "function" && !FigRender.toSVG.__phase5Honest) {
            var previousSVG = FigRender.toSVG;
            var honestSVG = function (doc, opts) {
                var svg = previousSVG.call(this, doc, opts);
                return String(svg).replace(/该图表类型需 v2 服务端渲染/g, "图表未能真实生成（禁止导出占位图）");
            };
            honestSVG.__phase5Honest = true;
            honestSVG.__phase5Previous = previousSVG;
            FigRender.toSVG = honestSVG;
        }
        var ex = global.FigExport;
        if (!ex) return;
        ["toSVGBlob", "toSVGString"].forEach(function (name) {
            if (typeof ex[name] !== "function" || ex[name].__phase5Guard) return;
            var prev = ex[name];
            var wrapped = function (doc, opts) {
                assertRenderable(doc, opts && opts.panel_id);
                return prev.call(ex, doc, opts);
            };
            wrapped.__phase5Guard = true;
            ex[name] = wrapped;
        });
        ["toRasterBlob", "toTIFFBlob", "toPDFBlob"].forEach(function (name) {
            if (typeof ex[name] !== "function" || ex[name].__phase5Guard) return;
            var prev = ex[name];
            var wrapped = function (doc, opts) {
                try { assertRenderable(doc, opts && opts.panel_id); }
                catch (err) { return Promise.reject(err); }
                return prev.call(ex, doc, opts);
            };
            wrapped.__phase5Guard = true;
            ex[name] = wrapped;
        });
    }

    function reportTemplateError(err) {
        if (has("App") && typeof App.error === "function") App.error(err.message);
        else if (has("Ui") && typeof Ui.toast === "function") Ui.toast(err.message, { type: "error", ms: 6000 });
        return Promise.reject(err);
    }

    function installTemplateSafety() {
        var gp = global.FigPresets;
        if (gp) {
            ["templates", "template"].forEach(function (name) {
                if (typeof gp[name] !== "function" || gp[name].__phase5Capabilities) return;
                var prev = gp[name];
                var wrapped = function () {
                    var result = prev.apply(gp, arguments);
                    return Array.isArray(result) ? result.map(templateRecord) : templateRecord(result);
                };
                wrapped.__phase5Capabilities = true;
                gp[name] = wrapped;
            });
            if (typeof gp.templateFromStats === "function" && !gp.templateFromStats.__phase5Guard) {
                var prevBuild = gp.templateFromStats;
                var build = function (id, data) {
                    var tpl = requireTemplateApplicable(id);
                    checkTemplateData(tpl, data);
                    return prevBuild.apply(gp, arguments);
                };
                build.__phase5Guard = true;
                gp.templateFromStats = build;
            }
            if (typeof gp.recommend === "function" && !gp.recommend.__phase5Default) {
                var prevRecommend = gp.recommend;
                var recommend = function (stats, opts) {
                    opts = opts || {};
                    var include = opts.include_unsupported === true;
                    var forward = {};
                    Object.keys(opts).forEach(function (key) { forward[key] = opts[key]; });
                    return prevRecommend.call(gp, stats, forward).map(function (rec) {
                        var out = {};
                        Object.keys(rec).forEach(function (key) { out[key] = rec[key]; });
                        try {
                            var cap = capabilityForId(rec.template_id);
                            out.capability = cap.capability;
                            out.capability_description = cap.capability_description;
                        } catch (err) { out.capability = "unsupported"; }
                        return out;
                    }).filter(function (rec) { return include || rec.capability !== "unsupported"; });
                };
                recommend.__phase5Default = true;
                gp.recommend = recommend;
            }
        }
        var ops = global.FigOps;
        if (ops) {
            ["apply", "applyAll"].forEach(function (name) {
                if (typeof ops[name] !== "function" || ops[name].__phase5TemplateGuard) return;
                var prev = ops[name];
                var wrapped = function () {
                    validateTemplateOps(name === "apply" ? [arguments[1]] : arguments[1]);
                    return prev.apply(ops, arguments);
                };
                wrapped.__phase5TemplateGuard = true;
                ops[name] = wrapped;
            });
        }
        var templates = global.Templates;
        if (templates) {
            if (typeof templates.apply === "function" && !templates.apply.__phase5Guard) {
                var prevApply = templates.apply;
                var apply = function (id, opts) {
                    opts = opts || {};
                    try {
                        var tpl = requireTemplateApplicable(id);
                        var data = opts.data || existingInlineData(global.App && global.App.doc);
                        checkTemplateData(tpl, data);
                    } catch (err) { return reportTemplateError(err); }
                    var result = prevApply.call(templates, id, opts);
                    return Promise.resolve(result).then(function (res) {
                        if (tpl.capability === "layout" && has("App") && typeof App.status === "function") {
                            App.status("已创建空版式「" + tpl.name + "」：仅布局，未自动填图；请逐面板添加真实数据");
                        }
                        return res;
                    });
                };
                apply.__phase5Guard = true;
                templates.apply = apply;
            }
            if (typeof templates.mount === "function" && !templates.mount.__phase5Gallery) {
                var prevMount = templates.mount;
                var mount = function (panel) {
                    var result = prevMount.apply(templates, arguments);
                    installTemplateGallery(panel);
                    return result;
                };
                mount.__phase5Gallery = true;
                templates.mount = mount;
            }
        }
        if (has("App") && typeof App.commit === "function" && !App.commit.__phase5TemplateGuard) {
            var prevCommit = App.commit;
            var commit = function (ops) {
                validateTemplateOps(ops);
                return prevCommit.apply(App, arguments);
            };
            commit.__phase5TemplateGuard = true;
            App.commit = commit;
        }
    }

    function templateRuntimeInstall() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installRenderSafety();
        installTemplateSafety();
    }

    function templateGalleryNode(doc, tag, text, style) {
        var el = doc.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (style) el.setAttribute("style", style);
        return el;
    }

    function installTemplateGallery(panel) {
        if (!panel || !global.document) return;
        var doc = global.document;
        if (panel.__phase5ShowUnsupported === undefined) panel.__phase5ShowUnsupported = false;
        if (!panel.__phase5Capture) {
            panel.__phase5Capture = true;
            panel.addEventListener("click", function (ev) {
                var node = ev.target;
                while (node && node !== panel) {
                    if (node.getAttribute && node.getAttribute("data-capability") === "unsupported") {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (has("App") && typeof App.status === "function") {
                            App.status("该模板仅示意，暂不支持真实生成，已禁止应用");
                        }
                        return;
                    }
                    node = node.parentNode;
                }
            }, true);
        }
        function decorate() {
            var items = panel.querySelectorAll ? panel.querySelectorAll(".template-item") : [];
            items.forEach(function (item) {
                if (item.__phase5Capability) return;
                var found = null;
                var id = item.getAttribute && item.getAttribute("data-template-id");
                var title = item.querySelector && item.querySelector("span");
                var name = title ? String(title.textContent || "").trim() : "";
                capabilityList().forEach(function (tpl) {
                    if (!found && ((id && tpl.id === id) || (!id && name && tpl.name === name))) found = tpl;
                });
                if (!found) return;
                item.__phase5Capability = found.capability;
                item.setAttribute("data-capability", found.capability);
                item.setAttribute("data-template-id", found.id);
                var badge = templateGalleryNode(doc, "div", CAPABILITY_TEXT[found.capability],
                    "font-size:11px;font-weight:bold;padding:2px 5px;border-radius:3px;" +
                    (found.capability === "full" ? "color:#176b3a;background:#e7f6ec;" :
                        found.capability === "layout" ? "color:#755400;background:#fff4cc;" :
                            "color:#9b1c1c;background:#fee2e2;"));
                item.insertBefore(badge, item.firstChild);
                var button = item.querySelector && item.querySelector("button");
                if (button) {
                    if (found.capability === "unsupported") {
                        button.disabled = true;
                        button.textContent = "禁止应用";
                        button.title = "仅示意，无真实 SVG 生成能力";
                        button.setAttribute("aria-disabled", "true");
                    } else if (found.capability === "layout") {
                        button.textContent = "创建空版式";
                        button.title = "只创建复合空版式，不自动填图；请逐面板添加真实数据";
                    } else {
                        button.title = "使用真实数据本地生成 SVG；无数据不会生成占位图";
                    }
                }
                item.style.display = found.capability === "unsupported" && !panel.__phase5ShowUnsupported ? "none" : "";
            });
            items.forEach(function (item) {
                var cap = item.getAttribute("data-capability");
                item.style.display = cap === "unsupported" && !panel.__phase5ShowUnsupported ? "none" : "";
            });
        }
        if (!panel.__phase5ToolbarEl || panel.__phase5ToolbarEl.parentNode !== panel) {
            var bar = templateGalleryNode(doc, "div", null,
                "position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #ddd;padding:5px 8px;font-size:11px;");
            var label = templateGalleryNode(doc, "label", null, "display:flex;gap:5px;align-items:center;cursor:pointer;");
            var toggle = templateGalleryNode(doc, "input");
            toggle.type = "checkbox";
            toggle.checked = panel.__phase5ShowUnsupported;
            toggle.addEventListener("change", function () {
                panel.__phase5ShowUnsupported = toggle.checked;
                decorate();
            });
            label.appendChild(toggle);
            label.appendChild(doc.createTextNode("显示 unsupported（仅示意预览，禁止应用）"));
            bar.appendChild(label);
            bar.appendChild(templateGalleryNode(doc, "div",
                "full 需真实数据；layout 只建空版式，不自动填图。默认不推荐、不展示 unsupported。",
                "color:#666;margin-top:3px;line-height:1.35;"));
            panel.insertBefore(bar, panel.firstChild);
            panel.__phase5ToolbarEl = bar;
        }
        panel.__phase5Decorate = decorate;
        decorate();
        if (!panel.__phase5Observer && typeof global.MutationObserver === "function") {
            panel.__phase5Observer = new global.MutationObserver(function () { decorate(); });
            panel.__phase5Observer.observe(panel, { childList: true, subtree: true });
        }
    }

    function appFail(err) {
        var m = msgOf(err);
        warn(m);
        if (has("App") && typeof App.error === "function") App.error(m);
        else if (has("Ui") && typeof Ui.toast === "function") Ui.toast(m, { type: "error" });
    }

    // ------------------------------------------------------------------
    // 1. Store adapter
    // ------------------------------------------------------------------

    function attachStore() {
        try {
            if (has("Store") && typeof Store.attach === "function") {
                Store.attach();
            } else if (has("FigStore") && FigStore.adapters &&
                       typeof FigStore.adapters.localStorage === "function") {
                warn("缺少 Store 模块（app/store.js），直接注册 FigStore 的 localStorage 适配器");
                FigStore.use(FigStore.adapters.localStorage());
            } else {
                warn("持久化不可用：缺少 Store 与 FigStore");
                return;
            }
            // Open the adapter eagerly so the first save never races open().
            if (has("FigStore") && typeof FigStore.open === "function") {
                FigStore.open().catch(function (err) {
                    warn("存储适配器打开失败：" + msgOf(err));
                });
            }
        } catch (err) {
            warn("Store.attach 失败：" + msgOf(err));
        }
    }

    // ------------------------------------------------------------------
    // 2. Presets: fetch from ../shared/presets, inline fallback on failure
    // ------------------------------------------------------------------

    function fetchJson(url) {
        if (typeof fetch !== "function") {
            return Promise.reject(new Error("当前环境不支持 fetch"));
        }
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
        return fetch(url, { cache: "no-cache", signal: ctrl ? ctrl.signal : undefined })
            .then(function (res) {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            })
            .finally(function () { if (timer) clearTimeout(timer); });
    }

    function loadPresetFile(file) {
        var i = 0;
        function tryNext() {
            if (i >= PRESET_BASES.length) return Promise.resolve(null);
            var url = PRESET_BASES[i++] + file;
            return fetchJson(url).catch(function () { return tryNext(); });
        }
        return tryNext();
    }

    function loadPresets() {
        if (!has("FigPresets") || typeof FigPresets.load !== "function") {
            warn("缺少 FigPresets（lib/presets.js），跳过预设加载");
            return Promise.resolve({ fallback: true, counts: null });
        }
        var spec = [
            { key: "journals", file: "journals.json", fb: FB_JOURNALS, label: "期刊预设" },
            { key: "templates", file: "templates.json", fb: FB_TEMPLATES, label: "模板" },
            { key: "palettes", file: "palettes.json", fb: FB_PALETTES, label: "配色" }
        ];
        return Promise.all(spec.map(function (s) {
            return loadPresetFile(s.file).then(function (obj) {
                if (obj && typeof obj === "object") return { spec: s, obj: obj };
                return { spec: s, obj: s.fb, usedFallback: true };
            });
        })).then(function (parts) {
            var bundle = {};
            var usedFallback = [];
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                if (!p.obj) {
                    // No fetch result and no fallback copy for this file.
                    warn("预设文件缺失：" + p.spec.file);
                    continue;
                }
                bundle[p.spec.key] = p.obj;
                if (p.usedFallback) usedFallback.push(p.spec.label);
            }
            try {
                FigPresets.load(bundle);
            } catch (err) {
                warn("FigPresets.load 失败：" + msgOf(err));
                return { fallback: true, counts: null };
            }
            if (usedFallback.length) {
                var text = "预设文件加载失败（" + usedFallback.join("、") + "），已使用内置兜底副本";
                warn(text);
                if (has("Ui") && typeof Ui.toast === "function") {
                    Ui.toast(text, { type: "error", ms: 5000 });
                } else if (has("App") && typeof App.status === "function") {
                    App.status(text);
                }
            }
            return {
                fallback: usedFallback.length > 0,
                counts: {
                    journals: FigPresets.journals().length,
                    templates: FigPresets.templates().length,
                    palettes: (has("FigPalette") && typeof FigPalette.list === "function")
                        ? FigPalette.list().length : null
                }
            };
        });
    }

    // ------------------------------------------------------------------
    // 3. Default document
    // ------------------------------------------------------------------

    function defaultDpi() {
        if (has("Settings") && typeof Settings.defaultDpi === "function") {
            var d = Settings.defaultDpi();
            if (typeof d === "number" && d >= 72 && d <= 2400) return d;
        }
        return 300;
    }

    function createDefaultDoc() {
        if (!has("FigDoc")) throw new Error("内核未加载：缺少 FigDoc（lib/figdoc.js）");
        return FigDoc.create({
            width_mm: 120,
            height_mm: 90,
            dpi: defaultDpi(),
            background: "#FFFFFF",
            title: "未命名图",
            app: "FigStudio Web v1",
            app_version: "1.0"
        });
    }

    // ------------------------------------------------------------------
    // 4. Module mounting (script load order)
    // ------------------------------------------------------------------

    var bootStats = { mounted: 0, total: 0 };

    function mountAll() {
        var steps = [
            ["Ui", function () {
                var el = pickEl(["modal-root"]);
                if (el) Ui.mount(el);
            }],
            ["Editor", function () {
                var el = pickEl(["stage"]);
                if (!el) throw new Error("找不到画布挂载点 #stage");
                Editor.mount(el);
            }],
            ["Import", function () {
                // Mount only into the dedicated panel; a toolbar/panel-templates
                // fallback lets Templates.mount wipe the Import buttons later.
                var el = pickEl(["panel-import"]);
                if (el) Import.mount(el);
            }],
            ["Templates", function () {
                var el = pickEl(["panel-templates"]);
                if (el) Templates.mount(el);
            }],
            ["Presets", function () {
                var el = pickEl(["panel-presets"]);
                if (el) Presets.mount(el);
            }],
            ["Exporter", function () {
                var el = pickEl(["modal-root"]);
                if (el) Exporter.mount(el);
            }],
            ["History", function () {
                var el = pickEl(["panel-history"]);
                if (el) History.mount(el);
            }],
            ["SciencePanel", function () {
                var el = pickEl(["panel-science"]);
                if (el) SciencePanel.mount(el);
            }],
            ["DiagramPanel", function () {
                var el = pickEl(["panel-diagram"]);
                if (el) DiagramPanel.mount(el);
            }],
            ["AiPanel", function () {
                var el = pickEl(["panel-ai"]);
                if (el) AiPanel.mount(el);
            }],
            ["Anchors", function () {
                var el = pickEl(["panel-anchors"]);
                if (el) Anchors.mount(el);
            }],
            ["Layers", function () {
                var el = pickEl(["panel-layers"]);
                if (el) Layers.mount(el);
            }],
            ["Props", function () {
                var el = pickEl(["panel-props"]);
                if (el) Props.mount(el);
            }],
            ["Settings", function () {
                var el = pickEl(["panel-settings"]);
                if (el) Settings.mount(el);
            }],
            ["Store", function () {
                var el = pickEl(["panel-store"]);
                if (el) Store.mount(el);
            }]
        ];
        bootStats.total = steps.length;
        var problems = [];
        for (var i = 0; i < steps.length; i++) {
            var name = steps[i][0];
            if (!has(name) || typeof global[name].mount !== "function") {
                problems.push(name + "（模块未加载）");
                continue;
            }
            try {
                steps[i][1]();
                bootStats.mounted++;
            } catch (err) {
                warn("挂载 " + name + " 失败：" + msgOf(err));
            }
        }
        if (problems.length) warn("以下模块未挂载：" + problems.join("；"));
    }

    // ------------------------------------------------------------------
    // 4b. Side-pane tabs — call after mountAll() so the panels exist and
    // Ui.tabs can toggle #panel-<id> visibility via the .hidden class.
    // ------------------------------------------------------------------

    var TAB_ALL = [
        { id: "science", label: "论证" },
        { id: "diagram", label: "实体关系" },
        { id: "anchors", label: "锚点" },
        { id: "layers", label: "图层" },
        { id: "props", label: "属性" },
        { id: "templates", label: "模板" },
        { id: "presets", label: "期刊" },
        { id: "history", label: "历史" },
        { id: "store", label: "工程" }
    ];

    // AI 对话始终固定在下半栏，不再占用上半栏的工具标签。
    var VARIANT_TABS = {
        a: ["science", "diagram", "templates", "presets", "anchors", "history", "store", "layers", "props"],
        b: ["props", "layers", "diagram", "anchors", "science", "templates", "presets", "history", "store"],
        c: ["science", "diagram", "presets", "history", "store", "props", "layers", "anchors", "templates"]
    };
    var VARIANT_DEFAULT_TAB = { a: "science", b: "props", c: "science" };
    var VARIANT_LABEL = { a: "对话创作", b: "专业编辑", c: "投稿审阅" };

    function resolveVariant() {
        try {
            var qs = (global.location && global.location.search) || "";
            var m = /[?&]variant=([A-Za-z])/.exec(qs);
            var v = m ? m[1].toLowerCase() : "b";
            return VARIANT_TABS[v] ? v : "b";
        } catch (e) { return "b"; }
    }

    function orderedTabDefs(variant) {
        var ids = VARIANT_TABS[variant] || VARIANT_TABS.b;
        var out = [];
        ids.forEach(function (id) {
            for (var i = 0; i < TAB_ALL.length; i++) {
                if (TAB_ALL[i].id === id) { out.push(TAB_ALL[i]); break; }
            }
        });
        return out;
    }

    function applyVariant() {
        var v = resolveVariant();
        if (has("App") && typeof App.setUi === "function") {
            App.setUi({ variant: v, activeTab: VARIANT_DEFAULT_TAB[v] });
        }
        if (global.document && global.document.body) {
            global.document.body.setAttribute("data-variant", v);
            var badge = global.document.getElementById("variant-badge");
            if (!badge) {
                badge = global.document.createElement("span");
                badge.id = "variant-badge";
                badge.textContent = "版本：" + (VARIANT_LABEL[v] || "专业编辑");
                badge.title = "A=对话创作（AI 优先）｜B=专业编辑（属性优先）｜C=投稿审阅（期刊/审阅优先）。URL 加 ?variant=A|B|C 切换。";
                var bar = byId("status-bar");
                if (bar && bar.insertBefore) bar.insertBefore(badge, bar.firstChild);
            }
        }
    }

    function onTabChange(id) {
        if (has("App") && App.ui) App.ui.activeTab = id;
        if (has("App") && typeof App.emit === "function") {
            App.emit("ui:changed", { activeTab: id });
        }
    }

    function wireTabs() {
        try {
            var tabsEl = byId("tabs");
            if (!tabsEl) {
                warn("找不到 #tabs，侧栏标签页未初始化");
                return;
            }
            if (!has("Ui") || typeof Ui.tabs !== "function") {
                warn("缺少 Ui.tabs，侧栏标签页未初始化");
                return;
            }
            Ui.tabs(tabsEl, {
                tabs: orderedTabDefs((has("App") && App.ui) ? App.ui.variant : "b"),
                active: (has("App") && App.ui) ? App.ui.activeTab : null,
                onChange: onTabChange
            });
        } catch (err) {
            appFail(err);
        }
    }

    // ------------------------------------------------------------------
    // 4c. Split pane — draggable divider between #canvas-pane and #side-pane
    //     (pointer drag / arrow keys / double-click reset). Width persists
    //     to localStorage and is clamped when #main shrinks. No Editor.fit()
    //     here: see the resize note near runBoot.
    // ------------------------------------------------------------------

    var SPLIT_LS_KEY = "figstudio.splitPane.v1";
    var SPLIT_DEFAULT = 380;
    var SPLIT_MIN_SIDE = 280;
    var SPLIT_MIN_CANVAS = 320;
    var SPLIT_KEY_STEP = 16;

    function initSplitPane() {
        try {
            var main = byId("main");
            var side = byId("side-pane");
            if (!main || !side) {
                warn("找不到 #main 或 #side-pane，分栏拖动未初始化");
                return;
            }
            if (byId("split-handle")) return;

            var handle = document.createElement("div");
            handle.id = "split-handle";
            handle.className = "split-handle";
            handle.setAttribute("role", "separator");
            handle.setAttribute("aria-orientation", "vertical");
            handle.setAttribute("aria-label", "调整侧栏宽度：拖动、左右方向键（Shift 加速）、双击复位");
            handle.tabIndex = 0;
            main.insertBefore(handle, side);

            var dragging = false;

            function sideBounds() {
                var available = Math.max(0, main.clientWidth - handle.offsetWidth);
                var max = Math.max(0, available - SPLIT_MIN_CANVAS);
                var min = Math.min(SPLIT_MIN_SIDE, Math.max(160, max));
                return { min: min, max: Math.max(min, max) };
            }

            function currentWidth() {
                var w = side.getBoundingClientRect().width;
                return isFinite(w) ? w : SPLIT_DEFAULT;
            }

            function setWidth(width, persist) {
                var b = sideBounds();
                var w = Math.min(b.max, Math.max(b.min, Math.round(width)));
                document.documentElement.style.setProperty("--side-pane-width", w + "px");
                handle.setAttribute("aria-valuemin", String(Math.round(b.min)));
                handle.setAttribute("aria-valuemax", String(Math.round(b.max)));
                handle.setAttribute("aria-valuenow", String(w));
                if (persist) {
                    try {
                        global.localStorage.setItem(SPLIT_LS_KEY, String(w));
                    } catch (err) { /* 本地存储不可用时忽略 */ }
                }
                return w;
            }

            function loadWidth() {
                try {
                    var raw = global.localStorage ? global.localStorage.getItem(SPLIT_LS_KEY) : null;
                    var n = raw === null || raw === undefined ? NaN : parseFloat(raw);
                    return isFinite(n) && n > 0 ? n : null;
                } catch (err) {
                    return null;
                }
            }

            function syncEditorBadges() {
                // Editor 只监听 window resize 来同步画布徽章（不触发 fit），复用同一通道。
                try {
                    global.dispatchEvent(new global.Event("resize"));
                } catch (err) { /* 徽章未同步不影响布局 */ }
            }

            var saved = loadWidth();
            setWidth(saved === null ? SPLIT_DEFAULT : saved, false);

            handle.addEventListener("pointerdown", function (ev) {
                if (ev.button !== 0 || dragging) return;
                ev.preventDefault();
                dragging = true;
                handle.setPointerCapture(ev.pointerId);
                document.body.classList.add("split-dragging");
            });
            handle.addEventListener("pointermove", function (ev) {
                if (!dragging) return;
                var rect = main.getBoundingClientRect();
                setWidth(rect.right - ev.clientX - handle.offsetWidth / 2, false);
            });
            function endDrag(ev) {
                if (!dragging) return;
                dragging = false;
                document.body.classList.remove("split-dragging");
                try { handle.releasePointerCapture(ev.pointerId); } catch (err) { /* 已释放 */ }
                setWidth(currentWidth(), true);
                syncEditorBadges();
            }
            handle.addEventListener("pointerup", endDrag);
            handle.addEventListener("pointercancel", endDrag);

            handle.addEventListener("dblclick", function () {
                setWidth(SPLIT_DEFAULT, true);
                syncEditorBadges();
            });

            handle.addEventListener("keydown", function (ev) {
                var step = ev.shiftKey ? SPLIT_KEY_STEP * 4 : SPLIT_KEY_STEP;
                if (ev.key === "ArrowLeft") {
                    ev.preventDefault();
                    setWidth(currentWidth() - step, true);
                    syncEditorBadges();
                } else if (ev.key === "ArrowRight") {
                    ev.preventDefault();
                    setWidth(currentWidth() + step, true);
                    syncEditorBadges();
                } else if (ev.key === "Home") {
                    ev.preventDefault();
                    setWidth(sideBounds().min, true);
                    syncEditorBadges();
                } else if (ev.key === "End") {
                    ev.preventDefault();
                    setWidth(sideBounds().max, true);
                    syncEditorBadges();
                }
            });

            if (typeof global.ResizeObserver === "function") {
                var ro = new global.ResizeObserver(function () {
                    setWidth(currentWidth(), false);
                });
                ro.observe(main);
                ro.observe(side);
            } else {
                global.addEventListener("resize", function () {
                    setWidth(currentWidth(), false);
                });
            }
        } catch (err) {
            warn("分栏初始化失败：" + msgOf(err));
        }
    }

    var AI_SPLIT_LS_KEY = "figstudio.aiSplitPane.v1";
    var AI_SPLIT_RATIO = 0.46;
    var AI_SPLIT_MIN = 230;
    var AI_SPLIT_MIN_TOOLS = 150;
    var AI_SPLIT_KEY_STEP = 16;

    function initAiSplitPane() {
        var side = byId("side-pane");
        var panel = byId("panel-ai");
        var handle = byId("ai-split-handle");
        if (!side || !panel || !handle) {
            warn("找不到固定 AI 分栏，上下高度调整未初始化");
            return;
        }
        var dragging = false;

        function bounds() {
            var available = Math.max(0, side.clientHeight - handle.offsetHeight);
            var max = Math.max(0, available - AI_SPLIT_MIN_TOOLS);
            var min = Math.min(AI_SPLIT_MIN, Math.max(160, max));
            return { min: min, max: Math.max(min, max), available: available };
        }

        function currentHeight() {
            var h = panel.getBoundingClientRect().height;
            return isFinite(h) && h > 0 ? h : bounds().available * AI_SPLIT_RATIO;
        }

        function setHeight(height, persist) {
            var b = bounds();
            var h = Math.min(b.max, Math.max(b.min, Math.round(height)));
            document.documentElement.style.setProperty("--ai-pane-height", h + "px");
            handle.setAttribute("aria-valuemin", String(Math.round(b.min)));
            handle.setAttribute("aria-valuemax", String(Math.round(b.max)));
            handle.setAttribute("aria-valuenow", String(h));
            if (persist) {
                try { global.localStorage.setItem(AI_SPLIT_LS_KEY, String(h)); }
                catch (err) { /* 本地存储不可用时保留当前布局 */ }
            }
            return h;
        }

        function savedHeight() {
            try {
                var n = parseFloat(global.localStorage.getItem(AI_SPLIT_LS_KEY));
                return isFinite(n) && n > 0 ? n : null;
            } catch (err) { return null; }
        }

        var saved = savedHeight();
        setHeight(saved === null ? bounds().available * AI_SPLIT_RATIO : saved, false);
        handle.title = "拖动调整上下栏高度；上下方向键微调（Shift 加速）；双击恢复 46%";

        handle.addEventListener("pointerdown", function (ev) {
            if (ev.button !== 0 || dragging) return;
            ev.preventDefault();
            dragging = true;
            handle.setPointerCapture(ev.pointerId);
            document.body.classList.add("ai-split-dragging");
        });
        handle.addEventListener("pointermove", function (ev) {
            if (!dragging) return;
            var rect = side.getBoundingClientRect();
            setHeight(rect.bottom - ev.clientY - handle.offsetHeight / 2, false);
        });
        function endDrag(ev) {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove("ai-split-dragging");
            try { handle.releasePointerCapture(ev.pointerId); } catch (err) { /* 已释放 */ }
            setHeight(currentHeight(), true);
        }
        handle.addEventListener("pointerup", endDrag);
        handle.addEventListener("pointercancel", endDrag);
        handle.addEventListener("dblclick", function () {
            setHeight(bounds().available * AI_SPLIT_RATIO, true);
        });
        handle.addEventListener("keydown", function (ev) {
            var step = ev.shiftKey ? AI_SPLIT_KEY_STEP * 4 : AI_SPLIT_KEY_STEP;
            if (ev.key === "ArrowUp") {
                ev.preventDefault();
                setHeight(currentHeight() + step, true);
            } else if (ev.key === "ArrowDown") {
                ev.preventDefault();
                setHeight(currentHeight() - step, true);
            } else if (ev.key === "Home") {
                ev.preventDefault();
                setHeight(bounds().min, true);
            } else if (ev.key === "End") {
                ev.preventDefault();
                setHeight(bounds().max, true);
            }
        });
        if (typeof global.ResizeObserver === "function") {
            var ro = new global.ResizeObserver(function () { setHeight(currentHeight(), false); });
            ro.observe(side);
        } else {
            global.addEventListener("resize", function () { setHeight(currentHeight(), false); });
        }
    }

    // ------------------------------------------------------------------
    // 5. Topbar wiring
    // ------------------------------------------------------------------

    var missingButtons = [];

    function bindClick(id, fn) {
        var el = byId(id);
        if (!el) {
            missingButtons.push(id);
            return;
        }
        el.addEventListener("click", function (ev) {
            ev.preventDefault();
            fn();
        });
    }

    function setPressed(el, on) {
        if (!el) return;
        try {
            el.setAttribute("aria-pressed", on ? "true" : "false");
            el.classList.toggle("active", !!on);
        } catch (err) {
            // Older engines without classList: ignore.
        }
    }

    function commitOps(ops, label) {
        if (!has("App") || typeof App.commit !== "function") {
            appFail(new Error("App 模块未就绪，无法执行编辑操作"));
            return null;
        }
        try {
            var result = App.commit(ops, { label: label, source: "user" });
            // App.commit is async; surface rejections through App.error.
            if (result && typeof result.catch === "function") {
                result.catch(appFail);
            }
            return result;
        } catch (err) {
            appFail(err);
            return null;
        }
    }

    function selectionOrWarn(min, what) {
        if (!has("App") || typeof App.selection !== "function") {
            appFail(new Error("App 模块未就绪，无法读取选区"));
            return null;
        }
        var sel = App.selection();
        if (!sel || sel.length < min) {
            if (typeof App.status === "function") {
                App.status(what + "需要先选中至少 " + min + " 个元素");
            }
            return null;
        }
        return sel;
    }

    function doUndo() {
        if (!has("FigOps") || !has("App") || typeof App.publishDoc !== "function") {
            appFail(new Error("内核或 App 未就绪，无法撤销"));
            return Promise.resolve(false);
        }
        return App.publishDoc(function (current) {
            return FigOps.undo(current);
        }, { reason: "undo", finalizeHistory: true }).then(function () {
            if (typeof App.status === "function") App.status("已撤销");
            return true;
        }).catch(function (err) {
            appFail(err);
            return false;
        });
    }

    function doRedo() {
        if (!has("FigOps") || !has("App") || typeof App.publishDoc !== "function") {
            appFail(new Error("内核或 App 未就绪，无法重做"));
            return Promise.resolve(false);
        }
        return App.publishDoc(function (current) {
            return FigOps.redo(current);
        }, { reason: "redo", finalizeHistory: true }).then(function () {
            if (typeof App.status === "function") App.status("已重做");
            return true;
        }).catch(function (err) {
            appFail(err);
            return false;
        });
    }

    function onNew() {
        if (has("Store") && typeof Store.newProject === "function") {
            try {
                var created = Store.newProject();
                if (created && typeof created.catch === "function") {
                    created.catch(appFail);
                }
                return;
            } catch (err) {
                appFail(err);
                return;
            }
        }
        var proceed = true;
        if (has("Ui") && typeof Ui.confirm === "function") {
            proceed = Ui.confirm("新建将清空当前画布（未保存的内容会丢失），确定？");
        }
        Promise.resolve(proceed).then(function (ok) {
            if (!ok) return null;
            if (!has("App") || typeof App.publishDoc !== "function") {
                throw new Error("App 模块未就绪，无法新建文档");
            }
            var doc = createDefaultDoc();
            return App.publishDoc(doc, { reason: "new" }).then(function () {
                if (typeof App.clearSelection === "function") App.clearSelection();
                App.status("已新建文档 " + doc.id);
            });
        }).catch(appFail);
    }

    function onOpen() {
        if (has("Store") && typeof Store.open === "function") {
            try {
                var opened = Store.open();
                if (opened && typeof opened.catch === "function") {
                    opened.catch(appFail);
                }
                return;
            } catch (err) {
                appFail(err);
                return;
            }
        }
        try {
            if (!has("History") || typeof History.importProject !== "function") {
                throw new Error("打开功能需要 Store 或 History 模块");
            }
            var inp = document.createElement("input");
            inp.type = "file";
            inp.accept = ".figureproj.json,.json";
            inp.addEventListener("change", function () {
                var f = inp.files && inp.files[0];
                if (!f) return;
                // History.importProject 内部通过可等待的统一发布入口替换文档，
                // 返回 true/false；这里不能再把返回值当作文档发布。
                Promise.resolve(History.importProject(f)).then(function (ok) {
                    if (ok === false) return; // cancelled/failed; reason already reported
                    App.status("已打开工程：" + f.name);
                }).catch(appFail);
            });
            inp.click();
        } catch (err) {
            appFail(err);
        }
    }

    function onSave() {
        try {
            if (!has("Store") || typeof Store.save !== "function") {
                throw new Error("存储模块未就绪（app/store.js），无法保存");
            }
            var jobs = [Promise.resolve(Store.save({ label: "手动保存" }))];
            // 手动保存同时 drain 查看器服务的条件保存队列；本地工程快照与
            // /api/current 是两种持久化，不以后者替代前者。
            if (has("ViewerBoot") && typeof ViewerBoot.saveNow === "function") {
                jobs.push(ViewerBoot.saveNow());
            }
            return Promise.all(jobs).catch(appFail);
        } catch (err) {
            appFail(err);
            return Promise.resolve(null);
        }
    }

    function onGroup() {
        var sel = selectionOrWarn(1, "编组");
        if (!sel) return;
        commitOps([{ op: "group", targets: sel }], "编组");
    }

    function onUngroup() {
        var sel = selectionOrWarn(1, "解组");
        if (!sel) return;
        commitOps([{ op: "ungroup", targets: sel }], "解组");
    }

    function align(mode) {
        var sel = selectionOrWarn(2, "对齐");
        if (!sel) return;
        commitOps([{ op: "align", targets: sel, mode: mode }], "对齐（" + mode + "）");
    }

    function distribute(orientation) {
        var sel = selectionOrWarn(3, "分布");
        if (!sel) return;
        commitOps([{ op: "distribute", targets: sel, orientation: orientation }],
            "分布（" + orientation + "）");
    }

    function zOrder(to) {
        var sel = selectionOrWarn(1, "调整层级");
        if (!sel) return;
        commitOps([{ op: "z_order", targets: sel, to: to }], "层级：" + to);
    }

    function onDeleteSelection(sel) {
        var n = sel.length;
        if (has("Ui") && typeof Ui.confirm === "function") {
            Ui.confirm("删除选中的 " + n + " 个元素？").then(function (ok) {
                if (ok) commitOps([{ op: "delete", targets: sel }], "删除选中元素");
            }).catch(function () { /* cancelled */ });
            return;
        }
        commitOps([{ op: "delete", targets: sel }], "删除选中元素");
    }

    function zoomBy(factor) {
        try {
            if (!has("Editor") || typeof Editor.zoom !== "function") {
                throw new Error("Editor 未就绪，无法缩放");
            }
            Editor.zoom(factor, {});
        } catch (err) {
            appFail(err);
        }
    }

    function onZoomReset() {
        try {
            if (!has("Editor") || typeof Editor.fit !== "function") {
                throw new Error("Editor 未就绪，无法复位视图");
            }
            Editor.fit();
        } catch (err) {
            appFail(err);
        }
    }

    function renderOverlaySafe() {
        try {
            if (has("Editor") && typeof Editor.renderOverlay === "function") {
                Editor.renderOverlay();
            }
        } catch (err) {
            warn("Editor.renderOverlay 失败：" + msgOf(err));
        }
    }

    function bindToggle(id, key, onChange) {
        var el = byId(id);
        if (!el) {
            missingButtons.push(id);
            return;
        }
        el.addEventListener("click", function (ev) {
            ev.preventDefault();
            if (!has("App") || !App.ui) return;
            App.ui[key] = !App.ui[key];
            setPressed(el, App.ui[key]);
            if (onChange) onChange();
            if (typeof App.emit === "function") App.emit("ui:changed", { key: key, value: App.ui[key] });
        });
        if (has("App") && App.ui) setPressed(el, App.ui[key]);
    }

    function onExport() {
        try {
            if (!has("Exporter") || typeof Exporter.open !== "function") {
                throw new Error("导出模块未就绪（app/export.js）");
            }
            Exporter.open();
        } catch (err) {
            appFail(err);
        }
    }

    function onReview() {
        try {
            if (!has("AiPanel") || typeof AiPanel.review !== "function") {
                throw new Error("AI 面板未就绪（app/ai.js）");
            }
            var p = AiPanel.review();
            if (p && typeof p.catch === "function") p.catch(appFail);
        } catch (err) {
            appFail(err);
        }
    }

    function onSettings() {
        try {
            if (!has("Settings") || typeof Settings.open !== "function") {
                throw new Error("设置模块未就绪（app/settings.js）");
            }
            Settings.open();
        } catch (err) {
            appFail(err);
        }
    }

    function wireTopbar() {
        missingButtons = [];
        bindClick("btn-new", onNew);
        bindClick("btn-open", onOpen);
        bindClick("btn-save", onSave);
        bindClick("btn-undo", doUndo);
        bindClick("btn-redo", doRedo);
        bindClick("btn-group", onGroup);
        bindClick("btn-ungroup", onUngroup);
        bindClick("btn-align-left", function () { align("left"); });
        bindClick("btn-align-center", function () { align("center"); });
        bindClick("btn-align-right", function () { align("right"); });
        bindClick("btn-align-top", function () { align("top"); });
        bindClick("btn-align-middle", function () { align("middle"); });
        bindClick("btn-align-bottom", function () { align("bottom"); });
        bindClick("btn-distribute-h", function () { distribute("horizontal"); });
        bindClick("btn-distribute-v", function () { distribute("vertical"); });
        bindClick("btn-z-front", function () { zOrder("front"); });
        bindClick("btn-z-back", function () { zOrder("back"); });
        bindClick("btn-z-forward", function () { zOrder("forward"); });
        bindClick("btn-z-backward", function () { zOrder("backward"); });
        bindClick("btn-export", onExport);
        bindClick("btn-review", onReview);
        bindClick("btn-settings", onSettings);
        bindClick("zoom-out", function () { zoomBy(1 / ZOOM_STEP); });
        bindClick("zoom-in", function () { zoomBy(ZOOM_STEP); });
        bindClick("zoom-level", onZoomReset);
        bindToggle("toggle-guides", "showGuides", renderOverlaySafe);
        bindToggle("toggle-snap", "snap", null);
        if (missingButtons.length) {
            warn("以下顶栏按钮未找到：" + missingButtons.join("、"));
        }
    }

    // ------------------------------------------------------------------
    // 6. Keyboard shortcut fallback (Editor binds its own keys first;
    //    anything it preventDefault()s is skipped here).
    // ------------------------------------------------------------------

    function selectAll() {
        if (!has("App") || !App.doc) return;
        var ids = [];
        var els = App.doc.elements || [];
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.locked || el.visible === false) continue;
            if (el.parent_id) continue; // top-level only
            ids.push(el.id);
        }
        if (typeof App.select === "function") App.select(ids);
        if (typeof App.status === "function") App.status("已全选 " + ids.length + " 个元素");
    }

    function wireShortcuts() {
        document.addEventListener("keydown", function (ev) {
            if (ev.defaultPrevented) return; // already handled (Editor etc.)
            var t = ev.target;
            if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
                      t.tagName === "SELECT" || t.isContentEditable)) return;
            var key = ev.key || "";
            var k = key.toLowerCase();
            var mod = ev.ctrlKey || ev.metaKey;

            if (mod && k === "z" && !ev.shiftKey) { ev.preventDefault(); doUndo(); return; }
            if (mod && ((k === "z" && ev.shiftKey) || k === "y")) { ev.preventDefault(); doRedo(); return; }
            if (mod && k === "s") { ev.preventDefault(); onSave(); return; }
            if (mod && k === "a") {
                if (!has("App")) return;
                ev.preventDefault();
                selectAll();
                return;
            }
            if (key === "Delete" || key === "Backspace") {
                if (!has("App") || typeof App.selection !== "function") return;
                var sel = App.selection();
                if (sel && sel.length) {
                    ev.preventDefault();
                    onDeleteSelection(sel);
                }
                return;
            }
            if (key === "Escape") {
                if (has("App") && typeof App.clearSelection === "function") App.clearSelection();
                return;
            }
            if (key === "+" || key === "=") { zoomBy(ZOOM_STEP); return; }
            if (key === "-") { zoomBy(1 / ZOOM_STEP); return; }
        });
    }

    // ------------------------------------------------------------------
    // 7. Zoom label / topbar state / events
    // ------------------------------------------------------------------

    // No window-resize handler on purpose: Editor.fit() runs exactly once
    // after the first mount (see runBoot); fitting on every resize would
    // override the user's manual zoom.

    function refreshZoomLevel() {
        var el = byId("zoom-level");
        if (!el || !has("App") || !App.ui) return;
        var z = (typeof App.ui.zoom === "number" && App.ui.zoom > 0) ? App.ui.zoom : 1;
        el.textContent = Math.round(z * 100) + "%";
    }

    function syncTopbarButtons() {
        var doc = has("App") ? App.doc : null;
        var hist = (doc && doc.history) || [];
        var playheadFn = has("FigOps") &&
            (FigOps.contentRev || FigOps.contentRevOf || FigOps.getContentRev);
        var playhead = typeof playheadFn === "function" ? playheadFn(doc) : 0;
        var canUndo = false, canRedo = false;
        hist.forEach(function (r) {
            if (!r || r.kind === "revert") return;
            if ((r.rev || 0) <= playhead) canUndo = true;
            if ((r.rev || 0) > playhead) canRedo = true;
        });

        var selected = has("App") && typeof App.selection === "function" ? App.selection() : [];
        var selectedEls = selected.map(function (id) {
            return doc && has("FigDoc") && typeof FigDoc.get === "function" ? FigDoc.get(doc, id) : null;
        }).filter(Boolean);
        var n = selectedEls.length;
        var canUngroup = n > 0 && selectedEls.every(function (el) {
            return el.type === "group" || el.type === "panel";
        });
        function setEnabled(id, enabled) {
            var el = byId(id);
            if (!el) return;
            el.disabled = !enabled;
            el.setAttribute("aria-disabled", enabled ? "false" : "true");
        }
        setEnabled("btn-undo", canUndo);
        setEnabled("btn-redo", canRedo);
        setEnabled("btn-group", n >= 1);
        setEnabled("btn-ungroup", canUngroup);
        ["btn-align-left", "btn-align-center", "btn-align-right",
         "btn-align-top", "btn-align-middle", "btn-align-bottom"].forEach(function (id) {
            setEnabled(id, n >= 2);
        });
        setEnabled("btn-distribute-h", n >= 3);
        setEnabled("btn-distribute-v", n >= 3);
        ["btn-z-front", "btn-z-back", "btn-z-forward", "btn-z-backward"].forEach(function (id) {
            setEnabled(id, n >= 1);
        });
        // #btn-explode-chart 由 ChartEdit 独立维护，不能在这里覆盖。
    }

    function subscribeUiEvents() {
        if (!has("App") || typeof App.on !== "function") return;
        App.on("ui:changed", refreshZoomLevel);
        App.on("doc:changed", refreshZoomLevel);
        App.on("doc:changed", syncTopbarButtons);
        App.on("history:changed", syncTopbarButtons);
        App.on("selection:changed", syncTopbarButtons);
        refreshZoomLevel();
        syncTopbarButtons();
    }

    // ------------------------------------------------------------------
    // 8. Boot sequence + banner
    // ------------------------------------------------------------------

    function printBanner(doc, presetInfo) {
        var c = doc.canvas;
        var parts = ["[FigStudio v1] 启动完成"];
        parts.push("文档 " + doc.id + "（" + c.width_mm + "×" + c.height_mm + "mm @" + c.dpi + "dpi）");
        parts.push("模块挂载 " + bootStats.mounted + "/" + bootStats.total);
        if (presetInfo && presetInfo.counts) {
            parts.push("预设：期刊 " + presetInfo.counts.journals +
                " / 模板 " + presetInfo.counts.templates +
                " / 配色 " + presetInfo.counts.palettes +
                (presetInfo.fallback ? "（含内置兜底副本）" : "（已从 shared/presets 加载）"));
        }
        console.log(parts.join(" | "));
    }

    function runBoot(presetInfo, initialDoc) {
        if (!has("App") || typeof App.setDoc !== "function") {
            throw new Error("App 模块未加载（app/state.js），无法初始化文档");
        }
        templateRuntimeInstall();
        // v3 查看器：优先使用服务端（viewer.py /api/current）返回的当前文档；
        // 服务端暂无文档时回退为新建空文档。
        var doc = initialDoc || createDefaultDoc();
        App.setDoc(doc, { reason: "boot" });

        applyVariant();
        mountAll();
        wireTabs();
        subscribeUiEvents();
        if (has("ChartEdit") && typeof ChartEdit.mount === "function") ChartEdit.mount();
        wireTopbar();
        wireShortcuts();
        initSplitPane();
        initAiSplitPane();

        // Fit exactly once after the first mount; window resize must not
        // re-fit because that would override the user's manual zoom.
        try {
            if (has("Editor") && typeof Editor.fit === "function") Editor.fit();
        } catch (err) {
            warn("Editor.fit 失败：" + msgOf(err));
        }
        refreshZoomLevel();
        if (typeof App.status === "function") App.status("就绪");

        printBanner(doc, presetInfo);
    }

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn);
        } else {
            fn();
        }
    }

    global.FigurePhase5 = {
        install: templateRuntimeInstall,
        capabilities: capabilityList,
        capabilityForId: capabilityForId,
        assertTemplateApplicable: requireTemplateApplicable,
        assertRenderable: assertRenderable,
        renderNyquist: drawNyquist,
        fallbackTemplates: FB_TEMPLATES,
        fallbackRenderTypes: FALLBACK_RENDER_TYPES.slice(),
        loadPresets: loadPresets,
        decorateTemplateGallery: installTemplateGallery
    };
    if (typeof module !== "undefined" && module.exports) module.exports = global.FigurePhase5;

    if (global.document && typeof global.document.addEventListener === "function") {
        ready(function () {
            attachStore();
            var booted = false;
            function doBoot(info, initialDoc) {
                if (booted) return;
                booted = true;
                try {
                    runBoot(info, initialDoc);
                    // v3 查看器：boot 完成后挂接 App.commit → debounce 回写 /api/current。
                    if (has("ViewerBoot") && typeof ViewerBoot.attachAutoSave === "function") {
                        ViewerBoot.attachAutoSave();
                    } else {
                        warn("缺少 ViewerBoot（app/viewer-boot.js），本次会话不会自动回写文档到查看器服务");
                    }
                } catch (err) {
                    var m = "启动失败：" + msgOf(err);
                    warn(m);
                    var st = byId("status-text");
                    if (st) st.textContent = m;
                }
            }
            // v3 查看器：预设与当前文档并行加载；/api/current 404 或服务不在时
            // loadInitialDoc 返回 null，doBoot 回退为新建空文档。
            var serverDocPromise = (has("ViewerBoot") &&
                typeof ViewerBoot.loadInitialDoc === "function")
                ? ViewerBoot.loadInitialDoc()
                : Promise.resolve(null);
            Promise.all([loadPresets(), serverDocPromise]).then(function (results) {
                doBoot(results[0], results[1] || null);
            }, function (err) {
                warn("预设加载异常：" + msgOf(err));
                doBoot({ fallback: true, counts: null }, null);
            });
        });
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
