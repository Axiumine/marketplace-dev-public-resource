import { Binary } from 'mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emailHash = vi.fn(() => 'n'.repeat(50))

vi.mock('@axiumine/koa-utils/lib/emailHash', () => ({ emailHash }))

const pendingSlot = vi.fn()
const readPendingRegistration = vi.fn()
const renewPendingRegistration = vi.fn()

vi.mock('../src/lib/registration/pendingRegistration.mts', () => ({
	pendingSlot,
	readPendingRegistration,
	renewPendingRegistration
}))

const REGISTRATION_TARGET_USER = { __sentinel: 'user' }

vi.mock('../src/lib/registration/registrationTargets.mts', () => ({ REGISTRATION_TARGET_USER }))

const { createResendRegistration } = await import('../src/lib/registration/resendRegistration.mts')

const CIPHERTEXT = new Binary(Buffer.from('0102ff', 'hex'), Binary.SUBTYPE_ENCRYPTED)
const SLOT = { key: 'mp:pending:user:0102ff', email: CIPHERTEXT }

const sendVerifyEmail = vi.fn()

const target = {
	tier: 'user' as const,
	model: {} as never,
	waitApprov: false,
	encryptEmail: vi.fn(),
	sendVerifyEmail
}

const resendRegistration = createResendRegistration(target)

const record = {
	_id: undefined as never,
	email: CIPHERTEXT,
	password: '$2b$14$' + 'z'.repeat(53),
	hash: 'h'.repeat(50),
	registeredAt: new Date('2026-08-29T10:00:00.000Z'),
	dateLastReq: new Date('2026-08-29T10:00:00.000Z'),
	requestTimes: 3
}

beforeEach(() => {
	vi.clearAllMocks()
	pendingSlot.mockResolvedValue(SLOT)
	readPendingRegistration.mockResolvedValue(record)
})

describe('resendRegistration — a registration is pending', () => {
	it('re-mints the hash and sends the new link', async () => {
		await resendRegistration('anna@test.it')

		expect(pendingSlot).toHaveBeenCalledExactlyOnceWith(target, 'anna@test.it')
		expect(renewPendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT, 'n'.repeat(50), expect.any(Date))
		expect(sendVerifyEmail).toHaveBeenCalledExactlyOnceWith('anna@test.it', 'n'.repeat(50))
	})

	// One hash, minted once and used twice. Two `emailHash()` calls would store one and send the other,
	// and every resent link would be dead on arrival — while also spending a strike on the person using it.
	it('sends the hash it stored', async () => {
		await resendRegistration('anna@test.it')

		expect(emailHash).toHaveBeenCalledOnce()
		expect(sendVerifyEmail.mock.calls[0][1]).toBe(renewPendingRegistration.mock.calls[0][1])
	})

	// ⚠️ Written before it is sent, for the same reason submit is: a link that overtakes the record it
	// names is dead on the first click, and indistinguishable from a wrong hash to the person holding it.
	it('renews the record before it sends the link', async () => {
		await resendRegistration('anna@test.it')

		expect(renewPendingRegistration.mock.invocationCallOrder[0]).toBeLessThan(sendVerifyEmail.mock.invocationCallOrder[0])
	})

	// The new link's window starts now rather than at submission, which is what makes a resend worth
	// asking for at all — otherwise a registration two days old would buy a link that lives one more day.
	it('stamps the renewal with the current time', async () => {
		const before = Date.now()

		await resendRegistration('anna@test.it')

		const at = renewPendingRegistration.mock.calls[0][2] as Date

		expect(at.getTime()).toBeGreaterThanOrEqual(before)
		expect(at.getTime()).toBeLessThanOrEqual(Date.now())
	})

	// The record is not rewritten from the argument list: the address and the password stay whatever the
	// submission put there. This module hands `renewPendingRegistration` a slot and a hash and nothing else.
	it('hands the renewal nothing but the slot, the hash and the clock', async () => {
		await resendRegistration('anna@test.it')

		expect(renewPendingRegistration.mock.calls[0]).toHaveLength(3)
		expect(renewPendingRegistration.mock.calls[0][0]).toBe(SLOT)
	})
})

describe('resendRegistration — nothing is pending', () => {
	beforeEach(() => readPendingRegistration.mockResolvedValue(null))

	// ⚠️ **The read is what makes this safe.** `renewPendingRegistration` writes three fields, and `HSET`
	// builds a key it does not find — so against an expired or consumed registration it would *create* a
	// record holding a hash and nothing else: no id, no address, no password. The confirm step could not
	// turn that into an account, and it would sit there looking like a live link for three days.
	it('writes nothing at all', async () => {
		await resendRegistration('anna@test.it')

		expect(readPendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
		expect(renewPendingRegistration).not.toHaveBeenCalled()
		expect(emailHash).not.toHaveBeenCalled()
	})

	// ⚠️ **And sends nothing.** A resend that mailed an address with no pending registration would be a
	// free way to mail any address the platform's own sender can reach, out of an unauthenticated
	// mutation — and would also answer, by the arrival of the mail, whether the address is registered.
	it('sends no mail, so the mutation tells a caller nothing', async () => {
		await resendRegistration('anna@test.it')

		expect(sendVerifyEmail).not.toHaveBeenCalled()
	})

	// Both branches resolve the same way. The resolver answers `true` for every address, and it can only
	// do that because this function refuses to distinguish them.
	it('resolves exactly as the pending branch does', async () => {
		await expect(resendRegistration('anna@test.it')).resolves.toBeUndefined()

		readPendingRegistration.mockResolvedValueOnce(record)

		await expect(resendRegistration('anna@test.it')).resolves.toBeUndefined()
	})

	// The read comes first, so an address nobody registered still costs one `HGETALL` and no more — and
	// the key it reads is the one the tier and the address derive, never a scan.
	it('reads the slot before it decides', async () => {
		await resendRegistration('anna@test.it')

		expect(pendingSlot.mock.invocationCallOrder[0]).toBeLessThan(readPendingRegistration.mock.invocationCallOrder[0])
	})
})

describe('the bound resend', () => {
	it('exists for the customer tier', async () => {
		const module = await import('../src/lib/registration/resendRegistration.mts')

		expect(module.resendUserRegistration).toBeTypeOf('function')
	})

	// ⚠️ **No shop-owner twin, and none is missing.** That tier's form carries no resend button; submitting
	// the registration again is its recovery, and it lands on the same key, mints a new hash and re-arms
	// the window (ADR-042). An export here with no mutation behind it would read as one that got dropped.
	it('has no shop-owner twin', async () => {
		const module = await import('../src/lib/registration/resendRegistration.mts')

		expect(Object.keys(module).sort()).toEqual(['createResendRegistration', 'resendUserRegistration'])
	})
})
