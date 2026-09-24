# Changelog

## 0.1.0

First release.

- `jevcheck` CLI: scan paths or git scopes (`--changed`, `--staged`, `--base`), with stylish, JSON and SARIF 2.1.0 output. `--no-locate` and `--no-prefilter` bypass the localization pass and the prefilter/unless gates.
- `jevcheck test` runs each rule against its fixtures; `--record` and `--drift` track calibration.
- `jevcheck recall` measures how many injected violations each rule catches in real files.
- `jevcheck baseline` and `// jevcheck-ignore <rule> -- <reason>` for accepted hits. Every scan applies the baseline by default; `--no-baseline` sees everything.
- `jevcheck verify` checks statements about code against the lines they cite.
- `jevcheck hook` judges one edited file for coding agents and editors.
- `jevcheck init` scaffolds a config with an example rule and fixtures.
- `candidates` rules select constructs with ast-grep, in process (`@ast-grep/napi`).
- Providers: Vercel AI Gateway, TypeSafe, and a cache-only replay provider.
- Programmatic API: `loadConfig`, `createJevcheck`, reporters; `jevcheck/mutate` and `jevcheck/prepare` helpers.
