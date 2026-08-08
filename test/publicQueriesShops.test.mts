import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql'
import { trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, Mock, vi } from 'vitest'

const companyFind = vi.fn()
const companyFindOne = vi.fn()
const companyCountDocuments = vi.fn(async () => 0)
const companyAggregate = vi.fn(async () => [])
const itemCategoryFind = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind, findOne: companyFindOne, countDocuments: companyCountDocuments, aggregate: companyAggregate }
}))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { find: itemCategoryFind }
}))

interface IChain {
	sort: Mock
	skip: Mock
	limit: Mock
	lean: Mock
}

/** A mongoose `Query`, mocked as the fluent object it is: every link returns itself, `lean` resolves. */
const chain = (rows: unknown): IChain => {
	const self = {} as IChain

	self.sort = vi.fn(() => self)
	self.skip = vi.fn(() => self)
	self.limit = vi.fn(() => self)
	self.lean = vi.fn(async () => rows)

	return self
}

const TRUSTED = Object.getOwnPropertySymbols(trusted({}))[0]
const live = { published: true, deleted: trusted({ $exists: false }) }
const MILAN = { lng: 9.1919, lat: 45.4642 }

const shop = (n: number) => ({ _id: new Types.ObjectId(), publicName: `Shop ${n}`, slug: `shop-${n}` })
const pin = (n: number) => ({ ...shop(n), address: { position: { type: 'Point', coordinates: [9 + n / 100, 45] } } })

// Imported per test rather than at the top: these field objects are built at module load, so a
// top-level `await import()` would evaluate them during Vitest's collection phase — outside the window
// Stryker attributes mutants to, where a killed mutant is reported as Survived.
let companies: (typeof import('../src/graphQLPublic/schema/queries/companies.mts'))['companies']
let PUBLIC_COMPANY_PROJECTION: (typeof import('../src/graphQLPublic/schema/queries/companies.mts'))['PUBLIC_COMPANY_PROJECTION']
let companyBySlug: (typeof import('../src/graphQLPublic/schema/queries/companyBySlug.mts'))['companyBySlug']
let companiesNearby: (typeof import('../src/graphQLPublic/schema/queries/companiesNearby.mts'))['companiesNearby']
let itemCategories: (typeof import('../src/graphQLPublic/schema/queries/itemCategories.mts'))['itemCategories']

beforeEach(async () => {
	vi.clearAllMocks()
	companyCountDocuments.mockResolvedValue(0)
	companyAggregate.mockResolvedValue([])
	;({ companies, PUBLIC_COMPANY_PROJECTION } = await import('../src/graphQLPublic/schema/queries/companies.mts'))
	;({ companyBySlug } = await import('../src/graphQLPublic/schema/queries/companyBySlug.mts'))
	;({ companiesNearby } = await import('../src/graphQLPublic/schema/queries/companiesNearby.mts'))
	;({ itemCategories } = await import('../src/graphQLPublic/schema/queries/itemCategories.mts'))
})

describe('PUBLIC_COMPANY_PROJECTION', () => {
	// ⚠️ **The projection is a security boundary, not an optimisation.** `legalName`, `vatNumber`,
	// `taxCode`, `certifiedEmail`, `uniqueCode`, `registryExtract`, `contactPerson`, `administrator` and
	// `idShopOwner` live on the same document as `publicName`. GraphQL would refuse to *serve* them since
	// the public type does not declare them — but that leaves the whole document in this process's
	// memory, its query logs and any Sentry breadcrumb, on every request from the open internet.
	it('names the five public fields and nothing from the legal entity', () => {
		expect(PUBLIC_COMPANY_PROJECTION.split(' ').sort()).toEqual(['_id', 'address', 'description', 'publicName', 'slug'])
		expect(PUBLIC_COMPANY_PROJECTION).not.toMatch(
			/legalName|vatNumber|taxCode|certifiedEmail|uniqueCode|registryExtract|contactPerson|administrator|idShopOwner/
		)
	})
})

describe('companies', () => {
	const resolve = async (args: Record<string, unknown> = {}, rows: unknown[] = [], total = 0) => {
		const query = chain(rows)
		companyFind.mockReturnValueOnce(query)
		companyCountDocuments.mockResolvedValueOnce(total)

		return { page: await companies.resolve(null, args), query }
	}

	it('answers a non-nullable page and takes three optional arguments', () => {
		expect(companies.description).toBe('Get published companies, paginated, optionally filtered by city')
		expect(companies.type).toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(companies.args)).toEqual(['limit', 'offset', 'city'])
		expect(companies.args.limit.type).toBe(GraphQLInt)
		expect(companies.args.offset.type).toBe(GraphQLInt)
		expect(companies.args.city.type).toBe(GraphQLString)
	})

	// Alphabetical rather than newest-first: a listing ordered by insertion time reorders itself under
	// the reader between page 1 and page 2, and a crawler revisiting `/shops?page=7` must find roughly
	// what it found last time or every URL it indexed points at different shops.
	it('walks published shops by name, from the default page size', async () => {
		const { query } = await resolve()

		expect(companyFind).toHaveBeenCalledExactlyOnceWith(live, PUBLIC_COMPANY_PROJECTION)
		expect(query.sort).toHaveBeenCalledExactlyOnceWith({ publicName: 1 })
		expect(query.skip).toHaveBeenCalledExactlyOnceWith(0)
		expect(query.lean).toHaveBeenCalledOnce()
	})

	// ⚠️ `limit + 1` rather than a second count: one extra index entry answers "is there another page"
	// exactly, and stays exact past `COUNT_CAP` where `total` no longer is. The extra row is dropped.
	it('fetches one row past the window to answer hasMore, and drops it', async () => {
		const rows = [shop(1), shop(2), shop(3)]
		const { page, query } = await resolve({ limit: 2 }, rows)

		expect(query.limit).toHaveBeenCalledExactlyOnceWith(3)
		expect(page.hasMore).toBe(true)
		expect(page.nodes).toHaveLength(2)
	})

	it('reports no further page when the window comes back short', async () => {
		const { page } = await resolve({ limit: 2 }, [shop(1)])

		expect(page.hasMore).toBe(false)
		expect(page.nodes).toHaveLength(1)
	})

	it('reports no further page when the window is exactly full', async () => {
		const { page } = await resolve({ limit: 2 }, [shop(1), shop(2)])

		expect(page.hasMore).toBe(false)
		expect(page.nodes).toHaveLength(2)
	})

	it('clamps the page size and normalises the offset before they reach the driver', async () => {
		const { query } = await resolve({ limit: 500, offset: -3 })

		expect(query.limit).toHaveBeenCalledExactlyOnceWith(61)
		expect(query.skip).toHaveBeenCalledExactlyOnceWith(0)
	})

	it('refuses an offset past the cap rather than answering a different window', async () => {
		await expect(companies.resolve(null, { offset: 10_001 })).rejects.toThrow('offset must not exceed 10000')

		expect(companyFind).not.toHaveBeenCalled()
	})

	// ⚠️ **`city` is matched exactly, not fuzzily.** It is a URL segment produced by this platform's own
	// links, not a search box — `search` is the search box. Equality is what `published_city_publicName`
	// can serve; a `$regex` on the same field cannot use the index and turns the second-most-requested
	// route into a collection scan.
	it('narrows on an exact city, in the same filter the count uses', async () => {
		await resolve({ city: 'Boston' })

		expect(companyFind.mock.calls[0][0]).toEqual({ ...live, 'address.city': 'Boston' })
		expect(companyFind.mock.calls[0][0]['address.city']).toBe('Boston')
		expect(companyCountDocuments.mock.calls[0][0]).toBe(companyFind.mock.calls[0][0])
	})

	it.each([
		['an omitted city', undefined],
		['a null city', null],
		['an empty city', '']
	])('ignores %s instead of filtering on it', async (_desc, city) => {
		await resolve({ city })

		expect(Object.keys(companyFind.mock.calls[0][0])).toEqual(['published', 'deleted'])
	})

	// ⚠️ The `deleted` clause has to carry the `trusted()` tag: `sanitizeFilter` is on globally, and an
	// untagged `{ $exists: false }` is cast as a literal value against the path — a filter that matches
	// nothing, silently, which reads to every caller as "the platform has no shops".
	it('keeps the trusted tag on the liveness clause', async () => {
		await resolve({ city: 'Boston' })

		expect(companyFind.mock.calls[0][0].deleted[TRUSTED]).toBe(true)
	})

	// The `limit` option is what bounds the count: the server stops walking at COUNT_CAP matches rather
	// than at the end of the collection.
	it('bounds the count at the cap and reports it as exact only below it', async () => {
		const { page } = await resolve({}, [], 4_999)

		expect(companyCountDocuments).toHaveBeenCalledExactlyOnceWith(live, { limit: 5_000 })
		expect(page.total).toBe(4_999)
		expect(page.totalIsExact).toBe(true)
	})

	// Conservative at the boundary: a collection holding exactly COUNT_CAP matches reports `false` for a
	// figure that happens to be exact. The other rounding — claiming exactness for a capped count — has a
	// client render a page count that is wrong.
	it('calls a count that reached the cap inexact', async () => {
		const { page } = await resolve({}, [], 5_000)

		expect(page.totalIsExact).toBe(false)
	})
})

describe('companyBySlug', () => {
	// ⚠️ **Nullable on purpose — this is how a 404 is expressed.** An unknown slug, an unpublished shop
	// and a retired one answer identically; distinguishing them would tell anyone which draft shop names
	// are taken and which shops have gone dark.
	it('is nullable, and takes the slug as its only argument', () => {
		expect(companyBySlug.description).toBe('Get one published company by its slug, or null')
		expect(companyBySlug.type).not.toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(companyBySlug.args)).toEqual(['slug'])
		expect(companyBySlug.args.slug.type).toBeInstanceOf(GraphQLNonNull)
	})

	it('seeks the slug with the liveness pair, projecting only the public fields', async () => {
		const found = shop(1)
		companyFindOne.mockReturnValueOnce(chain(found))

		await expect(companyBySlug.resolve(null, { slug: 'shop-1' })).resolves.toBe(found)

		expect(companyFindOne).toHaveBeenCalledExactlyOnceWith({ slug: 'shop-1', ...live }, PUBLIC_COMPANY_PROJECTION)
		expect(companyFindOne.mock.calls[0][0].deleted[TRUSTED]).toBe(true)
	})

	it('answers null for anything that is not a live published shop', async () => {
		companyFindOne.mockReturnValueOnce(chain(null))

		await expect(companyBySlug.resolve(null, { slug: 'gone' })).resolves.toBeNull()
	})
})

describe('companiesNearby', () => {
	const bbox = { minLng: 9, minLat: 45, maxLng: 10, maxLat: 46 }

	it('answers a non-nullable result and takes a box, a point and a limit', () => {
		expect(companiesNearby.description).toBe('Get published companies inside a bounding box, or within a radius of a point')
		expect(companiesNearby.type).toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(companiesNearby.args)).toEqual(['bbox', 'near', 'limit'])
		expect(companiesNearby.args.limit.type).toBe(GraphQLInt)
	})

	// ⚠️ Exactly one, because the two answer different questions and only one of them can produce a
	// distance. Accepting both would mean silently picking one and reporting distances measured from a
	// centre the caller never asked about.
	it.each([
		['neither', {}],
		['both', { bbox, near: { ...MILAN, radiusMeters: 5_000 } }]
	])('refuses %s of bbox and near', async (_desc, args) => {
		await expect(companiesNearby.resolve(null, args)).rejects.toThrow('Pass exactly one of bbox or near')

		expect(companyAggregate).not.toHaveBeenCalled()
		expect(companyFind).not.toHaveBeenCalled()
	})

	describe('the radius path', () => {
		const near = { ...MILAN, radiusMeters: 5_000 }

		const resolveNear = async (args: Record<string, unknown> = {}, rows: unknown[] = []) => {
			companyAggregate.mockResolvedValueOnce(rows)

			const result = await companiesNearby.resolve(null, { near, ...args })

			return { result, pipeline: companyAggregate.mock.calls[0][0] }
		}

		// ⚠️ `$geoNear` **must be the first stage** — a server rule, not a style choice — which is why the
		// liveness filter travels inside its `query` option instead of a `$match` in front of it. A
		// `$match` first is not slower, it is a hard error. And `spherical: true` is what makes
		// `maxDistance` and the reported distance metres: without it they are radians against a planar
		// interpretation, and the query answers with the wrong shops rather than with an error.
		it('geo-sorts from the point, in metres, over live shops only', async () => {
			const { pipeline } = await resolveNear()

			expect(pipeline[0]).toEqual({
				$geoNear: {
					near: { type: 'Point', coordinates: [9.1919, 45.4642] },
					distanceField: 'distanceMeters',
					maxDistance: 5_000,
					spherical: true,
					key: 'address.position',
					query: { published: true, deleted: { $exists: false } }
				}
			})
			expect(Object.getOwnPropertySymbols(pipeline[0].$geoNear.query.deleted)).toHaveLength(0)
		})

		// `key` is named explicitly because `$geoNear` otherwise infers the field from the available
		// geospatial indexes and fails the moment a second `2dsphere` index exists on this collection — a
		// failure whose message points at the aggregation rather than at the new index.
		it('names the indexed field rather than letting the server infer it', async () => {
			const { pipeline } = await resolveNear()

			expect(pipeline[0].$geoNear.key).toBe('address.position')
		})

		it('projects the pin shape, distance included', async () => {
			const { pipeline } = await resolveNear()

			expect(pipeline[2]).toEqual({
				$project: { _id: 1, publicName: 1, slug: 1, position: '$address.position', distanceMeters: 1 }
			})
			expect(pipeline).toHaveLength(3)
		})

		// Its own clamp rather than `clampLimit`: a page of shop cards and a screenful of map markers are
		// bounded by different things — one by what a reader scrolls, the other by what a browser can draw.
		it.each([
			['the default screenful', undefined, 201],
			['a caller’s own page', 50, 51],
			['zero, raised to one', 0, 2],
			['a negative limit, raised to one', -10, 2],
			['a limit past the ceiling', 10_000, 201]
		])('fetches one past %s', async (_desc, limit, expected) => {
			const { pipeline } = await resolveNear({ limit })

			expect(pipeline[1]).toEqual({ $limit: expected })
		})

		// A bare `rows.length === limit` cannot tell a full page from a region holding exactly that many
		// shops, and the map draws "there are more shops here" from this flag.
		it('reports truncation exactly, and returns only the asked-for pins', async () => {
			const { result } = await resolveNear({ limit: 2 }, [pin(1), pin(2), pin(3)])

			expect(result.truncated).toBe(true)
			expect(result.nodes).toHaveLength(2)
		})

		it('reports no truncation for a region that fills the page exactly', async () => {
			const { result } = await resolveNear({ limit: 2 }, [pin(1), pin(2)])

			expect(result.truncated).toBe(false)
			expect(result.nodes).toHaveLength(2)
		})

		it('validates the point before it builds a pipeline', async () => {
			await expect(companiesNearby.resolve(null, { near: { lng: 9.19, lat: 45.46, radiusMeters: 0 } })).rejects.toThrow(
				'near.radiusMeters must be greater than 0'
			)

			expect(companyAggregate).not.toHaveBeenCalled()
		})
	})

	describe('the viewport path', () => {
		const resolveBox = async (args: Record<string, unknown> = {}, rows: unknown[] = []) => {
			const query = chain(rows)
			companyFind.mockReturnValueOnce(query)

			return { result: await companiesNearby.resolve(null, { bbox, ...args }), query }
		}

		// ⚠️ `trusted()` here and nowhere in the `$geoNear` pipeline: `sanitizeFilter` would wrap the
		// `$geoWithin` into an `{ $eq: … }` against a literal polygon object — a filter matching nothing,
		// silently, which looks exactly like an empty map.
		it('filters by polygon, trusted, over live shops', async () => {
			await resolveBox()

			const filter = companyFind.mock.calls[0][0]

			expect(filter.published).toBe(true)
			expect(filter.deleted[TRUSTED]).toBe(true)
			expect(filter['address.position'][TRUSTED]).toBe(true)
			expect(filter['address.position'].$geoWithin.$geometry.type).toBe('Polygon')
		})

		// No distance is reported, and that is honest: the middle of a viewport is not where the user is,
		// so any distance measured from it would be a plausible wrong number on every marker.
		it('flattens the pin and reports no distance', async () => {
			const { result, query } = await resolveBox({ limit: 5 }, [pin(1)])

			expect(query.limit).toHaveBeenCalledExactlyOnceWith(6)
			expect(companyFind.mock.calls[0][1]).toBe('_id publicName slug address.position')
			expect(result.nodes).toEqual([
				{
					_id: expect.any(Types.ObjectId),
					publicName: 'Shop 1',
					slug: 'shop-1',
					position: { type: 'Point', coordinates: [9.01, 45] }
				}
			])
			expect(result.nodes[0]).not.toHaveProperty('address')
			expect(result.nodes[0]).not.toHaveProperty('distanceMeters')
		})

		it('truncates the same way the radius path does', async () => {
			const { result } = await resolveBox({ limit: 1 }, [pin(1), pin(2)])

			expect(result.truncated).toBe(true)
			expect(result.nodes).toHaveLength(1)
		})

		it('refuses a viewport that wraps the antimeridian before it queries', async () => {
			await expect(companiesNearby.resolve(null, { bbox: { ...bbox, minLng: 10, maxLng: 9 } })).rejects.toThrow(
				'a box crossing the antimeridian is not supported'
			)

			expect(companyFind).not.toHaveBeenCalled()
		})
	})
})

describe('itemCategories', () => {
	// ⚠️ **No pagination, and it is the only public read here without any.** The collection is
	// Admin-curated, capped at two levels and shared platform-wide — a navigation menu, not a data set.
	// Every consumer needs all of it at once, so paginating it means every caller loops to page N to
	// assemble a menu.
	it('answers a non-nullable list of non-nullable categories, with no arguments at all', () => {
		expect(itemCategories.description).toBe('Get the whole item category tree, flat')
		expect(itemCategories.type).toBeInstanceOf(GraphQLNonNull)
		expect((itemCategories.type as GraphQLNonNull<GraphQLList<never>>).ofType).toBeInstanceOf(GraphQLList)
		expect('args' in itemCategories).toBe(false)
	})

	// `deleted` is filtered; `published` is not, because categories have no such flag — a category is not
	// a draft, it exists platform-wide the moment an operator creates it. Soft-deleted rows stay because
	// `item.idCategory` is required and MongoDB has no foreign keys.
	it('filters only the tombstones, and keeps the trusted tag doing it', async () => {
		const rows = [{ _id: new Types.ObjectId(), name: 'Bread', slug: 'bread', position: 1 }]
		itemCategoryFind.mockReturnValueOnce(chain(rows))

		await expect(itemCategories.resolve()).resolves.toBe(rows)

		expect(Object.keys(itemCategoryFind.mock.calls[0][0])).toEqual(['deleted'])
		// The operator *and* its boolean, not just the key: `$exists: true` inverts the filter into
		// "tombstones only" and `{}` drops it entirely, and both leave the key set untouched.
		expect(itemCategoryFind.mock.calls[0][0].deleted.$exists).toBe(false)
		expect(itemCategoryFind.mock.calls[0][0].deleted[TRUSTED]).toBe(true)
		expect(itemCategoryFind.mock.calls[0][1]).toBe('_id idParent name slug position')
	})

	// Sorted by `position` — a **sort ordinal**, not the GeoJSON `position` on `company.address`; the two
	// share a name and nothing else. `_id` breaks the tie so two categories given the same ordinal do not
	// swap places between two reads of the same data.
	it('orders by the curated ordinal, with a stable tie-break', async () => {
		const query = chain([])
		itemCategoryFind.mockReturnValueOnce(query)

		await itemCategories.resolve()

		expect(query.sort).toHaveBeenCalledExactlyOnceWith({ position: 1, _id: 1 })
		expect(query.lean).toHaveBeenCalledOnce()
		expect(query.limit).not.toHaveBeenCalled()
	})
})
