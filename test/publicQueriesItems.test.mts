import { GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql'
import { Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chain, expectTombstoneFilter, live, TRUSTED } from './support/queryChain.mts'

const companyFind = vi.fn()
const companyCountDocuments = vi.fn(async () => 0)
const itemFind = vi.fn()
const itemFindOne = vi.fn()
const itemCountDocuments = vi.fn(async () => 0)
const itemAggregate = vi.fn(async () => [])
const itemCategoryFind = vi.fn()
const liveCompanyBySlug = vi.fn()
const liveItemsAcrossShops = vi.fn(async () => [] as unknown[])

vi.mock('@axiumine/marketplace-common/models/MongoDB/Company', () => ({
	Company: { find: companyFind, countDocuments: companyCountDocuments }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/Item', () => ({
	Item: { find: itemFind, findOne: itemFindOne, countDocuments: itemCountDocuments, aggregate: itemAggregate }
}))
vi.mock('@axiumine/marketplace-common/models/MongoDB/ItemCategory', () => ({
	ItemCategory: { find: itemCategoryFind }
}))
vi.mock('../src/lib/catalogue/liveCompanyBySlug.mts', () => ({ liveCompanyBySlug }))
vi.mock('../src/lib/catalogue/liveItemsAcrossShops.mts', () => ({
	liveItemsAcrossShops,
	MAX_CROSS_SHOP_OFFSET: 2_000,
	OVERFETCH: 3
}))

const LIVE_PLAIN = { published: true, deleted: { $exists: false } }
const MILAN = { lng: 9.1919, lat: 45.4642 }

const idCompany = new Types.ObjectId('507f1f77bcf86cd799439011')
const idCategory = new Types.ObjectId('507f191e810c19729de860ea')
const company = { _id: idCompany, slug: 'mark-boutique', publicName: 'Mark Boutique' }

const item = (n: number) => ({ _id: new Types.ObjectId(), idCategory, name: `Item ${n}`, description: 'x', slug: `item-${n}` })

let GraphQLSitemapKind: (typeof import('../src/graphQLPublic/schema/types/GraphQLSitemapEntry.mts'))['GraphQLSitemapKind']
let items: (typeof import('../src/graphQLPublic/schema/queries/items.mts'))['items']
let itemBySlug: (typeof import('../src/graphQLPublic/schema/queries/itemBySlug.mts'))['itemBySlug']
let searchCompanies: (typeof import('../src/graphQLPublic/schema/queries/search.mts'))['searchCompanies']
let searchItems: (typeof import('../src/graphQLPublic/schema/queries/search.mts'))['searchItems']
let sitemapEntries: (typeof import('../src/graphQLPublic/schema/queries/sitemapEntries.mts'))['sitemapEntries']

beforeEach(async () => {
	vi.clearAllMocks()
	itemCountDocuments.mockResolvedValue(0)
	companyCountDocuments.mockResolvedValue(0)
	itemAggregate.mockResolvedValue([])
	liveItemsAcrossShops.mockResolvedValue([])
	liveCompanyBySlug.mockResolvedValue(company)
	;({ items } = await import('../src/graphQLPublic/schema/queries/items.mts'))
	;({ itemBySlug } = await import('../src/graphQLPublic/schema/queries/itemBySlug.mts'))
	;({ searchCompanies, searchItems } = await import('../src/graphQLPublic/schema/queries/search.mts'))
	;({ sitemapEntries } = await import('../src/graphQLPublic/schema/queries/sitemapEntries.mts'))
	;({ GraphQLSitemapKind } = await import('../src/graphQLPublic/schema/types/GraphQLSitemapEntry.mts'))
})

describe('GraphQLSitemapKind', () => {
	// ⚠️ The three `value`s are what the resolver branches on — `args.kind === 'COMPANY'` compares against
	// this string, not against the member name — so an enum member left without one silently falls
	// through to the CATEGORY branch instead of failing. graphql-js defaults a missing `value` to the
	// member name, which is why the members are asserted by value rather than by name alone.
	it.each([
		['COMPANY', '/shop/:slug'],
		['ITEM', '/shop/:companySlug/item/:slug'],
		['CATEGORY', '/category/:slug and /category/:parentSlug/:slug']
	])('exposes %s, documented with the paths it actually emits', (name, description) => {
		const value = GraphQLSitemapKind.getValue(name)

		expect(value?.value).toBe(name)
		// The description is the only machine-readable statement of what a slice returns, and the
		// sitemap generator is written against it. It is asserted because it is a contract, not a
		// comment: these three strings and the paths built in sitemapEntries.mts must agree.
		expect(value?.description).toBe(description)
	})

	it('publishes exactly those three families', () => {
		expect(GraphQLSitemapKind.getValues().map((v) => v.name)).toEqual(['COMPANY', 'ITEM', 'CATEGORY'])
	})
})

describe('itemBySlug', () => {
	// Two arguments and not one, because `item.slug` is unique **per company**: two shops may both sell a
	// "blue-shirt" without one of them having to call it "blue-shirt-2". The pair is the identifier, and
	// the URL spells it as the pair.
	it('is nullable and identifies an item by the pair that is actually unique', () => {
		expect(itemBySlug.description).toBe('Get one published item by its company slug and its own slug, or null')
		expect(itemBySlug.type).not.toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(itemBySlug.args)).toEqual(['companySlug', 'slug'])
		expect(itemBySlug.args.companySlug.type).toBeInstanceOf(GraphQLNonNull)
		expect(itemBySlug.args.slug.type).toBeInstanceOf(GraphQLNonNull)
	})

	// Two reads in this order and not the other: resolving the shop first enforces the cross-document
	// rule — an item is public only if its company is published too — without a join, and leaves
	// `idCompany` in hand so the item lookup is a single seek on `idCompany_slug_unique`.
	it('resolves the shop first, then seeks the item on the unique pair', async () => {
		const doc = item(1)
		itemFindOne.mockReturnValueOnce(chain(doc))

		await expect(itemBySlug.resolve(null, { companySlug: 'mark-boutique', slug: 'item-1' })).resolves.toEqual({
			...doc,
			companySlug: 'mark-boutique',
			companyPublicName: 'Mark Boutique'
		})

		expect(liveCompanyBySlug).toHaveBeenCalledExactlyOnceWith('mark-boutique')
		expect(itemFindOne).toHaveBeenCalledExactlyOnceWith(
			{ idCompany, slug: 'item-1', ...live },
			'_id idCategory name description slug'
		)
		expect(itemFindOne.mock.calls[0][0].deleted[TRUSTED]).toBe(true)
	})

	// ⚠️ Six distinct states, one response. Unknown shop, unpublished shop, retired shop, unknown item,
	// draft item, deleted item — telling them apart would let anyone enumerate which slugs a competitor
	// has reserved and which of its items are still drafts. The SSR route turns `null` into a real 404.
	it('answers null for a shop that is not live, without reading the item at all', async () => {
		liveCompanyBySlug.mockResolvedValueOnce(null)

		await expect(itemBySlug.resolve(null, { companySlug: 'gone', slug: 'item-1' })).resolves.toBeNull()

		expect(itemFindOne).not.toHaveBeenCalled()
	})

	it('answers the same null for a live shop with no such live item', async () => {
		itemFindOne.mockReturnValueOnce(chain(null))

		await expect(itemBySlug.resolve(null, { companySlug: 'mark-boutique', slug: 'draft' })).resolves.toBeNull()
	})
})

describe('items', () => {
	it('answers a non-nullable page and takes the two selectors plus paging', () => {
		expect(items.description).toBe('Get published items of one company, or of one category across every company')
		expect(items.type).toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(items.args)).toEqual(['companySlug', 'idCategory', 'limit', 'offset'])
		expect(items.args.companySlug.type).toBe(GraphQLString)
		expect(items.args.idCategory.type).toBe(GraphQLID)
		expect(items.args.limit.type).toBe(GraphQLInt)
	})

	// Unbounded "every item on the platform" is not a page the public site ever asks for, and it is the
	// one request that would scan the whole collection.
	it.each([
		['no selector at all', {}],
		['two null selectors', { companySlug: null, idCategory: null }],
		['two empty selectors', { companySlug: '', idCategory: '' }]
	])('refuses %s', async (_desc, args) => {
		await expect(items.resolve(null, args)).rejects.toThrow('Pass companySlug, idCategory, or both')

		expect(liveCompanyBySlug).not.toHaveBeenCalled()
		expect(liveItemsAcrossShops).not.toHaveBeenCalled()
	})

	it('refuses a malformed category id by name, before any query', async () => {
		await expect(items.resolve(null, { idCategory: 'nope' })).rejects.toThrow('idCategory is not a valid id')

		expect(liveItemsAcrossShops).not.toHaveBeenCalled()
	})

	describe('the shop path — exact, because the shop is settled once', () => {
		const resolveShop = async (args: Record<string, unknown> = {}, docs: unknown[] = [], total = 0) => {
			const query = chain(docs)
			itemFind.mockReturnValueOnce(query)
			itemCountDocuments.mockResolvedValueOnce(total)

			return { page: await items.resolve(null, { companySlug: 'mark-boutique', ...args }), query }
		}

		// Sorted by `name` here and by `_id` on the category path, and the split is a cost decision:
		// neither sort is index-backed, but a shop's own catalogue is bounded by what one business sells,
		// while the same blocking sort across a category spans every item on the platform.
		it('pages one shop’s catalogue by name, one document past the window', async () => {
			const { page, query } = await resolveShop({ limit: 2 }, [item(1), item(2), item(3)], 7)

			expect(itemFind).toHaveBeenCalledExactlyOnceWith({ idCompany, ...live }, '_id idCategory name description slug')
			expect(query.sort).toHaveBeenCalledExactlyOnceWith({ name: 1 })
			expect(query.skip).toHaveBeenCalledExactlyOnceWith(0)
			expect(query.limit).toHaveBeenCalledExactlyOnceWith(3)
			expect(page.hasMore).toBe(true)
			expect(page.nodes).toHaveLength(2)
			expect(page.total).toBe(7)
			expect(page.totalIsExact).toBe(true)
		})

		// ⚠️ The overfetch is what makes `hasMore` exact, and the boundary is where it can be wrong in
		// both directions: a full page is *not* evidence of a next one. `>=` here would report more, the
		// page would lose its last document to the pop, and a caller paging on that flag would loop forever
		// over a catalogue whose size happens to be a multiple of its page size.
		it('reports no next page when the window came back exactly full, keeping every document', async () => {
			const { page } = await resolveShop({ limit: 2 }, [item(1), item(2)], 2)

			expect(page.hasMore).toBe(false)
			expect(page.nodes).toHaveLength(2)
		})

		// The shop is already resolved, so its two identity fields are attached here rather than re-read
		// per document — which is what lets one node type serve all three item paths.
		it('stamps the shop’s identity onto every document', async () => {
			const { page } = await resolveShop({}, [item(1)])

			expect(page.nodes[0]).toMatchObject({ companySlug: 'mark-boutique', companyPublicName: 'Mark Boutique' })
		})

		it('narrows by category when both selectors are given, staying on the exact path', async () => {
			await resolveShop({ idCategory: idCategory.toHexString() })

			expect(itemFind.mock.calls[0][0]).toEqual({ idCompany, ...live, idCategory })
			expect(itemCountDocuments.mock.calls[0][0]).toBe(itemFind.mock.calls[0][0])
			expect(liveItemsAcrossShops).not.toHaveBeenCalled()
		})

		// ⚠️ An unknown, unpublished or retired shop is an empty catalogue, not an error — the same
		// non-oracle `companyBySlug` maintains. The route renders its 404 from that query's `null`; this
		// one must not contradict it with a message saying the shop exists but is hidden.
		it('answers an empty page for a shop that is not live, and queries nothing', async () => {
			liveCompanyBySlug.mockResolvedValueOnce(null)

			await expect(items.resolve(null, { companySlug: 'gone' })).resolves.toEqual({
				nodes: [],
				total: 0,
				totalIsExact: true,
				hasMore: false
			})

			expect(itemFind).not.toHaveBeenCalled()
			expect(itemCountDocuments).not.toHaveBeenCalled()
		})

		it('bounds the count at the cap and stops claiming exactness there', async () => {
			const { page } = await resolveShop({}, [], 5_000)

			expect(itemCountDocuments).toHaveBeenCalledExactlyOnceWith({ idCompany, ...live }, { limit: 5_000 })
			expect(page.totalIsExact).toBe(false)
		})

		it('honours the deep-paging cap of the exact path', async () => {
			await expect(items.resolve(null, { companySlug: 'mark-boutique', offset: 10_001 })).rejects.toThrow(
				'offset must not exceed 10000'
			)
		})
	})

	describe('the category path — a join, and honest about it', () => {
		// There is no shop to resolve first, so the company-published check becomes a `$lookup` and
		// inherits every compromise `liveItemsAcrossShops` documents.
		it('walks every shop through the joining pipeline, sorted by _id', async () => {
			liveItemsAcrossShops.mockResolvedValueOnce([item(1), item(2), item(3)])

			const page = await items.resolve(null, { idCategory: idCategory.toHexString(), limit: 2, offset: 40 })

			expect(liveItemsAcrossShops).toHaveBeenCalledExactlyOnceWith({ idCategory }, {}, { _id: 1 }, 40, 3)
			expect(page.hasMore).toBe(true)
			expect(page.nodes).toHaveLength(2)
			expect(liveCompanyBySlug).not.toHaveBeenCalled()
		})

		// Same boundary as the shop path, and it matters more here: the join drops documents, so a page that
		// comes back exactly full is the *common* case rather than the coincidence it is above.
		it('reports no next page on an exactly full window, and keeps both documents', async () => {
			liveItemsAcrossShops.mockResolvedValueOnce([item(1), item(2)])

			const page = await items.resolve(null, { idCategory: idCategory.toHexString(), limit: 2 })

			expect(page.hasMore).toBe(false)
			expect(page.nodes).toHaveLength(2)
		})

		// ⚠️ **Never exact here, and not because of the cap**: this count sees `item.published` and cannot
		// see `company.published`, so it counts items belonging to shops that have gone dark. An upper
		// bound, labelled as one.
		it('reports an inexact total even when the count is far below the cap', async () => {
			itemCountDocuments.mockResolvedValueOnce(3)

			const page = await items.resolve(null, { idCategory: idCategory.toHexString() })

			expect(itemCountDocuments).toHaveBeenCalledExactlyOnceWith({ idCategory, ...live }, { limit: 5_000 })
			expect(page.total).toBe(3)
			expect(page.totalIsExact).toBe(false)
		})

		// A much lower offset cap than the exact path's, and named in the message: every skipped document here
		// is multiplied by OVERFETCH and then fed through a join.
		it('caps paging depth at the cross-shop limit, not the general one', async () => {
			await expect(items.resolve(null, { idCategory: idCategory.toHexString(), offset: 2_001 })).rejects.toThrow(
				'offset must not exceed 2000'
			)

			await expect(items.resolve(null, { idCategory: idCategory.toHexString(), offset: 2_000 })).resolves.toBeDefined()
		})
	})
})

describe('search, the half both fields share', () => {
	// `assertQuery` is one function behind two fields, and these run against both: a `q` that one field
	// refuses and the other accepts is a search page whose two tabs disagree about whether what was
	// typed is a valid query at all.
	const fieldOf = (name: string) => (name === 'searchCompanies' ? searchCompanies : searchItems)

	beforeEach(() => {
		companyFind.mockReturnValue(chain([]))
	})

	it.each([
		['searchCompanies', 'Full-text search over published companies, optionally within a radius'],
		['searchItems', 'Full-text search over published items, optionally within a radius of their shop']
	])('%s answers a non-nullable page and takes q, near, limit and offset', (name, description) => {
		const field = fieldOf(name)

		expect(field.description).toBe(description)
		expect(field.type).toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(field.args)).toEqual(['q', 'near', 'limit', 'offset'])
		expect(field.args.q.type).toBeInstanceOf(GraphQLNonNull)
	})

	it.each([
		['searchCompanies', 'an empty query', ''],
		['searchCompanies', 'a query of spaces', '   '],
		['searchCompanies', 'a query of tabs and newlines', '\t\n '],
		['searchItems', 'an empty query', ''],
		['searchItems', 'a query of spaces', '   '],
		['searchItems', 'a query of tabs and newlines', '\t\n ']
	])('%s refuses %s', async (name, _desc, q) => {
		await expect(fieldOf(name).resolve(null, { q })).rejects.toThrow('q must not be empty')

		expect(companyFind).not.toHaveBeenCalled()
		expect(liveItemsAcrossShops).not.toHaveBeenCalled()
	})

	// ⚠️ Rejected rather than truncated: a text search's cost grows with the number of terms — each one
	// a separate index traversal whose postings are then intersected — so an unbounded `q` is unbounded
	// work requested by an anonymous caller in one small request. Silently searching for a prefix of what
	// was typed would return results the user cannot explain.
	it.each(['searchCompanies', 'searchItems'])(
		'%s accepts a query at the ceiling and refuses one character more',
		async (name) => {
			const field = fieldOf(name)

			await expect(field.resolve(null, { q: 'a'.repeat(120) })).resolves.toBeDefined()
			await expect(field.resolve(null, { q: 'a'.repeat(121) })).rejects.toThrow('q must not exceed 120 characters')
		}
	)

	it.each(['searchCompanies', 'searchItems'])('%s validates the point before it searches anything', async (name) => {
		await expect(fieldOf(name).resolve(null, { q: 'sneaker', near: { lng: 999, lat: 0, radiusMeters: 1 } })).rejects.toThrow(
			'near.lng must be a longitude between -180 and 180'
		)

		expect(companyFind).not.toHaveBeenCalled()
		expect(liveItemsAcrossShops).not.toHaveBeenCalled()
	})
})

describe('searchCompanies', () => {
	const resolveSearch = async (args: Record<string, unknown> = {}, docs: unknown[] = []) => {
		const query = chain(docs)
		companyFind.mockReturnValueOnce(query)

		return { result: await searchCompanies.resolve(null, { q: 'sneaker', ...args }), query }
	}

	it('searches the trimmed query, ranked by the collection’s own relevance', async () => {
		const shops = [{ _id: idCompany, publicName: 'Mark Boutique' }]
		const { result, query } = await resolveSearch({ q: '  sneaker  ' }, shops)

		expect(companyFind.mock.calls[0][0].$text.$search).toBe('sneaker')
		expect(companyFind.mock.calls[0][1]).toBe('_id publicName slug description address')
		expect(query.sort).toHaveBeenCalledExactlyOnceWith({ score: { $meta: 'textScore' } })
		expect(result.nodes).toEqual(shops)
	})

	// ⚠️ `trusted()` on the `Query` filter. `sanitizeFilter` would rewrite both `$text` and the
	// `$geoWithin` on `address.position` into equality tests against literal objects — filters that match
	// nothing, silently, and read as "no results".
	it('tags every admin in the filter it hands mongoose', async () => {
		await resolveSearch({ near: { ...MILAN, radiusMeters: 5_000 } })

		const filter = companyFind.mock.calls[0][0]

		expect(filter.$text[TRUSTED]).toBe(true)
		expect(filter.deleted[TRUSTED]).toBe(true)
		expect(filter['address.position'][TRUSTED]).toBe(true)
		expect(filter.published).toBe(true)
	})

	// ⚠️ `$geoWithin`/`$centerSphere` rather than `$near`, because a query may have exactly one sort and
	// a text search's sort is its relevance. MongoDB refuses the `$text` + `$near` combination outright;
	// a pure predicate composes. The trade-off is accepted: within the radius, a closer shop does not
	// outrank a better-matching one.
	it('bounds by radius with a predicate that does not sort', async () => {
		await resolveSearch({ near: { ...MILAN, radiusMeters: 5_000 } })

		const geo = companyFind.mock.calls[0][0]['address.position']

		expect(geo.$geoWithin.$centerSphere[0]).toEqual([9.1919, 45.4642])
		expect(geo.$geoWithin.$centerSphere[1]).toBeCloseTo(5_000 / 6_378_100, 12)
	})

	it('leaves the filter unbounded when no point is given', async () => {
		await resolveSearch()

		expect(companyFind.mock.calls[0][0]).not.toHaveProperty('address.position')
	})

	// The count carries the whole filter, geo bound included, so it is the same population the page is a
	// window on — and it is issued with the cap, so the server stops walking at COUNT_CAP matches.
	it('counts the same filter it searched, bounded by the cap', async () => {
		await resolveSearch({ near: { ...MILAN, radiusMeters: 5_000 } })

		expect(companyCountDocuments).toHaveBeenCalledExactlyOnceWith(companyFind.mock.calls[0][0], { limit: 5_000 })
	})

	// ⚠️ `total` is capped, so `totalIsExact` is what says whether it is the answer or the cap. The
	// boundary is asserted from both sides: a collection holding exactly COUNT_CAP matches reports
	// inexact, because the count stopped there and cannot know there was no 5001st.
	it.each([
		[4_999, true],
		[5_000, false]
	])('reports a total of %i as exact: %s', async (total, exact) => {
		companyCountDocuments.mockResolvedValueOnce(total)

		const { result } = await resolveSearch()

		expect(result.total).toBe(total)
		expect(result.totalIsExact).toBe(exact)
	})

	// `limit + 1` rather than deriving "is there another page" from `total`, which is capped: past the
	// cap the derived answer would truncate the result set at whatever COUNT_CAP happens to be. The
	// extra document is dropped before it is returned.
	it.each([
		['a full page and one more', 3, true, 2],
		['exactly a full page', 2, false, 2]
	])('fetches one past the window and reports %s', async (_label, fetched, hasMore, kept) => {
		const shops = Array.from({ length: fetched }, (_, n) => ({ _id: new Types.ObjectId(), publicName: `Shop ${n}` }))

		const { result, query } = await resolveSearch({ limit: 2 }, shops)

		expect(query.limit).toHaveBeenCalledExactlyOnceWith(3)
		expect(result.hasMore).toBe(hasMore)
		expect(result.nodes).toHaveLength(kept)
	})

	it('clamps the page size and defaults it to one screen', async () => {
		const { query } = await resolveSearch({ limit: 500 })
		expect(query.limit).toHaveBeenCalledExactlyOnceWith(61)

		const { query: unspecified } = await resolveSearch()
		expect(unspecified.limit).toHaveBeenCalledExactlyOnceWith(25)
	})

	// ⚠️ Bounded by the ordinary `MAX_OFFSET`: this is a single-collection query, so a skipped document
	// costs one index entry, exactly as it does on `/shops`. Past the cap it throws rather than clamping —
	// silently serving page 10 000 to a caller who asked for page 20 000 is how a crawler indexes the same
	// shops under 10 000 URLs.
	it('pages by offset, normalises a negative one and refuses one past the cap', async () => {
		const { query } = await resolveSearch({ offset: 48 })
		expect(query.skip).toHaveBeenCalledExactlyOnceWith(48)

		const { query: negative } = await resolveSearch({ offset: -1 })
		expect(negative.skip).toHaveBeenCalledExactlyOnceWith(0)

		await expect(resolveSearch({ offset: 10_000 })).resolves.toBeDefined()
		await expect(searchCompanies.resolve(null, { q: 'sneaker', offset: 10_001 })).rejects.toThrow('offset must not exceed 10000')
	})
})

describe('searchItems', () => {
	const resolveSearch = async (args: Record<string, unknown> = {}) => await searchItems.resolve(null, { q: 'sneaker', ...args })

	// ⚠️ The pipeline's `$match` is spelled plainly. Aggregation stages never pass through
	// `sanitizeFilter`, and a `trusted()` wrapper inside one is an unknown object the server rejects.
	it('hands the join a plain text match and a plain geo bound', async () => {
		await resolveSearch({ q: '  sneaker  ', near: { ...MILAN, radiusMeters: 5_000 } })

		const companyMatch = liveItemsAcrossShops.mock.calls[0][1]

		expect(liveItemsAcrossShops.mock.calls[0][0]).toEqual({ $text: { $search: 'sneaker' } })
		expect(Object.getOwnPropertySymbols(liveItemsAcrossShops.mock.calls[0][0].$text)).toHaveLength(0)
		expect(companyMatch['address.position'].$geoWithin.$centerSphere[1]).toBeCloseTo(5_000 / 6_378_100, 12)
		expect(Object.getOwnPropertySymbols(companyMatch['address.position'])).toHaveLength(0)
		expect(liveItemsAcrossShops.mock.calls[0][2]).toEqual({ score: { $meta: 'textScore' } })
	})

	// An item has no coordinates and inherits its shop's, so the radius travels into the `$lookup`
	// sub-pipeline where that company is already being fetched and checked.
	it('leaves the company match empty when no point is given', async () => {
		await resolveSearch()

		expect(liveItemsAcrossShops.mock.calls[0][1]).toEqual({})
	})

	it('returns what came back through the join, ranked by relevance', async () => {
		const hits = [item(1)]
		liveItemsAcrossShops.mockResolvedValueOnce(hits)

		await expect(resolveSearch()).resolves.toMatchObject({ nodes: hits, hasMore: false })
	})

	// ⚠️ Never exact, and not because of the cap: the count runs on `item` alone, where it can see
	// neither `company.published` nor the radius — both live in the other collection and no count can
	// join. An upper bound, honestly labelled.
	it.each([[0], [7], [5_000]])('counts %i live items and still refuses to call the total exact', async (total) => {
		itemCountDocuments.mockResolvedValueOnce(total)

		const result = await resolveSearch({ near: { ...MILAN, radiusMeters: 5_000 } })

		const filter = itemCountDocuments.mock.calls[0][0]

		// The radius is deliberately absent here: it lives on `company`, and this count cannot join.
		// That absence is half of why the total is never reported exact.
		expect(Object.keys(filter)).toEqual(['$text', 'published', 'deleted'])
		expect(filter.$text.$search).toBe('sneaker')
		expect(filter.$text[TRUSTED]).toBe(true)
		expect(filter.published).toBe(true)
		expect(filter.deleted[TRUSTED]).toBe(true)
		expect(itemCountDocuments.mock.calls[0][1]).toEqual({ limit: 5_000 })
		expect(result.total).toBe(total)
		expect(result.totalIsExact).toBe(false)
	})

	// `hasMore` comes from documents that went through the join, which is what keeps it exact while the
	// count beside it is only an upper bound.
	it.each([
		['a full page and one more', 3, true, 2],
		['exactly a full page', 2, false, 2]
	])('fetches one past the window and reports %s', async (_label, fetched, hasMore, kept) => {
		liveItemsAcrossShops.mockResolvedValueOnce(Array.from({ length: fetched }, (_, n) => item(n)))

		const result = await resolveSearch({ limit: 2 })

		expect(liveItemsAcrossShops.mock.calls[0][4]).toBe(3)
		expect(result.hasMore).toBe(hasMore)
		expect(result.nodes).toHaveLength(kept)
	})

	it('clamps the page size and defaults it to one screen', async () => {
		await resolveSearch({ limit: 500 })
		expect(liveItemsAcrossShops.mock.calls[0][4]).toBe(61)

		await resolveSearch()
		expect(liveItemsAcrossShops.mock.calls[1][4]).toBe(25)
	})

	// ⚠️ Bounded by `MAX_CROSS_SHOP_OFFSET`, not by `MAX_OFFSET`. Every skipped document here is
	// multiplied by `OVERFETCH` and then fed through a join, so depth costs several times what it costs
	// on the company half.
	it('pages by offset, normalises a negative one and refuses one past the tighter cross-shop cap', async () => {
		await resolveSearch({ offset: 48 })
		expect(liveItemsAcrossShops.mock.calls[0][3]).toBe(48)

		await resolveSearch({ offset: -1 })
		expect(liveItemsAcrossShops.mock.calls[1][3]).toBe(0)

		await expect(resolveSearch({ offset: 2_000 })).resolves.toBeDefined()
		await expect(resolveSearch({ offset: 2_001 })).rejects.toThrow('offset must not exceed 2000')
	})
})

describe('sitemapEntries', () => {
	const facet = (docs: unknown[], scanned?: number, maxId?: Types.ObjectId) => [
		{
			docs,
			scanned: scanned === undefined ? [] : [{ n: scanned }],
			tail: maxId ? [{ maxId }] : []
		}
	]

	it('answers a non-nullable page keyed by kind, with a cursor and a limit', () => {
		expect(sitemapEntries.description).toBe('Get crawlable paths of one kind, keyset paginated by _id')
		expect(sitemapEntries.type).toBeInstanceOf(GraphQLNonNull)
		expect(Object.keys(sitemapEntries.args)).toEqual(['kind', 'afterId', 'limit'])
		expect(sitemapEntries.args.kind.type).toBeInstanceOf(GraphQLNonNull)
		expect(sitemapEntries.args.afterId.type).toBe(GraphQLID)
		expect(sitemapEntries.args.limit.type).toBe(GraphQLInt)
	})

	// Much larger than the listing page sizes because the caller is a sitemap generator, not a browser: a
	// shard holds up to 50 000 `<url>` elements and every extra round trip is a full request.
	it.each([
		['the default slice', undefined, 1_000],
		['a caller’s own slice', 500, 500],
		['zero, raised to one', 0, 1],
		['a negative slice, raised to one', -5, 1],
		['a slice past the ceiling', 10_000, 2_000]
	])('walks %s', async (_desc, limit, expected) => {
		const query = chain([])
		companyFind.mockReturnValueOnce(query)

		await sitemapEntries.resolve(null, { kind: 'COMPANY', limit })

		expect(query.limit).toHaveBeenCalledExactlyOnceWith(expected)
	})

	it('refuses a malformed cursor by name', async () => {
		await expect(sitemapEntries.resolve(null, { kind: 'COMPANY', afterId: 'nope' })).rejects.toThrow('afterId is not a valid id')

		expect(companyFind).not.toHaveBeenCalled()
	})

	describe('COMPANY', () => {
		// ⚠️ **Keyset paginated by `_id`, and it is the one caller that had to be.** A sitemap walks the
		// entire collection by definition — the workload `MAX_OFFSET` refuses: at half a million shops the
		// last page of a `skip` walk discards half a million index entries and the whole file costs O(n²).
		// It is also more correct under concurrent writes: a shop created mid-walk gets a larger `_id` and
		// lands on a later page, where an offset walk would shift every remaining page and drop a document.
		it('resumes from the cursor, trusted, and emits site-relative paths', async () => {
			const docs = [{ _id: idCompany, slug: 'mark-boutique' }]
			const query = chain(docs)
			companyFind.mockReturnValueOnce(query)

			const page = await sitemapEntries.resolve(null, { kind: 'COMPANY', afterId: idCompany.toHexString(), limit: 1 })

			expect(companyFind.mock.calls[0][0]._id[TRUSTED]).toBe(true)
			expect(companyFind.mock.calls[0][0]._id.$gt).toEqual(idCompany)
			expect(companyFind.mock.calls[0][0].published).toBe(true)
			expect(companyFind.mock.calls[0][1]).toBe('_id slug')
			expect(query.sort).toHaveBeenCalledExactlyOnceWith({ _id: 1 })
			// Paths come back site-relative: this service does not know the customer domain, and a backend
			// that guesses the origin writes a sitemap full of URLs pointing at the wrong environment.
			expect(page.nodes).toEqual([{ path: '/shop/mark-boutique' }])
			expect(page.nextAfterId).toEqual(idCompany)
		})

		it('starts from the beginning when no cursor is given', async () => {
			companyFind.mockReturnValueOnce(chain([]))

			await sitemapEntries.resolve(null, { kind: 'COMPANY' })

			expect(Object.keys(companyFind.mock.calls[0][0])).toEqual(['published', 'deleted'])
		})

		// Nothing is dropped after the fetch on this walk, so a short page really does mean the end.
		it('stops the walk on a short page', async () => {
			companyFind.mockReturnValueOnce(chain([{ _id: idCompany, slug: 'mark-boutique' }]))

			const page = await sitemapEntries.resolve(null, { kind: 'COMPANY', limit: 2 })

			expect(page.nextAfterId).toBeNull()
		})
	})

	describe('ITEM', () => {
		// ⚠️ The only walk whose returned documents are fewer than its scanned documents, and `$facet` is what keeps
		// the pagination exact through that filter: both branches see the same already-sorted,
		// already-limited window, so `scanned` reports how many documents were consumed and `maxId` where the
		// walk stopped — regardless of how many survived the join. Deriving the cursor from the survivors
		// would stall the walk on any window whose items all belong to unpublished shops.
		it('scans a window, joins the shop, and carries the cursor from the scan', async () => {
			const maxId = new Types.ObjectId()
			itemAggregate.mockResolvedValueOnce(facet([{ slug: 'sneaker', companySlug: 'mark-boutique' }], 2, maxId))

			const page = await sitemapEntries.resolve(null, { kind: 'ITEM', limit: 2 })
			const pipeline = itemAggregate.mock.calls[0][0]

			expect(pipeline[0]).toEqual({ $match: LIVE_PLAIN })
			expect(pipeline[1]).toEqual({ $sort: { _id: 1 } })
			expect(pipeline[2]).toEqual({ $limit: 2 })
			expect(pipeline[3].$facet.docs[0].$lookup).toMatchObject({
				from: 'company',
				localField: 'idCompany',
				foreignField: '_id',
				as: 'company',
				pipeline: [{ $match: LIVE_PLAIN }, { $project: { slug: 1 } }]
			})
			// No `preserveNullAndEmptyArrays` — the dropping IS the company-published check.
			expect(pipeline[3].$facet.docs[1]).toEqual({ $unwind: '$company' })
			// `_id: 0` because the cursor comes from the `tail` branch and a projected `_id` would only
			// travel back over the wire; `companySlug` is lifted out of the joined document because the
			// path needs both slugs and nothing downstream should have to know a `$lookup` happened.
			expect(pipeline[3].$facet.docs[2]).toEqual({ $project: { _id: 0, slug: 1, companySlug: '$company.slug' } })
			expect(pipeline[3].$facet.scanned).toEqual([{ $count: 'n' }])
			expect(pipeline[3].$facet.tail).toEqual([{ $group: { _id: null, maxId: { $max: '$_id' } } }])
			expect(page.nodes).toEqual([{ path: '/shop/mark-boutique/item/sneaker' }])
			expect(page.nextAfterId).toBe(maxId)
		})

		// The cursor is a plain `$gt` here: aggregation stages never pass through `sanitizeFilter`, so a
		// `trusted()` wrapper would be an unknown object the server rejects — the inverse of the `find`
		// paths above.
		it('spells its cursor plainly inside the pipeline', async () => {
			itemAggregate.mockResolvedValueOnce(facet([], 0))

			await sitemapEntries.resolve(null, { kind: 'ITEM', afterId: idCompany.toHexString() })

			const match = itemAggregate.mock.calls[0][0][0].$match

			expect(match._id).toEqual({ $gt: idCompany })
			expect(Object.getOwnPropertySymbols(match._id)).toHaveLength(0)
			expect(Object.getOwnPropertySymbols(match.deleted)).toHaveLength(0)
		})

		// ⚠️ Do not stop on a short page: this walk returns fewer documents than it scanned whenever an item's
		// shop is unpublished, so a short page is normal and says nothing about being finished.
		it('keeps walking when the join dropped documents but the window was full', async () => {
			const maxId = new Types.ObjectId()
			itemAggregate.mockResolvedValueOnce(facet([], 3, maxId))

			const page = await sitemapEntries.resolve(null, { kind: 'ITEM', limit: 3 })

			expect(page.nodes).toEqual([])
			expect(page.nextAfterId).toBe(maxId)
		})

		it('stops when the scan itself came up short', async () => {
			itemAggregate.mockResolvedValueOnce(facet([{ slug: 'sneaker', companySlug: 'mark-boutique' }], 1))

			const page = await sitemapEntries.resolve(null, { kind: 'ITEM', limit: 3 })

			expect(page.nextAfterId).toBeNull()
		})

		// `$count` emits no document at all for an empty window, so the `?? 0` is the difference between
		// ending the walk and reading `n` off `undefined`.
		it('ends the walk on an empty window, where $count emits nothing', async () => {
			itemAggregate.mockResolvedValueOnce(facet([]))

			const page = await sitemapEntries.resolve(null, { kind: 'ITEM', limit: 3 })

			expect(page.nodes).toEqual([])
			expect(page.nextAfterId).toBeNull()
		})
	})

	describe('CATEGORY', () => {
		const parentId = new Types.ObjectId()

		it('emits a top-level category at the short path and never reads a parent', async () => {
			const query = chain([{ _id: idCategory, slug: 'bread' }])
			itemCategoryFind.mockReturnValueOnce(query)

			const page = await sitemapEntries.resolve(null, { kind: 'CATEGORY', limit: 1 })

			expect(page.nodes).toEqual([{ path: '/category/bread' }])
			expect(page.nextAfterId).toEqual(idCategory)
			expect(itemCategoryFind).toHaveBeenCalledOnce()
			expectTombstoneFilter(itemCategoryFind.mock.calls[0][0])
			expect(itemCategoryFind.mock.calls[0][1]).toBe('_id slug idParent')
			// Sorted by `_id` because the cursor IS the `_id`: without this sort the walk resumes from
			// whatever document happened to come last, and documents below it are never emitted.
			expect(query.sort).toHaveBeenCalledExactlyOnceWith({ _id: 1 })
		})

		// The second read resolves the parents of *this page only* — bounded by the page, not by the
		// collection — and filters them for liveness in the same query.
		it('resolves the parents of this page to build the nested path', async () => {
			itemCategoryFind
				.mockReturnValueOnce(chain([{ _id: idCategory, slug: 'sourdough', idParent: parentId }]))
				.mockReturnValueOnce(chain([{ _id: parentId, slug: 'bread' }]))

			const page = await sitemapEntries.resolve(null, { kind: 'CATEGORY', limit: 1 })

			expect(itemCategoryFind).toHaveBeenCalledTimes(2)
			expect(itemCategoryFind.mock.calls[1][0]._id[TRUSTED]).toBe(true)
			expect(itemCategoryFind.mock.calls[1][0]._id.$in).toEqual([parentId])
			expect(itemCategoryFind.mock.calls[1][1]).toBe('_id slug')
			expect(page.nodes).toEqual([{ path: '/category/bread/sourdough' }])
		})

		// ⚠️ A subcategory whose parent has been soft-deleted is dropped rather than emitted under a dead
		// segment: its URL cannot be built without a parent slug, and `/category/undefined/x` in a sitemap
		// is worse than nothing. The page is then short, which is why the cursor comes from the scanned
		// documents here too.
		it('drops an orphan rather than writing an undefined segment, and still advances', async () => {
			itemCategoryFind
				.mockReturnValueOnce(
					chain([
						{ _id: idCategory, slug: 'sourdough', idParent: parentId },
						{ _id: idCompany, slug: 'bread', idParent: undefined }
					])
				)
				.mockReturnValueOnce(chain([]))

			const page = await sitemapEntries.resolve(null, { kind: 'CATEGORY', limit: 2 })

			expect(page.nodes).toEqual([{ path: '/category/bread' }])
			expect(page.nextAfterId).toEqual(idCompany)
		})

		it('resumes from its cursor, trusted, and stops on a short page', async () => {
			itemCategoryFind.mockReturnValueOnce(chain([{ _id: idCategory, slug: 'bread' }]))

			const page = await sitemapEntries.resolve(null, { kind: 'CATEGORY', afterId: idCompany.toHexString(), limit: 5 })

			expect(itemCategoryFind.mock.calls[0][0]._id[TRUSTED]).toBe(true)
			expect(itemCategoryFind.mock.calls[0][0]._id.$gt).toEqual(idCompany)
			expect(page.nextAfterId).toBeNull()
		})
	})
})
