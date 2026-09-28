/**
 * schemastery 的最小替身：只实现本插件的 Config 用到的那点子集。
 * 目的是让 `node test/run.mjs` 在没有 DSH 安装的机器上（CI）也能跑；
 * 它**不校验**真实 schemastery 的语义——runner 找到真包时会优先用真包。
 * `i18n` 只记录 messages，便于测试断言"字段说明确实挂上了"。
 */
const chain = (base) => {
  const schema = (value) => { if (value === undefined) return schema.meta?.default; return value }
  schema.meta = base
  schema.step = () => schema
  schema.min = () => schema
  schema.max = () => schema
  schema.default = (value) => { schema.meta.default = value; return schema }
  schema.optional = () => schema
  schema.description = () => schema
  schema.i18n = (messages) => { schema.meta.i18n = messages; return schema }
  return schema
}
const z = {
  number: () => chain({ type: 'number' }),
  string: () => chain({ type: 'string' }),
  boolean: () => chain({ type: 'boolean' }),
  any: () => chain({}),
  array: (inner) => chain({ type: 'array', inner }),
  object: (shape) => {
    const schema = (value) => value ?? {}
    schema.meta = { type: 'object', shape }
    schema.description = () => schema
    schema.i18n = (messages) => { schema.meta.i18n = messages; return schema }
    return schema
  },
  union: (list) => chain({ type: 'union', list }),
}
export default z
export { z }
