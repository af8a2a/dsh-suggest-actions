import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

/**
 * Minimal hooks runner: enough of React to render the card outside a browser,
 * with effects executed in order and state updates driving re-renders.
 */
function createHooksRuntime() {
  const runtime = { hooks: [], cursor: 0, deps: new Map(), cleanups: new Map(), pending: [], dirty: false }
  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    memo: (component) => component,
    useState(initial) {
      const index = runtime.cursor++
      if (!(index in runtime.hooks)) runtime.hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(runtime.hooks[index]) : value
        if (next !== runtime.hooks[index]) {
          runtime.hooks[index] = next
          runtime.dirty = true
        }
      }
      return [runtime.hooks[index], set]
    },
    useEffect(effect, deps) {
      const index = runtime.cursor++
      const previous = runtime.deps.get(index)
      const changed = !previous
        || !deps
        || deps.length !== previous.length
        || deps.some((value, position) => value !== previous[position])
      if (!changed) return
      runtime.deps.set(index, deps ? [...deps] : null)
      runtime.pending.push(() => {
        const cleanup = runtime.cleanups.get(index)
        if (typeof cleanup === 'function') cleanup()
        const result = effect()
        runtime.cleanups.set(index, typeof result === 'function' ? result : undefined)
      })
    },
    useCallback(callback) {
      runtime.cursor++
      return callback
    },
    useRef(initial) {
      const index = runtime.cursor++
      if (!(index in runtime.hooks)) runtime.hooks[index] = { current: initial }
      return runtime.hooks[index]
    },
  }
  return { React, runtime }
}

/** Render until state settles (effects schedule async work that re-renders). */
async function renderSettled(Component, props, runtime) {
  let tree
  for (let pass = 0; pass < 25; pass += 1) {
    runtime.cursor = 0
    runtime.dirty = false
    runtime.pending = []
    tree = Component(props)
    for (const effect of runtime.pending) effect()
    runtime.pending = []
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!runtime.dirty && pass > 0) break
  }
  return tree
}

async function loadPlugin() {
  const source = await readFile(new URL('../client/client.js', import.meta.url), 'utf8')
  let definition
  const window = { __ModuleLoader__: { load: (value) => { definition = value } } }
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  runInNewContext(source, { window, document, fetch: (...args) => globalThis.fetch(...args), AbortController, console, setTimeout, clearTimeout })
  assert.equal(definition?.id, 'dsh-suggest-actions')
  return definition
}

function collectChips(tree, out = []) {
  if (!tree || typeof tree !== 'object') return out
  const props = tree.props ?? {}
  if (tree.type === 'button' && String(props.className ?? '').includes('dsa-chip')) out.push(tree)
  const children = props.children
  if (Array.isArray(children)) for (const child of children) collectChips(child, out)
  else if (children && typeof children === 'object') collectChips(children, out)
  return out
}

test('client registers one turn-tail entry that renders and sends a chip', async () => {
  const definition = await loadPlugin()
  const { React, runtime } = createHooksRuntime()
  const registrations = []
  const sent = []
  let fetched = 0
  const payload = { ok: true, question: '希望优先深入哪一类改进项？', actions: [
    { label: '优先做单池多光源重构', prompt: '优先做单池多光源重构，并给出改造清单。' },
    { label: '优先做 GPU 侧缓存与剔除', prompt: '先做 GPU 侧缓存与剔除，评估收益。' },
  ] }

  const session = {
    beginSubmission: () => ({ requestId: 'req-1', abandon: () => {} }),
    prompt: async (content, mode) => {
      sent.push({ content, mode })
      return { ok: true }
    },
  }
  const ctx = {
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (slotName, factory) => {
        registrations.push({ slotName, entry: factory() })
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sessions: { binding: () => ({ session }) },
  }

  const exports = definition.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require: ${id}`)
  })
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale', 'sessions'])
  exports.apply(ctx)

  const turnTail = registrations.find((entry) => entry.slotName === 'conversation.chat.turnTail')
  assert.ok(turnTail, 'the plugin registers into conversation.chat.turnTail')
  const registerCall = registrations.find((entry) => entry.options?.name === 'conversation.chat.turnTail')
  assert.ok(registerCall, 'the slot entry keeps the turnTail name')
  const component = registerCall.component

  const face = registerCall.options.inject('session-1')
  assert.equal(face.sessionId, 'session-1')

  const fetchImpl = async (url, init) => {
    fetched += 1
    assert.equal(url, '/dsh-suggest-actions/suggest')
    const body = JSON.parse(init.body)
    assert.deepEqual(body, { sessionId: 'session-1', seq: 42 })
    return { ok: true, json: async () => payload }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    const props = { sessionId: 'session-1', seq: 42, turn: { turn: 3 }, getBinding: () => ({ session }) }
    const tree = await renderSettled(component, props, runtime)
    const chips = collectChips(tree)
    assert.equal(chips.length, 2, 'both actions render as chips')
    assert.match(JSON.stringify(tree), /优先做单池多光源重构/)
    assert.match(JSON.stringify(tree), /希望优先深入哪一类改进项？/)

    const before = sent.length
    chips[0].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(sent.length, before + 1, 'clicking a chip sends one prompt')
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].content)), [{ type: 'text', text: '优先做单池多光源重构，并给出改造清单。' }])
    assert.equal(sent[0].mode, 'queue')

    // A later Turn takes over: the older card must disappear and never refetch.
    const callsAfterNewest = fetched
    const olderProps = { sessionId: 'session-1', seq: 12, turn: { turn: 1 }, getBinding: () => ({ session }) }
    const olderTree = await renderSettled(component, olderProps, createHooksRuntime())
    assert.equal(olderTree, null, 'a tail older than the watermark renders nothing')
    assert.equal(fetched, callsAfterNewest, 'an older tail never spends a model call')
  } finally {
    globalThis.fetch = originalFetch
  }
})
