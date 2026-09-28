/**
 * 真机集成测试 runner：用 DSH 真实发布的包（在 app.asar 内，普通 node 读不到）
 * 加载本插件，因此内部用 Electron-as-node 执行 test/integration.mjs。
 *
 * 做法：为需要的包在包内临时生成"跳板"（package.json + 用绝对 file:// URL 再导出的 index.js），
 * 跑完清理；不需要管理员权限，也不改动 DSH 安装或 profile。
 *
 * 用法：node test/run-integration.mjs <DSH 安装目录>（或设环境变量 DSH_APP_DIR；缺省时以退出码 2 跳过）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = dirname(here)
const appDir = process.argv[2] ?? process.env.DSH_APP_DIR
const asar = join(appDir, 'resources', 'app.asar', 'dsh', 'node_modules')
const electron = join(appDir, 'DeepSeek Harness.exe')

// 检查 DSH 安装目录（不写死本机路径，避免把开发者的目录结构带进仓库）。
if (appDir === undefined || !existsSync(electron) || !existsSync(join(appDir, 'resources', 'app.asar'))) {
  console.error('未指定 DSH 安装目录，或该目录下没有 DeepSeek Harness.exe 与 resources/app.asar')
  console.error('用法：node test/run-integration.mjs [DSH 安装目录]   或设置环境变量 DSH_APP_DIR')
  console.error('例：node test/run-integration.mjs /path/to/dsh-app（该目录下应有 DeepSeek Harness 可执行文件与 resources/app.asar）')
  process.exit(2)
}

// 需要"真机"的包：@deepseek-ai/<name> → 在 app.asar 里的相对路径 + 用到的子路径
const scoped = {
  'schemastery': { default: true, subpaths: { '.': 'lib/index.mjs' } },
  'cordis': { subpaths: { '.': 'lib/index.js' } },
  'dsh-compaction': { subpaths: { '.': 'lib/index.js' } },
  'dsh-compaction-basic': { subpaths: { '.': 'lib/index.js' } },
  'dsh-commands': { subpaths: { './brand': 'lib/types/brand.js' } },
  'dsh-storage-domain': { subpaths: { '.': 'lib/index.js' } },
}
const plain = { zod: { subpaths: { '.': 'lib/index.js' } } }

const scope = join(pkg, 'node_modules', '@deepseek-ai')
rmSync(join(pkg, 'node_modules'), { recursive: true, force: true })
mkdirSync(scope, { recursive: true })

const shim = (target, name, subpaths, withDefault = false) => {
  const exportsMap = {}
  const files = []
  for (const [key, rel] of Object.entries(subpaths)) {
    const file = key === '.' ? 'index.mjs' : rel.replace(/^[.][/]/, '').replace(/[/]/g, '_') + '.mjs'
    files.push([file, pathToFileURL(join(target, rel)).href])
    exportsMap[key] = './' + file
  }
  const dir = join(scope, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.0.0-shim', type: 'module', exports: exportsMap }, null, 2))
  for (const [file, url] of files) {
    const body = 'export * from ' + JSON.stringify(url) + '\n'
      + (withDefault ? 'export { default } from ' + JSON.stringify(url) + '\n' : '')
    writeFileSync(join(dir, file), body)
  }
}

for (const [name, spec] of Object.entries(scoped)) shim(join(asar, '@deepseek-ai', name), name, spec.subpaths, spec.default === true)
console.log('跳板包：' + Object.keys(scoped).join(', ') + ' + zod')
// zod 是普通包，跳板要放在顶层 node_modules/zod
{
  const target = join(asar, 'zod')
  const dir = join(pkg, 'node_modules', 'zod')
  // runner 自己跑在普通 node 上，读不到 asar 内部，所以入口用已知值（zod 4.6.5 的 ESM 入口）。
  const zodEntry = process.env.DSH_ZOD_ENTRY ?? 'index.js'
  const zodUrl = pathToFileURL(join(target, zodEntry)).href
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'zod', version: '0.0.0-shim', type: 'module', exports: { '.': './index.mjs' } }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), 'export * from ' + JSON.stringify(zodUrl) + '\nexport { default } from ' + JSON.stringify(zodUrl) + '\n')
  console.log('zod 跳板 → ' + zodEntry)
}

let status = 1
try {
  const run = spawnSync(electron, [join(here, 'integration.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  status = run.status ?? 1
} finally {
  rmSync(join(pkg, 'node_modules'), { recursive: true, force: true })
}
process.exit(status)
