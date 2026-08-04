import { GraphQLEnumType, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * Which family of URLs a sitemap slice walks.
 *
 * An enum rather than a string, because the three are not a filter over one collection — they are
 * three different reads with three different join shapes, and a caller passing `"shops"` should be
 * refused by the schema rather than by a `default:` branch. It also gives the sitemap generator a
 * complete, machine-readable list of what the site publishes: adding a fourth crawlable URL family
 * means adding a member here, which is a schema change the frontend's codegen surfaces.
 */
export const GraphQLSitemapKind = new GraphQLEnumType({
	name: 'GraphQLSitemapKind',
	values: {
		COMPANY: { value: 'COMPANY', description: '/shop/:slug' },
		ITEM: { value: 'ITEM', description: '/shop/:companySlug/item/:slug' },
		CATEGORY: { value: 'CATEGORY', description: '/category/:slug and /category/:parentSlug/:slug' }
	}
})

/**
 * One `<url>` of a sitemap: the site-relative path, and nothing else.
 *
 * The path is emitted relative (`/shop/pizzeria-roma`) rather than absolute because this service
 * does not know the customer domain — `APP_DOMAIN_USER` belongs to the flow that mails a
 * verification link, and the sitemap is written by the frontend, which knows the host it is being
 * served on. A backend that guesses the origin produces a sitemap full of URLs pointing at the wrong
 * environment, and it produces it silently.
 *
 * ⚠️ **No `lastmod`, deliberately, and it is a gap rather than a decision to leave alone.**
 * Neither `company` nor `item` carries an update timestamp — there is no `updatedAt` on either
 * collection. The available near-miss is the creation time embedded in the `ObjectId`, and emitting
 * that as `lastmod` would be a lie with teeth: `lastmod` means *last modification*, so a shop that
 * rewrites its description keeps advertising the day it registered, and a crawler that catches the
 * discrepancy once stops trusting `lastmod` for the whole site rather than for the one URL. Omitting
 * the element is explicitly allowed by the sitemap protocol and costs only the recrawl hint.
 *
 * Closing it properly is one migration adding `updatedAt` to both collections plus a `$currentDate`
 * in every write resolver that touches them — `companyUpdate`, `itemAdd`, `itemUpdate`, `itemDel`
 * and the publish paths. Until all of those stamp it, a partially-wired `updatedAt` is worse than
 * none, because it is wrong only for the rows nobody remembered to cover.
 */
export const GraphQLSitemapEntry = new GraphQLObjectType({
	name: 'GraphQLSitemapEntry',
	fields: () => ({
		path: { type: new GraphQLNonNull(GraphQLString) }
	})
})

/**
 * A sitemap slice and where to resume.
 *
 * ⚠️ **Keyset paginated, not offset paginated, and this is the one caller that had to be.** A
 * sitemap walks the entire collection by definition — that is what it is for — so it is the exact
 * workload `MAX_OFFSET` refuses: at half a million shops the last page of a `skip`-paginated walk
 * costs the server half a million discarded index entries, and generating the whole sitemap costs
 * O(n²). Resuming from the last `_id` is a single index seek regardless of depth.
 *
 * `nextAfterId` is `null` exactly when the walk is finished, so the generator loops until it is
 * null and needs no count and no total — which is also what makes the walk correct while shops are
 * being created underneath it: a new row gets a larger `_id` and is picked up by a later page
 * instead of shifting every subsequent page by one the way an offset walk would.
 */
export const GraphQLSitemapPage = new GraphQLObjectType({
	name: 'GraphQLSitemapPage',
	fields: () => ({
		nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLSitemapEntry))) },
		nextAfterId: { type: GraphQLID }
	})
})
