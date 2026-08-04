import { MongoDBDisconnect } from '@axiumine/koa-utils/dataSources/MongoDB'
import { RedisDisconnect } from '@axiumine/koa-utils/dataSources/Redis'
import * as Sentry from '@sentry/node'

/**
 * Disconnects from all databases and exits the process
 * @param exitCode - The exit code to use when terminating the process
 */
export async function disconnectAllDatabases(exitCode: number = 0): Promise<never> {
	const DISCONNECT_TIMEOUT = 5000 // 5 seconds timeout
	let code = exitCode
	let error: unknown = null

	// Only the disconnection is guarded: it is the sole thing whose failure justifies exit 1.
	try {
		await Promise.race([
			Promise.all([MongoDBDisconnect(), RedisDisconnect()]),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Database disconnection timeout')), DISCONNECT_TIMEOUT))
		])
	} catch (e) {
		error = e
		code = 1
	}

	// Telemetry sits outside that try and is best-effort: reporting must never decide the exit code.
	// While captureMessage() and process.exit() both lived inside the try, a Sentry outage on the
	// success path was caught below and silently turned the requested exitCode into 1.
	try {
		if (error === null) Sentry.captureMessage('All databases disconnected successfully', 'info')
		else Sentry.captureException(error, { extra: { detail: 'Error during database disconnection' } })
	} catch {
		// nothing left to report to; the exit code below is what matters
	}

	// Single exit point, unreachable by any catch above.
	process.exit(code)
}
