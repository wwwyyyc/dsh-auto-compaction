/**
 * 跑单测：临时把 seam 替身接到包的 node_modules，跑完清掉，绝不在包里留下 node_modules。
 * schemastery：优先用真实包（$DSH_SCHEMASTERY 或第一个参数或 $DSH_PROFILE_DIR 下的安装），
 * 找不到就退回 test/stubs/schemastery 的最小替身，这样没有 DSH 安装的机器（CI）也能跑。
 * 用法：node test/run.mjs [schemastery 目录]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = dirname(here)
const scope = join(pkg, 'node_modules', '@deepseek-ai')
const candidates = [
  process.argv[2],
  process.env.DSH_SCHEMASTERY,
  process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai', 'schemastery') : undefined,
].filter((value) => typeof value === 'string' && value.length > 0)

const real = candidates.find((dir) => existsSync(dir))
const stubSchemastery = join(here, 'stubs', 'schemastery')
console.log(real === undefined
  ? 'schemastery: 使用内置替身（未校验真实 schema 语义；有 DSH 安装时请传路径以用真包）'
  : 'schemastery: 真实包 ' + real)

rmSync(join(pkg, 'node_modules'), { recursive: true, force: true })
mkdirSync(scope, { recursive: true })
symlinkSync(real ?? stubSchemastery, join(scope, 'schemastery'), 'junction')
for (const name of ['dsh-compaction', 'dsh-compaction-basic', 'dsh-commands', 'dsh-storage-domain']) {
  symlinkSync(join(here, 'stubs', name), join(scope, name), 'junction')
}
// zod 是普通（非作用域）包：必须解析在顶层 node_modules/zod。
symlinkSync(join(here, 'stubs', 'zod'), join(pkg, 'node_modules', 'zod'), 'junction')

let status = 1
try {
  const run = spawnSync(process.execPath, [join(here, 'logic.test.mjs')], { stdio: 'inherit' })
  status = run.status ?? 1
} finally {
  rmSync(join(pkg, 'node_modules'), { recursive: true, force: true })
}
process.exit(status)
