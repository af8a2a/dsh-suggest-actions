import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerSuggestRoute } from '../lib/route.mjs'

/** Build a request stream carrying a JSON body. */
function makeRequest(url, body) {
  const encoded = Buffer.from(JSON.stringify(body ?? {}), 'utf8')
  const stream = Readable.from([encoded])
  stream.url = url
  stream.method = 'POST'
  stream.headers = {}
  return stream
}

/** Collect one JSON response. */
function makeResponse() {
  const chunks = []
  return {
    status: 0,
    headers: {},
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      chunks.push(String(chunk))
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk))
      this.writableEnded = true
      this.body = chunks.join('')
    },
    flushHeaders() {},
    on() {},
    off() {},
  }
}

/** A session whose transcript is two messages and whose route is fixed. */
function makeSession(id = 'session-1') {
  return {
    id,
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看 VSM 的改进路线' }] },
      {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '已分析完，短期建议单池多光源重构，中期建议 GPU 侧缓存与剔除。希望优先深入哪一类改进项？',
        }],
      },
    ],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
  }
}

/** Fake cordis context with a captured route and a scripted model. */
function makeContext({ streamText, session = makeSession() } = {}) {
  const context = { route: null, calls: [], disposer: null }
  context.ctx = {
    webServer: {
      register: (route) => {
        context.route = route
        return () => {
          context.disposer = true
        }
      },
    },
    connection: { requestRejection: () => undefined },
    sessions: { get: (id) => (session && session.id === id ? session : undefined) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'default', model: 'default-model' }) },
    llm: {
      stream: (options) => {
        context.calls.push(options)
        return (async function* stream() {
          const text = typeof streamText === 'function' ? streamText(options, context.calls.length) : streamText
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  context.dispose = registerSuggestRoute(context.ctx, {})
  return context
}

test('the route answers with a normalized card payload from the session route', async () => {
  const reply = '{"question":"希望优先深入哪一类改进项？","actions":[{"label":"单池多光源重构","prompt":"优先做单池多光源重构。"},{"label":"GPU 侧缓存与剔除","prompt":"先做 GPU 侧缓存与剔除。"}]}'
  const context = makeContext({ streamText: reply })
  const response = makeResponse()
  await context.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'session-1', seq: 7 }), response)

  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.question, '希望优先深入哪一类改进项？')
  assert.deepEqual(payload.actions.map((action) => action.label), ['单池多光源重构', 'GPU 侧缓存与剔除'])
  assert.equal(payload.provider, 'deepseek')
  assert.equal(payload.model, 'deepseek-chat')

  const call = context.calls[0]
  assert.equal(call.provider, 'deepseek')
  assert.equal(call.model, 'deepseek-chat')
  assert.equal(call.purpose, 'suggest-actions')
  assert.match(call.system, /STRICT JSON/)
  assert.match(call.messages[0].content[0].text, /<conversation>/)
})

test('a second request for the same tail is served from cache', async () => {
  const reply = '{"question":"q","actions":[{"label":"a","prompt":"a"}]}'
  const context = makeContext({ streamText: reply })
  for (let index = 0; index < 2; index += 1) {
    const response = makeResponse()
    await context.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'session-1', seq: 3 }), response)
    assert.equal(JSON.parse(response.body).ok, true)
  }
  assert.equal(context.calls.length, 1, 'the second identical request does not call the model again')
})

test('a malformed first reply is repaired once, then rejected', async () => {
  let replies = ['not json at all', '{"question":"q","actions":[{"label":"a"}]}']
  const context = makeContext({ streamText: () => replies.shift() })
  const response = makeResponse()
  await context.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'session-1', seq: 9 }), response)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.actions, [{ label: 'a', prompt: 'a' }])
  assert.equal(context.calls.length, 2, 'the repair attempt is a second call')
  assert.match(context.calls[1].messages[0].content[0].text, /rejected/)
})

test('missing session and disabled plugin fail without calling the model', async () => {
  const context = makeContext({ streamText: '{"question":"q","actions":[{"label":"a"}]}' })
  const missing = makeResponse()
  await context.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'nope' }), missing)
  assert.equal(missing.status, 404)
  assert.equal(JSON.parse(missing.body).reason, 'session-not-found')
  assert.equal(context.calls.length, 0)

  const offContext = makeContext({ streamText: 'x' })
  offContext.ctx.webServer.register = (route) => {
    offContext.route = route
    return () => {}
  }
  registerSuggestRoute(offContext.ctx, { enabled: false })
  const disabledResponse = makeResponse()
  await offContext.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'session-1' }), disabledResponse)
  assert.equal(JSON.parse(disabledResponse.body).disabled, true)
  assert.equal(offContext.calls.length, 0)
})

test('an unauthorized request is refused before any work', async () => {
  const context = makeContext({ streamText: 'x' })
  context.ctx.connection.requestRejection = () => 403
  const response = makeResponse()
  await context.route.handler(makeRequest('/dsh-suggest-actions/suggest', { sessionId: 'session-1' }), response)
  assert.equal(response.status, 403)
  assert.equal(context.calls.length, 0)
})
