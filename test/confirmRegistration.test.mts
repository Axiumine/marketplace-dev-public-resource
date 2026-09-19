import { Binary } from 'mongodb'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chain, type IChain } from './support/queryChain.mts'

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
/** A bcrypt hash of the *same* password under a different salt — what a second registration produces. */
const OTHER_HASH = '$2b$14$' + 'q'.repeat(53)
const CLOSED_ID = new Types.ObjectId('66c0ffee0000000000000002')

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
const target = {
	tier: 'user' as const,
	model: { findOne, updateOne, insertMany } as never,
	waitApprov: false,
	encryptEmail: vi.fn(),
	sendVerifyEmail: vi.fn()
}

const confirmRegistration = createConfirmRegistration(target)
const confirmShopOwner = createConfirmRegistration({ ...target, tier: 'shopOwner', waitApprov: true })

/** A live account holding the address, opened by *this* registration — the hash is the record's. */
const ourHolder = { _id: ID, login: { password: HASHED } }

/** A live account holding the address that this registration did not open: somebody else's. */
const otherHolder = { _id: new Types.ObjectId('66c0ffee0000000000000003'), login: { password: OTHER_HASH } }

/** The same address, still held by the account whose owner closed it — inside the retention window. */
const closedHolder = {
	_id: CLOSED_ID,
	deleted: new Date('2026-08-20T09:00:00.000Z'),
	login: { password: OTHER_HASH }
}

/**
 * A closed account that nonetheless carries *this* registration's own credential — the restore this very
 * confirmation wrote landed, but the account was closed again (an admin, a second closure, whatever the
 * cause) before the recovery read runs. `isOurs` must still say no: a closed account is not a usable one,
 * and the `deleted` check is what tells this apart from `ourHolder` on the credential alone.
 */
const closedHolderWithOurCredential = {
	_id: CLOSED_ID,
	deleted: new Date('2026-08-20T09:00:00.000Z'),
	login: { password: HASHED }
}

/**
 * Every lookup chain handed out this run, in call order. `openAccount` reads the address twice on the
 * paths that fail — once in the transaction and once after it aborts — and which session each read
 * carried is the difference between a recovery that works and one that reads the aborted transaction's
 * own view, so the chains are kept rather than the documents alone.
 */
const chains: IChain[] = []

/**
 * Queues what the address lookup finds, one answer per call and in order.
 *
 * The default set in `beforeEach` is "nobody holds it", which is what every insert-path test wants for
 * both reads; a test that wants a holder queues one over the top, which is why these are `...Once`.
 */
function addressHeldBy(...holders: unknown[]) {
	for (const holder of holders) {
		const link = chain(holder)

		chains.push(link)
		findOne.mockReturnValueOnce(link)
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	chains.length = 0
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
	it('uses the admin that runs no save middleware', async () => {
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

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('write conflict')

		expect(deletePendingRegistration).not.toHaveBeenCalled()
		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
	})
})

describe('confirmRegistration — the address lookup', () => {
	// ⚠️ **No `deleted` clause, and that is the point.** `login.email_unique` is the only unique index on
	// either collection — no `partialFilterExpression`, no `sparse` (ADR-011) — so whoever holds the
	// address is the answer to every question this module asks. Narrowing to the closed ones would hide
	// the live holder that the replay branch and the two-people-one-address race both turn on.
	it('asks who holds the address, not who closed it', async () => {
		await confirmRegistration('anna@test.it', HASH)

		const [filter] = findOne.mock.calls[0]

		expect(Object.keys(filter)).toEqual(['login.email'])
		expect(filter['login.email']).toBe(CIPHERTEXT)
	})

	// The ciphertext Redis held is the value that goes into the filter — ADR-043's *confirm is a copy*.
	// It is what `login.email_unique` is built over, so this is a point lookup rather than a scan, and
	// nothing on this path decrypts or re-derives an address to make it.
	it('reads the three fields the two decisions need, and no others', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(findOne.mock.calls[0][1]).toBe('_id deleted login.password')
	})
})

describe('confirmRegistration — restoring a closed account', () => {
	it('writes no update when the address is free', async () => {
		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne).not.toHaveBeenCalled()
		expect(insertMany).toHaveBeenCalledOnce()
	})

	// ⚠️ **ADR-046: the retention window is an undo window.** Signing up again at a closed address inside
	// it is the request to come back, and the activation link is the proof — the same proof a password
	// reset accepts. Minting a second document instead would leave the person's shops, items and
	// addresses hanging off an id they no longer are.
	it('hands the closed document back rather than minting a new one', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne).toHaveBeenCalledOnce()
		expect(updateOne.mock.calls[0][0]).toEqual({ _id: CLOSED_ID })
		expect(insertMany).not.toHaveBeenCalled()
	})

	// ⚠️ The empty strings are the `$unset` operand MongoDB wants and are asserted as written: `deletedBy`
	// left behind names an admin on a live account, and `deleted` left behind is an account that is
	// back but still refused at every login gate.
	it('clears the closure and the actor who made it', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.calls[0][1].$unset).toEqual({ deleted: '', deletedBy: '' })
	})

	// The password is the one just submitted. The person proved they can read mail at the address and
	// chose a credential doing it; the hash the account carried before the closure is not kept, because
	// nothing may outlive a closure that could be used to log in as the account before this moment.
	it('takes the credential the person just chose, and marks the address proved', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.calls[0][1].$set).toEqual({
			'login.password': HASHED,
			emailVerify: { valid: true }
		})
	})

	// ⚠️ **`_id` and `registeredAt` are absent by design.** The whole of an undo is that this is the *same*
	// account — the id every `company.idShopOwner` still points at, and the date the person actually
	// joined. A restore that rewrote either would be a new account wearing an old one's data.
	it('keeps the id and the join date the account already had', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		const update = updateOne.mock.calls[0][1]

		expect(Object.keys(update.$set)).not.toContain('registeredAt')
		expect(Object.keys(update.$set)).not.toContain('_id')
	})

	// ⚠️ **A suspended-then-closed account comes back suspended.** Only the Admin tier lifts a suspension
	// (ADR-044), and an undo the subject performs on themselves must not be the way around one.
	it('leaves a suspension exactly where the admin left it', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		const update = updateOne.mock.calls[0][1]
		const written = [...Object.keys(update.$set), ...Object.keys(update.$unset)]

		expect(written.filter((path) => path.startsWith('disabled'))).toEqual([])
	})

	// ⚠️ The platform owner's ruling of 2026-08-29: *"the state of waitApprove is true, so admin can not
	// approve the user if it is a problem"*. Coming back is re-entry through the door a first registration
	// uses, so the admin gets the same veto — and it is the only human checkpoint on a recycled mailbox.
	it('re-raises the approval gate on the seller tier', async () => {
		addressHeldBy(closedHolder)

		await confirmShopOwner('mark@test.it', HASH)

		expect(updateOne.mock.calls[0][1].$set.waitApprov).toBe(true)
	})

	// The customer tier has no approval gate at all, and a field the `user` schema does not declare fails
	// `additionalProperties: false` — so the two collections cannot share one update shape.
	it('raises no approval gate on the customer tier', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.calls[0][1].$set).not.toHaveProperty('waitApprov')
	})

	// The restore is a plaintext update on purpose: `fieldEncryptionPlugin` encrypts `$set` operands on
	// the way past, and `runValidators` is what makes the collection's own `$jsonSchema` the last word on
	// the shape it leaves behind.
	it('validates the restore against the collection', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(updateOne.mock.calls[0][2].runValidators).toBe(true)
	})

	it('runs the lookup and the restore in one transaction', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(withTransaction).toHaveBeenCalledOnce()
		expect(chains[0].session).toHaveBeenCalledWith(session)
		expect(updateOne.mock.calls[0][2].session).toBe(session)
	})

	// An account opened and an account handed back both send it: the person completed a registration
	// either way, and saying which of the two happened would say what the platform still holds about an
	// address to anyone who can type one in.
	it('welcomes the person and consumes the record, as an opened account does', async () => {
		addressHeldBy(closedHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(registrationMailer.sendWelcome).toHaveBeenCalledExactlyOnceWith('anna@test.it')
		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})
})

describe('confirmRegistration — somebody else holds the address', () => {
	// ⚠️ The two-people-one-address race: both submitted before either clicked, and the first click opened
	// the account. The loser must not be handed it, and must not be told they are the loser — the refusal
	// is the same check-your-mail page every other refusal on this route answers with.
	it('refuses a live holder this registration did not open', async () => {
		addressHeldBy(otherHolder, otherHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(insertMany).not.toHaveBeenCalled()
		expect(updateOne).not.toHaveBeenCalled()
	})

	it('sends no welcome and leaves the record for the person who owns it', async () => {
		addressHeldBy(otherHolder, otherHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow(EMAIL_CHECK_LINK)

		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})
})

describe('confirmRegistration — a replayed click', () => {
	// ⚠️ The confirm step spans Redis and MongoDB and can only be idempotent, not atomic: a crash between
	// the commit and the `DEL` leaves a live key over a live account. The credential is what makes that
	// knowable — `login.password` is the record's bcrypt hash byte for byte only if this very registration
	// is what put it there, two registrations at one address hashing to different values.
	it('treats a live holder carrying this record’s credential as a second click', async () => {
		addressHeldBy(ourHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()

		expect(insertMany).not.toHaveBeenCalled()
		expect(updateOne).not.toHaveBeenCalled()
	})

	// The second click is the same account being confirmed twice, and the person read the first mail.
	it('sends no second welcome, and still consumes the key', async () => {
		addressHeldBy(ourHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// A commit whose acknowledgement was lost reports an error over work that landed, so the recovery
	// asks the collection rather than reading the driver's error — which is what makes it right for every
	// reason a transaction can fail, a duplicate key being only the loudest.
	it('swallows an insert failure when the account it describes is in fact there', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		addressHeldBy(null, ourHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()

		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// ⚠️ **The restore path needs the same recovery, and an `_id` check could not have given it one.** A
	// restore mints no id — it writes to the document that was already there — so "is there an account
	// carrying the record's `_id`" answers `no` over a restore that committed. The credential answers it.
	it('swallows a restore failure when the account is in fact back', async () => {
		updateOne.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		addressHeldBy(closedHolder, ourHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()

		expect(deletePendingRegistration).toHaveBeenCalledExactlyOnceWith(SLOT.key)
	})

	// ⚠️ **A genuine collision must still be an error.** A racing registration that claimed `login.email`
	// first leaves a holder with a different hash, and swallowing that would report a registration as done
	// while the person has no account.
	it('rethrows when the address ended up held by somebody else', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		addressHeldBy(null, otherHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('E11000 duplicate key')

		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	it('rethrows when nothing landed at all', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		addressHeldBy(null, null)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('E11000 duplicate key')

		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	// A closed holder is not a recovery either: whatever the failed transaction did, it was not the
	// restore, and reporting success would leave the person with an account still refused at every gate.
	it('rethrows when the address is still held by a closed account', async () => {
		insertMany.mockRejectedValueOnce(new Error('write conflict'))
		addressHeldBy(null, closedHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('write conflict')
	})

	// ⚠️ The credential alone is not enough: a closed account that happens to carry this registration's own
	// hash — the restore it wrote landed, then the account was closed again before this read — is still not
	// a usable account. Reporting success here would consume the key and tell the person they are in, over
	// an account that refuses them at the login gate.
	it('rethrows when the recovered account is closed, even carrying this registration’s own credential', async () => {
		insertMany.mockRejectedValueOnce(new Error('write conflict'))
		addressHeldBy(null, closedHolderWithOurCredential)

		await expect(confirmRegistration('anna@test.it', HASH)).rejects.toThrow('write conflict')

		expect(registrationMailer.sendWelcome).not.toHaveBeenCalled()
		expect(deletePendingRegistration).not.toHaveBeenCalled()
	})

	it('recovers from a failure that is not a duplicate key at all', async () => {
		withTransaction.mockRejectedValueOnce(new Error('connection reset'))
		addressHeldBy(ourHolder)

		await expect(confirmRegistration('anna@test.it', HASH)).resolves.toBeUndefined()
	})

	// ⚠️ **The recovery read carries no session, and the transaction read carries one.** The transaction
	// has aborted, and what is being asked is what the collection holds now — asked through the aborted
	// session it would answer from a view that no longer exists.
	it('asks the collection without the aborted session', async () => {
		insertMany.mockRejectedValueOnce(new Error('E11000 duplicate key'))
		addressHeldBy(null, ourHolder)

		await confirmRegistration('anna@test.it', HASH)

		expect(chains[0].session).toHaveBeenCalledWith(session)
		expect(chains[1].session).toHaveBeenCalledWith(null)
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
