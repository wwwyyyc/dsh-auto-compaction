/**
 * dsh-auto-compaction — 按当前模型上下文比例触发的 DSH 压缩后端（策略取自 Codex）。
 *
 * 本文件声明插件的公开面：默认导出的引擎类、四个纯逻辑辅助函数，以及配置形状。
 * 只依赖 `BasicCompactionEngine` 的类身份，其余会话/计量类型用窄结构接口描述，
 * 因此不额外引入对 DSH 会话包的耦合。
 */
import type { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

/** token-meter 测量结果里本插件用得到的部分。 */
export interface SurfaceMeasurement {
  /** 请求 + 响应压力估算。 */
  readonly totalTokens: number
  /** 按表层顺序排列的计价节点。 */
  readonly nodes: readonly { readonly seq: number; readonly tokens: number }[]
}

/** 会话里本插件用得到的部分。 */
export interface SurfaceSession {
  /** 当前日志的最大 seq 之后的位置（用于反向扫描压缩锁）。 */
  readonly seq: number
  readonly surface: { readonly nodes: readonly number[] }
  /** 读取某个 seq 的日志事件。 */
  eventAt(seq: number): { readonly type: string; readonly seq: number } | undefined
  /** 最新一次已路由请求的上下文（提供方/模型/窗口）。 */
  requestContext?(): { readonly provider: string; readonly model: string; readonly contextWindow?: number } | undefined
}

/** 一条路由的解析结果：有效窗口、阈值与逐字尾预算。 */
export interface CodexSpec {
  readonly window: number
  readonly thresholdTokens: number
  readonly retainTokens: number
  readonly triggerRatio: number
  readonly usableRatio: number
  /** 窗口来自绝对覆盖（override）、适配器声明（declared）还是从溢出学到的上限（learned）。 */
  readonly source: 'override' | 'declared' | 'learned'
}

/** 计算阈值/保留预算的输入。 */
export interface CodexSpecInput {
  /** 适配器声明的窗口。 */
  declaredWindow?: number
  /** 有效窗口的绝对覆盖，优先级最高。 */
  overrideWindow?: number
  /** 对声明窗口的信任系数（默认 1）。 */
  windowRatio?: number
  /** 触发比例，例如 0.98。 */
  triggerRatio?: number
  /** 硬上限比例（默认 0.95）。 */
  usableRatio?: number
  /** 显式阈值。 */
  compactTokenLimit?: number
  /** 该路由一次请求预留的输出 token（会被夹到窗口的一半）。 */
  reservedOutputTokens?: number
  /** 学习到的容量上限（只收紧）。 */
  learnedWindow?: number
  /** 显式逐字尾预算。 */
  retainTokens?: number
  /** 未给 retainTokens 时按可用容量的比例（默认 0.16）。 */
  retainRatio?: number
}

/**
 * 把「声明窗口 / 覆盖窗口 + 比例口径」解析成阈值与逐字尾预算。
 * @returns 解析结果；窗口不可用时为 null。
 */
export function computeCodexSpec(input: CodexSpecInput): CodexSpec | null

/**
 * 选出「保留近期逐字尾」的可压区间（首个 system/message 不入列、工具调用/结果不成对不切）。
 * @returns 包含首尾 seq 的区间；没有可压区间时为 null。
 */
export function selectRetainedRange(
  session: SurfaceSession,
  measurement: SurfaceMeasurement,
  retainTokens: number,
): { readonly start: number; readonly end: number } | null

/**
 * 压缩锁是否在途（与随附后端的 assertNoActiveCompaction 同构）。
 * @returns true 表示当前会话已有未配对的 `compaction/start`。
 */
export function hasActiveCompactionLock(session: Pick<SurfaceSession, 'seq' | 'eventAt'>): boolean

/**
 * 有界记忆：宿主长跑时限制 per-session 状态（淘汰最久未写的键）。
 * @returns 传入的同一个 Map，便于链式使用。
 */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit?: number): Map<K, V>

/** 开箱可选的策略组合（只填未显式给出的字段）。 */
export const POLICY_PRESETS: Readonly<Record<'conservative' | 'balanced' | 'aggressive', {
  readonly triggerRatio: number
  readonly usableRatio: number
  readonly postTurnThresholdPercent: number
}>>

/** 顶层配置字段的中英文说明。 */
export const CONFIG_DESCRIPTIONS: Readonly<{ zh: Readonly<Record<string, string>>; en: Readonly<Record<string, string>> }>

/** 把 `policyPreset` 填进未显式给出的字段；未知预设名抛错。 */
export function applyPolicyPreset<T extends Record<string, unknown>>(raw: T): T

/** 逐模型的覆盖项。 */
export interface ModelPolicy {
  provider: string
  model: string
  contextWindow?: number
  compactTokenLimit?: number
  windowRatio?: number
  triggerRatio?: number
  retainTokens?: number
  retainRatio?: number
  summarizationProvider?: string
  summarizationModel?: string
  maxTokens?: number
  compactionRetries?: number
  maxOverflowRetries?: number
}

/** 插件配置（随附后端字段 + 本插件扩展）。 */
export interface AutoCompactionConfig {
  /** 随附后端的字段：原样透传。 */
  thresholdRatio?: number
  headroomTokens?: number
  /** 逐字尾预算（本插件接管压力路径时按有效窗口使用）。 */
  retainTokens?: number
  retainRatio?: number
  summarizationProvider?: string
  summarizationModel?: string
  maxTokens?: number
  compactionRetries?: number
  maxOverflowRetries?: number
  auto?: boolean
  modelPolicies?: ModelPolicy[]
  /** 策略组合预设：conservative / balanced / aggressive。 */
  policyPreset?: 'conservative' | 'balanced' | 'aggressive'
  /** 有效窗口绝对值覆盖。 */
  contextWindow?: number
  /** 显式阈值 token 数。 */
  compactTokenLimit?: number
  /** 对声明窗口的信任系数。 */
  windowRatio?: number
  /** 触发比例（0.98 = 98%）。 */
  triggerRatio?: number
  /** 硬上限比例。 */
  usableRatio?: number
  /** 判定分子口径。 */
  pressureSource?: 'projection' | 'meter'
  /** 从 provider 溢出反推容量上限。 */
  learnFromOverflow?: boolean
  /** 自诊断命令名；空字符串关闭。 */
  diagnosticsCommandName?: string
  /** 自诊断输出语言：zh / en / both（默认 both）。 */
  diagnosticsLanguage?: 'zh' | 'en' | 'both'
  /** 回合末相位阈值（占可用窗口百分比；0 关闭）。 */
  postTurnThresholdPercent?: number
  postTurnCooldownMs?: number
  postTurnMaxAttemptsPerSession?: number
}

/** 自动压缩引擎：随附后端的 durable 事务 + 比例触发 + 回合末相位 + 溢出自学习。 */
export declare class AutoCompactionEngine extends BasicCompactionEngine {
  constructor(ctx: unknown, config?: AutoCompactionConfig)
  static Config: unknown
  static inject: readonly string[]
}

export default AutoCompactionEngine
