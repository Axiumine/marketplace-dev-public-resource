import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmailVerify = vi.fn()
// A function expression, not an arrow: the source calls `new SocketLabsLib()`, and an arrow is not a
// constructor. Returning an object from a constructor call is what makes it the instance.
const SocketLabsLib = vi.fn(function mockSocketLabsLib() {
	return { sendEmailVerify }
})

vi.mock('@axiumine/koa-utils/email/SocketLabsLib', () => ({ SocketLabsLib }))

const APP_DOMAIN_USER = 'https://storefront.test'

const { sendUserVerifyEmail, USER_VERIFY_LINK_PATH } = await import('../src/lib/access/sendUserVerifyEmail.mts')

beforeEach(() => {
	vi.clearAllMocks()
	process.env.APP_DOMAIN_USER = APP_DOMAIN_USER
})

describe('sendUserVerifyEmail', () => {
	// ⚠️ The literal is asserted whole because nothing joins it to the router at runtime. `/check` is the
	// `@koa/router` prefix and `/verify-email-user` is the route; this string is what goes in the mail,
	// built from a different variable in a different file. Changing one and not the other produces a link
	// that 404s with no error anywhere on the platform — the customer simply never activates.
	it('points at the mounted customer route, prefix included', () => {
		expect(USER_VERIFY_LINK_PATH).toBe('/check/verify-email-user')
	})

	// ⚠️ **`APP_DOMAIN_USER`, not `APP_DOMAIN`.** One process sends two audiences' links: the shop
	// owner's goes to the operator-facing domain `SocketLabsLib` reads at construction, the customer's
	// must go to the storefront. Passing the base per-call is the only reason both can leave this service.
	it('sends the storefront domain and the customer path, not the constructor’s defaults', async () => {
		await sendUserVerifyEmail('customer@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify).toHaveBeenCalledExactlyOnceWith(
			'customer@marketplace.test',
			'a1b2c3',
			'',
			APP_DOMAIN_USER,
			'/check/verify-email-user'
		)
	})

	// The third argument is the recipient's name, and there is none: `personalData` is optional on this
	// tier and registration is an address plus a password, so at the moment this mail is sent the platform
	// genuinely does not know who it is writing to.
	it('addresses nobody by name, because at registration there is no name yet', async () => {
		await sendUserVerifyEmail('customer@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify.mock.calls[0][2]).toBe('')
	})

	// With the variable unset the call passes `undefined` and koa-utils falls back to `APP_DOMAIN`, so a
	// misconfigured environment sends a *working* link on the wrong domain rather than a broken one —
	// visible to whoever clicks it, and it costs nobody their registration.
	it('forwards an unset domain rather than substituting one', async () => {
		delete process.env.APP_DOMAIN_USER

		await sendUserVerifyEmail('customer@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify.mock.calls[0][3]).toBeUndefined()
	})

	// A fresh client per send. `SocketLabsLib` reads its credentials and `APP_DOMAIN` in the constructor,
	// so a module-level instance would pin the environment as it was at import time — which is exactly
	// the trap the `linkBase` parameter above exists to get out of.
	it('builds a client per send', async () => {
		await sendUserVerifyEmail('first@marketplace.test', 'hash-1')
		await sendUserVerifyEmail('second@marketplace.test', 'hash-2')

		expect(SocketLabsLib).toHaveBeenCalledTimes(2)
		expect(SocketLabsLib).toHaveBeenCalledWith()
	})

	// The send is awaited, so a refusal from SocketLabs reaches the resolver and rolls its transaction
	// back. A registration whose mail never left would otherwise sit unverifiable, holding its unique
	// address, until the three-day abandon timer released it.
	it('awaits the send, so a failed mail fails the caller', async () => {
		sendEmailVerify.mockRejectedValueOnce(new Error('SocketLabs refused'))

		await expect(sendUserVerifyEmail('customer@marketplace.test', 'a1b2c3')).rejects.toThrow('SocketLabs refused')
	})
})
