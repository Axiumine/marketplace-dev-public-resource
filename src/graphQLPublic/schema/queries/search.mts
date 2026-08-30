import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { GraphQLInputNearPoint } from '@GraphQLInput/GraphQLInputGeo.mjs'
import { assertNearPoint, centerSphereFilter, INearPoint } from '@lib/catalogue/geoArgs.mjs'
import { liveItemsAcrossShops, MAX_CROSS_SHOP_OFFSET } from '@lib/catalogue/liveItemsAcrossShops.mjs'
import { assertOffset, clampLimit, COUNT_CAP, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicCompanyPage } from '@ptypes/GraphQLPublicCompanyPage.mjs'
import { GraphQLPublicItemPage } from '@ptypes/GraphQLPublicItemPage.mjs'
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'
import { trusted } from 'mongoose'

import { PUBLIC_COMPANY_PROJECTION } from './companies.mjs'

interface IArgs {
	q: string
	near?: INearPoint | null
	limit?: number | null
	offset?: number | null
}

/**
 * Longest query string accepted.
 *
 * A text search's cost grows with the number of terms — each one is a separate index traversal whose
 * postings are then intersected — so an unbounded `q` is an unbounded amount of work requested by an
 * anonymous caller in a single small request. 120 characters is longer than any real query and short
 * enough that the worst case is bounded. Rejected rather than truncated: silently searching for a
 * prefix of what was typed returns results the user cannot explain.
 */
const MAX_QUERY_LENGTH = 120

/**
 * `/search?q=&kind=&near=&page=` — the site search, over shops *or* over items, optionally bounded to
 * a radius.
 *
 * ## Two fields rather than one field returning both lists
 *
 * MongoDB's `textScore` is computed against each collection's own term statistics and field weights,
 * so a shop's 1.4 and an item's 1.1 have never been compared and interleaving them produces an order
 * that looks authoritative and is arbitrary. The two result sets were therefore always kept apart —
 * what changed is that the caller now says which one it wants, and gets one page of it rather than one
 * screen of both.
 *
 * ⚠️ **Two root fields, not `search(kind:)` returning a union.** The two answer different node types,
 * and graphql-js has no generics: a single field would need a union plus a `resolveType` on the server
 * and `... on` fragments in every document, to deliver exactly what two field names deliver for free.
 * `GraphQLPublicItemPage` makes the same argument at greater length about the page envelope itself.
 * The choice is a UI concern and lives in the URL; the wire has one field per shape.
 *
 * Both reuse the page envelope the listings already use, so `total`/`totalIsExact`/`hasMore` mean here
 * exactly what they mean on `/shops` — read `GraphQLPublicCompanyPage` for what the cap does to
 * `total` and why `hasMore` is computed from the documents fetched instead.
 *
 * ## The geographic bound, and why it is `$geoWithin` rather than `$near`
 *
 * `$near` and `$geoNear` sort by distance, and a query may have exactly one sort. A text search's
 * sort is its relevance — that is the whole point of searching — so a proximity admin that also
 * sorts cannot be combined with `$text` at all; MongoDB refuses the combination outright rather than
 * picking one. `$geoWithin` / `$centerSphere` is a pure predicate with no sort of its own, so it
 * composes: results are ordered by relevance and *filtered* by distance. The trade-off is real and
 * accepted — within the radius, a closer shop does not outrank a better-matching one.
 *
 * ## trusted()
 *
 * `sanitizeFilter` is on globally and wraps any non-`$` key whose value carries `$` admins into
 * `{ $eq: … }`. Both the `$text` operator and the `$geoWithin` on `address.position` would be
 * rewritten into equality tests against literal objects — filters that match nothing, silently, and
 * read as "no results". Aggregation stages never pass through `sanitizeFilter`, which is why the
 * item half spells the same predicates plainly.
 */
const SEARCH_ARGS = {
	q: { type: new GraphQLNonNull(GraphQLString) },
	near: { type: GraphQLInputNearPoint },
	limit: { type: GraphQLInt },
	offset: { type: GraphQLInt }
}

/**
 * Trim and bound the query text.
 *
 * Shared by both fields so the two cannot drift into accepting different input — a `q` one field
 * refuses and the other runs is a page whose two tabs disagree about whether the search is valid.
 */
function assertQuery(raw: string): string {
	const q = raw.trim()

	if (q.length === 0) throw new Error('q must not be empty')
	if (q.length > MAX_QUERY_LENGTH) throw new Error(`q must not exceed ${MAX_QUERY_LENGTH} characters`)

	return q
}

/**
 * Shops matching the text, one page at a time.
 *
 * `offset` is bounded by the ordinary `MAX_OFFSET`: this is a single-collection query, so a skipped
 * document costs one index entry, exactly as it does on `/shops`.
 */
export const searchCompanies = {
	type: new GraphQLNonNull(GraphQLPublicCompanyPage),
	description: 'Full-text search over published companies, optionally within a radius',
	args: SEARCH_ARGS,
	async resolve(_: unknown, args: IArgs) {
		const q = assertQuery(args.q)
		const near = args.near ? assertNearPoint(args.near) : undefined
		const limit = clampLimit(args.limit)
		const offset = assertOffset(args.offset)

		const filter = {
			$text: trusted({ $search: q }),
			...livePublic(),
			...(near ? { 'address.position': trusted(centerSphereFilter(near)) } : {})
		}

		const [docs, total] = await Promise.all([
			Company.find(filter, PUBLIC_COMPANY_PROJECTION)
				// Sorting by `$meta` without projecting the score requires MongoDB 4.4 or newer, which
				// this platform is well past. Not projecting it is deliberate: the score orders the
				// list and the order is the answer, so the raw number has no business leaving the
				// server. GraphQLPublicItemHit says the same at greater length.
				.sort({ score: { $meta: 'textScore' } })
				.skip(offset)
				// `limit + 1` rather than deriving "is there another page" from `total`, which is
				// capped: past the cap the derived answer would truncate the result set at whatever
				// COUNT_CAP happens to be. One extra index entry buys an exact flag.
				.limit(limit + 1)
				.lean(),
			// The count carries the same filter, geo bound included, so it is exact up to the cap.
			Company.countDocuments(filter, { limit: COUNT_CAP })
		])

		const hasMore = docs.length > limit
		if (hasMore) docs.pop()

		return { nodes: docs, total, totalIsExact: total < COUNT_CAP, hasMore }
	}
}

/**
 * Items matching the text, one page at a time.
 *
 * ## Where the radius is applied
 *
 * An item has no coordinates; it inherits its shop's. So "items near me" is an item text match whose
 * *company* falls inside the circle, and the filter travels into the `$lookup` sub-pipeline where
 * that company is already being fetched and checked. ⚠️ It therefore raises the share of fetched
 * documents the join discards — see `liveItemsAcrossShops` for what `OVERFETCH` does and does not
 * cover: a tight radius shortens item pages before it empties them.
 *
 * ⚠️ **`offset` is bounded by `MAX_CROSS_SHOP_OFFSET`, not by `MAX_OFFSET`.** Every skipped document
 * here is multiplied by `OVERFETCH` and then fed through a join, so depth costs several times what it
 * costs on the company half. `liveItemsAcrossShops` carries the arithmetic.
 *
 * ⚠️ **`totalIsExact` is `false` on every call, and not because of the cap.** The count runs on `item`
 * alone, where it can see neither `company.published` nor the radius — both live in the other
 * collection and no count can join. It is an upper bound, honestly labelled, exactly as the category
 * listing's is. `hasMore` is unaffected: it comes from documents that went through the join.
 */
export const searchItems = {
	type: new GraphQLNonNull(GraphQLPublicItemPage),
	description: 'Full-text search over published items, optionally within a radius of their shop',
	args: SEARCH_ARGS,
	async resolve(_: unknown, args: IArgs) {
		const q = assertQuery(args.q)
		const near = args.near ? assertNearPoint(args.near) : undefined
		const limit = clampLimit(args.limit)
		const offset = assertOffset(args.offset, MAX_CROSS_SHOP_OFFSET)

		const [docs, total] = await Promise.all([
			liveItemsAcrossShops(
				{ $text: { $search: q } },
				near ? { 'address.position': centerSphereFilter(near) } : {},
				{ score: { $meta: 'textScore' } },
				offset,
				limit + 1
			),
			Item.countDocuments({ $text: trusted({ $search: q }), ...livePublic() }, { limit: COUNT_CAP })
		])

		const hasMore = docs.length > limit
		if (hasMore) docs.pop()

		return { nodes: docs, total, totalIsExact: false, hasMore }
	}
}
