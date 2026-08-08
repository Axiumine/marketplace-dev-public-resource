import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicCompany } from '@ptypes/GraphQLPublicCompany.mjs'
import { GraphQLNonNull, GraphQLString } from 'graphql'

import { PUBLIC_COMPANY_PROJECTION } from './companies.mjs'

interface IArgs {
	slug: string
}

/**
 * `/shop/:slug` — one shop's public page.
 *
 * A single seek on `slug_unique`, the partial unique index
 * `20260804010000-alter-company-public` installed on `{ slug: { $type: 'string' } }`; the two
 * liveness predicates are then applied to the one fetched document rather than scanned for.
 *
 * ⚠️ **Nullable on purpose — this is how a 404 is expressed.** An unknown slug, an unpublished shop
 * and a soft-deleted shop all answer `null`, identically and deliberately: distinguishing them would
 * turn this query into an oracle telling anyone which draft shop names are taken and which shops
 * have gone dark. The SSR route maps `null` to a real HTTP 404 so the page is never indexed.
 *
 * A retired shop keeps its slug occupied — `slug_unique` carries no `deleted` filter, exactly as
 * `vatNumber_unique` does not — so a slug is never recycled. That is the behaviour a public URL
 * wants: a link that used to be a shop must not silently become a different shop.
 */
export const companyBySlug = {
	type: GraphQLPublicCompany,
	description: 'Get one published company by its slug, or null',
	args: {
		slug: { type: new GraphQLNonNull(GraphQLString) }
	},
	async resolve(_: unknown, args: IArgs) {
		return await Company.findOne({ slug: args.slug, ...livePublic() }, PUBLIC_COMPANY_PROJECTION).lean()
	}
}
