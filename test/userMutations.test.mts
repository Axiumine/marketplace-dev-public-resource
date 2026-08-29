// noinspection DuplicatedCode -- what this shares with shopOwnerRegisterMutation.test.mts is the mock
// declarations, and none of it can move: `vi.mock` is hoisted to the top of the file that declares it, so a
// handle imported from a shared module is not yet bound when its own factory runs.

import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardPublicWrite = vi.fn()
const submitUserRegistration = vi.fn()
const resendUserRegistration = vi.fn()
const checkEmailLen = vi.fn()
const checkPwdLen = vi.fn()
const endEverySessionUser = vi.fn()

const boundResetPwdResolve = vi.fn(async () => 'delegated-reset')
const boundUpdatePwdResolve = vi.fn(async () => 'delegated-update')
const BOUND_RESET_TYPE = new GraphQLNonNull(GraphQLBoolean)
const BOUND_UPDATE_TYPE = new GraphQLNonNull(GraphQLBoolean)

vi.mock('@axiumine/koa-utils/lib/checkEmailLen', () => ({ checkEmailLen }))
vi.mock('@axiumine/koa-utils/lib/checkPwdLen', () => ({ checkPwdLen }))

vi.mock('../src/lib/access/endEverySession.mts', () => ({ endEverySessionUser }))
vi.mock('../src/lib/access/guardPublicWrite.mts', () => ({ guardPublicWrite }))
vi.mock('../src/lib/registration/submitRegistration.mts', () => ({ submitUserRegistration }))
vi.mock('../src/lib/registration/resendRegistration.mts', () => ({ resendUserRegistration }))
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

/** Mixed case and trailing space, because normalisation is asserted on nearly every path below. */
const TYPED_EMAIL = ' Customer@Marketplace.TEST '
const EMAIL = 'customer@marketplace.test'

const registerArgs = { email: TYPED_EMAIL, password: 'sup3r-secret', repeatPassword: 'sup3r-secret', turnstileToken: 'cf-token' }

/** The guard's argument object, which four mutations build with four different sets of numbers. */
const guardedWith = () => guardPublicWrite.mock.calls[0][0]

beforeEach(async () => {
	vi.clearAllMocks()
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
		expect(submitUserRegistration).not.toHaveBeenCalled()
	})

	// ⚠️ **`repeatPassword` is a control here and a courtesy in the form.** The frontend check exists to
	// tell the typist before they submit; nothing stops a client from not being that frontend. Checking
	// it server-side is what makes "the customer confirmed their password" true rather than rendered.
	it('refuses two different passwords, before the guard and before the submission', async () => {
		// koa-utils puts the readable half in `extensions.description` and keeps `message` at the status
		// title, so asserting on `message` alone would pass for every 400 this mutation can raise.
		await expect(userRegister.resolve(null, { ...registerArgs, repeatPassword: 'sup3r-secrey' })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'The two passwords do not match' }
		})

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(submitUserRegistration).not.toHaveBeenCalled()
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

	// ⚠️ The guard runs before the submission, so a refused caller costs one Redis counter and nothing
	// else: no bcrypt round, no pending record, and above all no mail. A guard that ran afterwards would
	// meter the answer while the mail had already gone out.
	it('submits nothing once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow('Too many requests')

		expect(submitUserRegistration).not.toHaveBeenCalled()
	})

	it('guards before it submits', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(guardPublicWrite.mock.invocationCallOrder[0]).toBeLessThan(submitUserRegistration.mock.invocationCallOrder[0])
	})
})

describe('userRegister — what it hands the flow', () => {
	// ⚠️ **Nothing is written to MongoDB by this resolver** (ADR-042). A submitted registration is a Redis
	// record with a three-day TTL and the `user` document is created by the confirmation click and by
	// nothing else. What this replaced was four branches over a half-built document: an unverified row held
	// the address against everybody else, an abandoned one was tombstoned lazily and so often never at all,
	// and a closed one had to be hard-deleted to free its address. None of those states can exist now,
	// because the state that used to hold them is not in the collection — so the resolver is the
	// normalisation, the two length checks, the guard and a call. What the call does about a free, a live
	// or a closed address is `submitRegistration.test.mts`.
	it('submits the canonical address and the password as typed', async () => {
		await userRegister.resolve(null, registerArgs)

		expect(submitUserRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL, 'sup3r-secret')
	})

	// ⚠️ **The customer flow, never the seller one.** Both take an address and a password and neither can
	// tell them apart; the wrong binding here would open a `shopOwner` account — behind an approval queue
	// nobody is waiting on — for somebody who asked to be a customer.
	it('submits through the customer binding', async () => {
		const module = await import('../src/lib/registration/submitRegistration.mts')

		expect(submitUserRegistration).toBe(module.submitUserRegistration)
	})

	// ⚠️ **Every outcome answers `true`, and that is the security property rather than laziness.**
	// koa-utils' `signUp` throws a 409 when the address is taken, which turns the mutation into an
	// account-enumeration oracle: anybody can ask it, one address at a time, who has an account here. The
	// outcomes are distinguishable only in the inbox.
	it('answers true whatever the flow found', async () => {
		await expect(userRegister.resolve(null, registerArgs)).resolves.toBe(true)
	})

	// `tryCatchRethrow` is what turns an unexpected driver error into a GraphQL error without leaking the
	// driver's message; a failure has to keep failing, not be swallowed into a `true`.
	it('rethrows rather than answering true when the flow fails', async () => {
		submitUserRegistration.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toThrow()
	})

	it('does not leak the driver’s message to the caller', async () => {
		submitUserRegistration.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))

		await expect(userRegister.resolve(null, registerArgs)).rejects.toMatchObject({
			message: 'Internal Server Error'
		})
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

	// ⚠️ No password argument, and there must not be one. A resend re-sends a link for a registration that
	// already carries the password its submitter chose; accepting one here would let anybody who knows an
	// address change the password a pending registration is about to be activated with.
	it('takes an address and nothing else', () => {
		expect(Object.keys(userVerifyEmailResend.args)).not.toContain('password')
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

	// The length check but not the password one: there is no password on this mutation to check.
	it('checks the address length and has no password to check', async () => {
		await userVerifyEmailResend.resolve(null, resendArgs)

		expect(checkPwdLen).not.toHaveBeenCalled()
	})

	it('re-issues under the canonical address', async () => {
		await userVerifyEmailResend.resolve(null, resendArgs)

		expect(resendUserRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	// ⚠️ **`true` for every address, pending or not.** Both outcomes — no pending registration, link
	// re-issued — look identical from outside, which is what stops the mutation being an enumeration
	// oracle that costs nothing to query. Which of the two happened is `resendRegistration.test.mts`.
	it('answers true whether or not anything was pending', async () => {
		await expect(userVerifyEmailResend.resolve(null, resendArgs)).resolves.toBe(true)

		resendUserRegistration.mockResolvedValueOnce(undefined)

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).resolves.toBe(true)
	})

	it('rethrows a failed send instead of reporting success', async () => {
		resendUserRegistration.mockRejectedValueOnce(new Error('SocketLabs refused'))

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).rejects.toThrow()
	})

	it('re-issues nothing once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(userVerifyEmailResend.resolve(null, resendArgs)).rejects.toThrow('Too many requests')

		expect(resendUserRegistration).not.toHaveBeenCalled()
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
		expect(endEverySessionUser).not.toHaveBeenCalled()
	})
})

// E15-S10. The public reset flow was the fourth credential write on the platform and the last one that
// revoked nothing: somebody resetting their password because they believed another person was inside the
// account changed the lock and left every stolen session open.
describe('userUpdatePwd — ending the sessions the reset just made resettable', () => {
	const updateArgs = { email: TYPED_EMAIL, hash: 'reset-hash', password: 'a-new-password', turnstileToken: 'cf-token' }

	it('ends every session the customer holds, under the normalised address', async () => {
		await userUpdatePwd.resolve(null, updateArgs)

		expect(endEverySessionUser).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	// ⚠️ After the delegate, never before it. A revoke placed first would log the customer out of every
	// device for a reset that then failed validation, and would run its read on every wrong hash and every
	// unknown address — the whole rate-limited abuse surface — for the one caller about to succeed.
	it('revokes only once the write has returned', async () => {
		await userUpdatePwd.resolve(null, updateArgs)

		expect(boundUpdatePwdResolve.mock.invocationCallOrder[0]).toBeLessThan(endEverySessionUser.mock.invocationCallOrder[0])
	})

	it('revokes nothing when the delegate refuses', async () => {
		boundUpdatePwdResolve.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(userUpdatePwd.resolve(null, updateArgs)).rejects.toThrow('Forbidden')

		expect(endEverySessionUser).not.toHaveBeenCalled()
	})

	// ⚠️ The password is live and the hash is spent by the time this fires, so the customer has to request a
	// fresh link. That cost is accepted: the alternative is answering `true` with every stolen session still
	// open, which is the exact lie the story exists to stop telling.
	it('answers 500 rather than true when the revoke is refused', async () => {
		endEverySessionUser.mockRejectedValueOnce(new Error('Connection is closed'))

		await expect(userUpdatePwd.resolve(null, updateArgs)).rejects.toThrow('Internal Server Error')
	})

	it('reports the refused revoke as a 500 through tryCatchRethrow, not as the raw Redis error', async () => {
		endEverySessionUser.mockRejectedValueOnce(new Error('Connection is closed'))

		const thrown = await userUpdatePwd.resolve(null, updateArgs).catch((e: unknown) => e)

		expect((thrown as { extensions?: { http?: { status?: number } } }).extensions?.http?.status).toBe(500)
	})
})
