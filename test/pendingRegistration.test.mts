import { Binary } from 'mongodb'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisClient = {
	hSet: vi.fn(),
	expire: vi.fn(),
	hGetAll: vi.fn(),
	hIncrBy: vi.fn(),
	del: vi.fn()
}

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))

// Pinned rather than taken from the machine, so the key assertions below state that the prefix comes
// from `REDIS_KEY` instead of merely agreeing with whatever is set. `pendingSlot` reads the variable
// per call, which is what lets one build serve two environments — and what makes the assertion below
// possible at all.
process.env.REDIS_KEY = 'mp:test:'

const {
	deletePendingRegistration,
	MAX_VERIFY_ATTEMPTS,
	PENDING_TTL_SECONDS,
	pendingSlot,
	readPendingRegistration,
	renewPendingRegistration,
	strikePendingRegistration,
	writePendingRegistration
} = await import('../src/lib/registration/pendingRegistration.mts')

const CIPHERTEXT = new Binary(Buffer.from('0102ff', 'hex'), Binary.SUBTYPE_ENCRYPTED)
const HEX = '0102ff'

const target = {
	tier: 'user' as const,
	model: {} as never,
	waitApprov: false,
	encryptEmail: vi.fn(async () => CIPHERTEXT),
	sendVerifyEmail: vi.fn()
}

const slot = { key: `mp:test:pending:user:${HEX}`, email: CIPHERTEXT }

const ID = new Types.ObjectId('66c0ffee0000000000000001')
const REGISTERED_AT = new Date('2026-08-29T10:00:00.000Z')
const LAST_REQ = new Date('2026-08-29T10:00:01.000Z')

const record = {
	_id: ID,
	password: '$2b$14$' + 'x'.repeat(53),
	hash: 'h'.repeat(50),
	registeredAt: REGISTERED_AT,
	dateLastReq: LAST_REQ,
	requestTimes: 1
}

beforeEach(() => vi.clearAllMocks())

describe('the window and the strike ceiling', () => {
	// Three days, in seconds. Spelled as a product rather than as 259200 so a change is legible, and
	// asserted as the number so the product cannot quietly become a different one.
	it('keeps koa-utils’ three-day activation window', () => {
		expect(PENDING_TTL_SECONDS).toBe(259200)
	})

	it('keeps koa-utils’ five-strike ceiling', () => {
		expect(MAX_VERIFY_ATTEMPTS).toBe(5)
	})
})

describe('pendingSlot', () => {
	// ⚠️ The key is the ciphertext, hex-encoded — not a digest of the address and not the address. A
	// digest would key the record just as well and would cost the reuse: this same `Binary` is what the
	// confirm step inserts into `login.email`.
	it('keys the record on the hex of the deterministic ciphertext', async () => {
		expect(await pendingSlot(target, 'anna@test.it')).toEqual({
			key: `mp:test:pending:user:${HEX}`,
			email: CIPHERTEXT
		})

		expect(target.encryptEmail).toHaveBeenCalledExactlyOnceWith('anna@test.it')
	})

	// The address itself must never be part of a Redis key: keys are readable in `MONITOR`, in a slow
	// log and in any dump, and none of those is a place personal data may sit (ADR-043).
	it('puts no readable address in the key', async () => {
		const { key } = await pendingSlot(target, 'anna@test.it')

		expect(key).not.toContain('anna')
		expect(key).not.toContain('@')
	})

	// ⚠️ `user` and `shopOwner` are unrelated collections (ADR-002) and one person may hold an account
	// in both with the same address. Without the tier in the key, registering as one would overwrite a
	// pending registration for the other.
	it('separates the two tiers under the same address', async () => {
		const asUser = await pendingSlot(target, 'anna@test.it')
		const asShopOwner = await pendingSlot({ ...target, tier: 'shopOwner' }, 'anna@test.it')

		expect(asUser.key).toContain(':pending:user:')
		expect(asShopOwner.key).toContain(':pending:shopOwner:')
		expect(asUser.key).not.toBe(asShopOwner.key)
	})

	it('takes its prefix from REDIS_KEY', async () => {
		process.env.REDIS_KEY = 'other:'

		expect((await pendingSlot(target, 'anna@test.it')).key).toBe(`other:pending:user:${HEX}`)

		process.env.REDIS_KEY = 'mp:test:'
	})
})

describe('writePendingRegistration', () => {
	it('writes every field the confirm step needs, as strings', async () => {
		await writePendingRegistration(slot, record)

		expect(redisClient.hSet).toHaveBeenCalledExactlyOnceWith(slot.key, {
			id: '66c0ffee0000000000000001',
			email: HEX,
			password: record.password,
			hash: record.hash,
			registeredAt: `${REGISTERED_AT.getTime()}`,
			dateLastReq: `${LAST_REQ.getTime()}`,
			requestTimes: '1'
		})
	})

	// ⚠️ **The one risk ADR-042 names.** `HSET` on a missing key creates it with no TTL, so a write that
	// forgot its `EXPIRE` would hold that address's slot for ever — and a test on a fresh Redis would
	// still pass. Both the call and its order are pinned.
	it('arms the TTL, after the write', async () => {
		await writePendingRegistration(slot, record)

		expect(redisClient.expire).toHaveBeenCalledExactlyOnceWith(slot.key, PENDING_TTL_SECONDS)
		expect(redisClient.hSet.mock.invocationCallOrder[0]).toBeLessThan(redisClient.expire.mock.invocationCallOrder[0])
	})

	// The address in the record and the address the key is derived from are one value read twice from
	// the slot, so no caller can hand in a record whose `login.email` is not the one it is filed under.
	it('takes the address from the slot rather than from the record', async () => {
		await writePendingRegistration({ key: 'k', email: new Binary(Buffer.from('ab', 'hex'), 6) }, record)

		expect(redisClient.hSet.mock.calls[0][1].email).toBe('ab')
	})

	// One key, never two. A second key — an index, a set of pending addresses — would be a `CROSSSLOT`
	// error on the cluster the platform runs.
	it('touches exactly one key', async () => {
		await writePendingRegistration(slot, record)

		expect(redisClient.hSet.mock.calls[0][0]).toBe(slot.key)
		expect(redisClient.expire.mock.calls[0][0]).toBe(slot.key)
	})
})

describe('readPendingRegistration', () => {
	const stored = {
		id: '66c0ffee0000000000000001',
		email: HEX,
		password: record.password,
		hash: record.hash,
		registeredAt: `${REGISTERED_AT.getTime()}`,
		dateLastReq: `${LAST_REQ.getTime()}`,
		requestTimes: '3'
	}

	it('rebuilds the record from the stored strings', async () => {
		redisClient.hGetAll.mockResolvedValueOnce(stored)

		expect(await readPendingRegistration(slot.key)).toEqual({
			_id: ID,
			email: CIPHERTEXT,
			password: record.password,
			hash: record.hash,
			registeredAt: REGISTERED_AT,
			dateLastReq: LAST_REQ,
			requestTimes: 3
		})
	})

	// ⚠️ Subtype 6, not the default 0. `isCiphertext` tests the subtype, so a `Binary` rebuilt with the
	// generic one would be re-encrypted by the model's `pre('insertMany')` pass — a `binData` that
	// decrypts to a `binData`, and an account nobody can ever log into.
	it('rebuilds the address as encrypted binary, so the model leaves it alone', async () => {
		redisClient.hGetAll.mockResolvedValueOnce(stored)

		const read = await readPendingRegistration(slot.key)

		expect(read?.email).toBeInstanceOf(Binary)
		expect(read?.email.sub_type).toBe(Binary.SUBTYPE_ENCRYPTED)
		expect(read?.email.sub_type).toBe(6)
		// `Binary#buffer` types as the plain `Uint8Array` bson declares it, not the Node `Buffer` it
		// actually is — `.equals` is a `Buffer`-only method the type doesn't carry. `toEqual` compares
		// typed arrays byte for byte, which is the same check.
		expect(read?.email.buffer).toEqual(CIPHERTEXT.buffer)
	})

	// `HGETALL` answers `{}` for a key that does not exist rather than a nil, so the absence has to be
	// read off a field. Expired, never written and already consumed are deliberately one answer.
	it('answers null for a key that is not there', async () => {
		redisClient.hGetAll.mockResolvedValueOnce({})

		expect(await readPendingRegistration(slot.key)).toBeNull()
	})

	// A record that lost its hash cannot open anything, so it is dead in exactly the way an absent one
	// is — and reading it as live would hand `undefined` to a `!==` comparison against a URL parameter.
	it('answers null for a record with no hash', async () => {
		redisClient.hGetAll.mockResolvedValueOnce({ ...stored, hash: undefined })

		expect(await readPendingRegistration(slot.key)).toBeNull()
	})

	it('reads the key it was given, and only reads', async () => {
		redisClient.hGetAll.mockResolvedValueOnce(stored)

		await readPendingRegistration(slot.key)

		expect(redisClient.hGetAll).toHaveBeenCalledExactlyOnceWith(slot.key)
		expect(redisClient.hSet).not.toHaveBeenCalled()
		expect(redisClient.expire).not.toHaveBeenCalled()
	})
})

describe('strikePendingRegistration', () => {
	it('counts one wrong hash against the record', async () => {
		await strikePendingRegistration(slot.key)

		expect(redisClient.hIncrBy).toHaveBeenCalledExactlyOnceWith(slot.key, 'requestTimes', 1)
	})

	// ⚠️ **The assertion this module exists for.** Re-arming the TTL on a failed attempt would let
	// anybody keep somebody else's pending registration alive indefinitely by guessing at the link. A
	// wrong hash spends a strike; it does not buy time.
	it('does not re-arm the TTL', async () => {
		await strikePendingRegistration(slot.key)

		expect(redisClient.expire).not.toHaveBeenCalled()
	})
})

describe('deletePendingRegistration', () => {
	it('removes the record', async () => {
		await deletePendingRegistration(slot.key)

		expect(redisClient.del).toHaveBeenCalledExactlyOnceWith(slot.key)
	})
})

describe('renewPendingRegistration', () => {
	const at = new Date('2026-08-30T09:00:00.000Z')

	// The strikes counted attempts against the old hash, so they go with it — the same thing koa-utils'
	// `setEmailHash` did on the document.
	it('re-mints the hash, the window and the strike count', async () => {
		await renewPendingRegistration(slot, 'n'.repeat(50), at)

		expect(redisClient.hSet).toHaveBeenCalledExactlyOnceWith(slot.key, {
			hash: 'n'.repeat(50),
			dateLastReq: `${at.getTime()}`,
			requestTimes: '1'
		})
	})

	// ⚠️ A resend re-sends a registration; it does not restart one. Rewriting `id` would open the account
	// under a different `_id` and lose the replay guard, and rewriting `password` from here would let an
	// argument list with no password in it change one.
	it('leaves the id, the password and the submission time alone', async () => {
		await renewPendingRegistration(slot, 'n'.repeat(50), at)

		expect(Object.keys(redisClient.hSet.mock.calls[0][1])).toEqual(['hash', 'dateLastReq', 'requestTimes'])
	})

	it('re-arms the TTL, so a resent link lives the full window', async () => {
		await renewPendingRegistration(slot, 'n'.repeat(50), at)

		expect(redisClient.expire).toHaveBeenCalledExactlyOnceWith(slot.key, PENDING_TTL_SECONDS)
	})
})
