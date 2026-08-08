import { trusted, Types } from 'mongoose'
import { describe, expect, it } from 'vitest'

import {
	assertObjectId,
	assertOffset,
	clampLimit,
	COUNT_CAP,
	DEFAULT_LIMIT,
	LIVE_PUBLIC_PIPELINE,
	livePublic,
	MAX_LIMIT,
	MAX_OFFSET
} from '../src/lib/catalogue/publicRead.mts'

// `trusted()` marks its argument with a private, non-registered Symbol, so the tag cannot be written
// by hand — it is read off a sample instead. Asserting the tag itself rather than only the object's
// shape is what makes the `sanitizeFilter` trap testable: an untagged `{ $exists: false }` is cast as
// a literal value against the `deleted` path and the filter silently matches nothing, which reads to
// every caller as an empty catalogue rather than as an error.
const TRUSTED = Object.getOwnPropertySymbols(trusted({}))[0]

describe('livePublic', () => {
	it('is the published-and-not-deleted pair, with the deleted clause trusted', () => {
		const filter = livePublic()

		expect(filter).toEqual({ published: true, deleted: trusted({ $exists: false }) })
		expect(Object.keys(filter)).toEqual(['published', 'deleted'])
		expect(filter.published).toBe(true)
		expect(filter.deleted[TRUSTED]).toBe(true)
	})

	// ⚠️ The reason it is a function. `trusted()` tags the object it is handed, so one shared instance
	// would be a single mutable object embedded in the filter of every concurrent read on the service —
	// and anything that mutated it would mutate every in-flight query at once.
	it('hands out a fresh object every call, tag included', () => {
		const first = livePublic()
		const second = livePublic()

		expect(second).not.toBe(first)
		expect(second.deleted).not.toBe(first.deleted)
		expect(second.deleted[TRUSTED]).toBe(true)
	})
})

describe('LIVE_PUBLIC_PIPELINE', () => {
	// The exact inverse of the rule above, and it has to be asserted separately because both objects
	// read identically with a plain `toEqual`. Aggregation stages never pass through `sanitizeFilter`,
	// so a `trusted()` wrapper inside a `$match` is an unknown object the *server* rejects — a failed
	// query rather than an empty one.
	it('spells the same two predicates plainly, with no trusted tag', () => {
		expect(LIVE_PUBLIC_PIPELINE).toEqual({ published: true, deleted: { $exists: false } })
		expect(Object.getOwnPropertySymbols(LIVE_PUBLIC_PIPELINE)).toHaveLength(0)
		expect(Object.getOwnPropertySymbols(LIVE_PUBLIC_PIPELINE.deleted)).toHaveLength(0)
	})
})

describe('the caps', () => {
	// Pinned as numbers because every clamp below is asserted against them: reading a cap from the
	// module under test and then comparing the module's own output to it would pass for any value.
	it('are the values the callers and the docs assume', () => {
		expect(DEFAULT_LIMIT).toBe(24)
		expect(MAX_LIMIT).toBe(60)
		expect(MAX_OFFSET).toBe(10_000)
		expect(COUNT_CAP).toBe(5_000)
	})
})

describe('clampLimit', () => {
	// Absent means "the caller expressed no preference", which is the default page — not 0, and not
	// the maximum. Both spellings arrive from GraphQL: an omitted argument is `undefined`, an argument
	// explicitly set to null is `null`.
	it.each([
		['undefined', undefined],
		['null', null]
	])('answers the default page size for %s', (_desc, value) => {
		expect(clampLimit(value)).toBe(DEFAULT_LIMIT)
	})

	// The floor is 1 rather than 0: a page of zero documents is a request that costs a round trip and
	// answers nothing, and `limit(0)` means *no limit* to the MongoDB driver — the one value that
	// would turn a clamped listing into an unbounded collection scan.
	it.each([
		['zero', 0, 1],
		['a negative page size', -50, 1],
		['the smallest legal page', 1, 1],
		['a page inside the range', 24, 24],
		['exactly the ceiling', 60, 60],
		['one past the ceiling', 61, 60],
		['a page size a caller could only mean as an attack', 10_000_000, 60]
	])('clamps %s', (_desc, given, expected) => {
		expect(clampLimit(given)).toBe(expected)
	})
})

describe('assertOffset', () => {
	// Negative is normalised rather than refused: `skip(-1)` throws inside the driver with a message
	// that names the driver and not the argument, which is not an error an anonymous caller can act on.
	it.each([
		['undefined', undefined],
		['null', null],
		['a negative offset', -1],
		['a deeply negative offset', -10_000]
	])('reads %s as the first page', (_desc, value) => {
		expect(assertOffset(value)).toBe(0)
	})

	it.each([
		['the first page', 0],
		['a page inside the range', 240],
		['exactly the cap', 10_000]
	])('passes %s through untouched', (_desc, value) => {
		expect(assertOffset(value)).toBe(value)
	})

	// ⚠️ Throws rather than clamping, and that asymmetry with `clampLimit` is the whole design: an
	// over-large limit returns a prefix of what was asked for, while an over-large offset would return
	// a *different window* — which is how a crawler ends up indexing the same 24 shops under 10 000
	// URLs. The message is asserted whole because it is the only place the caller is told what to do
	// instead.
	it('refuses one past the default cap, naming the cap and the way out', () => {
		expect(() => assertOffset(10_001)).toThrow(
			'offset must not exceed 10000. Narrow the listing with a city or a category filter, or use sitemapEntries, which is keyset paginated and has no such limit.'
		)
	})

	// The cross-shop paths pass their own, much lower cap — every skipped document there is multiplied by
	// OVERFETCH and then fed through a join. A caller-supplied max has to appear in the message too,
	// or the refusal names a limit that was never applied.
	it('honours a caller-supplied cap, and reports that one', () => {
		expect(assertOffset(2_000, 2_000)).toBe(2_000)
		expect(() => assertOffset(2_001, 2_000)).toThrow('offset must not exceed 2000.')
		expect(() => assertOffset(2_001, 2_000)).not.toThrow('offset must not exceed 10000.')
	})
})

describe('assertObjectId', () => {
	it('returns a real ObjectId for a well-formed hex string', () => {
		const id = assertObjectId('507f1f77bcf86cd799439011', 'idCategory')

		expect(id).toBeInstanceOf(Types.ObjectId)
		expect(id.toHexString()).toBe('507f1f77bcf86cd799439011')
	})

	// ⚠️ It throws before any query is built, and that is the point: mongoose casts on its own and
	// raises a `CastError` carrying the model name, the path and a mongoose stack frame — into a
	// response an anonymous caller reads. The argument name is in the message because it is the only
	// part that tells the caller which of its two id arguments was wrong.
	it.each([
		['a word', 'nope'],
		['an empty string', ''],
		['a truncated hex string', '507f1f77bcf86cd79943901']
	])('refuses %s, naming the argument', (_desc, value) => {
		expect(() => assertObjectId(value, 'afterId')).toThrow('afterId is not a valid id')
		expect(() => assertObjectId(value, 'idCategory')).toThrow('idCategory is not a valid id')
	})
})
