import { defineConfig } from 'vitest/config'

import { nodeNextResolver } from './vitest.shared.mts'

// Vitest config used by Stryker's vitest-runner (`yarn test:mutation`).
//
// It mirrors the `unit` project of vitest.config.mts and nothing else:
//   - No coverage block. Mutants deliberately break the code, so line-coverage
//     thresholds are meaningless here — the mutation score is the metric.
//   - No `integration` project. Stryker re-runs the suite once per mutant; pointing
//     that at test/integration/*.itest.mts would hammer the real Redis cluster AND the
//     real MongoDB replica set hundreds of times inside this service's own
//     `marketplaceDev:itest:publicResource:` namespace, where `fileParallelism: false`
//     serialises everything. Unit tests have both datasources mocked, so mutant runs
//     stay hermetic and parallelisable.
//
// Keep the plugins/resolve/inline settings in sync with vitest.config.mts — the
// `.mjs -> .mts` NodeNext rewrite and the single-graphql-realm pinning are load
// bearing, not preferences.
// ⚠️ Five entries, and the fifth is not optional — this list has to be the SAME list as the one in
// vitest.config.mts. `@axiumine/marketplace-common` was missing here, which put it on the
// externalised side while koa-utils sat on the inlined one: two graphql copies in one schema, so the
// real ApolloServer's validation threw `Cannot use GraphQLNonNull "String!" from another module or
// realm` and koa-utils' `instanceof GraphQLError` narrowing quietly stopped matching. Under Stryker
// that surfaces as a failed *initial* run, which aborts the whole gate before a single mutant is
// tested — the mutation score was never 100 here, there was no score at all.
const inlineDeps = [/graphql/, /@apollo\/server/, /@as-integrations/, /@axiumine\/koa-utils/, /@axiumine\/marketplace-common/]

export default defineConfig({
	plugins: [nodeNextResolver],
	resolve: { dedupe: ['graphql'] },
	test: {
		include: ['test/*.test.mts'],
		server: { deps: { inline: inlineDeps } },
		// The `unit` project in vitest.config.mts sets no explicit testTimeout (vitest's 5s
		// default). Stryker's instrumented mutants run slower than the original code, so the
		// same 5s can spuriously time out a still-correct test under an inert mutant — that
		// would report a false Survived (test errored, not "test caught nothing"), not a real
		// kill/miss signal. 30s matches the headroom already given to the integration project.
		testTimeout: 30_000,
		// Same as the `unit` project: set before the sources call `dotenv.config()`,
		// which does not override keys already present in process.env.
		env: {
			NODE_ENV: 'test',
			REDIS_IS_CLUSTER: '0',
			REDIS_URL: 'redis://127.0.0.1:6379',
			REDIS_KEY: 'test:',
			MONGODB_URI: 'mongodb://127.0.0.1:27017/test'
		}
	}
})
