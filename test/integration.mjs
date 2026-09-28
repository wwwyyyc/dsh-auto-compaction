/**
 * 真机集成测试：用 **DSH 真实发布的包**（cordis / schemastery / dsh-compaction /
 * dsh-compaction-basic / dsh-commands/brand / zod / dsh-storage-domain）加载本插件，
 * 只把"服务"替换成探针（tokenMeter / llm / sessions / commands / storageDomain）。
 *
 * 与 logic.test.mjs 的分工：那边用替身验逻辑分支，这边验"在真实 API 面上能不能装、
 * 能不能构造、真实 schema 校验能否通过、真实工具函数能否配合工作"。
 * 运行方式：node test/run-integration.mjs（内部用 Electron-as-node 以穿透 app.asar）
 */
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import Engine, {
  CAPACITY_DOMAIN,
  CONFIG_DESCRIPTIONS,
  applyPolicyPreset,
  computeCodexSpec,
  hasActiveCompactionLock,
} from '../lib/index.js'

const R = {}
const INFO = {}
const rejections = []
process.on('unhandledRejection', (reason) => { rejections.push(String(reason && reason.message ? reason.message : reason)) })
const eq = (name, actual, expected) => {
  R[name] = JSON.stringify(actual) === JSON.stringify(expected) ? 'ok' : 'FAIL got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)
}
const ok = (name, condition, detail = '') => { R[name] = condition ? 'ok' : 'FAIL ' + detail }

// ---------- 探针：真实的 cordis Context + 假服务 ----------
const makeHarness = (opts = {}) => {
  const state = {
    tokens: opts.tokens ?? 0,
    declared: opts.declared === undefined ? 1000 : opts.declared,
    log: opts.log ?? [],
  }
  const commands = []
  const opensLog = []
  const puts = []
  const calls = []
  const infos = []
  const records = new Map()
  const ctx = new Context()
  if (opts.withLogger !== false) ctx.logger.level = 4
  ctx.provide('tokenMeter', {
    measure: () => ({
      totalTokens: state.tokens,
      nodes: [10, 11, 12, 13].map((seq) => ({ seq, tokens: Math.floor(state.tokens / 4) })),
    }),
  })
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: state.declared }, defaultMaxTokens: opts.defaultMax ?? 0 }),
  })
  ctx.provide('sessions', { flush: async () => {} })
  ctx.provide('commands', { register: (definition) => { commands.push(definition); return () => {} } })
  if (opts.withStorage !== false) {
    ctx.provide('storageDomain', {
      open: async (spec) => { opensLog.push(spec?.name ?? '(no name)'); return ({
        table: () => ({
          entries: () => records.entries(),
          keys: () => records.keys(),
          get: (key) => records.get(key),
          put: async (key, value) => { records.set(key, value); puts.push([key, value]) },
        }),
        close: async () => {},
      }) },
    })
  }
  const agent = {
    session: {
      id: 'integration-session',
      requestContext: () => ({ provider: 'codemaker', model: 'deepseek-flash', contextWindow: state.declared }),
      requestHeader: () => ({ config: { provider: 'codemaker', model: 'deepseek-flash' } }),
      surface: { nodes: [10, 11, 12, 13], replaceGeneration: 0 },
      seq: state.log.length,
      eventAt: (seq) => {
        if (seq === 10) return { seq, type: 'system/message' }
        if (seq >= 11 && seq <= 13) return { seq, type: 'user/message' }
        const event = state.log[seq]
        return event === undefined ? undefined : { ...event, seq }
      },
    },
    options: {},
  }
  return { ctx, agent, state, commands, opensLog, puts, calls, infos, patchRegion: (engine) => {
    engine.compactRegion = async (start, end) => { calls.push({ start, end }); return { shadowedSeqs: [start, end] } }
  } }
}

// ---------- 0. 先探明插件里的动态导入在真机上能否解析 ----------
{
  let probe = ''
  try { const m = await import('zod'); probe = 'zod ok:' + typeof (m.z ?? m.default?.z ?? m.default) } catch (e) { probe = 'zod ERR ' + e.message }
  try { const m = await import('@deepseek-ai/dsh-storage-domain'); probe += ' | domain ok:' + typeof m.defineDomain } catch (e) { probe += ' | domain ERR ' + e.message }
  ok('0.动态导入可解析（zod + storage-domain）', !/ERR/.test(probe), probe)
  INFO['0b.动态导入探针'] = probe
}

// ---------- 0c. 直接复现插件里的真实 API 序列（defineDomain + zod） ----------
{
  let detail = ''
  try {
    const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
    const zod = (await import('zod')).z ?? (await import('zod')).default
    const spec = defineDomain({
      name: CAPACITY_DOMAIN.name,
      version: CAPACITY_DOMAIN.version,
      layout: 'single',
      tables: { capacity: domainTable(zod.object({ tokens: zod.number().int().positive(), at: zod.number().int().nonnegative() })) },
    })
    detail = 'ok ' + spec.name + '@' + spec.version + ' layout=' + spec.layout
  } catch (error) { detail = 'ERR ' + error.message }
  ok('0c.真实 defineDomain 接受本插件的 spec', detail.startsWith('ok'), detail)
  INFO['0d.defineDomain 结果'] = detail
}

// ---------- A. 在真实 API 面上构造 ----------
{
  const h = makeHarness({ tokens: 900 })
  const engine = new Engine(h.ctx, { triggerRatio: 0.98, usableRatio: 0.98, retainTokens: 100, auto: false })
  ok('A1 真实 BasicCompactionEngine 接受剥离后的配置', engine instanceof BasicCompactionEngine, String(engine))
  ok('A2 继承链正确', Object.getPrototypeOf(Engine) === BasicCompactionEngine)
  ok('A3 真实 cordis 注册了 compaction 服务', typeof h.ctx.get('compaction')?.compactIfNeeded === 'function')
  eq('A4 继承到真实后端的方法', ['compactRegion', 'compactNow', 'compactIfNeeded', 'summarize'].map((m) => typeof engine[m]), ['function', 'function', 'function', 'function'])
  ok('A5 真实 schemastery 校验通过（Config 可调用）', (() => { try { return typeof Engine.Config === 'function' && JSON.stringify(Engine.Config({ triggerRatio: 0.9 })) !== undefined } catch { return false } })())
  ok('A6 说明表挂到真实 schema 上', Object.keys(CONFIG_DESCRIPTIONS.zh).length > 15 && typeof applyPolicyPreset({ policyPreset: 'aggressive' }).triggerRatio === 'number')
}

// ---------- B. 真实 dsh-commands 注册路径 ----------
{
  const h = makeHarness({ tokens: 100 })
  new Engine(h.ctx, { triggerRatio: 0.98, auto: false })
  await new Promise((r) => setImmediate(r))
  eq('B1 通过真实 cordis inject 注册命令', [h.commands.length, h.commands[0]?.name, String(h.commands[0]?.definitionId)], [1, 'auto-compaction', 'dsh-auto-compaction/diagnostics'])
}

// ---------- C. 真实的工具函数 + 判定 → 选区 → 事务入口 ----------
{
  const h = makeHarness({ tokens: 990 })
  const engine = new Engine(h.ctx, { triggerRatio: 0.98, usableRatio: 0.98, retainTokens: 100, compactionRetries: 0, auto: false })
  h.patchRegion(engine)
  await engine.compactIfNeeded(h.agent, 'pressure', undefined)
  eq('C1 真实 toolPairingBalancedBefore 下的选区与事务入口', h.calls, [{ start: 11, end: 12 }])
}
{
  const h = makeHarness({ tokens: 700 })
  const engine = new Engine(h.ctx, { triggerRatio: 0.98, usableRatio: 0.98, retainTokens: 100, auto: false })
  h.patchRegion(engine)
  await engine.compactIfNeeded(h.agent, 'pressure', undefined)
  eq('C2 阈值以下不动手', h.calls.length, 0)
}
{
  // 未配对的 compaction/start：真实会话日志形状下的锁检测
  const h = makeHarness({ tokens: 950, log: [{ type: 'turn/start' }, { type: 'compaction/start' }] })
  const engine = new Engine(h.ctx, { triggerRatio: 0.98, usableRatio: 0.98, retainTokens: 100, auto: false })
  h.patchRegion(engine)
  ok('C3 真实日志形状下识别在途压缩', hasActiveCompactionLock(h.agent.session) === true)
  await engine.compactIfNeeded(h.agent, 'pressure', undefined)
  eq('C4 在途时不修剪不启动', [h.calls.length, h.puts.length], [0, 0])
}

// ---------- D. 溢出自学习 + 真实 zod / defineDomain 持久化 ----------
{
  const h = makeHarness({ tokens: 500000, declared: 1000000 })
  const engine = new Engine(h.ctx, { triggerRatio: 0.98, usableRatio: 0.98, auto: false })
  h.patchRegion(engine)
  try { await engine.compactIfNeeded(h.agent, 'context-overflow', undefined) } catch { /* 交给真实后端时缺真实会话，允许失败 */ }
  await new Promise((r) => setTimeout(r, 50))
  eq('D1 溢出后写入持久化（真实 zod + 真实 defineDomain）', h.puts.map(([k, v]) => [k, v.tokens]), [['codemaker/deepseek-flash', 475000]])
  INFO['D1b.storage.open 收到的领域名'] = JSON.stringify(h.opensLog)
  INFO['D1c.未处理的 rejection'] = JSON.stringify(rejections)
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '', signal: undefined })).text
  ok('D2 诊断里体现学到的上限', /learned|已学习上限/.test(text), text.slice(0, 200))
  eq('D3 学到后阈值随之下降', computeCodexSpec({ declaredWindow: 1000000, triggerRatio: 0.98, usableRatio: 0.98, learnedWindow: 475000 }).thresholdTokens, 465500)
}

// ---------- E. 无可选服务时的降级（真实 Context 上不给 commands / storageDomain） ----------
{
  const h = makeHarness({ tokens: 990, withStorage: false })
  const ctx2 = new Context()
  ctx2.provide('tokenMeter', h.ctx.get('tokenMeter'))
  ctx2.provide('llm', h.ctx.get('llm'))
  ctx2.provide('sessions', h.ctx.get('sessions'))
  const engine = new Engine(ctx2, { triggerRatio: 0.98, usableRatio: 0.98, retainTokens: 100, compactionRetries: 0, auto: false })
  h.patchRegion(engine)
  await engine.compactIfNeeded(h.agent, 'pressure', undefined)
  eq('E1 无 commands/storageDomain 仍可加载并压缩', [h.calls.length, h.puts.length], [1, 0])
}

const failed = Object.entries(R).filter(([, value]) => value !== 'ok')
console.log(JSON.stringify(R, null, 1))
console.log('诊断信息: ' + JSON.stringify(INFO))
console.log(failed.length === 0 ? 'INTEGRATION PASS (' + Object.keys(R).length + ')' : 'INTEGRATION FAILURES: ' + JSON.stringify(failed, null, 1))
process.exit(failed.length === 0 ? 0 : 1)
