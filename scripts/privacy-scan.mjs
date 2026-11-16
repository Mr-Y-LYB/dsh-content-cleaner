// 职责：开源前隐私门。双向扫描「被 git 跟踪的文件内容」与「全部提交历史 diff」，
// 把命中分成 block 级（必须为 0，否则退出码 1）与 warn 级（可以存在但要列出来），
// 并检查 git 里有没有混进 node_modules、压缩包、.env、私钥与扫描报告。
// 只用 Node 内置模块，零依赖。用法：node scripts/privacy-scan.mjs [--json]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const wantJson = process.argv.includes('--json')

/** block 级规则：命中就必须改写，判据是 0。 */
const BLOCK_RULES = [
  { id: 'home-path', label: '家目录绝对路径', pattern: /\/root\/|\/home\/[^/\s"'`]+\// },
  { id: 'email', label: '邮箱地址', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: 'github-token', label: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'api-key', label: 'sk- 开头的密钥', pattern: /\bsk-[A-Za-z0-9]{16,}/ },
  { id: 'aws-key', label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key', label: '私钥块', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'machine-sid', label: '机器 SID', pattern: /\bS-1-5-21-\d+-\d+-\d+-\d+\b/ },
]

/** warn 级规则：允许存在，但要列出来人工解释。 */
const WARN_RULES = [
  { id: 'root-word', label: '单独出现的 root 字样', pattern: /\broot\b/ },
  { id: 'localhost', label: 'localhost', pattern: /\blocalhost\b/ },
  { id: 'internal-ip', label: '内网地址', pattern: /\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { id: 'loopback', label: '回环地址', pattern: /\b127\.0\.0\.1\b/ },
]

/** 不许进库的文件名特征。 */
const FORBIDDEN_TRACKED = [
  { id: 'node-modules', label: 'node_modules', test: (path) => path.includes('node_modules/') },
  { id: 'archive', label: '压缩包', test: (path) => path.endsWith('.tgz') || path.endsWith('.tar.gz') },
  { id: 'dotenv', label: '.env 文件', test: (path) => /(^|\/)\.env(\..*)?$/.test(path) },
  { id: 'pem-key', label: '私钥/证书', test: (path) => path.endsWith('.pem') || path.endsWith('.key') },
  { id: 'report', label: '扫描报告', test: (path) => path.endsWith('privacy-report.json') },
  { id: 'backup', label: 'workspace 备份', test: (path) => path.endsWith('workspace.json.bak') },
]

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tgz|gz|mp4|mp3|wav|ttf|woff2?|zst|bin|so|node)$/i

/** 跑一条 git 命令，读不到就返回空串。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
}

/** 命中内容脱敏：只留首尾，避免报告本身又把秘密抄一遍。 */
function mask(text) {
  const value = String(text)
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 3)}***${value.slice(-2)}`
}

/** 本文件本身就是规则表，里面必然写着这些字面量；扫它自己的 warn 级没有意义。 */
const SELF_PATH = 'scripts/privacy-scan.mjs'

/** 逐行套规则；skipWarn 用于放过“本来就该写着这些词”的文件。 */
function scanLines(entries, face, hits, skipWarn) {
  for (const entry of entries) {
    const line = entry.text
    if (line === '') continue
    for (const rule of BLOCK_RULES) {
      const match = rule.pattern.exec(line)
      if (match !== null) {
        hits.push({ level: 'block', face, rule: rule.id, label: rule.label, path: entry.path, line: entry.line, sample: mask(match[0]) })
      }
    }
    if (skipWarn) continue
    for (const rule of WARN_RULES) {
      const match = rule.pattern.exec(line)
      if (match !== null) {
        hits.push({ level: 'warn', face, rule: rule.id, label: rule.label, path: entry.path, line: entry.line, sample: mask(match[0]) })
      }
    }
  }
}

/** 把一段 diff 拆成「属于哪个文件」的行，这样 warn 级也能按文件放过。 */
function diffEntries(text) {
  const entries = []
  let current = '(未知文件)'
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('+++ b/')) {
      current = line.slice(6)
      continue
    }
    if (line.startsWith('diff --git ')) {
      current = '(未知文件)'
      continue
    }
    if (line.startsWith('commit ')) {
      current = '(提交说明)'
      continue
    }
    entries.push({ text: line, path: current, line: index + 1 })
  }
  return entries
}

const hits = []
const notes = []

// 面一：被跟踪的文件内容。
const tracked = git(['ls-files']).split('\n').filter((line) => line !== '')
for (const path of tracked) {
  for (const rule of FORBIDDEN_TRACKED) {
    if (rule.test(path)) hits.push({ level: 'block', face: 'files', rule: rule.id, label: `不该入库：${rule.label}`, path, line: 0, sample: path })
  }
  const full = join(ROOT, path)
  if (!existsSync(full) || BINARY_EXT.test(path)) {
    notes.push({ path, reason: '二进制或缺失，需人工确认' })
    continue
  }
  const buffer = readFileSync(full)
  if (buffer.includes(0)) {
    notes.push({ path, reason: '含 NUL 字节，按二进制处理，需人工确认' })
    continue
  }
  const lines = buffer.toString('utf8').split('\n').map((text, index) => ({ text, path, line: index + 1 }))
  scanLines(lines, 'files', hits, path === SELF_PATH)
}

// 面二：全部提交历史的 diff（含删除行，取的是 patch 全文）。
const history = git(['log', '-p', '--all', '--no-color', '--format=commit %H %s'])
if (history === '') {
  notes.push({ path: '(git 历史)', reason: '读不到提交历史：可能还没初始化仓库或还没有提交' })
} else {
  // diff 里逐行归属到具体文件，本文件的字面量同样放过 warn 级。
  const diff = diffEntries(history)
  for (const entry of diff) {
    const skipWarn = entry.path === SELF_PATH
    scanLines([entry], 'history', hits, skipWarn)
  }
}

// 汇总。
processLine()
function processLine() {
  const block = hits.filter((hit) => hit.level === 'block')
  const warn = hits.filter((hit) => hit.level === 'warn')

  console.log('dsh-content-cleaner · 开源前隐私扫描')
  console.log(`仓库：${ROOT}`)
  console.log(`被跟踪文件：${tracked.length} 个`)
  console.log(`block 级命中：${block.length}　warn 级命中：${warn.length}`)
  console.log('')

  const group = (list, title) => {
    if (list.length === 0) return
    console.log(`— ${title} —`)
    for (const hit of list) {
      const where = hit.line > 0 ? `${hit.path}:${hit.line}` : hit.path
      console.log(`  [${hit.face}] ${where} · ${hit.label} · ${hit.sample}`)
    }
    console.log('')
  }
  group(block, 'block 级（必须清零）')
  group(warn, 'warn 级（可存在，需逐条解释）')

  if (notes.length > 0) {
    console.log('— 人工确认 —')
    for (const note of notes) console.log(`  ${note.path}：${note.reason}`)
    console.log('')
  }

  console.log(block.length === 0 && notes.length === 0
    ? '结论：通过（block 级 0 命中，无待人工确认文件）'
    : '结论：不通过（见上）')

  if (wantJson) {
    const file = join(ROOT, 'privacy-report.json')
    writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), trackedFiles: tracked.length, block, warn, notes }, null, 2)}\n`)
    console.log(`报告：${file}（已被 .gitignore 挡住）`)
  }
}
process.exit(hits.some((hit) => hit.level === 'block') ? 1 : 0)
