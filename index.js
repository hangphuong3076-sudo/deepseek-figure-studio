/**
 * index.js — dsh-figure-studio 的 Host 插件（DeepSeek Harness bundle 入口）。
 *
 * 依据官方文档实现：
 *   - 插件 = 导出 apply(ctx) 的模块（@deepseek-ai/cordis）
 *   - 工具 = ctx.tools.register(defineTool({...}))（@deepseek-ai/dsh-tools）
 *   - 配置 = 导出 Config 的 Schemastery schema（@deepseek-ai/schemastery）
 *
 * 本插件把 26 个 figure_* 工具注册进 DSH 的 tool registry；每个工具的 execute
 * 把调用转发给同包内的 Python 后端 `mcp/server.py`（stdio JSON-RPC 2.0 MCP），
 * 从而完整复用已经过端到端测试的图形内核、期刊预设、光栅导出与可追溯历史。
 * 工具 schema 的单一事实来源是 `mcp/tools.json`（由 `mcp/tools_spec.py` 生成）。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-figure-studio'
export const inject = ['tools', 'llm', 'agentDefaultModel']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(__dirname, 'mcp', 'server.py')

// ---------------------------------------------------------------------------
// 配置（cordis.yml 里 figure-studio 行的 config 字段，经 Schema 校验）
//   Config = { python: string, viewerPort: number, deepseekKeyFile: string }
// ---------------------------------------------------------------------------
export const Config = Schema.object({
  python: Schema.string().default(''),
  viewerPort: Schema.number().default(8770),
  deepseekKeyFile: Schema.string().default(''),
  startViewer: Schema.boolean().default(true),
  llmBridgePort: Schema.number().default(8771),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxTokens: Schema.number().default(8192),
})

// ---------------------------------------------------------------------------
// 工具清单：从 mcp/tools.json 同步读入（单一事实来源 = tools_spec.py）
// ---------------------------------------------------------------------------
const TOOLS = (() => {
  try {
    const raw = readFileSync(path.join(__dirname, 'mcp', 'tools.json'), 'utf8')
    return JSON.parse(raw).tools || []
  } catch (e) {
    // 读不到清单时仍加载（apply 阶段会再报中文错误），保证宿主不被静默挂掉。
    console.error('[dsh-figure-studio] 读取 mcp/tools.json 失败：', e && e.message)
    return []
  }
})()

// ---------------------------------------------------------------------------
// 常驻 Python 子进程 + JSON-RPC 客户端（stdio 逐行协议）
// ---------------------------------------------------------------------------
let child = null
let rl = null
let nextId = 1
const pending = new Map()
let ready = false
let initPromise = null
let pythonBin = null
let llmBridgeServer = null
let llmBridgeUrl = ''

function resolvePython(config) {
  if (pythonBin) return pythonBin
  pythonBin = (config && config.python) || process.env.FIGURE_PYTHON || 'python'
  return pythonBin
}

function spawnServer(config) {
  const bin = resolvePython(config)
  const args = [SERVER, '--port', String(config.viewerPort || 8770)]
  if (config.deepseekKeyFile) args.push('--key-file', config.deepseekKeyFile)
  // startViewer=true 时让 MCP 后端同进程托管可视化工作台，插件加载即出双栏 UI。
  if (config.startViewer !== false) args.push('--viewer')
  const env = { ...process.env }
  // 把本机 llm 桥地址传给工作台后端，让窗口右栏 AI 面板零 key 复用 DSH 的 DeepSeek。
  if (llmBridgeUrl) env.FIGURE_LLM_BRIDGE = llmBridgeUrl
  const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'], env, windowsHide: true })
  proc.on('exit', () => {
    // 后端退出后清空状态，下一次 execute 会自动重启。
    if (child === proc) { child = null; rl = null; ready = false }
    for (const [, p] of pending) p.reject(new Error('figure 后端进程已退出'))
    pending.clear()
  })
  proc.on('error', (err) => {
    if (child === proc) { child = null; rl = null; ready = false }
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  })
  child = proc
  rl = createInterface({ input: proc.stdout, terminal: false })
  rl.on('line', (line) => {
    const t = line.trim()
    if (!t) return
    let msg
    try { msg = JSON.parse(t) } catch { return }
    if (msg && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    }
  })
}

function rawRequest(method, params) {
  if (!child || !rl) throw new Error('figure 后端未启动')
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function ensureReady(config) {
  if (ready && child && rl) return
  if (initPromise) return initPromise
  initPromise = (async () => {
    spawnServer(config)
    await rawRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-figure-studio', version: '1.0.0' },
    })
    ready = true
  })()
  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

async function callTool(name_, args, config) {  await ensureReady(config)
  const result = await rawRequest('tools/call', { name: name_, arguments: args || {} })
  const text = result && result.content && result.content[0] && result.content[0].text
  let payload
  try { payload = JSON.parse(text) } catch { payload = { ok: false, error: 'figure 后端返回非 JSON：' + text } }
  if (payload && payload.ok === false) {
    throw new Error(payload.error || ('figure 工具 ' + name_ + ' 执行失败'))
  }
  return payload
}

// ---------------------------------------------------------------------------
// JSON Schema → defineTool parameters（object 顶层 → 参数名到 {type,required,description}）
// ---------------------------------------------------------------------------
function toParameters(schema) {
  const props = (schema && schema.properties) || {}
  const required = new Set(Array.isArray(schema && schema.required) ? schema.required : [])
  const out = {}
  for (const [key, p] of Object.entries(props)) {
    let t = p.type
    if (Array.isArray(t)) t = t[0] // 如 ["string","array"] 取第一种
    t = t || 'string'
    const spec = {
      type: t,
      description: p.description || '',
    }
    // DSH 的 harness.defineTool 只接受受限 JSON Schema 子集，两条硬约束：
    //   1) 非必填参数必须整个省略 required，写成 required:false 会被拒绝
    //      → JsonSchemaError: parameters.<name>.required must be true when present
    //   2) object 类型必须显式给出布尔 additionalProperties
    //      → JsonSchemaError: parameters.<name>.additionalProperties must be explicitly true or false
    if (required.has(key)) spec.required = true
    if (t === 'object') {
      // 开放对象：doc / data / inline 的真实结构交给 Python 后端校验，此处不做嵌套约束
      spec.additionalProperties = true
    } else if (t === 'array' && p.items && p.items.type) {
      const itemType = Array.isArray(p.items.type) ? p.items.type[0] : p.items.type
      spec.items = { type: itemType }
      if (itemType === 'object') spec.items.additionalProperties = true
    }
    out[key] = spec
  }
  return out
}

function renderText(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

// 打开原生窗口（native_viewer.py：pywebview → Chrome/Edge --app → 默认浏览器兜底）。
// 独立子进程、脱离父进程生命周期；窗口由用户关闭，插件卸载不强行杀掉 GUI。
function openNativeWindow(config, url) {
  try {
    const bin = resolvePython(config)
    const native = path.join(__dirname, 'mcp', 'native_viewer.py')
    const proc = spawn(bin, [native, '--url', url], { stdio: 'ignore', detached: true })
    proc.unref()
    return proc
  } catch (err) {
    console.error('[dsh-figure-studio] 打开原生窗口失败：', err && err.message)
    return null
  }
}

// ---------------------------------------------------------------------------
// 复用 DSH 自带模型连接（ctx.llm）：figure_review 的模型路径不再需要插件自持 key。
// ---------------------------------------------------------------------------
// 审阅上下文由服务端 FigAI.buildReviewMessages 统一构建，避免 Host 再维护一份信息更少的提示。

// DSH 0.2.2 的接口是 prepareCall/stream（异步 chunk 流），不是 OpenAI chat 方法。
// 系统提示独立传 system；本桥只实现 text block，再消费 text-delta。
// 本机桥没有实现 OpenAI image_url 到 DSH image block 的协议转换，带图必须本地报错。
function figureRoute(ctx, config) {
  const custom = config && config.provider && config.model
  const current = !custom && ctx.agentDefaultModel &&
    typeof ctx.agentDefaultModel.currentSelection === 'function'
    ? ctx.agentDefaultModel.currentSelection()
    : null
  const provider = custom ? config.provider : current && current.provider
  const model = custom ? config.model : current && current.model
  if (!provider || !model) {
    throw new Error('尚未选中 DSH 默认模型；请先在 DSH 中选择模型，或在绘图插件配置中同时填写 provider 与 model')
  }
  return { provider, model }
}

const IMAGE_UNSUPPORTED_ERROR = '当前 DSH 模型桥仅支持文本消息，不支持图像输入；未发起模型请求。请改用结构化文档审阅或支持 image_url 的直连模型'

function hasImageContent(messages) {
  return messages.some((message) => {
    const content = message && message.content
    return Array.isArray(content) && content.some((part) => part && (
      part.type === 'image_url' || part.type === 'image' || part.type === 'input_image' || part.image_url
    ))
  })
}

function harnessMessages(messages) {
  if (hasImageContent(messages)) throw new Error(IMAGE_UNSUPPORTED_ERROR)
  const system = []
  const out = []
  for (const message of messages) {
    const role = message && message.role
    const content = message && message.content
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : []).map((part) => part && part.type === 'text' ? part.text : '').join('')
    if (role === 'system') {
      system.push(text)
      continue
    }
    out.push({
      role: role === 'assistant' ? 'assistant' : role === 'developer' ? 'developer' : 'user',
      content: [{ type: 'text', text }],
      source: role === 'assistant' ? { kind: 'model' } : { kind: 'dsh-figure-studio' },
    })
  }
  return { system: system.join('\n\n'), messages: out }
}

function harnessError(reason) {
  if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
    const failure = reason.failure || {}
    throw new Error(failure.message || ('DSH 模型请求失败（' + reason.kind + '）'))
  }
}

// ---------------------------------------------------------------------------
// 模型请求进度（真实阶段，绝不伪造百分比）：
//   model_pending  已收到 /chat 请求，等待模型调用准备
//   model_prepare  正在 prepareCall
//   model_stream   正在消费 text-delta（只统计真实收到的增量段数/字符数，
//                  不假设模型 token 总量，因此不显示百分比）
//   model_complete 模型流正常终结
//   model_error    请求失败（错误原因原样记录，不伪装完成）
// 仅当 /chat body 携带 request_id（由窗口前端 settings.js 的 fetch 钩子附加，
// 只走本机桥，不进 DeepSeek 官方参数）时记录；GET /progress?request_id=
// 供 viewer.py /api/ai/progress 轻量轮询。任务表只保留最近有限条，
// 不保存 messages / key 等请求内容。
// ---------------------------------------------------------------------------
const LLM_PROGRESS_MAX = 64
const llmProgress = new Map()

function llmProgressSet(requestId, patch) {
  if (!requestId) return
  const prev = llmProgress.get(requestId) || {
    request_id: requestId,
    phase: 'model_pending',
    detail: '',
    deltas: 0,
    chars: 0,
    error: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const next = { ...prev, ...patch, request_id: requestId }
  next.updated_at = new Date().toISOString()
  // Map 按插入序淘汰最旧任务；刷新时先删后插，保证「最近使用」的保留。
  llmProgress.delete(requestId)
  llmProgress.set(requestId, next)
  while (llmProgress.size > LLM_PROGRESS_MAX) {
    const oldest = llmProgress.keys().next().value
    llmProgress.delete(oldest)
  }
}

async function consumeHarnessStream(stream, progress) {
  const parts = []
  const textIndexes = new Set()
  let finish = null
  for await (const chunk of stream) {
    if (!chunk || !chunk.type) continue
    if (chunk.type === 'text-delta') {
      if (!textIndexes.has(chunk.index)) {
        textIndexes.add(chunk.index)
        parts.push(chunk.text)
      } else {
        parts[parts.length - 1] += chunk.text
      }
      if (progress && typeof progress.delta === 'function') {
        progress.delta(typeof chunk.text === 'string' ? chunk.text : '')
      }
    } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text') {
      if (!textIndexes.has(chunk.index)) {
        textIndexes.add(chunk.index)
        parts.push(chunk.block.text || '')
      }
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
      harnessError(finish)
    }
  }
  if (!finish) throw new Error('DSH 模型响应没有终态 finish 事件')
  if (finish.kind !== 'stop' && finish.kind !== 'tool-calls' && finish.kind !== 'max-tokens') {
    throw new Error('DSH 模型响应未完成（' + finish.kind + '）')
  }
  const text = parts.join('')
  if (!text.trim()) throw new Error('DSH 模型没有返回文本内容')
  return text
}

async function callHarnessLlm(ctx, messages, config, progress) {
  if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
    if (progress) progress.fail(new Error('当前 DSH 没有可用的 llm 流式服务'))
    throw new Error('当前 DSH 没有可用的 llm 流式服务')
  }
  const route = figureRoute(ctx, config)
  const input = harnessMessages(messages)
  const maxTokens = config && isFinite(config.maxTokens) && config.maxTokens > 0
    ? Math.round(config.maxTokens)
    : 8192
  let call = null
  if (progress) progress.phase('model_prepare', '正在准备模型调用（prepareCall）')
  if (typeof ctx.llm.prepareCall === 'function') {
    call = await ctx.llm.prepareCall({ ...route, maxTokens })
  }
  const streamInput = { ...(call ? call.config : { ...route, maxTokens }), ...input, purpose: 'figure-studio' }
  const stream = call && typeof call.stream === 'function'
    ? call.stream(streamInput)
    : ctx.llm.stream(streamInput)
  try {
    const text = await consumeHarnessStream(stream, progress)
    if (progress) progress.phase('model_complete', '模型返回完成')
    return text
  } catch (err) {
    if (progress) progress.fail(err)
    throw err
  }
}

// ---------------------------------------------------------------------------
// 本机 llm 桥：把窗口右栏 AI 面板的 /chat 请求转发到 ctx.llm，实现「窗口零 key」。
//   - POST /chat   body {messages:[...], model?, request_id?} → callHarnessLlm → OpenAI 形状
//                  （request_id 只用于进度追踪，不转发给模型）
//   - GET  /progress?request_id=… 真实阶段进度（model_pending/prepare/stream/complete/error）
//   - GET  /health {ok:true}
// 只在 ctx.llm 存在且 startViewer 未关闭时启动；端口由 config.llmBridgePort 指定。
// ---------------------------------------------------------------------------
function startLlmBridge(ctx, config) {
  const llm = ctx && ctx.llm
  if (!llm) return
  const port = config.llmBridgePort || 8771
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return
    }
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // 轻量进度查询：只回 phase / 计数 / 简短 error，不含任何 prompt 或 key。
    if (req.method === 'GET' && (req.url === '/progress' || req.url.startsWith('/progress?'))) {
      const q = new URL(req.url, 'http://127.0.0.1')
      const requestId = String(q.searchParams.get('request_id') || '')
      if (!requestId) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '缺少 request_id' }))
        return
      }
      const task = llmProgress.get(requestId)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(task
        ? { ok: true, task }
        : { ok: false, error: '未找到该 request_id 的进度记录（可能已过期或请求未携带 request_id）' }))
      return
    }
    if (req.method === 'POST' && (req.url === '/chat' || req.url === '/chat/')) {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', async () => {
        let messages = []
        let requestId = ''
        try {
          const body = raw ? JSON.parse(raw) : {}
          messages = Array.isArray(body.messages) ? body.messages : []
          // request_id 是前端经过本机桥时附加的追踪字段，不是模型参数；
          // 官方 DeepSeek 请求体不会带它，也不会被转发给 ctx.llm。
          if (typeof body.request_id === 'string' && body.request_id.trim()) {
            requestId = body.request_id.trim().slice(0, 128)
          }
        } catch {
          messages = []
        }
        const send = (status, obj) => {
          try {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(obj))
          } catch { /* 连接已关闭 */ }
        }
        if (!messages.length) {
          send(400, { error: 'messages 不能为空' })
          return
        }
        if (hasImageContent(messages)) {
          send(415, { error: IMAGE_UNSUPPORTED_ERROR })
          return
        }
        let progress = null
        if (requestId) {
          llmProgressSet(requestId, {
            phase: 'model_pending',
            detail: '已收到模型请求，等待准备',
            deltas: 0,
            chars: 0,
            error: null,
          })
          progress = {
            phase(nextPhase, detail) {
              llmProgressSet(requestId, { phase: nextPhase, detail: detail || '', error: null })
            },
            delta(text) {
              const t = llmProgress.get(requestId)
              llmProgressSet(requestId, {
                phase: 'model_stream',
                detail: '模型返回中：已接收 ' + ((t ? t.deltas : 0) + 1) + ' 段 / ' +
                  ((t ? t.chars : 0) + (text ? text.length : 0)) + ' 字符',
                deltas: (t ? t.deltas : 0) + 1,
                chars: (t ? t.chars : 0) + (text ? text.length : 0),
              })
            },
            fail(err) {
              llmProgressSet(requestId, {
                phase: 'model_error',
                detail: '',
                error: err && err.message ? String(err.message).slice(0, 300) : String(err),
              })
            },
          }
        }
        try {
          const text = await callHarnessLlm(ctx, messages, config, progress)
          if (text == null) {
            if (progress) progress.fail(new Error('ctx.llm 未命中或返回为空'))
            send(502, { error: 'DSH 模型连接不可用（ctx.llm 未命中或返回为空）' })
            return
          }
          send(200, { choices: [{ message: { content: text } }] })
        } catch (err) {
          send(502, { error: err && err.message ? err.message : String(err) })
        }
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  // 立即把 URL 暴露给 spawnServer（在 listen 完成前也可，真实 /chat 请求发生在桥就绪之后）。
  llmBridgeUrl = 'http://127.0.0.1:' + port
  server.on('error', (err) => {
    console.error('[dsh-figure-studio] llm 桥启动失败：', err && err.message)
    if (llmBridgeServer === server) llmBridgeServer = null
    llmBridgeUrl = ''
  })
  server.listen(port, '127.0.0.1', () => {
    llmBridgeServer = server
    ctx.logger?.info?.('[dsh-figure-studio] llm 桥已启动：%s（窗口 AI 面板零 key 复用 DSH DeepSeek）', llmBridgeUrl)
  })
}

function reviewDocumentContext(doc) {
  const elements = Array.isArray(doc && doc.elements) ? doc.elements : []
  return {
    id: (doc && doc.id) || '',
    title: (doc && doc.title) || '',
    canvas: (doc && doc.canvas) || {},
    elements: elements.filter((e) => e && typeof e === 'object').map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name || e.label || null,
      parent_id: e.parent_id || null,
      children: Array.isArray(e.children) ? e.children : undefined,
      visible: e.visible !== false,
      bbox_mm: e.transform || e.bbox_mm || null,
      style: e.style || null,
      text: e.text == null ? null : String(e.text),
    })),
    panels: Array.isArray(doc && doc.panels) ? doc.panels : [],
    anchors: Array.isArray(doc && doc.anchors) ? doc.anchors : [],
    scientific_contract: doc && doc.meta && doc.meta.scientific_contract
      ? doc.meta.scientific_contract
      : null,
    statistics_by_chart: elements.filter((e) => e && e.type === 'chart' && e.chart && e.chart.statistics)
      .map((e) => ({ id: e.id, statistics: e.chart.statistics })),
  }
}

async function buildHarnessReviewMessages(args, config) {
  const request = { doc: args && args.doc, build_messages_only: true }
  if (args && args.journal_id) request.journal_id = args.journal_id
  const built = await callTool('figure_review', request, config)
  const messages = built && built.messages
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('figure_review 后端未返回审阅 messages，无法构建 DSH 结构化审阅上下文')
  }
  const contextualMessages = [...messages, {
    role: 'user',
    content: '审阅用结构化 FigureDocument 上下文（style/font、bbox_mm 与 text 均为文档值，不是像素观察）：\n' +
      JSON.stringify(reviewDocumentContext(args && args.doc)),
  }]
  if (hasImageContent(contextualMessages)) {
    throw new Error('审阅上下文包含图像，已停止 DSH 文本模型请求；请移除附图后重试')
  }
  return contextualMessages
}

// ---------------------------------------------------------------------------
// apply：注册 figure_* 工具（当前含科学论证合同与科学审计工具）
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  if (!Array.isArray(TOOLS) || TOOLS.length === 0) {
    ctx.logger?.error?.('[dsh-figure-studio] 未找到 mcp/tools.json，figure_* 工具未注册')
    return
  }

  for (const tool of TOOLS) {
    const isReview = tool.name === 'figure_review'
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: toParameters(tool.inputSchema),
      output: {
        // DSH 的 schema DSL 要求：type:'object' 必须显式声明 additionalProperties 布尔值
        // → 否则 JsonSchemaError: schema.additionalProperties must be explicitly true or false
        schema: { type: 'object', additionalProperties: true },
        render: renderText,
      },
      async execute(args) {
        // figure_review 优先复用 DSH 自带的模型连接（ctx.llm），零 key；
        // 失败则回退到 Python 路径（插件自持 key 或离线规则）。
        if (isReview) {
          try {
            const messages = await buildHarnessReviewMessages(args || {}, config)
            const text = await callHarnessLlm(ctx, messages, config)
            if (text != null) {
              return await callTool('figure_review', { ...(args || {}), model_response: text }, config)
            }
          } catch (err) {
            console.error('[dsh-figure-studio] harness llm 审阅失败，回退 Python 路径：', err && err.message)
          }
        }
        return callTool(tool.name, args, config)
      },
    }))
  }

  // 卸载时杀掉常驻 Python 子进程（ctx.effect 的 disposer）。
  ctx.effect(() => {
    return () => {
      if (child) { try { child.stdin.end() } catch { /* 忽略 */ } child.kill() }
      child = null
      rl = null
      ready = false
      initPromise = null
      pending.clear()
      if (llmBridgeServer) {
        try { llmBridgeServer.close() } catch { /* 忽略 */ }
        llmBridgeServer = null
      }
      llmBridgeUrl = ''
    }
  })

  ctx.logger?.info?.('[dsh-figure-studio] 已注册 %d 个 figure_* 工具（后端 %s）', TOOLS.length, SERVER)

  // 插件加载时立即拉起后端；startViewer=true 时可视化双栏工作台以「原生窗口」打开。
  if (config.startViewer !== false) {
    // 先起本机 llm 桥（同步设置 llmBridgeUrl），再 spawn 后端，把地址通过环境变量传给 viewer.py。
    startLlmBridge(ctx, config)
    const url = 'http://127.0.0.1:' + (config.viewerPort || 8770) + '/'
    ensureReady(config)
      .then(() => {
        ctx.logger?.info?.('[dsh-figure-studio] 可视化工作台服务已启动：%s', url)
        const proc = openNativeWindow(config, url)
        if (proc) {
          ctx.logger?.info?.('[dsh-figure-studio] 已打开原生窗口（native_viewer.py）')
        } else {
          ctx.logger?.warn?.('[dsh-figure-studio] 原生窗口启动失败，请手动访问 %s', url)
        }
      })
      .catch((err) => ctx.logger?.warn?.('[dsh-figure-studio] 可视化工作台启动失败：%s', err && err.message))
  }
}
