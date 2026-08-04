/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mts'
	},
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * 28 workers on a 32-thread box. The `4` this replaces was never measured anywhere — the same literal
	 * sat in all nine Stryker configs on the platform, frontend included, where dropping it
	 * cut 59 minutes to 18.
	 *
	 * Measured here, 161 mutants, machine otherwise idle:
	 *
	 *   concurrency 4  → 67s
	 *   concurrency 28 → 35s
	 *
	 * ⚠️ "It still scored 100" is **not** what justified this, and must not justify the next change. A
	 * starved worker misses a deadline, its test fails, and Stryker records the mutant as *killed* —
	 * overload inflates the score, so 100 at any concurrency is consistent with a gate that has quietly
	 * stopped checking. At the break threshold there is no headroom for the number to show it.
	 *
	 * What was compared instead is the set of non-killed mutants, where load surfaces first: both runs
	 * ended on the same zero non-killed mutants — no survivor, no timeout, nothing to compare away.
	 * Re-measure that way before touching this.
	 */
	concurrency: 28,
	timeoutMS: 60000,
	// Mutation score is a push gate — see COVERAGE.md. `break` fails the run (exit 1)
	// below this score, which is what the pre-push hook keys off. Raise it as tests
	// improve; never lower it to make a run pass.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and `.stryker-tmp`
	 * — `ignorePatterns` itself defaults to empty, and `.qodana/` here runs to tens of megabytes.
	 *
	 * It is not only wasted copying. `disableTypeChecks: true` resolves to the glob
	 * `**\/*.{js,ts,jsx,tsx,html,vue,mjs,mts,cts,cjs}` matched with `dot: true`, so it descends into
	 * dotted directories, and every run logged a `ParseError` trying to strip `@ts-` directives out of
	 * Qodana's own `thirdPartySoftwareList.html`. Stryker swallows that error and carries on, so the
	 * gate stayed green while printing a stack trace nobody could act on.
	 *
	 * Neither directory is an input to any test: both are gitignored build output.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'src/**/*.mts',
		// index.mts is NOT blanket-excluded. Verified with `vitest run --project unit --coverage`:
		// the file reaches 83.01% statements / 69.23% branches from the unit project alone, with
		// only lines 124-137 reported uncovered — the ENDPOINT/health/fallthrough dispatch inside
		// the app.use() middleware body in createServer, which only runs when a real HTTP request
		// travels through the Koa stack, and only test/integration/index.itest.mts does that (this
		// run deliberately stays on the unit project only, see vitest.mutation.config.mts). Every
		// other line, INCLUDING the listen() call and the bind-fix options object at 180-198, is
		// unit-covered and gets mutated below.
		//
		// A bare `!src/index.mts:124-137` does NOT narrow anything here — verified empirically
		// against @stryker-mutator/core@9.6.1's project-reader.js: the negated-pattern branch of
		// resolveFileDescriptions() sets `{ mutate: false }` unconditionally for every file the
		// glob part matches, discarding whatever range was parsed from the pattern. So a negated
		// range silently behaves exactly like `!src/index.mts` — the whole file, same silent trap
		// as an unenforced git hook. What actually narrows is excluding the whole file and then
		// re-including it as the UNION of two positive ranges, which Stryker's project reader does
		// merge (see unionFileDescriptions). That leaves lines 124-137 unmutated, along with
		// 207-225 — the `v8 ignore`d entrypoint tail below, which never executes under
		// NODE_ENV=test regardless of project, so mutating it would only add NoCoverage noise.
		'!src/index.mts',
		'src/index.mts:1-123',
		'src/index.mts:138-206'
	]
}
