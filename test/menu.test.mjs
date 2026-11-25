import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const bundle = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
class Node {
  callbacks = {}
  children = []
  style = {}
  setAttribute() {}
  addEventListener(type, f) { this.callbacks[type] = f }
  append(...children) { this.children.push(...children) }
  appendChild(child) { this.append(child) }
  remove() { this.removed = true }
  showModal() { this.open = true }
  close(value = '') {
    this.open = false
    this.returnValue = value
    this.callbacks.close()
  }
}
const rootEntry = '20261125-000000-session-right-clicked'
const childEntry = '20261125-000000-session-child-ok'
const fake = ({ protocol = 'dsh-app:', status = 200, response, request, purgeFailure } = {}) => {
  let provider, exported, stop, unregistered, refreshed = 0
  const requests = [], notices = []
  const body = new Node()
  const window = { location: { protocol }, __ModuleLoader__: { load: (reg) => { exported = reg.factory() } } }
  const ctx = {
    effect: (effect) => { stop = effect() },
    contextMenus: {
      register: (p) => { provider = p; return () => { unregistered = true } },
      notify: (...a) => notices.push(a),
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'session-blank': { blank: true } } }) },
      refresh: () => { refreshed += 1 },
    },
  }
  runInNewContext(bundle, {
    window,
    document: { body, createElement: () => new Node() },
    fetch: async (url, options) => {
      requests.push({ url, options })
      if (request) return request(url, options)
      return url.endsWith('/purge')
        ? { ok: !purgeFailure, json: async () => purgeFailure ? { ok: false } : { ok: true, count: 1 } }
        : { ok: status === 200, json: async () => response ?? { ok: true, id: 'session-right-clicked', entry: rootEntry } }
    },
  })
  exported.apply(ctx)
  return {
    get provider() { return provider }, get unregistered() { return unregistered }, get refreshed() { return refreshed },
    body, requests, notices, stop: () => stop(),
    open() { return provider.resolve({ sessionId: 'session-right-clicked', displayTitle: '<text only>' })[0].run() },
    button(i) { return body.children.at(-1).children[2].children[i] },
  }
}

test('desktop session menu; no remote action or blank-draft target', () => {
  const app = fake()
  assert.equal(app.provider.target, 'session')
  assert.equal(app.provider.resolve({ sessionId: 'session-blank' }).length, 0)
  const action = app.provider.resolve({ sessionId: 'session-regular' })[0]
  assert.equal(action.label, '删除')
  assert.equal(action.danger, true)
  assert.equal(action.afterContent, true)
  assert.equal(fake({ protocol: 'https:' }).provider, undefined)
})

test('cancel and Escape do not call the Host', async () => {
  const app = fake()
  const canceled = app.open()
  app.button(0).callbacks.click()
  await canceled
  const escaped = app.open()
  app.body.children.at(-1).close()
  await escaped
  assert.equal(app.requests.length, 0)
  assert.ok(app.body.children.every((n) => n.removed))
})

test('confirm stages exact captured session and permanently purges only its entry', async () => {
  const app = fake()
  const done = app.open()
  await app.open()
  assert.equal(app.requests.length, 0)
  assert.match(app.body.children[0].children[1].textContent, /<text only>/)
  app.button(1).callbacks.click()
  await done
  assert.equal(app.requests.length, 2)
  assert.deepEqual(app.requests.map(r => r.url), ['/api/session-delete/delete', '/api/session-delete/purge'])
  for (const { options } of app.requests) {
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['x-dsh-plugin'], 'session-delete')
    assert.equal(options.redirect, 'error')
  }
  assert.deepEqual(JSON.parse(app.requests[0].options.body), { id: 'session-right-clicked' })
  assert.deepEqual(JSON.parse(app.requests[1].options.body), { entry: rootEntry })
  assert.match(app.body.children[0].children[1].textContent, /无法恢复/)
  assert.equal(app.refreshed, 1)
  assert.deepEqual(app.notices, [['会话已永久删除。', true]])
})

test('running session is kept; partial cascades do not report unconditional success', async () => {
  const running = fake({ status: 409, response: { error: { code: 'RUNNING' } } })
  const refused = running.open()
  running.button(1).callbacks.click()
  await refused
  assert.equal(running.refreshed, 0)
  assert.match(running.notices[0][0], /仍在运行/)
  assert.equal(running.notices[0][1], false)
  const partial = fake({ response: { ok: true, id: 'session-right-clicked', entry: rootEntry, cascade: {
    deleted: [{ id: 'child-ok', entry: childEntry }], skippedRunning: ['child-busy'], failed: [{ id: 'child-error' }],
  } } })
  const done = partial.open()
  partial.button(1).callbacks.click()
  await done
  assert.match(partial.notices[0][0], /1 个子会话已永久删除.*1 个仍在运行.*1 个子会话未能/)
  assert.equal(partial.notices[0][1], false)
  assert.deepEqual(partial.requests.slice(1).map(r => JSON.parse(r.options.body)), [
    {entry: rootEntry}, {entry: childEntry},
  ])
})

test('a failed purge is not reported as a permanent delete', async () => {
  const app = fake({ purgeFailure: true })
  const done = app.open()
  app.button(1).callbacks.click()
  await done
  assert.equal(app.requests.length, 2)
  assert.match(app.notices[0][0], /永久删除未全部完成/)
  assert.equal(app.notices[0][1], false)
})

test('malformed staged entries are never sent to purge', async () => {
  const app = fake({ response: { ok: true, id: 'session-right-clicked', entry: '../bad' } })
  const done = app.open()
  app.button(1).callbacks.click()
  await done
  assert.equal(app.requests.length, 1)
  assert.equal(app.notices[0][1], false)
})

test('unloading dismisses open confirmation without deletion', async () => {
  const app = fake()
  const done = app.open()
  app.stop()
  await done
  assert.equal(app.unregistered, true)
  assert.equal(app.requests.length, 0)
  assert.equal(app.body.children[0].removed, true)
})

const installedBackend = process.env.DSH_TEST_DELETION_BACKEND
  ?? joinPath(homedir(), '.dsh/profiles/desktop/node_modules/dsh-session-delete/src/index.js')

test('installed backend removes selected parent and child, preserves unrelated trash',
  { skip: !existsSync(installedBackend) }, async () => {
  const { mkdtemp, mkdir, writeFile, readdir, rm, stat } = await import('node:fs/promises')
  const { basename, dirname, join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const root = await mkdtemp(fileURLToPath(new URL('./sandbox-', import.meta.url)))
  const plugin = process.env.DSH_TEST_DELETION_BACKEND ?? join(homedir(), '.dsh/profiles/desktop/node_modules/dsh-session-delete/src/index.js')
  const live = join(root, 'sessions', 'example')
  const trash = join(root, 'trash', 'sessions')
  const existing = '20261125-000000-unrelated-entry'
  const parent = { id: 'session-right-clicked', cwd: root }
  const child = { id: 'session-example-child', cwd: root, parentSession: parent.id }
  const unrelated = { id: 'session-other-live', cwd: root }
  const headers = [parent, child, unrelated]
  const loc = (entry) => ({ path: join(live, entry.id, 'session.jsonl.zstd') })
  try {
    for (const header of headers) {
      const f = loc(header).path
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, 'disposable fixture')
    }
    await mkdir(join(trash, existing), { recursive: true })
    await writeFile(join(trash, existing, 'sentinel'), 'unrelated')
    const { apply } = await import(pathToFileURL(plugin))
    const routes = new Map()
    const archives = new Set()
    apply({
      sessionPersistence: { list: async () => headers, locate: loc },
      workspaceRegistry: { get archivedSessionIds() { return [...archives] }, archiveSession: async id => archives.add(id) },
      agents: new Map(),
      get: () => undefined,
      effect: (fn) => fn(),
      webServer: { register: (row) => { routes.set(row.path, row.handler) } },
    })
    const app = fake({ request: async (url, options) => {
      let status, response
      await routes.get(url)({
        method: options.method, headers: options.headers,
        async *[Symbol.asyncIterator]() { yield Buffer.from(options.body) },
      }, {
        writeHead: code => { status = code },
        end: data => { response = JSON.parse(data) },
      })
      return { ok: status === 200, json: async () => response }
    } })
    const pending = app.open()
    app.button(1).callbacks.click()
    await pending
    assert.equal(app.notices[0][0], '会话及 1 个子会话已永久删除。', basename(root))
    assert.deepEqual((await readdir(live)).sort(), [unrelated.id])
    assert.deepEqual((await readdir(trash)).sort(), [existing, 'audit.log'].sort())
    assert.ok((await stat(join(trash, existing, 'sentinel'))).isFile())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
