// 职责：造一个可安全删除的测试会话（目录 + 投影缓存 json），给验收用。
// 用法：node scripts/make-test-session.mjs [标题]
// 输出会话 id；删掉它就用面板里的「确认删除」，不要手删，那样验不到插件。
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const title = process.argv[2] ?? '测试会话-请删除'
const id = `session-${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`
const project = '--tmp-cleaner-test--'

const dir = join(home, 'sessions', project, id)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'session.lock'), '')
writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 0))

const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(cacheDir, { recursive: true })
writeFileSync(
  join(cacheDir, `${id}.json`),
  JSON.stringify({
    version: 1,
    record: {
      identity: { formatVersion: 1, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: 1, seq: 1, val: title } },
    },
  }),
)
console.log(id)
