// 职责：插件自测。在一个临时 DSH_HOME 里造出会话/缓存/工作区登记，然后走面板真实的
// data() 与 actions 流程，验证「列会话 → 勾选 → 确认删除 → 清缓存」都按预期工作，
// 并验证三条硬红线：当前对话不可删、生命周期目录不被列出、计费台账与语音模型不被清。
// 用法：node scripts/selftest.mjs   全部通过时退出码 0，并打印 PASS 行。
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-content-cleaner-'))
process.env.DSH_HOME = sandbox

const SESSION_OK = 'session-11111111-1111-4111-8111-111111111111'
const SESSION_CUR = 'session-22222222-2222-4222-8222-222222222222'
const PROJECT = '--tmp-proj--'

/** 造一个会话目录 + 一条投影缓存记录。 */
function seedSession(id, title, createdAt, payloadBytes) {
  const dir = join(sandbox, 'sessions', PROJECT, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.lock'), '')
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(payloadBytes, 7))
  const cacheDir = join(sandbox, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, `${id}.json`),
    JSON.stringify({ version: 1, record: { identity: { createdAt }, rows: { title: { val: title } } } }),
  )
}

/** 造出各目录的骨架与若干文件。 */
function seedTree() {
  seedSession(SESSION_OK, '可删的测试会话', 1_700_000_000_000, 4096)
  seedSession(SESSION_CUR, '当前正在聊的会话', 1_700_000_100_000, 2048)
  // 生命周期目录：必须始终不被列出、不被删除。
  mkdirSync(join(sandbox, 'sessions', '.dsh-go-lifecycle', 'deadbeef'), { recursive: true })
  writeFileSync(join(sandbox, 'sessions', '.dsh-go-lifecycle', 'deadbeef', 'session.lock'), '')
  // 两类缓存。
  mkdirSync(join(sandbox, 'cache', 'dsh-go-bridge'), { recursive: true })
  writeFileSync(join(sandbox, 'cache', 'dsh-go-bridge', 'occupancy.json'), '{"a":1}')
  // 黑名单目录：必须一个字都不动。
  mkdirSync(join(sandbox, 'storages', 'cost-meter'), { recursive: true })
  writeFileSync(join(sandbox, 'storages', 'cost-meter', 'ledger.json'), '{"cost":1}')
  mkdirSync(join(sandbox, 'speech-to-text'), { recursive: true })
  writeFileSync(join(sandbox, 'speech-to-text', 'model.bin'), Buffer.alloc(128, 1))
  // 工作区登记：登记两个会话，删掉后应该只剩当前对话。
  mkdirSync(join(sandbox, 'storages'), { recursive: true })
  writeFileSync(
    join(sandbox, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { archivedSessionIds: [SESSION_OK], pinnedSessionIds: [] },
      tables: { workspaces: { ws1: { path: '/tmp', sessionIds: [SESSION_OK, SESSION_CUR] } } },
    }),
  )
}

/** 假的宿主上下文：只提供 dshGo 桥接，其余服务一律缺失，用来验证降级路径。 */
function fakeContext() {
  const captured = {}
  const logs = []
  const ctx = {
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('dshGo')) {
        callback({
          dshGo: {
            panel(id, config) {
              captured.panelId = id
              captured.panel = config
            },
          },
        })
      }
      // 其余服务故意不提供：agents / sessions / workspaceRegistry 全部走降级分支。
    },
    logger: { warn: (message) => logs.push(message) },
  }
  return { ctx, captured, logs }
}

let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) console.log(`PASS ${label}`)
  else {
    failed += 1
    console.log(`FAIL ${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

seedTree()

const { apply } = await import('../lib/index.js')
const { ctx, captured, logs } = fakeContext()
apply(ctx)

check('面板 id', captured.panelId, 'cleaner')
check('面板有 view / data / actions', [
  typeof captured.panel.view,
  typeof captured.panel.data,
  typeof captured.panel.actions,
], ['function', 'function', 'object'])

/** 取一次面板数据。 */
async function readModel(scope, locale = 'zh-CN') {
  let model
  const cleanup = captured.panel.data(scope, (next) => { model = next }, { locale })
  if (typeof cleanup === 'function') cleanup()
  return model
}

// 一、列表：只列两个真实会话，生命周期目录不出现，当前对话不可删。
let model = await readModel({ sessionId: SESSION_CUR })
check('会话行数', model.sessionRows.length, 2)
check('会话总数口径', model.summary.sessions, '2')
check('生命周期目录未出现', model.sessionRows.some((row) => String(row.title).includes('lifecycle')), false)
const curRow = model.sessionRows.find((row) => row.title.includes('当前'))
check('当前对话没有勾选动作', curRow.action, undefined)
check('当前对话标注', curRow.trailing, '当前对话')
const okRow = model.sessionRows.find((row) => row.title.includes('可删'))
check('可删会话有勾选动作', typeof okRow.action, 'object')
check('降级日志已记录', logs.some((line) => line.includes('agents')), true)

// 二、勾选后确认文案带条数与体积。
const pickedModel = captured.panel.actions.toggle({ sessionId: SESSION_CUR }, { value: { sessionId: SESSION_OK }, locale: 'zh-CN' }).patch
check('勾选后备注含条数', pickedModel.sessionNote.includes('将删除 1 个会话'), true)
check('确认按钮带条数', pickedModel.deleteLabel, '确认删除 1 个')

// 三、取消确认不删任何东西。
const cancelled = captured.panel.actions['confirm-delete']({ sessionId: SESSION_CUR }, { value: { confirmed: false }, locale: 'zh-CN' })
check('取消提示', cancelled.toast, '已取消删除')
check('取消后目录还在', existsSync(join(sandbox, 'sessions', PROJECT, SESSION_OK)), true)

// 四、确认删除：先勾选，再走延后效果。
captured.panel.actions.toggle({ sessionId: SESSION_CUR }, { value: { sessionId: SESSION_OK }, locale: 'zh-CN' })
const pending = captured.panel.actions['confirm-delete']({ sessionId: SESSION_CUR }, { value: { confirmed: true }, locale: 'zh-CN' })
check('删除走 pending', typeof pending.result, 'function')
const effects = await pending.result(undefined)
check('删除提示', effects[0].text.startsWith('已删除 1 个会话'), true)
const afterDelete = effects[1].data
check('删完只剩 1 行', afterDelete.sessionRows.length, 1)
check('会话目录已删除', existsSync(join(sandbox, 'sessions', PROJECT, SESSION_OK)), false)
check('投影缓存 json 已删除', existsSync(join(sandbox, 'storages', 'session_projcache', 'sessions', `${SESSION_OK}.json`)), false)
const workspace = JSON.parse(readFileSync(join(sandbox, 'storages', 'workspace.json'), 'utf8'))
check('工作区登记已摘除', workspace.tables.workspaces.ws1.sessionIds, [SESSION_CUR])
check('归档名单已摘除', workspace.global.archivedSessionIds, [])
check('生命周期目录仍在', existsSync(join(sandbox, 'sessions', '.dsh-go-lifecycle', 'deadbeef', 'session.lock')), true)

// 五、缓存：两行、体积实时；清空后目录保留、黑名单不受影响。
check('缓存行数', model.cacheRows.length, 2)
const cleared = captured.panel.actions['clear-cache']({ sessionId: SESSION_CUR }, { value: { cacheId: 'cache' }, locale: 'zh-CN' })
check('清缓存需要确认', cleared.patch.cacheNote.includes('确认清空'), true)
const clearResult = captured.panel.actions['confirm-clear']({ sessionId: SESSION_CUR }, { value: { confirmed: true }, locale: 'zh-CN' })
check('清缓存提示', clearResult[0].text.startsWith('已清空'), true)
check('cache 目录保留但已空', existsSync(join(sandbox, 'cache')) && !existsSync(join(sandbox, 'cache', 'dsh-go-bridge')), true)
check('计费台账未动', existsSync(join(sandbox, 'storages', 'cost-meter', 'ledger.json')), true)
check('语音模型未动', existsSync(join(sandbox, 'speech-to-text', 'model.bin')), true)

// 六、红线：非法 id、越权缓存 id 一律拒绝。
const { deleteSession } = await import('../lib/sessions.js')
check('非法 id 被拒', (await deleteSession('../etc', {})).reason, 'invalid-id')
check('当前对话被拒', (await deleteSession(SESSION_CUR, { currentId: SESSION_CUR })).reason, 'current-session')
const { clearCache, listCaches } = await import('../lib/cache.js')
check('越权缓存 id 被拒', clearCache('cost-meter').reason, 'not-allowed')
check('可清缓存只有两类', listCaches().map((item) => item.id), ['cache', 'projcache'])

rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
