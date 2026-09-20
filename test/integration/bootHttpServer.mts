import type { AddressInfo } from 'node:net'

import type { Server } from 'http'

import { start } from '../../src/index.mts'

/**
 * Boots the real server against the real Redis cluster / MongoDB and returns the pair every
 * `beforeAll` in this directory needs: the listening `httpServer` and the base URL to hit it on.
 *
 * Shared rather than repeated per file, because it is exactly the boot every integration suite here
 * performs — a second copy is not a second behaviour, only a second place a rename of `start()`'s
 * return shape could go unnoticed in one file while this one keeps compiling.
 */
export async function bootHttpServer(): Promise<{ httpServer: Server; base: string }> {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	const httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')

	return { httpServer, base: `http://127.0.0.1:${address.port}` }
}
