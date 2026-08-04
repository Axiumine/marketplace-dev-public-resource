import { GraphQLPublicPosition } from '@ptypes/GraphQLPublicPosition.mjs'
import { GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * One map pin: the least a marker needs to be drawn, labelled and clicked through.
 *
 * Deliberately **not** `GraphQLPublicCompany`. A viewport returns up to `MAX_NEARBY` of these and the
 * payload is on the critical path of every pan and zoom, so the shop's `description` — up to 2000
 * characters — and its full postal address are 200× dead weight for a marker that renders a name.
 * The click-through refetches the whole shop by `slug`, once, when the user asks for it.
 *
 * ⚠️ **`distanceMeters` is null on the bounding-box path and set on the point-and-radius path**, and
 * that asymmetry is real rather than an oversight. Distance is produced by `$geoNear`, which needs a
 * centre; a viewport rectangle has no centre that means anything to the user — the middle of the
 * screen is not where they are — so inventing one would put a plausible, wrong number on every pin.
 * A client sorting by distance must use the point form and get its centre from the browser.
 */
export const GraphQLPublicCompanyNearby = new GraphQLObjectType({
	name: 'GraphQLPublicCompanyNearby',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		publicName: { type: new GraphQLNonNull(GraphQLString) },
		slug: { type: new GraphQLNonNull(GraphQLString) },
		position: { type: new GraphQLNonNull(GraphQLPublicPosition) },
		distanceMeters: { type: GraphQLFloat }
	})
})

/**
 * The pins, and whether there were more of them than were sent.
 *
 * ⚠️ **An envelope exists only for `truncated`, and `truncated` exists only so the cap is never
 * silent.** A bare list that stops at 200 is indistinguishable from a region containing exactly 200
 * shops — the map looks complete, and the shop in position 201 is invisible with nothing anywhere
 * saying so. With the flag the UI can render "zoom in to see every shop here", which is both true
 * and the correct instruction: the fix for a truncated viewport is a smaller viewport, not a bigger
 * page.
 */
export const GraphQLPublicCompanyNearbyResult = new GraphQLObjectType({
	name: 'GraphQLPublicCompanyNearbyResult',
	fields: () => ({
		nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicCompanyNearby))) },
		truncated: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
