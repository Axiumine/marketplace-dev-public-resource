import { Binary } from 'mongodb'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chain } from './support/queryChain.mts'

const emailHash = vi.fn(() => 'h'.repeat(50))
// A hash that shares nothing with the plaintext, so "the record carries no readable password" is an
// assertion rather than a coincidence of the stub.
const HASHED = '$2b$14$' + 'z'.repeat(53)
const encryptPassword = vi.fn(async () => HASHED)

vi.mock('@axiumine/koa-utils/lib/emailHash', () => ({ emailHash }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))

const pendingSlot = vi.fn()
const writePendingRegistration = vi.fn()

vi.mock('../src/lib/registration/pendingRegistration.mts', () => ({ pendingSlot, writePendingRegistration }))

const registrationMailer = { emailAlreadyValid: vi.fn() }

vi.mock('../src/lib/registration/registrationMailer.mts', () => ({ registrationMailer }))

// The two bound exports are built at module load from the real targets, which reach two models and two
// senders. Only the factory is exercised here, against a target this file controls; that the bindings
// carry the right model, key and sender is `registrationTargets.test.mts`.
const REGISTRATION_TARGET_USER = { __sentinel: 'user' }
const REGISTRATION_TARGET_SHOP_OWNER = { __sentinel: 'shopOwner' }

vi.mock('../src/lib/registration/registrationTargets.mts', () => ({
	EMAIL_PATH: 'login.email',
	REGISTRATION_TARGET_SHOP_OWNER,
	REGISTRATION_TARGET_USER
}))

const { createSubmitRegistration } = await import('../src/lib/registration/submitRegistration.mts')

const CIPHERTEXT = new Binary(Buffer.from('0102ff', 'hex'), Binary.SUBTYPE_ENCRYPTED)
const SLOT = { key: 'mp:pending:user:0102ff', email: CIPHERTEXT }

const findOne = vi.fn()
const sendVerifyEmail = vi.fn()

const target = {
	tier: 'user' as const,
	model: { findOne } as never,
	waitApprov: false,
	encryptEmail: vi.fn(),
	sendVerifyEmail
}

const submitRegistration = createSubmitRegistration(target)

/** What the projected read answers: `null`, a live document, or one with `deleted` stamped. */
function accountIs(existing: unknown) {
	findOne.mockReturnValueOnce(chain(existing))
}

beforeEach(() => {
	vi.clearAllMocks()
	pendingSlot.mockResolvedValue(SLOT)
})

describe('submitRegistration — the read', () => {
	// ⚠️ No liveness filter, deliberately: a closed document still occupies the address, so the branch
	// has to see it rather than have it filtered away. The projection is one field because nothing here
	// needs `login.password` in scope.
	it('looks the address up by the encrypted path, projecting only the closure stamp', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(findOne).toHaveBeenCalledExactlyOnceWith({ 'login.email': 'anna@test.it' }, 'deleted')
	})

	// `login.email` is deterministically encrypted, so the plaintext handed to `findOne` is rewritten by
	// the model's own filter hook into the one ciphertext the unique index holds. That is what makes this
	// an indexed `$eq` rather than a scan, and it is why nothing here encrypts the address itself.
	it('hands the filter the plaintext and lets the model’s hook encrypt it', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(findOne.mock.calls[0][0]['login.email']).toBe('anna@test.it')
	})
})

describe('submitRegistration — a live account holds the address', () => {
	beforeEach(() => accountIs({ _id: new Types.ObjectId() }))

	// The one message that helps the address's owner (they forgot they registered) without telling
	// anybody else that the address is taken.
	it('mails “you are already registered”', async () => {
		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(registrationMailer.emailAlreadyValid).toHaveBeenCalledExactlyOnceWith('anna@test.it')
	})

	// ⚠️ **Nothing is written and no link is sent.** A pending record here would let anybody overwrite
	// the slot of an address they do not own, and — since the confirm step reclaims whatever the record
	// names — hand them a link to somebody else's address.
	it('writes no pending record and sends no link', async () => {
		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(writePendingRegistration).not.toHaveBeenCalled()
		expect(sendVerifyEmail).not.toHaveBeenCalled()
		expect(pendingSlot).not.toHaveBeenCalled()
	})

	// The password never reaches bcrypt on this branch, which is the cheap half of the point: a
	// 14-round hash is over a second of CPU, and this is the branch an enumeration sweep would hit.
	it('does not hash the password it was handed', async () => {
		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(encryptPassword).not.toHaveBeenCalled()
	})
})

describe('submitRegistration — the address is free', () => {
	it('writes the pending record and sends the link, for an address nobody holds', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(pendingSlot).toHaveBeenCalledExactlyOnceWith(target, 'anna@test.it')
		expect(writePendingRegistration).toHaveBeenCalledOnce()
		expect(sendVerifyEmail).toHaveBeenCalledExactlyOnceWith('anna@test.it', 'h'.repeat(50))
		expect(registrationMailer.emailAlreadyValid).not.toHaveBeenCalled()
	})

	// ⚠️ **A closed account is not touched here.** The owner's ruling is that its address is reclaimed
	// "when he will click the link to confirm the email, not before that", and an anonymous form post is
	// not a click. Until somebody proves they can read mail at the address, all this flow has created is
	// a key that expires on its own.
	it('registers over a closed account without disturbing it', async () => {
		accountIs({ deleted: new Date('2026-08-01T00:00:00.000Z') })

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(writePendingRegistration).toHaveBeenCalledOnce()
		expect(sendVerifyEmail).toHaveBeenCalledOnce()
		expect(registrationMailer.emailAlreadyValid).not.toHaveBeenCalled()
	})

	it('mints the id, hashes the password and starts the strike count at one', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		const [slot, record] = writePendingRegistration.mock.calls[0]

		expect(slot).toBe(SLOT)
		expect(record._id).toBeInstanceOf(Types.ObjectId)
		expect(record.password).toBe(HASHED)
		expect(record.hash).toBe('h'.repeat(50))
		expect(record.requestTimes).toBe(1)
	})

	// ⚠️ **bcrypt here rather than at confirm**, so the plaintext password never outlives the request
	// that carried it — it is not in Redis and it is not in the record the confirm step reads. The
	// account is opened with `insertMany`, which runs no `save` middleware, so this value lands in
	// `login.password` exactly as it is; hashing in both places is what stored `bcrypt(bcrypt(password))`
	// in E18-S09.
	it('puts no readable password in the record', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(encryptPassword).toHaveBeenCalledExactlyOnceWith('Passw0rd!')
		expect(writePendingRegistration.mock.calls[0][1].password).not.toContain('Passw0rd!')
	})

	// One clock reading for both stamps, so `registeredAt` and `dateLastReq` cannot disagree by the
	// microseconds between two `new Date()` calls — which would read, later, as a registration that was
	// resent before it was submitted.
	it('stamps submission and issue from one reading of the clock', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		const { registeredAt, dateLastReq } = writePendingRegistration.mock.calls[0][1]

		expect(registeredAt).toBeInstanceOf(Date)
		expect(registeredAt.getTime()).toBe(dateLastReq.getTime())
	})

	// ⚠️ The record is written before the mail is sent, and it has to be: a link that arrives before the
	// record it names would be dead on the first click, and the person would have no way to tell that
	// from a wrong hash.
	it('writes the record before it sends the link', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(writePendingRegistration.mock.invocationCallOrder[0]).toBeLessThan(sendVerifyEmail.mock.invocationCallOrder[0])
	})

	// The hash in the mail is the hash in the record — one value, minted once. Two calls to `emailHash`
	// would send a link that never matches.
	it('sends the hash it stored', async () => {
		accountIs(null)

		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(emailHash).toHaveBeenCalledOnce()
		expect(sendVerifyEmail.mock.calls[0][1]).toBe(writePendingRegistration.mock.calls[0][1].hash)
	})

	// A second submit is not a special case: same address, same tier, same key — so it overwrites and
	// re-arms the TTL. That is also how somebody who never received the first mail recovers.
	it('overwrites the same key on a second submit', async () => {
		accountIs(null)
		await submitRegistration('anna@test.it', 'Passw0rd!')

		accountIs(null)
		await submitRegistration('anna@test.it', 'Passw0rd!')

		expect(writePendingRegistration.mock.calls.map((call) => call[0].key)).toEqual([SLOT.key, SLOT.key])
	})
})

describe('the two bound submits', () => {
	// Named exports rather than a factory call at each resolver: one instance per tier, so the two
	// mutations cannot drift onto different bindings.
	it('exist, one per tier', async () => {
		const { submitShopOwnerRegistration, submitUserRegistration } =
			await import('../src/lib/registration/submitRegistration.mts')

		expect(submitUserRegistration).toBeTypeOf('function')
		expect(submitShopOwnerRegistration).toBeTypeOf('function')
		expect(submitUserRegistration).not.toBe(submitShopOwnerRegistration)
	})
})
