/**
 * Same-origin HTTP route that turns a session's recent transcript into a
 * next-step suggestion card payload. The client calls it for the turn tail it
 * is about to render; results are cached per (session, seq) so re-mounts and
 * React double effects do not spend a second model call.
 * @module lib/route
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  buildSystem,
  buildUserMessage,
  detectLanguageName,
  extractJson,
  normalizePayload,
  recentMessages,
} from './suggest.mjs'

const MAX_BODY = 8 * 1024
const CACHE_TTL_MS = 15 * 60 * 1000
const CACHE_LIMIT = 60

/** Plugin version, read rather than hardcoded so diagnostics report the truth. */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
})()

/**
 * Buffer and parse a small JSON request body.
 * @param req - the HTTP request.
 * @returns the parsed object, or `null` when it is not valid JSON within the limit.
 */
function readJson(req) {
  return new Promise((resolve) => {
    /** Buffer chunks first: concatenating them as strings can split a multi-byte character. */
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY) {
        tooBig = true
        chunks.length = 0
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (tooBig) return resolve(null)
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * Write one JSON response, tolerating an already-closed socket.
 * @param res - the HTTP response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Resolve the provider/model the suggestion call should use: the session's own
 * selection first, then the configured default.
 * @param ctx - the plugin context.
 * @param session - the target session.
 * @returns `{ provider, model }`.
 */
export function resolveRoute(ctx, session) {
  try {
    const config = session?.requestHeader?.()?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    // A session without a resolvable header falls through to the default route.
  }
  const fallback = ctx?.agentDefaultModel?.currentSelection?.() ?? {}
  return { provider: fallback.provider, model: fallback.model }
}

/**
 * Stream one completion into a single string.
 * @param ctx - the plugin context.
 * @param options - route, prompts, token cap, and cancellation.
 * @returns the combined assistant text.
 */
async function streamText(ctx, { provider, model, system, user, maxTokens, sessionId, signal }) {
  const messages = [{
    id: randomUUID(),
    role: 'user',
    source: { kind: 'dsh-suggest-actions' },
    content: [{ type: 'text', text: user }],
  }]
  let output = ''
  let finish
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    messages,
    system,
    maxTokens,
    sessionId,
    purpose: 'suggest-actions',
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
    if (chunk?.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const failure = finish.failure
    throw new Error(failure?.message ?? failure?.code ?? `suggest-actions: model call ${finish.kind}`)
  }
  return output.trim()
}

/**
 * Register the suggestion route.
 * @param ctx - the plugin context (needs `webServer`, `connection`, `sessions`, `llm`, `agentDefaultModel`).
 * @param config - deployment defaults from cordis.patch.yml.
 * @returns a disposer, or `null` when the web server is unavailable.
 */
export function registerSuggestRoute(ctx, config = {}) {
  const webServer = ctx?.webServer
  const connection = ctx?.connection
  if (!webServer || typeof webServer.register !== 'function') return null

  const enabled = config.enabled !== false
  const maxActions = clampInt(config.maxActions, 1, 4, 3)
  const timeoutMs = clampInt(config.timeoutMs, 2000, 60000, 15000)
  const maxTokens = clampInt(config.maxTokens, 120, 1200, 500)
  const maxMessages = clampInt(config.maxMessages, 2, 20, 8)
  const maxChars = clampInt(config.maxChars, 1000, 20000, 6000)

  /** sessionId:seq -> { at, payload }; insertion order doubles as LRU order. */
  const cache = new Map()
  /** sessionId:seq -> in-flight promise, so double mounts share one call. */
  const inflight = new Map()

  const cacheGet = (key) => {
    const hit = cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key)
      return undefined
    }
    cache.delete(key)
    cache.set(key, hit)
    return hit.payload
  }
  const cacheSet = (key, payload) => {
    cache.delete(key)
    cache.set(key, { at: Date.now(), payload })
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  /**
   * Ask the model for one card payload.
   * @param session - target session.
   * @param signal - cancellation for the whole request.
   * @returns the normalized `{ question, actions }` payload plus call metadata.
   */
  const generate = async (session, signal) => {
    const history = recentMessages(session.deriveMessages?.() ?? [], { maxMessages, maxChars })
    if (history.length === 0) throw new Error('suggest-actions: nothing to suggest from yet')
    const language = detectLanguageName(history)
    const route = resolveRoute(ctx, session)
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') {
      throw new Error('suggest-actions: the session has no provider/model route')
    }
    const system = buildSystem(language, maxActions)
    const user = buildUserMessage(history, language)
    const startedAt = Date.now()
    const reply = await streamText(ctx, {
      ...route,
      system,
      user,
      maxTokens,
      sessionId: session.id,
      signal,
    })
    if (!reply) throw new Error('suggest-actions: the model returned nothing')
    let payload
    try {
      payload = normalizePayload(extractJson(reply), { maxActions })
    } catch (error) {
      // One repair attempt: the model sometimes wraps JSON in prose despite the contract.
      const repaired = await streamText(ctx, {
        ...route,
        system,
        user: `${user}\n\nYour previous reply was rejected (${error.message}). Return ONLY the JSON object, with no prose and no code fence.`,
        maxTokens,
        sessionId: session.id,
        signal,
      })
      payload = normalizePayload(extractJson(repaired), { maxActions })
    }
    return {
      ok: true,
      ...payload,
      provider: route.provider,
      model: route.model,
      ms: Date.now() - startedAt,
    }
  }

  const route = {
    kind: 'prefix',
    path: '/dsh-suggest-actions',
    handler: async (req, res) => {
      let rejection
      if (typeof connection?.requestRejection === 'function') {
        try {
          rejection = connection.requestRejection(req)
        } catch {
          rejection = 403
        }
      } else {
        // Without the browser-cookie check this route would be reachable off-machine.
        rejection = 403
      }
      if (rejection !== undefined) {
        sendJson(res, rejection, { ok: false, reason: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://x')

      if (url.pathname === '/dsh-suggest-actions/status' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, enabled, version: PLUGIN_VERSION, maxActions })
        return
      }

      if (url.pathname !== '/dsh-suggest-actions/suggest' || req.method !== 'POST') {
        sendJson(res, 404, { ok: false, reason: 'not-found' })
        return
      }
      if (!enabled) {
        sendJson(res, 200, { ok: false, disabled: true, reason: 'disabled' })
        return
      }

      const body = await readJson(req)
      if (!body || typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
        sendJson(res, 400, { ok: false, reason: 'missing-session-id' })
        return
      }
      const sessionId = body.sessionId.trim()
      const seq = Number.isFinite(Number(body.seq)) ? String(Number(body.seq)) : 'latest'
      const key = `${sessionId}:${seq}`
      const cached = cacheGet(key)
      if (cached) {
        sendJson(res, 200, cached)
        return
      }
      if (inflight.has(key)) {
        try {
          sendJson(res, 200, await inflight.get(key))
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error) })
        }
        return
      }

      const session = ctx.sessions?.get?.(sessionId)
      if (!session) {
        sendJson(res, 404, { ok: false, reason: 'session-not-found' })
        return
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort('suggest-actions timeout'), timeoutMs)
      const onClose = () => {
        if (!res.writableEnded) controller.abort('client disconnected')
      }
      res.on('close', onClose)
      const pending = generate(session, controller.signal)
      inflight.set(key, pending)
      try {
        const payload = await pending
        cacheSet(key, payload)
        sendJson(res, 200, { ...payload, seq: Number(seq) || null, sessionId })
      } catch (error) {
        const reason = controller.signal.aborted
          ? String(controller.signal.reason ?? 'aborted')
          : String(error?.message ?? error)
        sendJson(res, 200, { ok: false, reason })
      } finally {
        inflight.delete(key)
        clearTimeout(timer)
        res.off('close', onClose)
      }
    },
  }

  return webServer.register(route)
}

/**
 * Clamp an optional numeric config field.
 * @param value - configured value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the field is absent or not a number.
 * @returns the clamped integer.
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}
