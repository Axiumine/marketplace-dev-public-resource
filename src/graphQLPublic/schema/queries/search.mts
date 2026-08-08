import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { GraphQLInputNearPoint } from '@GraphQLInput/GraphQLInputGeo.mjs'
import { assertNearPoint, centerSphereFilter, INearPoint } from '@lib/catalogue/geoArgs.mjs'
import { liveItemsAcrossShops } from '@lib/catalogue/liveItemsAcrossShops.mjs'
import { clampLimit, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicSearchResult } from '@ptypes/GraphQLPublicSearchResult.mjs'
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'
import { trusted } from 'mongoose'

import { PUBLIC_COMPANY_PROJECTION } from './companies.mjs'

interface IArgs {
	q: string
	near?: INearPoint | null
	limit?: number | null
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
 * `/search?q=&near=` — the site search, over shops and over items, optionally bounded to a radius.
 *
 * Two collections, two text indexes, two result lists. `GraphQLPublicSearchResult` documents why
 * they are not merged into one ranked list: MongoDB's `textScore` is computed against each
 * collection's own term statistics and field weights, so a shop's 1.4 and an item's 1.1 have never
 * been compared and interleaving them produces an order that looks authoritative and is arbitrary.
 *
 * ## The geographic bound, and why it is `$geoWithin` rather than `$near`
 *
 * `$near` and `$geoNear` sort by distance, and a query may have exactly one sort. A text search's
 * sort is its relevance — that is the whole point of searching — so a proximity operator that also
 * sorts cannot be combined with `$text` at all; MongoDB refuses the combination outright rather than
 * picking one. `$geoWithin` / `$centerSphere` is a pure predicate with no sort of its own, so it
 * composes: results are ordered by relevance and *filtered* by distance. The trade-off is real and
 * accepted — within the radius, a closer shop does not outrank a better-matching one.
 *
 * ## Where the bound is applied for items
 *
 * An item has no coordinates; it inherits its shop's. So "items near me" is an item text match whose
 * *company* falls inside the circle, and the filter travels into the `$lookup` sub-pipeline where
 * that company is already being fetched and checked. ⚠️ It therefore raises the share of fetched
 * documents the join discards — see `liveItemsAcrossShops` for what `OVERFETCH` does and does not cover:
 * a tight radius shortens item pages before it empties them.
 *
 * ## trusted()
 *
 * `sanitizeFilter` is on globally and wraps any non-`$` key whose value carries `$` operators into
 * `{ $eq: … }`. Both the `$text` operator and the `$geoWithin` on `address.position` would be
 * rewritten into equality tests against literal objects — filters that match nothing, silently, and
 * read as "no results". Aggregation stages never pass through `sanitizeFilter`, which is why the
 * item half spells the same predicates plainly.
 */
export const search = {
	type: new GraphQLNonNull(GraphQLPublicSearchResult),
	description: 'Full-text search over published companies and items, optionally within a radius',
	args: {
		q: { type: new GraphQLNonNull(GraphQLString) },
		near: { type: GraphQLInputNearPoint },
		limit: { type: GraphQLInt }
	},
	async resolve(_: unknown, args: IArgs) {
		const q = args.q.trim()
		if (q.length === 0) throw new Error('q must not be empty')
		if (q.length > MAX_QUERY_LENGTH) throw new Error(`q must not exceed ${MAX_QUERY_LENGTH} characters`)

		const near = args.near ? assertNearPoint(args.near) : undefined
		const limit = clampLimit(args.limit)

		const [companies, items] = await Promise.all([
			Company.find(
				{
					$text: trusted({ $search: q }),
					...livePublic(),
					...(near ? { 'address.position': trusted(centerSphereFilter(near)) } : {})
				},
				PUBLIC_COMPANY_PROJECTION
			)
				// Sorting by `$meta` without projecting the score requires MongoDB 4.4 or newer, which
				// this platform is well past. Not projecting it is deliberate: the score orders the
				// list and the order is the answer, so the raw number has no business leaving the
				// server. GraphQLPublicItemHit says the same at greater length.
				.sort({ score: { $meta: 'textScore' } })
				.limit(limit)
				.lean(),
			liveItemsAcrossShops(
				{ $text: { $search: q } },
				near ? { 'address.position': centerSphereFilter(near) } : {},
				{ score: { $meta: 'textScore' } },
				0,
				limit
			)
		])

		return { companies, items }
	}
}
