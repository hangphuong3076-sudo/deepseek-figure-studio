---
description: 打开可视化双栏工作台（左编辑 SVG + 右 AI 对话）
argument-hint: "[port 默认 8770]"
---

# /figure-viewer — 打开可视化工作台

## 用途

启动并打开本插件的可视化双栏工作台：**左边是可拖拽/编辑的 SVG 画布，右边是 AI 对话面板**。适合需要人工在画布上直接操作（移动、改字、编组、对齐、框选）、或与 AI 一来一回改图的场景。

## 入参

1. `port`（可选）：监听端口，默认 `8770`。

## 执行步骤

1. 调用 MCP 工具 `figure_open_viewer`，参数 `{"doc": <当前 doc>}`（若已有文档则传入，工作台会载入它）；
2. 把返回的 `url`（如 `http://127.0.0.1:8770/`）交给用户，在浏览器打开；
3. Windows 原生窗口优先运行本插件根目录的 `start-native-viewer.bat`，或执行 `python mcp/native_viewer.py --serve --port 8770`；`start-viewer.bat` / `python mcp/viewer.py --port 8770` 是浏览器备选。
4. 实体关系图可先在「实体关系」面板编辑节点文字、role 颜色语义、通用形状、方向、包含分组与来源定位；预览隔离于正式图稿，只有「提交到画布」才经 `apply_schematic` 写历史。节点/容器可用普通拖动、对齐与文字编辑，connector 会按移动后的真实 bbox 重算，不能拿静态路径代替。
5. 外部或 DeepSeek 流程可先调用 `figure_schematic`（`preview:true`）取得 doc/SVG，再把 doc 推给本窗口；来源默认 `user_provided_unverified`。真实人工检查完成后才可填写 reviewer、checked_at、outcome、notes，自动测试不会生成这些记录。交付用 `figure_export` 或 `figure_export_bundle` 产生实际 SVG/PNG/PDF，不能只交预览截图代替可编辑源。

## 调用的工具

- MCP：`figure_open_viewer`（把当前 doc 推给工作台并返回 URL）

## 备注

- 右栏下半部分是常驻 AI 对话区，上方保留工具与属性面板，并非只存在于某一个旧式标签页。
- 编辑保存使用当前版本的 `base_token`；过期版本返回 HTTP 409 / `save_conflict`，停止自动覆盖。先用「历史 → 导出工程」保留本页备份，再刷新核对并手动合并；不提供常驻同步自动合并承诺。
- DSH 模型桥提供文本聊天路径；审阅基于结构化文档与规则，不支持附图时不宣称完成视觉或审美审查。视觉直连尚需按用户实际模型能力测试，不预先承诺真实账号已连接；无 key 时使用明确标注的离线规则回退。
