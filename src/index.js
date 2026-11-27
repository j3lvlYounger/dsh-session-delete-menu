import { lstat, mkdtemp, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'session-delete-menu'
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents']

const PATH = '/api/dsh-session-delete-menu'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const LOG = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
})

class Refusal extends Error {
  constructor(code) { super(code); this.code = code }
}
const refuse = code => { throw new Refusal(code) }
const missing = async path => {
  try { await lstat(path); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function verifiedDirectory(root, snapshot, id) {
  const log = snapshot?.location?.path
  if (snapshot?.header?.id !== id || snapshot.location?.kind !== 'jsonl' ||
      typeof log !== 'string' || !isAbsolute(log) || resolve(log) !== log ||
      !LOG.test(basename(log))) refuse('UNSUPPORTED')
  const dir = dirname(log)
  const project = dirname(dir)
  if (basename(dir) !== id || dirname(project) !== root) refuse('UNSAFE_PATH')
  const canonicalRoot = await realpath(root)
  for (const path of [root, project, dir]) {
    if (!(await lstat(path)).isDirectory()) refuse('UNSAFE_PATH')
  }
  const file = await lstat(log)
  if (!file.isFile() || file.nlink !== 1 ||
      await realpath(log) !== join(canonicalRoot, basename(project), id, basename(log))) {
    refuse('UNSAFE_PATH')
  }
  return dir
}

function descendants(snapshots, id) {
  const children = new Map()
  for (const { header } of snapshots) {
    // A fork has a separate owner and must never be implicitly deleted.
    if (header?.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
    if (!children.has(header.parentSession)) children.set(header.parentSession, [])
    children.get(header.parentSession).push(header.id)
  }
  const ids = [id]
  const visited = new Set(ids)
  for (const parent of ids) {
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      ids.push(child)
    }
  }
  return ids
}

export function createDeletion(ctx) {
  const persistence = ctx.sessionPersistence
  const registry = ctx.workspaceRegistry
  const protectedIds = new Set()
  const removedLive = new Set()
  let pending
  let disposed = false

  async function eraseOne(id) {
    if (!ID.test(id)) refuse('INVALID_ID')
    const rootValue = persistence.config?.root
    if (persistence.name !== 'session-persistence-jsonl' || typeof rootValue !== 'string' || !rootValue) {
      refuse('UNSUPPORTED')
    }
    const root = resolve(rootValue)
    if (root === dirname(root)) refuse('UNSAFE_PATH')
    if (ctx.agents.get(id)?.status === 'running') refuse('RUNNING')
    const original = await persistence.stat(id)
    if (!original) refuse('NOT_FOUND')
    const dir = await verifiedDirectory(root, original, id)
    const wasArchived = registry.archivedSessionIds.includes(id)
    const wasPinned = registry.pinnedSessionIds?.includes(id) === true
    let archived = false
    let quarantine
    let moved = false
    let purging = false
    let lease
    try {
      // The host rejects active jobs/subagents and saves the archive gate
      // before any file movement. Do not call archive with stopActivity.
      if (wasArchived) {
        const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
        if (activity.length) refuse('RUNNING')
      } else {
        await registry.archiveSession(id)
        archived = true
      }
      protectedIds.add(id)

      const live = ctx.sessions.get(id)
      if (live) {
        // A live idle Agent already owns the backend writer. Drain its event
        // buffer under the archive gate instead of opening a second writer.
        if (ctx.agents.get(id)?.status === 'running' || !await ctx.sessions.flush(live)) refuse('RUNNING')
      } else {
        // For cold Sessions require the native lease; another Harness process
        // with ownership must finish before this process can move the log.
        if (original.formatStatus !== 'current') refuse('UNSUPPORTED')
        lease = await persistence.open(id, 'write')
      }

      const seq = live?.seq
      const checked = await persistence.stat(id)
      if (!checked || await verifiedDirectory(root, checked, id) !== dir ||
          checked.location.path !== original.location.path ||
          (!live && checked.revision !== original.revision)) refuse('CHANGED')
      quarantine = await mkdtemp(join(dirname(await realpath(root)), '.dsh-session-delete-'))
      if (disposed || ctx.agents.get(id)?.status === 'running' || ctx.sessions.get(id) !== live ||
          live?.seq !== seq || !registry.archivedSessionIds.includes(id)) refuse('CHANGED')
      const staged = join(quarantine, 'data')
      await rename(dir, staged)
      moved = true
      await lease?.close()
      lease = undefined
      if (!await missing(dir) || (await persistence.stat(id)) !== undefined || live?.seq !== seq) refuse('CHANGED')

      purging = true
      await rm(staged, { recursive: true })
      await rmdir(quarantine).catch(() => {})
      if (live && ctx.sessions.get(id) === live) removedLive.add(id)
      ctx.emit('api-session/removed', id)
      if (!ctx.sessions.get(id)) {
        protectedIds.delete(id)
        // Clear the archive marker after removal; otherwise refresh might
        // display a stale archive record. A live Session stays gated until exit.
        await registry.unarchiveSession(id).catch(() => {})
      }
    } catch (error) {
      if (moved && !purging && await missing(dir).catch(() => false)) {
        try { await rename(join(quarantine, 'data'), dir); moved = false } catch {}
      }
      if (!moved) {
        if (quarantine) await rmdir(quarantine).catch(() => {})
        protectedIds.delete(id)
        if (archived) {
          await registry.unarchiveSession(id).catch(() => {})
          if (wasPinned) await registry.pinSession(id).catch(() => {})
        }
      }
      if (moved) refuse('INCOMPLETE')
      if (error?.name === 'WorkspaceActiveSessionError' || error?.name === 'SessionAlreadyOwnedError') refuse('RUNNING')
      throw error
    } finally {
      await lease?.close().catch(() => {})
    }
  }

  async function erase(id) {
    const family = descendants(await persistence.list(), id)
    await eraseOne(id)
    let deletedChildren = 0
    let runningChildren = 0
    let failedChildren = 0
    for (const child of family.slice(1)) {
      if (disposed) { failedChildren++; continue }
      try { await eraseOne(child); deletedChildren++ }
      catch (error) {
        if (error?.code === 'RUNNING') runningChildren++
        else failedChildren++
      }
    }
    return { ok: true, id, deletedChildren, runningChildren, failedChildren }
  }

  async function fetch(request) {
    if (disposed || request.method !== 'POST' ||
        request.headers.get('x-dsh-plugin') !== 'session-delete-menu' ||
        request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
      return json({ ok: false, code: 'FORBIDDEN' }, 403)
    }
    let data
    try {
      const text = await request.text()
      if (text.length > 512) refuse('INVALID_ID')
      data = JSON.parse(text)
    } catch { return json({ ok: false, code: 'INVALID_ID' }, 400) }
    if (data?.status === true && Object.keys(data).length === 1) {
      return json({ ok: true, removed: [...removedLive] })
    }
    if (!data || typeof data.id !== 'string' || !ID.test(data.id) || Object.keys(data).length !== 1) {
      return json({ ok: false, code: 'INVALID_ID' }, 400)
    }
    if (pending) return json({ ok: false, code: 'BUSY' }, 409)
    pending = erase(data.id)
    try { return json(await pending) }
    catch (error) {
      const code = error instanceof Refusal ? error.code : 'FAILED'
      return json({ ok: false, code }, code === 'NOT_FOUND' ? 404 : code === 'RUNNING' ? 409 : 422)
    } finally { pending = undefined }
  }

  return {
    fetch,
    guardUnarchive({ sessionId }) {
      if (protectedIds.has(sessionId)) refuse('BUSY')
    },
    releaseMarker(session) {
      if (!removedLive.delete(session.id)) return
      protectedIds.delete(session.id)
      void (async () => {
        if (!ctx.sessions.get(session.id) && !await persistence.stat(session.id)) {
          await registry.unarchiveSession(session.id)
        }
      })().catch(() => {})
    },
    async dispose() {
      disposed = true
      await pending?.catch(() => {})
    },
  }
}

export function apply(ctx) {
  // Exact owner-only route behind Harness's authenticated connection router.
  if (ctx.get('profileContext')?.name !== 'desktop' || ctx.connection.allowsRemoteAuthorities) return
  ctx.effect(() => {
    const deletion = createDeletion(ctx)
    const detach = ctx.connection.fetch.register({
      path: PATH, methods: ['POST'], requestBody: 'buffered', fetch: deletion.fetch,
    })
    const unguard = ctx.on('workspace/session-unarchiving', deletion.guardUnarchive)
    const releaseMarker = ctx.on('session/disposed', deletion.releaseMarker)
    return async () => {
      try { await deletion.dispose() }
      finally { releaseMarker(); unguard(); await detach() }
    }
  }, 'session-delete-menu: local permanent deletion')
}
