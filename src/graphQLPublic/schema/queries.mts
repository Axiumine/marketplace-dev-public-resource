import { GraphQLObjectType } from 'graphql'

import { companies } from './queries/companies.mjs'
import { companiesNearby } from './queries/companiesNearby.mjs'
import { companyBySlug } from './queries/companyBySlug.mjs'
import { itemBySlug } from './queries/itemBySlug.mjs'
import { itemCategories } from './queries/itemCategories.mjs'
import { items } from './queries/items.mjs'
import { publicHelloArgs } from './queries/publicHelloArgs.mjs'
import { publicHelloNoArgs } from './queries/publicHelloNoArgs.mjs'
import { search } from './queries/search.mjs'
import { sitemapEntries } from './queries/sitemapEntries.mjs'

/**
 * The whole public read surface, and the only tier on the platform that answers without a token.
 *
 * ⚠️ **There is no auth middleware in front of any of these.** This service mounts none — that is what
 * "public" means here — so every field below is reachable by anyone on the internet, unauthenticated,
 * at whatever rate they choose. Two consequences hold for anything added to this list. First, the
 * projection is the security boundary: `PUBLIC_COMPANY_PROJECTION` names five fields of a document
 * that also carries a VAT number, and a new field on a public type is a publication decision, not a
 * convenience. Second, every argument that can grow the server's work — `limit`, `offset`, `q`,
 * `radiusMeters`, the bbox size — is bounded in the resolver, because nothing upstream will bound it.
 *
 * The eight reads split cleanly by consumer: `companies` / `companyBySlug` / `items` / `itemBySlug` /
 * `itemCategories` serve the SSR routes and are the crawlable surface; `companiesNearby` and `search`
 * serve client-side islands (map, search box); `sitemapEntries` serves the sitemap generator alone.
 * The two demo queries predate all of it and stay as the smoke test that the endpoint is mounted.
 */
const QueriesPublic = new GraphQLObjectType({
	name: 'QueriesPublic',
	fields: {
		publicHelloNoArgs,
		publicHelloArgs,
		companies,
		companyBySlug,
		companiesNearby,
		items,
		itemBySlug,
		itemCategories,
		search,
		sitemapEntries
	}
})

export default QueriesPublic
