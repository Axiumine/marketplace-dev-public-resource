import { GraphQLPublicPosition } from '@ptypes/GraphQLPublicPosition.mjs'
import { GraphQLBaseAddressFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLBaseAddressFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * A shop, as an anonymous visitor sees it.
 *
 * ⚠️ **This type is a redaction of `company`, and the omissions are the point.** The collection is a
 * legal entity as much as it is a storefront: `legalName`, `vatNumber`, `taxCode`, `certifiedEmail`,
 * `uniqueCode`, `registryExtract`, `contactPerson`, `administrator` and `idShopOwner` are all on it,
 * and not one of them appears below. The ShopOwner tier's `GraphQLCompany` exposes them because the
 * only caller is the company's own owner. Here the caller is the internet.
 *
 * `published` and `deleted` are absent for a different reason: every resolver that can return this
 * type already filters on both, so a `published` field could only ever answer `true` — a constant
 * dressed as data, and one that invites a client to filter on it and get the emptiness wrong.
 *
 * **Why `publicName` and `slug` are non-null here and nullable on the ShopOwner tier.** The
 * collection stores both as optional: a company registered before the catalogue existed has neither.
 * But `20260804010000-alter-company-public` installed an `$expr` alongside the `$jsonSchema` making
 * `published: true` impossible without them, and every read path that reaches this type filters
 * `published: true`. So the nullability difference between the two tiers is not a disagreement — it
 * is the same collection seen through a filter that excludes exactly the rows where the fields are
 * missing. `description` stays nullable because the validator does not demand it: a shop may go live
 * with a name and no page body.
 */
export const GraphQLPublicCompany = new GraphQLObjectType({
	name: 'GraphQLPublicCompany',
	fields: () => ({
		// Exposed because the SPA's cache keys on it and because `/shop/:slug` needs a stable handle
		// for the map pin it came from. It is an opaque identifier, not a capability: no public
		// resolver takes one as an argument.
		_id: { type: new GraphQLNonNull(GraphQLID) },
		publicName: { type: new GraphQLNonNull(GraphQLString) },
		slug: { type: new GraphQLNonNull(GraphQLString) },
		description: { type: GraphQLString },
		address: { type: new GraphQLNonNull(GraphQLPublicCompanyAddress) }
	})
})

/**
 * The visiting address, whole. A shop that wants customers through its door publishes where the door
 * is — there is nothing to redact here that publishing a shop does not already publish.
 *
 * `position` is non-null because the collection makes it non-null: `20260803000000-create-company`
 * created the collection empty and required the point from the first insert, precisely so the map
 * would never have to reason about a shop with no coordinates.
 */
const GraphQLPublicCompanyAddress = new GraphQLObjectType({
	name: 'GraphQLPublicCompanyAddress',
	fields: () => ({
		...GraphQLBaseAddressFrag,
		position: { type: new GraphQLNonNull(GraphQLPublicPosition) }
	})
})
