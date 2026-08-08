import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { assertOffset, clampLimit, COUNT_CAP, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicCompanyPage } from '@ptypes/GraphQLPublicCompanyPage.mjs'
import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	limit?: number | null
	offset?: number | null
	city?: string | null
}

/**
 * ⚠️ **The projection is a security boundary, not an optimisation.**
 *
 * `company` is a legal entity as much as it is a storefront: `legalName`, `vatNumber`, `taxCode`,
 * `certifiedEmail`, `uniqueCode`, `registryExtract`, `contactPerson`, `administrator` and
 * `idShopOwner` all live on the same document as `publicName` and `slug`. `GraphQLPublicCompany`
 * does not declare those fields, so GraphQL would refuse to serve them — but relying on that means
 * the whole document is in this process's memory, in its query logs and in any Sentry breadcrumb
 * that captures a mongoose event, on every request from the open internet. Naming the five public
 * fields keeps a VAT number out of the service entirely rather than out of one response.
 *
 * Every public read of `company` in this service uses this constant. Adding a field to it is adding
 * a field to the public site.
 */
export const PUBLIC_COMPANY_PROJECTION = '_id publicName slug description address'

/**
 * `/shops` and `/shops/:city` — the paginated, crawlable shop listing.
 *
 * Sorted by `publicName`, which `20260804040000-index-company-public-read` exists to make an index
 * walk rather than a blocking sort: `published_publicName` when no city is named,
 * `published_city_publicName` when one is. Alphabetical rather than newest-first because a listing
 * ordered by insertion time reorders itself under the reader between page 1 and page 2, and because
 * a crawler that revisits `/shops?page=7` must find roughly what it found last time or the pages it
 * has indexed all point at the wrong shops.
 *
 * ⚠️ **`city` is matched exactly, not fuzzily.** It is a URL segment produced by this platform's own
 * links, not a search box — `search` is the search box. An exact equality is what the compound index
 * can serve; a `$regex` on the same field cannot use it and would turn the second-most-requested
 * route into a scan.
 *
 * `limit + 1` rather than a second count: fetching one document past the window answers "is there another
 * page" exactly, for the cost of one index entry, and stays exact past `COUNT_CAP` where `total`
 * stops being. The extra document is dropped before it is returned.
 */
export const companies = {
	type: new GraphQLNonNull(GraphQLPublicCompanyPage),
	description: 'Get published companies, paginated, optionally filtered by city',
	args: {
		limit: { type: GraphQLInt },
		offset: { type: GraphQLInt },
		city: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IArgs) {
		const limit = clampLimit(args.limit)
		const offset = assertOffset(args.offset)

		const filter = { ...livePublic(), ...(args.city ? { 'address.city': args.city } : {}) }

		const [docs, total] = await Promise.all([
			Company.find(filter, PUBLIC_COMPANY_PROJECTION)
				.sort({ publicName: 1 })
				.skip(offset)
				.limit(limit + 1)
				.lean(),
			// The `limit` option is what bounds the count: the server stops walking at COUNT_CAP
			// matches instead of at the end of the collection. See COUNT_CAP for why that matters on
			// this route specifically.
			Company.countDocuments(filter, { limit: COUNT_CAP })
		])

		const hasMore = docs.length > limit
		if (hasMore) docs.pop()

		return {
			nodes: docs,
			total,
			// Conservative at the boundary: a collection holding exactly COUNT_CAP matches reports
			// `false` for a figure that happens to be exact. The other rounding — claiming exactness
			// for a capped count — would have a client render a page count that is wrong.
			totalIsExact: total < COUNT_CAP,
			hasMore
		}
	}
}
