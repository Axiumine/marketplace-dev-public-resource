import type { Context, Next } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

// The customer tier gets its own flow, its own route and its own stub, for the same reason: the two
// flows are bound to different models, so a shared handler would confirm a ShopOwner address against
// the `user` collection. Only `routerVerifyEmailUser` is stubbed here — `setEmailHashUser` is exported
// from the same module and used by the registration resolvers, so it has to stay on the mock's shape.
const verifyEmailHandlerUser = vi.fn()
const routerVerifyEmailUser = vi.fn(() => verifyEmailHandlerUser)

vi.mock('../src/lib/access/verifyEmailFlowUser.mts', () => ({ routerVerifyEmailUser, setEmailHashUser: vi.fn() }))

const { default: router } = await import('../src/middleware/router/index.mts')

// Minimal ctx to drive router.routes() directly: @koa/router's dispatch only reads
// ctx.method / ctx.path (host matching is skipped when the router has no `host` option) and
// writes the captured params onto ctx.request.params / ctx.params. No Koa app or http server
// is needed to exercise route matching and handler dispatch.
function makeCtx(method: string, path: string): Context {
	return { method, path, request: {} } as unknown as Context
}

const noopNext: Next = async () => {}

// The two handler stubs are module-level, so a call made by one dispatch test is still on the mock
// when the next one runs — which is what makes "the other tier's handler was not reached" assertable.
// The FACTORY mocks are deliberately left alone: they record a call made once at module load, before
// any test body ran, and clearing them would erase the only evidence that the wiring happened.
beforeEach(() => {
	verifyEmailHandler.mockClear()
	verifyEmailHandlerUser.mockClear()
})

describe('router', () => {
	it('carries the /check prefix', () => {
		expect(router.opts.prefix).toBe('/check')
	})

	it('registers exactly three GET routes', () => {
		expect(router.stack).toHaveLength(3)

		expect(router.stack[0].path).toBe('/check')
		expect(router.stack[0].methods).toContain('GET')

		expect(router.stack[1].path).toBe('/check/verify-email/:email/:hash')
		expect(router.stack[1].methods).toContain('GET')

		expect(router.stack[2].path).toBe('/check/verify-email-user/:email/:hash')
		expect(router.stack[2].methods).toContain('GET')
	})

	it('builds each verify-email handler once, at module load', () => {
		expect(routerVerifyEmail).toHaveBeenCalledTimes(1)
		expect(routerVerifyEmail).toHaveBeenCalledWith()

		expect(routerVerifyEmailUser).toHaveBeenCalledTimes(1)
		expect(routerVerifyEmailUser).toHaveBeenCalledWith()
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
		const ctx = makeCtx('GET', '/check/verify-email/mark%40test.it/abc123hash')

		await router.routes()(ctx, noopNext)

		expect(verifyEmailHandler).toHaveBeenCalledTimes(1)
		expect(verifyEmailHandler.mock.calls[0][0].params).toEqual({
			email: 'mark@test.it',
			hash: 'abc123hash'
		})
	})
})

describe('GET /check/verify-email-user/:email/:hash', () => {
	it('reaches the customer handler with the decoded params, and not the ShopOwner one', async () => {
		const ctx = makeCtx('GET', '/check/verify-email-user/anna%40test.it/def456hash')

		await router.routes()(ctx, noopNext)

		expect(verifyEmailHandlerUser).toHaveBeenCalledTimes(1)
		expect(verifyEmailHandlerUser.mock.calls[0][0].params).toEqual({
			email: 'anna@test.it',
			hash: 'def456hash'
		})

		// The paths share a prefix, so this is the assertion that matters: `/verify-email-user/...` must
		// not also match `/verify-email/:email/:hash` with `email` captured as the literal `-user`.
		expect(verifyEmailHandler).not.toHaveBeenCalled()
	})
})
