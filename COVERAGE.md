# Test quality policy — 100% coverage **and** 100% mutation score, no exceptions

This service requires **100% test coverage on every metric** — statements, branches,
functions, and lines — **and a 100% Stryker mutation score**. Both are hard gates, not targets.

They answer different questions, which is why both exist:

| Gate | Question it answers |
|---|---|
| coverage | did a test *execute* this line? |
| mutation | would a test *fail* if this line were wrong? |

100% coverage with weak assertions is the normal failure mode, and it is invisible to the
coverage number. Mutation testing is what falsifies it: Stryker rewrites `src/` one small
change at a time (`true` → `false`, a string → `""`, a block → `{}`) and re-runs the suite.
A mutant that *survives* is an edit no test noticed.

## The rule

If coverage is below 100% on any metric, the fix is one of:

1. **Add the missing tests** for the uncovered lines / branches / functions.
2. **Delete the code** if it is unreachable or dead.

If the mutation score is below 100%, the fix is one of:

1. **Strengthen the assertion** that should have caught the mutant.
2. **Delete the code** if the mutant proves the branch is dead.
3. **Document an equivalent mutant** with `// Stryker disable next-line <Mutator>: <why>` —
   only when the mutated code provably cannot behave differently on any reachable input.

**Never** lower a threshold to make a run pass. The thresholds are the specification;
red means the work is not done, not that the number is wrong.

## Where it is enforced

| Layer | File | What it does |
|---|---|---|
| Local test run | `vitest.config.mts` → `test.coverage.thresholds` | `yarn test:cov` exits non-zero if any metric < 100% |
| Local mutation run | `stryker.config.mjs` → `thresholds.break` | `yarn test:mutation` exits non-zero if the score < 100 |
| Qodana scan gate | `qodana.yaml` → `failureConditions.testCoverageThresholds` (`total`/`fresh` = 100) | `./qodana.sh` fails the scan if coverage < 100% |
| Git `pre-commit` | `.githooks/pre-commit` | blocks the commit if `yarn test:cov` **or** the Qodana scan fails |
| Git `pre-push` | `.githooks/pre-push` | blocks the push if `yarn lint:check`, `yarn test:cov`, `yarn test:mutation` **or** the Qodana scan fails |

The three coverage layers read the same coverage run (vitest, v8 provider, lcov →
`coverage/lcov.info`, `coverage.include` over `src/**/*.mts`). Change coverage
config in `vitest.config.mts` only. Qodana has no mutation gate — `pre-push` is the
only one.

⚠️ **`coverage.include` is the whole reason those thresholds mean anything.** The
v8 provider reports only the files a test actually `import`-ed, so without it a
source file no suite loads is *absent* from the report rather than listed at 0%,
and 100% of a denominator that excludes it passes (`RISK_REGISTER` R07). The glob
names every shipped source file, so a new one is force-listed at 0% and takes the
run red until it has a test. `all: true` and `extension: ['.mts']` sat either side
of it until 2026-09-06 and did nothing at all: vitest 4 removed both from
`CoverageOptions`, and an unchecked spread swallowed them without a warning. Do not
bring either back — `all` is not a synonym for `include`.

Both hooks run the scan on purpose. `git merge --no-ff` never fires `pre-commit` —
git runs that hook for `git commit` only — so the merge commit, the one revision
that reaches `origin`, is the single commit no pre-commit scan ever sees. And
Qodana Cloud files each report under the branch it ran on, so a repo scanned only
at commit time never produces a `main`-tagged report to baseline against. Each hook
hands `qodana.sh` `SKIP_TESTS=1`, reusing the `coverage/lcov.info` its own coverage
step just wrote rather than letting the script regenerate it with a test run whose
failure it swallows. `SKIP_QODANA=1` skips the scan alone; the coverage and
mutation gates stay.

## Two projects, one coverage report

`vitest.config.mts` defines two projects; `yarn test:cov` runs both and aggregates coverage:

| Project | Files | Datasources | Purpose |
|---|---|---|---|
| `unit` | `test/*.test.mts` | mocked | pure logic, error paths, prod branches — fast, offline |
| `integration` | `test/integration/*.itest.mts` | **real MongoDB + real Redis cluster** | boots the server via `start()` and drives it over HTTP |

The integration project connects to the **live Redis cluster and the live MongoDB** using the
`REDIS_*` and `MONGODB_URI` values from `.env` (loaded by the sources' own `dotenv.config()`).
It overrides only the keyspace prefix (`REDIS_KEY=marketplaceDev:itest:publicResource:`, a namespace
private to this service, under the ACL-allowed `marketplaceDev:itest:` stem) and `PORT=0` (ephemeral).
Run just one side with `yarn test:unit` / `yarn test:integration`.

Consequence: the coverage gate — and therefore `pre-push` and `./qodana.sh` — needs **both**
datasources reachable. That is intentional: 100% here means the server was really booted and
really talked to MongoDB and Redis, not that a mock returned the expected value.

### What the integration suite really exercises against MongoDB

`resetPwd` and `updatePwd` are driven over HTTP against the live database, including
`mongoose.startSession()` and `withTransaction` — so the **replica set** has to be up, not just
a standalone `mongod`. Both are called with an address that does not exist, on purpose:

- `resetPwd` answers `true` for an unknown address (no enumeration oracle) and persists nothing;
- `updatePwd` answers `403` for the same reason.

Neither writes, so the suite is safe to run repeatedly against the shared dev database.

## Enabling the hook

The `pre-push` hook lives in `.githooks/` (tracked in git). It is activated by:

```bash
git config core.hooksPath .githooks
```

The `prepare` script in `package.json` runs this automatically on `yarn install`, so a
fresh clone is gated after the first install. To verify:

```bash
git config --get core.hooksPath   # -> .githooks
```

## Server boot and Sentry init are covered — do not exclude them

`src/index.mts` (Koa/Apollo wiring, the `/check` router, `/health`, shutdown) and
`src/instrument.mts` (Sentry init) reach 100% through the **integration** project, which boots
the real server and hits `/public-resource`, `/health`, `/check/`, and an unknown path over
HTTP. They are **not** `v8 ignore`d and must stay that way — the only `v8 ignore` block is the
entrypoint tail of `index.mts` (the `if (NODE_ENV !== 'test')` bootstrap that registers signal
handlers and calls `start()`), which cannot run under the test process without killing the
worker via `process.exit`. Every function it wires (`start`, `gracefulShutdown`,
`onUnhandledRejection`, `onUncaughtException`) is exercised directly by tests, so the ignored
block contains only the wiring, no logic.

`src/index.ts.orig` is a merge leftover, not a source (see CLAUDE.md). It is out of scope
because `coverage.include` is `src/**/*.mts` — do not "fix" that by widening the glob.

## Mutation testing — what is mutated, and what is not

`yarn test:mutation` runs Stryker (`stryker.config.mjs`) with the **vitest** runner over
`vitest.mutation.config.mts`. Two deliberate scope decisions:

| Setting | Why |
|---|---|
| runs the **`unit` project only** | Stryker re-runs the suite once per mutant. Pointing that at `test/integration/*.itest.mts` would hit the real Redis cluster **and** the real MongoDB replica set hundreds of times, where `fileParallelism: false` serialises everything within this service's own `marketplaceDev:itest:publicResource:` namespace. Unit tests have both datasources mocked, so mutant runs stay hermetic and parallel. |
| `index.mts` line-range split, **not** a whole-file exclusion | Verified with `vitest run --project unit --coverage`: `index.mts` reaches 83.01% statements / 69.23% branches from the `unit` project alone, with only lines 124-137 reported uncovered — the `ENDPOINT`/`/health`/fallthrough dispatch inside the `app.use()` middleware body in `createServer`, which only runs when a real HTTP request travels through the Koa stack (only `test/integration/index.itest.mts` does that; this run deliberately stays on `unit`, see `vitest.mutation.config.mts`). Everything else, **including the `listen()` call and its bind-fix options object**, is unit-covered. `mutate` in `stryker.config.mjs` is therefore `['src/**/*.mts', '!src/index.mts', 'src/index.mts:1-123', 'src/index.mts:138-206']`: exclude the whole file, then re-include it as the union of two positive ranges, which leaves lines 124-137 (integration-only) and 207-225 (the `v8 ignore`d entrypoint tail below, which never runs under `NODE_ENV=test` either way) unmutated while mutating everything else. A bare `!src/index.mts:124-137` does **not** narrow anything — verified empirically against `@stryker-mutator/core@9.6.1`'s `project-reader.js`: the negated-pattern branch of `resolveFileDescriptions()` sets `{ mutate: false }` unconditionally for every file the glob part matches, discarding whatever range was parsed from the pattern, so a negated range silently behaves exactly like `!src/index.mts` — the whole file. |

`ignoreStatic` is **not** set, and that claim above ("nothing is excluded because of it") was false
the moment it was written: it described a run made *with* `ignoreStatic: true`, which drops every
static (module-load-only) mutant before Stryker even attempts one — there was nothing left for the
existing tests to "independently kill". Turning it off exposed 11 static survivors on the first
honest run: `description`/`name` string literals on `publicMutArgs`, `publicMutNoArgs`,
`publicHelloArgs`, `publicHelloNoArgs`, `HelloType`, `MutationsPublic` and `QueriesPublic`, plus
whole-object wipes of `HelloType`, `MutationsPublic`, `QueriesPublic` and — the one that matters
most — `RESET_PWD_PATHS` in `src/lib/access/resetPwdFlow.mts` collapsing to `{}`.

Two separate problems had to be fixed, not one. First, attribution: a module-level mutant is
evaluated during Vitest's file-collection phase, before any test runs, and Stryker's
`coverageAnalysis: perTest` cannot attribute a collection-time throw or value change to a test that
hasn't started yet — even though the suite's assertions plainly fail against it once it runs. The
fix is importing the modules under test dynamically, inside `beforeEach`/`beforeAll`, never at top
level and never merely inside a top-level `await import()` (which still runs during collection), so
the same evaluation happens inside a window Stryker does track. Second, assertion strength: a
per-key `toBeDefined()`/`toBe()` check does not catch a whole-object wipe, because an absent key
just reads `undefined` and no per-key assertion ever runs against it — `RESET_PWD_PATHS`,
`HelloType`, `MutationsPublic` and `QueriesPublic` each needed an assertion against the literal
value itself (`.toEqual` on the whole object, plus `Object.keys(...).toHaveLength(...)` for the
multi-field ones) to fail against `{}`.

Everything else — the two GraphQL resolvers, the reset-password field map, the `/check` router,
the Sentry transport wrapper, the datasource-disconnect/shutdown logic, and now the unit-covered
majority of `index.mts` (the bind-fix `listen()` call, `logListening`, `createServer`'s
`koa-bodyparser`/`ApolloServer` config objects, the failure path) — is fully mutated.
Current state (`yarn test:mutation`, this repo, this session): **140 mutants, 140 killed, 0
survived**, 1 minute 6 seconds.

Narrowing the `index.mts` exclusion (see the table above) exposed 11 real survivors on the first
honest run at the narrowed range: the `koa-bodyparser` options object in `createServer` (8
mutants — `enableTypes`/`extendTypes` array and string literals, and two whole-object wipes), the
`ApolloServer` `plugins`/`csrfPrevention` options (2 mutants), and the `console.error('error',
error)` string literal in `start()`'s catch block (1 mutant) — none of these had ever been
mutated before, because the whole file was excluded. `test/index.unit.test.mts` now wraps
`koa-bodyparser` and `@apollo/server` with recording spies that delegate to the real
implementation (so `createServer()` still behaves exactly as in production) and asserts the exact
captured options; both wrappers snapshot the values **before** calling through, because both
libraries mutate the options object they are given in place (`koa-bodyparser` sets
`detectJSON`/`onerror`/`returnRawBody` on it directly; `ApolloServer`'s real constructor appends
its own built-in plugins onto the `plugins` array) — reading the values after the call would
report the library's post-mutation state instead of what `src/index.mts` actually passed.
`console.error` gained the same treatment: the failure-path tests already spied on it but never
asserted a call, so the spy caught nothing.

### Writing tests that kill

The only survivor in the first real run was in `publicHelloArgs.mts`'s `console.debug('publicHelloArgs:
name: ', args.name)`: the test called `resolve()` and asserted the returned greeting, but nothing
checked what was logged, so Stryker's `StringLiteral` mutant (blanking the message to `''`) passed
unnoticed. The fix, in `test/schema.test.mts`, spies on `console.debug` and asserts the exact call —
`toHaveBeenCalledExactlyOnceWith('publicHelloArgs: name: ', 'Mark')` — rather than the weaker
`toHaveBeenCalled()`, which would pass for the mutant too.

## Running it

```bash
yarn test:cov       # coverage + threshold check (the source of truth)
yarn test:mutation  # Stryker; report at reports/mutation/mutation.html
./qodana.sh         # full Qodana Ultimate scan, incl. the 100% coverage gate
```

`git push` runs the first two, in that order, and blocks on either.
