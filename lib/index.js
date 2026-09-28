/**
 * dsh-auto-compaction — 面向真实部署的自动压缩后端（策略取自 Codex）。
 *
 * 与随附 `@deepseek-ai/dsh-compaction-basic` 的差异（都是刻意为之）：
 *
 * 1. **有效窗口覆盖**（Codex 的 `model_context_window`）：适配器声明的窗口可以是
 *    乐观值（本项目里 codemaker 全部声明 1000000），那样 0.9 阈值永远到不了，
 *    自动压缩等于死代码。配置 `contextWindow` 后，阈值与保留预算都按真实容量算。
 * 2. **Codex 阈值口径**：`min(compactTokenLimit ?? 0.9W, 0.95W) − 输出预留`，
 *    保留 `retainTokens ?? 0.16 × (W − 输出预留)`。未配置任何覆盖时整条压力路径
 *    交回 basic，行为与默认后端一致。
 * 3. **PostTurn 相位**：Codex 的回合末压缩落在 `CompactionPhase::PostTurn`。
 *    DSH 默认没有这个相位，本插件挂在 `agent/turn-stopping`（回合还没关闭，
 *    因此可以用 `compactRegion` 的 current-turn 事务）——而不是 `compactNow()`：
 *    后者按 retainTokens=0 选区，只会保留最后一个表层节点，等于把逐字尾全部丢掉。
 * 4. **观测**：每次压缩记一条 info（窗口/阈值/保留量/释放量），配置问题按 target
 *    只警告一次，绝不因为压缩失败打断已完成的回合。
 */
import z from '@deepseek-ai/schemastery'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { ManualCompactionError, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

/** 默认触发比例：有效窗口的 90%（Codex 的 auto_compact_token_limit 缺省口径）。 */
const DEFAULT_TRIGGER_RATIO = 0.9
/** 默认硬上限比例：95%（Codex 的 effective_context_window_percent）。 */
const USABLE_WINDOW_RATIO = 0.95
/** 从溢出反推容量时留的余量：被拒规模 × 该系数当作有效窗口。 */
const LEARNED_MARGIN = 0.95
/** 学习结果的持久化领域（storage-domain，json 后端的 single 布局）。 */
export const CAPACITY_DOMAIN = Object.freeze({ name: 'auto_compaction', table: 'capacity', version: 1 })
/** basic 的默认逐字尾比例，用于未显式给 retainTokens 时按有效窗口缩放。 */
const DEFAULT_RETAIN_RATIO = 0.16
const DEFAULT_POST_TURN_COOLDOWN_MS = 15_000
const DEFAULT_POST_TURN_MAX_ATTEMPTS = 3

const positiveInteger = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0

/** 千分位（不依赖 locale，宿主/测试环境表现一致）。 */
const formatTokens = (value) => (typeof value === 'number' ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '—')
/** 比例转百分比文本。 */
const formatRatio = (value) => (typeof value === 'number' ? Math.round(value * 100) + '%' : '—')
/** 本地 HH:MM:SS。 */
const formatClock = (at) => new Date(at).toTimeString().slice(0, 8)

/** 比例取值：0 < r ≤ 1，非法/缺失都回退（纯函数里的宽松口径）。 */
const ratioValue = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback)

/** 配置里的正整数：非法直接 fail-fast。 */
function normalizePositive(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('AutoCompactionConfig: ' + name + ' must be a positive integer')
  }
  return value
}

/** 自诊断输出语言：zh / en / both（默认 both）。 */
function normalizeLanguage(value) {
  if (value === undefined) return 'both'
  if (value === 'zh' || value === 'en' || value === 'both') return value
  throw new Error("AutoCompactionConfig: diagnosticsLanguage must be 'zh', 'en' or 'both'")
}

/** 自诊断命令名：空串 = 关闭；否则必须是小写命令名。 */
function normalizeCommandName(value) {
  if (value === undefined) return 'auto-compaction'
  if (typeof value !== 'string') throw new Error('AutoCompactionConfig: diagnosticsCommandName must be a string')
  if (value.length === 0) return ''
  if (!/^[a-z][a-z0-9_-]*$/.test(value)) {
    throw new Error('AutoCompactionConfig: diagnosticsCommandName must match /^[a-z][a-z0-9_-]*$/ (or be empty to disable)')
  }
  return value
}

/** 判定分子口径：非法直接 fail-fast。 */
function normalizePressureSource(value) {
  if (value === undefined) return 'projection'
  if (value !== 'projection' && value !== 'meter') {
    throw new Error("AutoCompactionConfig: pressureSource must be 'projection' or 'meter'")
  }
  return value
}

/** 配置里的比例：非法直接 fail-fast。 */
function normalizeRatio(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('AutoCompactionConfig: ' + name + ' must be a number in (0, 1]')
  }
  return value
}

/**
 * 把「适配器声明的窗口 / 配置覆盖的窗口 + Codex 口径」解析成阈值与逐字尾预算。
 * 纯函数，便于脱离 Cordis 单测。
 * @param input.declaredWindow - 适配器声明的上下文窗口。
 * @param input.overrideWindow - 配置的有效窗口覆盖（Codex 的 model_context_window）。
 * @param input.compactTokenLimit - 显式阈值（Codex 的 model_auto_compact_token_limit）。
 * @param input.windowRatio - 对声明窗口的信任系数：声明 1M 而实际 200k 时填 0.2。
 * @param input.triggerRatio - 触发比例：有效窗口的百分之多少触发（默认 0.9）。
 * @param input.usableRatio - 硬上限比例（默认 0.95）。
 * @param input.reservedOutputTokens - 该路由一次请求预留的输出 token。
 * @param input.retainTokens - 显式逐字尾预算。
 * @param input.retainRatio - 未给 retainTokens 时按可用容量的比例缩放。
 * @returns {{window:number, thresholdTokens:number, retainTokens:number, triggerRatio:number, source:'override'|'declared'}|null}
 */
export function computeCodexSpec(input) {
  const scaled = positiveInteger(input.declaredWindow)
    ? Math.max(1, Math.floor(input.declaredWindow * ratioValue(input.windowRatio, 1)))
    : undefined
  const configured = positiveInteger(input.overrideWindow) ? input.overrideWindow : scaled
  if (!positiveInteger(configured)) return null
  // 从真实溢出里学到的上限优先于一切声明/覆盖：它是唯一有实证的容量。
  const learned = positiveInteger(input.learnedWindow) ? input.learnedWindow : undefined
  const window = learned === undefined ? configured : Math.min(configured, learned)
  const learnedApplied = learned !== undefined && learned < configured
  // 输出预留可能大于覆盖后的窗口（声明 1M 的路由默认预留 32k，而窗口被覆盖成 20k 时）：
  // 夹到窗口的一半，保证仍有可压区间，而不是悄悄停用压缩。
  const reserved = Math.min(positiveInteger(input.reservedOutputTokens) ? input.reservedOutputTokens : 0, Math.floor(window / 2))
  const capacity = window - reserved
  if (capacity <= 0) return null
  const triggerRatio = ratioValue(input.triggerRatio, DEFAULT_TRIGGER_RATIO)
  const usableRatio = ratioValue(input.usableRatio, USABLE_WINDOW_RATIO)
  const windowLimit = Math.floor(window * triggerRatio)
  const usableLimit = Math.floor(window * usableRatio)
  const configuredLimit = positiveInteger(input.compactTokenLimit) ? Math.min(input.compactTokenLimit, windowLimit) : windowLimit
  const thresholdTokens = Math.max(1, Math.min(configuredLimit, usableLimit, capacity))
  const keep = positiveInteger(input.retainTokens)
    ? input.retainTokens
    : Math.floor(capacity * (typeof input.retainRatio === 'number' && input.retainRatio > 0 ? input.retainRatio : DEFAULT_RETAIN_RATIO))
  // basic 的事务要求 retain < threshold 且必须留下可压区间，这里直接夹住而不是抛错。
  const retainTokens = Math.max(0, Math.min(keep, Math.floor(thresholdTokens * 0.9)))
  return {
    window,
    thresholdTokens,
    retainTokens,
    triggerRatio,
    usableRatio,
    source: learnedApplied ? 'learned' : (positiveInteger(input.overrideWindow) ? 'override' : 'declared'),
  }
}

/**
 * 选出「保留近期逐字尾」的可压区间：与 basic 的选区同构（首个 system/message 不入列、
 * 工具调用/结果不成对不切），但保留预算由本插件按有效窗口给出。
 * @returns {{start:number, end:number}|null}
 */
export function selectRetainedRange(session, measurement, retainTokens) {
  const pricedNodes = measurement.nodes
  if (!Array.isArray(pricedNodes) || pricedNodes.length === 0) return null
  const surfaceNodes = session.surface.nodes
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length !== pricedNodes.length) return null
  if (surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) return null
  const head = session.eventAt(surfaceNodes[0])
  const firstIdx = head?.type === 'system/message' ? 1 : 0
  let accumulated = 0
  let keepFromIdx = pricedNodes.length
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index].tokens
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx <= firstIdx) return null
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null
  return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }
}

/**
 * 压缩锁是否在途：与 basic 的 inspectCompactionEntryState 同构，只用公开 API
 * （session.seq / session.eventAt）反向扫描日志 —— 未配对的 compaction/start，
 * 且不早于最新的 session/end-seed，才算一次在途压缩。父类的自动路径会在决策后
 * 断言它（assertNoActiveCompaction）；本插件重写了压力路径，所以自己先查一次，
 * 避免在别的压缩在途时修剪会话、干扰对方要求的表层稳定。
 * @returns true 表示当前会话已有在途压缩。
 */
export function hasActiveCompactionLock(session) {
  let unmatchedStart
  let entryStateKnown = false
  let latestEndSeedSeq
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) continue
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq
    if (!entryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event.seq
        entryStateKnown = true
      } else if (event.type === 'compaction/end') entryStateKnown = true
    }
    if (entryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return unmatchedStart !== undefined && (latestEndSeedSeq === undefined || latestEndSeedSeq < unmatchedStart)
}

/**
 * 开箱可选的策略组合：只填用户没显式给出的字段，显式值永远优先。
 * - conservative：Codex 的保守口径（90% 触发 / 95% 硬顶 / 不启用回合末相位）
 * - balanced：95% 触发 / 95% 硬顶 / 回合末 80% of 可用窗口
 * - aggressive：98% 触发 / 98% 硬顶 / 回合末与压力触发同点（贴窗口，压缩收益最大）
 */
export const POLICY_PRESETS = Object.freeze({
  conservative: Object.freeze({ triggerRatio: 0.9, usableRatio: 0.95, postTurnThresholdPercent: 0 }),
  balanced: Object.freeze({ triggerRatio: 0.95, usableRatio: 0.95, postTurnThresholdPercent: 80 }),
  aggressive: Object.freeze({ triggerRatio: 0.98, usableRatio: 0.98, postTurnThresholdPercent: 100 }),
})

/** 顶层配置字段的中英文说明（GUI 设置表单直接渲染）。 */
export const CONFIG_DESCRIPTIONS = Object.freeze({
  zh: {
    thresholdRatio: '（basic）压力阈值比例；本插件接管压力路径后以 triggerRatio 为准',
    headroomTokens: '（basic）阈值上额外预留的压力余量',
    retainRatio: '未给 retainTokens 时，逐字尾预算占可用容量的比例',
    retainTokens: '逐字保留的近期 tail token 数（对齐 Codex 的 20k 用户消息预算）',
    summarizationProvider: '摘要请求的提供方；留空跟随当前路由',
    summarizationModel: '摘要请求的模型；留空跟随当前路由',
    maxTokens: '摘要输出的 token 上限',
    compactionRetries: '一次触发下最多压缩几轮',
    maxOverflowRetries: 'provider 报上下文溢出后最多压缩重试几次',
    auto: '是否启用自动压缩与溢出恢复；false 则只在手动命令下压缩',
    modelPolicies: '逐模型覆盖：provider/model 加任意上面的字段，另加 windowRatio/triggerRatio/contextWindow/compactTokenLimit',
    contextWindow: '有效窗口绝对值覆盖（优先级最高）',
    compactTokenLimit: '显式阈值 token 数；缺省 = 有效窗口 × triggerRatio',
    windowRatio: '对适配器声明窗口的信任系数：声明 1M 而实际 200k 就填 0.2',
    triggerRatio: '触发比例：有效窗口的百分之多少触发（0.98 = 98%）',
    usableRatio: '硬上限比例：阈值不会超过它（与 triggerRatio 取小）',
    pressureSource: '判定分子口径：projection（与 GUI「上下文已用」环同源）或 meter（回放估算）',
    learnFromOverflow: '从 provider 报的上下文溢出反推真实容量，并当作有效窗口上限（只收紧）',
    diagnosticsCommandName: '自诊断命令名；空字符串 = 不注册（默认 auto-compaction）',
    policyPreset: '策略组合预设：conservative / balanced / aggressive（只填未显式给出的字段）',
    postTurnThresholdPercent: '回合末相位阈值：占可用窗口的百分比；0 = 关闭',
    postTurnCooldownMs: '同一会话两次回合末压缩的最小间隔（毫秒）',
    postTurnMaxAttemptsPerSession: '同一会话回合末压缩的次数上限',
  },
  en: {
    thresholdRatio: '(basic) pressure ratio; triggerRatio takes over once this plugin owns the pressure path',
    headroomTokens: '(basic) extra pressure headroom below the threshold',
    retainRatio: 'verbatim tail budget as a fraction of usable capacity when retainTokens is unset',
    retainTokens: 'verbatim recent-tail token budget (mirrors Codex’s 20k user-message budget)',
    summarizationProvider: 'provider for the summarization request; empty follows the routed model',
    summarizationModel: 'model for the summarization request; empty follows the routed model',
    maxTokens: 'output token cap for the summary',
    compactionRetries: 'how many compactions one trigger may run',
    maxOverflowRetries: 'how many compaction retries after a provider context overflow',
    auto: 'enable automatic compaction and overflow recovery; false keeps it manual-only',
    modelPolicies: 'per-model overrides: provider/model plus any field above, and windowRatio/triggerRatio/contextWindow/compactTokenLimit',
    contextWindow: 'absolute effective window override (highest priority)',
    compactTokenLimit: 'explicit threshold in tokens; defaults to effective window × triggerRatio',
    windowRatio: 'trust factor for the declared window (1M declared / 200k real → 0.2)',
    triggerRatio: 'trigger at this fraction of the effective window (0.98 = 98%)',
    usableRatio: 'hard ceiling; the threshold never exceeds it',
    pressureSource: 'numerator source: projection (same number as the GUI ring) or meter (replay estimate)',
    learnFromOverflow: 'derive real capacity from provider context overflows and cap the window with it (tightens only)',
    diagnosticsCommandName: 'diagnostics command name; empty string disables it (default auto-compaction)',
    policyPreset: 'policy preset: conservative / balanced / aggressive (fills only fields you left unset)',
    postTurnThresholdPercent: 'turn-end phase threshold as a percent of the usable window; 0 disables it',
    postTurnCooldownMs: 'minimum delay between two turn-end compactions in one session',
    postTurnMaxAttemptsPerSession: 'attempt cap for turn-end compaction per session',
  },
})

/** 把预设填进未显式给出的字段；显式值优先。未知预设名直接 fail-fast。 */
export function applyPolicyPreset(raw = {}) {
  const name = raw.policyPreset
  if (name === undefined) return raw
  const preset = POLICY_PRESETS[name]
  if (preset === undefined) {
    throw new Error('AutoCompactionConfig: policyPreset must be one of ' + Object.keys(POLICY_PRESETS).join(' / '))
  }
  const merged = { ...raw }
  for (const [field, value] of Object.entries(preset)) {
    if (merged[field] === undefined) merged[field] = value
  }
  return merged
}

/**
 * 有界记忆：宿主进程长跑，per-session 状态不能无限增长（Map 保持插入序，删最早的）。
 * 命中的 key 会移到末尾，因此淘汰的是"最久未写"的那个。
 */
export function rememberBounded(map, key, value, limit = 64) {
  map.delete(key)
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return map
}

/** 自动压缩引擎：basic 的 durable 事务 + Codex 的触发与 PostTurn 相位。 */
export class AutoCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = z.object({
    // —— basic 的字段：原样透传 ——
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    auto: z.boolean(),
    modelPolicies: z.array(z.object({
      provider: z.string(),
      model: z.string(),
      thresholdRatio: z.number(),
      headroomTokens: z.number().step(1).min(0),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
      /** 逐模型的有效窗口覆盖。 */
      contextWindow: z.number().step(1).min(1),
      /** 逐模型的显式阈值。 */
      compactTokenLimit: z.number().step(1).min(1),
      /** 逐模型对声明窗口的信任系数。 */
      windowRatio: z.number(),
      /** 逐模型的触发比例。 */
      triggerRatio: z.number(),
    })),
    // —— 本插件的扩展 ——
    /** 有效窗口覆盖：适配器声明不可信时用它（Codex 的 model_context_window）。 */
    contextWindow: z.number().step(1).min(1),
    /** 显式阈值；缺省 = 有效窗口 × triggerRatio（Codex 的 model_auto_compact_token_limit）。 */
    compactTokenLimit: z.number().step(1).min(1),
    /** 对「适配器声明的窗口」的信任系数：声明 1M 而实际 200k 时填 0.2。 */
    windowRatio: z.number(),
    /** 触发比例：有效窗口的百分之多少触发（0.95 = 95%）。 */
    triggerRatio: z.number(),
    /** 硬上限比例：阈值不会超过它（默认 0.95）。 */
    usableRatio: z.number(),
    /** 判定分子口径：'projection'（默认，与 GUI 的「上下文已用」环同源）或 'meter'（basic 的回放估算）。 */
    pressureSource: z.string(),
    /** 从 provider 报的上下文溢出里反推真实容量，并把它当作有效窗口的上限（默认开）。 */
    learnFromOverflow: z.boolean(),
    /** 自诊断命令名（小写字母/数字/下划线/连字符）；空字符串 = 不注册。默认 'auto-compaction'。 */
    diagnosticsCommandName: z.string(),
    /** 策略组合预设：conservative / balanced / aggressive。 */
    policyPreset: z.string(),
    /** 自诊断输出语言：zh / en / both（默认 both）。 */
    diagnosticsLanguage: z.string(),
    /** 回合末阈值：占可用窗口（95%）的百分比；0 = 关闭 PostTurn 相位。 */
    postTurnThresholdPercent: z.number().step(1).min(0),
    /** 同一会话两次回合末压缩的最小间隔。 */
    postTurnCooldownMs: z.number().step(1).min(0),
    /** 同一会话回合末压缩的最大次数（低于阈值后自动清零）。 */
    postTurnMaxAttemptsPerSession: z.number().step(1).min(1),
  }).i18n(CONFIG_DESCRIPTIONS)

  #codex

  constructor(ctx, input = {}) {
    const raw = applyPolicyPreset(input)
    const {
      contextWindow, compactTokenLimit, windowRatio, triggerRatio, usableRatio, pressureSource, learnFromOverflow,
      diagnosticsCommandName, diagnosticsLanguage, policyPreset: _preset, postTurnThresholdPercent, postTurnCooldownMs,
      postTurnMaxAttemptsPerSession, modelPolicies, ...basicConfig
    } = raw
    // 父类对未知 key 是 fail-fast 的：扩展字段（含 modelPolicies 内的扩展键）必须先剥离。
    const basicPolicies = []
    const policyWindows = new Map()
    for (const policy of modelPolicies ?? []) {
      const {
        contextWindow: policyWindow, compactTokenLimit: policyLimit,
        windowRatio: policyWindowRatio, triggerRatio: policyTriggerRatio, ...rest
      } = policy
      basicPolicies.push(rest)
      const label = 'modelPolicies[' + policy.provider + '/' + policy.model + '].'
      const override = {
        contextWindow: normalizePositive(policyWindow, label + 'contextWindow'),
        compactTokenLimit: normalizePositive(policyLimit, label + 'compactTokenLimit'),
        windowRatio: normalizeRatio(policyWindowRatio, label + 'windowRatio'),
        triggerRatio: normalizeRatio(policyTriggerRatio, label + 'triggerRatio'),
      }
      if (Object.values(override).some((value) => value !== undefined)) {
        policyWindows.set(policy.provider + '/' + policy.model, override)
      }
    }
    super(ctx, { ...basicConfig, modelPolicies: basicPolicies })
    this.#codex = {
      contextWindow: normalizePositive(contextWindow, 'contextWindow'),
      compactTokenLimit: normalizePositive(compactTokenLimit, 'compactTokenLimit'),
      windowRatio: normalizeRatio(windowRatio, 'windowRatio'),
      triggerRatio: normalizeRatio(triggerRatio, 'triggerRatio'),
      usableRatio: normalizeRatio(usableRatio, 'usableRatio'),
      pressureSource: normalizePressureSource(pressureSource),
      learnFromOverflow: learnFromOverflow === undefined ? true : Boolean(learnFromOverflow),
      learnedMargin: LEARNED_MARGIN,
      learnedCeiling: new Map(),
      capacityStore: undefined,
      capacityStorePromise: undefined,
      capacityLoaded: false,
      policyWindows,
      postTurnPercent: normalizeInteger(postTurnThresholdPercent, 0, 0, 100, 'postTurnThresholdPercent'),
      postTurnCooldownMs: normalizeInteger(postTurnCooldownMs, DEFAULT_POST_TURN_COOLDOWN_MS, 0, Number.MAX_SAFE_INTEGER, 'postTurnCooldownMs'),
      postTurnMaxAttempts: normalizeInteger(postTurnMaxAttemptsPerSession, DEFAULT_POST_TURN_MAX_ATTEMPTS, 1, Number.MAX_SAFE_INTEGER, 'postTurnMaxAttemptsPerSession'),
      commandName: normalizeCommandName(diagnosticsCommandName),
      diagnosticsLanguage: normalizeLanguage(diagnosticsLanguage),
      compactions: new Map(),
      attempts: new Map(),
      lastRunAt: new Map(),
      running: new WeakSet(),
      warnedTargets: new Set(),
    }
    if (this.config.auto && this.#codex.postTurnPercent > 0) this.#registerPostTurnCompaction()
    if (this.#codex.commandName.length > 0) this.#registerDiagnosticsCommand()
  }

  /**
   * 触发判定的分子。默认与 GUI 的「上下文已用」环**同源**：读 token-meter 注册的
   * \`contextPressure\` 投影（\`projectedTokens ?? pressureTokens\`，即提供方报告/预估的下一次
   * 请求提示词规模），所以"环上到 95% 就压"成立。投影服务缺席或没有可用数值时回退到
   * tokenMeter 的回放估算（basic 的口径）；\`pressureSource: meter\` 可强制回退。
   * 投影只给数字，选区仍然要用 tokenMeter 的 nodes。
   * @param agent - 待判定的 agent。
   * @param measurement - 本次 tokenMeter 测量（回退用）。
   * @returns 用于与阈值比较的 token 数。
   */
  #pressureDetail(agent, measurement) {
    if (this.#codex.pressureSource !== 'meter') {
      const projections = this.ctx.get('sessionProjections')
      const state = projections?.stateOf?.(agent.session, 'contextPressure')
      const used = state?.projectedTokens ?? state?.pressureTokens
      if (typeof used === 'number' && Number.isFinite(used) && used > 0) {
        return {
          tokens: used,
          source: state?.projectedTokens !== undefined ? 'projection/projectedTokens' : 'projection/pressureTokens',
        }
      }
    }
    return { tokens: measurement.totalTokens, source: 'tokenMeter' }
  }

  /** 判定分子（数值）；来源见 #pressureDetail。 */
  #pressureTokens(agent, measurement) {
    return this.#pressureDetail(agent, measurement).tokens
  }

  /**
   * 压力触发：按 Codex 口径重算阈值与保留预算，再走 basic 的同一个 durable 事务。
   * 没有配置任何窗口/阈值覆盖时交回父类，保持默认后端行为。
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'context-overflow') {
      this.#learnFromOverflow(agent)
      return await super.compactIfNeeded(agent, trigger, signal)
    }
    const spec = await this.#resolveSpec(agent, signal)
    if (spec === null) return await super.compactIfNeeded(agent, trigger, signal)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    if (this.#pressureTokens(agent, measurement) < spec.thresholdTokens) return null
    if (hasActiveCompactionLock(agent.session)) return null
    const prune = this.ctx.get('toolResultPruner')
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
      if (this.#pressureTokens(agent, measurement) < spec.thresholdTokens) return null
    }
    let result = null
    const retries = this.config.compactionRetries
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const range = selectRetainedRange(agent.session, measurement, spec.retainTokens)
      if (range === null) return result
      const before = this.#pressureTokens(agent, measurement)
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      const after = this.#pressureTokens(agent, measurement)
      this.#recordCompaction(agent, 'pressure', before, after, result)
      if (after < spec.thresholdTokens) return result
    }
    this.#warnOnce(spec.key, 'still above the threshold after ' + (retries + 1) + ' attempt(s); the next step will retry')
    return result
  }

  /**
   * 可选注册自诊断命令：命令注册表缺席的组合（headless/ACP）不会因此加载失败。
   * 命令只读，不触发压缩（手动压缩仍是 /compact）。
   */
  #registerDiagnosticsCommand() {
    const ctx = this.ctx
    if (typeof ctx.inject !== 'function') return
    const definition = {
      definitionId: CommandDefinitionId('dsh-auto-compaction/diagnostics'),
      name: this.#codex.commandName,
      description: 'Show auto-compaction diagnostics for this session',
      handler: (invocation) => this.#diagnostics(invocation),
    }
    ctx.inject(['commands'], (scoped) => {
      scoped.effect(function* () {
        yield scoped.commands.register(definition)
      }, 'auto-compaction diagnostics command')
    })
  }

  /**
   * 渲染一条自诊断文本：当前路由的有效窗口（含是否用到了从溢出学到的上限）、阈值、
   * 判定分子与占阈值的比例、保留预算、相位设置，以及本会话已发生的压缩。
   * 目的是让"没压"这件事可自查：是没到阈值，还是分母本身不可信。
   */
  /** 按 diagnosticsLanguage 渲染：'both' 时中英各占一行。 */
  #renderDiagnostics(pairs) {
    const language = this.#codex.diagnosticsLanguage
    const lines = []
    for (const [zh, en] of pairs) {
      if (language === 'zh') lines.push(zh)
      else if (language === 'en') lines.push(en)
      else lines.push(zh, en)
    }
    return lines.join('\n')
  }

  /**
   * 渲染一条自诊断文本：当前路由的有效窗口（含是否用到了从溢出学到的上限）、阈值、
   * 判定分子与占阈值的比例、保留预算、相位设置，以及本会话已发生的压缩。
   * 目的是让"没压"这件事可自查：是没到阈值，还是分母本身不可信。
   * 文案按 \`diagnosticsLanguage\` 输出（默认中英双行）。
   */
  async #diagnostics(invocation) {
    if ((invocation.rawInput ?? '').trim().length > 0) {
      return { kind: 'error', text: 'Usage: /' + this.#codex.commandName + ' (no arguments)' }
    }
    const agent = invocation.agent
    const route = agent.session.requestContext?.()
    const provider = route?.provider ?? agent.options?.provider
    const model = route?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) {
      return { kind: 'success', text: this.#renderDiagnostics([[
        '自动压缩：本会话还没有已路由的请求，先发一条消息再看。',
        'auto-compaction: this session has no routed request yet; send a message first.',
      ]]) }
    }
    const key = provider + '/' + model
    const info = await this.ctx.llm.resolveModelInfo(provider, model, undefined).catch(() => undefined)
    const declared = info?.context?.contextWindow
    const spec = await this.#resolveSpec(agent, undefined)
    const pairs = [[
      '自动压缩自诊断 · ' + key,
      'auto-compaction diagnostics · ' + key,
    ]]
    if (spec === null) {
      pairs.push(
        ['窗口  声明 ' + formatTokens(declared) + '（适配器未声明或未配置覆盖）',
          'window  declared ' + formatTokens(declared) + ' (adapter declares none / no override configured)'],
        ['状态  本插件未接管压力路径：没有配置任何窗口/比例/阈值覆盖时，交回 basic 默认策略',
          'state   this plugin does not own the pressure path: with no window/ratio/threshold override it hands back to the bundled backend'],
        ['修法  给本插件配 triggerRatio（如 0.98）或 contextWindow，再发一条消息',
          'fix     configure triggerRatio (e.g. 0.98) or contextWindow, then send a message'],
      )
      return { kind: 'success', text: this.#renderDiagnostics(pairs) }
    }
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const pressure = this.#pressureDetail(agent, measurement)
    const learned = this.#codex.learnFromOverflow ? this.#codex.learnedCeiling.get(key) : undefined
    const percent = spec.thresholdTokens > 0 ? Math.min(100, Math.round(pressure.tokens / spec.thresholdTokens * 100)) : 0
    const learnedSuffixZh = learned === undefined ? '' : '（已学习上限 ' + formatTokens(learned) + '）'
    const learnedSuffixEn = learned === undefined ? '' : ' (learned ceiling ' + formatTokens(learned) + ')'
    pairs.push(
      ['窗口  声明 ' + formatTokens(declared) + ' × 系数 → 有效 ' + formatTokens(spec.window) + learnedSuffixZh + ' · 来源 ' + spec.source,
        'window  declared ' + formatTokens(declared) + ' × factor → effective ' + formatTokens(spec.window) + learnedSuffixEn + ' · source ' + spec.source],
      ['阈值  ' + formatRatio(spec.triggerRatio) + ' → ' + formatTokens(spec.thresholdTokens) + ' tokens（硬上限 '
        + formatRatio(spec.usableRatio) + '；预留已计入）',
        'trigger ' + formatRatio(spec.triggerRatio) + ' → ' + formatTokens(spec.thresholdTokens) + ' tokens (ceiling '
        + formatRatio(spec.usableRatio) + '; output reservation included)'],
      ['当前  ' + formatTokens(pressure.tokens) + '（' + pressure.source + '）= 阈值的 ' + percent + '% · 还差 '
        + formatTokens(Math.max(0, spec.thresholdTokens - pressure.tokens)),
        'now     ' + formatTokens(pressure.tokens) + ' (' + pressure.source + ') = ' + percent + '% of threshold · '
        + formatTokens(Math.max(0, spec.thresholdTokens - pressure.tokens)) + ' to go'],
      ['保留  ' + formatTokens(spec.retainTokens) + ' tokens 逐字尾 · 摘要输出上限 '
        + (this.config.maxTokens === undefined ? '跟随 headroom' : formatTokens(this.config.maxTokens)),
        'retain  ' + formatTokens(spec.retainTokens) + ' verbatim tokens · summary cap '
        + (this.config.maxTokens === undefined ? 'follows headroom' : formatTokens(this.config.maxTokens))],
    )
    const state = this.#codex
    pairs.push(
      ['相位  回合末 ' + state.postTurnPercent + '% of 可用窗口 · 冷却 ' + Math.round(state.postTurnCooldownMs / 1000)
        + 's · 上限 ' + state.postTurnMaxAttempts + ' 次/会话 · 溢出重试 ' + (this.config.maxOverflowRetries ?? 1),
        'phases  turn-end ' + state.postTurnPercent + '% of usable · cooldown ' + Math.round(state.postTurnCooldownMs / 1000)
        + 's · cap ' + state.postTurnMaxAttempts + '/session · overflow retries ' + (this.config.maxOverflowRetries ?? 1)],
    )
    const stats = state.compactions.get(agent.session.id)
    if (stats === undefined) {
      pairs.push(['本会话  还没有压缩过', 'session no compaction yet'])
    } else {
      const last = stats.last
      pairs.push([
        '本会话  已压 ' + stats.count + ' 次 · 最近 ' + formatClock(last.at) + '（' + last.phase + '）估算释放 ~'
        + formatTokens(Math.max(0, last.before - last.after)) + ' · shadowed ' + last.shadowed + ' 节点 · '
        + formatTokens(last.before) + ' → ' + formatTokens(last.after),
        'session ' + stats.count + ' compaction(s) · last ' + formatClock(last.at) + ' (' + last.phase + ') released ~'
        + formatTokens(Math.max(0, last.before - last.after)) + ' · ' + last.shadowed + ' node(s) shadowed · '
        + formatTokens(last.before) + ' → ' + formatTokens(last.after),
      ])
    }
    return { kind: 'success', text: this.#renderDiagnostics(pairs) }
  }

  /**
   * 打开容量领域（storage-domain，single 布局），并把已存记录载入内存——这是
   * "跨重启记得被拒规模"的实现。存储设施缺席（无 storageDomain 服务）、导入失败或
   * 打开失败都只警告一次并退化成纯内存：压缩本身绝不因为持久化不可用而失败。
   * @returns 容量表句柄，或 undefined 表示只走内存。
   */
  async #capacityStore() {
    const state = this.#codex
    if (!state.learnFromOverflow) return undefined
    if (state.capacityStore !== undefined || state.capacityLoaded) return state.capacityStore
    if (state.capacityStorePromise === undefined) state.capacityStorePromise = this.#openCapacityStore()
    return await state.capacityStorePromise
  }

  async #openCapacityStore() {
    const state = this.#codex
    const storage = this.ctx.get('storageDomain')
    if (storage === undefined || typeof storage.open !== 'function') {
      state.capacityLoaded = true
      return undefined
    }
    try {
      const [zodModule, domainModule] = await Promise.all([
        import('zod'),
        import('@deepseek-ai/dsh-storage-domain'),
      ])
      const zod = zodModule.z ?? zodModule.default?.z ?? zodModule.default
      const spec = domainModule.defineDomain({
        name: CAPACITY_DOMAIN.name,
        version: CAPACITY_DOMAIN.version,
        layout: 'single',
        tables: {
          [CAPACITY_DOMAIN.table]: domainModule.domainTable(zod.object({
            tokens: zod.number().int().positive(),
            at: zod.number().int().nonnegative(),
          })),
        },
      })
      const domain = await storage.open(spec)
      this.ctx.effect(function* () {
        yield () => {
          try {
            const closing = domain.close?.()
            if (closing !== undefined && typeof closing.catch === 'function') closing.catch(() => {})
          } catch {}
        }
      }, 'auto-compaction capacity domain')
      const table = domain.table(CAPACITY_DOMAIN.table)
      let loaded = 0
      for (const [key, record] of table.entries()) {
        const tokens = record?.tokens
        if (positiveInteger(tokens)) {
          rememberBounded(state.learnedCeiling, key, tokens)
          loaded += 1
        }
      }
      state.capacityStore = table
      state.capacityLoaded = true
      if (loaded > 0) this.ctx.logger.info('auto-compaction: loaded ' + loaded + ' learned capacity record(s) from storage')
      return table
    } catch (error) {
      state.capacityLoaded = true
      const message = error instanceof Error ? error.message : String(error)
      this.#warnOnce('storage', 'capacity persistence unavailable (' + message + '); learned capacity stays in memory only')
      return undefined
    }
  }

  /** 把一条学习结果写到存储；失败只警告一次，不影响判定。 */
  async #persistLearnedCapacity(key, tokens) {
    const table = await this.#capacityStore()
    if (table === undefined) return
    try {
      await table.put(key, { tokens, at: Date.now() })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#warnOnce('storage-write', 'capacity persistence write failed (' + message + '); keeping it in memory only')
    }
  }

  /** 记录一次已完成的压缩：命令自诊断要用（计数 + 最近一次）。 */
  #recordCompaction(agent, phase, before, after, result) {
    const sessionId = agent.session.id
    const previous = this.#codex.compactions.get(sessionId)
    rememberBounded(this.#codex.compactions, sessionId, {
      count: (previous?.count ?? 0) + 1,
      last: { at: Date.now(), phase, before, after, shadowed: result?.shadowedSeqs?.length ?? 0 },
    })
  }

  /**
   * PostTurn 相位：回合还没关闭时压缩，因此可以用 current-turn 事务保住逐字尾。
   * 这里 await 是刻意的——选区事务要求整条表层稳定，回合结束前压缩也是 Codex 的
   * 相位选择；失败只记日志，绝不影响已经产生的回合结果。
   */
  #registerPostTurnCompaction() {
    this.ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      const state = this.#codex
      if (state.running.has(agent) || signal?.aborted) return
      state.running.add(agent)
      try {
        const spec = await this.#resolveSpec(agent, signal)
        if (spec === null) return
        const measurement = this.ctx.tokenMeter.measure(agent.session)
        const thresholdTokens = Math.floor(spec.window * spec.usableRatio * state.postTurnPercent / 100)
        const pressure = this.#pressureTokens(agent, measurement)
        if (pressure < thresholdTokens) {
          state.attempts.delete(agent.session.id)
          return
        }
        const sessionId = agent.session.id
        if ((state.attempts.get(sessionId) ?? 0) >= state.postTurnMaxAttempts) return
        if (Date.now() - (state.lastRunAt.get(sessionId) ?? 0) < state.postTurnCooldownMs) return
        if (hasActiveCompactionLock(agent.session)) return
        rememberBounded(state.attempts, sessionId, (state.attempts.get(sessionId) ?? 0) + 1)
        rememberBounded(state.lastRunAt, sessionId, Date.now())
        try {
          const range = selectRetainedRange(agent.session, measurement, spec.retainTokens)
          if (range === null) return
          const before = pressure
          const result = await this.compactRegion(range.start, range.end, agent, signal)
          const after = this.#pressureTokens(agent, this.ctx.tokenMeter.measure(agent.session))
          this.#recordCompaction(agent, 'post-turn', before, after, result)
          this.ctx.logger.info(
            'auto-compaction post-turn (' + spec.source + ' window ' + spec.window + ', trigger '
            + (spec.triggerRatio * 100).toFixed(0) + '% of usable = ' + thresholdTokens + '): kept ' + spec.retainTokens
            + ' tokens, shadowed ' + result.shadowedSeqs.length + ' node(s), ' + before + ' -> ' + after + ' tokens',
          )
        } catch (error) {
          if (error instanceof ManualCompactionError) return
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger.warn('auto-compaction post-turn failed: ' + message + '; the completed turn is preserved')
        }
      } finally {
        state.running.delete(agent)
      }
    })
  }

  /**
   * provider 确认溢出时，把"刚刚被拒的那个规模"记成这条路由的容量上限：真实容量 ≤ 该值，
   * 取一点余量当作后续的有效窗口。声明窗口是乐观值时（本项目 codemaker 全写 1M），
   * 这是唯一有实证的依据，也让 98% 这种贴近边界的比例真的可达。
   * 只收紧、不放松；同一路由只保留最小的一次观测。
   */
  #learnFromOverflow(agent) {
    if (!this.#codex.learnFromOverflow) return
    const route = agent.session.requestContext?.()
    const provider = route?.provider ?? agent.options?.provider
    const model = route?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) return
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const failedAt = Math.max(measurement.totalTokens, this.#pressureTokens(agent, measurement))
    if (!positiveInteger(failedAt)) return
    const learned = Math.max(1, Math.floor(failedAt * this.#codex.learnedMargin))
    const key = provider + '/' + model
    const previous = this.#codex.learnedCeiling.get(key)
    if (previous !== undefined && previous <= learned) return
    rememberBounded(this.#codex.learnedCeiling, key, learned)
    void this.#persistLearnedCapacity(key, learned)
    this.ctx.logger.info(
      'auto-compaction learned capacity for ' + key + ': rejected at ' + failedAt
      + ' tokens -> treating the window as ' + learned + ' (was ' + (previous ?? 'unknown') + ')',
    )
  }

  /** 解析当前路由的 Codex spec；返回 null 表示交回 basic。 */
  async #resolveSpec(agent, signal) {
    // 冷启动时先把持久化的学习结果载入内存（只做一次；存储缺席时是无操作的 await）。
    await this.#capacityStore()
    const state = this.#codex
    const route = agent.session.requestContext?.()
    const provider = route?.provider ?? agent.options?.provider
    const model = route?.model ?? agent.options?.model
    if (provider === undefined || model === undefined) return null
    const key = provider + '/' + model
    const override = state.policyWindows.get(key)
    // 「按当前模型窗口 × 比例」是默认口径：只要配了比例/窗口/阈值中的任意一项，本插件就接管压力路径。
    if (override === undefined
      && state.contextWindow === undefined && state.compactTokenLimit === undefined
      && state.triggerRatio === undefined && state.usableRatio === undefined && state.windowRatio === undefined) {
      return null
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    const spec = computeCodexSpec({
      declaredWindow: info?.context?.contextWindow,
      overrideWindow: override?.contextWindow ?? state.contextWindow,
      windowRatio: override?.windowRatio ?? state.windowRatio,
      triggerRatio: override?.triggerRatio ?? state.triggerRatio,
      usableRatio: state.usableRatio,
      compactTokenLimit: override?.compactTokenLimit ?? state.compactTokenLimit,
      reservedOutputTokens: positiveInteger(agent.options?.maxTokens) ? agent.options.maxTokens : info?.defaultMaxTokens,
      retainTokens: this.#retainTokensFor(key),
      retainRatio: this.config.retainRatio,
      learnedWindow: this.#codex.learnFromOverflow ? this.#codex.learnedCeiling.get(key) : undefined,
    })
    if (spec === null) {
      this.#warnOnce(key, 'no usable context window for ' + key + '; the adapter declares none')
      return null
    }
    return { ...spec, key }
  }

  #retainTokensFor(key) {
    if (positiveInteger(this.config.retainTokens)) return this.config.retainTokens
    const policy = this.config.modelPolicies.find((entry) => entry.provider + '/' + entry.model === key)
    return positiveInteger(policy?.retainTokens) ? policy.retainTokens : undefined
  }

  #warnOnce(key, message) {
    if (this.#codex.warnedTargets.has(key)) return
    this.#codex.warnedTargets.add(key)
    this.ctx.logger.warn('auto-compaction (' + key + '): ' + message)
  }
}

function normalizeInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error('AutoCompactionConfig: ' + name + ' must be an integer in ' + min + '..' + max)
  }
  return value
}

export default AutoCompactionEngine
