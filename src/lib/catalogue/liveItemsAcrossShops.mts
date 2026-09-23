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
 * joining company documents onto a hundred thousand items to return sixty is not a query, it is an
 * outage. So the pipeline limits first and joins second, which means documents are **dropped after the
 * window was chosen**: items whose shop has since been unpublished vanish from the page they would
 * have filled.
 *
 * `OVERFETCH` is the mitigation and it is not a fix. Fetching three times the window makes the
 * shortfall invisible for any realistic ratio of unpublished shops, and cannot make it impossible:
 * if every item in the fetched window belongs to an unpublished shop, this returns fewer documents than
 * exist. That is why `total` from these paths is reported with `totalIsExact: false` — the count
 * cannot see the company half either, so it is an upper bound.
 *
 * ⚠️ **The real fix is a denormalised `companyPublished` on `item`**, which turns the cross-document
 * AND into a single-document predicate and lets it be indexed with the rest of the `$match`. It is
 * deliberately not done here, because a flag is only as good as its weakest writer: it needs a
 * migration on `item`, a backfill, and a `$set` in *every* resolver that can change a company's
 * publication — `companyUpdate` on the ShopOwner tier and the Admin tier's moderation paths — each
 * of which must fan the change out over that company's whole catalogue. A half-wired denormalisation
 * is worse than none, because it is wrong only for the documents nobody remembered.
 *
 * ⚠️ **No `trusted()` anywhere below.** `sanitizeFilter` wraps mongoose `Query` filters only;
 * aggregation stages go to the driver untouched, so `{ $exists: false }` is read as the operator it
 * is and a `trusted()` wrapper would be an unknown object the server rejects. The inverse of the
 * rule that applies three lines away in `livePublic()`.
 *
 * ## `hasMore` needed its own fix
 *
 * ⚠️ **The overfetch window is `liveItemsAcrossShops`' problem alone — it must never leak into `hasMore`
 * as a false negative.** The obvious `docs.length > limit` (the pattern every single-collection listing
 * on this service uses) reads as post-join and therefore safe, but it is only ever asked of the *bounded*
 * window above: when every document inside `(skip + limit) * OVERFETCH` raw matches turns out to belong
 * to an unpublished shop, `docs` comes back short for a reason that has nothing to do with whether more
 * live items exist further out in the raw match set — they were simply never looked at. Reading `false`
 * off that shortfall is a real defect, not the accepted `total` trade-off: it under-reports a boolean the
 * page-navigation UI acts on directly, silently hiding pages that exist. See `moreLiveItemsExist`, which
 * both cross-shop callers fall back on exactly when the bounded fetch cannot answer the question honestly.
 */

/** Documents fetched per item wanted, before the company join drops some of them. See above. */
export const OVERFETCH = 3

/**
 * Deepest page the cross-shop paths will serve — much shallower than `MAX_OFFSET`.
 *
 * Every skipped document is multiplied by `OVERFETCH` and then fed through a join, so the cost of depth
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
 *                     predicate added here raises the share of fetched documents the join discards, and
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

/**
 * No pre-join `$limit` on `moreLiveItemsExist`'s pipeline would be the honest number for what this
 * function asks — this is a stand-in for "no real bound at all", not a second overfetch window.
 *
 * ⚠️ **It exists to satisfy the query planner, not to cap the work.** `$sort` on `{ $meta: 'textScore' }`
 * (the text-search callers' sort) followed directly by `$lookup`/`$unwind`, with no `$limit` between them,
 * makes MongoDB 8's planner materialise the score as an internal field and then choke on it downstream —
 * `FieldPath field names may not start with '$', given '$computed0'`, straight out of the server. A
 * `$sort` immediately followed by *any* `$limit` takes the planner's bounded top-k path instead, which
 * never hits that field at all. `liveItemsAcrossShops` above never shows the bug because its own `$limit`
 * is already there for a different reason. No number this small enough to matter would still answer the
 * question exactly, so this one is chosen to be effectively unreachable instead: no category or search
 * result on this platform holds anywhere near this many raw matches.
 */
const NO_REAL_BOUND = Number.MAX_SAFE_INTEGER

/**
 * Whether a live item sits at joined position `position` or later — the exact question `hasMore` is,
 * asked directly instead of inferred from a window that was never meant to answer it.
 *
 * ⚠️ **No *meaningful* pre-join limit, unlike `liveItemsAcrossShops` above, and that is still the whole
 * point.** The page fetch bounds its raw window because it has to pull a *page's worth* of live documents
 * through the join and a hundred thousand candidates for sixty results is the outage the module's own docs
 * describe. This asks a strictly cheaper question — does *one* live document exist beyond a position — so
 * the driver's cursor can walk the sorted match set and stop at the first live one, whatever that costs on
 * a given category. `NO_REAL_BOUND` is there only because the planner insists on a number; see its own doc
 * for why. The two callers only ever reach this after the bounded fetch already came back with `limit`
 * documents or fewer, which is precisely the case where the bounded window cannot be trusted to answer
 * honestly — see the module doc above.
 *
 * ⚠️ **`$skip` here runs *after* `$lookup`/`$unwind`, matching `liveItemsAcrossShops`' own order.** `skip`
 * there counts joined, live documents; a raw pre-join skip would count a different, larger set and answer
 * a different question — whether a live item exists past `position` *raw* matches in, most of which may
 * themselves be dead ends the page never showed.
 *
 * @param match        the same `$match` predicates the caller gave `liveItemsAcrossShops` for this
 *                      page — the probe has to ask about the identical population, or a "no more"
 *                      answer would be about a different set of items than the one the page reads.
 * @param companyMatch the same company-side predicates passed alongside `match`, ANDed into *this*
 *                      pipeline's own `$lookup` sub-pipeline for the same reason.
 * @param sort          the same `$sort` stage the page fetch used, so `position` names the same place
 *                       in the same order.
 * @param position      joined position to look past — `offset + limit`, the index the page's own
 *                       sentinel document would have occupied had the bounded fetch reached it.
 */
export async function moreLiveItemsExist(
	match: Record<string, unknown>,
	companyMatch: Record<string, unknown>,
	sort: PipelineStage.Sort['$sort'],
	position: number
): Promise<boolean> {
	const pipeline: PipelineStage[] = [
		{ $match: { ...match, ...LIVE_PUBLIC_PIPELINE } },
		{ $sort: sort },
		{ $limit: NO_REAL_BOUND },
		{
			$lookup: {
				from: 'company',
				localField: 'idCompany',
				foreignField: '_id',
				as: 'company',
				pipeline: [{ $match: { ...companyMatch, ...LIVE_PUBLIC_PIPELINE } }, { $project: { _id: 1 } }]
			}
		},
		{ $unwind: '$company' },
		{ $skip: position },
		{ $limit: 1 },
		{ $project: { _id: 1 } }
	]

	const hits = await Item.aggregate<{ _id: Types.ObjectId }>(pipeline)

	return hits.length > 0
}
