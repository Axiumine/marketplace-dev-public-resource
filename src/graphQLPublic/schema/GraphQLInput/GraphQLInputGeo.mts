import { GraphQLFloat, GraphQLInputObjectType, GraphQLNonNull } from 'graphql'

/**
 * The two ways a caller may bound a geographic query, as input objects.
 *
 * Input objects rather than eight loose `Float` arguments, because the arguments are only meaningful
 * as a set: `minLng` without `maxLat` is not a partially specified viewport, it is nothing. GraphQL
 * can enforce "all four or none of the four" on an input object's fields and cannot enforce it
 * across sibling arguments, so the grouping moves a whole class of caller mistake from a runtime
 * check into the schema.
 *
 * ⚠️ **Bounds are not expressible here and are checked in `geoArgs.mts`.** `Float` accepts a
 * longitude of 4000 and a latitude of -900; GraphQL has no range constraint on a scalar. Every field
 * below is validated before it reaches a query — the schema guarantees the shape, `assertNearPoint`
 * and `bboxToPolygon` guarantee the values.
 */

/**
 * A map viewport. Longitude first in the field order as well as in the name, matching GeoJSON — the
 * lat/lng transposition is the one geo bug that produces no error and only wrong shops.
 */
export const GraphQLInputBoundingBox = new GraphQLInputObjectType({
	name: 'GraphQLInputBoundingBox',
	fields: () => ({
		minLng: { type: new GraphQLNonNull(GraphQLFloat) },
		minLat: { type: new GraphQLNonNull(GraphQLFloat) },
		maxLng: { type: new GraphQLNonNull(GraphQLFloat) },
		maxLat: { type: new GraphQLNonNull(GraphQLFloat) }
	})
})

/**
 * A centre and a radius — "shops near me", where *me* is the browser's geolocation.
 *
 * `radiusMeters` is non-null and has no default. A default radius is a number the server invents on
 * the user's behalf and then hides in a resolver, where the client cannot show it, cannot let the
 * user change it, and cannot explain why the result set is the size it is.
 */
export const GraphQLInputNearPoint = new GraphQLInputObjectType({
	name: 'GraphQLInputNearPoint',
	fields: () => ({
		lng: { type: new GraphQLNonNull(GraphQLFloat) },
		lat: { type: new GraphQLNonNull(GraphQLFloat) },
		radiusMeters: { type: new GraphQLNonNull(GraphQLFloat) }
	})
})
