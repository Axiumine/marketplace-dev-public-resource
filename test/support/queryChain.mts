// What the two public-read suites share, and nothing else.
//
// `publicQueriesShops.test.mts` and `publicQueriesItems.test.mts` cover two different halves of the
// same public tier — companies and the catalogue — and both drive their resolvers through the same
// two fixtures: a mocked mongoose `Query` and the liveness filter every public read carries. Kept in
// one place because the alternative is not merely duplication: a `live` that drifts on one side
// would let one suite go on asserting a filter the other has stopped using, and neither would fail.
//
// This file is NOT a test file. `test/*.test.mts` is the unit project's include glob, so anything
// under `test/support/` is only ever loaded by a suite that imports it.

import { trusted } from 'mongoose'
import { expect, Mock, vi } from 'vitest'

/** A mongoose `Query`, mocked as the fluent object it is: every link returns itself, `lean` resolves. */
export interface IChain {
	sort: Mock
	skip: Mock
	limit: Mock
	session: Mock
	lean: Mock
}

export const chain = (docs: unknown): IChain => {
	const self = {} as IChain

	self.sort = vi.fn(() => self)
	self.skip = vi.fn(() => self)
	self.limit = vi.fn(() => self)
	// The registration reads carry a `session`; the public ones never do. One link serves both, and a
	// suite that cares which asserts on the mock rather than on the chain's shape.
	self.session = vi.fn(() => self)
	self.lean = vi.fn(async () => docs)

	return self
}

/**
 * The symbol mongoose stamps on a `trusted()` object, read off a throwaway rather than hard-coded:
 * it is an internal name, and a suite that spelled it out would keep passing after mongoose renamed
 * it while the production filter had quietly stopped being trusted.
 */
export const TRUSTED = Object.getOwnPropertySymbols(trusted({}))[0]

/** The liveness clause every public read carries — published, and not a tombstone. */
export const live = { published: true, deleted: trusted({ $exists: false }) }

/**
 * The `itemCategory` filter, asserted whole.
 *
 * ⚠️ The operator *and* its boolean, not merely the key. `$exists: true` inverts the filter into
 * "tombstones only" — a sitemap made entirely of deleted categories — and `{}` drops it altogether,
 * and neither shows up in the key set. The `trusted` tag is the third assertion for the same reason:
 * `sanitizeFilter` is on globally, and an untagged operator object is stripped before it reaches the
 * server.
 */
export const expectTombstoneFilter = (filter: Record<string, Record<string | symbol, unknown>>): void => {
	expect(Object.keys(filter)).toEqual(['deleted'])
	expect(filter.deleted.$exists).toBe(false)
	expect(filter.deleted[TRUSTED]).toBe(true)
}
