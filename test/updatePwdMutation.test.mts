import { beforeEach, describe, expect, it, vi } from 'vitest'

// The bound flow is koa-utils' and is pinned in `resetPwdFlow.test.mts`; what this file pins is the layer
// this repo added on top of it. Sentinels rather than real GraphQL objects: nothing here builds a schema,
// so nothing here needs the `graphql` copy koa-utils was compiled against.
const BOUND_TYPE = { __sentinel: 'boundType' }
const BOUND_ARGS = { __sentinel: 'boundArgs' }
const BOUND_DESCRIPTION = "changes the user's password"
const boundResolve = vi.fn(async () => true)
const endEverySessionShopOwner = vi.fn()

vi.mock('../src/lib/access/resetPwdFlow.mts', () => ({
	updatePwd: { description: BOUND_DESCRIPTION, type: BOUND_TYPE, args: BOUND_ARGS, resolve: boundResolve }
}))
vi.mock('../src/lib/access/endEverySession.mts', () => ({ endEverySessionShopOwner }))

// `tryCatchRethrow` is deliberately NOT mocked: the point of the catch is which answer a refused revoke
// produces, and mocking the thing that decides it would assert only that a function was called.

// Imported inside `beforeEach` rather than at the top, the way every mutation suite in this repo is: the
// field object is built at module load, so a top-level `await import()` evaluates it during Vitest's
// collection phase — outside the per-test window Stryker measures, where a killed mutant reads as Survived.
let updatePwd: (typeof import('../src/graphQLPublic/schema/mutations/updatePwd.mts'))['updatePwd']

/** Mixed case and a trailing space, because the address the read uses has to be the normalised one. */
const TYPED_EMAIL = ' Owner@Marketplace.TEST '
const EMAIL = 'owner@marketplace.test'

const updateArgs = { email: TYPED_EMAIL, hash: 'reset-hash', password: 'a-new-password' }

beforeEach(async () => {
	vi.clearAllMocks()
	boundResolve.mockResolvedValue(true)
	;({ updatePwd } = await import('../src/graphQLPublic/schema/mutations/updatePwd.mts'))
})

describe('updatePwd — the field', () => {
	// Borrowed by reference, not restated. A hand-copied `args` map here would be a second place for the
	// reset triple to drift from the one koa-utils actually reads, and the drift would be invisible.
	it('is the bound flow’s own description, type and arguments', () => {
		expect(updatePwd.description).toBe(BOUND_DESCRIPTION)
		expect(updatePwd.type).toBe(BOUND_TYPE)
		expect(updatePwd.args).toBe(BOUND_ARGS)
	})
})

describe('updatePwd — the write', () => {
	it('delegates the reset triple verbatim and answers what the flow answered', async () => {
		const source = { some: 'source' }

		await expect(updatePwd.resolve(source, updateArgs)).resolves.toBe(true)

		expect(boundResolve).toHaveBeenCalledExactlyOnceWith(source, updateArgs)
	})

	it('does not swallow the flow’s refusal, and revokes nothing on one', async () => {
		boundResolve.mockRejectedValueOnce(new Error('Forbidden'))

		await expect(updatePwd.resolve(null, updateArgs)).rejects.toThrow('Forbidden')

		expect(endEverySessionShopOwner).not.toHaveBeenCalled()
	})
})

describe('updatePwd — ending the sessions the reset just made resettable', () => {
	it('ends every session the seller holds, under the normalised address', async () => {
		await updatePwd.resolve(null, updateArgs)

		expect(endEverySessionShopOwner).toHaveBeenCalledExactlyOnceWith(EMAIL)
	})

	// ⚠️ After the delegate, never before it. A revoke placed first would log the owner out of every device
	// for a reset that then failed validation, and would run the read on every wrong hash and every unknown
	// address — the whole rate-limited abuse surface — for the one caller in a thousand about to succeed.
	it('revokes only once the write has returned', async () => {
		await updatePwd.resolve(null, updateArgs)

		expect(boundResolve.mock.invocationCallOrder[0]).toBeLessThan(endEverySessionShopOwner.mock.invocationCallOrder[0])
	})

	// ⚠️ The password is live and the hash is spent by the time this fires, so the caller has to request a
	// fresh link. That cost is accepted: the alternative is answering `true` with every stolen session still
	// open, which is the exact lie this wrapper exists to stop telling.
	it('answers 500 rather than true when the revoke is refused', async () => {
		endEverySessionShopOwner.mockRejectedValueOnce(new Error('Connection is closed'))

		await expect(updatePwd.resolve(null, updateArgs)).rejects.toThrow('Internal Server Error')
	})

	it('reports the refused revoke as a 500 through tryCatchRethrow, not as the raw Redis error', async () => {
		endEverySessionShopOwner.mockRejectedValueOnce(new Error('Connection is closed'))

		const thrown = await updatePwd.resolve(null, updateArgs).catch((e: unknown) => e)

		expect((thrown as { extensions?: { http?: { status?: number } } }).extensions?.http?.status).toBe(500)
	})
})
