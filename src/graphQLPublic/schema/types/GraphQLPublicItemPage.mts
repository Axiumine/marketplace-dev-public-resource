import { GraphQLPublicItemHit } from '@ptypes/GraphQLPublicItemHit.mjs'
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * One page of items — a shop's catalogue, or one slice of a category that spans every shop.
 *
 * Same envelope and the same caveats as `GraphQLPublicCompanyPage`: read that file for what
 * `totalIsExact` means and why `hasMore` is derived from the documents actually fetched rather than from
 * `total`.
 *
 * ⚠️ **`totalIsExact` is `false` on the cross-shop path for a second reason**, on top of the count
 * cap. A count of items in a category cannot see whether each item's *shop* is published — that AND
 * spans two collections and no count can join — so the figure is an upper bound even when it is far
 * below the cap. `liveItemsAcrossShops` documents the whole problem and what would fix it.
 *
 * Two page envelopes (this and the company one) rather than one generic type because graphql-js has
 * no generics: a parameterised page would need a factory minting a distinct `GraphQLObjectType` per
 * element type anyway, and the factory's generated names (`GraphQLPage_GraphQLPublicItemHit`) are
 * what the frontend's codegen would put in its types. Two hand-written files, two readable names.
 */
export const GraphQLPublicItemPage = new GraphQLObjectType({
	name: 'GraphQLPublicItemPage',
	fields: () => ({
		nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicItemHit))) },
		total: { type: new GraphQLNonNull(GraphQLInt) },
		totalIsExact: { type: new GraphQLNonNull(GraphQLBoolean) },
		hasMore: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
