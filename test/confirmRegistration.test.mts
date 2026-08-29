import { Binary } from 'mongodb'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chain, TRUSTED } from './support/queryChain.mts'

const buildAccountScrub = vi.fn(() => ({ $set: { 'login.email': 'scrubbed' }, $unset: { personalData: '' } }))

vi.mock('@axiumine/marketplace-common/others/accountScrub', () => ({ buildAccountScrub }))

const deletePendingRegistration = vi.fn()
const pendingSlot = vi.fn()
const readPendingRegistration = vi.fn()
const strikePendingRegistration = vi.fn()

vi.mock('../src/lib/registration/pendingRegistration.mts', () => ({
	deletePendingRegistration,
	MAX_VERIFY_ATTEMPTS: 5,
	pendingSlot,
	readPendingRegistration,
	strikePendingRegistration
}))

const registrationMailer = {
	tooMuchVerifyRequests: vi.fn(),
	wrongHash: vi.fn(),
	sendWelcome: vi.fn()
}

vi.mock('../src/lib/registration/registrationMailer.mts', () => ({ registrationMailer }))

const REGISTRATION_TARGET_USER = { __sentinel: 'user' }
const REGISTRATION_TARGET_SHOP_OWNER = { __sentinel: 'shopOwner' }

vi.mock('../src/lib/registration/registrationTargets.mts', () => ({
	EMAIL_PATH: 'login.email',
	REGISTRATION_TARGET_SHOP_OWNER,
	REGISTRATION_TARGET_USER
}))

// `withTransaction` is driven for real — it runs the callback and reports what it threw — because the
// order inside it is the whole of this module. `endSession` is asserted separately: a session leaked
// per confirmation exhausts the pool, and nothing else in the process would say so.
// Hoisted: `mongoose` is imported at the top of this file, so its factory runs before any plain `const`
// here has initialised.
const { endSession, session, startSession, withTransaction } = vi.hoisted(() => {
	const end = vi.fn()
	const inTransaction = vi.fn(async (body: () => Promise<void>) => {
		await body()
	})
	const handle = { withTransaction: inTransaction, endSession: end }

	return {
		endSession: end,
		session: handle,
		startSession: vi.fn(async () => handle),
		withTransaction: inTransaction
	}
})

vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()

	return { ...actual, default: { ...actual.default, startSession }, startSession }
})

const { createConfirmRegistration, EMAIL_CHECK_LINK, REGISTRATION_DONE_LINK } =
	await import('../src/lib/registration/confirmRegistration.mts')

const CIPHERTEXT = new Binary(Buffer.from('0102ff', 'hex'), Binary.SUBTYPE_ENCRYPTED)
const SLOT = { key: 'mp:pending:user:0102ff', email: CIPHERTEXT }
const HASH = 'h'.repeat(50)
const ID = new Types.ObjectId('66c0ffee0000000000000001')
const REGISTERED_AT = new Date('2026-08-29T10:00:00.000Z')
const HASHED = '$2b$14$' + 'z'.repeat(53)

const record = {
	_id: ID,
	email: CIPHERTEXT,
	password: HASHED,
	hash: HASH,
	registeredAt: REGISTERED_AT,
	dateLastReq: REGISTERED_AT,
	requestTimes: 1
}

const findOne = vi.fn()
const updateOne = vi.fn()
const insertMany = vi.fn()
const exists = vi.fn()

const target = {
	tier: 'user' as const,
	model: { findOne, updateOne, insertMany, exists } as never,
	waitApprov: false,
	encryptEmail: vi.fn(),
	sendVerifyEmail: vi.fn()
}

const confirmRegistration = createConfirmRegistration(target)
const confirmShopOwner = createConfirmRegistration({ ...target, tier: 'shopOwner', waitApprov: true })

/**
 * What the closed-holder lookup finds. The default below is "nobody holds it"; a test that wants a
 * holder queues one over the top, which is why this is a `...Once`.
 */
function closedHolderIs(closed: unknown) {
	findOne.mockReturnValueOnce(chain(closed))
}

beforeEach(() => {
	vi.clearAllMocks()
	pendingSlot.mockResolvedValue(SLOT)
	readPendingRegistration.mockResolvedValue(record)
	findOne.mockReturnValue(chain(null))
})

describe('the two redirect targets', () => {
	it('sends a confirmed registration to the done page', () => {
		expect(REGISTRATION_DONE_LINK).toBe('/x/registration-done')
	})

	// ⚠️ One destination for every refusal, and that is the design: dead link, expired record, wrong hash
	// and five strikes spent are only ever distinguishable to somebody who can read the mailbox.
	it('sends every refusal to the same check-your-mail page', () => {
		expect(EMAIL_CHECK_LINK).toBe('/x/email-check')
	})
})

describe('confirmRegistration — the guards', () => {
	it('refuses a link whose record is gone', async () => {
		readPendingRegistration.mockResolvedValueOnce(null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(startSession).not.toHaveBeenCalled()
		expect(insertMany).not.toHaveBeenCalled()
	})

	// Expired, never written and already consumed are one answer on purpose. No mail either — a dead
	// link that mailed the address would be a way to make the platform mail anybody, for free.
	it('sends nothing for a link whose record is gone', async () => {
		readPendingRegistration.mockResolvedValueOnce(null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(registrationMailer.wrongHash).not.toHaveBeenCalled()
		expect(registrationMailer.tooMuchVerifyRequests).not.toHaveBeenCalled()
		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	it('reads the record filed under this tier and this address', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(pendingSlot).toHaveBeenCalledExactlyOnceWith(target, 'anna@test.it')
		expect(readPendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// koa-utils' threshold and its off-by-one convention, both kept: `requestTimes` starts at 1, so the
	// fifth strike is the one that disposes of the record.
	it('disposes of a record whose strikes are spent, and says so', async () => {
		readPendingRegistration.mockResolvedValueOnce({ ...record, requestTimes: 5 })

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
		expect(registrationMailer.tooMuchVerifyRequests).toHaveBeenCalledExactlyOnceWith('anna@test.it')
		expect(insertMany).not.toHaveBeenCalled()
	})

	// The ceiling is a floor test, not an equality one: `hIncrBy` is not bounded, so a record that
	// somehow passed 5 must still be refused rather than wrap round into a valid one.
	it('refuses a record past the ceiling as well as one on it', async () => {
		readPendingRegistration.mockResolvedValueOnce({ ...record, requestTimes: 9 })

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(deletePendingRegistration).toHaveBeenCalledOnce()
	})

	it('lets the fourth strike through, and refuses the fifth', async () => {
		readPendingRegistration.mockResolvedValueOnce({ ...record, requestTimes: 4 })

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()

		expect(registrationMailer.tooMuchVerifyRequests).not.toHaveBeenCalled()
	})

	it('counts a wrong hash and names the strike it made', async () => {
		await expect(confirmRegistration('anna@test.it', 'wrong')).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(strikePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
		expect(registrationMailer.wrongHash).toHaveBeenCalledExactlyOnceWith('anna@test.it', 2)
		expect(insertMany).not.toHaveBeenCalled()
	})

	// ⚠️ A wrong hash spends a strike; it does not destroy the record. Somebody guessing at a link must
	// not be able to dispose of a stranger's registration in one request.
	it('leaves the record in place on a wrong hash', async () => {
		await expect(confirmRegistration('anna@test.it', 'wrong')).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	// The comparison is against the hash the record holds, never against the one in the URL. Comparing
	// the URL hash with itself is a mutant koa-utils' own suite once let through.
	it('compares the URL hash against the stored one', async () => {
		readPendingRegistration.mockResolvedValueOnce({ ...record, hash: 'stored' })

		await expect(confirmRegistration('anna@test.it', 'stored')).resolves.toBeUndefined()
		expect(insertMany).toHaveBeenCalledOnce()
	})

	// The ceiling is checked before the hash, so a spent record is disposed of rather than earning a
	// sixth strike and a second mail on every further guess.
	it('checks the ceiling before it checks the hash', async () => {
		readPendingRegistration.mockResolvedValueOnce({ ...record, requestTimes: 5 })

		await expect(confirmRegistration('anna@test.it', 'wrong')).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(registrationMailer.tooMuchVerifyRequests).toHaveBeenCalledOnce()
		expect(strikePendingRegistration).not.toHaveBeenCalled()
	})
})

describe('confirmRegistration — opening the account', () => {
	it('inserts the account the record describes, inside the transaction', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(insertMany).toHaveBeenCalledExactlyOnceWith(
			[
				{
					_id: ID,
					login: { email: CIPHERTEXT, password: HASHED },
					registeredAt: REGISTERED_AT,
					emailVerify: { valid: true }
				}
			],
			{ session }
		)
	})

	// ⚠️ **`insertMany`, never `create`.** `LoginSubDocSchema`'s `pre('save')` bcrypts `password` when the
	// path is modified and `create` routes through `save`, so a `create` here would store
	// `bcrypt(bcrypt(password))` and open an account nobody can ever log into. `insertMany` runs no `save`
	// middleware and still runs `pre('insertMany')`, whose encryption pass is idempotent over the `Binary`.
	it('uses the operator that runs no save middleware', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(insertMany).toHaveBeenCalledOnce()
		expect(insertMany.mock.calls[0][0][0].login.password).toBe(HASHED)
	})

	// The ciphertext Redis held is the value that reaches MongoDB — ADR-043's *confirm is a copy*.
	// Nothing on this path decrypts, and nothing re-encrypts: the plugin's `isCiphertext` check lets a
	// subtype-6 `Binary` through untouched.
	it('copies the stored ciphertext into login.email rather than re-deriving it', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(insertMany.mock.calls[0][0][0].login.email).toBe(CIPHERTEXT)
	})

	// ⚠️ `waitApprov` is written here or nowhere, so no path can open a shop-owner account that skips the
	// approval gate — and the customer's document must not carry the key at all, since `user` has no such
	// field and the validator is `additionalProperties: false`.
	it('parks a shop owner behind the approval queue, and a customer never', async () => {
		await confirmRegistration('anna@test.it', HASH)
		expect(insertMany.mock.calls[0][0][0]).not.toHaveProperty('waitApprov')

		await confirmShopOwner('mark@test.it', HASH)
		expect(insertMany.mock.calls[1][0][0].waitApprov).toBe(true)
	})

	// The three pending members — hash, window, strike count — were the Redis record, and the record is
	// gone. What survives is the one thing the verification produced.
	it('writes emailVerify with valid alone', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(insertMany.mock.calls[0][0][0].emailVerify).toEqual({ valid: true })
	})

	it('opens the session, uses it, and ends it', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(startSession).toHaveBeenCalledOnce()
		expect(withTransaction).toHaveBeenCalledOnce()
		expect(endSession).toHaveBeenCalledOnce()
	})

	// A session leaked per confirmation exhausts the pool, and a failing transaction is exactly when it
	// would leak — so the `finally` is asserted from the failing side too.
	it('ends the session even when the transaction throws', async () => {
		insertMany.mockRejectedValueOnce(new Error('write conflict'))
		exists.mockResolvedValueOnce(null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('write conflict')

		expect(endSession).toHaveBeenCalledOnce()
	})

	it('welcomes the person and consumes the record', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(registrationMailer.sendWelcome).toHaveBeenCalledExactlyOnceWith('anna@test.it')
		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// ⚠️ **The key is deleted after the transaction, never before it.** Deleting first would turn any
	// failure of the write into a registration that cannot be retried and cannot be recovered — the
	// person would have to start again with an address a closed account may still be holding.
	it('deletes the key only once the account is written', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(insertMany.mock.invocationCallOrder[0]).toBeLessThan(deletePendingRegistration.mock.invocationCallOrder[0])
	})

	it('leaves the key alone when the write fails', async () => {
		insertMany.mockRejectedValueOnce(new Error('write conflict'))
		exists.mockResolvedValueOnce(null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('write conflict')

		expect(deletePendingRegistration).not.toHaveBeenCalled()
		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
	})
})

describe('confirmRegistration — reclaiming the address', () => {
	const closedId = new Types.ObjectId('66c0ffee0000000000000002')

	it('does nothing when no closed account holds the address', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne).not.toHaveBeenCalled()
		expect(buildAccountScrub).not.toHaveBeenCalled()
	})

	// ⚠️ **`deleted` is in the filter, not merely checked by the caller.** A live document holding this
	// address never reaches here — submit answered "already registered" and wrote no record — but the
	// guard that matters is the one a future caller cannot skip by reading a branch wrongly.
	it('looks only for a closed holder, in the session', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		const [filter, projection] = findOne.mock.calls[0]

		expect(filter['login.email']).toBe(CIPHERTEXT)
		expect(filter.deleted.$exists).toBe(true)
		expect(projection).toBe('_id')
	})

	// `sanitizeFilter` is on globally, so a bare `{ $exists: true }` is cast to a literal to match
	// against — which matches nothing, so the scrub would silently skip and the insert would then fail on
	// the unique index. It fails safe, but it fails.
	it('marks the operator trusted, or it would match nothing', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		expect(findOne.mock.calls[0][0].deleted[TRUSTED]).toBe(true)
	})

	// The same update the retention sweep runs at day 30, built by the same function — a hand-written
	// second copy is how a field added to `user` survives one of the two paths in silence.
	it('scrubs the closed holder with the shared retention update', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		expect(buildAccountScrub).toHaveBeenCalledExactlyOnceWith('user', `${closedId}`, expect.any(Date))
		expect(updateOne).toHaveBeenCalledExactlyOnceWith({ _id: closedId }, buildAccountScrub.mock.results[0].value, {
			session,
			runValidators: true
		})
	})

	// The scrub is a plaintext update on purpose: `fieldEncryptionPlugin` encrypts `$set` operands on the
	// way past, and `runValidators` is what makes the collection's own `$jsonSchema` the last word on the
	// shape the overwrite leaves behind.
	it('validates the scrub against the collection', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.calls[0][2].runValidators).toBe(true)
	})

	// ⚠️ **The order is load bearing.** MongoDB enforces a unique index at each write rather than at
	// commit, so the address has to have moved to `deleted-<id>@invalid.local` before the new document
	// claims it. Reversed, every re-registration of a closed address fails on `login.email_unique`.
	it('frees the address before it claims it', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.invocationCallOrder[0]).toBeLessThan(insertMany.mock.invocationCallOrder[0])
	})

	// Both writes carry the session, so a failure of either leaves neither — the closed document keeps
	// its original address and nobody holds a half-reclaimed one.
	it('runs the scrub and the insert in one transaction', async () => {
		closedHolderIs({ _id: closedId })

		await confirmRegistration('anna@test.it', HASH)

		expect(withTransaction).toHaveBeenCalledOnce()
		expect(updateOne.mock.calls[0][2].session).toBe(session)
		expect(insertMany.mock.calls[0][1].session).toBe(session)
	})

	it('names the tier being scrubbed, so the two collections cannot share a field list', async () => {
		closedHolderIs({ _id: closedId })

		await confirmShopOwner('mark@test.it', HASH)

		expect(buildAccountScrub.mock.calls[0][0]).toBe('shopOwner')
	})
})

describe('confirmRegistration — a replayed click', () => {
	// ⚠️ The confirm step spans Redis and MongoDB and can only be idempotent, not atomic: a crash between
	// the commit and the `DEL` leaves a live key over a live account. The pre-minted `_id` is what makes
	// that knowable — an account carrying *this record's* id can only have been written by an earlier run
	// of this same confirmation.
	it('swallows the failure when the account is already there', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		exists.mockResolvedValueOnce({ _id: ID })

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()

		expect(exists).toHaveBeenCalledExactlyOnceWith({ _id: ID })
	})

	// The second click is the same account being confirmed twice, and the person read the first mail.
	it('sends no second welcome, and still consumes the key', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		exists.mockResolvedValueOnce({ _id: ID })

		await confirmRegistration('anna@test.it', HASH)

		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// ⚠️ **A genuine collision must still be an error.** A racing registration that claimed
	// `login.email` first fails the insert with no document under our `_id`, and swallowing that would
	// report a registration as done while the person has no account.
	it('rethrows when no account carries the record’s id', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		exists.mockResolvedValueOnce(null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('E11000 duplicate key')

		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	// The check is a read rather than an inspection of the driver's error, which is what makes it correct
	// for every reason a transaction can fail — a commit whose acknowledgement was lost included, which
	// reports an error over work that landed.
	it('recovers from a failure that is not a duplicate key at all', async () => {
		withTransaction.mockRejectedValueOnce(new Error('connection reset'))
		exists.mockResolvedValueOnce({ _id: ID })

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()
	})

	// Read outside the session: the transaction has aborted, and what is being asked is what the
	// collection holds now.
	it('asks the collection without the aborted session', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		exists.mockResolvedValueOnce({ _id: ID })

		await confirmRegistration('anna@test.it', HASH)

		expect(exists.mock.calls[0]).toHaveLength(1)
	})
})

describe('the two bound confirms', () => {
	it('exist, one per tier', async () => {
		const { confirmShopOwnerRegistration, confirmUserRegistration } =
			await import('../src/lib/registration/confirmRegistration.mts')

		expect(confirmUserRegistration).toBeTypeOf('function')
		expect(confirmShopOwnerRegistration).toBeTypeOf('function')
		expect(confirmUserRegistration).not.toBe(confirmShopOwnerRegistration)
	})
})
