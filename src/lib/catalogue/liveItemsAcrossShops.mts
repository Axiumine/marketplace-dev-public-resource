import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { PipelineStage, Types } from 'mongoose'

import { LIVE_PUBLIC_PIPELINE } from './publicRead.mjs'

/**
 * Items read **across** shops, with each item's shop resolved and its publication checked.
 *
 * Two callers: the category listing (`/category/:slug`, which spans every shop on the platform) and
 * `search`. Both hit the same wall, and it is the reason this file exists rather than the pipeline
 * being inlined twice.
 *
 * ## The wall
 *
 * An item is publicly visible only if `item.published` **and** `company.published` are true. That
 * AND cannot be indexed, validated or stored: MongoDB has no foreign keys, a `$jsonSchema` sees one
 * document, and the two flags live in two collections. `items(companySlug:)` and `itemBySlug` dodge
 * it entirely by resolving the shop first — one indexed read settles the company half for every item
 * under it. A query that starts from a category or from a text score has no shop to resolve first,
 * so the join has to happen inside the pipeline.
 *
 * ## The compromise, stated plainly
 *
 * `$lookup` cannot run before the `$limit` — a category can span every shop on the platform, and
 * joining company rows onto a hundred thousand items to return sixty is not a query, it is an
 * outage. So the pipeline limits first and joins second, which means rows are **dropped after the
 * window was chosen**: items whose shop has since been unpublished vanish from the page they would
 * have filled.
 *
 * `OVERFETCH` is the mitigation and it is not a fix. Fetching three times the window makes the
 * shortfall invisible for any realistic ratio of unpublished shops, and cannot make it impossible:
 * if every item in the fetched window belongs to an unpublished shop, this returns fewer rows than
 * exist. That is why `total` from these paths is reported with `totalIsExact: false` — the count
 * cannot see the company half either, so it is an upper bound.
 *
 * ⚠️ **The real fix is a denormalised `companyPublished` on `item`**, which turns the cross-document
 * AND into a single-document predicate and lets it be indexed with the rest of the `$match`. It is
 * deliberately not done here, because a flag is only as good as its weakest writer: it needs a
 * migration on `item`, a backfill, and a `$set` in *every* resolver that can change a company's
 * publication — `companyUpdate` on the ShopOwner tier and the Admin tier's moderation paths — each
 * of which must fan the change out over that company's whole catalogue. A half-wired denormalisation
 * is worse than none, because it is wrong only for the rows nobody remembered.
 *
 * ⚠️ **No `trusted()` anywhere below.** `sanitizeFilter` wraps mongoose `Query` filters only;
 * aggregation stages go to the driver untouched, so `{ $exists: false }` is read as the operator it
 * is and a `trusted()` wrapper would be an unknown object the server rejects. The inverse of the
 * rule that applies three lines away in `livePublic()`.
 */

/** Rows fetched per row wanted, before the company join drops some of them. See above. */
export const OVERFETCH = 3

/**
 * Deepest page the cross-shop paths will serve — much shallower than `MAX_OFFSET`.
 *
 * Every skipped row is multiplied by `OVERFETCH` and then fed through a join, so the cost of depth
 * here is three index seeks per skipped item rather than one discarded index entry. 2000 is where
 * that stays bounded, and it is well past any page a reader or a crawler reaches: `/category/:slug`
 * at page 34 is not a journey, and the shops behind it are reachable through `/shops` and the
 * sitemap regardless.
 */
export const MAX_CROSS_SHOP_OFFSET = 2_000

export interface IItemHit {
	_id: Types.ObjectId
	idCategory: Types.ObjectId
	name: string
	description: string
	slug: string
	companySlug: string
	companyPublicName: string
}

/**
 * Build and run the pipeline.
 *
 * @param match        extra `$match` predicates on `item`, ANDed with the liveness pair.
 *                     `{ idCategory }` for the category listing, `{ $text: { $search: q } }` for
 *                     search.
 * @param companyMatch extra `$match` predicates on the joined `company`, ANDed with *its* liveness
 *                     pair inside the `$lookup` sub-pipeline. This is where a geographic bound goes:
 *                     an item has no coordinates of its own and inherits its shop's, so "items near
 *                     me" is an item text match whose *company* is inside the circle. ⚠️ Every
 *                     predicate added here raises the share of fetched rows the join discards, and
 *                     `OVERFETCH` is what absorbs that — a bound narrow enough to reject most shops
 *                     will shorten pages before it empties them.
 * @param sort         the `$sort` stage. Search sorts by text score, the listing by `_id`; the
 *                     caller owns it because only the caller knows whether a `$meta` field is
 *                     available to sort on.
 * @param skip         already validated against `MAX_CROSS_SHOP_OFFSET` by the caller.
 * @param limit        already clamped by the caller.
 */
export async function liveItemsAcrossShops(
	match: Record<string, unknown>,
	companyMatch: Record<string, unknown>,
	sort: PipelineStage.Sort['$sort'],
	skip: number,
	limit: number
): Promise<IItemHit[]> {
	const pipeline: PipelineStage[] = [
		{ $match: { ...match, ...LIVE_PUBLIC_PIPELINE } },
		{ $sort: sort },
		// Bound the work before the join, and only here. Everything after this stage is O(window).
		{ $limit: (skip + limit) * OVERFETCH },
		{
			$lookup: {
				from: 'company',
				localField: 'idCompany',
				foreignField: '_id',
				as: 'company',
				// The sub-pipeline is what makes the join a filter as well as a fetch: a company that
				// fails these predicates produces an empty `company` array, and the `$unwind` below
				// then drops the item. Projecting two fields keeps the legal-entity half of that
				// collection — vatNumber, certifiedEmail, legalName, registryExtract — out of this
				// service's memory entirely, rather than relying on the GraphQL type to hide it.
				pipeline: [{ $match: { ...companyMatch, ...LIVE_PUBLIC_PIPELINE } }, { $project: { slug: 1, publicName: 1 } }]
			}
		},
		// No `preserveNullAndEmptyArrays` — the dropping IS the company-published check.
		{ $unwind: '$company' },
		{ $skip: skip },
		{ $limit: limit },
		{
			$project: {
				_id: 1,
				idCategory: 1,
				name: 1,
				description: 1,
				slug: 1,
				companySlug: '$company.slug',
				companyPublicName: '$company.publicName'
			}
		}
	]

	return await Item.aggregate<IItemHit>(pipeline)
}
