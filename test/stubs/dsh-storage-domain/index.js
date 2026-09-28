/** storage-domain 的最小替身：保留 defineDomain 的字段校验语义与 domainTable 形状。 */
// 与真实实现一致：小写字母开头，仅小写字母/数字/下划线（连字符不合法）。
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

export function domainTable(schema) {
  return { valueSchema: schema }
}

export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error('domain name must match ' + UNIT_NAME_RE)
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error('domain version must be a non-negative integer')
  if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') {
    throw new Error("domain layout must be 'single' or 'per-record'")
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) throw new Error('table name must match ' + UNIT_NAME_RE)
  }
  return spec
}
