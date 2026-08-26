import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardPublicWrite = vi.fn()
const sendUserVerifyEmail = vi.fn()
const setEmailHashUser = vi.fn(async () => 'hash-reissued')
const purgeClosedUser = vi.fn()
const registerNewUser = vi.fn(async () => 'hash-fresh')
const restartUserRegistration = vi.fn()
const userForRegistration = vi.fn()
const emailAlreadyValid = vi.fn()
const checkEmailLen = vi.fn()
const checkPwdLen = vi.fn()

const boundResetPwdResolve = vi.fn(async () => 'delegated-reset')
const boundUpdatePwdResolve = vi.fn(async () => 'delegated-update')
const BOUND_RESET_TYPE = new GraphQLNonNull(GraphQLBoolean)
const BOUND_UPDATE_TYPE = new GraphQLNonNull(GraphQLBoolean)

// `vi.hoisted`, unlike the plain consts above, because this file imports `mongoose` itself: the mock
// factory runs while that import is evaluated, which is before any top-level `const` in the file has
// been initialised. The other factories are only reached by the dynamic imports in `beforeEach`.
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
vi.mock('../src/lib/access/sendUserVerifyEmail.mts', () => ({ sendUserVerifyEmail }))
vi.mock('../src/lib/access/verifyEmailFlowUser.mts', () => ({ setEmailHashUser }))
vi.mock('../src/lib/db/purgeClosedUser.mts', () => ({ purgeClosedUser }))
vi.mock('../src/lib/db/registerNewUser.mts', () => ({ registerNewUser }))
vi.mock('../src/lib/db/restartUserRegistration.mts', () => ({ restartUserRegistration }))
vi.mock('../src/lib/db/userForRegistration.mts', () => ({ userForRegistration }))
vi.mock('../src/lib/access/resetPwdFlowUser.mts', () => ({
	userResetPwd: { type: BOUND_RESET_TYPE, resolve: boundResetPwdResolve },
	userUpdatePwd: { type: BOUND_UPDATE_TYPE, resolve: boundUpdatePwdResolve }
}))

// Imported inside `beforeEach` rather than at the top, the way every mutation suite in this repo is:
// the field objects are built at module load, so a top-level `await import()` evaluates them during
// Vitest's collection phase — outside the per-test window Stryker measures, where a killed mutant is
// reported as Survived.
let userRegister: (typeof import('../src/graphQLPublic/schema/mutations/userRegister.mts'))['userRegister']
let userVerifyEmailResend: (typeof import('../src/graphQLPublic/schema/mutations/userVerifyEmailResend.mts'))['userVerifyEmailResend']
let userResetPwd: (typeof import('../src/graphQLPublic/schema/mutations/userResetPwd.mts'))['userResetPwd']
let userUpdatePwd: (typeof import('../src/graphQLPublic/schema/mutations/userUpdatePwd.mts'))['userUpdatePwd']

const userId = new Types.ObjectId('507f1f77bcf86cd799439011')

/** Mixed case and trailing space, because normalisation is asserted on nearly every path below. */
const TYPED_EMAIL = ' Customer@Marketplace.TEST '
const EMAIL = 'customer@marketplace.test'

const registerArgs = { email: TYPED_EMAIL, password: 'sup3r-secret', repeatPassword: 'sup3r-secret', turnstileToken: 'cf-token' }

/** The guard's argument object, which four mutations build with four different sets of numbers. */
const guardedWith = () => guardPublicWrite.mock.calls[0][0]

beforeEach(async () => {
	vi.clearAllMocks()
	setEmailHashUser.mockResolvedValue('hash-reissued')
	registerNewUser.mockResolvedValue('hash-fresh')
	userForRegistration.mockResolvedValue(null)
	;({ userRegister } = await import('../src/graphQLPublic/schema/mutations/userRegister.mts'))
	;({ userVerifyEmailResend } = await import('../src/graphQLPublic/schema/mutations/userVerifyEmailResend.mts'))
	;({ userResetPwd } = await import('../src/graphQLPublic/schema/mutations/userResetPwd.mts'))
	;({ userUpdatePwd } = await import('../src/graphQLPublic/schema/mutations/userUpdatePwd.mts'))
})

describe('userRegister — the field', () => {
	it('answers a non-nullable Boolean and describes itself', () => {
		expect(userRegister.description).toBe('Register a new customer and send the activation link')
		expect(userRegister.type).toBeInstanceOf(GraphQLNonNull)
		expect((userRegister.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
	})

	// `turnstileToken` is the one nullable argument: the frontend that will send it does not exist yet,
	// and a required argument would make the mutation uncallable until it does.
	it('requires the three credentials and leaves the captcha token optional', () => {
		expect(Object.keys(userRegister.args)).toEqual(['email', 'password', 'repeatPassword', 'turnstileToken'])
		expect(userRegister.args.email.type).toBeInstanceOf(GraphQLNonNull)
		expect(userRegister.args.password.type).toBeInstanceOf(GraphQLNonNull)
		expect(userRegister.args.repeatPassword.type).toBeInstanceOf(GraphQLNonNull)
		expect(userRegister.args.turnstileToken.type).toBe(GraphQLString)
	})
})

describe('userRegister — validation, before anything is spent', () => {
	// The lengths are koa-utils' rules, called here so a 4 KB "email" is refused before it becomes a
	// Redis key and a bcrypt round. The normalised address goes to the checker and the raw password does:
	// trimming a password would silently change what the customer typed.
	it('checks the normalised address and the password as typed', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(checkEmailLen).toHaveBeenCalledExactlyOnceWith(EMAIL)
		expect(checkPwdLen).toHaveBeenCalledExactlyOnceWith('sup3r-secret')
	})

	it('stops on a refused length without touching Redis or Mongo', async () => {
		checkEmailLen.mockImplementationOnce(() => {
			throw new Error('email too long')
		})

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow('email too long')

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(startSession).not.toHaveBeenCalled()
	})

	// ⚠️ **`repeatPassword` is a control here and a courtesy in the form.** The frontend check exists to
	// tell the typist before they submit; nothing stops a client from not being that frontend. Checking
	// it server-side is what makes "the customer confirmed their password" true rather than rendered.
	it('refuses two different passwords, before the guard and before the transaction', async () => {
		// koa-utils puts the readable half in `extensions.description` and keeps `message` at the status
		// title, so asserting on `message` alone would pass for every 400 this mutation can raise.
		await expect(userRegister.resolve(null, { ...registerArgs, repeatPassword: 'sup3r-secrey' })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'The two passwords do not match' }
		})

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(startSession).not.toHaveBeenCalled()
	})

	it('compares the passwords byte for byte, not case-insensitively', async () => {
		await expect(userRegister.resolve(null, { ...registerArgs, repeatPassword: 'SUP3R-SECRET' })).rejects.toMatchObject({
			extensions: { description: 'The two passwords do not match' }
		})
	})
})

describe('userRegister — the guard', () => {
	it('meters three activation mails an hour per address', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(guardPublicWrite).toHaveBeenCalledExactlyOnceWith({
			bucket: 'userRegister',
			email: EMAIL,
			turnstileToken: 'cf-token',
			perEmailPerHour: 3
		})
	})

	// The counter keys off the canonical address, so `Customer@…` and `customer@…` share one bucket —
	// otherwise the per-address ceiling is bypassed by changing the capitalisation of the same inbox.
	it('meters the canonical address, not the typed one', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(guardedWith().email).toBe(EMAIL)
	})

	it('never opens a transaction once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow('Too many requests')

		expect(startSession).not.toHaveBeenCalled()
		expect(userForRegistration).not.toHaveBeenCalled()
	})
})

describe('userRegister — the four outcomes', () => {
	// ⚠️ **All four answer `true`, and that is the security property rather than laziness.** A mutation
	// that throws 409 for a taken address is an account-enumeration oracle: anyone can ask it, one
	// address at a time, who has an account here. The outcomes are distinguishable only in the inbox.
	it('writes the document and sends the link when the address is free', async () => {
		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(userForRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL, session)
		expect(registerNewUser).toHaveBeenCalledExactlyOnceWith(EMAIL, 'sup3r-secret', session)
		expect(sendUserVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-fresh')
		expect(restartUserRegistration).not.toHaveBeenCalled()
		expect(emailAlreadyValid).not.toHaveBeenCalled()
		expect(purgeClosedUser).not.toHaveBeenCalled()
	})

	// ⚠️ A verified document is somebody's account: nothing is written to it — not the password, not the hash.
	// The "you already have an account" mail is the one message that helps its owner (they forgot they
	// registered) without telling anybody else the address is taken.
	it('writes nothing at all to a verified account, and says so only in the inbox', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: true } })

		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(emailAlreadyValid).toHaveBeenCalledExactlyOnceWith(EMAIL)
		expect(registerNewUser).not.toHaveBeenCalled()
		expect(restartUserRegistration).not.toHaveBeenCalled()
		expect(setEmailHashUser).not.toHaveBeenCalled()
		expect(sendUserVerifyEmail).not.toHaveBeenCalled()
		expect(purgeClosedUser).not.toHaveBeenCalled()
	})

	// ⚠️ **A closed account is destroyed and the address registered fresh** (ADR-011 §Amendment
	// 2026-08-26). The document was already condemned — `user.deleted_ttl` removes it thirty days after
	// `userDel` stamped it — so this only brings the removal forward to the request that needs the
	// address, which makes the erasure earlier than the retention rule requires rather than later. Before
	// it existed, closing an account burned its address for a month and answered "you are already
	// registered" the whole time, about an account nobody could log into.
	it('destroys a closed account and registers the address again from scratch', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: true }, deleted: new Date() })

		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(purgeClosedUser).toHaveBeenCalledExactlyOnceWith(session, userId)
		expect(registerNewUser).toHaveBeenCalledExactlyOnceWith(EMAIL, 'sup3r-secret', session)
		expect(sendUserVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-fresh')
		expect(emailAlreadyValid).not.toHaveBeenCalled()
		expect(restartUserRegistration).not.toHaveBeenCalled()
		expect(setEmailHashUser).not.toHaveBeenCalled()
	})

	// ⚠️ **The old document has to be gone before the new one is written, and the order is not stylistic.**
	// `login.email_unique` carries no `partialFilterExpression`, so both documents would hold the same
	// address at once: inside the transaction the insert fails on the index, the whole registration aborts,
	// and the customer is told nothing while nothing at all happens.
	it('deletes before it inserts, or the unique index refuses the new document', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: true }, deleted: new Date() })

		await userRegister.resolve(null, registerArgs)

		expect(purgeClosedUser.mock.invocationCallOrder[0]).toBeLessThan(registerNewUser.mock.invocationCallOrder[0])
		expect(registerNewUser.mock.invocationCallOrder[0]).toBeLessThan(sendUserVerifyEmail.mock.invocationCallOrder[0])
	})

	// ⚠️ **Both halves of the condition are load-bearing, and the branch is ordered before the verified one
	// on purpose.** A closed document is verified too, so the two conditions overlap: the other order makes
	// this branch unreachable. `deleted` alone is not enough either — an unverified stamp is an abandoned
	// attempt, and destroying it would answer a mistyped password with a hard delete.
	it.each([
		['live and verified', { _id: userId, emailVerify: { valid: true } }],
		['stamped but never verified', { _id: userId, emailVerify: { valid: false }, deleted: new Date() }],
		['stamped with no emailVerify at all', { _id: userId, deleted: new Date() }]
	])('leaves %s well alone — only a verified stamp is a closed account', async (_desc, existing) => {
		userForRegistration.mockResolvedValueOnce(existing)

		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(purgeClosedUser).not.toHaveBeenCalled()
	})

	// An unfinished attempt — possibly with a mistyped password, possibly tombstoned by the three-day
	// guard. Restarting it is what keeps the address usable by the person who chose it; the unique index
	// on `login.email` means the alternative is that they can never register it at all.
	it('restarts an unverified attempt with the new password and a new hash', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: false } })

		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(restartUserRegistration).toHaveBeenCalledExactlyOnceWith(session, userId, 'sup3r-secret')
		expect(setEmailHashUser).toHaveBeenCalledExactlyOnceWith(session, userId)
		expect(sendUserVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-reissued')
		expect(registerNewUser).not.toHaveBeenCalled()
	})

	// The optional chain matters: `emailVerify` is absent on a document whose registration was interrupted
	// between the insert and the flow. Reading that as "verified" would lock the address forever.
	it.each([
		['no emailVerify subdocument at all', { _id: userId }],
		['an emailVerify with no valid flag', { _id: userId, emailVerify: {} }],
		['a tombstoned unverified document', { _id: userId, emailVerify: { valid: false }, deleted: new Date() }]
	])('treats %s as an unfinished attempt', async (_desc, existing) => {
		userForRegistration.mockResolvedValueOnce(existing)

		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)

		expect(restartUserRegistration).toHaveBeenCalledOnce()
		expect(emailAlreadyValid).not.toHaveBeenCalled()
	})

	// The restart is ordered: password first, then the hash, then the mail. A mail sent before the document
	// was rewritten would carry a link that activates the *old* password.
	it('rewrites the document before it mints the hash, and mints before it sends', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: false } })

		await userRegister.resolve(null, registerArgs)

		expect(restartUserRegistration.mock.invocationCallOrder[0]).toBeLessThan(setEmailHashUser.mock.invocationCallOrder[0])
		expect(setEmailHashUser.mock.invocationCallOrder[0]).toBeLessThan(sendUserVerifyEmail.mock.invocationCallOrder[0])
	})
})

describe('userRegister — the transaction', () => {
	// One transaction so a mail is never sent for a document that failed to write. The reverse — document written,
	// SocketLabs then refuses — stays possible by design, and `userVerifyEmailResend` is the recovery.
	it('does all of its work inside one transaction, and always ends the session', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(startSession).toHaveBeenCalledOnce()
		expect(withTransaction).toHaveBeenCalledOnce()
		expect(endSession).toHaveBeenCalledOnce()
	})

	it('ends the session even when the transaction throws', async () => {
		registerNewUser.mockRejectedValueOnce(new Error('write conflict'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow()

		expect(endSession).toHaveBeenCalledOnce()
	})

	// `tryCatchRethrow` is what turns an unexpected driver error into a GraphQL error without leaking the
	// driver's message; a failure has to keep failing, not be swallowed into a `true`.
	it('rethrows rather than answering true on a failed write', async () => {
		registerNewUser.mockRejectedValueOnce(new Error('write conflict'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow()
	})
})

describe('userVerifyEmailResend', () => {
	const resendArgs = { email: TYPED_EMAIL, turnstileToken: 'cf-token' }

	it('answers a non-nullable Boolean, takes an address and an optional token', () => {
		expect(userVerifyEmailResend.description).toBe('Re-send the customer activation link')
		expect(userVerifyEmailResend.type).toBeInstanceOf(GraphQLNonNull)
		expect((userVerifyEmailResend.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(GraphQLBoolean)
		expect(Object.keys(userVerifyEmailResend.args)).toEqual(['email', 'turnstileToken'])
		expect(userVerifyEmailResend.args.email.type).toBeInstanceOf(GraphQLNonNull)
		expect(userVerifyEmailResend.args.turnstileToken.type).toBe(GraphQLString)
	})

	// Same ceiling as registration, in a bucket of its own: this path sends a mail and writes nothing
	// else, and burning the resend allowance must not spend the registration one.
	it('meters three an hour per address, in its own bucket', async () => {
		await userVerifyEmailResend.resolve(null, resendArgs)

		expect(guardPublicWrite).toHaveBeenCalledExactlyOnceWith({
			bucket: 'userVerifyEmailResend',
			email: EMAIL,
			turnstileToken: 'cf-token',
			perEmailPerHour: 3
		})
		expect(checkEmailLen).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	// Minting through `setEmailHashUser` also resets `requestTimes`, which is right: the strikes counted
	// attempts against the *old* hash, and the caller is about to be given a new one.
	it('re-issues the link for a live unverified registration', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: false } })

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).resolves.toBe(true)

		expect(setEmailHashUser).toHaveBeenCalledExactlyOnceWith(session, userId)
		expect(sendUserVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-reissued')
	})

	// ⚠️ All four outcomes are `true` and silent, for the reason `userRegister` is. A tombstoned document is
	// left alone here and *not* restarted: reviving it from an argument list with no password would let
	// anyone keep somebody else's abandoned document alive indefinitely. Registering again is the recovery,
	// and it proves who is asking by setting a password only the mail can activate.
	it.each([
		['no such registration', null],
		['a tombstoned document', { _id: userId, emailVerify: { valid: false }, deleted: new Date() }],
		['an account that is already verified', { _id: userId, emailVerify: { valid: true } }]
	])('answers true and sends nothing for %s', async (_desc, existing) => {
		userForRegistration.mockResolvedValueOnce(existing)

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).resolves.toBe(true)

		expect(setEmailHashUser).not.toHaveBeenCalled()
		expect(sendUserVerifyEmail).not.toHaveBeenCalled()
		expect(userForRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL, session)
	})

	// ⚠️ The `?.` is load-bearing on a document the projection allows to arrive without `emailVerify` — a
	// registration interrupted between its insert and its hash, or written by an older path. Reading
	// `.valid` straight off it throws a TypeError inside the transaction, which `tryCatchRethrow` turns
	// into a 500 on a mutation whose entire contract is "answers true and says nothing".
	it('treats a document with no emailVerify as unverified, and re-issues rather than throwing', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId })

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).resolves.toBe(true)

		expect(sendUserVerifyEmail).toHaveBeenCalledExactlyOnceWith(EMAIL, 'hash-reissued')
	})

	it('ends the session on every path, including the ones that write nothing', async () => {
		await userVerifyEmailResend.resolve(null, resendArgs)

		expect(withTransaction).toHaveBeenCalledOnce()
		expect(endSession).toHaveBeenCalledOnce()
	})

	it('rethrows a failed send instead of reporting success', async () => {
		userForRegistration.mockResolvedValueOnce({ _id: userId, emailVerify: { valid: false } })
		sendUserVerifyEmail.mockRejectedValueOnce(new Error('SocketLabs refused'))

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).rejects.toThrow()

		expect(endSession).toHaveBeenCalledOnce()
	})

	it('never opens a transaction once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).rejects.toThrow('Too many requests')

		expect(startSession).not.toHaveBeenCalled()
	})
})

describe('userResetPwd', () => {
	const resetArgs = { email: TYPED_EMAIL, turnstileToken: 'cf-token' }

	// The type is the delegate's own object, by identity: rebuilding an equivalent one here would be a
	// second `GraphQLNonNull(GraphQLBoolean)` from this file's copy of `graphql`, and a schema mixing two
	// realms fails `instanceof` at construction.
	it('borrows the bound flow’s type and declares its own two arguments', () => {
		expect(userResetPwd.description).toBe('Send a customer password-reset link')
		expect(userResetPwd.type).toBe(BOUND_RESET_TYPE)
		expect(Object.keys(userResetPwd.args)).toEqual(['email', 'turnstileToken'])
		expect(userResetPwd.args.email.type).toBeInstanceOf(GraphQLNonNull)
		expect(userResetPwd.args.turnstileToken.type).toBe(GraphQLString)
	})

	// ⚠️ The shop-owner `resetPwd` beside it in the schema is **not** guarded, deliberately: those two
	// apps ship today and send no Turnstile token, so gating them is a coordinated frontend change. The
	// customer tier has no frontend yet, so it is born with the gate on.
	it('meters three an hour per address before delegating', async () => {
		await userResetPwd.resolve(null, resetArgs)

		expect(guardPublicWrite).toHaveBeenCalledExactlyOnceWith({
			bucket: 'userResetPwd',
			email: EMAIL,
			turnstileToken: 'cf-token',
			perEmailPerHour: 3
		})
		expect(checkEmailLen).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	// ⚠️ The address is handed on **as typed**, not lowercased: the delegate normalises it itself, and
	// pre-normalising here would hide a change of mind there. Only the guard needs the canonical form, so
	// that two spellings of one inbox share a counter.
	it('delegates with the caller’s arguments untouched, and returns what the flow returns', async () => {
		const source = { some: 'source' }

		await expect(userResetPwd.resolve(source, resetArgs)).resolves.toBe('delegated-reset')

		expect(boundResetPwdResolve).toHaveBeenCalledExactlyOnceWith(source, resetArgs)
		expect(boundResetPwdResolve.mock.calls[0][1].email).toBe(TYPED_EMAIL)
	})

	it('sends no mail once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userResetPwd.resolve(null, resetArgs)).rejects.toThrow('Too many requests')

		expect(boundResetPwdResolve).not.toHaveBeenCalled()
	})
})

describe('userUpdatePwd', () => {
	const updateArgs = { email: TYPED_EMAIL, hash: 'reset-hash', password: 'a-new-password', turnstileToken: 'cf-token' }

	it('borrows the bound flow’s type and declares the reset triple plus the token', () => {
		expect(userUpdatePwd.description).toBe("Confirm a customer's password reset")
		expect(userUpdatePwd.type).toBe(BOUND_UPDATE_TYPE)
		expect(Object.keys(userUpdatePwd.args)).toEqual(['email', 'hash', 'password', 'turnstileToken'])
		expect(userUpdatePwd.args.hash.type).toBeInstanceOf(GraphQLNonNull)
		expect(userUpdatePwd.args.password.type).toBeInstanceOf(GraphQLNonNull)
		expect(userUpdatePwd.args.turnstileToken.type).toBe(GraphQLString)
	})

	// ⚠️ A higher ceiling than the request side, and metered against **guessing the hash** rather than
	// against sending mail. koa-utils answers a wrong hash with the same 403 an unknown address gets, so
	// nothing leaks — but nothing costs the caller anything either, and an unmetered 403 is an invitation
	// to keep asking. The limit is what turns the hash into a secret that has to be received.
	it('allows ten an hour per address, in its own bucket', async () => {
		await userUpdatePwd.resolve(null, updateArgs)

		expect(guardPublicWrite).toHaveBeenCalledExactlyOnceWith({
			bucket: 'userUpdatePwd',
			email: EMAIL,
			turnstileToken: 'cf-token',
			perEmailPerHour: 10
		})
		expect(checkEmailLen).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	it('delegates the hash and the new password verbatim, and returns the flow’s answer', async () => {
		const source = { some: 'source' }

		await expect(userUpdatePwd.resolve(source, updateArgs)).resolves.toBe('delegated-update')

		expect(boundUpdatePwdResolve).toHaveBeenCalledExactlyOnceWith(source, updateArgs)
	})

	it('never reaches the delegate once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userUpdatePwd.resolve(null, updateArgs)).rejects.toThrow('Too many requests')

		expect(boundUpdatePwdResolve).not.toHaveBeenCalled()
	})
})
