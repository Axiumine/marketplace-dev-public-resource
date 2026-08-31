import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store is asserted by identity, so a sentinel is enough and no Redis is touched. Importing the real
// client would open a connection for a suite that never issues a command.
const redisClient = { __sentinel: 'redisClient' }
const revokeAllSessionsForAccount = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))
vi.mock('@axiumine/marketplace-common/others/revokeAllSessionsForAccount', () => ({ revokeAllSessionsForAccount }))

// The two models are NOT mocked: what the bindings at the bottom of the module are worth is precisely that
// they name the real `shopOwner` and `user` models, which a mock would assert nothing about. `findOne` is
// spied on per test instead.
//
// Imported inside `beforeEach` rather than at the top, the way every suite in this repo is: the two
// bindings are built at module load, so a top-level `await import()` evaluates them during Vitest's
// collection phase — outside the per-test window Stryker measures, where a killed mutant reads as Survived.
let createEndEverySession: (typeof import('../src/lib/access/endEverySession.mts'))['createEndEverySession']
let endEverySessionShopOwner: (typeof import('../src/lib/access/endEverySession.mts'))['endEverySessionShopOwner']
let endEverySessionUser: (typeof import('../src/lib/access/endEverySession.mts'))['endEverySessionUser']

const ACCOUNT_ID = '507f1f77bcf86cd799439011'
const EMAIL = 'customer@marketplace.test'

/** A model that answers `result` from `findOne(...).lean()`, and the two spies behind it. */
const modelYielding = (result: unknown) => {
	const lean = vi.fn().mockResolvedValue(result)
	const findOne = vi.fn(() => ({ lean }))

	// No `session` method on purpose: the transaction ended when the delegate returned, so a production
	// path that reached for one would fail here rather than silently join a session that is over.
	return { model: { findOne } as never, findOne, lean }
}

/** The single argument object `revokeAllSessionsForAccount` was handed. */
const revokedWith = () => revokeAllSessionsForAccount.mock.calls[0][0]

beforeEach(async () => {
	vi.restoreAllMocks()
	vi.clearAllMocks()
	;({ createEndEverySession, endEverySessionShopOwner, endEverySessionUser } =
		await import('../src/lib/access/endEverySession.mts'))
})

describe('createEndEverySession — the read', () => {
	it('seeks the login address alone, and projects nothing but the id', async () => {
		const { model, findOne, lean } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model, tier: TIER.user })(EMAIL)

		expect(findOne).toHaveBeenCalledExactlyOnceWith({ 'login.email': EMAIL }, '_id')
		expect(Object.keys(findOne.mock.calls[0][0])).toEqual(['login.email'])
		// `.lean()` straight off the query, with no arguments and no `.session(...)` in between.
		expect(lean).toHaveBeenCalledExactlyOnceWith()
	})

	// A wrong path is a runtime no-op, not a type error: the filter would match nothing, the account would
	// look absent and the mutation would answer 500 for every successful reset. The path is pinned against
	// both flow maps rather than against a second copy of the literal, so a rename in either one lands here.
	it('reads the same field the two reset flows match on', async () => {
		const { RESET_PWD_PATHS } = await import('../src/lib/access/resetPwdFlow.mts')
		const { RESET_PWD_PATHS_USER } = await import('../src/lib/access/resetPwdFlowUser.mts')
		const { model, findOne } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model, tier: TIER.user })(EMAIL)

		expect(findOne.mock.calls[0][0]).toEqual({ [RESET_PWD_PATHS.email]: EMAIL })
		expect(findOne.mock.calls[0][0]).toEqual({ [RESET_PWD_PATHS_USER.email]: EMAIL })
		expect(ShopOwner.schema.path(RESET_PWD_PATHS.email)).toBeDefined()
		expect(User.schema.path(RESET_PWD_PATHS_USER.email)).toBeDefined()
	})
})

describe('createEndEverySession — the revoke', () => {
	it('revokes through the shared routine, naming the store, the tier and the id and nothing else', async () => {
		const { model } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model, tier: TIER.shopOwner })(EMAIL)

		expect(revokeAllSessionsForAccount).toHaveBeenCalledExactlyOnceWith({
			store: redisClient,
			tier: TIER.shopOwner,
			accountId: ACCOUNT_ID
		})
		expect(Object.keys(revokedWith())).toEqual(['store', 'tier', 'accountId'])
	})

	// The routine takes a string, and an ObjectId handed straight through would be filed under whatever
	// Redis made of the object rather than under the hex the index is keyed on.
	it('hands the id over as its hex string, never as the ObjectId', async () => {
		const { model } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model, tier: TIER.user })(EMAIL)

		expect(revokedWith().accountId).toBe(ACCOUNT_ID)
		expect(typeof revokedWith().accountId).toBe('string')
	})

	// ⚠️ The whole revoke, deliberately. The authenticated services' helper also deletes the caller's own
	// access key, because an authenticated caller presents a bearer token; this caller presents none — the
	// reset form is reachable with no session at all — and since R54 the routine retires both halves of
	// what it names.
	it('issues no second command of its own', async () => {
		const { model } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model, tier: TIER.user })(EMAIL)

		expect(revokeAllSessionsForAccount).toHaveBeenCalledTimes(1)
	})

	it('carries the tier it was bound to, never a fixed one', async () => {
		const shopOwner = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })
		const user = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })

		await createEndEverySession({ model: shopOwner.model, tier: TIER.shopOwner })(EMAIL)
		await createEndEverySession({ model: user.model, tier: TIER.user })(EMAIL)

		expect(revokeAllSessionsForAccount.mock.calls[0][0].tier).toBe(TIER.shopOwner)
		expect(revokeAllSessionsForAccount.mock.calls[1][0].tier).toBe(TIER.user)
	})
})

describe('createEndEverySession — failing loudly', () => {
	// Unreachable through the front door: the delegate committed a write to this address moments ago. It is
	// still not silent — answering nothing here would mean reporting a completed reset with every session
	// still open, which is the one outcome this function exists to prevent.
	it('throws when the read cannot name the account, and revokes nothing', async () => {
		const { model } = modelYielding(null)

		await expect(createEndEverySession({ model, tier: TIER.shopOwner })(EMAIL)).rejects.toThrow(
			'endEverySession: no shopOwner account matched the address of a completed reset'
		)

		expect(revokeAllSessionsForAccount).not.toHaveBeenCalled()
	})

	// A plain Error, not a GraphQLError: the call sites hand it to `tryCatchRethrow`, which reports a plain
	// Error to Sentry and answers 500, while a GraphQLError would pass straight through unreported.
	it('names the tier and no address, and stays a plain Error', async () => {
		const { model } = modelYielding(null)

		await expect(createEndEverySession({ model, tier: TIER.user })(EMAIL)).rejects.toThrow(
			'endEverySession: no user account matched the address of a completed reset'
		)
		await expect(createEndEverySession({ model, tier: TIER.user })(EMAIL)).rejects.not.toThrow(EMAIL)
	})

	it('lets a refused revoke out rather than swallowing it', async () => {
		const { model } = modelYielding({ _id: new Types.ObjectId(ACCOUNT_ID) })
		revokeAllSessionsForAccount.mockRejectedValueOnce(new Error('Connection is closed'))

		await expect(createEndEverySession({ model, tier: TIER.user })(EMAIL)).rejects.toThrow('Connection is closed')
	})
})

describe('the two bindings', () => {
	it('points the seller half at the shopOwner collection, with the shopOwner tier', async () => {
		const lean = vi.fn().mockResolvedValue({ _id: new Types.ObjectId(ACCOUNT_ID) })
		const findOne = vi.spyOn(ShopOwner, 'findOne').mockReturnValue({ lean } as never)
		const userFindOne = vi.spyOn(User, 'findOne')

		await endEverySessionShopOwner(EMAIL)

		expect(findOne).toHaveBeenCalledExactlyOnceWith({ 'login.email': EMAIL }, '_id')
		expect(userFindOne).not.toHaveBeenCalled()
		expect(revokedWith().tier).toBe(TIER.shopOwner)
		expect(revokedWith().accountId).toBe(ACCOUNT_ID)
	})

	it('points the customer half at the user collection, with the user tier', async () => {
		const lean = vi.fn().mockResolvedValue({ _id: new Types.ObjectId(ACCOUNT_ID) })
		const findOne = vi.spyOn(User, 'findOne').mockReturnValue({ lean } as never)
		const shopOwnerFindOne = vi.spyOn(ShopOwner, 'findOne')

		await endEverySessionUser(EMAIL)

		expect(findOne).toHaveBeenCalledExactlyOnceWith({ 'login.email': EMAIL }, '_id')
		expect(shopOwnerFindOne).not.toHaveBeenCalled()
		expect(revokedWith().tier).toBe(TIER.user)
		expect(revokedWith().accountId).toBe(ACCOUNT_ID)
	})

	// The pair is what stops an id from one collection ending a session filed under another: nothing on a
	// Mongoose model says which tier it is, and nothing prevents two collections minting the same ObjectId.
	it('never crosses the collection with the other tier', async () => {
		expect(TIER.shopOwner).not.toBe(TIER.user)
		expect(ShopOwner.collection.name).toBe('shopOwner')
		expect(User.collection.name).toBe('user')
	})
})
