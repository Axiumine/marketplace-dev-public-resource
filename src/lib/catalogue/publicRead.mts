import { trusted, Types } from 'mongoose'

/**
 * The pieces every public catalogue read shares: the liveness filter, the pagination clamps and a
 * bounded count.
 *
 * This service answers anonymous, unauthenticated, uncached-by-default traffic at the scale the
 * platform is being built for, so every argument a caller supplies is treated as hostile — not
 * because it can inject anything (it cannot, see `livePublic` below) but because it can ask for work.
 * A `limit` of 10 000 000 and an `offset` of 50 000 000 are both syntactically valid GraphQL Ints.
 */

/**
 * `{ published: true, deleted: <absent> }` — the two predicates that separate what an anonymous
 * visitor may see from what the shop owner is still drafting. Both `company` and `item` spell
 * liveness this way, which is why one helper serves both.
 *
 * ⚠️ **A function, not a constant.** `trusted()` tags the object it is handed, and handing the same
 * tagged instance to every concurrent query would make one shared mutable object part of the filter
 * of every in-flight read. A fresh object per call costs nothing and cannot be aliased.
 *
 * trusted(): `sanitizeFilter` is on globally, so a bare `{ $exists: false }` is taken as a literal
 * value and cast against the `deleted` path instead of being read as an operator — the filter then
 * silently matches nothing rather than matching the live rows. It is the single most repeated trap
 * in this codebase.
 *
 * ⚠️ **Not usable in an aggregation pipeline.** `sanitizeFilter` wraps mongoose `Query` filters
 * only; `Model.aggregate()` stages are passed to the driver untouched, and a `trusted()` wrapper
 * inside a `$match` is an unknown object the server rejects. Pipelines spell it `{ $exists: false }`
 * plainly, and every one of them says so at the call site.
 */
export function livePublic() {
	return { published: true, deleted: trusted({ $exists: false }) }
}

/** The same two predicates for an aggregation `$match`, where `trusted()` must not appear. */
export const LIVE_PUBLIC_PIPELINE = { published: true, deleted: { $exists: false } } as const

/**
 * Largest page any public listing will serve.
 *
 * 60 rather than a round 50 because the shop grid is 3 and 4 columns wide at its two breakpoints and
 * 60 is the smallest number above 50 divisible by both — a page that ends mid-row reads as a bug.
 */
export const MAX_LIMIT = 60

/** Default page size when the caller names none. One screen plus a little, on both grids. */
export const DEFAULT_LIMIT = 24

/**
 * Deepest page an offset-paginated listing will serve.
 *
 * `skip` is O(offset) in MongoDB — the server walks and discards every skipped index entry — so page
 * 100 000 of `/shops` costs 2.4 million discarded entries per request and is a free denial of
 * service. 10 000 is not a compromise between speed and completeness; it is the point past which the
 * *right* answer is a narrower query. Every listing here is filterable by city and by category, and
 * `sitemapEntries` — the one caller that genuinely has to walk the whole collection — is keyset
 * paginated by `_id` instead and has no offset at all.
 *
 * Past the cap this throws rather than clamping. Silently serving page 10 000 to a caller who asked
 * for page 20 000 is how a crawler indexes the same 24 shops under 10 000 URLs.
 */
export const MAX_OFFSET = 10_000

/**
 * Largest number `total` will ever report.
 *
 * `countDocuments` with no bound is a full index scan of the matching range: cheap on 200 companies,
 * a per-request scan of half a million entries at target scale, on the *listing* route, which is the
 * most requested route on the site. Passing `limit` to the count makes the server stop early, so the
 * cost is bounded by this constant instead of by the collection.
 *
 * The honesty of the answer is preserved by `totalIsExact`, not by hiding the cap: a caller that
 * gets `total: 5000, totalIsExact: false` knows to render "5000+" and knows not to compute a page
 * count from it.
 */
export const COUNT_CAP = 5_000

/**
 * Clamp a caller-supplied page size into `[1, MAX_LIMIT]`.
 *
 * Clamping rather than throwing, unlike `assertOffset`: an over-large `limit` still returns the rows
 * the caller wanted, in the right order, starting at the right place — the answer is a prefix of the
 * requested one and nothing about it is misleading. An over-large `offset` returns a *different*
 * window, which is why the two are handled differently.
 *
 * ⚠️ **Written as `min(max(…))` and not as two boundary comparisons, on purpose.** `if (limit < 1)
 * return 1` and `limit > MAX_LIMIT ? MAX_LIMIT : limit` are correct, but their `<=` / `>=` variants
 * return *the same number* at the boundary — an equivalent mutant, which no test can kill and which
 * therefore reads as a permanent hole in a gate that breaks at 100. The clamp form has no boundary
 * comparison to flip, and its own mutants (`min` ↔ `max`) are both killed by the tests below.
 */
export function clampLimit(limit?: number | null): number {
	if (limit === undefined || limit === null) return DEFAULT_LIMIT

	return Math.min(Math.max(limit, 1), MAX_LIMIT)
}

/**
 * Reject an offset past `max`, and normalise a negative one to 0.
 *
 * Negative is normalised because `skip(-1)` throws inside the driver with a message that names the
 * driver rather than the argument; past the cap is refused because clamping would lie.
 *
 * `max` is a parameter because the cross-shop paths are much more expensive per skipped row —
 * `MAX_CROSS_SHOP_OFFSET` in `liveItemsAcrossShops.mts` explains why, and passes itself in.
 *
 * ⚠️ **`?? 0` and not `offset === undefined || offset === null`, on purpose** — and this is where it
 * differs from `clampLimit`, which keeps the explicit pair. Dropping the `=== null` arm there answers
 * `1` instead of `DEFAULT_LIMIT`, so it is observable; dropping it here changes nothing at all,
 * because the fallthrough runs `Math.max(null, 0)`, which is `0` — the same answer by another route.
 * That is an equivalent mutant, unkillable by any test, and a permanent hole in a gate that breaks at
 * 100. `??` collapses both nullish cases in one operator whose own mutant (`??` → `&&`) turns an
 * omitted offset into `NaN` and is killed by the tests below.
 */
export function assertOffset(offset?: number | null, max: number = MAX_OFFSET): number {
	const requested = offset ?? 0

	if (requested > max) {
		throw new Error(
			`offset must not exceed ${max}. Narrow the listing with a city or a category filter, or use sitemapEntries, which is keyset paginated and has no such limit.`
		)
	}

	// Same reason as `clampLimit`: `offset < 0 ? 0 : offset` and `offset <= 0 ? 0 : offset` both
	// answer 0 at zero, so the comparison form carries an unkillable mutant. `Math.max` has none.
	return Math.max(requested, 0)
}

/**
 * Reject an id argument that is not a well-formed ObjectId, before mongoose does.
 *
 * Mongoose casts a string into the path's type on its own and throws a `CastError` when it cannot —
 * which is correct behaviour and the wrong error to hand the open internet: it carries the model
 * name, the path and a mongoose stack frame into a response an anonymous caller reads. This throws
 * a sentence instead, and throws it before any query is built.
 */
export function assertObjectId(value: string, name: string): Types.ObjectId {
	if (!Types.ObjectId.isValid(value)) {
		throw new Error(`${name} is not a valid id`)
	}

	return new Types.ObjectId(value)
}
