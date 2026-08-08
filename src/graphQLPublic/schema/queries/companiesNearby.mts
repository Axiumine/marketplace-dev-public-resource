import { Company } from '@axiumine/marketplace-common/models/MongoDB/Company'
import { GraphQLInputBoundingBox, GraphQLInputNearPoint } from '@GraphQLInput/GraphQLInputGeo.mjs'
// No `centerSphereFilter` here, deliberately: the map's radius path wants distances back, so it uses
// `$geoNear` — which sorts and reports `distanceMeters` — while `centerSphereFilter` exists for the one
// caller that cannot sort by distance because it already sorts by relevance. See `search`.
import { assertNearPoint, bboxToPolygon, IBoundingBox, INearPoint, MAX_NEARBY } from '@lib/catalogue/geoArgs.mjs'
import { LIVE_PUBLIC_PIPELINE, livePublic } from '@lib/catalogue/publicRead.mjs'
import { GraphQLPublicCompanyNearbyResult } from '@ptypes/GraphQLPublicCompanyNearby.mjs'
import { GraphQLInt, GraphQLNonNull } from 'graphql'
import { trusted, Types } from 'mongoose'

interface IArgs {
	bbox?: IBoundingBox | null
	near?: INearPoint | null
	limit?: number | null
}

interface IPin {
	_id: Types.ObjectId
	publicName: string
	slug: string
	position: { type: string; coordinates: number[] }
	distanceMeters?: number
}

/** Shape the bbox path fetches — `position` is still nested under `address` there. */
interface IBboxCompany {
	_id: Types.ObjectId
	publicName: string
	slug: string
	address: { position: { type: string; coordinates: number[] } }
}

/**
 * The map. Shops inside a viewport rectangle, or shops within a radius of a point.
 *
 * ⚠️ **Exactly one of `bbox` and `near`**, and the two are not interchangeable — they answer
 * different questions and only one of them can produce a distance:
 *
 * - `bbox` is *"what is on screen"*. It runs `$geoWithin` over a GeoJSON polygon, which is a pure
 *   predicate: no sort, no centre, no distance. `distanceMeters` comes back `null` on every pin, and
 *   that is honest — the middle of a viewport is not where the user is, so any distance measured
 *   from it would be a plausible wrong number on every marker.
 * - `near` is *"what is close to me"*, with *me* supplied by the browser's geolocation. It runs
 *   `$geoNear`, which sorts by distance and reports it, so the nearest shop is first and every pin
 *   carries a real `distanceMeters`.
 *
 * Both read the `address.position_2dsphere` index, added by `20260804010000-alter-company-public`;
 * neither builds a filter that is not backed by it. ⚠️ `$geoNear` **must be the first stage of its
 * pipeline** — that is a server rule, not a style choice — which is why the liveness filter travels
 * inside its `query` option instead of in a `$match` in front of it. A `$match` first is not slower,
 * it is a hard error.
 *
 * `key: 'address.position'` is named explicitly. `$geoNear` infers the field from the available
 * geospatial indexes and fails at runtime the moment a second `2dsphere` index exists on this
 * collection — a failure whose message points at the aggregation rather than at the new index.
 *
 * ⚠️ **`trusted()` on the bbox filter, none in the pipeline.** `sanitizeFilter` is on globally and
 * wraps any non-`$` key whose value contains `$` operators into `{ $eq: … }`, which would turn the
 * `$geoWithin` on `address.position` into an equality test against a literal polygon object — a
 * filter that matches nothing, silently, and looks like an empty map. Aggregation stages never pass
 * through `sanitizeFilter`, so the `$geoNear` path spells the same predicates plainly.
 */
export const companiesNearby = {
	type: new GraphQLNonNull(GraphQLPublicCompanyNearbyResult),
	description: 'Get published companies inside a bounding box, or within a radius of a point',
	args: {
		bbox: { type: GraphQLInputBoundingBox },
		near: { type: GraphQLInputNearPoint },
		limit: { type: GraphQLInt }
	},
	async resolve(_: unknown, args: IArgs) {
		if (!args.bbox === !args.near) {
			throw new Error('Pass exactly one of bbox or near')
		}

		// Its own clamp rather than clampLimit(): a page of shop cards and a screenful of map markers
		// are bounded by different things — one by what a reader scrolls, the other by what a browser
		// can draw and what a viewport payload may weigh.
		const requested = args.limit ?? MAX_NEARBY
		// `min(max(…))` rather than a boundary comparison — see clampLimit(): `requested < 1` and
		// `requested <= 1` return the same 1, so the comparison form carries an unkillable mutant.
		const limit = Math.min(Math.max(requested, 1), MAX_NEARBY)

		// limit + 1, so `truncated` is exact for the cost of one extra pin. A bare `=== limit` cannot
		// tell a full page from a region that happens to hold exactly that many shops.
		const pins = args.near ? await pinsNear(args.near, limit + 1) : await pinsInBox(args.bbox!, limit + 1)

		const truncated = pins.length > limit
		if (truncated) pins.pop()

		return { nodes: pins, truncated }
	}
}

async function pinsNear(near: INearPoint, limit: number): Promise<IPin[]> {
	assertNearPoint(near)

	return await Company.aggregate<IPin>([
		{
			$geoNear: {
				near: { type: 'Point', coordinates: [near.lng, near.lat] },
				distanceField: 'distanceMeters',
				maxDistance: near.radiusMeters,
				// spherical: true is what makes maxDistance and distanceField metres. Without it they
				// are radians against a planar index, and the query answers with the wrong shops
				// rather than with an error.
				spherical: true,
				key: 'address.position',
				query: LIVE_PUBLIC_PIPELINE
			}
		},
		{ $limit: limit },
		{ $project: { _id: 1, publicName: 1, slug: 1, position: '$address.position', distanceMeters: 1 } }
	])
}

async function pinsInBox(bbox: IBoundingBox, limit: number): Promise<IPin[]> {
	const docs = await Company.find(
		{ ...livePublic(), 'address.position': trusted(bboxToPolygon(bbox)) },
		'_id publicName slug address.position'
	)
		.limit(limit)
		.lean<IBboxCompany[]>()

	// Flattened here rather than by a `$project`, because `find()` has no stage to do it in. The
	// alternative — exposing `address` on the pin type — would ship four postal-address strings per
	// marker that nothing draws.
	return docs.map((doc) => ({
		_id: doc._id,
		publicName: doc.publicName,
		slug: doc.slug,
		position: doc.address.position
	}))
}
