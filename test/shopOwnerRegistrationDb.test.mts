import { ClientSession, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const emailHash = vi.fn(() => 'hash-from-koa-utils')
const encryptPassword = vi.fn(async (password: string) => `bcrypt(${password})`)
const shopOwnerCreate = vi.fn()
const shopOwnerUpdateOne = vi.fn()
const shopOwnerFindOne = vi.fn()

vi.mock('@axiumine/koa-utils/lib/emailHash', () => ({ emailHash }))
vi.mock('@axiumine/koa-utils/lib/encryptPassword', () => ({ encryptPassword }))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ShopOwner', () => ({
	ShopOwner: { create: shopOwnerCreate, updateOne: shopOwnerUpdateOne, findOne: shopOwnerFindOne }
}))

const { registerNewShopOwner } = await import('../src/lib/db/registerNewShopOwner.mts')
const { restartShopOwnerRegistration } = await import('../src/lib/db/restartShopOwnerRegistration.mts')
const { shopOwnerForRegistration } = await import('../src/lib/db/shopOwnerForRegistration.mts')

const session = { id: 'session' } as unknown as ClientSession
const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439012')

/** The single document `create` is handed, which it takes wrapped in an array so the session applies. */
const created = () => shopOwnerCreate.mock.calls[0][0][0]

beforeEach(() => vi.clearAllMocks())

describe('registerNewShopOwner', () => {
	it('returns the hash the mail has to carry, minted by koa-utils', async () => {
		await expect(registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)).resolves.toBe('hash-from-koa-utils')

		expect(emailHash).toHaveBeenCalledExactlyOnceWith()
	})

	// ⚠️ **`waitApprov: true` is the reason this mutation may exist at all**, and this is the assertion
	// that keeps it there: `checkShopOwnerApproval` refuses the account a session at login and at every
	// refresh while the flag is up, so a stranger who fills in the form and opens the activation mail is
	// a *request* to sell here, never a seller. Drop the field and self-registration silently becomes
	// self-admission — nothing else on the platform would notice, because every other layer treats a
	// shopOwner document as an approved shop owner.
	it('parks the account for an operator to approve', async () => {
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

		expect(created().waitApprov).toBe(true)
	})

	// ⚠️ **Minimal is the whole point, and the validator enforces it from the other side.** `shopOwner` is
	// `additionalProperties: false` and — since `personalData` left its `required` array for exactly this
	// mutation — wants `login` and `registeredAt` only. Writing an empty `personalData` "to have the shape
	// there" is not harmless padding: its own `required` list names all five members, so MongoDB would
	// refuse the insert. The key set is asserted exactly because `toEqual` ignores keys holding `undefined`.
	it('writes the five members the validator wants and nothing else', async () => {
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

		expect(Object.keys(created()).sort()).toEqual(['_id', 'emailVerify', 'login', 'registeredAt', 'waitApprov'])
		expect(created()).not.toHaveProperty('personalData')
		expect(created()).not.toHaveProperty('disabled')
	})

	// ⚠️ **The plaintext is handed over on purpose, and `encryptPassword` must not be called.**
	// `LoginSubDocSchema`'s `pre('save')` bcrypts the path on every `create`, so hashing here too stored
	// `bcrypt(bcrypt(password))` and opened an account that could never log in — which is what this
	// function did until 2026-08-13. A mocked model runs no middleware, so this test can only assert what
	// `create` is handed; the hook firing is proved against real MongoDB in
	// `test/integration/index.itest.mts`. The `updateOne` sibling below hashes explicitly and is right to:
	// the rule follows the write operator, not the field.
	it('hands create the plaintext, leaving the hashing to the model’s pre-save hook', async () => {
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

		expect(encryptPassword).not.toHaveBeenCalled()
		expect(created().login).toEqual({ email: 'seller@marketplace.test', password: 'sup3r-secret' })
	})

	// ⚠️ `requestTimes: 1` is koa-utils' convention and a *strike* counter, not a send counter: the verify
	// router increments it on a **wrong** hash and abandons the registration at five. Starting it at 0
	// would silently hand every registration a sixth attempt.
	it('opens the registration unverified, with one strike already on the clock', async () => {
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

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
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

		expect(created().registeredAt).toBeInstanceOf(Date)
		expect(created().emailVerify.dateLastReq).toBe(created().registeredAt)
	})

	// The `_id` is minted here rather than left to mongoose because the caller needs it inside the same
	// transaction. A fresh one per call, so a retried registration cannot collide with the document it retries.
	it('mints a fresh id per registration', async () => {
		await registerNewShopOwner('first@marketplace.test', 'sup3r-secret', session)
		await registerNewShopOwner('second@marketplace.test', 'sup3r-secret', session)

		expect(created()._id).toBeInstanceOf(Types.ObjectId)
		expect(shopOwnerCreate.mock.calls[1][0][0]._id.toHexString()).not.toBe(created()._id.toHexString())
	})

	// ⚠️ The array form is not styling. `Model.create(doc, options)` reads a second argument as another
	// *document*; only `create([doc], options)` passes options through — so writing it the short way drops
	// the session and the insert lands outside the transaction, committed even when the mail fails.
	it('passes the session by taking the array form of create', async () => {
		await registerNewShopOwner('seller@marketplace.test', 'sup3r-secret', session)

		expect(shopOwnerCreate).toHaveBeenCalledExactlyOnceWith([expect.any(Object)], { session })
		expect(shopOwnerCreate.mock.calls[0][0]).toHaveLength(1)
	})
})

describe('restartShopOwnerRegistration', () => {
	// ⚠️ This overwrites a stored password with nothing proved, and it is safe **only** because the
	// document is not yet an account: `checkShopOwnerEmailVerified` refuses every document whose
	// `emailVerify.valid` is false, so the mail to that address is the proof, and `checkShopOwnerApproval`
	// refuses it again while it waits. What it buys is recovery from a mistyped password whose
	// confirmation mail never arrived.
	it('re-encrypts the newly supplied password onto the pending document', async () => {
		await restartShopOwnerRegistration(session, shopOwnerId, 'a-different-password')

		expect(encryptPassword).toHaveBeenCalledExactlyOnceWith('a-different-password')
		expect(shopOwnerUpdateOne.mock.calls[0][1].$set).toEqual({ 'login.password': 'bcrypt(a-different-password)' })
	})

	// ⚠️ **`waitApprov` is not written here, in either direction, and no other file can make that hold.**
	// Raising it would let a public mutation un-approve an account an operator has already admitted —
	// anybody who knows a seller's address could park them by re-submitting the registration form.
	// Clearing it would be worse: an approval decision taken by an unauthenticated caller.
	it('leaves the approval decision alone', async () => {
		await restartShopOwnerRegistration(session, shopOwnerId, 'a-different-password')

		expect(JSON.stringify(shopOwnerUpdateOne.mock.calls[0][1])).not.toMatch(/waitApprov/)
	})

	// ⚠️ `$unset` and not `$set: { deleted: null }`. The abandon guards soft-delete — five wrong hashes,
	// or a link older than three days — and the tombstoned document keeps holding its unique `login.email`.
	// Leaving `deleted` in place would make that address permanently unusable by the person who chose it.
	// A null would satisfy no validator either.
	it('clears the abandon tombstone in the same write', async () => {
		await restartShopOwnerRegistration(session, shopOwnerId, 'a-different-password')

		expect(shopOwnerUpdateOne).toHaveBeenCalledExactlyOnceWith(
			{ _id: shopOwnerId },
			{ $set: { 'login.password': 'bcrypt(a-different-password)' }, $unset: { deleted: '' } },
			{ session, runValidators: true }
		)
		expect(Object.keys(shopOwnerUpdateOne.mock.calls[0][1])).toEqual(['$set', '$unset'])
	})

	// The activation hash is *not* minted here: `setEmailHash` owns all three `emailVerify` paths, so they
	// are written in one place and cannot drift from the flow's paths map.
	it('does not touch emailVerify — the flow owns those three paths', async () => {
		await restartShopOwnerRegistration(session, shopOwnerId, 'a-different-password')

		expect(emailHash).not.toHaveBeenCalled()
		expect(JSON.stringify(shopOwnerUpdateOne.mock.calls[0][1])).not.toMatch(/emailVerify/)
	})

	// `runValidators` because an `updateOne` skips them by default: without it the collection's
	// `$jsonSchema` is the only thing left standing between a malformed write and the database.
	it('runs the model validators, and writes inside the caller’s transaction', async () => {
		await restartShopOwnerRegistration(session, shopOwnerId, 'a-different-password')

		expect(shopOwnerUpdateOne.mock.calls[0][2]).toEqual({ session, runValidators: true })
	})
})

describe('shopOwnerForRegistration', () => {
	const chain = (result: unknown) => {
		const lean = vi.fn().mockResolvedValue(result)

		return { session: vi.fn(() => ({ lean })) }
	}

	// ⚠️ **No `deleted` filter, deliberately.** `login.email` carries a plain unique index with no
	// `partialFilterExpression`, so a tombstoned document still occupies its address: a lookup behind a
	// liveness filter would report "free", and the `create` behind it would then fail on the *index*
	// rather than on a branch anyone can read. The caller decides what a tombstone means.
	it('seeks the address alone, tombstones included', async () => {
		shopOwnerFindOne.mockReturnValueOnce(chain(null))

		await shopOwnerForRegistration('seller@marketplace.test', session)

		expect(shopOwnerFindOne.mock.calls[0][0]).toEqual({ 'login.email': 'seller@marketplace.test' })
		expect(Object.keys(shopOwnerFindOne.mock.calls[0][0])).toEqual(['login.email'])
	})

	// ⚠️ **`waitApprov` must not be projected**, and this is the assertion that says so out loud. Whether
	// the account is parked changes nothing about what the caller does next, so the only thing reading it
	// here could add is a branch that behaves differently for parked accounts — an oracle for which
	// addresses are waiting on an operator, on a mutation anyone may call. The projection also keeps
	// `login.password` off the registration path entirely, so no bcrypt hash can reach a log line.
	it('projects the three fields the branches read — no credential, no approval state', async () => {
		shopOwnerFindOne.mockReturnValueOnce(chain(null))

		await shopOwnerForRegistration('seller@marketplace.test', session)

		const projection = shopOwnerFindOne.mock.calls[0][1] as string

		expect(projection.split(' ').sort()).toEqual(['_id', 'deleted', 'emailVerify.valid'])
		expect(projection).not.toMatch(/password|login\.email|waitApprov/)
	})

	// Read inside the transaction, so the document this decides on is the document the write then
	// updates — the alternative is deciding "no such registration" against a snapshot another request has
	// already changed, and inserting a duplicate the unique index refuses.
	it('reads through the caller’s session and returns a lean document', async () => {
		const doc = { _id: shopOwnerId, emailVerify: { valid: false } }
		const query = chain(doc)
		shopOwnerFindOne.mockReturnValueOnce(query)

		await expect(shopOwnerForRegistration('seller@marketplace.test', session)).resolves.toBe(doc)

		expect(query.session).toHaveBeenCalledExactlyOnceWith(session)
	})

	it('answers null when the address is free', async () => {
		shopOwnerFindOne.mockReturnValueOnce(chain(null))

		await expect(shopOwnerForRegistration('free@marketplace.test', session)).resolves.toBeNull()
	})
})
