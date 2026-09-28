/** zod 的最小替身：只实现本项目声明持久化记录 schema 用到的那几个方法。 */
const chain = () => {
  const api = {
    optional: () => api,
    int: () => api,
    positive: () => api,
    nonnegative: () => api,
    min: () => api,
    safeParse: (value) => ({ success: true, data: value }),
  }
  return api
}
const z = {
  object: (shape) => ({ ...chain(), shape, safeParse: (value) => ({ success: true, data: value }) }),
  number: () => chain(),
  string: () => chain(),
  boolean: () => chain(),
}
export default z
export { z }
