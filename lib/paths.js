// 职责：集中推导本机 DSH 数据目录（会话、会话投影缓存、缓存、工作区登记），
// 并提供“可清理会话”的统一统计口径：sessions/<项目目录>/<会话目录> 两层，
// 且必须排除引擎自用的 .dsh-go-lifecycle。所有路径都从 DSH_HOME 推导，代码里不写死绝对路径。
import { lstatSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 引擎自用的生命周期目录：里面是会话锁与删除墓碑，永远不列出来、永远不删除。 */
export const LIFECYCLE_DIR = '.dsh-go-lifecycle'

/** 会话 id 的形状：字母数字开头，之后只允许字母数字和短横线，最长 128。 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

/** DSH 数据根目录：优先读环境变量 DSH_HOME，读不到就退回 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 会话目录根：<DSH_HOME>/sessions */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 会话投影缓存根：<DSH_HOME>/storages/session_projcache（会话标题就存在这里）。 */
export function projCacheRoot() {
  return join(dshHome(), 'storages', 'session_projcache')
}

/** 会话投影缓存里单个会话的 json 所在目录：<DSH_HOME>/storages/session_projcache/sessions */
export function projCacheSessionsRoot() {
  return join(projCacheRoot(), 'sessions')
}

/** 桥接与临时文件缓存：<DSH_HOME>/cache */
export function cacheRoot() {
  return join(dshHome(), 'cache')
}

/** 工作区登记文件：<DSH_HOME>/storages/workspace.json */
export function workspaceRecordPath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/**
 * 扫出全部“真实会话目录”。
 * 返回 [{ id, project, dir }]；目录读不到时返回空数组，绝不抛异常。
 * 只下钻两层（项目目录 / 会话目录），第一层就跳过 .dsh-go-lifecycle。
 */
export function scanSessionDirs() {
  const sessionRoot = sessionsRoot()
  let projects
  try {
    projects = readdirSync(sessionRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (project.name === LIFECYCLE_DIR) continue
    const projectDir = join(sessionRoot, project.name)
    let entries
    try {
      entries = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!SESSION_ID_RE.test(entry.name)) continue
      out.push({ id: entry.name, project: project.name, dir: join(projectDir, entry.name) })
    }
  }
  return out
}

/**
 * 统计口径：项目目录数与可清理会话数。
 * 与 find 命令「<DSH_HOME>/sessions 下两层目录、排除生命周期目录」的结果一致。
 * 读不到目录时返回 { projects: 0, sessions: 0 }。
 */
export function countSessions() {
  const dirs = scanSessionDirs()
  const projects = new Set(dirs.map((item) => item.project))
  return { projects: projects.size, sessions: dirs.length }
}

/**
 * 递归累加一个路径的字节数，文件个数一起返回。
 * 不跟随符号链接（避免被链到别处去统计），读失败按 0 算，绝不抛异常。
 */
export function measurePath(path) {
  let bytes = 0
  let files = 0
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { bytes, files }
  }
  if (stat.isSymbolicLink()) return { bytes, files }
  if (stat.isFile()) return { bytes: stat.size, files: 1 }
  if (!stat.isDirectory()) return { bytes, files }
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    const child = measurePath(join(path, entry.name))
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files }
}

/** 只算字节数的便捷写法。 */
export function dirBytes(path) {
  return measurePath(path).bytes
}
