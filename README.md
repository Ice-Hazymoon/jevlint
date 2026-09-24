# jevcheck

Lint rules for the code-review questions a syntax-based linter can't answer: "is a secret being logged here?", "can this retry loop run forever?", "does this handler leak an internal error message?". You write each rule as a plain-English yes/no question. jevcheck picks the code the rule applies to, asks [TypeSafe](https://typesafe.ai)'s Jev model, and reports a calibrated probability rather than free text. Each rule is tested against fixtures, answers are cached, and output looks like any other linter's: files, lines, rule ids and exit codes.

Use it alongside ESLint, not instead of it. If a rule can be decided from syntax alone, a deterministic linter is cheaper and exact.

## Install

```sh
npm install --save-dev jevcheck typescript
```

Requires Node.js 22+ or Bun. `typescript` (5.x or 6.x) is a peer dependency.

## Quick start

```sh
npx jevcheck init                   # jevcheck.config.ts + an example rule + two fixtures
export AI_GATEWAY_API_KEY=...      # or TYPESAFE_API_KEY, see "Providers and keys"
npx jevcheck test                   # the example rule must pass its own fixtures
npx jevcheck                        # scan the current directory
```

On a file the rule fires on (a `logger.info` call carrying a `password`), a scan reports:

```text
src/auth/login.ts
  1-5       error    example/no-secret-in-log  p=0.99
             why  Secrets written to logs spread to log storage, alerts and backups, ...
             fix  Remove the secret from the logging call, or log a redacted form of it.

✖ 1 hit (1 error, 0 warnings)
```

**Line precision.** A rule with no `candidates` is judged per chunk — a whole file at or under 150 lines, or a packed slice of a larger one — and reports that chunk's own range; a second pass then narrows a chunk over 40 lines to the smaller window that actually fired. A chunk at or under 40 lines, like the 5-line file above, is already one window, so it's reported as-is: for a short file or a short rule, that can be the whole thing. Add `candidates` (an ast-grep selector) for a node-exact range regardless of size.

## Writing a rule

A rule is one narrow question about "the code in `code`", phrased so that **yes means violation**.

```ts
// jevcheck.config.ts
import { defineConfig, defineRule } from 'jevcheck';

const noSecretInLog = defineRule({
    id: 'logging/no-secret-in-log',
    severity: 'error',
    status: 'owned',
    why: 'Secrets written to logs spread to log storage, alerts and backups.',
    files: ['src/**/*.ts'],
    prefilter: /\b(?:console|logger)\.(?:log|info|warn|error|debug)\s*\(/,
    question: 'Does the code in `code` pass a password, API key, access token or other secret value to a logging call?',
    criteria: {
        true: 'A logging call receives a value that holds a password, API key, token or similar credential.',
        false: 'Logging calls only receive identifiers, counts, statuses or already-redacted values.',
    },
    fix: 'Remove the secret from the logging call, or log a redacted form of it.',
});

export default defineConfig({ rules: [noSecretInLog] });
```

Every rule needs at least one `invalid-*` fixture (it must fire) and one `valid-*` fixture (it must not). The first line gives the path the snippet pretends to live at:

```ts
// jevcheck/fixtures/logging__no-secret-in-log/invalid-password.txt
// path: src/auth/login.ts
logger.info('login attempt', { email, password });
```

```ts
// jevcheck/fixtures/logging__no-secret-in-log/valid-email-only.txt
// path: src/auth/login.ts
logger.info('login attempt', { email });
```

`jevcheck test` runs them. `exempt-*` fixtures check `exemptions`, which are named exceptions that the model is asked about separately.

Beyond the required fields, a rule can use:

| Field | Purpose |
| --- | --- |
| `prefilter` / `unless` / `filePrefilter` | Regex gates that decide in code when the question can't apply. Cheaper and more precise. |
| `candidates` | An [ast-grep](https://ast-grep.github.io/) rule (YAML body) that selects the exact constructs to judge, one question per match. `related` + `linkBy` pull in a far-away construct, such as a function's definition, as context. |
| `wholeFile` | Judge the whole file, for "X is missing" rules. |
| `exemptions` | Legitimate exceptions, each asked as its own question. A hit is exempted when any of them answers ≥ 0.5. |
| `threshold` | Report at or above this probability. Default `0.8`. |
| `confirm` | What a reviewer should check before acting. Printed with each hit. |
| `mutants` | Recall probes for `jevcheck recall` (helpers in `jevcheck/mutate`). |
| `prepare` | Deterministic edit of the text before it's sent (helpers in `jevcheck/prepare`). |
| `status` | `owned` (trusted; used by `hook` and `--owned`) or `shadow` (still being tuned). |
| `source` | Where the rule comes from (a doc section, a ticket, a team convention), printed with each hit. Free text, optional. |
| `exclude` | Globs excluded even when `files` matches. |
| `deterministicCandidate` | Note that a deterministic linter could decide this rule instead; listed by `jevcheck list`. |

## Configuration

`jevcheck.config.{ts,mts,js,mjs}` is found by walking up from the current directory, or passed with `--config`. Paths are relative to the config file.

| Option | Default | |
| --- | --- | --- |
| `rules` | (required) | Your rules. Ids must be unique. |
| `include` | `DEFAULT_INCLUDE` (`**/*.{ts,tsx,mts,vue}`) | Files that may be scanned. |
| `ignore` | `DEFAULT_IGNORE` (`node_modules`, `dist`, `build`, caches, `*.d.ts`, `.env*`, ...) | Files never scanned. |
| `fixtures` | `jevcheck/fixtures` | Fixture directory (`<rule id with / as __>/`). |
| `calibration` | `jevcheck/calibration.json` | Written by `test --record`, read by `test --drift`. |
| `baseline` | `jevcheck/baseline.json` | Written by `jevcheck baseline`. |
| `cacheDir` | `$XDG_CACHE_HOME/jevcheck` or `~/.cache/jevcheck` | Answer and verdict cache. |
| `suppression` | `jevcheck-ignore` | Inline marker: `// jevcheck-ignore <rule id> -- <reason>` (the reason is required). |
| `provider` | gateway if `AI_GATEWAY_API_KEY` is set, else typesafe | See below. |
| `concurrency` / `tokensPerSecond` | `48` / `230000` | Request pacing. |
| `reporters` | `[]` | `{ name, onRunComplete(result) }` hooks called after every scan. |

Mistakes are reported with the field name, for example `rules[0] ("logging/x"): "severity" must be "error" or "warning"` or `unknown key "ignores" (did you mean "ignore"?)`.

## CLI

| Command | |
| --- | --- |
| `jevcheck [paths...]` | Scan (default: the current directory). `--changed`, `--staged` and `--base <ref>` scan git changes. `--format stylish\|json\|sarif`. `--no-baseline`, `--no-locate` and `--no-prefilter` skip the baseline, the localization pass or the prefilter gates (`jevcheck --help` for all options). |
| `jevcheck test` | Run fixtures. `--record` saves probabilities; `--drift` asks again and compares. |
| `jevcheck recall` | Mutate real files and measure how many violations are caught. |
| `jevcheck baseline [paths...]` | Accept the current hits; every later scan then reports only new ones. |
| `jevcheck list` | List rules. |
| `jevcheck verify <claims.json>` | Check statements about code against the lines they cite. |
| `jevcheck cache prune` | Delete old cache entries. |
| `jevcheck hook` | Post-edit hook for coding agents and editors. Reads `{"file_path": "..."}` on stdin and exits 2 with the hits on stderr. |
| `jevcheck init` | Scaffold a config, an example rule and fixtures. |

`jevcheck --help` and `jevcheck <command> --help` list every option. Exit codes: `0` no error-severity hit, `1` at least one error-severity hit, `2` usage or runtime error.

## Providers and keys

| `provider` | Key variable (override with `keyEnv`) | |
| --- | --- | --- |
| `{ kind: 'gateway' }` | `AI_GATEWAY_API_KEY` | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)'s TypeSafe endpoint. Serves the latest model. |
| `{ kind: 'typesafe', model? }` | `TYPESAFE_API_KEY` | api.typesafe.ai, pinned to a model version. |
| `{ kind: 'replay', model? }` | none | Cache only. A missing answer is an error, and nothing is sent. |

**Security.** The text of every judged chunk (source code, plus the file path) is sent to the provider. Don't scan code you aren't allowed to share with it. Keys are read only from the environment variable named above: jevcheck never reads `.env` files and never logs keys. If you keep keys in a dotenv file, load it yourself before running jevcheck.

## CI

Answers are cached by model, question and exact code, so a re-scan of unchanged code costs nothing. Keep the cache between runs:

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/jevcheck
    key: jevcheck-${{ github.sha }}
    restore-keys: jevcheck-
- run: npx jevcheck --base origin/main --format sarif > jevcheck.sarif
  env:
    AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: jevcheck.sarif
```

- Every scan applies the baseline by default, so CI fails only on new hits. Commit `jevcheck/baseline.json` after `jevcheck baseline`.
- To test rules without a key or network (for example on forks), point `cacheDir` at a committed directory and use `provider: { kind: 'replay' }`.

## Programmatic API

```ts
import { createJevcheck, loadConfig } from 'jevcheck';

const jevcheck = createJevcheck(await loadConfig());
const result = await jevcheck.lint(['src/server.ts'], { owned: true });
for (const hit of result.hits) console.log(hit.file, hit.startLine, hit.rule, hit.probability);

await jevcheck.test();                                  // fixtures
await jevcheck.recall({ files: ['src/server.ts'] });    // mutation recall
```

For a config built in code, use `resolveConfig(defineConfig({ ... }), rootDir)`. All types (`JevRule`, `LintRunResult`, ...) are exported and documented.

## Calibration and recall

- **Calibration:** `jevcheck test --record` stores each fixture's probability. The gateway model can change without notice, so `jevcheck test --drift` asks again without the cache and lists fixtures that moved by 0.10 or more. Fixtures that pass by less than 0.05 are flagged as thin margins.
- **Recall:** fixtures show a question can work; recall shows it works on your code. Each `mutants` entry turns real compliant code into a violation (for example, removing a timeout). `jevcheck recall` judges a deterministic sample of mutated files and reports the share caught. Aim for 0.9 or higher before marking a rule `owned`.

  ```ts
  import { dropMethodCalls } from 'jevcheck/mutate';

  // On a rule requiring a bounded query, this drops `.limit(...)` from a real compliant call.
  mutants: [{ id: 'drop-limit', apply: text => dropMethodCalls(text, 'limit') }],
  ```

  ```text
  $ jevcheck recall
  security/bounded-query  drop-limit  9/10  recall=0.90
  ```

## FAQ

**What does it cost?** One request carries every applicable question for one chunk of code. Two stores keep re-scans cheap: a file unchanged since its last scan is replayed whole from the ledger, for free; a changed file still reuses any individual answer already in the per-question cache. `prefilter` / `candidates` keep unrelated code from being sent at all. The summary line reports both, plus requests and input tokens, for example `3 files replayed from ledger, 12 answers from cache, 2 requests, 480 input tokens`.

**Is my code private?** The judged chunks go to the provider you configure, and nowhere else. Use `prefilter`, `files` and `ignore` to limit what is sent.

**Is it deterministic?** For a given model, cached answers are exact, so re-running on unchanged code gives the same result. A new model can shift probabilities, which is what `test --drift` detects. Use the `typesafe` provider to pin a model version.

## License

MIT
