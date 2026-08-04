import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Sentinel: the factory is koa-utils' and is tested there. What this file pins is what WE hand it,
// and that the handler it returns is the one the router mounts.
const boundRouterVerifyEmail = { __sentinel: 'routerVerifyEmail' }
const createVerifyEmailFlow = vi.fn(() => ({ routerVerifyEmail: boundRouterVerifyEmail }))

vi.mock('@axiumine/koa-utils/lib/access/createVerifyEmailFlow', () => ({ createVerifyEmailFlow }))

// Imported dynamically inside beforeAll for the same reason as resetPwdFlow.test.mts: VERIFY_EMAIL_PATHS
// is a module-load-time object literal, so a mutant wiping it to `{}` does its damage during Vitest's
// file-collection phase, which Stryker's perTest coverage cannot attribute to any test — it is then
// reported Survived even though the assertions below plainly fail against it.
let VERIFY_EMAIL_PATHS: (typeof import('../src/lib/access/verifyEmailFlow.mts'))['VERIFY_EMAIL_PATHS']
let routerVerifyEmail: (typeof import('../src/lib/access/verifyEmailFlow.mts'))['routerVerifyEmail']

beforeAll(async () => {
	;({ VERIFY_EMAIL_PATHS, routerVerifyEmail } = await import('../src/lib/access/verifyEmailFlow.mts'))
})

const EXPECTED = {
	email: 'login.email',
	valid: 'emailVerify.valid',
	hash: 'emailVerify.hash',
	dateLastReq: 'emailVerify.dateLastReq',
	requestTimes: 'emailVerify.requestTimes',
	newEmailTmp: 'emailVerify.newEmailTmp',
	deleted: 'deleted',
	disabled: 'disabled',
	verifyClear: ['emailVerify.hash', 'emailVerify.dateLastReq', 'emailVerify.requestTimes'],
	emailChangeClear: ['emailVerify.hash', 'emailVerify.dateLastReq', 'emailVerify.requestTimes', 'emailVerify.newEmailTmp']
}

describe('verifyEmailFlow', () => {
	it('builds the flow exactly once, against the Imprenditore model', () => {
		expect(createVerifyEmailFlow).toHaveBeenCalledTimes(1)
		expect(createVerifyEmailFlow.mock.calls[0][0].model).toBe(Imprenditore)
	})

	// The whole argument object, key set included. Two things ride on this. A mutant that drops
	// `onAbandon` does not fail any per-key assertion — koa-utils defaults it to 'delete', which is
	// precisely the behaviour this binding exists to avoid — and the integration suite builds its own
	// flow from these same values plus a recording mailer, an argument that only holds while nothing
	// else is being passed here.
	it('passes exactly model, paths, onAbandon and deletedValue', () => {
		expect(Object.keys(createVerifyEmailFlow.mock.calls[0][0])).toEqual(['model', 'paths', 'onAbandon', 'deletedValue'])
	})

	// Disposal policy. koa-utils 5.6.1 had no such option: both abandon guards hard-deleted, and on
	// `imprenditore` that dropped the row while its puntoVendita → categoria → 13 food collections went
	// on pointing at an idImprenditore nothing resolved any more.
	it('soft-deletes an abandoned registration instead of dropping the row', () => {
		expect(createVerifyEmailFlow.mock.calls[0][0].onAbandon).toBe('soft-delete')
	})

	// koa-utils defaults `deletedValue` to boolean `true`, right for its own UserBase and wrong here
	// twice: `deleted` is a Date on the model AND `bsonType: 'date'` in the collection validator, so
	// the default is rejected by both. The schema assertion is what makes that concrete rather than a
	// claim in a comment.
	it('tombstones with a fresh Date, which is what the imprenditore schema declares', () => {
		const { deletedValue } = createVerifyEmailFlow.mock.calls[0][0]

		expect(typeof deletedValue).toBe('function')
		expect(Imprenditore.schema.path('deleted').instance).toBe('Date')

		// Called per disposal, not captured once: the function form is the only reason the tombstone
		// carries the moment of the write rather than the moment this module was first imported.
		const first = deletedValue()
		const second = deletedValue()

		expect(first).toBeInstanceOf(Date)
		expect(second).toBeInstanceOf(Date)
		expect(second).not.toBe(first)
		expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime())
	})

	// The route existed for years and never once reached a real account: koa-utils' own export is
	// bound to UserBase, collection 'user', which this database does not have. Every request found
	// nothing and redirected to the failure page, including requests carrying a valid hash.
	it('binds the flow to the imprenditore collection, not koa-utils UserBase', () => {
		expect(Imprenditore.collection.name).toBe('imprenditore')
	})

	// Whole-object assertion plus an explicit key count, for the same reason as the reset map: a
	// per-key check cannot fail against `{}` (no `expect` inside a missing key ever runs), and the
	// count catches a mutant swapping in a different 10-key object.
	it('passes the Marketplace path map, and nothing but it', () => {
		expect(Object.keys(VERIFY_EMAIL_PATHS)).toHaveLength(10)
		expect(VERIFY_EMAIL_PATHS).toEqual(EXPECTED)
		expect(createVerifyEmailFlow.mock.calls[0][0].paths).toEqual(EXPECTED)
	})

	// The defaults are account.deleted / account.disabled, neither of which exists here, so an omitted
	// key leaves the account-state gate reading undefined forever and silently never firing. tsc
	// catches an absent key (the map is annotated with the full IVerifyEmailPaths, not a Partial); it
	// does not catch a wrong one.
	it('points the account-state gate at the root flags, not the UserBase account subtree', () => {
		expect(VERIFY_EMAIL_PATHS.deleted).toBe('deleted')
		expect(VERIFY_EMAIL_PATHS.disabled).toBe('disabled')
		expect(VERIFY_EMAIL_PATHS.deleted).not.toMatch(/^account\./)
		expect(VERIFY_EMAIL_PATHS.disabled).not.toMatch(/^account\./)
	})

	// The mirror image of the resetPwd guard, and deliberately the opposite shape. resetClear must be
	// the ['resetPwd'] CONTAINER because that subdocument declares required: ['resetDateReq',
	// 'resetHash'] — unsetting one member leaves a document strict validation rejects. emailVerify
	// declares no required array at all, precisely so these three can go while `valid` stays. Clearing
	// the container here would throw away valid: true, the one thing the verification produced.
	it('clears the three token members and never the emailVerify container', () => {
		expect(VERIFY_EMAIL_PATHS.verifyClear).toEqual([
			VERIFY_EMAIL_PATHS.hash,
			VERIFY_EMAIL_PATHS.dateLastReq,
			VERIFY_EMAIL_PATHS.requestTimes
		])
		expect(VERIFY_EMAIL_PATHS.verifyClear).not.toContain('emailVerify')
		expect(VERIFY_EMAIL_PATHS.verifyClear).not.toContain(VERIFY_EMAIL_PATHS.valid)
	})

	// emailChangeClear is verifyClear plus the pending address — the change is only abandoned once
	// the new address has been written to login.email, so leaving newEmailTmp behind would keep an
	// already-consumed change offerable.
	it('clears the pending address too when a change is confirmed', () => {
		expect(VERIFY_EMAIL_PATHS.emailChangeClear).toEqual([...VERIFY_EMAIL_PATHS.verifyClear, VERIFY_EMAIL_PATHS.newEmailTmp])
	})

	// The two token slots must not be pointed at the same field. While they shared one, a hash issued
	// by either flow authenticated the other, and an unauthenticated reset request killed pending
	// activation links.
	it('keeps the verification hash off the password-reset slot', () => {
		expect(VERIFY_EMAIL_PATHS.hash).toBe('emailVerify.hash')
		expect(VERIFY_EMAIL_PATHS.hash).not.toMatch(/reset/i)
	})

	// A wrong path is a runtime no-op, not a type error: findOne matches nothing and $set writes a
	// field the strict validator rejects. The table is built FROM the map rather than from a copy of
	// the literals, so a rename in marketplace-common fails here instead of in production.
	//
	// A plain loop, not `it.each`: it.each's table is built while describe registers its tests, which
	// runs during collection — before beforeAll has populated VERIFY_EMAIL_PATHS.
	it('resolves every path, including both clear lists, on the real Imprenditore schema', () => {
		const table: Array<[string, string]> = [
			['email', VERIFY_EMAIL_PATHS.email],
			['valid', VERIFY_EMAIL_PATHS.valid],
			['hash', VERIFY_EMAIL_PATHS.hash],
			['dateLastReq', VERIFY_EMAIL_PATHS.dateLastReq],
			['requestTimes', VERIFY_EMAIL_PATHS.requestTimes],
			['newEmailTmp', VERIFY_EMAIL_PATHS.newEmailTmp],
			['deleted', VERIFY_EMAIL_PATHS.deleted],
			['disabled', VERIFY_EMAIL_PATHS.disabled],
			...VERIFY_EMAIL_PATHS.verifyClear.map((p, i): [string, string] => [`verifyClear[${i}]`, p]),
			...VERIFY_EMAIL_PATHS.emailChangeClear.map((p, i): [string, string] => [`emailChangeClear[${i}]`, p])
		]

		for (const [key, dottedPath] of table) {
			expect(Imprenditore.schema.path(dottedPath), `${key} -> ${dottedPath}`).toBeDefined()
		}
	})

	it('re-exports the flow-bound router factory', () => {
		expect(routerVerifyEmail).toBe(boundRouterVerifyEmail)
	})
})
