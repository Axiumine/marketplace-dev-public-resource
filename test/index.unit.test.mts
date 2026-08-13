import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const MongoDBConnect = vi.fn()
const RedisConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
const setupFieldEncryption = vi.fn()
// Captured constructor/factory arguments for the two real, unmocked config objects createServer()
// builds (koa-bodyparser's options, ApolloServer's options). Both wrappers delegate to the real
// implementation — body parsing and the Apollo instance still behave exactly as in production —
// they only additionally record what they were called with, so the option literals themselves
// (enableTypes, extendTypes, plugins, csrfPrevention) have something asserting their exact value
// instead of merely being reached.
const bodyParserOptions: unknown[] = []
const apolloServerOptions: { pluginCount: number | undefined; csrfPrevention: unknown }[] = []

// The one middleware in the dispatch chain that cannot be driven for real without a socket and a
// live schema execution. Mocked to a recorder so the Apollo arm of the dispatch below can be
// exercised at all: what the arm owes anyone is that the endpoint path reaches Apollo, carrying this
// request's own ctx as the GraphQL context — and both halves are asserted from what lands here.
const apolloKoaMiddleware = vi.fn()
const apolloKoaOptions: { context: () => Promise<unknown> }[] = []

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
vi.mock('@as-integrations/koa', () => ({
	koaMiddleware: (_server: unknown, options: { context: () => Promise<unknown> }) => {
		apolloKoaOptions.push(options)
		return apolloKoaMiddleware
	}
}))
// The datasources are imported transitively by the router and the reset-password flow; bare stubs
// are enough because the unit project never really connects — http.Server.prototype.listen is
// stubbed too, below, so the success path can run without opening a socket.
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
// Mocked, not stubbed with a real key: setupFieldEncryption() opens a ClientEncryption against the
// live connection mongoose holds, and the unit project has none. What matters here is that start()
// awaits it, in the right order, and dies if it rejects — all three are asserted below.
vi.mock('@axiumine/marketplace-common/encryption/setupFieldEncryption', () => ({ setupFieldEncryption }))
vi.mock('koa-bodyparser', async (importOriginal) => {
	const actual = await importOriginal<typeof import('koa-bodyparser')>()
	return {
		// koa-bodyparser mutates its `opts` argument in place (sets detectJSON/onerror/
		// returnRawBody directly on the object it was given), so the options object must be
		// snapshotted with a shallow copy BEFORE calling through, or the recorded value would
		// reflect koa-bodyparser's post-mutation state instead of what src/index.mts passed in.
		default: (options: Parameters<typeof actual.default>[0]) => {
			bodyParserOptions.push({ ...options })
			return actual.default(options)
		}
	}
})
vi.mock('@apollo/server', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@apollo/server')>()
	class SpiedApolloServer extends actual.ApolloServer {
		constructor(options: ConstructorParameters<typeof actual.ApolloServer>[0]) {
			// ApolloServer's real constructor appends its own built-in plugins (landing page,
			// usage reporting, ...) directly onto the `plugins` array it was given, so the count
			// must be read BEFORE calling super() — reading it after would count Apollo's own
			// plugins alongside ours. Referencing the constructor parameter before super() is
			// fine; only `this` is off-limits until super() runs.
			const pluginCount = options?.plugins?.length
			const csrfPrevention = options?.csrfPrevention
			super(options)
			apolloServerOptions.push({ pluginCount, csrfPrevention })
		}
	}
	return { ...actual, ApolloServer: SpiedApolloServer }
})

const {
	ENDPOINT,
	REQUIRED_ENV_VARS,
	checkRequiredEnv,
	buildValidationRules,
	healthResponse,
	logListening,
	gracefulShutdown,
	onUnhandledRejection,
	onUncaughtException,
	createServer,
	start
} = await import('../src/index.mts')

describe('checkRequiredEnv', () => {
	/*
	 * ⚠️ The whole list, by value and in order, rather than a length or a `toContain`. This array is a
	 * contract with every environment the service is deployed into, and both ways of breaking it are
	 * silent: a name dropped from here turns a fatal misconfiguration into a service that starts and
	 * fails later, at a request, somewhere that does not name the cause; a name added here and read
	 * nowhere makes every environment carry a value that does nothing. A length check passes a swap and
	 * a `toContain` passes an addition, so neither notices the change. The order is asserted too — the
	 * boot names the *first* missing variable, and that is the one an operator goes looking for. E18-S03.
	 */
	it('requires exactly these 20 variables, in this order', () => {
		expect(REQUIRED_ENV_VARS).toStrictEqual([
			'PORT',
			'REDIS_IS_CLUSTER',
			'REDIS_DB1_HOST',
			'REDIS_DB2_HOST',
			'REDIS_DB3_HOST',
			'REDIS_DB1_PORT',
			'REDIS_DB2_PORT',
			'REDIS_DB3_PORT',
			'REDIS_USERNAME',
			'REDIS_PASSWORD',
			'REDIS_KEY',
			'MONGODB_URI',
			'CSFLE_MASTER_KEY_PATH',
			'CSFLE_KEY_VAULT_NAMESPACE',
			'SOCKETLABS_SERVER_ID',
			'SOCKETLABS_SERVER_APIKEY',
			'PLATFORM_NAME',
			'EMAIL_FROM',
			'APP_DOMAIN',
			'APP_DOMAIN_USER'
		])
	})

	it('passes when every required variable is set', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		expect(() => checkRequiredEnv(env)).not.toThrow()
	})

	it('throws naming the first missing variable', () => {
		expect(() => checkRequiredEnv({})).toThrow(`Missing required environment variable: ${REQUIRED_ENV_VARS[0]}`)
	})

	// MONGODB_URI is the one required variable the logout service does not have: this server is the
	// only public tier that reads the catalog, so a missing URI must fail the boot, not the queries.
	it('requires MONGODB_URI', () => {
		const env = Object.fromEntries(REQUIRED_ENV_VARS.map((k) => [k, 'x']))
		delete env.MONGODB_URI

		expect(() => checkRequiredEnv(env)).toThrow('Missing required environment variable: MONGODB_URI')
	})

	// Named literally rather than derived from the array: these two are what setupFieldEncryption()
	// reads, and a rename on either side has to break a test rather than a boot. ADR-029.
	it('requires the two field-encryption variables by name', () => {
		expect(REQUIRED_ENV_VARS).toContain('CSFLE_MASTER_KEY_PATH')
		expect(REQUIRED_ENV_VARS).toContain('CSFLE_KEY_VAULT_NAMESPACE')
	})
})

describe('buildValidationRules', () => {
	it('is empty outside production', () => {
		expect(buildValidationRules({ NODE_ENV: 'test' })).toEqual([])
	})

	it('caps depth and blocks introspection in production', () => {
		expect(buildValidationRules({ NODE_ENV: 'production' })).toHaveLength(2)
	})
})

describe('healthResponse', () => {
	it('reports OK with a round-trippable ISO timestamp', () => {
		const res = healthResponse()
		expect(res.status).toBe('OK')
		expect(res.timestamp).toBe(new Date(res.timestamp).toISOString())
	})
})

describe('logListening', () => {
	let info: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureMessage.mockReset()
		info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
	})
	afterEach(() => {
		info.mockRestore()
		vi.unstubAllEnvs()
	})

	it('logs to the console only, outside production', () => {
		logListening({ NODE_ENV: 'test', PORT: '4027' })
		expect(info).toHaveBeenCalledExactlyOnceWith('Serving http://*:4027/public-resource for test.')
		expect(captureMessage).not.toHaveBeenCalled()
	})

	it('also mirrors the banner to Sentry in production', () => {
		logListening({ NODE_ENV: 'production', PORT: '80' })
		const message = 'Serving http://*:80/public-resource for production.'
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(message, 'info')
		expect(info).toHaveBeenCalledExactlyOnceWith(message)
	})

	// The real call site — start(), below — invokes logListening() with NO arguments, letting it
	// fall back to process.env. The two tests above pass an explicit env object, which is a path
	// production never takes; that gap is exactly how a HOSTNAME reference kept logging
	// "Serving http://undefined:..." after HOSTNAME was removed from REQUIRED_ENV_VARS and the env
	// template. This test stubs process.env the way production actually has it (no HOSTNAME at
	// all) and calls logListening with zero arguments, so a reintroduced env.HOSTNAME reference
	// fails it immediately.
	it('reads process.env when called with no arguments, as the real call site does', () => {
		vi.stubEnv('NODE_ENV', 'production')
		vi.stubEnv('PORT', '4064')
		vi.stubEnv('HOSTNAME', undefined)

		logListening()

		const message = 'Serving http://*:4064/public-resource for production.'
		expect(info).toHaveBeenCalledExactlyOnceWith(message)
		expect(captureMessage).toHaveBeenCalledExactlyOnceWith(message, 'info')
	})
})

describe('createServer', () => {
	beforeEach(() => {
		bodyParserOptions.length = 0
		apolloServerOptions.length = 0
		apolloKoaOptions.length = 0
		apolloKoaMiddleware.mockClear()
	})

	it('parses json/form/text bodies and hardens Apollo with the drain plugin and csrfPrevention', async () => {
		const { apolloServer } = await createServer()

		try {
			expect(bodyParserOptions).toEqual([
				{
					enableTypes: ['json', 'form', 'text'],
					extendTypes: { json: ['application/json'] }
				}
			])

			expect(apolloServerOptions).toEqual([{ pluginCount: 1, csrfPrevention: true }])
		} finally {
			await apolloServer.stop()
		}
	})

	// The dispatch middleware is driven directly, from `app.middleware`, rather than through a socket:
	// it is the last thing createServer() pushes onto the Koa stack, and its two non-Apollo branches are
	// plain ctx writes. Only test/integration/index.itest.mts sends a real request, and it is not in the
	// mutation run — so without this the `else { await next() }` arm had no unit coverage at all, which
	// Stryker reports as NoCoverage: a mutant nothing even attempted to kill.
	it('answers /health itself and hands every other path to the next middleware', async () => {
		const { app, apolloServer } = await createServer()
		const dispatch = app.middleware.at(-1)!

		try {
			const health = { path: '/health' } as never as { path: string; body: { status: string }; status: number }
			const healthNext = vi.fn()
			await dispatch(health as never, healthNext)

			expect(health.body.status).toBe('OK')
			expect(health.status).toBe(200)
			// Answering here and calling next() would run the rest of the stack over a response that is
			// already written — the 200 stands, and whatever the next middleware writes is appended to it.
			expect(healthNext).not.toHaveBeenCalled()

			// ⚠️ Falls through rather than 404ing here: `router.routes()` sits *earlier* in the stack, so
			// by the time an unknown path reaches this arm the REST routes have already declined it, and
			// `router.allowedMethods()` is what turns that into a 404/405. Answering here would take the
			// verify-email routes' error handling away from the router that owns them.
			const other = { path: '/verify-email-user/x/y' }
			const otherNext = vi.fn()
			await dispatch(other as never, otherNext)

			expect(otherNext).toHaveBeenCalledOnce()
		} finally {
			await apolloServer.stop()
		}
	})

	// ⚠️ The arm that carries every GraphQL request, and the one no unit test drove until now: Stryker
	// reported the whole `if` body as NoCoverage and killed nothing when it flipped `ctx.path === ENDPOINT`
	// to `false`. A service that answers no GraphQL at all is not a subtle regression, and it was one
	// mutant away from shipping unnoticed — the integration suite catches it, but the mutation run does
	// not include the integration project.
	it('hands a request on the service’s own endpoint to Apollo, with this ctx as the GraphQL context', async () => {
		const { app, apolloServer } = await createServer()
		const dispatch = app.middleware.at(-1)!

		try {
			const graphql = { path: ENDPOINT }
			const graphqlNext = vi.fn()
			await dispatch(graphql as never, graphqlNext)

			// The dispatch returns Apollo's middleware rather than awaiting it and falling through, so
			// `next` is handed over, not called here: Apollo decides whether the stack continues.
			expect(apolloKoaMiddleware).toHaveBeenCalledExactlyOnceWith(graphql, graphqlNext)
			expect(graphqlNext).not.toHaveBeenCalled()

			// ⚠️ `context()` must answer *this* request's ctx. Returning anything else — a stale closure,
			// an empty object — compiles, serves, and leaves every resolver reading someone else's
			// session: `ctx.state.user` is how all three tiers are identified on this platform.
			expect(apolloKoaOptions).toHaveLength(1)
			await expect(apolloKoaOptions[0].context()).resolves.toBe(graphql)
		} finally {
			await apolloServer.stop()
		}
	})
})

describe('gracefulShutdown', () => {
	beforeEach(() => {
		captureMessage.mockReset()
		disconnectAllDatabases.mockReset()
	})

	it('drains Apollo, closes the server and disconnects with code 0', async () => {
		const apolloServer = { stop: vi.fn().mockResolvedValue(undefined) }
		const httpServer = { close: vi.fn((cb: () => void) => cb()) }

		await gracefulShutdown('SIGTERM', apolloServer as never, httpServer as never)

		expect(captureMessage).toHaveBeenCalledWith('SIGTERM received, shutting down gracefully...')
		expect(apolloServer.stop).toHaveBeenCalledTimes(1)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(0)
	})
})

describe('process handlers', () => {
	let exit: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})
	afterEach(() => exit.mockRestore())

	it('onUnhandledRejection reports the reason and exits 1', () => {
		const reason = new Error('boom')
		onUnhandledRejection(reason)
		expect(captureException).toHaveBeenCalledWith(reason)
		expect(exit).toHaveBeenCalledWith(1)
	})

	it('onUncaughtException reports the error and exits 1', () => {
		const error = new Error('kaboom')
		onUncaughtException(error)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(exit).toHaveBeenCalledWith(1)
	})
})

describe('start (failure path)', () => {
	let errorLog: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		captureException.mockReset()
		disconnectAllDatabases.mockReset()
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		RedisConnect.mockReset().mockResolvedValue(undefined)
		setupFieldEncryption.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		errorLog.mockRestore()
		vi.unstubAllEnvs()
	})

	it('reports to Sentry and disconnects with code 1 when Redis fails to connect', async () => {
		const error = new Error('redis boom')
		RedisConnect.mockRejectedValueOnce(error)

		await start()

		expect(RedisConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
	})

	it('reports to Sentry and disconnects with code 1 when MongoDB fails to connect', async () => {
		const error = new Error('mongo boom')
		MongoDBConnect.mockRejectedValueOnce(error)

		await start()

		expect(MongoDBConnect).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
	})

	// A service that came up with field encryption broken would answer queries with ciphertext and
	// write plaintext beside it, so this failure has to be as fatal as a datasource failure.
	it('reports to Sentry and disconnects with code 1 when field encryption cannot start', async () => {
		const error = new Error('CSFLE_MASTER_KEY_PATH is not set — field encryption cannot start without it')
		setupFieldEncryption.mockRejectedValueOnce(error)

		await start()

		expect(setupFieldEncryption).toHaveBeenCalledTimes(1)
		expect(captureException).toHaveBeenCalledWith(error)
		expect(disconnectAllDatabases).toHaveBeenCalledWith(1)
		expect(errorLog).toHaveBeenCalledExactlyOnceWith('error', error)
	})

	// checkRequiredEnv runs OUTSIDE the try, so a missing variable must propagate to the caller
	// instead of being swallowed into a disconnect-and-exit.
	it('throws out of start() — without touching the datasources — when a variable is missing', async () => {
		vi.stubEnv('MONGODB_URI', '')

		await expect(start()).rejects.toThrow('Missing required environment variable: MONGODB_URI')
		expect(MongoDBConnect).not.toHaveBeenCalled()
		expect(RedisConnect).not.toHaveBeenCalled()
		expect(disconnectAllDatabases).not.toHaveBeenCalled()
	})
})

describe('start (success path — the listen() call)', () => {
	let listenSpy: ReturnType<typeof vi.spyOn>
	let infoLog: ReturnType<typeof vi.spyOn>
	let srv: Awaited<ReturnType<typeof start>>

	beforeEach(() => {
		MongoDBConnect.mockReset().mockResolvedValue(undefined)
		RedisConnect.mockReset().mockResolvedValue(undefined)
		setupFieldEncryption.mockReset().mockResolvedValue(undefined)
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')
		vi.stubEnv('PORT', '4027')
		infoLog = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		// Never actually binds a socket: the callback is invoked synchronously, exactly like a real
		// listen() would once bound, so start() resolves without opening a port.
		listenSpy = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
			const cb = args.find((arg): arg is () => void => typeof arg === 'function')
			cb?.()
			return this
		})
	})

	afterEach(async () => {
		await srv?.apolloServer.stop()
		listenSpy.mockRestore()
		infoLog.mockRestore()
		vi.unstubAllEnvs()
	})

	// This is the regression guard for the bind fix: `hostname` is not a `net.Server.listen`
	// option (Node's is `host`), so it was always silently ignored and the server always bound
	// every interface regardless of HOSTNAME. Asserting the exact options object — no `host` key,
	// `port` from the environment — fails if a `host`/`hostname` key is ever reintroduced, and
	// fails just as loudly if `port` is ever dropped.
	it('calls listen with only { port }, no host/hostname key', async () => {
		srv = await start()

		expect(listenSpy).toHaveBeenCalledExactlyOnceWith({ port: '4027' }, expect.any(Function))
	})

	// Once, with no arguments: it reads its configuration from the environment, and a caller that
	// passed it anything would be building a second source of truth for the master key path.
	it('sets field encryption up exactly once, before the server is built', async () => {
		srv = await start()

		expect(setupFieldEncryption).toHaveBeenCalledExactlyOnceWith()
		expect(setupFieldEncryption.mock.invocationCallOrder[0]).toBeLessThan(listenSpy.mock.invocationCallOrder[0])
	})
})

// ⚠️ **`app.proxy` off is load-bearing, not an unset default nobody thought about.** With it off,
// `ctx.ip` is the socket address — nginx's own — so no client address is reachable in this process
// at all, which is the design: the per-caller rate limit is the edge's (`conf.d/20-rate-limit.conf`
// keys its zones on `$binary_remote_addr` after `real_ip_header CF-Connecting-IP`), and nothing here
// can write a visitor's address to Redis, to a log line or to Sentry. Turning it on would silently
// start trusting `X-Forwarded-For` and start producing real addresses everywhere `ctx.ip` is read.
// A comment cannot prevent that; this test can, and it is the reason the setting is never assigned.
describe('app.proxy', () => {
	it('is off on the constructed Koa app', async () => {
		for (const k of REQUIRED_ENV_VARS) vi.stubEnv(k, 'x')

		const { app, apolloServer } = await createServer()

		expect(app.proxy).toBeFalsy()

		await apolloServer.stop()
		vi.unstubAllEnvs()
	})
})
