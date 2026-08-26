// noinspection DuplicatedCode -- what this shares with shopOwnerRegistrationDb.test.mts is the mock
// declarations: the imports, the `vi.fn()` handles and the `vi.mock` factories that close over them. None of
// it can move. `vi.mock` is hoisted to the top of the file that declares it, so a handle imported from a
// shared module is not yet bound when its own factory runs — the mock would install `undefined`. The tests
// underneath, which is what the two suites actually assert, run against different collections.

import { ClientSession, trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emailHash = vi.fn(() => 'hash-from-koa-utils')
const encryptPassword = vi.fn(async (password: string) => `bcrypt(${password})`)
const userCreate = vi.fn()
const userUpdateOne = vi.fn()
const userFindOne = vi.fn()
const userDeleteOne = vi.fn()

vi.mock('@axiumine/koa-utils/lib/emailHash', () => ({ emailHash }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/User', () => ({
	User: { create: userCreate, deleteOne: userDeleteOne, updateOne: userUpdateOne, findOne: userFindOne }
}))

const { purgeClosedUser } = await import('../src/lib/db/purgeClosedUser.mts')
const { registerNewUser } = await import('../src/lib/db/registerNewUser.mts')
const { restartUserRegistration } = await import('../src/lib/db/restartUserRegistration.mts')
const { userForRegistration } = await import('../src/lib/db/userForRegistration.mts')

const session = { id: 'session' } as unknown as ClientSession
const userId = new Types.ObjectId('507f1f77bcf86cd799439011')

/** The single document `create` is handed, which it takes wrapped in an array so the session applies. */
const created = () => userCreate.mock.calls[0][0][0]

beforeEach(() => vi.clearAllMocks())

describe('registerNewUser', () => {
	it('returns the hash the mail has to carry, minted by koa-utils', async () => {
		await expect(registerNewUser('customer@marketplace.test', 'sup3r-secret', session)).resolves.toBe('hash-from-koa-utils')

		expect(emailHash).toHaveBeenCalledExactlyOnceWith()
	})

	// ⚠️ **Minimal is the whole point, and the validator enforces it from the other side.** `user` is
	// `additionalProperties: false` and requires `login` and `registeredAt` only. Writing an empty
	// `personalData` "to have the shape there" is not harmless padding — its own `required` list names
	// `firstName` and `lastName`, so the insert would be refused by MongoDB. The key set is asserted
	// exactly because `toEqual` ignores properties holding `undefined`.
	it('writes the four members the validator wants and nothing else', async () => {
		await registerNewUser('customer@marketplace.test', 'sup3r-secret', session)

		expect(Object.keys(created()).sort()).toEqual(['_id', 'emailVerify', 'login', 'registeredAt'])
		expect(created()).not.toHaveProperty('personalData')
		expect(created()).not.toHaveProperty('addresses')
		expect(created()).not.toHaveProperty('waitApprov')
	})

	// ⚠️ **The plaintext is handed over on purpose, and `encryptPassword` must not be called.**
	// `LoginSubDocSchema`'s `pre('save')` bcrypts the path on every `create`, so hashing here too stored
	// `bcrypt(bcrypt(password))` and opened an account that could never log in — which is what this
	// function did until 2026-08-13. This test asserts the half a mocked model can see: what `create` is
	// handed. **It cannot see the other half**, because a mock runs no middleware, and that blindness is
	// exactly how the defect survived a suite at 100% — the hook firing is proved for real in
	// `test/integration/index.itest.mts` and in marketplace-common's `models.int.test.mts`.
	it('hands create the plaintext, leaving the hashing to the model’s pre-save hook', async () => {
		await registerNewUser('customer@marketplace.test', 'sup3r-secret', session)

		expect(encryptPassword).not.toHaveBeenCalled()
		expect(created().login).toEqual({ email: 'customer@marketplace.test', password: 'sup3r-secret' })
	})

	// ⚠️ `requestTimes: 1` is koa-utils' convention and a *strike* counter, not a send counter: the
	// verify router increments it on a **wrong** hash and abandons the registration at five. Starting it
	// at 0 would silently hand every registration a sixth attempt, and `handleIfTooMuchRequestsTimes` —
	// whose threshold is set against this 1 — is the only place that would notice.
	it('opens the registration unverified, with one strike already on the clock', async () => {
		await registerNewUser('customer@marketplace.test', 'sup3r-secret', session)

		expect(created().emailVerify).toEqual({
			valid: false,
			hash: 'hash-from-koa-utils',
			dateLastReq: expect.any(Date),
			requestTimes: 1
		})
		expect(created().emailVerify.valid).toBe(false)
	})

	// One clock reading, used twice. Two `new Date()` calls would differ by a millisecond or so, which
	// nothing would ever notice — until the three-day abandon window is computed from one of them and
	// audited against the other.
	it('stamps registration and last-request from a single reading of the clock', async () => {
		await registerNewUser('customer@marketplace.test', 'sup3r-secret', session)

		expect(created().registeredAt).toBeInstanceOf(Date)
		expect(created().emailVerify.dateLastReq).toBe(created().registeredAt)
	})

	// The `_id` is minted here rather than left to mongoose because the caller needs it inside the same
	// transaction. A fresh one per call, so a retried registration cannot collide with the document it retries.
	it('mints a fresh id per registration', async () => {
		await registerNewUser('first@marketplace.test', 'sup3r-secret', session)
		await registerNewUser('second@marketplace.test', 'sup3r-secret', session)

		expect(created()._id).toBeInstanceOf(Types.ObjectId)
		expect(userCreate.mock.calls[1][0][0]._id.toHexString()).not.toBe(created()._id.toHexString())
	})

	// ⚠️ The array form is not styling. `Model.create(doc, options)` reads a second argument as another
	// *document*; only `create([doc], options)` passes options through — so writing it the short way
	// drops the session and the insert lands outside the transaction, committed even when the mail fails.
	it('passes the session by taking the array form of create', async () => {
		await registerNewUser('customer@marketplace.test', 'sup3r-secret', session)

		expect(userCreate).toHaveBeenCalledExactlyOnceWith([expect.any(Object)], { session })
		expect(userCreate.mock.calls[0][0]).toHaveLength(1)
	})
})

describe('restartUserRegistration', () => {
	// ⚠️ This overwrites a stored password with nothing proved, and it is safe **only** because the document
	// is not yet an account: `loginUser` refuses every document whose `emailVerify.valid` is not true, so the
	// mail to that address is the proof. What it buys is recovery from a mistyped password whose
	// confirmation mail never arrived. On a verified document the same write would be an unauthenticated
	// password reset — which is why the caller checks `valid` and this helper is never reached otherwise.
	it('re-encrypts the newly supplied password onto the pending document', async () => {
		await restartUserRegistration(session, userId, 'a-different-password')

		expect(encryptPassword).toHaveBeenCalledExactlyOnceWith('a-different-password')
		expect(userUpdateOne.mock.calls[0][1].$set).toEqual({ 'login.password': 'bcrypt(a-different-password)' })
	})

	// ⚠️ `$unset` and not `$set: { deleted: null }`. The abandon guards soft-delete — five wrong hashes,
	// or a link older than three days — and the tombstoned document keeps holding its unique `login.email`.
	// Leaving `deleted` in place would make that address permanently unusable by the person who chose it,
	// which is not what a three-day timeout is meant to mean. A null would satisfy no validator either.
	it('clears the abandon tombstone in the same write', async () => {
		await restartUserRegistration(session, userId, 'a-different-password')

		expect(userUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id: userId },
			{ $set: { 'login.password': 'bcrypt(a-different-password)' }, $unset: { deleted: '' } },
			{ session, runValidators: true }
		)
		expect(Object.keys(userUpdateOne.mock.calls[0][1])).toEqual(['$set', '$unset'])
	})

	// The activation hash is *not* minted here: `setEmailHashUser` owns all three `emailVerify` paths, so
	// they are written in one place and cannot drift from the flow's paths map.
	it('does not touch emailVerify — the flow owns those three paths', async () => {
		await restartUserRegistration(session, userId, 'a-different-password')

		expect(emailHash).not.toHaveBeenCalled()
		expect(JSON.stringify(userUpdateOne.mock.calls[0][1])).not.toMatch(/emailVerify/)
	})

	// `runValidators` because an `updateOne` skips them by default: without it the collection's
	// `$jsonSchema` is the only thing left standing between a malformed write and the database.
	it('runs the model validators, and writes inside the caller’s transaction', async () => {
		await restartUserRegistration(session, userId, 'a-different-password')

		expect(userUpdateOne.mock.calls[0][2]).toEqual({ session, runValidators: true })
	})
})

describe('purgeClosedUser', () => {
	// ⚠️ **The one application hard delete on this platform** (ADR-011 §Amendment 2026-08-26). Everything
	// else stamps `deleted` and keeps the document. A closed customer is the exception because nothing
	// references `user` and its address is a credential rather than a legal identity — and because the
	// document is already condemned: `user.deleted_ttl` removes it thirty days after `userDel` stamped it,
	// so this only moves the removal forward to the request that needs the address back.
	it('removes the document outright, inside the caller’s transaction', async () => {
		await purgeClosedUser(session, userId)

		expect(userDeleteOne).toHaveBeenCalledExactlyOnceWith({ _id: userId, deleted: trusted({ $exists: true }) }, { session })
	})

	// ⚠️ **`deleted` is in the filter and not merely checked by the caller, and that is the whole safety
	// argument.** `userRegister` has already branched on it, so this clause can never fail there — which is
	// the point: this is the only write in the repo nothing can undo, and the guard that matters is the one
	// a future caller cannot skip by misreading a branch. A live account reaching here deletes nothing and
	// the transaction then fails loudly on `login.email_unique` instead of destroying an account quietly.
	it('cannot reach a live document — the closed clause is part of the filter', async () => {
		await purgeClosedUser(session, userId)

		expect(Object.keys(userDeleteOne.mock.calls[0][0]).sort()).toEqual(['_id', 'deleted'])
		expect(userDeleteOne.mock.calls[0][0].deleted).toEqual(trusted({ $exists: true }))
	})

	// ⚠️ **The `trusted()` wrapper is asserted, not just the shape.** `sanitizeFilter` is on process-wide,
	// so a bare `{ $exists: true }` is silently rewritten to `{ $eq: { $exists: true } }` — a search for a
	// field holding that literal object, which matches nothing. The delete would remove no document and the
	// registration behind it would then fail on the unique index: safe, and still broken. `toEqual` compares
	// symbol properties, so the two assertions above both fail if the wrapper is dropped.

	it('reads nothing back — the transaction is what makes the pair atomic', async () => {
		userDeleteOne.mockResolvedValueOnce({ acknowledged: true, deletedCount: 1 })

		await expect(purgeClosedUser(session, userId)).resolves.toBeUndefined()
	})
})

describe('userForRegistration', () => {
	const chain = (result: unknown) => {
		const lean = vi.fn().mockResolvedValue(result)

		return { session: vi.fn(() => ({ lean })) }
	}

	// ⚠️ **No `deleted` filter, deliberately.** `login.email` carries a plain unique index with no
	// `partialFilterExpression`, so a tombstoned document still occupies its address: a lookup behind a
	// liveness filter would report "free", and the `create` behind it would then fail on the *index*
	// rather than on a branch anyone can read. The caller decides what a tombstone means — and it needs
	// `emailVerify.valid` beside it to do so, since an unverified stamp is an abandoned attempt and a
	// verified one is a closed account.
	it('seeks the address alone, tombstones included', async () => {
		userFindOne.mockReturnValueOnce(chain(null))

		await userForRegistration('customer@marketplace.test', session)

		expect(userFindOne.mock.calls[0][0]).toEqual({ 'login.email': 'customer@marketplace.test' })
		expect(Object.keys(userFindOne.mock.calls[0][0])).toEqual(['login.email'])
	})

	// The projection is the reason this helper exists. Nothing on the registration path reads
	// `login.password`, so nothing on it can leak a bcrypt hash into a log line or a Sentry breadcrumb —
	// and the three fields named are exactly the three the caller branches on.
	it('projects the three fields the branches read, and no credential', async () => {
		userFindOne.mockReturnValueOnce(chain(null))

		await userForRegistration('customer@marketplace.test', session)

		const projection = userFindOne.mock.calls[0][1] as string

		expect(projection.split(' ').sort()).toEqual(['_id', 'deleted', 'emailVerify.valid'])
		expect(projection).not.toMatch(/password|login\.email/)
	})

	// Read inside the transaction, so the document this decides on is the document the write then updates — the
	// alternative is deciding "no such registration" against a snapshot another request has already
	// changed, and inserting a duplicate the unique index refuses.
	it('reads through the caller’s session and returns a lean document', async () => {
		const doc = { _id: userId, emailVerify: { valid: false } }
		const query = chain(doc)
		userFindOne.mockReturnValueOnce(query)

		await expect(userForRegistration('customer@marketplace.test', session)).resolves.toBe(doc)

		expect(query.session).toHaveBeenCalledExactlyOnceWith(session)
	})

	it('answers null when the address is free', async () => {
		userFindOne.mockReturnValueOnce(chain(null))

		await expect(userForRegistration('free@marketplace.test', session)).resolves.toBeNull()
	})
})
