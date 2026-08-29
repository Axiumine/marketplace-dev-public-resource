import {
	ENCRYPTED_FIELDS_SHOP_OWNER,
	ENCRYPTED_FIELDS_USER,
	KEY_ALT_NAME_SHOP_OWNER,
	KEY_ALT_NAME_USER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Binary } from 'mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real thing reaches libmongocrypt and a data key in `encryption.__keyVault`, neither of which a
// unit test has. What is pinned here is which list and which key it is handed, and that the ciphertext
// it produces for `login.email` is what comes back — the encryption itself is marketplace-common's and
// is tested there.
const encryptDocument = vi.fn(async (document: { login: { email: unknown } }) => ({
	login: { email: new Binary(Buffer.from('beef', 'hex'), Binary.SUBTYPE_ENCRYPTED) },
	__plaintext: document.login.email
}))

vi.mock('@axiumine/marketplace-common/encryption/encryptDocument', () => ({ encryptDocument }))

// Both senders build a `SocketLabsLib` and reach the network. Only identity is asserted below, so a
// sentinel is enough — and it is what makes "the customer's link is not sent on the admin domain"
// assertable without sending anything.
const sendUserVerifyEmail = vi.fn()
const sendShopOwnerVerifyEmail = vi.fn()

vi.mock('../src/lib/access/sendUserVerifyEmail.mts', () => ({ sendUserVerifyEmail }))
vi.mock('../src/lib/access/sendShopOwnerVerifyEmail.mts', () => ({ sendShopOwnerVerifyEmail }))

const { EMAIL_PATH, REGISTRATION_TARGET_SHOP_OWNER, REGISTRATION_TARGET_USER } =
	await import('../src/lib/registration/registrationTargets.mts')

beforeEach(() => vi.clearAllMocks())

describe('EMAIL_PATH', () => {
	it('is the login address path', () => {
		expect(EMAIL_PATH).toBe('login.email')
	})

	// ⚠️ The path is spelled here rather than read out of a koa-utils paths map, because those maps went
	// with the flows they configured (ADR-042). A rename in marketplace-common must therefore fail here
	// — the alternative is a filter that matches nothing and a registration that silently reports every
	// address as free.
	it('resolves on both collections’ real schemas', () => {
		expect(User.schema.path(EMAIL_PATH)).toBeDefined()
		expect(ShopOwner.schema.path(EMAIL_PATH)).toBeDefined()
	})
})

describe('REGISTRATION_TARGET_USER', () => {
	it('names the customer collection and its tier', () => {
		expect(REGISTRATION_TARGET_USER.tier).toBe(TIER.user)
		expect(REGISTRATION_TARGET_USER.model).toBe(User)
		expect(User.collection.name).toBe('user')
	})

	// A customer is admitted by confirming their address and by nothing else. There is no approval queue
	// on this tier, and a `true` here would park every registration behind one nobody reads.
	it('opens the account outright', () => {
		expect(REGISTRATION_TARGET_USER.waitApprov).toBe(false)
	})

	// ⚠️ `APP_DOMAIN_USER`, not `APP_DOMAIN`. One process serves two audiences and the two links differ
	// in host as well as path; a customer who followed the admin's would land on a panel that cannot
	// complete the activation.
	it('sends the link on the storefront sender', () => {
		expect(REGISTRATION_TARGET_USER.sendVerifyEmail).toBe(sendUserVerifyEmail)
	})

	it('encrypts under the customer key, with the customer field list', async () => {
		await REGISTRATION_TARGET_USER.encryptEmail('anna@test.it')

		expect(encryptDocument).toHaveBeenCalledExactlyOnceWith(
			{ login: { email: 'anna@test.it' } },
			ENCRYPTED_FIELDS_USER,
			KEY_ALT_NAME_USER
		)
	})
})

describe('REGISTRATION_TARGET_SHOP_OWNER', () => {
	it('names the seller collection and its tier', () => {
		expect(REGISTRATION_TARGET_SHOP_OWNER.tier).toBe(TIER.shopOwner)
		expect(REGISTRATION_TARGET_SHOP_OWNER.model).toBe(ShopOwner)
		expect(ShopOwner.collection.name).toBe('shopOwner')
	})

	// ⚠️ **The one asymmetry between the two targets, and the reason the public seller form is safe to
	// expose.** Selling is a commercial relationship with the admin, so a stranger may ask to become
	// a shop owner but may not become one by filling in a form: `checkShopOwnerApproval` refuses a
	// session at login and at every refresh while this flag is up.
	it('parks the account behind the approval queue', () => {
		expect(REGISTRATION_TARGET_SHOP_OWNER.waitApprov).toBe(true)
	})

	it('sends the link on the admin sender', () => {
		expect(REGISTRATION_TARGET_SHOP_OWNER.sendVerifyEmail).toBe(sendShopOwnerVerifyEmail)
	})

	it('encrypts under the seller key, with the seller field list', async () => {
		await REGISTRATION_TARGET_SHOP_OWNER.encryptEmail('mark@test.it')

		expect(encryptDocument).toHaveBeenCalledExactlyOnceWith(
			{ login: { email: 'mark@test.it' } },
			ENCRYPTED_FIELDS_SHOP_OWNER,
			KEY_ALT_NAME_SHOP_OWNER
		)
	})

	// ⚠️ Two collections, two data keys, two ciphertexts for one address — which is exactly why the
	// pending key carries the tier. Sharing a key here would make one tier's record findable under the
	// other's, and would put a `shopOwner` ciphertext into a `user` document.
	it('does not share the customer’s data key', () => {
		expect(KEY_ALT_NAME_SHOP_OWNER).not.toBe(KEY_ALT_NAME_USER)
	})
})

describe('encryptLoginEmail', () => {
	// The derivation ADR-043 asks for: the algorithm is whatever the field list says, read from the same
	// list the model's own plugin reads. Restating `ALGORITHM_DETERMINISTIC` here would be the second
	// enumeration that ADR's compliance section greps for — and would go on working, wrongly, on the day
	// the list changes.
	it('takes the algorithm from the field list rather than naming one', async () => {
		await REGISTRATION_TARGET_USER.encryptEmail('anna@test.it')

		expect(encryptDocument.mock.calls[0]).toHaveLength(3)
		expect(encryptDocument.mock.calls[0][1]).toBe(ENCRYPTED_FIELDS_USER)
	})

	it('hands back the ciphertext the document came home with', async () => {
		const email = await REGISTRATION_TARGET_USER.encryptEmail('anna@test.it')

		expect(email).toBeInstanceOf(Binary)
		expect(email.sub_type).toBe(Binary.SUBTYPE_ENCRYPTED)
		expect(email.buffer.toString('hex')).toBe('beef')
	})

	// ⚠️ **The guard is not defensive noise.** If `login.email` ever left the encrypted lists every other
	// part of this flow would keep working — a plaintext string hexes into a perfectly good Redis key —
	// and the failure would surface as personal data sitting in Redis in the clear, which is the one
	// thing ADR-043 exists to prevent. It fails at the first registration instead.
	it('refuses an address that came back in the clear', async () => {
		encryptDocument.mockResolvedValueOnce({ login: { email: 'anna@test.it' } } as never)

		await expect(REGISTRATION_TARGET_USER.encryptEmail('anna@test.it')).rejects.toThrow(
			'encryptLoginEmail: login.email came back in the clear — it is no longer an encrypted field'
		)
	})

	// The refusal names the path from the constant, so a rename cannot leave the message pointing at a
	// field that no longer exists.
	it('names the path it expected to find encrypted', async () => {
		encryptDocument.mockResolvedValueOnce({ login: { email: 'anna@test.it' } } as never)

		await expect(REGISTRATION_TARGET_USER.encryptEmail('anna@test.it')).rejects.toThrow(EMAIL_PATH)
	})
})
