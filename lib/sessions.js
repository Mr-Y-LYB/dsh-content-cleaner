// 职责：会话清单（标题 / 相对时间 / 体积 / 能否删除）与会话删除的五步流程。
// 删除顺序照原网页端插件 dsh-session-cleaner 验证过的顺序：拒删运行中 → 停空闲 agent →
// 从内存 live store 摘除 → 删磁盘目录 → 补清投影缓存与工作区登记，
// 最后一步是原插件没做干净的地方（不补就会在列表里留下“幽灵行”）。
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION_ID_RE,
  dirBytes,
  projCacheSessionsRoot,
  scanSessionDirs,
  workspaceRecordPath,
} from './paths.js'

/** 把字节数写成人看的大小：B / KB / MB / GB，保留一位小数。 */
export function formatBytes(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** 把“距今多久”写成中文或英文的粗略时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function formatAgo(since, locale = 'zh-CN', now = Date.now()) {
  const en = String(locale ?? '').startsWith('en')
  const ms = Number.isFinite(since) ? now - since : 0
  if (!Number.isFinite(ms) || ms < 60_000) return en ? 'just now' : '刚刚'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return en ? `${minutes} min ago` : `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return en ? `${hours} h ago` : `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return en ? `${days} d ago` : `${days} 天前`
}

/** 读一个会话的标题与创建时间；读不到就返回空值，绝不抛异常。 */
export function readSessionMeta(sessionId) {
  const file = join(projCacheSessionsRoot(), `${sessionId}.json`)
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'))
    const title = record?.record?.rows?.title?.val
    const createdAt = record?.record?.identity?.createdAt
    return {
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : '',
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    }
  } catch {
    return { title: '', createdAt: 0 }
  }
}

/**
 * 列出全部可清理会话。
 * options.currentId：当前正在看的这个对话的 id（它永远不可删）。
 * options.statusOf：给一个 id，返回 agent 的运行状态；服务不存在时返回 undefined。
 * 返回 [{ id, project, dir, title, createdAt, bytes, running, current, deletable, reason }]。
 */
export function listSessions(options = {}) {
  const { currentId = '', statusOf, now = Date.now() } = options
  const out = []
  for (const item of scanSessionDirs()) {
    const meta = readSessionMeta(item.id)
    let createdAt = meta.createdAt
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      // 投影缓存里没有创建时间时就退回目录修改时间，保证相对时间一定有值。
      createdAt = now
    }
    let status
    try {
      status = typeof statusOf === 'function' ? statusOf(item.id) : undefined
    } catch {
      status = undefined
    }
    const running = status === 'running'
    const current = currentId !== '' && item.id === currentId
    const deletable = !running && !current
    out.push({
      id: item.id,
      project: item.project,
      dir: item.dir,
      title: meta.title,
      createdAt,
      bytes: dirBytes(item.dir),
      running,
      current,
      deletable,
      reason: running ? 'running' : current ? 'current' : '',
    })
  }
  // 新的排前面；创建时间相同就按体积大的排前面，便于先清大的。
  out.sort((a, b) => (b.createdAt - a.createdAt) || (b.bytes - a.bytes))
  return out
}

/** 把会话 id 从 workspace.json 的会话名单里摘掉；改之前先备份成 workspace.json.bak。 */
function stripWorkspaceRegistration(sessionId) {
  const file = workspaceRecordPath()
  if (!existsSync(file)) return false
  let record
  try {
    record = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  let touched = false
  const drop = (list) => {
    if (!Array.isArray(list)) return list
    const next = list.filter((id) => id !== sessionId)
    if (next.length !== list.length) touched = true
    return next
  }
  const tables = record?.tables?.workspaces
  if (tables !== null && typeof tables === 'object') {
    for (const workspace of Object.values(tables)) {
      if (workspace === null || typeof workspace !== 'object') continue
      if (Array.isArray(workspace.sessionIds)) workspace.sessionIds = drop(workspace.sessionIds)
    }
  }
  const global = record?.global
  if (global !== null && typeof global === 'object') {
    if (Array.isArray(global.archivedSessionIds)) global.archivedSessionIds = drop(global.archivedSessionIds)
    if (Array.isArray(global.pinnedSessionIds)) global.pinnedSessionIds = drop(global.pinnedSessionIds)
  }
  if (!touched) return false
  try {
    copyFileSync(file, `${file}.bak`)
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 删一个会话，五步走，每步失败都能说清是第几步。
 * 返回 { ok, step, reason, bytes }；ok 为 true 时 bytes 是腾出的体积。
 * helpers.currentId  当前对话 id（禁止删除）
 * helpers.agentOf    给 id 返回 agent（用来判断运行状态、停空闲 agent）
 * helpers.sessionStore  内存 live store（用来摘除条目）
 * helpers.workspaceRegistry  工作区服务（优先用它摘登记）
 */
export async function deleteSession(sessionId, helpers = {}) {
  const {
    currentId = '',
    agentOf,
    sessionStore,
    workspaceRegistry,
  } = helpers

  // 第 1 步：校验 id 形状，形状不对直接拒绝，绝不碰磁盘。
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, step: 1, reason: 'invalid-id', bytes: 0 }
  }
  // 当前对话永远不删。
  if (currentId !== '' && sessionId === currentId) {
    return { ok: false, step: 1, reason: 'current-session', bytes: 0 }
  }

  // 第 2、3 步：运行中的拒绝；空闲但有 agent 的先把 agent 停掉。
  let agent
  try {
    agent = typeof agentOf === 'function' ? agentOf(sessionId) : undefined
  } catch {
    agent = undefined
  }
  if (agent !== undefined && agent !== null) {
    if (agent.status === 'running') return { ok: false, step: 2, reason: 'running', bytes: 0 }
    const fiber = agent.ctx?.fiber
    const unload = fiber?._unload
    if (typeof unload === 'function') {
      try {
        await unload.call(fiber)
      } catch {
        return { ok: false, step: 3, reason: 'cannot-stop', bytes: 0 }
      }
    }
  }

  // 第 4 步：从内存 live store 摘除条目，否则列表会留幽灵行。服务不存在就跳过，不算失败。
  try {
    const entry = sessionStore?.get?.(sessionId)
    if (typeof entry?.detach === 'function') entry.detach()
  } catch {
    // 摘除失败不阻断：磁盘删掉后列表重建也会消失。
  }

  // 第 5 步：删磁盘目录、删投影缓存 json、摘工作区登记。
  const target = scanSessionDirs().filter((item) => item.id === sessionId)
  if (target.length === 0) return { ok: false, step: 5, reason: 'not-found', bytes: 0 }
  let freed = 0
  for (const item of target) {
    freed += dirBytes(item.dir)
    try {
      rmSync(item.dir, { recursive: true, force: true })
    } catch {
      return { ok: false, step: 5, reason: 'cannot-remove', bytes: freed }
    }
  }
  try {
    rmSync(join(projCacheSessionsRoot(), `${sessionId}.json`), { force: true })
  } catch {
    // 投影缓存删不掉不影响会话本身已经删掉的事实。
  }
  let detachedWorkspace = false
  try {
    if (typeof workspaceRegistry?.list === 'function') {
      for (const workspace of workspaceRegistry.list()) {
        const ids = workspace?.sessionIds
        if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
        if (typeof workspace.detachSession === 'function') {
          await workspace.detachSession(sessionId)
          detachedWorkspace = true
        }
      }
    }
  } catch {
    // 服务调用失败时下面还有一次直接改 json 的兜底。
  }
  if (!detachedWorkspace) stripWorkspaceRegistration(sessionId)
  return { ok: true, step: 5, reason: '', bytes: freed }
}
