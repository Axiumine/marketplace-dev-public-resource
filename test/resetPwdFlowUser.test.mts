import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Sentinels: the factory is koa-utils' and is tested there. What this file pins is what WE hand it —
// which model, which paths, which mail domain — and that what comes back reaches the schema under the
// right names.
const boundResetPwd = { __sentinel: 'userResetPwd' }
const boundUpdatePassword = { __sentinel: 'userUpdatePwd' }
const boundMailer = { __sentinel: 'resetPwdMailer' }

const createResetPwdFlow = vi.fn(() => ({ resetPwd: boundResetPwd, updatePassword: boundUpdatePassword }))
const createResetPwdMailer = vi.fn(() => boundMailer)

vi.mock('@axiumine/koa-utils/lib/access/createResetPwdFlow', () => ({ createResetPwdFlow }))
vi.mock('@axiumine/koa-utils/lib/access/resetPwdMailer', () => ({ createResetPwdMailer }))

// Pinned rather than read from `.env`, so the assertion below states which variable the mail domain
// comes from instead of merely agreeing with whatever the machine happens to carry. Set before the
// dynamic import, because the module reads it once at load time.
const APP_DOMAIN_USER = 'https://storefront.test'
process.env.APP_DOMAIN_USER = APP_DOMAIN_USER

// Imported inside beforeAll for the reason the ShopOwner reset suite gives: the path map is a
// module-load-time object literal, so a mutant wiping it to `{}` does its damage during Vitest's
// file-collection phase, which Stryker's perTest coverage cannot attribute to any test — it is then
// reported Survived while the assertions below plainly fail against it.
let RESET_PWD_PATHS_USER: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['RESET_PWD_PATHS_USER']
let userResetPwd: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['userResetPwd']
let userUpdatePwd: (typeof import('../src/lib/access/resetPwdFlowUser.mts'))['userUpdatePwd']

beforeAll(async () => {
	;({ RESET_PWD_PATHS_USER, userResetPwd, userUpdatePwd } = await import('../src/lib/access/resetPwdFlowUser.mts'))
})

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
		expect(createResetPwdMailer).toHaveBeenCalledExactlyOnceWith(APP_DOMAIN_USER, '/reset-password/confirm#')
		expect(createResetPwdFlow.mock.calls[0][0].mailer).toBe(boundMailer)
	})

	// `/reset-password/confirm` is a **front-end** path, unlike `/check/verify-email-user/:email/:hash`
	// which is mounted in this process. Nothing fails when it is wrong — the link is followed by a
	// person, who lands on a 404 holding a valid hash — so this assertion is the only thing standing
	// between that route and a silent rename in `marketplace-user`.
	it('names the customer app’s route, not this service’s router prefix', () => {
		const [, path] = createResetPwdMailer.mock.calls[0]

		expect(path).toBe('/reset-password/confirm#')
		expect(path).not.toMatch(/^\/check/)
	})

	/*
	 * ⚠️ The trailing `#` is the whole of E12-S26 and the one character in this file that a tidy-up
	 * would remove. The link is assembled here the way koa-utils assembles it — `${base}${path}` then
	 * `/${encodeURI(email)}/${hash}`, `SocketLabsLib.mjs:280-283` — and handed to the platform's own URL
	 * parser rather than to a regex, so what is asserted is where a *browser* puts the credential: in
	 * `hash`, which RFC 3986 §3.5 never sends to a server, and out of `pathname`, which is what lands in
	 * an access log, a `Referer` and a proxy cache key.
	 *
	 * This mirrors a dependency rather than driving it: `createResetPwdMailer` is mocked in this file, so
	 * a koa-utils release that changed the concatenation would leave this green. That is a version-bump
	 * risk, stated, and the alternative — booting the real SocketLabs client — tests the vendor.
	 */
	it('puts the credential in the fragment, where no server can see it', () => {
		const [, path] = createResetPwdMailer.mock.calls[0]
		const link = new URL(`https://user.example${path}/${encodeURI('alice@example.com')}/9f3cabcd`)

		expect(link.href).toBe('https://user.example/reset-password/confirm#/alice@example.com/9f3cabcd')
		expect(link.hash).toBe('#/alice@example.com/9f3cabcd')
		expect(link.pathname).toBe('/reset-password/confirm')
		expect(link.pathname).not.toContain('9f3cabcd')
	})

	// The confirm screen is a page of its own, never the ask-for-your-address screen: the server cannot
	// see the fragment, so a link pointing at `/reset-password` would render the form that asks for an
	// address and silently drop the credential the customer just clicked.
	it('does not point the mail at the first half of the flow', () => {
		const [, path] = createResetPwdMailer.mock.calls[0]

		expect(path).not.toBe('/reset-password')
		expect(path).not.toBe('/reset-password#')
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
