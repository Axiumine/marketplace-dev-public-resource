import http from 'http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const captureException = vi.fn()
const captureMessage = vi.fn()
const MongoDBConnect = vi.fn()
const RedisConnect = vi.fn()
const disconnectAllDatabases = vi.fn()
// Captured constructor/factory arguments for the two real, unmocked config objects createServer()
// builds (koa-bodyparser's options, ApolloServer's options). Both wrappers delegate to the real
// implementation — body parsing and the Apollo instance still behave exactly as in production —
// they only additionally record what they were called with, so the option literals themselves
// (enableTypes, extendTypes, plugins, csrfPrevention) have something asserting their exact value
// instead of merely being reached.
const bodyParserOptions: unknown[] = []
const apolloServerOptions: { pluginCount: number | undefined; csrfPrevention: unknown }[] = []

vi.mock('@sentry/node', () => ({ captureException, captureMessage }))
// The datasources are imported transitively by the router and the reset-password flow; bare stubs
// are enough because the unit project never really connects — http.Server.prototype.listen is
// stubbed too, below, so the success path can run without opening a socket.
vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBConnect }))
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisConnect, redisClient: {} }))
vi.mock('@lib/db/disconnectAllDatabases.mjs', () => ({ disconnectAllDatabases }))
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
})
