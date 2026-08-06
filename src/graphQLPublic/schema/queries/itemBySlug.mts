import { liveCompanyBySlug } from '@lib/catalogue/liveCompanyBySlug.mjs'
import { livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicItemHit } from '@ptypes/GraphQLPublicItemHit.mjs'
import { Item } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Item'
import { GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'

interface IArgs {
	companySlug: string
	slug: string
}

interface IItemRow {
	_id: Types.ObjectId
	idCategory: Types.ObjectId
	name: string
	description: string
	slug: string
}

/**
 * `/shop/:companySlug/item/:slug` — one item's page.
 *
 * Two arguments and not one, because `item.slug` is unique **per company** rather than globally:
 * `20260804030000-create-item` made that choice so two shops may both sell a "margherita" without
 * one of them having to call it "margherita-2". The pair is therefore the identifier, and the URL
 * spells it as the pair.
 *
 * Two reads, in this order and not the other. Resolving the shop first is what enforces the
 * cross-document rule — an item is public only if its company is published too — and it does so
 * without a join: with `idCompany` in hand the item lookup is a single seek on
 * `idCompany_slug_unique`, the same index that enforces the per-company uniqueness. A uniqueness
 * constraint that is also the lookup index for the route it constrains is not a coincidence; the
 * migration says so.
 *
 * ⚠️ **Nullable, and every failure answers the same `null`.** Unknown shop, unpublished shop,
 * retired shop, unknown item, draft item, deleted item — six distinct states, one response. Telling
 * them apart would let anyone enumerate which slugs a competitor has reserved and which of its items
 * are still drafts. The SSR route turns `null` into a real HTTP 404 so nothing is indexed.
 */
export const itemBySlug = {
	type: GraphQLPublicItemHit,
	description: 'Get one published item by its company slug and its own slug, or null',
	args: {
		companySlug: { type: new GraphQLNonNull(GraphQLString) },
		slug: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		const company = await liveCompanyBySlug(args.companySlug)
		if (!company) return null

		const item = await Item.findOne(
			{ idCompany: company._id, slug: args.slug, ...livePublic() },
			'_id idCategory name description slug'
		).lean<IItemRow>()
		if (!item) return null

		return { ...item, companySlug: company.slug, companyPublicName: company.publicName }
	}
}
