import { redisClient, RedisConnect } from '@axiumine/koa-utils/dataSources/Redis'

/**
 * The keyspace the integration project runs in.
 *
 * Declared here rather than inline in `vitest.config.mts` because `globalSetup` has to write the keygrip
 * record into the *same* namespace the service under test reads it from, and those two run in different
 * processes — the project's `env` block never reaches this one. One constant, two readers, no chance of
 * seeding a prefix nobody looks at.
 */
export const ITEST_REDIS_KEY = 'marketplaceDev:itest:publicResource:'

/**
 * The keygrip record `start()` now refuses to boot without (ADR-034).
 *
 * ⚠️ **Opaque on purpose: this service holds no `KEYGRIP_KEK`, and must not.** It signs no cookie and
 * rotates nothing, so it never opens the record — `assertRedisNamespace` asks only whether the record is
 * *here*, which is how a `REDIS_KEY` naming a namespace nobody seeded is caught at boot instead of being
 * discovered as a 401 on every request. Minting a real key set for the run would put signing material in
 * one of the three tiers `SETUP.md` §7 says must not carry it, to satisfy a check that never looks at it.
 *
 * ⚠️ **Provisioned here rather than inherited.** The integration namespace is this suite's own, so
 * `yarn seed:keygrip` has never written into it: the record belongs next to the throwaway database and
 * the throwaway CSFLE key, and is as disposable as both.
 *
 * ⚠️ **Deleted first.** `HSET` merges, so a previous run's fields would otherwise survive under a record
 * this run believes it wrote whole.
 */
export async function seedKeygripRecord(): Promise<void> {
	await RedisConnect()
	try {
		await redisClient.del(`${ITEST_REDIS_KEY}keygrip`)
		await redisClient.hSet(`${ITEST_REDIS_KEY}keygrip`, {
			version: '1',
			wrapped: Buffer.alloc(64, 7).toString('base64'),
			fp: 'itest'
		})
	} finally {
		// This process only provisions; every test file opens its own client.
		await redisClient.close().catch(() => undefined)
	}
}
