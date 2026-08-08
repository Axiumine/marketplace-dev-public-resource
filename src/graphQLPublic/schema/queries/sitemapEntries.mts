import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { Item } from '@axiumine/marketplace-common/models/MongoDB/Item'
import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { assertObjectId, LIVE_PUBLIC_PIPELINE, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLSitemapKind, GraphQLSitemapPage } from '@ptypes/GraphQLSitemapEntry.mjs'
import { GraphQLID, GraphQLInt, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

type Kind = 'COMPANY' | 'ITEM' | 'CATEGORY'

interface IArgs {
	kind: Kind
	afterId?: string | null
	limit?: number | null
}

interface IPage {
	nodes: { path: string }[]
	nextAfterId: Types.ObjectId | null
}

/**
 * Documents per call.
 *
 * Much larger than the listing page sizes because the caller is a sitemap generator, not a browser:
 * a shard holds up to 50 000 `<url>` elements and every extra round trip is a full request against
 * this service. 2000 keeps one response comfortably small while making a full shard 25 calls rather
 * than 833.
 */
const MAX_SITEMAP_LIMIT = 2_000
const DEFAULT_SITEMAP_LIMIT = 1_000

/**
 * Everything crawlable, in slices, so the frontend can write `sitemap.xml` and its shards.
 *
 * ⚠️ **Keyset paginated by `_id`, and it is the one caller that had to be.** A sitemap walks the
 * entire collection by definition, which is exactly the workload `MAX_OFFSET` refuses: at half a
 * million shops the last page of a `skip`-paginated walk discards half a million index entries, and
 * generating the whole file costs O(n²). Resuming from the last `_id` is a single index seek at any
 * depth. It is also *more correct* under concurrent writes — a shop created mid-walk gets a larger
 * `_id` and is picked up by a later page, where an offset walk would shift every remaining page by
 * one and drop a document.
 *
 * Loop until `nextAfterId` comes back `null`. Do not stop on a short page: the `ITEM` walk returns
 * fewer documents than it scanned whenever an item's shop is unpublished, so a short page is normal and
 * says nothing about being finished. That is precisely why `nextAfterId` is derived from the **last
 * scanned** document rather than from the last returned one.
 *
 * Paths come back **site-relative**. This service does not know the customer domain — `APP_DOMAIN`
 * belongs to the flow that mails verification links — and a backend that guesses the origin writes a
 * sitemap full of URLs pointing at the wrong environment, silently. The generator knows the host it
 * is serving.
 *
 * Slugs are interpolated raw. Every one of them is constrained to a slug pattern by its collection's
 * `$jsonSchema`, so there is nothing here that needs percent-encoding; if that validator is ever
 * loosened, this is one of the places that assumes it was not.
 *
 * trusted(): `sanitizeFilter` is on globally, so every `$exists`, `$gt` and `$in` below would
 * otherwise be cast as a literal value instead of read as an operator — a filter matching nothing,
 * which in a sitemap reads as "the site has no pages".
 */
export const sitemapEntries = {
	type: new GraphQLNonNull(GraphQLSitemapPage),
	description: 'Get crawlable paths of one kind, keyset paginated by _id',
	args: {
		kind: { type: new GraphQLNonNull(GraphQLSitemapKind) },
		afterId: { type: GraphQLID },
		limit: { type: GraphQLInt }
	},
	async resolve(_: unknown, args: IArgs): Promise<IPage> {
		const requested = args.limit ?? DEFAULT_SITEMAP_LIMIT
		// `min(max(…))` rather than a boundary comparison — see clampLimit(): `requested < 1` and
		// `requested <= 1` return the same 1, so the comparison form carries an unkillable mutant.
		const limit = Math.min(Math.max(requested, 1), MAX_SITEMAP_LIMIT)
		const afterId = args.afterId ? assertObjectId(args.afterId, 'afterId') : undefined

		if (args.kind === 'COMPANY') return await companyPaths(afterId, limit)
		if (args.kind === 'ITEM') return await itemPaths(afterId, limit)

		return await categoryPaths(afterId, limit)
	}
}

/** `_id > afterId`, or nothing on the first call. Kept in one place so the three walks agree. */
function after(afterId?: Types.ObjectId) {
	return afterId ? { _id: trusted({ $gt: afterId }) } : {}
}

async function companyPaths(afterId: Types.ObjectId | undefined, limit: number): Promise<IPage> {
	const docs = await Company.find({ ...livePublic(), ...after(afterId) }, '_id slug')
		.sort({ _id: 1 })
		.limit(limit)
		.lean<{ _id: Types.ObjectId; slug: string }[]>()

	return {
		nodes: docs.map((doc) => ({ path: `/shop/${doc.slug}` })),
		// Nothing is dropped after the fetch on this walk, so a short page really does mean the end.
		nextAfterId: docs.length === limit ? docs[docs.length - 1]._id : null
	}
}

/**
 * The item walk, and the only one whose returned documents are fewer than its scanned documents: an item is
 * crawlable only if its shop is published too, and that check is a `$lookup` — the cross-document
 * rule `liveItemsAcrossShops` documents.
 *
 * `$facet` is what keeps the pagination exact through that filter. Both branches see the same
 * already-sorted, already-limited window, so `scanned` reports how many documents the walk consumed and
 * `maxId` reports where it stopped — regardless of how many survived the join. Deriving the cursor
 * from the surviving documents instead would stall the walk on any window whose items all belong to
 * unpublished shops: the last survivor would be from the *previous* page, and the next call would
 * re-read the same window forever.
 */
async function itemPaths(afterId: Types.ObjectId | undefined, limit: number): Promise<IPage> {
	const [facet] = await Item.aggregate<{
		docs: { slug: string; companySlug: string }[]
		scanned: { n: number }[]
		tail: { maxId: Types.ObjectId }[]
	}>([
		{ $match: { ...LIVE_PUBLIC_PIPELINE, ...(afterId ? { _id: { $gt: afterId } } : {}) } },
		{ $sort: { _id: 1 } },
		{ $limit: limit },
		{
			$facet: {
				docs: [
					{
						$lookup: {
							from: 'company',
							localField: 'idCompany',
							foreignField: '_id',
							as: 'company',
							pipeline: [{ $match: LIVE_PUBLIC_PIPELINE }, { $project: { slug: 1 } }]
						}
					},
					// No `preserveNullAndEmptyArrays` — the dropping IS the company-published check.
					{ $unwind: '$company' },
					{ $project: { _id: 0, slug: 1, companySlug: '$company.slug' } }
				],
				scanned: [{ $count: 'n' }],
				tail: [{ $group: { _id: null, maxId: { $max: '$_id' } } }]
			}
		}
	])

	const scanned = facet.scanned[0]?.n ?? 0

	return {
		nodes: facet.docs.map((doc) => ({ path: `/shop/${doc.companySlug}/item/${doc.slug}` })),
		nextAfterId: scanned === limit ? facet.tail[0].maxId : null
	}
}

/**
 * Categories and subcategories, whose paths differ in shape: `/category/:slug` at the top level and
 * `/category/:parentSlug/:slug` below it.
 *
 * The second read resolves the parents of *this page only* — bounded by the page, not by the
 * collection — and filters them for liveness. ⚠️ A subcategory whose parent has been soft-deleted is
 * dropped rather than emitted under a dead segment: its URL cannot be built without a parent slug,
 * and emitting `/category/undefined/x` into a sitemap is worse than emitting nothing. The page is
 * then short, which is why the cursor comes from the scanned documents here too.
 */
async function categoryPaths(afterId: Types.ObjectId | undefined, limit: number): Promise<IPage> {
	const live = { deleted: trusted({ $exists: false }) }

	const docs = await ItemCategory.find({ ...live, ...after(afterId) }, '_id slug idParent')
		.sort({ _id: 1 })
		.limit(limit)
		.lean<{ _id: Types.ObjectId; slug: string; idParent?: Types.ObjectId }[]>()

	const parentIds = docs.filter((doc) => doc.idParent).map((doc) => doc.idParent!)
	const parents = parentIds.length
		? await ItemCategory.find({ _id: trusted({ $in: parentIds }), ...live }, '_id slug').lean<
				{ _id: Types.ObjectId; slug: string }[]
			>()
		: []

	const parentSlugById = new Map(parents.map((parent) => [parent._id.toString(), parent.slug]))

	const nodes = docs
		.map((doc) => {
			if (!doc.idParent) return `/category/${doc.slug}`

			const parentSlug = parentSlugById.get(doc.idParent.toString())

			return parentSlug ? `/category/${parentSlug}/${doc.slug}` : null
		})
		.filter((path): path is string => path !== null)
		.map((path) => ({ path }))

	return {
		nodes,
		nextAfterId: docs.length === limit ? docs[docs.length - 1]._id : null
	}
}
