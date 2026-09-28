/** 本插件的逻辑用例：真代码 + 打桩 seam（见 test/stubs）。 */
import Engine, { CAPACITY_DOMAIN, CONFIG_DESCRIPTIONS, POLICY_PRESETS, applyPolicyPreset, computeCodexSpec, hasActiveCompactionLock, rememberBounded, selectRetainedRange } from '../lib/index.js'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'

const R = {}
const eq = (name, actual, expected) => {
  R[name] = JSON.stringify(actual) === JSON.stringify(expected) ? 'ok' : 'FAIL got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected)
}

// ---------- A. computeCodexSpec（纯函数） ----------
eq('A1 覆盖 200k + 32k 预留', computeCodexSpec({ declaredWindow: 1000000, overrideWindow: 200000, reservedOutputTokens: 32768 }), { window: 200000, thresholdTokens: 167232, retainTokens: 26757, triggerRatio: 0.9, usableRatio: 0.95, source: 'override' })
eq('A2 仅声明 1M（无覆盖）', computeCodexSpec({ declaredWindow: 1000000 }), { window: 1000000, thresholdTokens: 900000, retainTokens: 160000, triggerRatio: 0.9, usableRatio: 0.95, source: 'declared' })
eq('A3 显式阈值被 0.9W 夹住', computeCodexSpec({ declaredWindow: 1000000, compactTokenLimit: 950000 }).thresholdTokens, 900000)
eq('A4 显式 retain 被压到阈值之下', computeCodexSpec({ compactTokenLimit: 50000, declaredWindow: 1000000, retainTokens: 300000 }).retainTokens, 45000)
eq('A5 无窗口 -> null', computeCodexSpec({}), null)
eq('A6 超大输出预留夹到窗口一半', computeCodexSpec({ overrideWindow: 1000, reservedOutputTokens: 1000 }), { window: 1000, thresholdTokens: 500, retainTokens: 80, triggerRatio: 0.9, usableRatio: 0.95, source: 'override' })

// ---------- B. selectRetainedRange ----------
const mkSession = (seqs) => ({ surface: { nodes: seqs }, eventAt: (seq) => seq === seqs[0] ? { type: 'system/message' } : { type: 'user/message' } })
const mkMeasurement = (seqs, tokens) => ({ totalTokens: tokens.reduce((a, b) => a + b, 0), nodes: seqs.map((seq, i) => ({ seq, tokens: tokens[i] })) })
eq('B1 保留近期尾', selectRetainedRange(mkSession([10, 11, 12, 13]), mkMeasurement([10, 11, 12, 13], [100, 100, 100, 100]), 100), { start: 11, end: 12 })
eq('B2 保留量覆盖全部 -> 放弃', selectRetainedRange(mkSession([10, 11, 12, 13]), mkMeasurement([10, 11, 12, 13], [100, 100, 100, 100]), 250), null)
eq('B3 表层与计量不一致 -> 放弃', selectRetainedRange(mkSession([10, 11, 12]), mkMeasurement([10, 11, 12, 13], [100, 100, 100, 100]), 100), null)

// ---------- 引擎夹具 ----------
const mkEngine = (config, opts = {}) => {
  const listeners = []
  const logs = { info: [], warn: [] }
  const commands = []
  let pruned = 0
  const state = { tokens: opts.tokens ?? 0, drop: opts.drop ?? 0, declared: opts.declared === undefined ? 1000 : opts.declared }
  const logEvents = opts.logEvents ?? []
  const surface = [10, 11, 12, 13]
  const agent = {
    session: {
      id: 's1',
      requestContext: () => ({ provider: 'codemaker', model: 'deepseek-flash', contextWindow: state.declared }),
      surface: { nodes: surface },
      seq: logEvents.length,
      eventAt: (seq) => {
        if (seq === surface[0]) return { type: 'system/message', seq }
        if (surface.includes(seq)) return { type: 'user/message', seq }
        const event = logEvents[seq]
        return event === undefined ? undefined : { ...event, seq }
      },
    },
    options: opts.agentMaxTokens ? { maxTokens: opts.agentMaxTokens } : {},
  }
  const ctx = {
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), debug: () => {} },
    on: (name, handler) => { listeners.push([name, handler]); return () => {} },
    inject: (deps, callback) => {
      if (!deps.includes('commands') || opts.commands === false) return
      const scoped = {
        commands: { register: (definition) => { commands.push(definition); return () => {} } },
        effect: (fn) => {
          const produced = typeof fn === 'function' ? fn() : fn
          if (produced !== undefined && typeof produced.next === 'function') {
            let step = produced.next()
            while (!step.done) step = produced.next()
          }
          return () => {}
        },
      }
      callback(scoped)
    },
    get: (name) => {
      if (name === 'sessionProjections') {
        return opts.projections === undefined ? undefined : { stateOf: () => opts.projections }
      }
      if (name === 'storageDomain') return opts.storageDomain
      return opts.pruner ? { pruneSession: () => { pruned += 1 } } : undefined
    },
    effect: (fn) => { const p = typeof fn === 'function' ? fn() : fn; if (p?.next) { let s = p.next(); while (!s.done) s = p.next() } return () => {} },
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: state.declared }, defaultMaxTokens: opts.defaultMax ?? 8192 }) },
    tokenMeter: {
      measure: () => mkMeasurement([10, 11, 12, 13], [Math.floor(state.tokens / 4), Math.floor(state.tokens / 4), Math.floor(state.tokens / 4), state.tokens - 3 * Math.floor(state.tokens / 4)]),
    },
  }
  const engine = new Engine(ctx, config)
  engine.onCompactRegion = async () => { state.tokens = Math.max(0, state.tokens - state.drop) }
  return { engine, agent, listeners, logs, commands, state, prunedCount: () => pruned }
}
/** 假 storageDomain：记录 open/put，可预置既有记录，也可让 open 抛错。 */
const mkStorage = (seed = {}, options = {}) => {
  const records = new Map(Object.entries(seed))
  const puts = []
  const opens = []
  const table = {
    entries: () => records.entries(),
    keys: () => records.keys(),
    get: (key) => records.get(key),
    put: async (key, value) => { records.set(key, value); puts.push([key, value]) },
  }
  const domain = { table: (name) => { if (name !== 'capacity') throw new Error('undeclared table ' + name); return table }, close: () => Promise.resolve() }
  const storageDomain = {
    open: async (spec) => { opens.push(spec); if (options.openFails) throw new Error('backend-not-found'); return domain },
  }
  return { storageDomain, records, puts, opens }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

const runTurnStopping = async (h, signal) => {
  const entry = h.listeners.find((x) => x[0] === 'agent/turn-stopping')
  await entry[1]({ agent: h.agent, signal })
}

// ---------- C. 压力路径（W=1000、预留 256 -> 阈值 min(900, 950, 744) = 744） ----------
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, auto: false }, { tokens: 950, drop: 400, defaultMax: 256 })
  const r = await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C1 超阈值压一次后停下', [h.engine.calls.compactRegion.length, h.engine.calls.superCompactIfNeeded, r === null], [1, 0, false])
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, auto: false }, { tokens: 700, defaultMax: 256 })
  const r = await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C2 低于阈值不动作', [h.engine.calls.compactRegion.length, h.engine.calls.superCompactIfNeeded, r], [0, 0, null])
}
{
  const h = mkEngine({ retainTokens: 100, auto: false }, { tokens: 999999 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C3 无覆盖时交回 basic', [h.engine.calls.superCompactIfNeeded, h.engine.calls.compactRegion.length], [1, 0])
}
{
  const h = mkEngine({ contextWindow: 1000, auto: false }, { tokens: 999, defaultMax: 256 })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  eq('C4 溢出恢复仍交给 basic', h.engine.calls.superCompactIfNeeded, 1)
}
{
  const h = mkEngine({ contextWindow: 200000, retainTokens: 20000, auto: false }, { tokens: 190000, drop: 150000, defaultMax: 32768 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C5 1M 声明被 200k 覆盖后立即可压', h.engine.calls.compactRegion.length, 1)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, modelPolicies: [{ provider: 'codemaker', model: 'deepseek-flash', contextWindow: 400, retainTokens: 50 }], auto: false }, { tokens: 380, drop: 300, defaultMax: 256 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C6 逐模型覆盖生效', h.engine.calls.compactRegion.length, 1)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, auto: false }, { tokens: 950, drop: 400, defaultMax: 256, pruner: true })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C7 修剪器在测量前调用一次', [h.prunedCount(), h.engine.calls.compactRegion.length], [1, 1])
}
{
  const h = mkEngine({ contextWindow: 1000, auto: false }, { tokens: 600, agentMaxTokens: 128, defaultMax: 8192 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C8 agent.maxTokens 优先于 defaultMaxTokens', h.engine.calls.compactRegion.length, 0)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, auto: false }, { tokens: 999999, drop: 0, defaultMax: 256 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('C9 压不动时重试并只警告一次', [h.engine.calls.compactRegion.length, h.logs.warn.length], [2, 1])
}

// ---------- D. PostTurn 相位（可用窗口 950，80% -> 阈值 760） ----------
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 900, drop: 400, defaultMax: 256 })
  await runTurnStopping(h)
  eq('D1 回合末按保留预算压缩', [h.engine.calls.compactRegion.length, h.logs.info.length], [1, 1])
  eq('D1b 只压到近期尾之前', h.engine.calls.compactRegion[0], { start: 11, end: 12 })
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 700, defaultMax: 256 })
  await runTurnStopping(h)
  await runTurnStopping(h)
  eq('D2 低于阈值不触发', h.engine.calls.compactRegion.length, 0)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80, postTurnCooldownMs: 0, postTurnMaxAttemptsPerSession: 2 }, { tokens: 900, drop: 0, defaultMax: 256 })
  await runTurnStopping(h); await runTurnStopping(h); await runTurnStopping(h)
  eq('D3 次数上限', h.engine.calls.compactRegion.length, 2)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80, postTurnCooldownMs: 60000 }, { tokens: 900, drop: 0, defaultMax: 256 })
  await runTurnStopping(h); await runTurnStopping(h)
  eq('D4 冷却期抑制重复', h.engine.calls.compactRegion.length, 1)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 900, defaultMax: 256 })
  h.engine.onCompactRegion = async () => { throw new ManualCompactionError('busy', 'busy') }
  await runTurnStopping(h)
  eq('D5 busy 静默跳过', h.logs.warn.length, 0)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 900, defaultMax: 256 })
  h.engine.onCompactRegion = async () => { throw new Error('boom') }
  await runTurnStopping(h)
  eq('D6 其他失败只 warn 且保留回合', [h.logs.warn.length, /preserved/.test(h.logs.warn[0] ?? '')], [1, true])
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 900, defaultMax: 256 })
  const ac = new AbortController(); ac.abort()
  await runTurnStopping(h, ac.signal)
  eq('D7 已取消则跳过', h.engine.calls.compactRegion.length, 0)
}
{
  const h = mkEngine({ contextWindow: 1000, postTurnThresholdPercent: 0 }, { tokens: 900 })
  eq('D8 关闭时不注册钩子', h.listeners.length, 0)
}
{
  const h = mkEngine({ auto: false, contextWindow: 1000, postTurnThresholdPercent: 80 }, { tokens: 900 })
  eq('D9 auto:false 时不注册钩子', h.listeners.length, 0)
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80, postTurnMaxAttemptsPerSession: 3 }, { tokens: 900, drop: 400, defaultMax: 256 })
  await runTurnStopping(h); await runTurnStopping(h)
  eq('D10 压到阈值以下后不再重复', h.engine.calls.compactRegion.length, 1)
}
try { mkEngine({ contextWindow: 1000, postTurnThresholdPercent: 150 }); R['D11 非法百分比被拒'] = 'FAIL 未拒绝' }
catch (error) { R['D11 非法百分比被拒'] = /postTurnThresholdPercent/.test(error.message) ? 'ok' : 'FAIL ' + error.message }
try { mkEngine({ bogus: 1 }); R['D12 未知 key 仍被父类拒绝'] = 'FAIL 未拒绝' }
catch { R['D12 未知 key 仍被父类拒绝'] = 'ok' }

// ---------- E. 压缩锁前置检查（basic 的 assertNoActiveCompaction 等价物） ----------
const mkLog = (types) => types.map((type, seq) => ({ type, seq }))
const lockedSession = (types) => {
  const log = mkLog(types)
  return { seq: log.length, eventAt: (seq) => (log[seq] === undefined ? undefined : { ...log[seq], seq }) }
}
eq('E1 未配对的 compaction/start -> 在途', hasActiveCompactionLock(lockedSession(['turn/start', 'step/start', 'compaction/start', 'assistant/message', 'compaction/summary', 'x'])), true)
eq('E2 start 后有配对 end -> 不在途', hasActiveCompactionLock(lockedSession(['compaction/start', 'compaction/summary', 'compaction/end', 'x'])), false)
eq('E3 start 早于最新 session/end-seed -> 陈旧', hasActiveCompactionLock(lockedSession(['compaction/start', 'session/end-seed', 'turn/start', 'x'])), false)
eq('E4 无压缩事件 -> 不在途', hasActiveCompactionLock(lockedSession(['turn/start', 'step/start', 'x'])), false)
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, auto: false }, { tokens: 950, drop: 400, defaultMax: 256, pruner: true, logEvents: mkLog(['turn/start', 'compaction/start', 'x']) })
  const r = await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('E5 在途时压力路径不修剪不启动', [h.prunedCount(), h.engine.calls.compactRegion.length, r], [0, 0, null])
}
{
  const h = mkEngine({ contextWindow: 1000, retainTokens: 100, postTurnThresholdPercent: 80 }, { tokens: 900, drop: 400, defaultMax: 256, logEvents: mkLog(['turn/start', 'compaction/start', 'x']) })
  await runTurnStopping(h)
  eq('E6 在途时回合末跳过', h.engine.calls.compactRegion.length, 0)
}

// ---------- F. 按「当前模型窗口 × 比例」触发（本轮新增） ----------
eq('F1 声明 1M 的 95% 触发', computeCodexSpec({ declaredWindow: 1000000, triggerRatio: 0.95 }), { window: 1000000, thresholdTokens: 950000, retainTokens: 160000, triggerRatio: 0.95, usableRatio: 0.95, source: 'declared' })
eq('F2 信任系数 0.2 后再取 95%', computeCodexSpec({ declaredWindow: 1000000, windowRatio: 0.2, triggerRatio: 0.95 }), { window: 200000, thresholdTokens: 190000, retainTokens: 32000, triggerRatio: 0.95, usableRatio: 0.95, source: 'declared' })
eq('F3 usableRatio 是硬上限', computeCodexSpec({ declaredWindow: 1000, triggerRatio: 0.99, usableRatio: 0.95 }).thresholdTokens, 950)
eq('F4 输出预留把 95% 往下压', computeCodexSpec({ declaredWindow: 200000, triggerRatio: 0.95, reservedOutputTokens: 32768 }).thresholdTokens, 167232)
{
  // 只配比例、不配绝对窗口：引擎接管压力路径，并按声明窗口算阈值
  const h = mkEngine({ triggerRatio: 0.95, auto: false }, { tokens: 800, drop: 400, declared: 1000, defaultMax: 256 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('F5 只配比例即接管（声明窗口 ×95%）', [h.engine.calls.compactRegion.length, h.engine.calls.superCompactIfNeeded], [1, 0])
}
{
  // 声明 100k、容量 99k；6 万 token 时：顶层 0.5 -> 50k 触发，模型级 0.95 -> 95k 不触发
  const topOnly = mkEngine({ triggerRatio: 0.5, auto: false }, { tokens: 60000, drop: 55000, declared: 100000, defaultMax: 1000 })
  await topOnly.engine.compactIfNeeded(topOnly.agent, 'pressure')
  const withPolicy = mkEngine({
    triggerRatio: 0.5, auto: false,
    modelPolicies: [{ provider: 'codemaker', model: 'deepseek-flash', triggerRatio: 0.95 }],
  }, { tokens: 60000, drop: 55000, declared: 100000, defaultMax: 1000 })
  await withPolicy.engine.compactIfNeeded(withPolicy.agent, 'pressure')
  eq('F6 逐模型比例覆盖顶层比例', [topOnly.engine.calls.compactRegion.length, withPolicy.engine.calls.compactRegion.length], [1, 0])
}
{
  // 声明 1M：19.5 万 token 在 windowRatio=0.2（有效 200k × 95% = 190k）下触发，不设系数则不触发
  const scaled = mkEngine({ triggerRatio: 0.95, windowRatio: 0.2, auto: false }, { tokens: 195000, drop: 150000, declared: 1000000, defaultMax: 1000 })
  await scaled.engine.compactIfNeeded(scaled.agent, 'pressure')
  const declared = mkEngine({ triggerRatio: 0.95, auto: false }, { tokens: 195000, drop: 150000, declared: 1000000, defaultMax: 1000 })
  await declared.engine.compactIfNeeded(declared.agent, 'pressure')
  eq('F7 信任系数参与压力判定', [scaled.engine.calls.compactRegion.length, declared.engine.calls.compactRegion.length], [1, 0])
}
{
  // 回合末阈值 = 有效窗口 × 95% × postTurnPercent
  const h = mkEngine({ triggerRatio: 0.95, postTurnThresholdPercent: 80 }, { tokens: 900, drop: 400, declared: 1000, defaultMax: 256 })
  await runTurnStopping(h)
  eq('F8 回合末也按比例算', [h.engine.calls.compactRegion.length, /95% of usable = 760/.test(h.logs.info[0] ?? '')], [1, true])
}
{
  const h = mkEngine({ windowRatio: 0.2, postTurnThresholdPercent: 80 }, { tokens: 140000, drop: 100000, declared: 1000000, defaultMax: 1000 })
  await runTurnStopping(h)
  eq('F9 信任系数下的回合末阈值（140k < 152k）', h.engine.calls.compactRegion.length, 0)
}
{
  const h = mkEngine({ windowRatio: 0.2, postTurnThresholdPercent: 80 }, { tokens: 160000, drop: 100000, declared: 1000000, defaultMax: 1000 })
  await runTurnStopping(h)
  eq('F10 信任系数下的回合末阈值（160k > 152k）', h.engine.calls.compactRegion.length, 1)
}
try { mkEngine({ triggerRatio: 1.5 }); R['F11 非法比例被拒'] = 'FAIL 未拒绝' }
catch (error) { R['F11 非法比例被拒'] = /triggerRatio must be a number in/.test(error.message) ? 'ok' : 'FAIL ' + error.message }
try { mkEngine({ modelPolicies: [{ provider: 'p', model: 'm', windowRatio: 0 }] }); R['F12 逐模型非法比例被拒'] = 'FAIL 未拒绝' }
catch (error) { R['F12 逐模型非法比例被拒'] = /windowRatio must be a number in/.test(error.message) ? 'ok' : 'FAIL ' + error.message }

// ---------- G. 判定分子：与 GUI 环同源（projectedTokens ?? pressureTokens） ----------
{
  // tokenMeter 说 100（低于阈值 744），投影说 900：应当按投影判定并压缩
  const h = mkEngine({ triggerRatio: 0.95, compactionRetries: 0, auto: false }, { tokens: 600, drop: 600, declared: 1000, defaultMax: 256, projections: { projectedTokens: 900, contextWindow: 1000 } })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('G1 投影高于阈值则压缩（meter 只有 600）', h.engine.calls.compactRegion.length, 1)
}
{
  // 反向：投影说 100，meter 说 900 -> 不应压缩
  const h = mkEngine({ triggerRatio: 0.95, auto: false }, { tokens: 900, drop: 400, declared: 1000, defaultMax: 256, projections: { pressureTokens: 100, contextWindow: 1000 } })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('G2 投影低于阈值则不压缩（忽略 meter 的 900）', h.engine.calls.compactRegion.length, 0)
}
{
  // 投影存在但没有可用字段 -> 回退 meter
  const h = mkEngine({ triggerRatio: 0.95, auto: false }, { tokens: 900, drop: 400, declared: 1000, defaultMax: 256, projections: { contextWindow: 1000 } })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('G3 投影无可用数值时回退 meter', h.engine.calls.compactRegion.length, 1)
}
{
  // 没有 sessionProjections 服务 -> 回退 meter
  const h = mkEngine({ triggerRatio: 0.95, auto: false }, { tokens: 900, drop: 400, declared: 1000, defaultMax: 256 })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('G4 投影服务缺席时回退 meter', h.engine.calls.compactRegion.length, 1)
}
{
  // pressureSource: meter -> 强制忽略投影
  const h = mkEngine({ triggerRatio: 0.95, pressureSource: 'meter', auto: false }, { tokens: 100, drop: 400, declared: 1000, defaultMax: 256, projections: { projectedTokens: 900, contextWindow: 1000 } })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('G5 pressureSource: meter 忽略投影', h.engine.calls.compactRegion.length, 0)
}
{
  // 回合末相位同样按投影判定（阈值 = 1000×0.95×0.8 = 760）
  const h = mkEngine({ triggerRatio: 0.95, postTurnThresholdPercent: 80, postTurnCooldownMs: 0 }, { tokens: 600, drop: 600, declared: 1000, defaultMax: 256, projections: { projectedTokens: 900, contextWindow: 1000 } })
  await runTurnStopping(h)
  eq('G6 回合末也按投影判定', h.engine.calls.compactRegion.length, 1)
}
try { mkEngine({ pressureSource: 'nonsense' }); R['G7 非法 pressureSource 被拒'] = 'FAIL 未拒绝' }
catch (error) { R['G7 非法 pressureSource 被拒'] = /pressureSource must be/.test(error.message) ? 'ok' : 'FAIL ' + error.message }

// ---------- H. 98% 口径 + 从溢出中自学习真实容量 ----------
eq('H1 98% 不再被 95% 硬顶裁掉', computeCodexSpec({ declaredWindow: 1000000, triggerRatio: 0.98, usableRatio: 0.98 }), { window: 1000000, thresholdTokens: 980000, retainTokens: 160000, triggerRatio: 0.98, usableRatio: 0.98, source: 'declared' })
eq('H2 学到的上限压过声明值', computeCodexSpec({ declaredWindow: 1000000, triggerRatio: 0.98, usableRatio: 0.98, learnedWindow: 500000 }), { window: 500000, thresholdTokens: 490000, retainTokens: 80000, triggerRatio: 0.98, usableRatio: 0.98, source: 'learned' })
eq('H3 学到的上限更大则不生效', computeCodexSpec({ declaredWindow: 1000000, triggerRatio: 0.98, usableRatio: 0.98, learnedWindow: 2000000 }).source, 'declared')
{
  // 同一引擎：溢出前 50 万不压（阈值 98 万）；溢出后学到 47.5 万窗口 -> 阈值 46.55 万 -> 压
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false },
    { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 500000, contextWindow: 1000000 } })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  const before = h.engine.calls.compactRegion.length
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')   // 交给 basic，同时学习
  const learnedLogged = /learned capacity/.test(h.logs.info.join(' '))
  h.state.tokens = 500000
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('H4 溢出后按学到的容量判定', [before, learnedLogged, h.engine.calls.compactRegion.length - before], [0, true, 1])
}
{
  // 学习只收紧不放松：第二次更大的溢出不应抬高上限
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false },
    { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0 })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  h.state.tokens = 900000
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  h.state.tokens = 500000
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('H5 学习只收紧不放松', h.engine.calls.compactRegion.length, 1)
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, learnFromOverflow: false, compactionRetries: 0, auto: false },
    { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0 })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('H6 关闭学习后不收紧', h.engine.calls.compactRegion.length, 0)
}
{
  const map = new Map()
  for (let i = 0; i < 200; i += 1) rememberBounded(map, 's' + i, i, 64)
  rememberBounded(map, 's0', 999, 64)
  eq('H7 状态有界且淘汰最久未写', [map.size, map.has('s0'), map.get('s0'), map.has('s1')], [64, true, 999, false])
}

// ---------- I. /auto-compaction 自诊断命令 ----------
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, auto: false }, { tokens: 341361, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 341361, contextWindow: 1000000 } })
  eq('I1 默认注册命令名与定义 ID', [h.commands.length, h.commands[0]?.name, h.commands[0]?.definitionId], [1, 'auto-compaction', 'dsh-auto-compaction/diagnostics'])
  const out = await h.commands[0].handler({ agent: h.agent, rawInput: '', signal: new AbortController().signal })
  const text = out.text
  eq('I2 诊断含路由与窗口来源', [/codemaker\/deepseek-flash/.test(text), /来源 declared/.test(text)], [true, true])
  eq('I3 诊断含阈值与占比', [/阈值  98% → 980,000/.test(text), /阈值的 35%/.test(text), /还差 638,639/.test(text)], [true, true, true])
  eq('I4 诊断含分子来源与保留预算', [/projection\/pressureTokens/.test(text), /保留  160,000 tokens/.test(text)], [true, true])
  eq('I5 未压缩时的会话行', /本会话  还没有压缩过/.test(text), true)
  eq('I6 带参数时给用法', (await h.commands[0].handler({ agent: h.agent, rawInput: ' now' })).kind, 'error')
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false },
    { tokens: 990000, drop: 700000, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 990000, contextWindow: 1000000 } })
  h.engine.onCompactRegion = async () => { h.state.tokens = 290000; h.state.drop = 0 }
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '', signal: undefined })).text
  eq('I7 压缩后报告次数与相位', [/已压 1 次/.test(text), /pressure/.test(text), /shadowed 2 节点/.test(text)], [true, true, true])
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, auto: false }, { tokens: 500000, declared: 1000000, defaultMax: 0 })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '', signal: undefined })).text
  eq('I8 学到上限后窗口行标注', [/已学习上限 475,000/.test(text), /来源 learned/.test(text)], [true, true])
}
eq('I9 空命令名 = 不注册', mkEngine({ diagnosticsCommandName: '', auto: false }, { tokens: 100, declared: 1000 }).commands.length, 0)
eq('I10 没有命令服务时不影响加载', (() => { const h = mkEngine({ triggerRatio: 0.98, auto: false }, { tokens: 100, declared: 1000, commands: false }); return [h.commands.length, typeof h.engine.compactIfNeeded] })(), [0, 'function'])
try { mkEngine({ diagnosticsCommandName: 'Bad Name' }); R['I11 非法命令名被拒'] = 'FAIL 未拒绝' }
catch (error) { R['I11 非法命令名被拒'] = /diagnosticsCommandName must match/.test(error.message) ? 'ok' : 'FAIL ' + error.message }
{
  const h = mkEngine({ triggerRatio: 0.98, auto: false }, { tokens: 100, declared: null })
  const out = await h.commands[0].handler({ agent: h.agent, rawInput: '', signal: undefined })
  eq('I12 无声明窗口时给出修法', [/适配器未声明或未配置覆盖/.test(out.text), /配 triggerRatio/.test(out.text)], [true, true])
}

// ---------- J. 策略预设组合 + 字段说明 ----------
eq('J1 aggressive 填充未给出的字段', applyPolicyPreset({ policyPreset: 'aggressive' }), { policyPreset: 'aggressive', triggerRatio: 0.98, usableRatio: 0.98, postTurnThresholdPercent: 100 })
eq('J2 显式值优先于预设', (() => { const r = applyPolicyPreset({ policyPreset: 'aggressive', triggerRatio: 0.6 }); return [r.triggerRatio, r.usableRatio] })(), [0.6, 0.98])
eq('J3 没有预设时原样返回', applyPolicyPreset({ triggerRatio: 0.7 }), { triggerRatio: 0.7 })
eq('J4 预设表内容', [POLICY_PRESETS.conservative.triggerRatio, POLICY_PRESETS.conservative.postTurnThresholdPercent, POLICY_PRESETS.balanced.postTurnThresholdPercent], [0.9, 0, 80])
try { applyPolicyPreset({ policyPreset: 'nonsense' }); R['J5 未知预设名被拒'] = 'FAIL 未拒绝' }
catch (error) { R['J5 未知预设名被拒'] = /policyPreset must be one of/.test(error.message) ? 'ok' : 'FAIL ' + error.message }
{
  // 引擎级：conservative 关闭回合末相位（不注册 turn-stopping），并接管压力路径
  const h = mkEngine({ policyPreset: 'conservative' }, { tokens: 950, declared: 1000, defaultMax: 0 })
  eq('J6 conservative 不注册回合末相位', h.listeners.filter((x) => x[0] === 'agent/turn-stopping').length, 0)
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '' })).text
  eq('J7 conservative 阈值 90%', /阈值  90% → 900/.test(text), true)
}
{
  const h = mkEngine({ policyPreset: 'balanced' }, { tokens: 100, declared: 1000 })
  eq('J8 balanced 注册回合末 80%', [h.listeners.filter((x) => x[0] === 'agent/turn-stopping').length, h.commands.length], [1, 1])
}
{
  // 字段说明：每个顶层字段都要有中英文，且覆盖 schema 上的键
  const zhKeys = Object.keys(CONFIG_DESCRIPTIONS.zh)
  const enKeys = Object.keys(CONFIG_DESCRIPTIONS.en)
  const missingZh = enKeys.filter((k) => !zhKeys.includes(k))
  const missingEn = zhKeys.filter((k) => !enKeys.includes(k))
  eq('J9 说明表 zh/en 对齐', [missingZh.length, missingEn.length], [0, 0])
  const required = ['triggerRatio','usableRatio','windowRatio','contextWindow','compactTokenLimit','pressureSource','learnFromOverflow','diagnosticsCommandName','policyPreset','postTurnThresholdPercent','postTurnCooldownMs','postTurnMaxAttemptsPerSession','retainTokens','maxTokens','auto','modelPolicies']
  eq('J10 说明覆盖本插件字段', required.filter((k) => !zhKeys.includes(k)), [])
}

// ---------- K. 学习结果的持久化（跨重启） ----------
{
  const store = mkStorage()
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, auto: false }, { tokens: 500000, declared: 1000000, defaultMax: 0, storageDomain: store.storageDomain })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  await tick()
  eq('K1 学习结果写入存储', [store.opens.length, store.opens[0]?.name, store.opens[0]?.layout, store.puts.length, store.puts[0]?.[0], store.puts[0]?.[1]?.tokens], [1, CAPACITY_DOMAIN.name, 'single', 1, 'codemaker/deepseek-flash', 475000])
}
{
  // 预置记录 = 上一次进程学过的东西：新引擎第一次判定就该按 47.5 万窗口算
  const store = mkStorage({ 'codemaker/deepseek-flash': { tokens: 475000, at: 1 } })
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false }, { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0, storageDomain: store.storageDomain })
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('K2 重启后载入并使用学到的上限', [h.engine.calls.compactRegion.length, h.logs.info.some((m) => /loaded 1 learned capacity/.test(m))], [1, true])
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false }, { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0 })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  h.state.tokens = 500000
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('K3 无存储时退化为内存且判定照常', h.engine.calls.compactRegion.length, 1)
}
{
  const store = mkStorage()
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, learnFromOverflow: false, auto: false }, { tokens: 500000, declared: 1000000, defaultMax: 0, storageDomain: store.storageDomain })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  await tick()
  eq('K4 关闭学习则不碰存储', [store.opens.length, store.puts.length], [0, 0])
}
{
  const store = mkStorage({}, { openFails: true })
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, compactionRetries: 0, auto: false }, { tokens: 500000, drop: 400000, declared: 1000000, defaultMax: 0, storageDomain: store.storageDomain })
  await h.engine.compactIfNeeded(h.agent, 'context-overflow')
  await tick()
  h.state.tokens = 500000
  await h.engine.compactIfNeeded(h.agent, 'pressure')
  eq('K5 存不开时警告一次并继续用内存', [/persistence unavailable/.test(h.logs.warn.join(' ')), h.engine.calls.compactRegion.length, h.logs.warn.length], [true, 1, 1])
}

// ---------- L. 自诊断语言（zh / en / both） ----------
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, auto: false }, { tokens: 341361, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 341361, contextWindow: 1000000 } })
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '' })).text
  eq('L1 默认 both 输出中英两行', [/自动压缩自诊断/.test(text), /auto-compaction diagnostics/.test(text), /窗口  声明/.test(text), /window  declared/.test(text)], [true, true, true, true])
  eq('L2 both 的行数 = 7 组 × 2 行', text.split('\n').length, 14)
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, diagnosticsLanguage: 'zh', auto: false }, { tokens: 341361, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 341361, contextWindow: 1000000 } })
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '' })).text
  eq('L3 zh 只有中文', [/窗口  声明/.test(text), /window  declared/.test(text)], [true, false])
}
{
  const h = mkEngine({ triggerRatio: 0.98, usableRatio: 0.98, diagnosticsLanguage: 'en', auto: false }, { tokens: 341361, declared: 1000000, defaultMax: 0, projections: { pressureTokens: 341361, contextWindow: 1000000 } })
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '' })).text
  eq('L4 en 只有英文', [/窗口  声明/.test(text), /window  declared/.test(text), /35% of threshold/.test(text)], [false, true, true])
}
{
  const h = mkEngine({ triggerRatio: 0.98, diagnosticsLanguage: 'en', auto: false }, { tokens: 100, declared: null })
  const text = (await h.commands[0].handler({ agent: h.agent, rawInput: '' })).text
  eq('L5 无窗口分支也跟随语言', [/does not own the pressure path/.test(text), /本插件未接管/.test(text)], [true, false])
}
{
  const h = mkEngine({ triggerRatio: 0.98, diagnosticsLanguage: 'zh', auto: false }, { tokens: 0, declared: 1000 })
  const text = (await h.commands[0].handler({ agent: { session: { id: 's1', requestContext: () => ({ provider: undefined, model: undefined }) }, options: {} }, rawInput: '' })).text
  eq('L6 无路由分支也跟随语言', [/还没有已路由的请求/.test(text), /no routed request/.test(text)], [true, false])
}
try { mkEngine({ diagnosticsLanguage: 'fr' }); R['L7 非法语言被拒'] = 'FAIL 未拒绝' }
catch (error) { R['L7 非法语言被拒'] = /diagnosticsLanguage must be/.test(error.message) ? 'ok' : 'FAIL ' + error.message }

const failed = Object.entries(R).filter(([, value]) => value !== 'ok')
console.log(JSON.stringify(R, null, 1))
console.log(failed.length === 0 ? 'ALL PASS (' + Object.keys(R).length + ')' : 'FAILURES: ' + JSON.stringify(failed))
process.exit(failed.length === 0 ? 0 : 1)
