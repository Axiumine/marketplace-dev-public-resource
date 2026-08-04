import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Sentinels: the factory is koa-utils' and is tested there. What this file pins is what WE hand it,
// and that its two return values reach the schema under the right names.
const boundResetPwd = { __sentinel: 'resetPwd' }
const boundUpdatePassword = { __sentinel: 'updatePassword' }
const createResetPwdFlow = vi.fn(() => ({ resetPwd: boundResetPwd, updatePassword: boundUpdatePassword }))

vi.mock('@axiumine/koa-utils/lib/access/createResetPwdFlow', () => ({ createResetPwdFlow }))

// Imported dynamically inside beforeAll rather than at module top level (even a top-level
// `await import()` still runs during Vitest's file-collection phase, before any test executes).
// RESET_PWD_PATHS is a module-load-time object literal: a mutant that wipes it to `{}` does its
// damage at that same collection-time evaluation, which Stryker's perTest coverage analysis
// cannot attribute to any test - the mutant is reported Survived even though the assertions below
// plainly fail against it. Running the import inside beforeAll ties the evaluation to this file's
// own test run instead.
let RESET_PWD_PATHS: (typeof import('../src/lib/access/resetPwdFlow.mts'))['RESET_PWD_PATHS']
let resetPwd: (typeof import('../src/lib/access/resetPwdFlow.mts'))['resetPwd']
let updatePwd: (typeof import('../src/lib/access/resetPwdFlow.mts'))['updatePwd']

beforeAll(async () => {
	;({ RESET_PWD_PATHS, resetPwd, updatePwd } = await import('../src/lib/access/resetPwdFlow.mts'))
})

describe('resetPwdFlow', () => {
	it('builds the flow exactly once, against the Imprenditore model', () => {
		expect(createResetPwdFlow).toHaveBeenCalledTimes(1)
		expect(createResetPwdFlow.mock.calls[0][0].model).toBe(Imprenditore)
	})

	it('binds the flow to the imprenditore collection, not koa-utils UserBase', () => {
		// The whole point of the 5.3.0 factory. UserBase is collection 'user', which this database
		// does not have: while the flow was welded to it, every reset silently queried nothing.
		expect(Imprenditore.collection.name).toBe('imprenditore')
	})

	// Regression guard against the whole map being wiped to `{}`: a per-key check alone would not
	// catch that, since an absent key simply reads `undefined` and no single `expect(...).toBe(...)`
	// above would run at all. Asserting the complete object with `toEqual` fails against `{}`
	// (every key differs from undefined), and the explicit key count fails even in the pathological
	// case where a mutant swaps the whole map for a different 8-key object.
	it('passes the Marketplace path map, and nothing but it', () => {
		expect(Object.keys(RESET_PWD_PATHS)).toHaveLength(8)
		expect(RESET_PWD_PATHS).toEqual({
			email: 'login.email',
			password: 'login.password',
			name: 'anagrafica.nome',
			resetDateReq: 'resetPwd.resetDateReq',
			resetHash: 'resetPwd.resetHash',
			deleted: 'deleted',
			disabled: 'disabled',
			resetClear: ['resetPwd']
		})
		expect(createResetPwdFlow.mock.calls[0][0].paths).toEqual({
			email: 'login.email',
			password: 'login.password',
			name: 'anagrafica.nome',
			resetDateReq: 'resetPwd.resetDateReq',
			resetHash: 'resetPwd.resetHash',
			deleted: 'deleted',
			disabled: 'disabled',
			resetClear: ['resetPwd']
		})
	})

	// Regression guard. koa-utils 5.4.0 answers null for a deleted or disabled account, but it reads
	// those flags through paths that default to the UserBase layout - account.deleted and
	// account.disabled, neither of which exists on imprenditore. Dropping the keys is caught by tsc,
	// since RESET_PWD_PATHS is annotated with the full IResetPwdPaths rather than a Partial. Pointing
	// them at the WRONG path is not caught by anything: the gate reads undefined for every account
	// and silently never fires again. That is what this guard, and the schema check below, are for.
	// On imprenditore both flags live at the document root.
	it('points the account-state gate at the root flags, not the UserBase account subtree', () => {
		expect(RESET_PWD_PATHS.deleted).toBe('deleted')
		expect(RESET_PWD_PATHS.disabled).toBe('disabled')
		expect(RESET_PWD_PATHS.deleted).not.toMatch(/^account\./)
		expect(RESET_PWD_PATHS.disabled).not.toMatch(/^account\./)
	})

	// Regression guard. resetClear is NOT derived from resetDateReq + resetHash, and must not be
	// "simplified" into them: the migration declares resetPwd with required: ['resetDateReq',
	// 'resetHash'] under validationLevel 'strict' + validationAction 'error', so $unset-ing a single
	// member leaves a document the validator rejects and the cleanup write fails. Only the container
	// path is a legal clear.
	it('clears the whole resetPwd container, never its individual members', () => {
		expect(RESET_PWD_PATHS.resetClear).toEqual(['resetPwd'])
		expect(RESET_PWD_PATHS.resetClear).not.toContain(RESET_PWD_PATHS.resetDateReq)
		expect(RESET_PWD_PATHS.resetClear).not.toContain(RESET_PWD_PATHS.resetHash)
	})

	// Regression guard. The reset token has its own field. Pointing resetHash at the
	// email-verification slot (account.email.hash on UserBase) let a hash issued by either flow
	// authenticate the other, and made an unauthenticated reset request kill pending activation links.
	it('keeps the reset hash off any email-verification slot', () => {
		expect(RESET_PWD_PATHS.resetHash).toBe('resetPwd.resetHash')
		expect(RESET_PWD_PATHS.resetHash).not.toMatch(/email/)
	})

	// A wrong path is a runtime no-op, not a type error: findOne would match nothing and $set would
	// write a field the strict validator rejects. Checking the map against the real schema is the
	// only thing that catches a rename in marketplace-common - so the table is built FROM the map, not
	// from a copy of it. Duplicating the literals here would only assert that marketplace-common has the
	// fields, never that RESET_PWD_PATHS points at them.
	//
	// A plain loop, not `it.each`: `it.each`'s table is built while `describe` registers its tests,
	// which runs synchronously during collection - before `beforeAll` has populated RESET_PWD_PATHS
	// (see the import note above). Reading it here, inside the test body, runs after the hook.
	it('resolves every path, including resetClear, on the real Imprenditore schema', () => {
		const table: Array<[string, string]> = [
			['email', RESET_PWD_PATHS.email],
			['password', RESET_PWD_PATHS.password],
			['name', RESET_PWD_PATHS.name],
			['resetDateReq', RESET_PWD_PATHS.resetDateReq],
			['resetHash', RESET_PWD_PATHS.resetHash],
			['deleted', RESET_PWD_PATHS.deleted],
			['disabled', RESET_PWD_PATHS.disabled],
			...RESET_PWD_PATHS.resetClear.map((p, i): [string, string] => [`resetClear[${i}]`, p])
		]

		for (const [key, dottedPath] of table) {
			expect(Imprenditore.schema.path(dottedPath), `${key} -> ${dottedPath}`).toBeDefined()
		}
	})

	it('exports the flow mutations, updatePassword under the schema name updatePwd', () => {
		expect(resetPwd).toBe(boundResetPwd)
		expect(updatePwd).toBe(boundUpdatePassword)
	})
})
