import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createDeletion, apply } from '../src/index.js'
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
const id = 'session-right-clicked'
const fake = ({ protocol = 'dsh-app:', status = 200, response, request } = {}) => {
  let provider, exported, stop, unregistered, refreshed = 0
  const requests = [], notices = [], suppressed = []
  const byId = { 'session-blank': { blank: true }, [id]: {} }
  let listener
  const body = new Node()
  const window = { location: { protocol }, __ModuleLoader__: { load: (reg) => { exported = reg.factory() } } }
  const ctx = {
    effect: (effect) => { stop = effect() },
    contextMenus: {
      register: (p) => { provider = p; return () => { unregistered = true } },
      notify: (...a) => notices.push(a),
    },
    sessions: {
      list: {
        getSnapshot: () => ({ byId }),
        subscribe: fn => { listener = fn; return () => { listener = undefined } },
      },
      handleSessionRemoved(name) { suppressed.push(name); delete byId[name]; listener?.() },
      refresh: () => { refreshed += 1 },
    },
  }
  runInNewContext(bundle, {
    window, queueMicrotask,
    document: { body, createElement: () => new Node() },
    fetch: async (url, options) => {
      if (JSON.parse(options.body).status === true) {
        return request ? request(url, options) : { ok: true, json: async () => ({ ok: true, removed: [] }) }
      }
      requests.push({ url, options })
      if (request) return request(url, options)
      return { ok: status === 200, json: async () => response ?? { ok: true, id } }
    },
  })
  exported.apply(ctx)
  return {
    get provider() { return provider }, get unregistered() { return unregistered }, get refreshed() { return refreshed },
    body, requests, notices, suppressed, stop: () => stop(),
    reloadRow(name) { byId[name] = {}; listener?.() },
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

test('confirm sends only the captured session to the standalone backend', async () => {
  const app = fake()
  const done = app.open()
  await app.open()
  assert.equal(app.requests.length, 0)
  assert.match(app.body.children[0].children[1].textContent, /<text only>/)
  app.button(1).callbacks.click()
  await done
  assert.equal(app.requests.length, 1)
  const [{ url, options }] = app.requests
  assert.equal(url, '/api/dsh-session-delete-menu')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['x-dsh-plugin'], 'session-delete-menu')
  assert.equal(options.redirect, 'error')
  assert.deepEqual(JSON.parse(options.body), { id })
  assert.match(app.body.children[0].children[1].textContent, /无法恢复/)
  assert.equal(app.refreshed, 0)
  assert.deepEqual(app.suppressed, [id])
  app.reloadRow(id)
  app.reloadRow('another-session')
  await Promise.resolve()
  assert.deepEqual(app.suppressed, [id, id])
  assert.deepEqual(app.notices, [['会话已永久删除。', true]])
})

test('running session and incomplete removal do not report success', async () => {
  for (const [code, expected] of [['RUNNING', /仍在运行/], ['INCOMPLETE', /未确认永久删除完成/]]) {
    const app = fake({ status: 409, response: { ok: false, code } })
    const blocked = app.open()
    app.button(1).callbacks.click()
    await blocked
    assert.equal(app.refreshed, 0)
    assert.match(app.notices[0][0], expected)
    assert.equal(app.notices[0][1], false)
  }
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

const route = '/api/dsh-session-delete-menu'
const request = (input, header = 'session-delete-menu') => new Request('http://localhost' + route, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-plugin': header },
  body: JSON.stringify(input),
})

async function storage(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-delete-test-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'sessions')
  const records = new Map(), live = new Map(), agents = new Map()
  const leases = [], removed = [], archives = new Set(), foreignWriters = new Set()
  const dir = name => join(root, 'project', name)
  async function add(name, fields = {}) {
    const path = join(dir(name), 'session.v4.jsonl.zstd')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'fixture')
    records.set(name, { header: { id: name, ...fields }, revision: 'r:1',
      formatStatus: 'current', location: { kind: 'jsonl', path } })
  }
  const stat = async name => {
    const record = records.get(name)
    if (!record) return
    try { await lstat(record.location.path); return record }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const ctx = {
    sessionPersistence: { name: 'session-persistence-jsonl', config: { root }, stat,
      list: async () => [...records.values()],
      async open(name, mode) {
        assert.equal(mode, 'write')
        if (foreignWriters.has(name)) throw Object.assign(new Error(), { name: 'SessionAlreadyOwnedError' })
        leases.push('open:' + name)
        return { close: async () => { leases.push('close:' + name) } }
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archives] },
      archiveSession: async name => { archives.add(name) },
      unarchiveSession: async name => { archives.delete(name) },
    },
    sessions: { get: name => live.get(name), flush: async () => true },
    agents,
    waterfall: (_, _params, next) => next(),
    emit: (kind, name) => { assert.equal(kind, 'api-session/removed'); removed.push(name) },
  }
  return { base, dir, add, removed, ctx, records, archives, live, agents, foreignWriters, leases,
    deletion: createDeletion(ctx) }
}

test('standalone host and menu delete parent and subagent but preserve fork, other session and existing trash', async t => {
  const fixture = await storage(t)
  for (const [name, fields] of [
    [id], ['child', { origin: 'subagent', parentSession: id }],
    ['fork', { origin: 'fork', parentSession: id }], ['other'],
  ]) await fixture.add(name, fields)
  const trash = join(fixture.base, 'trash')
  await mkdir(trash)
  await writeFile(join(trash, 'sentinel'), 'preserve')
  const app = fake({ request: (url, options) =>
    fixture.deletion.fetch(new Request('http://localhost' + url, options)) })
  const done = app.open()
  app.button(1).callbacks.click()
  await done
  assert.deepEqual(app.notices, [['会话及 1 个子会话已永久删除。', true]])
  assert.deepEqual(fixture.removed, [id, 'child'])
  assert.deepEqual(fixture.leases, ['open:' + id, 'close:' + id, 'open:child', 'close:child'])
  assert.deepEqual((await readdir(dirname(fixture.dir(id)))).sort(), ['fork', 'other'])
  assert.deepEqual((await readdir(fixture.base)).sort(), ['sessions', 'trash'])
  assert.ok((await lstat(join(trash, 'sentinel'))).isFile())
  assert.equal(fixture.archives.size, 0)
})

test('an idle live session is flushed and stays gated, a running child is kept', async t => {
  const f = await storage(t)
  await f.add(id)
  await f.add('busy-child', { origin: 'subagent', parentSession: id })
  f.live.set(id, { seq: 42 })
  f.agents.set(id, { status: 'idle' })
  f.agents.set('busy-child', { status: 'running' })
  let flushed = false
  f.ctx.sessions.flush = async session => { assert.strictEqual(session, f.live.get(id)); flushed = true; return true }
  assert.deepEqual(await (await f.deletion.fetch(request({ id }))).json(), {
    ok: true, id, deletedChildren: 0, runningChildren: 1, failedChildren: 0,
  })
  assert.equal(flushed, true)
  assert.deepEqual(f.leases, [])
  assert.ok(f.archives.has(id))
  assert.deepEqual(await (await f.deletion.fetch(request({ status: true }))).json(), {
    ok: true, removed: [id],
  })
  assert.throws(() => f.deletion.guardUnarchive({ sessionId: id }), /BUSY/)
  assert.ok((await lstat(f.dir('busy-child'))).isDirectory())
})

test('foreign owner, malformed request, arbitrary path, and symlink never delete data', async t => {
  const f = await storage(t)
  await f.add(id)
  f.foreignWriters.add(id)
  for (const [input, header, code] of [
    [{ id }, 'incorrect', 'FORBIDDEN'], [{ id: '../project' }, undefined, 'INVALID_ID'],
    [{ id, all: true }, undefined, 'INVALID_ID'], [{ id }, undefined, 'RUNNING'],
  ]) assert.equal((await (await f.deletion.fetch(request(input, header))).json()).code, code)
  f.foreignWriters.delete(id)
  const other = join(f.base, 'other')
  await mkdir(other)
  const path = join(other, 'session.v4.jsonl.zstd')
  await writeFile(path, 'outside')
  f.records.get(id).location.path = path
  assert.equal((await (await f.deletion.fetch(request({ id }))).json()).code, 'UNSAFE_PATH')
  await symlink(other, f.dir('linked'))
  f.records.set('linked', { header: { id: 'linked' }, location: { kind: 'jsonl', path: join(f.dir('linked'), 'session.v4.jsonl.zstd') } })
  assert.equal((await (await f.deletion.fetch(request({ id: 'linked' }))).json()).code, 'UNSAFE_PATH')
  assert.deepEqual(f.removed, [])
  assert.equal(f.archives.size, 0)
  assert.ok((await lstat(f.dir(id))).isDirectory())
  assert.ok((await lstat(path)).isFile())
})

test('registers only an authenticated exact route on the local Desktop profile', async () => {
  for (const [profile, remote, expected] of [['desktop', false, true], ['desktop', true, false], ['headless', false, false]]) {
    let routeSpec, cleanup
    apply({
      get: () => ({ name: profile }),
      connection: { allowsRemoteAuthorities: remote,
        fetch: { register: spec => { routeSpec = spec; return async () => {} } } },
      effect: fn => { cleanup = fn() }, on: () => () => {},
    })
    assert.equal(Boolean(routeSpec), expected)
    if (routeSpec) {
      assert.equal(routeSpec.path, route)
      assert.deepEqual(routeSpec.methods, ['POST'])
      await cleanup()
    }
  }
})
