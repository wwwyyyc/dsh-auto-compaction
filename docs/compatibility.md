# 兼容性矩阵 / Compatibility matrix

本文件记录"在不同组合下会发生什么"。每一条都在开发中用测试或源码核对过。 / Every row was verified against `test/` or DSH source.

## 运行环境 / Runtime

| 组合 | 行为 | 依据 |
|---|---|---|
| 有 `commands` 服务（Web/桌面 GUI） | 注册自诊断命令（默认 `/auto-compaction`） | 测试 I1–I8 |
| 无 `commands` 服务（headless / ACP） | 不注册命令，压缩功能不受影响 | 测试 I10 |
| `diagnosticsCommandName: ''` | 显式关闭命令 | 测试 I9 |
| 有 `sessionProjections`（token-meter 的 `contextPressure`） | 判定分子 = GUI「上下文已用」环的同一个数 | 测试 G1/G2/G6 |
| 无投影，或投影缺字段 | 自动回退 tokenMeter 回放估算 | 测试 G3/G4 |
| `pressureSource: meter` | 强制回退到 basic 的口径 | 测试 G5 |
| 有 `toolResultPruner` | 越过阈值后先修剪超大工具输出，再决定是否摘要 | 测试 C7 |
| 无修剪器 | 直接进入摘要路径 | 代码路径 |

## 组合与冲突 / Composition conflicts

| 组合 | 行为 | 依据 |
|---|---|---|
| 同一 scope 同时挂 `dsh-compaction-basic` 与本插件 | **Cordis 直接拒绝**：`service "compaction" has been registered at <…>`。一个 scope 只能有一个压缩后端，本插件的 bundle patch 是"替换"而非"并存" | cordis `provide()` 实现 |
| 会话用的是 `minimal` preset | 该 preset 里没有 compaction 组，因此本插件不生效；要生效需把行插进该 preset | 随附 `presets/minimal.patch.yml` 全文 0 处 compaction |
| 会话用本插件的新 preset | 压缩后端 = 本插件；`/compact` 仍由 `dsh-command-compact` 调用同一引擎 | patch 分层仿真 |
| 适配器未声明 `contextWindow` 且未配置覆盖 | 不接管压力路径（交回 basic 默认策略），自诊断命令给出修法 | 测试 I12 |
| 手动装了别的第三方压缩后端 | 同理：Cordis 会拒绝第二个 `compaction` 服务 | 同上 |

## 会话生命周期 / Session lifecycle

| 场景 | 行为 | 依据 |
|---|---|---|
| 会话中途切换模型 | 每次判定都按当前 `requestContext()` 的路由重新解析窗口/阈值 | 测试 C6、I2 |
| 子 agent / fork | preset 继承；per-session 状态按 `session.id` 记录且有界（≤64 条，淘汰最久未写） | 测试 H7 |
| 长跑宿主 | per-session 状态不会无限增长 | 测试 H7 |
| 压缩在途时的又一次触发 | 前置检查（未配对的 `compaction/start`）直接跳过，不修剪、不动表层 | 测试 E1–E6 |
| provider 报上下文溢出 | 记录被拒规模当容量上限（只收紧），再交给 basic 的溢出恢复压缩并重试 | 测试 H4–H6 |
| 回合结束 | `agent/turn-stopping` 相位按保留预算压缩；失败只记日志，不影响已完成的回合 | 测试 D1–D10 |
| 有 `storageDomain`（DSH 标准组合默认有） | 学到的容量写入 `<storage root>/auto_compaction.json`（single 布局），冷启动载入并夹住有效窗口 | 测试 K1/K2 |
| 无 `storageDomain` 或没有 zod | 退化为纯内存学习，判定照常，不报错 | 测试 K3 |
| `learnFromOverflow: false` | 完全不开存储（`open` 不会被调用） | 测试 K4 |
| 存储打开/写入失败 | 警告一次后继续用内存；压缩结果不受影响 | 测试 K5 |

## 已声明的限制 / Known limits

1. **保留口径按表层节点计价**，不是 Codex 的"只保留 user 消息"；后者在路线图 P1。
2. **没有远端压缩**：DSH 的 provider 能力位里没有 `RemoteCompactionSupport`，无落点。
3. **没有压缩窗口代数（window id/number）**：会话日志没有窗口身份；本插件用"学习到的容量 + 来源标注"覆盖它最有用的部分。
4. **学习结果目前只在内存**（进程重启即忘）；持久化在 P1。
5. **98% 这类贴窗口的比例**需要准确的分母；分母不可信时靠 `learnFromOverflow` 修正，或先给 `windowRatio`。
6. **摘要请求本身也可能撞上限**：basic 会丢弃最旧项后重试，代价是额外请求。
