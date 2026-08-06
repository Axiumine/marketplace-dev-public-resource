import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Sentinels: both factories are koa-utils' and are tested there. What this file pins is what WE hand
// them — which model, which paths, which disposal policy, which mail domain — and that what comes
// back reaches the schema under the right names.
const boundRouterVerifyEmail = { __sentinel: 'routerVerifyEmailUser' }
const boundSetEmailHash = { __sentinel: 'setEmailHashUser' }
const boundResetPwd = { __sentinel: 'userResetPwd' }
const boundUpdatePassword = { __sentinel: 'userUpdatePwd' }
const boundMailer = { __sentinel: 'resetPwdMailer' }

const createVerifyEmailFlow = vi.fn(() => ({ routerVerifyEmail: boundRouterVerifyEmail, setEmailHash: boundSetEmailHash }))
const createResetPwdFlow = vi.fn(() => ({ resetPwd: boundResetPwd, updatePassword: boundUpdatePassword }))
const createResetPwdMailer = vi.fn(() => boundMailer)

vi.mock('@axiumine/koa-utils/lib/access/createVerifyEmailFlow', () => ({ createVerifyEmailFlow }))
vi.mock('@axiumine/koa-utils/lib/access/createResetPwdFlow', () => ({ createResetPwdFlow }))
vi.mock('@axiumine/koa-utils/lib/access/resetPwdMailer', () => ({ createResetPwdMailer }))

// Pinned rather than read from `.env`, so the assertion below states which variable the mail domain
// comes from instead of merely agreeing with whatever the machine happens to carry. Set before the
// dynamic import, because the module reads it once at load time.
const APP_DOMAIN_USER = 'https://storefront.test'
process.env.APP_DOMAIN_USER = APP_DOMAIN_USER

// Imported inside beforeAll for the reason the two ShopOwner flow suites give: the path maps are
// module-load-time object literals, so a mutant wiping one to `{}` does its damage during Vitest's
// file-collection phase, which Stryker's perTest coverage cannot attribute to any test — it is then
// reported Survived while the assertions below plainly fail against it.
let VERIFY_EMAIL_PATHS_USER: (typeof import('../src/lib/access/verifyEmailFlowUser.mts'))['VERIFY_EMAIL_PATHS_USER']
let routerVerifyEmailUser: (typeof import('../src/lib/access/verifyEmailFlowUser.mts'))['routerVerifyEmailUser']
let setEmailHashUser: (typeof import('../src/lib/access/verifyEmailFlowUser.mts'))['setEmailHashUser']
let RESET_PWD_PATHS_USER: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['RESET_PWD_PATHS_USER']
let userResetPwd: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['userResetPwd']
let userUpdatePwd: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['userUpdatePwd']

beforeAll(async () => {
	;({ VERIFY_EMAIL_PATHS_USER, routerVerifyEmailUser, setEmailHashUser } =
		await import('../src/lib/access/verifyEmailFlowUser.mts'))
	;({ RESET_PWD_PATHS_USER, userResetPwd, userUpdatePwd } = await import('../src/lib/access/resetPwdFlowUser.mts'))
})

const EXPECTED_VERIFY = {
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

const EXPECTED_RESET = {
	email: 'login.email',
	password: 'login.password',
	name: 'personalData.firstName',
	resetDateReq: 'resetPwd.resetDateReq',
	resetHash: 'resetPwd.resetHash',
	deleted: 'deleted',
	disabled: 'disabled',
	resetClear: ['resetPwd']
}

describe('verifyEmailFlowUser', () => {
	// ⚠️ The whole reason this module exists next to `verifyEmailFlow.mts` rather than being merged
	// with it: the two flows are bound to two collections. A shared binding would confirm a customer's
	// link against `shopOwner` and report every valid hash as a bad one.
	it('builds the flow exactly once, against the User model', () => {
		expect(createVerifyEmailFlow).toHaveBeenCalledTimes(1)
		expect(createVerifyEmailFlow.mock.calls[0][0].model).toBe(User)
		expect(User.collection.name).toBe('user')
	})

	// The key set as well as the values: a mutant that drops `onAbandon` fails no per-key assertion,
	// because koa-utils then defaults it to `'delete'` — precisely the behaviour this binding exists
	// to avoid.
	it('passes exactly model, paths, onAbandon and deletedValue', () => {
		expect(Object.keys(createVerifyEmailFlow.mock.calls[0][0])).toEqual(['model', 'paths', 'onAbandon', 'deletedValue'])
	})

	// ⚠️ Soft-delete, arrived at from the other direction than the shop owner's: `login.email` carries
	// a unique index with no `partialFilterExpression`, so a hard delete on an abandoned registration
	// frees that address for anyone to claim — including whoever was mistyping it into the form. The
	// tombstone keeps the address bound to the person who first proved they could receive mail there.
	it('soft-deletes an abandoned registration instead of dropping the row', () => {
		expect(createVerifyEmailFlow.mock.calls[0][0].onAbandon).toBe('soft-delete')
	})

	// koa-utils defaults `deletedValue` to boolean `true`, which `user.deleted` rejects twice over —
	// `bsonType: 'date'` in the validator and `Date` on the model. The function form also stamps the
	// moment of the write rather than the moment this module was imported, which is why it is called
	// twice here rather than captured once.
	it('tombstones with a fresh Date, which is what the user schema declares', () => {
		const { deletedValue } = createVerifyEmailFlow.mock.calls[0][0]

		expect(typeof deletedValue).toBe('function')
		expect(User.schema.path('deleted').instance).toBe('Date')

		const first = deletedValue()
		const second = deletedValue()

		expect(first).toBeInstanceOf(Date)
		expect(second).toBeInstanceOf(Date)
		expect(second).not.toBe(first)
		expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime())
	})

	// Whole-object assertion plus an explicit key count: a per-key check cannot fail against `{}`
	// (no `expect` inside a missing key ever runs), and the count catches a mutant swapping in a
	// different 10-key object.
	it('passes the customer path map, and nothing but it', () => {
		expect(Object.keys(VERIFY_EMAIL_PATHS_USER)).toHaveLength(10)
		expect(VERIFY_EMAIL_PATHS_USER).toEqual(EXPECTED_VERIFY)
		expect(createVerifyEmailFlow.mock.calls[0][0].paths).toEqual(EXPECTED_VERIFY)
	})

	// An unset key falls back to koa-utils' `UserBase` layout — `account.email.*` on collection
	// `user`, which on this platform *does* exist now and holds the customer, so the fallback would no
	// longer even miss loudly. It would read `undefined` for every account and silently never fire.
	it('points the account-state gate at the root flags, not the UserBase account subtree', () => {
		expect(VERIFY_EMAIL_PATHS_USER.deleted).toBe('deleted')
		expect(VERIFY_EMAIL_PATHS_USER.disabled).toBe('disabled')
		expect(VERIFY_EMAIL_PATHS_USER.deleted).not.toMatch(/^account\./)
		expect(VERIFY_EMAIL_PATHS_USER.disabled).not.toMatch(/^account\./)
	})

	// The leaf paths, never the container: `emailVerify` declares no `required` array precisely so
	// these three can go while `valid: true` — the one thing the verification produced — stays.
	it('clears the three token members and never the emailVerify container', () => {
		expect(VERIFY_EMAIL_PATHS_USER.verifyClear).toEqual([
			VERIFY_EMAIL_PATHS_USER.hash,
			VERIFY_EMAIL_PATHS_USER.dateLastReq,
			VERIFY_EMAIL_PATHS_USER.requestTimes
		])
		expect(VERIFY_EMAIL_PATHS_USER.verifyClear).not.toContain('emailVerify')
		expect(VERIFY_EMAIL_PATHS_USER.verifyClear).not.toContain(VERIFY_EMAIL_PATHS_USER.valid)
	})

	it('clears the pending address too when a change is confirmed', () => {
		expect(VERIFY_EMAIL_PATHS_USER.emailChangeClear).toEqual([
			...VERIFY_EMAIL_PATHS_USER.verifyClear,
			VERIFY_EMAIL_PATHS_USER.newEmailTmp
		])
	})

	// A wrong path is a runtime no-op rather than a type error — `findOne` matches nothing and `$set`
	// writes a field the strict validator rejects. The table is built FROM the map, so a rename in
	// marketplace-common fails here instead of in production.
	//
	// A plain loop, not `it.each`: `it.each` builds its table while `describe` registers, which runs
	// during collection — before `beforeAll` has populated the map.
	it('resolves every path, including both clear lists, on the real User schema', () => {
		const table: Array<[string, string]> = [
			['email', VERIFY_EMAIL_PATHS_USER.email],
			['valid', VERIFY_EMAIL_PATHS_USER.valid],
			['hash', VERIFY_EMAIL_PATHS_USER.hash],
			['dateLastReq', VERIFY_EMAIL_PATHS_USER.dateLastReq],
			['requestTimes', VERIFY_EMAIL_PATHS_USER.requestTimes],
			['newEmailTmp', VERIFY_EMAIL_PATHS_USER.newEmailTmp],
			['deleted', VERIFY_EMAIL_PATHS_USER.deleted],
			['disabled', VERIFY_EMAIL_PATHS_USER.disabled],
			...VERIFY_EMAIL_PATHS_USER.verifyClear.map((p, i): [string, string] => [`verifyClear[${i}]`, p]),
			...VERIFY_EMAIL_PATHS_USER.emailChangeClear.map((p, i): [string, string] => [`emailChangeClear[${i}]`, p])
		]

		for (const [key, dottedPath] of table) {
			expect(User.schema.path(dottedPath), `${key} -> ${dottedPath}`).toBeDefined()
		}
	})

	// Both are re-exported because the registration resolvers need the hash minter and the router
	// needs the handler — and neither may be taken from koa-utils' own exports, which are bound to
	// UserBase.
	it('re-exports the flow-bound router factory and hash minter', () => {
		expect(routerVerifyEmailUser).toBe(boundRouterVerifyEmail)
		expect(setEmailHashUser).toBe(boundSetEmailHash)
	})
})

describe('resetPwdFlowUser', () => {
	it('builds the flow exactly once, against the User model', () => {
		expect(createResetPwdFlow).toHaveBeenCalledTimes(1)
		expect(createResetPwdFlow.mock.calls[0][0].model).toBe(User)
	})

	it('passes the customer path map, and nothing but it', () => {
		expect(Object.keys(RESET_PWD_PATHS_USER)).toHaveLength(8)
		expect(RESET_PWD_PATHS_USER).toEqual(EXPECTED_RESET)
		expect(createResetPwdFlow.mock.calls[0][0].paths).toEqual(EXPECTED_RESET)
	})

	// ⚠️ The mailer is the whole reason this module is not one line. koa-utils' `sendEmailReset`
	// builds its link on `APP_DOMAIN` — the operator/shop-owner origin — and a customer who followed
	// that link would land on a panel that cannot complete the reset. The resolver cannot make the
	// choice itself: by the time it holds an email and a hash, two collections behind this one process
	// look identical.
	it('mails the link on the storefront domain, at the frontend reset route', () => {
		expect(createResetPwdMailer).toHaveBeenCalledExactlyOnceWith(APP_DOMAIN_USER, '/reset-password')
		expect(createResetPwdFlow.mock.calls[0][0].mailer).toBe(boundMailer)
	})

	// `/reset-password` is a **front-end** path, unlike `/check/verify-email-user/:email/:hash` which
	// is mounted in this process. Nothing fails when it is wrong — the link is followed by a person,
	// who lands on a 404 holding a valid hash — so this assertion is the only thing standing between
	// that route and a silent rename in `marketplace-user`.
	it('names the customer app’s route, not this service’s router prefix', () => {
		const [, path] = createResetPwdMailer.mock.calls[0]

		expect(path).toBe('/reset-password')
		expect(path).not.toMatch(/^\/check/)
	})

	// The gate koa-utils applies before it will send anything. Same argument as on the verify flow:
	// an unset key silently reads `account.deleted`, which does not exist on this collection.
	it('points the account-state gate at the root flags', () => {
		expect(RESET_PWD_PATHS_USER.deleted).toBe('deleted')
		expect(RESET_PWD_PATHS_USER.disabled).toBe('disabled')
		expect(RESET_PWD_PATHS_USER.deleted).not.toMatch(/^account\./)
	})

	// ⚠️ The container, and deliberately the opposite shape from `verifyClear`: the migration declares
	// `resetPwd` with `required: ['resetDateReq', 'resetHash']` under a strict validator, so unsetting
	// one member leaves a document the database rejects and the cleanup write fails.
	it('clears the whole resetPwd container, never its individual members', () => {
		expect(RESET_PWD_PATHS_USER.resetClear).toEqual(['resetPwd'])
		expect(RESET_PWD_PATHS_USER.resetClear).not.toContain(RESET_PWD_PATHS_USER.resetDateReq)
		expect(RESET_PWD_PATHS_USER.resetClear).not.toContain(RESET_PWD_PATHS_USER.resetHash)
	})

	// While the two token slots shared a field, a hash issued by either flow authenticated the other,
	// and an unauthenticated reset request killed pending activation links.
	it('keeps the reset hash off any email-verification slot', () => {
		expect(RESET_PWD_PATHS_USER.resetHash).toBe('resetPwd.resetHash')
		expect(RESET_PWD_PATHS_USER.resetHash).not.toMatch(/email/)
	})

	// ⚠️ `personalData.firstName` is optional on `user` — registration is an address and a password,
	// and the name arrives later or never. The path is still declared because leaving it unset falls
	// back to `UserBase`'s `account.name`, which reads `undefined` for every customer, named or not.
	it('resolves every path, including resetClear, on the real User schema', () => {
		const table: Array<[string, string]> = [
			['email', RESET_PWD_PATHS_USER.email],
			['password', RESET_PWD_PATHS_USER.password],
			['name', RESET_PWD_PATHS_USER.name],
			['resetDateReq', RESET_PWD_PATHS_USER.resetDateReq],
			['resetHash', RESET_PWD_PATHS_USER.resetHash],
			['deleted', RESET_PWD_PATHS_USER.deleted],
			['disabled', RESET_PWD_PATHS_USER.disabled],
			...RESET_PWD_PATHS_USER.resetClear.map((p, i): [string, string] => [`resetClear[${i}]`, p])
		]

		for (const [key, dottedPath] of table) {
			expect(User.schema.path(dottedPath), `${key} -> ${dottedPath}`).toBeDefined()
		}
	})

	it('exports the flow mutations, updatePassword under the schema name userUpdatePwd', () => {
		expect(userResetPwd).toBe(boundResetPwd)
		expect(userUpdatePwd).toBe(boundUpdatePassword)
	})
})
