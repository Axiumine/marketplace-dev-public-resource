import type { RouterContext } from '@koa/router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirmUserRegistration = vi.fn()
const confirmShopOwnerRegistration = vi.fn()

vi.mock('../src/lib/registration/confirmRegistration.mts', () => ({
	confirmShopOwnerRegistration,
	confirmUserRegistration,
	REGISTRATION_DONE_LINK: '/x/registration-done'
}))

// ⚠️ `isSafeRedirectTarget` is deliberately NOT mocked. It is the whole of the open-redirect defence on
// this handler, and a stub would turn the attack strings below into assertions about the stub.
const { createConfirmRegistrationRouter, ERROR_LINK } = await import('../src/lib/registration/confirmRegistrationRouter.mts')

const confirmRegistration = vi.fn()
const handler = createConfirmRegistrationRouter(confirmRegistration)

const redirect = vi.fn()

const context = (params: Record<string, string>) => ({ params, redirect }) as unknown as RouterContext

beforeEach(() => vi.clearAllMocks())

describe('the handler’s two happy details', () => {
	it('confirms the address and hash the route captured', async () => {
		await handler(context({ email: 'anna@test.it', hash: 'h'.repeat(50) }))

		expect(confirmRegistration).toHaveBeenCalledExactlyOnceWith('anna@test.it', 'h'.repeat(50))
	})

	it('sends a confirmed registration to the done page', async () => {
		await handler(context({ email: 'anna@test.it', hash: 'h'.repeat(50) }))

		expect(redirect).toHaveBeenCalledExactlyOnceWith('/x/registration-done')
	})
})

describe('the address as it arrives from the link', () => {
	// ⚠️ The pending key is the hex of a *deterministic* ciphertext, so `Anna@Test.it` and `anna@test.it`
	// are two different keys and only one of them holds the record. A mail client that capitalised the
	// link — or a person retyping it — would otherwise get a dead-link page for a live registration.
	it('lower-cases the address before it looks anything up', async () => {
		await handler(context({ email: 'Anna@Test.IT', hash: 'h'.repeat(50) }))

		expect(confirmRegistration.mock.calls[0][0]).toBe('anna@test.it')
	})

	// Same reason as the case fold: `%20` around a pasted link decodes to a space, and a space is part of
	// the plaintext the cipher is derived from.
	it('trims the whitespace a pasted link brings with it', async () => {
		await handler(context({ email: '  anna@test.it  ', hash: 'h'.repeat(50) }))

		expect(confirmRegistration.mock.calls[0][0]).toBe('anna@test.it')
	})

	// The hash is compared byte for byte against the stored one, so folding or trimming it would make a
	// wrong hash pass — and would make the strike counter fire on links that are merely mistyped.
	it('leaves the hash exactly as the link carried it', async () => {
		await handler(context({ email: 'anna@test.it', hash: ' AbC ' }))

		expect(confirmRegistration.mock.calls[0][1]).toBe(' AbC ')
	})
})

describe('the handler’s refusals', () => {
	// The whole redirect contract of the old `createVerifyEmailRouter`: a refusal throws the page it wants,
	// and the handler is what turns that into a redirect. Every refusal in `confirmRegistration` throws
	// this one page, so the browser cannot tell a dead link from a wrong hash.
	it('follows the page a refusal named', async () => {
		confirmRegistration.mockRejectedValueOnce(new Error('/x/email-check'))

		await handler(context({ email: 'anna@test.it', hash: 'wrong' }))

		expect(redirect).toHaveBeenCalledExactlyOnceWith('/x/email-check')
	})

	// ⚠️ A throw nobody planned for — Redis down, MongoDB unreachable — must not reach the browser as a
	// stack trace, and must not be swallowed into a success page either: the account was not opened.
	it('sends an unplanned throw to the error page', async () => {
		confirmRegistration.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))

		await handler(context({ email: 'anna@test.it', hash: 'h'.repeat(50) }))

		expect(redirect).toHaveBeenCalledExactlyOnceWith(ERROR_LINK)
	})

	it('names its own error page', () => {
		expect(ERROR_LINK).toBe('/x/error')
	})

	// A rejection that is not an `Error` at all still has to land somewhere. `(err as Error).message` is
	// `undefined` for a thrown string, and `undefined` is not a safe target — so it takes the error page
	// rather than throwing a second time inside the `catch`.
	it('survives a rejection that carries no message', async () => {
		confirmRegistration.mockRejectedValueOnce('nope')

		await expect(handler(context({ email: 'anna@test.it', hash: 'x' }))).resolves.toBeUndefined()

		expect(redirect).toHaveBeenCalledExactlyOnceWith(ERROR_LINK)
	})

	it('redirects once, never twice', async () => {
		confirmRegistration.mockRejectedValueOnce(new Error('/x/email-check'))

		await handler(context({ email: 'anna@test.it', hash: 'wrong' }))

		expect(redirect).toHaveBeenCalledOnce()
	})
})

describe('the open redirect this handler would otherwise be', () => {
	// ⚠️ **The message being redirected to is derived from a request parameter.** `confirmRegistration`
	// only ever throws `/x/email-check`, but the handler cannot know that, and the address it was handed
	// reaches MongoDB and Redis on the way — a driver that quotes the input back in its error message is
	// all it takes for an attacker to choose the redirect target. The allowlist is what stops that, and
	// these strings are the ones `isSafeRedirectTarget` exists to reject.
	//
	// `.` and `/` are inside the allowed class on purpose, so `/x/../../evil` is *accepted* — and is not a
	// finding: the prefix is literal, the target stays a same-origin path, and the browser resolves it to
	// one. What the allowlist stops is a target that leaves the origin.
	it.each([
		['//evil.com', 'protocol-relative — a browser reads this as another origin'],
		['https://evil.com', 'absolute, with a scheme'],
		['/x/\\evil.com', 'a backslash, which several browsers read as a separator'],
		['/registration-done', 'an in-origin path outside /x/'],
		['javascript:alert(1)', 'a scheme that is not a location at all'],
		['', 'nothing at all']
	])('refuses %s (%s)', async (target) => {
		confirmRegistration.mockRejectedValueOnce(new Error(target))

		await handler(context({ email: 'anna@test.it', hash: 'x' }))

		expect(redirect).toHaveBeenCalledExactlyOnceWith(ERROR_LINK)
	})

	// The other half of the allowlist: a page genuinely under the prefix is followed, so the assertions
	// above are about *what* is refused rather than about a guard that refuses everything.
	it.each(['/x/email-check', '/x/registration-done', '/x/some-page%20name'])('follows %s', async (target) => {
		confirmRegistration.mockRejectedValueOnce(new Error(target))

		await handler(context({ email: 'anna@test.it', hash: 'x' }))

		expect(redirect).toHaveBeenCalledExactlyOnceWith(target)
	})
})

describe('the two mounted handlers', () => {
	// ⚠️ Values, not factories. koa-utils' router exports were `() => handler` and were called at mount;
	// these are the middleware itself, so `router.get(path, routerConfirmUserRegistration)` is right and
	// `router.get(path, routerConfirmUserRegistration())` would mount `undefined`.
	it('are middlewares, one per tier, already bound', async () => {
		const { routerConfirmShopOwnerRegistration, routerConfirmUserRegistration } =
			await import('../src/lib/registration/confirmRegistrationRouter.mts')

		expect(routerConfirmUserRegistration).toBeTypeOf('function')
		expect(routerConfirmShopOwnerRegistration).toBeTypeOf('function')
		expect(routerConfirmUserRegistration).not.toBe(routerConfirmShopOwnerRegistration)
	})

	// ⚠️ The two routes differ only in path, and both take an address — so a customer's link handled by
	// the shop-owner confirm would look for the record under the wrong tier's key and, worse, would open a
	// `shopOwner` account for somebody who asked to be a customer.
	it('reach the confirmation of their own tier', async () => {
		const { routerConfirmShopOwnerRegistration, routerConfirmUserRegistration } =
			await import('../src/lib/registration/confirmRegistrationRouter.mts')

		await routerConfirmUserRegistration(context({ email: 'anna@test.it', hash: 'h' }))
		expect(confirmUserRegistration).toHaveBeenCalledExactlyOnceWith('anna@test.it', 'h')
		expect(confirmShopOwnerRegistration).not.toHaveBeenCalled()

		await routerConfirmShopOwnerRegistration(context({ email: 'mark@test.it', hash: 'g' }))
		expect(confirmShopOwnerRegistration).toHaveBeenCalledExactlyOnceWith('mark@test.it', 'g')
		expect(confirmUserRegistration).toHaveBeenCalledOnce()
	})
})
