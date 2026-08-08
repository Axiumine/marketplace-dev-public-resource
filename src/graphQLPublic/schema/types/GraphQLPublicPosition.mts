import { GraphQLPositionFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLPositionFrag'
import { GraphQLObjectType } from 'graphql'

/**
 * A GeoJSON `Point` as the public tier emits it — `{ type, coordinates: [longitude, latitude] }`.
 *
 * Its own file, and its own module-level instance, because two of this service's types embed it: a
 * shop's address and a map pin. GraphQL type names are unique within a schema, so declaring
 * `GraphQLPublicPosition` twice is a startup error rather than a duplicate — which is the good case.
 * The bad case is declaring one of them `GraphQLPublicPosition2` to make the error go away and
 * shipping two names for one shape into the generated client types.
 *
 * The fragment is shared with the ShopOwner and Admin tiers, so the coordinate order and the
 * `Float`-not-`Int` decision are documented once, in `marketplace-common`, and cannot drift between
 * the three.
 */
export const GraphQLPublicPosition = new GraphQLObjectType({
	name: 'GraphQLPublicPosition',
	fields: () => ({
		...GraphQLPositionFrag
	})
})
