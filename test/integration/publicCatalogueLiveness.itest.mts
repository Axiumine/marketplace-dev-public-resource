import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import { ENCRYPTED_FIELDS_COMPANY, KEY_ALT_NAME_COMPANY } from '@axiumine/marketplace-common/encryption/encryptedFields'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import QueriesPublic from '../../src/graphQLPublic/schema/queries.mts'
import { ENDPOINT, start } from '../../src/index.mts'

/****************************************************************************************
 * Every public read, driven against a database that holds a draft and a deleted row of each
 * kind — RISK_REGISTER **R58**.
 *
 * ## Why this file exists next to `test/publicCatalogueFilter.test.mts`
 *
 * That suite proves a *shape*: every function reading `Company` or `Item` names `livePublic()` or
 * `LIVE_PUBLIC_PIPELINE` in its own body. It is a structural check and it cannot see what the value
 * does after it is named — a filter built and then shadowed by a later spread, or a `livePublic()`
 * called and dropped, satisfies it while anonymous traffic reads drafts. R18 closed on the name
 * being present; R58 is the half that needs the value followed.
 *
 * Nothing static follows it, so this file follows it the only way left: the rows exist, the queries
 * run, and the drafts must not come back. Each `it` asserts the *absence* of a document the seed
 * put there on purpose, and the presence of its published sibling — a filter that stopped filtering
 * fails the first half, and a filter that matches nothing at all fails the second, so neither
 * direction can pass quietly.
 *
 * ## The seed
 *
 * One shop published, one still a draft, one soft-deleted; under the published shop one item of
 * each; and one *published* item under the *draft* shop, which is the cross-document AND that
 * `liveItemsAcrossShops` exists for and the one no single-collection predicate can express.
 *
 * ⚠️ **The rows are read back through the raw driver before anything is asserted about a query.**
 * A seed the validator rejected would leave every "the draft does not answer" assertion passing for
 * the wrong reason, which is precisely the failure this file is written to catch elsewhere.
 *
 * ⚠️ **Scoped by construction, not by cleanup.** The throwaway database also holds whatever
 * `marketplace-db-setup`'s demo migration seeds, so every assertion is either scoped to a value
 * unique to this run — its own city, its own category, its own search token, its own shop slug — or
 * is a membership test over a full listing. No assertion counts rows it did not create.
 ****************************************************************************************/

dotenv.config()

/** Unique to this run, and a legal slug segment: 32 lowercase hex characters. */
const RUN = randomUUID().replace(/-/g, '')

/** `companies(city:)` is an equality match, so a city nothing else uses isolates the listing. */
const CITY = `Liveness ${RUN}`

/**
 * Both text indexes cover a `description`, so one token dropped in every seeded description is
 * enough to isolate `searchCompanies` and `searchItems` from the demo rows. Hex survives the
 * english stemmer unchanged.
 */
const TOKEN = RUN

/**
 * Christchurch, New Zealand — chosen because the demo seed's one company sits in New York, so the
 * bounding box below contains this run's shops and nothing else. `companiesNearby` is still
 * asserted by membership rather than by an exact list: coordinates are the one axis a future
 * fixture could collide on without meaning to.
 */
const LNG = 172.6362
const LAT = -43.5321
const BBOX = { minLng: LNG - 0.05, minLat: LAT - 0.05, maxLng: LNG + 0.05, maxLat: LAT + 0.05 }

const slugOf = (what: string) => `liveness-${RUN}-${what}`

/**
 * `vatNumber_unique` and `certifiedEmail_unique` are global and carry no partial filter, so the three
 * shops need three of each — a soft-deleted shop keeps holding its keys, which is the whole point of
 * those two indexes having no `partialFilterExpression`. Eleven characters, from this run's token.
 */
const VAT_STEM = `${RUN.replace(/\D/g, '')}0000000000`.slice(0, 10)

const COMPANY_LIVE = slugOf('shop-live')
const COMPANY_DRAFT = slugOf('shop-draft')
const COMPANY_GONE = slugOf('shop-gone')
const ITEM_LIVE = slugOf('item-live')
const ITEM_DRAFT = slugOf('item-draft')
const ITEM_GONE = slugOf('item-gone')
const ITEM_IN_DRAFT_SHOP = slugOf('item-in-draft-shop')
const CATEGORY_LIVE = slugOf('cat-live')
const CATEGORY_GONE = slugOf('cat-gone')

let httpServer: Server
let base: string

const seeded: Array<{ collection: 'company' | 'item' | 'itemCategory'; _id: mongoose.Types.ObjectId }> = []

const idCategory = new mongoose.Types.ObjectId()
const idCategoryGone = new mongoose.Types.ObjectId()
const idCompanyLive = new mongoose.Types.ObjectId()
const idCompanyDraft = new mongoose.Types.ObjectId()
const idCompanyGone = new mongoose.Types.ObjectId()

function db() {
	return mongoose.connection.db!
}

/** Every node below is read for its slug and nothing else — the slug is what says which fixture it is. */
type Slugged = { slug: string }

/** The two page types the catalogue returns, as far as this file reads them. */
type Page<T> = { nodes: T[]; total: number; totalIsExact: boolean }

/** POST a GraphQL document to the real endpoint and return the parsed body. */
async function gql<T>(query: string, variables?: Record<string, unknown>) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	})

	return (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
}

/**
 * Fail loudly on a GraphQL error rather than letting `undefined` read as "the draft is hidden" — an
 * absence assertion passes against an errored response, which is the one way this whole file could be
 * green and prove nothing.
 */
async function data<T>(query: string, variables?: Record<string, unknown>) {
	const body = await gql<T>(query, variables)

	expect(body.errors, JSON.stringify(body.errors)).toBeUndefined()

	return body.data!
}

async function insert(collection: 'company' | 'item' | 'itemCategory', document: Record<string, unknown>) {
	await db().collection(collection).insertOne(document)
	seeded.push({ collection, _id: document._id as mongoose.Types.ObjectId })
}

/**
 * Inserted with the raw driver, the platform seeding convention (MC-23): the document is shaped by
 * the collection's own `$jsonSchema` and by nothing the model happens to believe today.
 *
 * ⚠️ `contactPerson` and `administrator` are `binData` subtype 6 in this collection (ADR-029), so a
 * plaintext seed is refused outright by the validator. They go through the same key the resolvers
 * would decrypt with — no public query reads either field, which is the point of encrypting them.
 */
async function seedCompany(_id: mongoose.Types.ObjectId, slug: string, nth: number, extra: Record<string, unknown>) {
	await insert(
		'company',
		await encryptDocument(
			{
				_id,
				idShopOwner: new mongoose.Types.ObjectId(),
				legalName: `Liveness ${RUN} Ltd`,
				vatNumber: `${VAT_STEM}${nth}`,
				contactPerson: 'Itest Contact',
				administrator: 'Itest Administrator',
				certifiedEmail: `itest-${RUN}-${nth}@marketplace.invalid`,
				registryExtract: 'itest registry extract',
				address: {
					street: '1 Liveness Street',
					postalCode: '80122',
					city: CITY,
					province: 'NZ',
					position: { type: 'Point', coordinates: [LNG, LAT] }
				},
				publicName: `Liveness Shop ${RUN}`,
				slug,
				description: `A shop seeded by the R58 liveness suite. ${TOKEN}`,
				...extra
			},
			ENCRYPTED_FIELDS_COMPANY,
			KEY_ALT_NAME_COMPANY
		)
	)
}

async function seedItem(idCompany: mongoose.Types.ObjectId, slug: string, extra: Record<string, unknown>) {
	await insert('item', {
		_id: new mongoose.Types.ObjectId(),
		idCompany,
		idCategory,
		name: `Liveness Item ${RUN}`,
		description: `An item seeded by the R58 liveness suite. ${TOKEN}`,
		slug,
		...extra
	})
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`

	await insert('itemCategory', { _id: idCategory, name: `Liveness ${RUN}`, slug: CATEGORY_LIVE, position: 900 })
	await insert('itemCategory', {
		_id: idCategoryGone,
		name: `Liveness gone ${RUN}`,
		slug: CATEGORY_GONE,
		position: 901,
		deleted: new Date()
	})

	await seedCompany(idCompanyLive, COMPANY_LIVE, 1, { published: true })
	await seedCompany(idCompanyDraft, COMPANY_DRAFT, 2, { published: false })
	await seedCompany(idCompanyGone, COMPANY_GONE, 3, { published: true, deleted: new Date() })

	await seedItem(idCompanyLive, ITEM_LIVE, { published: true })
	await seedItem(idCompanyLive, ITEM_DRAFT, { published: false })
	await seedItem(idCompanyLive, ITEM_GONE, { published: true, deleted: new Date() })
	await seedItem(idCompanyDraft, ITEM_IN_DRAFT_SHOP, { published: true })
})

afterAll(async () => {
	for (const { collection, _id } of seeded) {
		try {
			await db().collection(collection).deleteOne({ _id })
		} catch (error) {
			console.error(`[afterAll] cleanup failed for ${collection} ${_id.toString()}:`, error)
		}
	}
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

/** Every public read this file drives, one `describe` each. */
const COVERED = [
	'companies',
	'companyBySlug',
	'companiesNearby',
	'items',
	'itemBySlug',
	'itemCategories',
	'searchCompanies',
	'searchItems',
	'sitemapEntries'
]

/** The two demo queries, which read no collection and so have no liveness to check. */
const NOT_A_CATALOGUE_READ = ['publicHelloNoArgs', 'publicHelloArgs']

describe('the public read surface', () => {
	it('is covered field for field, so a tenth read cannot be added without seeding a draft for it', () => {
		expect(Object.keys(QueriesPublic.getFields()).sort()).toEqual([...COVERED, ...NOT_A_CATALOGUE_READ].sort())
	})
})

describe('the seed itself (integration, real MongoDB)', () => {
	it('put all nine documents on disk, so an empty answer below is a filter and not a rejected insert', async () => {
		const [companies, items, categories] = await Promise.all([
			db()
				.collection('company')
				.find({ slug: { $in: [COMPANY_LIVE, COMPANY_DRAFT, COMPANY_GONE] } })
				.toArray(),
			db()
				.collection('item')
				.find({ slug: { $in: [ITEM_LIVE, ITEM_DRAFT, ITEM_GONE, ITEM_IN_DRAFT_SHOP] } })
				.toArray(),
			db()
				.collection('itemCategory')
				.find({ slug: { $in: [CATEGORY_LIVE, CATEGORY_GONE] } })
				.toArray()
		])

		expect(companies).toHaveLength(3)
		expect(items).toHaveLength(4)
		expect(categories).toHaveLength(2)
	})
})

describe('companies: the shop listing answers with published, undeleted shops only', () => {
	const query = `query ($city: String!) {
		companies(city: $city, limit: 60) { nodes { slug } total totalIsExact }
	}`

	it('returns the live shop and neither the draft nor the deleted one', async () => {
		const { companies } = await data<{ companies: Page<Slugged> }>(query, { city: CITY })

		expect(companies.nodes.map((node) => node.slug)).toEqual([COMPANY_LIVE])
	})

	it('counts what it returns: the draft and the deleted shop are outside `total` as well', async () => {
		const { companies } = await data<{ companies: Page<Slugged> }>(query, { city: CITY })

		expect(companies.total).toBe(1)
		expect(companies.totalIsExact).toBe(true)
	})
})

describe('companyBySlug: a draft shop and a deleted shop are both 404, not 403', () => {
	const query = `query ($slug: String!) { companyBySlug(slug: $slug) { slug } }`

	it('answers the live shop', async () => {
		const { companyBySlug } = await data<{ companyBySlug: Slugged | null }>(query, { slug: COMPANY_LIVE })

		expect(companyBySlug).toEqual({ slug: COMPANY_LIVE })
	})

	it('answers null for the draft shop', async () => {
		expect((await data<{ companyBySlug: Slugged | null }>(query, { slug: COMPANY_DRAFT })).companyBySlug).toBeNull()
	})

	it('answers null for the deleted shop', async () => {
		expect((await data<{ companyBySlug: Slugged | null }>(query, { slug: COMPANY_GONE })).companyBySlug).toBeNull()
	})
})

describe('companiesNearby: the map island plots no drafts', () => {
	const query = `query ($bbox: GraphQLInputBoundingBox!) {
		companiesNearby(bbox: $bbox, limit: 60) { nodes { slug } }
	}`

	it('plots the live shop and drops the other two, which share its coordinates exactly', async () => {
		const { companiesNearby } = await data<{ companiesNearby: { nodes: Slugged[] } }>(query, { bbox: BBOX })
		const slugs = companiesNearby.nodes.map((node) => node.slug)

		expect(slugs).toContain(COMPANY_LIVE)
		expect(slugs).not.toContain(COMPANY_DRAFT)
		expect(slugs).not.toContain(COMPANY_GONE)
	})
})

describe('items: a shop catalogue, and a category across shops', () => {
	const byShop = `query ($companySlug: String!) {
		items(companySlug: $companySlug, limit: 60) { nodes { slug } total }
	}`

	it('serves the live item of the live shop, and neither its draft nor its deleted sibling', async () => {
		const { items } = await data<{ items: Page<Slugged> }>(byShop, { companySlug: COMPANY_LIVE })

		expect(items.nodes.map((node) => node.slug)).toEqual([ITEM_LIVE])
		expect(items.total).toBe(1)
	})

	it('serves an empty catalogue for the draft shop rather than the item it really holds', async () => {
		const { items } = await data<{ items: Page<Slugged> }>(byShop, { companySlug: COMPANY_DRAFT })

		expect(items.nodes).toEqual([])
		expect(items.total).toBe(0)
	})

	it('drops the published item of an unpublished shop from a category listing', async () => {
		const { items } = await data<{ items: Page<Slugged & { companySlug: string }> }>(
			`query ($idCategory: ID!) {
				items(idCategory: $idCategory, limit: 60) { nodes { slug companySlug } totalIsExact }
			}`,
			{ idCategory: idCategory.toString() }
		)

		expect(items.nodes.map((node) => node.slug)).toEqual([ITEM_LIVE])
		// The count behind this listing sees `item.published` and cannot see `company.published`, so
		// it is an upper bound and says so. `nodes` is the answer; `total` is labelled inexact.
		expect(items.totalIsExact).toBe(false)
	})
})

type ItemBySlug = { itemBySlug: Slugged | null }

describe('itemBySlug: the item detail page', () => {
	const query = `query ($companySlug: String!, $slug: String!) {
		itemBySlug(companySlug: $companySlug, slug: $slug) { slug }
	}`

	it('answers the live item of the live shop', async () => {
		const { itemBySlug } = await data<ItemBySlug>(query, { companySlug: COMPANY_LIVE, slug: ITEM_LIVE })

		expect(itemBySlug).toEqual({ slug: ITEM_LIVE })
	})

	it('answers null for a draft item of a live shop', async () => {
		expect((await data<ItemBySlug>(query, { companySlug: COMPANY_LIVE, slug: ITEM_DRAFT })).itemBySlug).toBeNull()
	})

	it('answers null for a deleted item of a live shop', async () => {
		expect((await data<ItemBySlug>(query, { companySlug: COMPANY_LIVE, slug: ITEM_GONE })).itemBySlug).toBeNull()
	})

	it('answers null for a published item whose shop is still a draft', async () => {
		expect((await data<ItemBySlug>(query, { companySlug: COMPANY_DRAFT, slug: ITEM_IN_DRAFT_SHOP })).itemBySlug).toBeNull()
	})
})

describe('search: the text index reaches drafts and the filter does not', () => {
	it('searchCompanies returns the live shop alone, though all three carry the token', async () => {
		const { searchCompanies } = await data<{ searchCompanies: { nodes: Slugged[] } }>(
			`query ($q: String!) { searchCompanies(q: $q, limit: 60) { nodes { slug } } }`,
			{ q: TOKEN }
		)

		expect(searchCompanies.nodes.map((node) => node.slug)).toEqual([COMPANY_LIVE])
	})

	it('searchItems returns the live item alone, though all four carry the token', async () => {
		const { searchItems } = await data<{ searchItems: { nodes: Slugged[] } }>(
			`query ($q: String!) { searchItems(q: $q, limit: 60) { nodes { slug } } }`,
			{ q: TOKEN }
		)

		expect(searchItems.nodes.map((node) => node.slug)).toEqual([ITEM_LIVE])
	})
})

describe('sitemapEntries: what a crawler is invited to index', () => {
	/** Walk every page of one kind — the listing spans the collection, this run's rows do not. */
	async function allPaths(kind: 'COMPANY' | 'ITEM' | 'CATEGORY') {
		const paths: string[] = []
		let afterId: string | null = null

		do {
			const { sitemapEntries } = await data<{
				sitemapEntries: { nodes: Array<{ path: string }>; nextAfterId: string | null }
			}>(
				`query ($kind: GraphQLSitemapKind!, $afterId: ID) {
					sitemapEntries(kind: $kind, afterId: $afterId, limit: 60) { nodes { path } nextAfterId }
				}`,
				{ kind, afterId }
			)

			paths.push(...sitemapEntries.nodes.map((node) => node.path))
			afterId = sitemapEntries.nextAfterId
		} while (afterId)

		return paths
	}

	it('lists the live shop and neither the draft nor the deleted one', async () => {
		const paths = await allPaths('COMPANY')

		expect(paths).toContain(`/shop/${COMPANY_LIVE}`)
		expect(paths).not.toContain(`/shop/${COMPANY_DRAFT}`)
		expect(paths).not.toContain(`/shop/${COMPANY_GONE}`)
	})

	it('lists the live item, and not the draft, the deleted, or the one in the draft shop', async () => {
		const paths = await allPaths('ITEM')

		expect(paths).toContain(`/shop/${COMPANY_LIVE}/item/${ITEM_LIVE}`)
		expect(paths).not.toContain(`/shop/${COMPANY_LIVE}/item/${ITEM_DRAFT}`)
		expect(paths).not.toContain(`/shop/${COMPANY_LIVE}/item/${ITEM_GONE}`)
		expect(paths).not.toContain(`/shop/${COMPANY_DRAFT}/item/${ITEM_IN_DRAFT_SHOP}`)
	})

	it('lists the live category and not the deleted one', async () => {
		const paths = await allPaths('CATEGORY')

		expect(paths).toContain(`/category/${CATEGORY_LIVE}`)
		expect(paths).not.toContain(`/category/${CATEGORY_GONE}`)
	})
})

describe('itemCategories: the menu', () => {
	it('carries the live category and not the deleted one', async () => {
		const { itemCategories } = await data<{ itemCategories: Slugged[] }>(`{ itemCategories { slug } }`)
		const slugs = itemCategories.map((node) => node.slug)

		expect(slugs).toContain(CATEGORY_LIVE)
		expect(slugs).not.toContain(CATEGORY_GONE)
	})
})
