/**
 * client.js — dsh-figure-studio 的 Client 浏览器半（可选，用于把工作台入口挂进
 * DSH Web UI）。依据官方 cookbook《Cookbook: live configuration forms》与
 * 《capability-seams》编写。
 *
 * ⚠️ 说明（诚实标注）：
 * - 本文件按官方文档给出的 `dsh.client` + 槽位（ctx.slots.inject /
 *   ctx.configForms.whileServed）API 编写，是可直接照抄进你的 bundle 的脚手架；
 * - client 模块的**懒 CJS 工厂包装格式**（"注册包名 + factory(require)"）在官方
 *   `packages/client/tsdown.client.ts` / client-module README 中定义，本仓库无 DSH
 *   源码，故该包装层需在能访问 DSH checkout 的环境下按 README 套上后再发布；
 * - 不装 client 半也不影响 Host 侧 26 个 figure_* 工具，可视化双栏工作台始终可通过
 *   `figure_open_viewer` 工具（或根目录 `start-viewer.bat`）独立打开。
 *
 * 本文件声明的能力：
 *   1) 在 Plugins 页给本 bundle 追加一个 section：显示工作台端口并提示打开方式；
 *   2) 若宿主提供 configForms，暴露 viewerPort / deepseekKeyFile 两个实时配置字段。
 */
;(function registerFigureStudioClient(hostApi) {
  'use strict'

  // 防御：不同 DSH 版本注入的宿主 API 可能略有差异，逐项特性检测，缺了就跳过。
  const slots = hostApi && hostApi.slots
  const configForms = hostApi && hostApi.configForms
  const t = hostApi && typeof hostApi.t === 'function' ? hostApi.t : (s) => s

  if (slots && typeof slots.inject === 'function') {
    try {
      slots.inject('plugins.detail.section', () =>
        slots.register({
          name: 'plugins.detail.section',
          id: 'figure-studio-viewer',
          locale: 'figureStudioViewer',
        }, ({ subject }) => {
          // 只对 dsh-figure-studio 这个 bundle 生效，其余返回 null。
          if (!subject || subject.kind !== 'bundle' || subject.pkg !== 'dsh-figure-studio') {
            return null
          }
          // 无 JSX 运行时时的文本回退：避免因 React 元素缺失导致加载失败。
          const note = t('figureStudioViewerHint')
          return { __text: note } // 占位；正式构建请换成对应 UI 元素的 JSX。
        }))
    } catch (e) {
      console.warn('[dsh-figure-studio] 注册 plugins.detail.section 失败：', e && e.message)
    }
  }

  if (configForms && typeof configForms.whileServed === 'function') {
    try {
      configForms.whileServed('dsh-figure-studio', ({ form }) => {
        // viewerPort / deepseekKeyFile 两个字段已由 Host 的 Config schema 声明；
        // 这里只做字段存在性兜底，实际渲染交给宿主 settings 表单。
        return form && form.state ? form : null
      })
    } catch (e) {
      console.warn('[dsh-figure-studio] 注册 configForms 失败：', e && e.message)
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis.__dshClientApi : undefined)
