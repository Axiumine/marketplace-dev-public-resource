// noinspection DuplicatedCode -- what this shares with userMutations.test.mts is the mock declarations: the
// imports, the `vi.fn()` handles, the `vi.hoisted` session block and the `vi.mock` factories that close over
// them. None of it can move. `vi.mock` and `vi.hoisted` are hoisted to the top of the file that declares
// them, so a handle imported from a shared module is not yet bound when its own factory runs — the mock
// would install `undefined`. The tests underneath, which is what the two suites actually assert, differ:
// one registers a shop owner, the other a user, against different collections and different mail flows.

import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardPublicWrite = vi.fn()
const sendShopOwnerVerifyEmail = vi.fn()
const setEmailHash = vi.fn(async () => 'hash-reissued')
const registerNewShopOwner = vi.fn(async () => 'hash-fresh')
const restartShopOwnerRegistration = vi.fn()
const shopOwnerForRegistration = vi.fn()
const emailAlreadyValid = vi.fn()
const checkEmailLen = vi.fn()
const checkPwdLen = vi.fn()

// `vi.hoisted`, unlike the plain consts above, because this file imports `mongoose` itself: the mock
// factory runs while that import is evaluated, which is before any top-level `const` in the file has
// been initialised. The other factories are only reached by the dynamic import in `beforeEach`.
const { endSession, session, startSession, withTransaction } = vi.hoisted(() => {
	const endSessionFn = vi.fn()
	const withTransactionFn = vi.fn(async (work: () => Promise<void>) => await work())
	const sessionObj = { withTransaction: withTransactionFn, endSession: endSessionFn }

	return {
		endSession: endSessionFn,
		session: sessionObj,
		startSession: vi.fn(async () => sessionObj),
		withTransaction: withTransactionFn
	}
})

vi.mock('mongoose', async (importOriginal) => {
	const actual = await importOriginal<typeof import('mongoose')>()

	return { ...actual, default: { ...actual.default, startSession } }
})

vi.mock('@axiumine/koa-utils/lib/checkEmailLen', () => ({ checkEmailLen }))
vi.mock('@axiumine/koa-utils/lib/checkPwdLen', () => ({ checkPwdLen }))
vi.mock('@axiumine/koa-utils/email/SocketLabsLib', () => ({
	SocketLabsLib: vi.fn(function mockSocketLabsLib() {
		return { emailAlreadyValid }
	})
}))

vi.mock('../src/lib/access/guardPublicWrite.mts', () => ({ guardPublicWrite }))
vi.mock('../src/lib/access/sendShopOwnerVerifyEmail.mts', () => ({ sendShopOwnerVerifyEmail }))
vi.mock('../src/lib/access/verifyEmailFlow.mts', () => ({ setEmailHash }))
vi.mock('../src/lib/db/registerNewShopOwner.mts', () => ({ registerNewShopOwner }))
vi.mock('../src/lib/db/restartShopOwnerRegistration.mts', () => ({ restartShopOwnerRegistration }))
vi.mock('../src/lib/db/shopOwnerForRegistration.mts', () => ({ shopOwnerForRegistration }))

// Imported inside `beforeEach` rather than at the top, the way every mutation suite in this repo is:
// the field objects are built at module load, so a top-level `await import()` evaluates them during
// Vitest's collection phase — outside the per-test window Stryker measures, where a killed mutant is
// reported as Survived.
let shopOwnerRegister: (typeof import('../src/graphQLPublic/schema/mutations/shopOwnerRegister.mts'))['shopOwnerRegister']

const shopOwnerId = new Types.ObjectId('507f1f77bcf86cd799439012')

/** Mixed case and trailing space, because normalisation is asserted on nearly every path below. */
const TYPED_EMAIL = ' Seller@Marketplace.TEST '
const EMAIL = 'seller@marketplace.test'

const registerArgs = { email: TYPED_EMAIL, password: 'sup3r-secret', repeatPassword: 'sup3r-secret', turnstileToken: 'cf-token' }

beforeEach(async () => {
	vi.clearAllMocks()
	setEmailHash.mockResolvedValue('hash-reissued')
	registerNewShopOwner.mockResolvedValue('hash-fresh')
	shopOwnerForRegistration.mockResolvedValue(null)
	;({ shopOwnerRegister } = await import('../src/graphQLPublic/schema/mutations/shopOwnerRegister.mts'))
})

describe('shopOwnerRegister — the field', () => {
	// The description is the one place a reader of the schema learns that this does not produce a seller,
	// only a request to be one — so it is pinned, not merely present.
	it('answers a non-nullable Boolean and says the account is pending approval', () => {
		expect(shopOwnerRegister.description).toBe(
			'Register a new shop owner, pending operator approval, and send the activation link'
		)
		expect(shopOwnerRegister.type).toBeInstanceOf(GraphQLNonNull)
		expect((shopOwnerRegister.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
	})

	// `turnstileToken` is the one nullable argument, for the reason `userRegister`'s is: a required
	// argument would make the mutation uncallable by any client that has not minted a token yet.
	it('requires the three credentials and leaves the captcha token optional', () => {
		expect(Object.keys(shopOwnerRegister.args)).toEqual(['email', 'password', 'repeatPassword', 'turnstileToken'])
		expect(shopOwnerRegister.args.email.type).toBeInstanceOf(GraphQLNonNull)
		expect(shopOwnerRegister.args.password.type).toBeInstanceOf(GraphQLNonNull)
		expect(shopOwnerRegister.args.repeatPassword.type).toBeInstanceOf(GraphQLNonNull)
		expect(shopOwnerRegister.args.turnstileToken.type).toBe(GraphQLString)
	})

	// ⚠️ No `personalData` argument, and there must not be one. The registration is an address and a
	// password; a form that also collected a name and a birth date would put five more strings on an
	// unauthenticated mutation and gain nothing — nobody has been identified yet, and onboarding asks
	// once the operator has approved the account.
	it('collects credentials only, no identity', () => {
		expect(Object.keys(shopOwnerRegister.args)).not.toContain('personalData')
		expect(Object.keys(shopOwnerRegister.args)).not.toContain('firstName')
	})
})

describe('shopOwnerRegister — validation, before anything is spent', () => {
	// The lengths are koa-utils' rules, called here so a 4 KB "email" is refused before it becomes a Redis
	// key and a bcrypt round. The normalised address goes to the checker and the raw password does:
	// trimming a password would silently change what the seller typed.
	it('checks the normalised address and the password as typed', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(checkEmailLen).toHaveBeenCalledExactlyOnceWith(EMAIL)
		expect(checkPwdLen).toHaveBeenCalledExactlyOnceWith('sup3r-secret')
	})

	it('stops on a refused length without touching Redis or Mongo', async () => {
		checkEmailLen.mockImplementationOnce(() => {
			throw new Error('email too long')
		})

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow('email too long')

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(startSession).not.toHaveBeenCalled()
	})

	// ⚠️ **`repeatPassword` is a control here and a courtesy in the form.** The frontend check exists to
	// tell the typist before they submit; nothing stops a client from not being that frontend.
	it('refuses two different passwords, before the guard and before the transaction', async () => {
		// koa-utils puts the readable half in `extensions.description` and keeps `message` at the status
		// title, so asserting on `message` alone would pass for every 400 this mutation can raise.
		await expect(shopOwnerRegister.resolve(null, { ...registerArgs, repeatPassword: 'sup3r-secrey' })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'The two passwords do not match' }
		})

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(startSession).not.toHaveBeenCalled()
	})

	it('compares the passwords byte for byte, not case-insensitively', async () => {
		await expect(shopOwnerRegister.resolve(null, { ...registerArgs, repeatPassword: 'SUP3R-SECRET' })).rejects.toMatchObject({
			extensions: { description: 'The two passwords do not match' }
		})
	})
})

describe('shopOwnerRegister — the guard', () => {
	// ⚠️ **A bucket of its own, not `userRegister`'s.** The two collections are unrelated by design
	// (ADR-002), so one person may legitimately be both a customer and a seller at the same address —
	// sharing a counter would let three seller attempts spend the customer's hourly allowance and lock
	// them out of a registration they have not tried yet.
	it('meters three activation mails an hour per address, in its own bucket', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(guardPublicWrite).toHaveBeenCalledExactlyOnceWith({
			bucket: 'shopOwnerRegister',
			email: EMAIL,
			turnstileToken: 'cf-token',
			perEmailPerHour: 3
		})
	})

	// The counter keys off the canonical address, so `Seller@…` and `seller@…` share one bucket —
	// otherwise the per-address ceiling is bypassed by changing the capitalisation of the same inbox.
	it('meters the canonical address, not the typed one', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(guardPublicWrite.mock.calls[0][0].email).toBe(EMAIL)
	})

	it('never opens a transaction once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow('Too many requests')

		expect(startSession).not.toHaveBeenCalled()
		expect(shopOwnerForRegistration).not.toHaveBeenCalled()
	})
})

describe('shopOwnerRegister — the three outcomes', () => {
	// ⚠️ **All three answer `true`, and that is the security property rather than laziness.** A mutation
	// that throws 409 for a taken address is an account-enumeration oracle: anyone can ask it, one address
	// at a time, who sells here. The outcomes are distinguishable only in the inbox.
	it('writes the document and sends the link when the address is free', async () => {
		await expect(shopOwnerRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(shopOwnerForRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL, session)
		expect(registerNewShopOwner).toHaveBeenCalledExactlyOnceWith(EMAIL, 'sup3r-secret', session)
		expect(sendShopOwnerVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-fresh')
		expect(restartShopOwnerRegistration).not.toHaveBeenCalled()
		expect(emailAlreadyValid).not.toHaveBeenCalled()
	})

	// ⚠️ A verified document is somebody's account — approved or still queued, and this mutation cannot
	// tell, because the lookup does not project the flag. Nothing is written to it, not the password and
	// not the hash. The "you already have an account" mail is the one message that helps its owner without
	// telling anybody else the address is taken.
	it('writes nothing at all to a verified account, and says so only in the inbox', async () => {
		shopOwnerForRegistration.mockResolvedValueOnce({ _id: shopOwnerId, emailVerify: { valid: true } })

		await expect(shopOwnerRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(emailAlreadyValid).toHaveBeenCalledExactlyOnceWith(EMAIL)
		expect(registerNewShopOwner).not.toHaveBeenCalled()
		expect(restartShopOwnerRegistration).not.toHaveBeenCalled()
		expect(setEmailHash).not.toHaveBeenCalled()
		expect(sendShopOwnerVerifyEmail).not.toHaveBeenCalled()
	})

	// An unfinished attempt — possibly with a mistyped password, possibly tombstoned by the three-day
	// guard. Restarting it is what keeps the address usable by the person who chose it; the unique index
	// on `login.email` means the alternative is that they can never register it at all.
	it('restarts an unverified attempt with the new password and a new hash', async () => {
		shopOwnerForRegistration.mockResolvedValueOnce({ _id: shopOwnerId, emailVerify: { valid: false } })

		await expect(shopOwnerRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(restartShopOwnerRegistration).toHaveBeenCalledExactlyOnceWith(session, shopOwnerId, 'sup3r-secret')
		expect(setEmailHash).toHaveBeenCalledExactlyOnceWith(session, shopOwnerId)
		expect(sendShopOwnerVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-reissued')
		expect(registerNewShopOwner).not.toHaveBeenCalled()
	})

	// The optional chain matters: `emailVerify` is absent on a document whose registration was interrupted
	// between the insert and the flow — and on every shop owner an operator created by hand through
	// `shopOwnerAdd`, which writes no such block at all. Reading that as "verified" would lock the address
	// forever; reading it as "unfinished" is what this branch does, and the restart it triggers can only
	// ever reach a document nobody has proved they own.
	it.each([
		['no emailVerify subdocument at all', { _id: shopOwnerId }],
		['an emailVerify with no valid flag', { _id: shopOwnerId, emailVerify: {} }],
		['a tombstoned unverified document', { _id: shopOwnerId, emailVerify: { valid: false }, deleted: new Date() }]
	])('treats %s as an unfinished attempt', async (_desc, existing) => {
		shopOwnerForRegistration.mockResolvedValueOnce(existing)

		await expect(shopOwnerRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(restartShopOwnerRegistration).toHaveBeenCalledOnce()
		expect(emailAlreadyValid).not.toHaveBeenCalled()
	})

	// The restart is ordered: password first, then the hash, then the mail. A mail sent before the
	// document was rewritten would carry a link that activates the *old* password.
	it('rewrites the document before it mints the hash, and mints before it sends', async () => {
		shopOwnerForRegistration.mockResolvedValueOnce({ _id: shopOwnerId, emailVerify: { valid: false } })

		await shopOwnerRegister.resolve(null, registerArgs)

		expect(restartShopOwnerRegistration.mock.invocationCallOrder[0]).toBeLessThan(setEmailHash.mock.invocationCallOrder[0])
		expect(setEmailHash.mock.invocationCallOrder[0]).toBeLessThan(sendShopOwnerVerifyEmail.mock.invocationCallOrder[0])
	})
})

describe('shopOwnerRegister — the transaction', () => {
	// One transaction so a mail is never sent for a document that failed to write. The reverse — document
	// written, SocketLabs then refuses — stays possible by design, and submitting the form again is the
	// recovery: it lands on the restart branch and re-mints the hash.
	it('does all of its work inside one transaction, and always ends the session', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(startSession).toHaveBeenCalledOnce()
		expect(withTransaction).toHaveBeenCalledOnce()
		expect(endSession).toHaveBeenCalledOnce()
	})

	it('ends the session even when the transaction throws', async () => {
		registerNewShopOwner.mockRejectedValueOnce(new Error('write conflict'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow()

		expect(endSession).toHaveBeenCalledOnce()
	})

	// `tryCatchRethrow` is what turns an unexpected driver error into a GraphQL error without leaking the
	// driver's message; a failure has to keep failing, not be swallowed into a `true`.
	it('rethrows rather than answering true on a failed write', async () => {
		registerNewShopOwner.mockRejectedValueOnce(new Error('write conflict'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow()
	})
})
