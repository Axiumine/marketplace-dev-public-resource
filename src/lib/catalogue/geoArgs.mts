/**
 * Validation and translation for the two geographic shapes the map speaks: a viewport rectangle and
 * a point with a radius.
 *
 * Both end up as a MongoDB geo operator over `company.address.position`, which
 * `20260804010000-alter-company-public` indexed `2dsphere`. Nothing here builds a filter that is not
 * backed by that index.
 *
 * ⚠️ **Longitude first, everywhere.** GeoJSON orders a coordinate pair `[longitude, latitude]`, and
 * so does every operator below. The migration that added the index says why this matters more than
 * it looks: a `2dsphere` index over `[lat, lng]` data builds without complaint and answers every
 * query with the wrong shops. There is no error to catch — only wrong answers — so the order is
 * asserted at the schema boundary here and never re-derived downstream.
 */

/** Earth's equatorial radius in metres, the divisor `$centerSphere` wants to be given radians. */
const EARTH_RADIUS_METERS = 6_378_100

/**
 * Largest radius `companiesNearby` will search.
 *
 * 200 km covers "shops near me" for any realistic definition of near, including a customer willing
 * to drive. Past it the query stops being a proximity search and becomes an unfiltered listing with
 * a slow geometric predicate in front of it, which `companies` already serves better.
 */
export const MAX_RADIUS_METERS = 200_000

/**
 * Largest edge, in degrees, of a viewport rectangle.
 *
 * A bounding box is a map viewport, and a viewport wider than this is a zoomed-out map that cannot
 * usefully render individual pins anyway. The cap is what keeps a `$geoWithin` from degenerating
 * into a scan of every published company on the platform. 10° of latitude is about 1100 km — the
 * whole of Italy fits.
 */
export const MAX_BBOX_DEGREES = 10

/** Largest number of pins one map request returns. See `companiesNearby` for what happens past it. */
export const MAX_NEARBY = 200

export interface IBoundingBox {
	minLng: number
	minLat: number
	maxLng: number
	maxLat: number
}

export interface INearPoint {
	lng: number
	lat: number
	radiusMeters: number
}

function assertLng(value: number, name: string): void {
	if (!Number.isFinite(value) || value < -180 || value > 180) {
		throw new Error(`${name} must be a longitude between -180 and 180`)
	}
}

function assertLat(value: number, name: string): void {
	if (!Number.isFinite(value) || value < -90 || value > 90) {
		throw new Error(`${name} must be a latitude between -90 and 90`)
	}
}

/**
 * Turn a validated point and radius into the `$geoWithin` / `$centerSphere` filter.
 *
 * `$centerSphere` rather than `$near`, and the difference is not cosmetic: `$near` sorts its result
 * by distance and therefore cannot be combined with a `$text` search or with any other sort, while
 * `$geoWithin` is a pure predicate that composes with everything. `search` needs exactly that
 * composition — text relevance *and* a geographic bound — so both callers here use the composable
 * one and `companiesNearby` gets its distances from a separate `$geoNear` aggregation instead.
 *
 * `$centerSphere` takes its radius in **radians**, not metres. Handing it metres is a silent
 * catastrophe: 5000 radians is 795 times around the planet, so the filter matches everything and the
 * result looks like a working proximity search whose radius is simply ignored.
 */
export function assertNearPoint(near: INearPoint): INearPoint {
	assertLng(near.lng, 'near.lng')
	assertLat(near.lat, 'near.lat')

	if (!Number.isFinite(near.radiusMeters) || near.radiusMeters <= 0) {
		throw new Error('near.radiusMeters must be greater than 0')
	}
	if (near.radiusMeters > MAX_RADIUS_METERS) {
		throw new Error(`near.radiusMeters must not exceed ${MAX_RADIUS_METERS}`)
	}

	return near
}

/** The `address.position` filter for a validated point. Call `assertNearPoint` first. */
export function centerSphereFilter(near: INearPoint) {
	return {
		$geoWithin: {
			$centerSphere: [[near.lng, near.lat], near.radiusMeters / EARTH_RADIUS_METERS]
		}
	}
}

/**
 * Validate a viewport rectangle and turn it into a GeoJSON `Polygon`.
 *
 * A polygon rather than the shorter `$box`, because `$box` is a legacy 2d operator: it is *accepted*
 * against a `2dsphere` index but interpreted with planar geometry, so its edges are straight lines
 * on an equirectangular projection rather than on the sphere the index actually models. The two
 * disagree by kilometres at Italian latitudes — a shop just inside the drawn rectangle can fall
 * outside the queried one — and the disagreement grows with the box.
 *
 * The ring is emitted counter-clockwise and closed. MongoDB reads a GeoJSON polygon by the
 * right-hand rule, so the winding order *is* which side of the ring is "inside"; a clockwise ring is
 * not an error, it is the complement of the intended area — everywhere on Earth except the viewport.
 *
 * ⚠️ **A box crossing the antimeridian is rejected rather than split.** `minLng > maxLng` is how a
 * map library expresses "the viewport wraps past ±180°", and answering it correctly means two
 * polygons and a `$or`. Nothing on an Italy-only platform can produce that viewport, so it is
 * refused with a message that says what happened instead of silently returning the inverted
 * rectangle — which is what a naive polygon build would do, and it would appear to work.
 */
export function bboxToPolygon(bbox: IBoundingBox) {
	assertLng(bbox.minLng, 'bbox.minLng')
	assertLng(bbox.maxLng, 'bbox.maxLng')
	assertLat(bbox.minLat, 'bbox.minLat')
	assertLat(bbox.maxLat, 'bbox.maxLat')

	if (bbox.minLng >= bbox.maxLng) {
		throw new Error('bbox.minLng must be smaller than bbox.maxLng — a box crossing the antimeridian is not supported')
	}
	if (bbox.minLat >= bbox.maxLat) {
		throw new Error('bbox.minLat must be smaller than bbox.maxLat')
	}
	if (bbox.maxLng - bbox.minLng > MAX_BBOX_DEGREES || bbox.maxLat - bbox.minLat > MAX_BBOX_DEGREES) {
		throw new Error(`bbox edges must not exceed ${MAX_BBOX_DEGREES} degrees — zoom in`)
	}

	return {
		$geoWithin: {
			$geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[bbox.minLng, bbox.minLat],
						[bbox.maxLng, bbox.minLat],
						[bbox.maxLng, bbox.maxLat],
						[bbox.minLng, bbox.maxLat],
						[bbox.minLng, bbox.minLat]
					]
				]
			}
		}
	}
}
