import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import mongoose from 'mongoose'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { start } from '../../src/index.mts'

/*
 * start()'s catch arm — the boot-failure path — driven for real.
 *
 * No fault is simulated: the datasource URL is pointed at something MongoDB genuinely refuses, and
 * the real driver raises the real error. Redis still connects for real on the same Promise.all,
 * which is the point of doing it this way: the catch has to tear down a HALF-CONNECTED process,
 * and disconnectAllDatabases really closes that live Redis client on the way out.
 *
 * Its own file because it must run with nothing connected yet — index.itest.mts boots the service
 * in its beforeAll, and vitest gives each test file its own module registry, so this one starts
 * from a clean slate.
 */
describe('start() when MongoDB refuses the connection', () => {
	const realUri = process.env.MONGODB_URI

	afterAll(async () => {
		process.env.MONGODB_URI = realUri
		await redisClient.close().catch(() => undefined)
	})

	it('logs, tears down the datasources that did come up, and exits 1', async () => {
		// Truthy, so checkRequiredEnv() is satisfied and the failure happens where it is meant to —
		// in the driver, not in the env guard.
		process.env.MONGODB_URI = 'not-a-mongodb-uri'

		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			// Resolves rather than throwing: the catch handles the error and (normally) exits.
			await expect(start()).resolves.toBeUndefined()

			expect(errorLog).toHaveBeenCalled()
			expect(exit).toHaveBeenCalledWith(1)

			// The teardown was real, not just attempted: mongoose never came up and the Redis client
			// that did is closed again.
			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			exit.mockRestore()
			errorLog.mockRestore()
		}
	})

	/*
	 * The env guard runs OUTSIDE start()'s try, so a missing variable is not caught, not reported
	 * to Sentry, and never reaches disconnectAllDatabases — it propagates straight out of start()
	 * and the process dies without touching a datasource. Driven through start() rather than by
	 * calling checkRequiredEnv() directly, so it is that ordering being tested and not just the
	 * guard's own loop.
	 *
	 * REDIS_KEY stands in for the missing variable here rather than a Keygrip key: this is the public
	 * tier's catalog service, it signs no cookies, and REQUIRED_ENV_VARS carries no KEYGRIP_KEY_* at
	 * all. It also has to be an entry no connection reads, or the two assertions below would hold for
	 * the wrong reason — REDIS_KEY is only a session-key prefix, so if the guard ever moved inside
	 * start()'s try both datasources would come up and this test would fail, which is the point.
	 * DSN used to play that role and cannot any more: Sentry is optional, so it is no longer required.
	 */
	it('refuses to boot at all, and connects nothing, when a required variable is missing', async () => {
		const realRedisKey = process.env.REDIS_KEY
		delete process.env.REDIS_KEY

		try {
			await expect(start()).rejects.toThrow('Missing required environment variable: REDIS_KEY')

			expect(mongoose.connection.readyState).toBe(0)
			expect(redisClient.isOpen).toBe(false)
		} finally {
			process.env.REDIS_KEY = realRedisKey
		}
	})
})
