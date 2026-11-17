/**
 * llm-bridge.js — 本机 llm 桥（从 index.js 抽出，纯 node:http、无 DSH 依赖）。
 *
 *   - POST /chat   body {messages:[...], model?, request_id?} → callLlm → OpenAI 形状
 *                  （request_id 只用于进度追踪，不转发给模型；请求体上限 16 MiB，超出 413）
 *   - GET  /progress?request_id=… 真实阶段进度（model_pending/prepare/stream/complete/error）
 *   - GET  /health {ok:true}
 *
 * 安全：不发 CORS 头、不处理 OPTIONS（落到 404）；viewer.py 服务端转发是唯一调用方，
 * 前端浏览器从不直连本桥，因此任何网页都无法跨域读取 /chat 回复。
 * 带 Origin 头（只有浏览器会带）或 Host 不是 loopback:端口（DNS 重绑定）的请求一律 403，
 * 防止网页用 no-cors 表单式 POST 盗用模型额度。
 * 只在 ctx.llm 存在且 startViewer 未关闭时启动；端口由 config.llmBridgePort 指定。
 */
import http from 'node:http'

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

// /chat 请求体上限：16 MiB。超出立即回 413 并停止累积/读取。
const CHAT_BODY_MAX_BYTES = 16 * 1024 * 1024

let llmBridgeServer = null
let llmBridgeUrl = ''

export function getLlmBridgeUrl() {
  return llmBridgeUrl
}

export function closeLlmBridge() {
  if (llmBridgeServer) {
    try { llmBridgeServer.close() } catch { /* 忽略 */ }
    llmBridgeServer = null
  }
  llmBridgeUrl = ''
}

/**
 * 启动本机桥。deps 由 index.js 注入（避免本模块反向依赖 DSH）：
 *   callLlm(ctx, messages, config, progress) -> Promise<string|null>
 *   hasImage(messages) -> bool
 *   imageErr -> string
 */
export function startLlmBridge(ctx, config, deps) {
  const llm = ctx && ctx.llm
  const callLlm = deps && deps.callLlm
  if (!llm || typeof callLlm !== 'function') return
  const hasImage = deps.hasImage || (() => false)
  const imageErr = deps.imageErr || '图像消息不支持'
  const port = config.llmBridgePort || 8771
  const allowedHosts = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port])
  const server = http.createServer((req, res) => {
    if (req.headers.origin !== undefined || !allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden' }))
      return
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
      let size = 0
      let overflow = false
      req.on('data', (c) => {
        if (overflow) return
        size += c.length
        if (size > CHAT_BODY_MAX_BYTES) {
          overflow = true
          raw = ''
          // 立即回 413；overflow 后 data 回调直接 return，停止累积（停止读取语义）。
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '请求体超过 16 MiB 上限' }))
          return
        }
        raw += c
      })
      req.on('end', async () => {
        if (overflow) return
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
        if (hasImage(messages)) {
          send(415, { error: imageErr })
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
          const text = await callLlm(ctx, messages, config, progress)
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
