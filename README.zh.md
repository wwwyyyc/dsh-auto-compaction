# dsh-auto-compaction

按**当前模型上下文的比例**触发的 DSH 自动压缩后端：保留逐字尾、带回合末(PostTurn)相位，并能从真实溢出里学习容量。

它在 `@deepseek-ai/dsh-compaction-basic` 之上只替换**触发策略**并补一个相位：durable 事务（标记对、单次表层替换、摘要、持久化检查点）原样复用。

## 快速上手

1. Creator 模式 → `plugin_manager` → `install_bundle`，target 填本目录绝对路径。
2. 新会话选预设 **自动压缩（按比例触发）**，或把 profile patch 里 `agent-preset-registry.selectedDefault` 改成 `auto-compaction`。
3. 在输入框敲 **`/auto-compaction`** 看自诊断：当前路由、有效窗口（含是否来自学习）、阈值、当前分子与占比、本会话已压缩记录。

```
自动压缩自诊断 · codemaker/deepseek-flash
窗口  声明 1,000,000 × 系数 → 有效 1,000,000 · 来源 declared
阈值  98% → 980,000 tokens（硬上限 98%；预留已计入）
当前  341,361（projection/pressureTokens）= 阈值的 35% · 还差 638,639
保留  20,000 tokens 逐字尾 · 摘要输出上限 32,768
相位  回合末 100% of 可用窗口 · 冷却 15s · 上限 3 次/会话 · 溢出重试 1
本会话  已压 2 次 · 最近 08:38:51（post-turn）估算释放 ~146,120 · shadowed 7 节点
```

## 触发口径

```
有效窗口 W_eff = contextWindow ?? 声明窗口 × windowRatio   （再被"学到的容量"夹住）
阈值 = max(1, min(W_eff × triggerRatio, W_eff × usableRatio, W_eff − 输出预留))
保留 = retainTokens ?? (W_eff − 输出预留) × retainRatio
```

判定分子默认与 GUI 的「上下文已用」环**同源**（`contextPressure` 投影：`projectedTokens ?? pressureTokens`），
所以"环上到 98% 就压"成立；投影缺席自动回退 tokenMeter（`pressureSource: meter` 可强制回退）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `policyPreset` | — | 策略组合：`conservative`(0.9/0.95/关闭回合末) / `balanced`(0.95/0.95/80%) / `aggressive`(0.98/0.98/100%)，只填未显式给出的字段 |
| `triggerRatio` | 0.9 | 触发比例，0.98 = 98% |
| `usableRatio` | 0.95 | 硬上限；要 98% 触发必须同步放到 0.98 |
| `windowRatio` | 1 | 声明窗口的信任系数（1M 声明 / 200k 实际 → 0.2） |
| `contextWindow` | — | 有效窗口绝对值覆盖（优先级最高） |
| `compactTokenLimit` | — | 显式阈值 token 数 |
| `learnFromOverflow` | true | 从 provider 溢出反推容量上限（只收紧） |
| `pressureSource` | projection | `projection`（与 GUI 环同源）/ `meter` |
| `diagnosticsCommandName` | auto-compaction | 自诊断命令名，空串关闭 |
| `diagnosticsLanguage` | both | 自诊断输出语言：`zh` / `en` / `both`（默认中英双行） |
| `postTurnThresholdPercent` | 0 | 回合末相位阈值（占可用窗口百分比），100 = 与压力触发同点 |
| `retainTokens` / `retainRatio` / `maxTokens` / `modelPolicies` / … | 同 basic | 逐模型可用 `modelPolicies` 覆盖窗口/比例/保留 |

## 测试

```
node test/run.mjs [path/to/@deepseek-ai/schemastery]
```

85 条断言覆盖：阈值/保留纯函数（比例、输出预留、学习容量）、选区算法、压力路径（修剪器、逐模型覆盖、重试、
未知 key 拒绝、压缩锁前置检查、分子来源）、PostTurn 相位（阈值、冷却、次数上限、busy、失败、取消）、
有界 per-session 状态、自诊断命令（注册/渲染/关闭/降级）、策略预设与字段说明。
runner 自带 seam 替身（含 schemastery），**无需 DSH 安装即可跑**（CI 见 `.github/workflows/test.yml`）。

另外有一套**真机集成测试**：`node test/run-integration.mjs <DSH 安装目录>`（或设 `DSH_APP_DIR`；未指定时以退出码 2 跳过）。它用 DSH **真实发布**的
`cordis` / `schemastery` / `dsh-compaction` / `dsh-compaction-basic` / `dsh-commands` / `zod` /
`dsh-storage-domain`（在 `app.asar` 内，内部经 Electron-as-node 加载）来构造引擎、注册命令、
走真实的选区与锁函数、并用真实 `defineDomain` 校验持久化 spec；只有"服务"是探针。当前 17 条断言全绿。

## 发布形态（市场要求）

DSH 市场里的"插件"就是一个 **npm 包（或 GitHub 仓库）**，没有专用格式：市场目录是一张索引，
安装动作是 `dsh plugin --profile <profile> add <包名 或 github:owner/repo>`。包内必须有的是
`package.json` 的 `dsh.bundle.patch`、它指向的 `cordis.patch.yml`、以及 ESM 入口；
其余（`icon.svg`、`peerDependencies`、类型声明、README、LICENSE）是生态惯例。
本包发布时只带 `files` 白名单里的内容（icon.svg / lib / docs / cordis.patch.yml / README ×2 /
CHANGELOG / LICENSE），测试与 CI 留在仓库里，不进安装面。

## 文档

- [兼容性矩阵](docs/compatibility.md)：各种组合下的行为与已声明的限制。
- [CHANGELOG](CHANGELOG.md)

## 路线图

**已就绪**：有效窗口覆盖、比例触发（含 98%）、GUI 同源分子、回合末相位、
**溢出自学习 + 跨重启持久化**（`~/.dsh/storages/auto_compaction.json`）、有界状态、自诊断命令、
策略预设、字段说明（zh/en）、零依赖测试 + CI。

**P1 剩余**：`retainMode: user-messages`（只保留近期 user 消息）、`summarizationPrompt` 定制 +
摘要输入自适应裁剪、配置组合的 GUI 一键切换。

**P2**：接近阈值时的预算提醒注入、非阻塞回合末压缩、压缩指标接入 session telemetry、
为其他插件提供 pre/post 压缩 waterfall。
