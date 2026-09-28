/** 测试替身：只保留本插件真正用到的两个导出。 */
export class ManualCompactionError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.code = code
    this.name = 'ManualCompactionError'
  }
}
/** 选区平衡判定：单测里恒为平衡，便于断言选区区间本身。 */
export function toolPairingBalancedBefore() {
  return true
}
