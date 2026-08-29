// noinspection DuplicatedCode -- what this shares with userMutations.test.mts is the mock declarations: the
// imports, the `vi.fn()` handles and the `vi.mock` factories that close over them. None of it can move.
// `vi.mock` is hoisted to the top of the file that declares it, so a handle imported from a shared module is
// not yet bound when its own factory runs — the mock would install `undefined`. The tests underneath, which
// is what the two suites actually assert, differ: one registers a shop owner, the other a customer, against
// different collections and different mail flows.

import { GraphQLBoolean, GraphQLNonNull, GraphQLString } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const guardPublicWrite = vi.fn()
const submitShopOwnerRegistration = vi.fn()
const checkEmailLen = vi.fn()
const checkPwdLen = vi.fn()

vi.mock('@axiumine/koa-utils/lib/checkEmailLen', () => ({ checkEmailLen }))
vi.mock('@axiumine/koa-utils/lib/checkPwdLen', () => ({ checkPwdLen }))

vi.mock('../src/lib/access/guardPublicWrite.mts', () => ({ guardPublicWrite }))
vi.mock('../src/lib/registration/submitRegistration.mts', () => ({ submitShopOwnerRegistration }))

// Imported inside `beforeEach` rather than at the top, the way every mutation suite in this repo is:
// the field objects are built at module load, so a top-level `await import()` evaluates them during
// Vitest's collection phase — outside the per-test window Stryker measures, where a killed mutant is
// reported as Survived.
let shopOwnerRegister: (typeof import('../src/graphQLPublic/schema/mutations/shopOwnerRegister.mts'))['shopOwnerRegister']

/** Mixed case and trailing space, because normalisation is asserted on nearly every path below. */
const TYPED_EMAIL = ' Seller@Marketplace.TEST '
const EMAIL = 'seller@marketplace.test'

const registerArgs = {
	email: TYPED_EMAIL,
	password: 'sup3r-secret',
	repeatPassword: 'sup3r-secret',
	turnstileToken: 'cf-token'
}

beforeEach(async () => {
	vi.clearAllMocks()
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
		expect(submitShopOwnerRegistration).not.toHaveBeenCalled()
	})

	// ⚠️ **`repeatPassword` is a control here and a courtesy in the form.** The frontend check exists to
	// tell the typist before they submit; nothing stops a client from not being that frontend.
	it('refuses two different passwords, before the guard and before the submission', async () => {
		// koa-utils puts the readable half in `extensions.description` and keeps `message` at the status
		// title, so asserting on `message` alone would pass for every 400 this mutation can raise.
		await expect(shopOwnerRegister.resolve(null, { ...registerArgs, repeatPassword: 'sup3r-secrey' })).rejects.toMatchObject({
			message: 'Bad Request',
			extensions: { http: { status: 400 }, description: 'The two passwords do not match' }
		})

		expect(guardPublicWrite).not.toHaveBeenCalled()
		expect(submitShopOwnerRegistration).not.toHaveBeenCalled()
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

	// ⚠️ The guard runs before the submission, so a refused caller costs one Redis counter and nothing
	// else: no bcrypt round, no pending record, and above all no mail. A guard that ran afterwards would
	// meter the answer while the mail had already gone out.
	it('submits nothing once the guard has refused', async () => {
		guardPublicWrite.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow('Too many requests')

		expect(submitShopOwnerRegistration).not.toHaveBeenCalled()
	})

	it('guards before it submits', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(guardPublicWrite.mock.invocationCallOrder[0]).toBeLessThan(submitShopOwnerRegistration.mock.invocationCallOrder[0])
	})
})

describe('shopOwnerRegister — what it hands the flow', () => {
	// ⚠️ **Nothing is written to MongoDB by this resolver** (ADR-042). A submitted registration is a Redis
	// record with a three-day TTL and the `shopOwner` document is created by the confirmation click and by
	// nothing else — so this resolver is the normalisation, the two length checks, the guard and a call.
	// What the call then does about a free, a live or a closed address is `submitRegistration.test.mts`.
	it('submits the canonical address and the password as typed', async () => {
		await shopOwnerRegister.resolve(null, registerArgs)

		expect(submitShopOwnerRegistration).toHaveBeenCalledExactlyOnceWith(EMAIL, 'sup3r-secret')
	})

	// ⚠️ **The seller flow, never the customer one.** Both take an address and a password and neither can
	// tell them apart; the wrong binding here would open a `user` account for somebody who asked to sell,
	// and would skip the approval queue that makes this mutation safe to expose in the first place.
	it('submits through the seller binding', async () => {
		const module = await import('../src/lib/registration/submitRegistration.mts')

		expect(submitShopOwnerRegistration).toBe(module.submitShopOwnerRegistration)
	})

	// ⚠️ **Every outcome answers `true`, and that is the security property rather than laziness.** A
	// mutation that throws 409 for a taken address is an account-enumeration oracle: anybody can ask it,
	// one address at a time, who sells here. The outcomes are distinguishable only in the inbox — and the
	// approval state is never part of the answer either.
	it('answers true whatever the flow found', async () => {
		await expect(shopOwnerRegister.resolve(null, registerArgs)).resolves.toBe(true)
	})

	// `tryCatchRethrow` is what turns an unexpected driver error into a GraphQL error without leaking the
	// driver's message; a failure has to keep failing, not be swallowed into a `true`.
	it('rethrows rather than answering true when the flow fails', async () => {
		submitShopOwnerRegistration.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toThrow()
	})

	// The rethrow is a GraphQL error, not the driver's: a caller must not learn the host and port of the
	// Redis node from a failed registration.
	it('does not leak the driver’s message to the caller', async () => {
		submitShopOwnerRegistration.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))

		await expect(shopOwnerRegister.resolve(null, registerArgs)).rejects.toMatchObject({
			message: 'Internal Server Error'
		})
	})
})
