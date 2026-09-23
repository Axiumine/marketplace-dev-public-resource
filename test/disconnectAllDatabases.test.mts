import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MongoDBDisconnect = vi.fn()
const RedisDisconnect = vi.fn()
const captureMessage = vi.fn()
const captureException = vi.fn()
const flush = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/MongoDB', () => ({ MongoDBDisconnect }))
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ RedisDisconnect }))
vi.mock('@sentry/node', () => ({ captureMessage, captureException, flush }))

const { disconnectAllDatabases } = await import('../src/lib/db/disconnectAllDatabases.mts')

// process.exit is neutralized to a no-op: the function has a `never` return type, the no-op
// lets it carry on and the exit code is read from the spy without killing the vitest worker.
let exit: ReturnType<typeof vi.spyOn>

describe('disconnectAllDatabases', () => {
	beforeEach(() => {
		MongoDBDisconnect.mockReset().mockResolvedValue(undefined)
		RedisDisconnect.mockReset().mockResolvedValue(undefined)
		captureMessage.mockReset()
		captureException.mockReset()
		flush.mockReset().mockResolvedValue(true)
		exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('disconnects MongoDB and Redis and exits with 0 by default', async () => {
		await disconnectAllDatabases()

		expect(MongoDBDisconnect).toHaveBeenCalledTimes(1)
		expect(RedisDisconnect).toHaveBeenCalledTimes(1)
		expect(captureMessage).toHaveBeenCalledWith('All databases disconnected successfully', 'info')
		expect(exit).toHaveBeenCalledExactlyOnceWith(0)
	})

	it('propagates the requested exit code', async () => {
		await disconnectAllDatabases(3)

		expect(exit).toHaveBeenCalledExactlyOnceWith(3)
	})

	it('exits with 1 and reports to Sentry if Redis disconnection fails', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { detail: 'Error during database disconnection' }
		})
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('exits with 1 and reports to Sentry if MongoDB disconnection fails', async () => {
		MongoDBDisconnect.mockRejectedValueOnce(new Error('mongo down'))

		await disconnectAllDatabases()

		expect(captureMessage).not.toHaveBeenCalled()
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { detail: 'Error during database disconnection' }
		})
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('exits with 1 if the disconnection exceeds the 5s timeout', async () => {
		vi.useFakeTimers()
		MongoDBDisconnect.mockReturnValueOnce(new Promise(() => {})) // never resolves
		RedisDisconnect.mockReturnValueOnce(new Promise(() => {})) // never resolves

		const pending = disconnectAllDatabases()
		await vi.advanceTimersByTimeAsync(5000)
		await pending

		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).toMatchObject({ message: 'Database disconnection timeout' })
		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	// Regression guard: telemetry is best-effort and must never decide the exit code. Before the
	// fix, captureMessage() and process.exit() both sat inside the try, so a Sentry outage on the
	// success path was caught and turned the requested exitCode into 1.
	it('keeps the requested exit code when captureMessage throws on the success path', async () => {
		captureMessage.mockImplementationOnce(() => {
			throw new Error('sentry down')
		})

		await disconnectAllDatabases(7)

		expect(exit).toHaveBeenCalledExactlyOnceWith(7)
		expect(captureException).not.toHaveBeenCalled()
	})

	it('still exits with 1 when the disconnection failed and captureException also throws', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))
		captureException.mockImplementationOnce(() => {
			throw new Error('sentry down')
		})

		await disconnectAllDatabases(7)

		expect(exit).toHaveBeenCalledExactlyOnceWith(1)
	})

	it('does not report a success message when the disconnection failed', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases(1)

		expect(captureMessage).not.toHaveBeenCalled()
	})

	// ⚠️ **B14, closed.** `captureMessage`/`captureException` only queue an event — delivery is an
	// outbound HTTPS call the SDK batches for later — and this function's `process.exit()` is where
	// every fatal path on this service actually leaves. A capture with nothing after it but that exit
	// never reaches Sentry, which is exactly the crash where an alert matters most.
	it('flushes Sentry before exiting, on the success path', async () => {
		await disconnectAllDatabases()

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
	})

	it('flushes Sentry before exiting, on the failure path too', async () => {
		RedisDisconnect.mockRejectedValueOnce(new Error('redis down'))

		await disconnectAllDatabases()

		expect(flush).toHaveBeenCalledExactlyOnceWith(2000)
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
	})
})
