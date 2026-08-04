import type { Context, Next } from 'koa'
import { describe, expect, it, vi } from 'vitest'

// routerVerifyEmail() is a factory called once, at module load, to build the handler mounted
// on the verify-email route. Mocking it keeps the real implementation (which hits MongoDB
// through userData4VerifyEmail) out of this unit test — only dispatch to the stub is asserted.
//
// The mock target is the LOCAL module, not '@axiumine/koa-utils/koa/router/verifyEmail'. The package
// export is the same handler pre-bound to koa-utils' own UserBase model — collection 'user', which
// this platform does not have — so it is no longer what the router mounts; what binds the flow to
// ShopOwner is pinned in verifyEmailFlow.test.mts.
const verifyEmailHandler = vi.fn()
const routerVerifyEmail = vi.fn(() => verifyEmailHandler)

vi.mock('../src/lib/access/verifyEmailFlow.mts', () => ({ routerVerifyEmail }))

const { default: router } = await import('../src/middleware/router/index.mts')

// Minimal ctx to drive router.routes() directly: @koa/router's dispatch only reads
// ctx.method / ctx.path (host matching is skipped when the router has no `host` option) and
// writes the captured params onto ctx.request.params / ctx.params. No Koa app or http server
// is needed to exercise route matching and handler dispatch.
function makeCtx(method: string, path: string): Context {
	return { method, path, request: {} } as unknown as Context
}

const noopNext: Next = async () => {}

describe('router', () => {
	it('carries the /check prefix', () => {
		expect(router.opts.prefix).toBe('/check')
	})

	it('registers exactly two GET routes', () => {
		expect(router.stack).toHaveLength(2)

		expect(router.stack[0].path).toBe('/check')
		expect(router.stack[0].methods).toContain('GET')

		expect(router.stack[1].path).toBe('/check/verify-email/:email/:hash')
		expect(router.stack[1].methods).toContain('GET')
	})

	it('builds the verify-email handler once, at module load', () => {
		expect(routerVerifyEmail).toHaveBeenCalledTimes(1)
		expect(routerVerifyEmail).toHaveBeenCalledWith()
	})
})

describe('GET /check/', () => {
	it('sets ctx.body to the empty string', async () => {
		const ctx = makeCtx('GET', '/check/')

		await router.routes()(ctx, noopNext)

		expect(ctx.body).toBe('')
	})
})

describe('GET /check/verify-email/:email/:hash', () => {
	it('reaches the mocked handler with the decoded params, including a URL-encoded email', async () => {
		const ctx = makeCtx('GET', '/check/verify-email/mario%40test.it/abc123hash')

		await router.routes()(ctx, noopNext)

		expect(verifyEmailHandler).toHaveBeenCalledTimes(1)
		expect(verifyEmailHandler.mock.calls[0][0].params).toEqual({
			email: 'mario@test.it',
			hash: 'abc123hash'
		})
	})
})
