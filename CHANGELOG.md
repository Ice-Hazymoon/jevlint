# Changelog

## 0.1.1

- Plain-text and JSON files are judged in bounded line chunks instead of one oversized request. Whole-file rules still skip oversized files.
- Token estimates count UTF-8 bytes, so CJK text is no longer underestimated.
- Requests are checked against the per-question and per-request limits before sending; an oversized line or question fails with its file and question IDs instead of being sent. A batch counts its shared state once.
- `lint` and `baseline` read each file once per scan, so suppressions and baseline fingerprints use the same snapshot that was judged.
- Ledger engine version is now 7: answers recorded by earlier versions are re-judged.

## 0.1.0

First release.

- `jevlint` CLI: scan paths or git scopes (`--changed`, `--staged`, `--base`), with stylish, JSON and SARIF 2.1.0 output. `--no-locate` and `--no-prefilter` bypass the localization pass and the prefilter/unless gates.
- `jevlint test` runs each rule against its fixtures; `--record` and `--drift` track calibration.
- `jevlint recall` measures how many injected violations each rule catches in real files.
- `jevlint baseline` and `// jevlint-ignore <rule> -- <reason>` for accepted hits. Every scan applies the baseline by default; `--no-baseline` sees everything.
- `jevlint verify` checks statements about code against the lines they cite.
- `jevlint hook` judges one edited file for coding agents and editors.
- `jevlint init` scaffolds a config with an example rule and fixtures.
- `candidates` rules select constructs with ast-grep, in process (`@ast-grep/napi`).
- Providers: Vercel AI Gateway, TypeSafe, and a cache-only replay provider.
- Programmatic API: `loadConfig`, `createJevlint`, reporters; `@hazymoon/jevlint/mutate` and `@hazymoon/jevlint/prepare` helpers.
