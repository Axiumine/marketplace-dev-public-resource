import { describe, expect, it } from 'vitest'

import {
	assertNearPoint,
	bboxToPolygon,
	centerSphereFilter,
	MAX_BBOX_DEGREES,
	MAX_NEARBY,
	MAX_RADIUS_METERS
} from '../src/lib/catalogue/geoArgs.mts'

/** Piazza del Duomo, Milan — longitude first, which is the one thing this whole module is about. */
const MILAN = { lng: 9.1919, lat: 45.4642 }

describe('the geographic caps', () => {
	it('are the values the map and the resolvers assume', () => {
		expect(MAX_RADIUS_METERS).toBe(200_000)
		expect(MAX_BBOX_DEGREES).toBe(10)
		expect(MAX_NEARBY).toBe(200)
	})
})

describe('assertNearPoint', () => {
	// Returns the same object rather than a copy: the caller passes it straight into the aggregation
	// and a defensive clone would only hide a mutation nobody makes.
	it('returns the point it was given', () => {
		const near = { ...MILAN, radiusMeters: 5_000 }

		expect(assertNearPoint(near)).toBe(near)
	})

	// The extremes are legal coordinates, not errors. A cap written with `<` where `<=` belongs turns
	// the antimeridian and both poles into "not a longitude", which nothing on a single-country platform
	// would ever notice — until the first customer opens the map somewhere else.
	it.each([
		['the antimeridian', { lng: 180, lat: 0 }],
		['its negative twin', { lng: -180, lat: 0 }],
		['the north pole', { lng: 0, lat: 90 }],
		['the south pole', { lng: 0, lat: -90 }],
		['null island', { lng: 0, lat: 0 }]
	])('accepts %s', (_desc, point) => {
		expect(() => assertNearPoint({ ...point, radiusMeters: 1 })).not.toThrow()
	})

	it.each([
		['a longitude past +180', { lng: 180.000001, lat: 0 }, 'near.lng must be a longitude between -180 and 180'],
		['a longitude past -180', { lng: -180.000001, lat: 0 }, 'near.lng must be a longitude between -180 and 180'],
		['a non-finite longitude', { lng: Number.NaN, lat: 0 }, 'near.lng must be a longitude between -180 and 180'],
		['an infinite longitude', { lng: Number.POSITIVE_INFINITY, lat: 0 }, 'near.lng must be a longitude between -180 and 180'],
		['a latitude past +90', { lng: 0, lat: 90.000001 }, 'near.lat must be a latitude between -90 and 90'],
		['a latitude past -90', { lng: 0, lat: -90.000001 }, 'near.lat must be a latitude between -90 and 90'],
		['a non-finite latitude', { lng: 0, lat: Number.NaN }, 'near.lat must be a latitude between -90 and 90']
	])('refuses %s', (_desc, point, message) => {
		expect(() => assertNearPoint({ ...point, radiusMeters: 1 })).toThrow(message)
	})

	// ⚠️ A radius of zero is refused rather than clamped: `$centerSphere` with radius 0 is a valid
	// query that matches only a shop standing on the exact coordinate, so it would answer an empty map
	// and look like there are no shops rather than like a bad argument.
	it.each([
		['zero', 0],
		['a negative radius', -1],
		['a non-finite radius', Number.NaN]
	])('refuses %s as a radius', (_desc, radiusMeters) => {
		expect(() => assertNearPoint({ ...MILAN, radiusMeters })).toThrow('near.radiusMeters must be greater than 0')
	})

	it('accepts the largest radius it will search, and refuses one metre more', () => {
		expect(() => assertNearPoint({ ...MILAN, radiusMeters: MAX_RADIUS_METERS })).not.toThrow()
		expect(() => assertNearPoint({ ...MILAN, radiusMeters: MAX_RADIUS_METERS + 1 })).toThrow(
			'near.radiusMeters must not exceed 200000'
		)
	})
})

describe('centerSphereFilter', () => {
	// ⚠️ **Radians, not metres**, and the division is the entire content of this function. Handing
	// `$centerSphere` metres is a silent catastrophe rather than an error: 5000 radians is 795 times
	// around the planet, so the filter matches every shop on the platform and the result reads as a
	// working proximity search whose radius is simply ignored. The expected number is written out
	// rather than recomputed from the same constant the source divides by, so a changed divisor fails.
	it('converts the radius to radians against Earth’s equatorial radius', () => {
		expect(centerSphereFilter({ ...MILAN, radiusMeters: 6_378_100 })).toEqual({
			$geoWithin: { $centerSphere: [[9.1919, 45.4642], 1] }
		})
	})

	// Longitude first. A `2dsphere` index over swapped pairs builds without complaint and answers
	// every query with the wrong shops — there is no error to catch, only wrong answers, which is why
	// the order is asserted at the boundary and never re-derived downstream.
	it('emits the centre longitude first', () => {
		const filter = centerSphereFilter({ ...MILAN, radiusMeters: 5_000 })

		expect(filter.$geoWithin.$centerSphere[0]).toEqual([9.1919, 45.4642])
		expect(filter.$geoWithin.$centerSphere[1]).toBeCloseTo(5_000 / 6_378_100, 12)
	})
})

describe('bboxToPolygon', () => {
	const bbox = { minLng: 9, minLat: 45, maxLng: 10, maxLat: 46 }

	// ⚠️ A GeoJSON `Polygon` rather than the shorter `$box`, which is a legacy 2d operator: accepted
	// against a 2dsphere index but interpreted with planar geometry, so its edges disagree with the
	// index's spherical ones by kilometres at mid latitudes.
	//
	// The ring is asserted position by position because its winding order *is* which side is "inside".
	// A clockwise ring is not rejected by MongoDB — it is read as the complement, everywhere on Earth
	// except the viewport, which returns every shop that is off screen.
	it('emits a closed counter-clockwise ring, longitude first', () => {
		expect(bboxToPolygon(bbox)).toEqual({
			$geoWithin: {
				$geometry: {
					type: 'Polygon',
					coordinates: [
						[
							[9, 45],
							[10, 45],
							[10, 46],
							[9, 46],
							[9, 45]
						]
					]
				}
			}
		})
	})

	it('closes the ring on the corner it started from', () => {
		const [ring] = bboxToPolygon(bbox).$geoWithin.$geometry.coordinates

		expect(ring).toHaveLength(5)
		expect(ring[4]).toEqual(ring[0])
	})

	it.each([
		['a bad minLng', { minLng: -181 }, 'bbox.minLng must be a longitude between -180 and 180'],
		['a bad maxLng', { maxLng: 181 }, 'bbox.maxLng must be a longitude between -180 and 180'],
		['a bad minLat', { minLat: -91 }, 'bbox.minLat must be a latitude between -90 and 90'],
		['a bad maxLat', { maxLat: 91 }, 'bbox.maxLat must be a latitude between -90 and 90']
	])('refuses %s, naming the corner', (_desc, patch, message) => {
		expect(() => bboxToPolygon({ ...bbox, ...patch })).toThrow(message)
	})

	// ⚠️ `minLng > maxLng` is how a map library says "the viewport wraps past ±180°". Answering it
	// correctly means two polygons and a `$or`; nothing on a single-country platform can produce that
	// viewport, so it is refused with a message that says what happened. A naive polygon build would
	// return the inverted rectangle instead — and it would appear to work.
	it.each([
		['an inverted longitude pair', { minLng: 10, maxLng: 9 }],
		['a degenerate longitude pair', { minLng: 9, maxLng: 9 }]
	])('refuses %s rather than inverting the rectangle', (_desc, patch) => {
		expect(() => bboxToPolygon({ ...bbox, ...patch })).toThrow(
			'bbox.minLng must be smaller than bbox.maxLng — a box crossing the antimeridian is not supported'
		)
	})

	it.each([
		['an inverted latitude pair', { minLat: 46, maxLat: 45 }],
		['a degenerate latitude pair', { minLat: 45, maxLat: 45 }]
	])('refuses %s', (_desc, patch) => {
		expect(() => bboxToPolygon({ ...bbox, ...patch })).toThrow('bbox.minLat must be smaller than bbox.maxLat')
	})

	// The cap is what keeps a `$geoWithin` from degenerating into a scan of every published company.
	// Both edges are checked, and both boundaries: exactly ten degrees is a legal viewport.
	it.each([
		['a ten-degree wide box', { maxLng: 19 }],
		['a ten-degree tall box', { maxLat: 55 }]
	])('accepts %s', (_desc, patch) => {
		expect(() => bboxToPolygon({ ...bbox, ...patch })).not.toThrow()
	})

	it.each([
		['too wide', { maxLng: 19.000001 }],
		['too tall', { maxLat: 55.000001 }]
	])('refuses a box that is %s, and says to zoom in', (_desc, patch) => {
		expect(() => bboxToPolygon({ ...bbox, ...patch })).toThrow('bbox edges must not exceed 10 degrees — zoom in')
	})
})
