# dsh-auto-compaction

Automatic context compaction for [DeepSeek Harness](https://www.deepseek.com/harness/) driven by
**a ratio of the current model's context window**: it keeps a verbatim tail, adds the turn-end
(PostTurn) phase the bundled backend lacks, and learns the real capacity from provider overflows.

It extends `@deepseek-ai/dsh-compaction-basic`: the durable compaction transaction (marker pair,
single surface replacement, summarization, persisted checkpoint) is reused unchanged — this plugin
replaces the trigger policy and adds one phase.

## Quick start

1. Creator mode → `plugin_manager` → `install_bundle` with this directory as `target`.
2. Pick the **auto-compaction** preset for a session, or point
   `agent-preset-registry.selectedDefault` at `auto-compaction` in the profile patch.
3. Run **`/auto-compaction`** in the composer to see a live diagnosis:

```
auto-compaction · codemaker/deepseek-flash
window  declared 1,000,000 × factor → effective 1,000,000 · source declared
trigger 98% → 980,000 tokens (ceiling 98%; output reservation included)
now    341,361 (projection/pressureTokens) = 35% of the threshold · 638,639 to go
retain 20,000 verbatim tokens · summary cap 32,768
phases turn-end 100% of usable · cooldown 15s · cap 3/session · overflow retries 1
session 2 compactions · last 08:38:51 (post-turn) released ~146,120 · 7 nodes shadowed
```

## Trigger semantics

```
effective window W_eff = contextWindow ?? declared × windowRatio   (then capped by learned capacity)
threshold = max(1, min(W_eff × triggerRatio, W_eff × usableRatio, W_eff − reserved output))
retained   = retainTokens ?? (W_eff − reserved output) × retainRatio
```

By default the numerator is **the same number the GUI "context used" ring shows**
(`contextPressure` projection: `projectedTokens ?? pressureTokens`), so "compact at 98%" means the ring's
98%. When the projection is missing the plugin falls back to the token-meter replay estimate;
`pressureSource: meter` forces that path.

| field | default | meaning |
|---|---|---|
| `policyPreset` | — | `conservative` (0.9 / 0.95 / turn-end off) · `balanced` (0.95 / 0.95 / 80%) · `aggressive` (0.98 / 0.98 / 100%); fills only unset fields |
| `triggerRatio` | 0.9 | trigger fraction; 0.98 = 98% |
| `usableRatio` | 0.95 | hard ceiling — raise it together with `triggerRatio` (e.g. 0.98/0.98), otherwise 0.98 is clipped back to 0.95 |
| `windowRatio` | 1 | trust factor for the declared window (1M declared / 200k real → 0.2) |
| `contextWindow` | — | absolute effective window (highest priority) |
| `compactTokenLimit` | — | explicit threshold in tokens |
| `learnFromOverflow` | true | on a provider overflow, remember the rejected size and cap the window with it (tightens only) |
| `pressureSource` | projection | `projection` (GUI-consistent) or `meter` |
| `diagnosticsCommandName` | auto-compaction | diagnostics command; empty string disables it |
| `diagnosticsLanguage` | both | diagnostics language: `zh` / `en` / `both` (default prints both lines) |
| `postTurnThresholdPercent` | 0 | turn-end threshold as a percent of the usable window (100 = same point as the pressure trigger) |
| `retainTokens` / `retainRatio` / `maxTokens` / `modelPolicies` / … | as in basic | `modelPolicies` overrides window/ratio/retention per model |

## Tests

```
node test/run.mjs [path/to/@deepseek-ai/schemastery]
```

85 assertions cover the pure threshold/retention math (ratios, output reservation, learned
capacity), range selection, the pressure path (pruner, per-model overrides, retries, unknown-key
rejection, compaction-lock pre-check, numerator source), the PostTurn phase (threshold, cooldown,
attempt cap, busy/failure handling, cancellation), bounded per-session state, the diagnostics command
(registration, rendering, disabling, degradation) and the policy presets plus field descriptions.
The runner ships seam stubs (including `schemastery`), so it runs **without a DSH install**
(see `.github/workflows/test.yml`).

A second, **real-runtime integration suite** runs with `node test/run-integration.mjs <DSH app dir>`
(or `DSH_APP_DIR=`; it exits with code 2 when the directory is not given):
it loads this plugin against the DSH packages as actually shipped (`cordis`, `schemastery`,
`dsh-compaction`, `dsh-compaction-basic`, `dsh-commands`, `zod`, `dsh-storage-domain` — read from
`app.asar` through Electron-as-node) and only the *services* are probes. 17 assertions, all green.

## Publishing shape

A DSH market plugin is just an **npm package (or a GitHub repo)** — there is no bespoke format:
the market keeps an index and installs with `dsh plugin --profile <profile> add <name or github:owner/repo>`.
A package must ship `package.json` with `dsh.bundle.patch`, the `cordis.patch.yml` it points at, and an ESM
entry; `icon.svg`, `peerDependencies`, type declarations, README and LICENSE are ecosystem conventions.
This package publishes only what its `files` whitelist lists (icon.svg / lib / docs / cordis.patch.yml /
both READMEs / CHANGELOG / LICENSE); tests and CI stay in the repository.

## Docs

- [Compatibility matrix](docs/compatibility.md) — behaviour per composition, and declared limits.
- [CHANGELOG](CHANGELOG.md)

## Roadmap

**Shipped**: effective-window override, ratio triggering (up to 98%), GUI-consistent numerator,
PostTurn phase, capacity learned from overflows **and persisted across restarts**
(`~/.dsh/storages/auto_compaction.json`), bounded per-session state, diagnostics command,
policy presets, zh/en field descriptions, dependency-free tests + CI.

**P1 remaining**: `retainMode: user-messages`, configurable summarization prompt with adaptive input
trimming, GUI one-click preset switching.

**P2**: token-budget reminder injection near the threshold, non-blocking turn-end compaction,
compaction metrics in session telemetry, pre/post compaction waterfalls for other plugins.
