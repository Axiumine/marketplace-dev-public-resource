import { liveCompanyBySlug } from '@lib/catalogue/liveCompanyBySlug.mjs'
import { IItemHit, liveItemsAcrossShops, MAX_CROSS_SHOP_OFFSET } from '@lib/catalogue/liveItemsAcrossShops.mjs'
import { assertObjectId, assertOffset, clampLimit, COUNT_CAP, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicItemPage } from '@ptypes/GraphQLPublicItemPage.mjs'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { GraphQLID, GraphQLInt, GraphQLString } from 'graphql'
import { GraphQLNonNull } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	companySlug?: string | null
	idCategory?: string | null
	limit?: number | null
	offset?: number | null
}

/** What the shop-page path reads off `item`; the shop's own two fields are added from the company. */
interface IShopItemRow {
	_id: Types.ObjectId
	idCategory: Types.ObjectId
	name: string
	description: string
	slug: string
}

const EMPTY_PAGE = { nodes: [] as IItemHit[], total: 0, totalIsExact: true, hasMore: false }

/**
 * Items, in the two ways the public site asks for them: one shop's catalogue (`/shop/:slug`) and one
 * category across every shop (`/category/:slug`).
 *
 * ⚠️ **The two modes are the same query only from the outside.** They differ in the one thing that
 * matters on this tier — how the cross-document rule "an item is visible only if its *shop* is also
 * published" gets enforced:
 *
 * - **`companySlug` given** — `liveCompanyBySlug` settles the company half once, with one indexed
 *   read, for every item under it. Exact: no join, no overfetch, `total` is a real count, and
 *   `idCategory` narrows it further if supplied.
 * - **`idCategory` alone** — there is no shop to resolve first, so the check becomes a `$lookup`
 *   inside the pipeline and inherits every compromise `liveItemsAcrossShops` documents at length.
 *   `totalIsExact` is `false` on this path even when the count is far below the cap, because a count
 *   cannot join.
 *
 * Passing both is the shop-page-filtered-by-category case and takes the exact path.
 *
 * **Sorted by `name` on the shop path, by `_id` on the category path**, and the split is a cost
 * decision rather than a preference. Neither sort is index-backed — `idCompany_published` and
 * `idCategory_published` are three equality keys with nothing after them — so both are blocking
 * sorts. On a shop's own catalogue that is bounded by what one business sells and is free.
 * A category spans the platform, so the same sort there would be a blocking sort over every item on
 * it; `_id` is at least the order the index already produces.
 */
export const items = {
	type: new GraphQLNonNull(GraphQLPublicItemPage),
	description: 'Get published items of one company, or of one category across every company',
	args: {
		companySlug: { type: GraphQLString },
		idCategory: { type: GraphQLID },
		limit: { type: GraphQLInt },
		offset: { type: GraphQLInt }
	},
	async resolve(_: unknown, args: IArgs) {
		if (!args.companySlug && !args.idCategory) {
			throw new Error('Pass companySlug, idCategory, or both')
		}

		const limit = clampLimit(args.limit)
		const idCategory = args.idCategory ? assertObjectId(args.idCategory, 'idCategory') : undefined

		if (args.companySlug) {
			return await itemsOfShop(args.companySlug, idCategory, limit, assertOffset(args.offset))
		}

		return await itemsOfCategory(idCategory!, limit, assertOffset(args.offset, MAX_CROSS_SHOP_OFFSET))
	}
}

async function itemsOfShop(companySlug: string, idCategory: Types.ObjectId | undefined, limit: number, offset: number) {
	const company = await liveCompanyBySlug(companySlug)

	// An unknown, unpublished or retired shop is an empty catalogue, not an error — the same
	// non-oracle `companyBySlug` maintains. The route renders its 404 from that query's `null`; this
	// one must not contradict it with a message saying the shop exists but is hidden.
	if (!company) return EMPTY_PAGE

	const filter = { idCompany: company._id, ...livePublic(), ...(idCategory ? { idCategory } : {}) }

	const [rows, total] = await Promise.all([
		Item.find(filter, '_id idCategory name description slug')
			.sort({ name: 1 })
			.skip(offset)
			.limit(limit + 1)
			.lean<IShopItemRow[]>(),
		Item.countDocuments(filter, { limit: COUNT_CAP })
	])

	const hasMore = rows.length > limit
	if (hasMore) rows.pop()

	return {
		// The shop is already resolved, so its two identity fields are attached here for free rather
		// than being re-read per row. This is what lets one node type serve all three item paths.
		nodes: rows.map((row) => ({ ...row, companySlug: company.slug, companyPublicName: company.publicName })),
		total,
		totalIsExact: total < COUNT_CAP,
		hasMore
	}
}

async function itemsOfCategory(idCategory: Types.ObjectId, limit: number, offset: number) {
	const [rows, total] = await Promise.all([
		liveItemsAcrossShops({ idCategory }, {}, { _id: 1 }, offset, limit + 1),
		Item.countDocuments({ idCategory, ...livePublic() }, { limit: COUNT_CAP })
	])

	const hasMore = rows.length > limit
	if (hasMore) rows.pop()

	return {
		nodes: rows,
		total,
		// Never exact here, and not because of the cap: this count sees `item.published` and cannot
		// see `company.published`, so it counts items belonging to shops that have gone dark. An
		// upper bound, honestly labelled.
		totalIsExact: false,
		hasMore
	}
}
