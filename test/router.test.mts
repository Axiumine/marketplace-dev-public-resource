import type { RouterContext } from '@koa/router'
import type { Next } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The two confirmation handlers are values, not factories: `createConfirmRegistrationRouter` is called at
// module load inside `confirmRegistrationRouter.mts` and what this router mounts is the middleware itself.
// Stubbing them keeps Redis, MongoDB and SocketLabs out of a routing test — only dispatch is asserted here;
// what each handler does with the pair is `confirmRegistrationRouter.test.mts`.
//
// ⚠️ The mock target is the LOCAL module, never `@axiumine/koa-utils/koa/router/verifyEmail`. That export
// reads a half-built account out of the package's own `UserBase` model — collection `user`, which no
// migration here creates — and after ADR-042 there is no half-built document to read in any collection.
const routerConfirmShopOwnerRegistration = vi.fn()
const routerConfirmUserRegistration = vi.fn()

vi.mock('../src/lib/registration/confirmRegistrationRouter.mts', () => ({
	routerConfirmShopOwnerRegistration,
	routerConfirmUserRegistration
}))

const { default: router } = await import('../src/middleware/router/index.mts')

// Minimal ctx to drive router.routes() directly: @koa/router's dispatch only reads
// ctx.method / ctx.path (host matching is skipped when the router has no `host` option) and
// writes the captured params onto ctx.request.params / ctx.params. No Koa app or http server
// is needed to exercise route matching and handler dispatch.
function makeCtx(method: string, path: string): RouterContext {
	return { method, path, request: {} } as unknown as RouterContext
}

const noopNext: Next = async () => {}

// The two stubs are module-level, so a call made by one dispatch test is still on the mock when the next
// one runs — which is what makes "the other tier's handler was not reached" assertable.
beforeEach(() => {
	routerConfirmShopOwnerRegistration.mockClear()
	routerConfirmUserRegistration.mockClear()
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

	// ⚠️ The handlers are mounted as values. koa-utils' router exports were `() => handler` and were called
	// at mount; mounting one of these the same way would hand `@koa/router` the result of calling the
	// middleware with no context — `undefined` — and every confirmation link would 404 at run time while
	// this suite went on passing.
	it('mounts the middlewares themselves rather than calling them', () => {
		expect(router.stack[1].stack).toContain(routerConfirmShopOwnerRegistration)
		expect(router.stack[2].stack).toContain(routerConfirmUserRegistration)

		expect(routerConfirmShopOwnerRegistration).not.toHaveBeenCalled()
		expect(routerConfirmUserRegistration).not.toHaveBeenCalled()
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

		expect(routerConfirmShopOwnerRegistration).toHaveBeenCalledTimes(1)
		expect(routerConfirmShopOwnerRegistration.mock.calls[0][0].params).toEqual({
			email: 'mark@test.it',
			hash: 'abc123hash'
		})
	})
})

describe('GET /check/verify-email-user/:email/:hash', () => {
	it('reaches the customer handler with the decoded params, and not the ShopOwner one', async () => {
		const ctx = makeCtx('GET', '/check/verify-email-user/anna%40test.it/def456hash')

		await router.routes()(ctx, noopNext)

		expect(routerConfirmUserRegistration).toHaveBeenCalledTimes(1)
		expect(routerConfirmUserRegistration.mock.calls[0][0].params).toEqual({
			email: 'anna@test.it',
			hash: 'def456hash'
		})

		// The paths share a prefix, so this is the assertion that matters: `/verify-email-user/...` must
		// not also match `/verify-email/:email/:hash` with `email` captured as the literal `-user`.
		expect(routerConfirmShopOwnerRegistration).not.toHaveBeenCalled()
	})
})
