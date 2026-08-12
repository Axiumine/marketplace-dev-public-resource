import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmailVerify = vi.fn()
// A function expression, not an arrow: the source calls `new SocketLabsLib()`, and an arrow is not a
// constructor. Returning an object from a constructor call is what makes it the instance.
const SocketLabsLib = vi.fn(function mockSocketLabsLib() {
	return { sendEmailVerify }
})

vi.mock('@axiumine/koa-utils/email/SocketLabsLib', () => ({ SocketLabsLib }))

const APP_DOMAIN = 'https://operator.test'

const { sendShopOwnerVerifyEmail, SHOP_OWNER_VERIFY_LINK_PATH } = await import('../src/lib/access/sendShopOwnerVerifyEmail.mts')

beforeEach(() => {
	vi.clearAllMocks()
	process.env.APP_DOMAIN = APP_DOMAIN
})

describe('sendShopOwnerVerifyEmail', () => {
	// ⚠️ The literal is asserted whole because nothing joins it to the router at runtime. `/check` is the
	// `@koa/router` prefix and `/verify-email` is the route; this string is what goes in the mail, built
	// from a different variable in a different file. Changing one and not the other produces a link that
	// 404s with no error anywhere on the platform — the seller simply never activates.
	it('points at the mounted seller route, prefix included', () => {
		expect(SHOP_OWNER_VERIFY_LINK_PATH).toBe('/check/verify-email')
	})

	// ⚠️ **Not `-user`.** Both routes live in this one process and neither can tell an email plus a hash
	// apart from the other's; the customer's path is `/check/verify-email-user`, and sending a seller
	// there resolves to the flow bound to the `user` collection, which reports every seller link as a bad
	// hash and counts a strike against a registration it cannot see.
	it('does not send the customer’s path', () => {
		expect(SHOP_OWNER_VERIFY_LINK_PATH).not.toBe('/check/verify-email-user')
	})

	// ⚠️ **`APP_DOMAIN`, the operator-facing domain, passed explicitly.** It is what `SocketLabsLib` would
	// have defaulted to, so the mail is the same either way today; spelling it out is what makes the
	// difference from `sendUserVerifyEmail` — which must override both — a decision a reader can see
	// rather than a parameter nobody noticed.
	it('sends the operator domain and the seller path', async () => {
		await sendShopOwnerVerifyEmail('seller@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify).toHaveBeenCalledExactlyOnceWith(
			'seller@marketplace.test',
			'a1b2c3',
			'',
			APP_DOMAIN,
			'/check/verify-email'
		)
	})

	// The third argument is the recipient's name, and there is none: `personalData` became optional on
	// `shopOwner` for exactly this mutation, so at the moment this mail is sent the platform genuinely
	// does not know who it is writing to. Onboarding asks later.
	it('addresses nobody by name, because at registration there is no name yet', async () => {
		await sendShopOwnerVerifyEmail('seller@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify.mock.calls[0][2]).toBe('')
	})

	// With the variable unset the call passes `undefined` and koa-utils falls back to the same
	// `APP_DOMAIN` the constructor read — so a misconfigured environment cannot make this path send a
	// link that is broken in a way the customer path's fallback would not also be.
	it('forwards an unset domain rather than substituting one', async () => {
		delete process.env.APP_DOMAIN

		await sendShopOwnerVerifyEmail('seller@marketplace.test', 'a1b2c3')

		expect(sendEmailVerify.mock.calls[0][3]).toBeUndefined()
	})

	// A fresh client per send. `SocketLabsLib` reads its credentials and `APP_DOMAIN` in the constructor,
	// so a module-level instance would pin the environment as it was at import time.
	it('builds a client per send', async () => {
		await sendShopOwnerVerifyEmail('first@marketplace.test', 'hash-1')
		await sendShopOwnerVerifyEmail('second@marketplace.test', 'hash-2')

		expect(SocketLabsLib).toHaveBeenCalledTimes(2)
		expect(SocketLabsLib).toHaveBeenCalledWith()
	})

	// The send is awaited, so a refusal from SocketLabs reaches the resolver and rolls its transaction
	// back. A registration whose mail never left would otherwise sit unverifiable, holding its unique
	// address, until the three-day abandon timer released it.
	it('awaits the send, so a failed mail fails the caller', async () => {
		sendEmailVerify.mockRejectedValueOnce(new Error('SocketLabs refused'))

		await expect(sendShopOwnerVerifyEmail('seller@marketplace.test', 'a1b2c3')).rejects.toThrow('SocketLabs refused')
	})
})
