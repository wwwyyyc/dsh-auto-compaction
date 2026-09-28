/**
 * 测试替身：镜像真实后端里本插件依赖的那些合同 ——
 * 未知 key fail-fast（含 modelPolicies 内）、auto 门控、compactRegion 事务入口。
 */
const BASIC_KEYS = new Set(['thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens', 'summarizationProvider', 'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto'])
const POLICY_KEYS = new Set(['provider', 'model', 'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens', 'summarizationProvider', 'summarizationModel', 'maxTokens', 'compactionRetries', 'maxOverflowRetries'])

export class BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  constructor(ctx, config = {}) {
    for (const key of Object.keys(config)) if (!BASIC_KEYS.has(key)) throw new Error('BasicCompactionConfig: unknown key "' + key + '"')
    for (const policy of config.modelPolicies ?? []) {
      for (const key of Object.keys(policy)) if (!POLICY_KEYS.has(key)) throw new Error('BasicCompactionConfig: unknown modelPolicies key "' + key + '"')
    }
    this.ctx = ctx
    this.config = {
      auto: config.auto === undefined ? true : config.auto,
      compactionRetries: config.compactionRetries ?? 1,
      retainRatio: config.retainRatio,
      retainTokens: config.retainTokens,
      modelPolicies: config.modelPolicies ?? [],
    }
    this.calls = { compactRegion: [], superCompactIfNeeded: 0, superCompactNow: 0 }
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  _registerAutomaticCompaction() { this.autoRegistered = true }
  async compactIfNeeded() { this.calls.superCompactIfNeeded += 1; return null }
  async compactNow() { this.calls.superCompactNow += 1; return null }
  async compactRegion(start, end) {
    this.calls.compactRegion.push({ start, end })
    if (this.onCompactRegion) await this.onCompactRegion()
    return { shadowedSeqs: [start, end] }
  }
}
