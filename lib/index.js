// 职责：注册 dsh-go 手机端的原生面板「会话缓存清理」，并把「列会话 / 删会话 / 清缓存」
// 串成一次点按能完成的事。面板只画结构和数据绑定，具体数字全部来自 data() 的实时扫描。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clearCache, listCaches } from './cache.js'
import { countSessions } from './paths.js'
import { deleteSession, formatAgo, formatBytes, listSessions } from './sessions.js'

// 插件名从 package.json 读，不在代码里硬编码（读不到时用兜底值，保证插件仍能装载）。
let packageName = 'dsh-content-cleaner'
try {
  const file = fileURLToPath(new URL('../package.json', import.meta.url))
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof parsed?.name === 'string' && parsed.name !== '') packageName = parsed.name
} catch {
  // 打包后路径变化时读不到 package.json，用兜底名继续。
}
export const name = packageName

/** 面板文案：中英两套，按 caps.locale 选；每段都在组件字数上限内。 */
const WORDS = {
  zh: {
    title: '会话缓存清理',
    overview: '概览',
    totalLabel: '会话总数',
    projectsUnit: '个项目',
    deletableUnit: '条可删',
    sessionsTitle: '会话',
    cacheTitle: '缓存',
    selectAll: '全选可删',
    clearPick: '清空选择',
    refresh: '刷新',
    cancel: '取消',
    untitled: '(无标题)',
    running: '运行中',
    current: '当前对话',
    picked: '已选',
    tapToPick: '点一行即勾选或取消',
    emptySessions: '没有可清理的会话',
    clearAll: '确认清空',
    confirmDelete: '确认删除',
    pendingDelete: '正在删除',
    pendingClear: '正在清理',
    deleted: (ok, total, size) => `已删除 ${ok} 个会话，腾出 ${size}`,
    deletedPartial: (ok, fail, size) => `成功 ${ok} 条 / 失败 ${fail} 条，腾出 ${size}`,
    nothingPicked: '先点会话勾选要删的',
    pickFirst: '已选 {n} 个，共 {size}，点下方「确认删除」',
    deleteHintEmpty: '勾选想删的会话，再点「确认删除」，删除后无法恢复',
    deleteHintPicked: (n, size) => `将删除 ${n} 个会话，共 ${size}，删除后无法恢复`,
    confirmDeleteLabel: (n) => (n > 0 ? `确认删除 ${n} 个` : '确认删除'),
    cancelDelete: '已取消删除',
    cacheHint: '只清这两类目录里的内容，目录本身保留；计费台账与语音模型永远不碰',
    clearAsk: (label) => `已选中「${label}」，点下方「确认清空」`,
    cleared: (label, size) => `已清空 ${label}，腾出 ${size}`,
    clearRefused: '这个目录不允许清理',
    clearCancelled: '已取消清理',
    refreshed: '已刷新',
    updated: (time) => `统计于 ${time}`,
    noAgent: '本机没有 agents 服务，运行状态未生效，靠当前对话排除兜底',
  },
  en: {
    title: 'Session & cache cleaner',
    overview: 'Overview',
    totalLabel: 'Sessions',
    projectsUnit: 'project(s)',
    deletableUnit: 'deletable',
    sessionsTitle: 'Sessions',
    cacheTitle: 'Caches',
    selectAll: 'Select all',
    clearPick: 'Clear picks',
    refresh: 'Refresh',
    cancel: 'Cancel',
    untitled: '(untitled)',
    running: 'Running',
    current: 'This chat',
    picked: 'Picked',
    tapToPick: 'Tap a row to pick or unpick',
    emptySessions: 'Nothing to clean',
    clearAll: 'Clear',
    confirmDelete: 'Confirm delete',
    pendingDelete: 'Deleting',
    pendingClear: 'Clearing',
    deleted: (ok, total, size) => `Deleted ${ok} session(s), freed ${size}`,
    deletedPartial: (ok, fail, size) => `${ok} deleted / ${fail} failed, freed ${size}`,
    nothingPicked: 'Pick sessions first',
    pickFirst: 'Picked {n} · {size}. Tap "Confirm delete" below',
    deleteHintEmpty: 'Pick sessions, then tap "Confirm delete". This cannot be undone',
    deleteHintPicked: (n, size) => `About to delete ${n} session(s), ${size}. Cannot be undone`,
    confirmDeleteLabel: (n) => (n > 0 ? `Delete ${n}` : 'Confirm delete'),
    cancelDelete: 'Delete cancelled',
    cacheHint: 'Only these two folders are emptied; the folders stay. Cost ledger and speech models are never touched',
    clearAsk: (label) => `Picked "${label}". Tap "Clear" below`,
    cleared: (label, size) => `Cleared ${label}, freed ${size}`,
    clearRefused: 'This folder is not allowed to be cleared',
    clearCancelled: 'Clear cancelled',
    refreshed: 'Refreshed',
    updated: (time) => `Counted at ${time}`,
    noAgent: 'No agents service on this host; running state falls back to this-chat exclusion',
  },
}

/** 按 locale 取文案表；locale 不是 en 开头就按中文。 */
function words(locale) {
  return String(locale ?? '').startsWith('en') ? WORDS.en : WORDS.zh
}

/** 每个面板实例（按对话 id 区分）的临时状态：勾选了哪些、缓存确认了哪一类。 */
const states = new Map()

function stateFor(scope) {
  const key = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : 'global'
  let state = states.get(key)
  if (state === undefined) {
    state = { picked: new Set(), pendingCache: '' }
    states.set(key, state)
  }
  return state
}

/** 把毫秒时间戳写成 HH:MM:SS，给「统计于」那行用。 */
function clockText(now) {
  const date = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 极端标题会撑破一行，截到 40 字以内（列表行不需要完整标题）。 */
function clip(text, max = 40) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * 注册插件：先把 agents / sessions / workspaceRegistry 三个可选服务抓下来，
 * 再在 dshGo 桥接下注册面板。服务缺失一律降级，不影响面板打开。
 */
export function apply(ctx) {
  const services = {}
  for (const key of ['agents', 'sessions', 'workspaceRegistry']) {
    try {
      ctx.inject([key], (inner) => {
        services[key] = inner[key]
      })
    } catch {
      // 该主机没有这个服务：后面按降级处理。
    }
  }

  const logger = ctx?.logger
  const warn = (message) => {
    try {
      logger?.warn?.(`dsh-content-cleaner: ${message}`)
    } catch {
      // 日志不可用就算了，不能因为写日志把功能弄挂。
    }
  }

  const agentOf = (id) => {
    const agents = services.agents
    if (agents === undefined || agents === null) return undefined
    try {
      return agents.get?.(id)
    } catch {
      return undefined
    }
  }
  const statusOf = (id) => {
    const agent = agentOf(id)
    return agent === undefined ? undefined : agent.status
  }

  /** 组装面板要推给 App 的整份数据。 */
  const buildModel = (scope, caps) => {
    const locale = caps?.locale
    const w = words(locale)
    const state = stateFor(scope)
    const currentId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
    if (services.agents === undefined) warn(w.noAgent)
    const sessions = listSessions({ currentId, statusOf, now: Date.now() })
    const caches = listCaches()

    // 勾选集合里如果有已经消失的会话，顺手清掉，避免残留的“已选”状态。
    for (const id of [...state.picked]) {
      if (!sessions.some((session) => session.id === id)) state.picked.delete(id)
    }

    const counted = countSessions()
    const totalBytes = sessions.reduce((sum, session) => sum + session.bytes, 0)
    const deletable = sessions.filter((session) => session.deletable)
    const picked = sessions.filter((session) => state.picked.has(session.id))
    const pickedBytes = picked.reduce((sum, session) => sum + session.bytes, 0)

    const sessionRows = sessions.map((session) => {
      const pickedRow = state.picked.has(session.id)
      const title = session.title === '' ? w.untitled : clip(session.title)
      const subtitle = `${formatAgo(session.createdAt, locale)} · ${formatBytes(session.bytes)}`
      const trailing = session.running
        ? w.running
        : session.current
          ? w.current
          : pickedRow
            ? w.picked
            : ''
      return {
        title,
        subtitle,
        trailing,
        tone: session.deletable ? (pickedRow ? 'info' : undefined) : 'muted',
        action: session.deletable ? { id: 'toggle', args: { sessionId: session.id } } : undefined,
      }
    })

    const cacheRows = caches.map((cache) => {
      const label = String(locale ?? '').startsWith('en') ? cache.labelEn : cache.labelZh
      const note = String(locale ?? '').startsWith('en') ? cache.noteEn : cache.noteZh
      const count = String(locale ?? '').startsWith('en')
        ? `${cache.files} file(s)`
        : `${cache.files} 个文件`
      return {
        title: keyCapital(label),
        subtitle: `${formatBytes(cache.bytes)} · ${count} · ${note}`,
        action: { id: 'clear-cache', args: { cacheId: cache.id } },
      }
    })

    const pendingCache = caches.find((cache) => cache.id === state.pendingCache)
    const pendingLabel = pendingCache === undefined
      ? ''
      : String(locale ?? '').startsWith('en') ? pendingCache.labelEn : pendingCache.labelZh

    return {
      summary: {
        sessions: `${counted.sessions}`,
        caption: `${totalBytes === 0 ? formatBytes(0) : formatBytes(totalBytes)} · ${deletable.length} ${w.deletableUnit} · ${counted.projects} ${w.projectsUnit}`,
      },
      sessionRows,
      sessionNote: sessions.length === 0
        ? w.emptySessions
        : picked.length === 0
          ? w.deleteHintEmpty
          : w.deleteHintPicked(picked.length, formatBytes(pickedBytes)),
      cacheRows,
      cacheNote: pendingCache === undefined ? w.cacheHint : w.clearAsk(pendingLabel),
      deleteLabel: w.confirmDeleteLabel(picked.length),
      clearLabel: pendingCache === undefined
        ? w.clearAll
        : `${w.clearAll} ${keyCapital(pendingLabel)}`,
      updated: w.updated(clockText(Date.now())),
    }
  }

  /** 组装面板视图：静态结构 + 指向 data.* 的绑定，列表行全部由数据推来。 */
  const buildView = (scope, caps) => {
    const w = words(caps?.locale)
    return {
      type: 'stack',
      title: w.title,
      children: [
        { type: 'text', text: w.overview },
        { type: 'metric', label: w.totalLabel, value: { $: 'data.summary.sessions' }, caption: { $: 'data.summary.caption' } },
        { type: 'text', text: w.sessionsTitle },
        { type: 'list', items: { $: 'data.sessionRows' } },
        { type: 'text', text: { $: 'data.sessionNote' }, tone: 'muted' },
        { type: 'actions', items: [
          { label: w.selectAll, action: 'select-all', icon: 'check' },
          { label: w.clearPick, action: 'clear-pick', icon: 'remove' },
          { label: w.refresh, action: 'refresh', icon: 'refresh' },
        ] },
        { type: 'confirm', id: 'confirm-delete', confirmLabel: { $: 'data.deleteLabel' }, cancelLabel: w.cancel },
        { type: 'text', text: w.cacheTitle },
        { type: 'list', items: { $: 'data.cacheRows' } },
        { type: 'text', text: { $: 'data.cacheNote' }, tone: 'muted' },
        { type: 'confirm', id: 'confirm-clear', confirmLabel: { $: 'data.clearLabel' }, cancelLabel: w.cancel },
        { type: 'text', text: { $: 'data.updated' }, tone: 'muted' },
      ],
    }
  }

  ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('cleaner', {
      view: (scope, caps) => buildView(scope, caps),
      data: (scope, emit, caps) => {
        const model = buildModel(scope, caps)
        emit(model)
        // 这一步不挂定时器：面板的刷新由点按触发，避免后台反复扫盘。
        return () => {}
      },
      actions: {
        // 点一行：勾选或取消。勾选只存在内存里，不改磁盘。
        toggle: (scope, event) => {
          const state = stateFor(scope)
          const sessionId = event?.value?.sessionId
          if (typeof sessionId !== 'string') return { toast: words(event?.locale).nothingPicked }
          if (state.picked.has(sessionId)) state.picked.delete(sessionId)
          else state.picked.add(sessionId)
          return { patch: buildModel(scope, { locale: event?.locale }) }
        },
        'select-all': (scope, event) => {
          const state = stateFor(scope)
          const currentId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
          for (const session of listSessions({ currentId, statusOf, now: Date.now() })) {
            if (session.deletable) state.picked.add(session.id)
          }
          return { patch: buildModel(scope, { locale: event?.locale }) }
        },
        'clear-pick': (scope, event) => {
          stateFor(scope).picked.clear()
          return { patch: buildModel(scope, { locale: event?.locale }) }
        },
        refresh: (scope, event) => ({ refresh: true, toast: words(event?.locale).refreshed }),
        // 单点「删除选中」：把条数与体积写进提示，真正删由下面的 confirm 触发。
        'delete-picked': (scope, event) => {
          const state = stateFor(scope)
          const w = words(event?.locale)
          const currentId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
          const picked = listSessions({ currentId, statusOf, now: Date.now() })
            .filter((session) => state.picked.has(session.id))
          if (picked.length === 0) return { toast: w.nothingPicked }
          const size = picked.reduce((sum, session) => sum + session.bytes, 0)
          const text = w.pickFirst
            .replace('{n}', String(picked.length))
            .replace('{size}', formatBytes(size))
          return { toast: text.slice(0, 40), patch: buildModel(scope, { locale: event?.locale }) }
        },
        // 二次确认：确认后逐条删，单条失败不中断其余。
        'confirm-delete': (scope, event) => {
          const state = stateFor(scope)
          const w = words(event?.locale)
          if (event?.value?.confirmed !== true) {
            state.picked.clear()
            return { toast: w.cancelDelete, patch: buildModel(scope, { locale: event?.locale }) }
          }
          const ids = [...state.picked]
          if (ids.length === 0) return { toast: w.nothingPicked }
          const currentId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
          return {
            pending: { label: w.pendingDelete, timeoutMs: 60_000 },
            result: async (signal) => {
              let ok = 0
              let failed = 0
              let freed = 0
              for (const id of ids) {
                if (signal?.aborted) break
                const outcome = await deleteSession(id, {
                  currentId,
                  agentOf,
                  sessionStore: services.sessions?.store,
                  workspaceRegistry: services.workspaceRegistry,
                })
                if (outcome.ok) {
                  ok += 1
                  freed += outcome.bytes
                } else {
                  failed += 1
                  warn(`delete ${id} failed at step ${outcome.step}: ${outcome.reason}`)
                }
              }
              state.picked.clear()
              const text = failed === 0
                ? w.deleted(ok, ids.length, formatBytes(freed))
                : w.deletedPartial(ok, failed, formatBytes(freed))
              return [
                { type: 'toast', text: text.slice(0, 40) },
                { type: 'patch', data: buildModel(scope, { locale: event?.locale }) },
              ]
            },
          }
        },
        // 点缓存行：记下要清哪一类，并把确认文案换成该缓存的名字。
        'clear-cache': (scope, event) => {
          const cacheId = event?.value?.cacheId
          const state = stateFor(scope)
          if (cacheId !== 'cache' && cacheId !== 'projcache') {
            return { toast: words(event?.locale).clearRefused }
          }
          state.pendingCache = cacheId
          return { patch: buildModel(scope, { locale: event?.locale }) }
        },
        'confirm-clear': (scope, event) => {
          const state = stateFor(scope)
          const w = words(event?.locale)
          if (event?.value?.confirmed !== true) {
            state.pendingCache = ''
            return { toast: w.clearCancelled, patch: buildModel(scope, { locale: event?.locale }) }
          }
          const cacheId = state.pendingCache
          const cache = listCaches().find((item) => item.id === cacheId)
          const label = cache === undefined
            ? ''
            : String(event?.locale ?? '').startsWith('en') ? cache.labelEn : cache.labelZh
          if (cacheId === '') return { toast: w.clearRefused }
          const outcome = clearCache(cacheId)
          state.pendingCache = ''
          const text = outcome.ok
            ? w.cleared(label, formatBytes(outcome.freed))
            : w.clearRefused
          return [
            { type: 'toast', text: text.slice(0, 40) },
            { type: 'patch', data: buildModel(scope, { locale: event?.locale }) },
          ]
        },
      },
    })
  })
}

/** 中文标签首字大写没必要，英文标签首字母大写更像名字；两种语言都只做一次轻处理。 */
function keyCapital(text) {
  const value = String(text ?? '')
  if (value === '') return value
  return value[0].toUpperCase() + value.slice(1)
}
