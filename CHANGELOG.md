# Changelog

## 0.8.0
- **修复（真机测试发现）**：storage 领域名必须是 `auto_compaction`——真实 `defineDomain` 只接受
  `/^[a-z][a-z0-9_]*$/`，此前的 `auto-compaction` 会被拒绝，导致容量持久化静默退化为纯内存。
  测试替身的 `UNIT_NAME_RE` 已对齐真实规则，避免再猜宽。
- 新增**真机集成测试** `test/run-integration.mjs`（17 条断言）：用 DSH 真实发布的包加载插件，
  覆盖真实 cordis 构造/服务注册、真实 schemastery 校验、真实选区与锁函数、真实 zod +
  defineDomain 的持久化 spec 校验；CI 在无本地 DSH 安装时自动跳过（退出码 2）。
- 补齐市场惯例元数据：`icon.svg` + `icon` 字段、`peerDependencies`（`dsh-commands` 与
  `dsh-storage-domain` 标 `optional: true`；市场兼容性检查读的就是这里）、`lib/index.d.ts` 类型声明。
- 自诊断命令支持语言选择：`diagnosticsLanguage: zh | en | both`（默认 `both`，中英各一行）。
- 补上架信息：`author` / `repository` / `homepage` / `bugs`（指向 GitHub 账号 wwwyyyc 的同名仓库）。
- 测试 90 → 97 条断言（L1–L7 语言分支与非法值）。

## 0.7.0
- **学习到的容量可持久化**：通过 DSH 的 storage-domain（json 后端，single 布局）把"某条路由被拒的规模"
  写到 `~/.dsh/storages/auto_compaction.json`，冷启动时载入并按它夹住有效窗口——跨重启生效，
  不再是一次溢出就"忘掉"。存储缺席/打开失败/写入失败都只警告一次并退化为纯内存，压缩判定不受影响。
- 显式声明 `zod` 依赖（storage-domain 的记录 schema 用 zod），并保持动态导入：
  没有 zod 的部署只会失去持久化，不会加载失败。
- 测试 85 → 90 条断言（K1–K5：写入、跨重启载入并生效、无存储退化、关闭学习不碰存储、存不开时降级）。

## 0.6.0
- 新增 `/auto-compaction` 自诊断命令：路由、有效窗口（含学习来源）、阈值、判定分子与占比、
  保留预算、相位设置、本会话压缩记录；命令服务缺席时自动跳过注册。
- 新增 `policyPreset`：`conservative` / `balanced` / `aggressive`，只填未显式给出的字段。
- 配置字段补齐 zh/en 说明（`CONFIG_DESCRIPTIONS` + `.i18n()`），GUI 设置表单可直接渲染。
- 新增 [兼容性矩阵](docs/compatibility.md) 与 CI（`.github/workflows/test.yml`，零依赖跑测试）。
- 测试 63 → 85 条断言（命令、预设、说明表、有界状态）。

## 0.5.0
- 98% 触发：`usableRatio` 可同步放开（默认 0.95 会把 0.98 裁回 0.95 的坑已写进注释与文档）。
- `learnFromOverflow`：provider 报溢出时把被拒规模记成该路由的容量上限（只收紧），
  声明窗口乐观时这是唯一有实证的依据。
- per-session 状态改为有界记忆（`rememberBounded`，宿主长跑不泄漏）。
- 测试零外部依赖：内置 schemastery 替身，`node test/run.mjs` 在任何机器上可跑。

## 0.4.0
- 判定分子与 GUI「上下文已用」环同源（`pressureSource: projection`，可回退/强制 meter）。

## 0.3.0
- 比例触发：`triggerRatio` / `usableRatio` / `windowRatio`，跟随当前路由模型窗口，可逐模型覆盖。

## 0.2.0
- 改名 `dsh-auto-compaction`；新增有效窗口覆盖（`contextWindow` 与信任系数）。
- PostTurn 相位改为 `agent/turn-stopping` + `compactRegion`，保住逐字尾（不再用只留最后一条的 `compactNow`）。
- 压缩锁前置检查；输出预留夹到窗口一半。

## 0.1.0
- 首个版本：继承 `dsh-compaction-basic`，新增回合末压缩相位。
