// 职责：两类缓存的体积统计与分类清理（只清目录里面的条目，目录本身保留）。
// 目录与文件都从 paths.js 推导；清理前有一道显式黑名单校验：
// cost-meter（计费台账）和 speech-to-text（409 MB 语音模型）永远不在可清理范围内。
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  cacheRoot,
  dshHome,
  measurePath,
  projCacheSessionsRoot,
} from './paths.js'

/** 明确不许清理的目录名：任何清理目标的真实路径里出现它们就直接拒绝。 */
export const FORBIDDEN_NAMES = ['cost-meter', 'speech-to-text']

/** 允许清理的两类缓存（id → 真实目录）。 */
function cacheTargets() {
  return [
    { id: 'cache', path: cacheRoot() },
    { id: 'projcache', path: projCacheSessionsRoot() },
  ]
}

/** 路径里是否出现黑名单名字（按路径段比较，避免误判普通文件名）。 */
function hitsForbidden(path) {
  const segments = String(path).split(/[\\/]+/)
  return segments.some((segment) => FORBIDDEN_NAMES.includes(segment))
}

/**
 * 列出可以清理的两类缓存，每项带体积与文件数。
 * 返回 [{ id, labelZh, labelEn, noteZh, noteEn, path, bytes, files }]。
 */
export function listCaches() {
  const labels = {
    cache: {
      labelZh: '桥接与临时缓存',
      labelEn: 'Bridge & temp cache',
      noteZh: '删了会自己重生',
      noteEn: 'rebuilds itself',
    },
    projcache: {
      labelZh: '会话标题投影缓存',
      labelEn: 'Session title cache',
      noteZh: '清空后标题可能暂时显示(无标题)',
      noteEn: 'titles may show as (untitled)',
    },
  }
  const out = []
  for (const target of cacheTargets()) {
    if (hitsForbidden(target.path)) continue
    const measured = measurePath(target.path)
    out.push({
      id: target.id,
      ...labels[target.id],
      path: target.path,
      bytes: measured.bytes,
      files: measured.files,
    })
  }
  return out
}

/**
 * 清空一类缓存里面的全部条目（目录本身保留）。
 * 只接受 'cache' 与 'projcache'；其他 id 或命中黑名单时一律拒绝。
 * 返回 { ok: true, freed, files } 或 { ok: false, reason }。
 */
export function clearCache(cacheId) {
  if (cacheId !== 'cache' && cacheId !== 'projcache') {
    return { ok: false, reason: 'not-allowed', freed: 0, files: 0 }
  }
  const target = cacheTargets().find((item) => item.id === cacheId)
  if (target === undefined) return { ok: false, reason: 'not-allowed', freed: 0, files: 0 }
  const path = target.path
  // 黑名单硬校验：命中就拒绝，绝不进入删除流程。
  if (hitsForbidden(path)) return { ok: false, reason: 'forbidden-path', freed: 0, files: 0 }
  // 目标必须落在 DSH 数据根目录里，防止路径被改坏成更上层目录。
  const home = dshHome()
  if (!path.startsWith(`${home}/`) && path !== home) {
    return { ok: false, reason: 'forbidden-path', freed: 0, files: 0 }
  }
  let entries
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    // 目录不存在等于已经是空的。
    return { ok: true, freed: 0, files: 0 }
  }
  let freed = 0
  let files = 0
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (hitsForbidden(child)) continue
    const measured = measurePath(child)
    try {
      rmSync(child, { recursive: true, force: true })
      freed += measured.bytes
      files += measured.files
    } catch {
      // 单个条目删不掉不影响其余的，最后按实际腾出的体积汇报。
    }
  }
  return { ok: true, freed, files }
}
