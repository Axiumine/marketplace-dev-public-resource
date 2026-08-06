import { PipelineStage, trusted, Types } from 'mongoose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const companyFindOne = vi.fn()
const itemAggregate = vi.fn()

vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Company', () => ({ Company: { findOne: companyFindOne } }))
vi.mock('@thedoctorweb_agency/marketplace-common/models/MongoDB/Item', () => ({ Item: { aggregate: itemAggregate } }))

const { liveCompanyBySlug } = await import('../src/lib/catalogue/liveCompanyBySlug.mts')
const { liveItemsAcrossShops, MAX_CROSS_SHOP_OFFSET, OVERFETCH } = await import('../src/lib/catalogue/liveItemsAcrossShops.mts')

const idCompany = new Types.ObjectId('507f1f77bcf86cd799439011')
const live = { published: true, deleted: trusted({ $exists: false }) }

/** `findOne(...).lean()` — the projection is the second argument, so the chain is one link long. */
const leaning = (result: unknown) => ({ lean: vi.fn().mockResolvedValue(result) })

beforeEach(() => vi.clearAllMocks())

describe('liveCompanyBySlug', () => {
	// ⚠️ This one read *is* the cross-document `published` check for every item path that has a shop
	// in its URL. An item is public only if its own flag and its company's are both true; no validator
	// and no index can say so, because both see one document. Resolving the shop first turns the rule
	// into a filter the item query never has to know about — which is why the liveness pair has to be
	// in this filter and not merely in the caller.
	it('seeks the slug, and only a live shop answers', async () => {
		const company = { _id: idCompany, slug: 'bakery-mario', publicName: 'Bakery Mario' }
		companyFindOne.mockReturnValueOnce(leaning(company))

		await expect(liveCompanyBySlug('bakery-mario')).resolves.toBe(company)

		expect(companyFindOne).toHaveBeenCalledExactlyOnceWith({ slug: 'bakery-mario', ...live }, '_id slug publicName')
	})

	// ⚠️ The projection is a security boundary, not a saving. `vatNumber`, `certifiedEmail`,
	// `legalName`, `registryExtract` and `taxCode` live on this same document; naming three fields
	// keeps a partita IVA out of this process's memory, its query logs and any Sentry breadcrumb,
	// rather than out of one response. `slug` and `publicName` are there because callers building an
	// item URL or an item card would otherwise issue a second read for them.
	it('asks for exactly the three fields a caller downstream needs', async () => {
		companyFindOne.mockReturnValueOnce(leaning(null))

		await liveCompanyBySlug('bakery-mario')

		const projection = companyFindOne.mock.calls[0][1] as string

		expect(projection.split(' ').sort()).toEqual(['_id', 'publicName', 'slug'])
		expect(projection).not.toMatch(/vatNumber|certifiedEmail|legalName|registryExtract|taxCode|idShopOwner/)
	})

	// Unknown, unpublished and soft-deleted are one answer on purpose — the callers turn it into an
	// empty catalogue or a 404, and none of them may say which of the three it was.
	it('answers null when nothing live matches', async () => {
		companyFindOne.mockReturnValueOnce(leaning(null))

		await expect(liveCompanyBySlug('gone')).resolves.toBeNull()
	})
})

describe('liveItemsAcrossShops', () => {
	it('publishes the constants its callers budget against', () => {
		expect(OVERFETCH).toBe(3)
		expect(MAX_CROSS_SHOP_OFFSET).toBe(2_000)
	})

	const runPipeline = async (
		match = { idCategory: idCompany },
		companyMatch = {},
		sort = { _id: 1 as const },
		skip = 0,
		limit = 24
	) => {
		itemAggregate.mockResolvedValueOnce([])
		await liveItemsAcrossShops(match, companyMatch, sort, skip, limit)

		return itemAggregate.mock.calls[0][0] as PipelineStage[]
	}

	it('returns the aggregation’s rows untouched', async () => {
		const hits = [{ _id: idCompany, name: 'Focaccia' }]
		itemAggregate.mockResolvedValueOnce(hits)

		await expect(liveItemsAcrossShops({ idCategory: idCompany }, {}, { _id: 1 }, 0, 24)).resolves.toBe(hits)
	})

	// ⚠️ **No `trusted()` anywhere in a pipeline.** `sanitizeFilter` wraps mongoose `Query` filters
	// only; aggregation stages reach the driver untouched, so a `trusted()` wrapper here is an unknown
	// object the server rejects. The exact inverse of the rule that applies to `livePublic()`.
	it('ANDs the caller’s match with the liveness pair, spelled plainly', async () => {
		const [stage] = await runPipeline({ $text: { $search: 'focaccia' } })

		expect(stage).toEqual({ $match: { $text: { $search: 'focaccia' }, published: true, deleted: { $exists: false } } })
		expect(Object.getOwnPropertySymbols((stage as PipelineStage.Match).$match.deleted!)).toHaveLength(0)
	})

	// The caller owns the sort because only the caller knows whether a `$meta` field is available to
	// sort on — search sorts by text score, the category listing by `_id`.
	it('uses the sort it was handed, before anything is discarded', async () => {
		const pipeline = await runPipeline({ idCategory: idCompany }, {}, { score: { $meta: 'textScore' } })

		expect(pipeline[1]).toEqual({ $sort: { score: { $meta: 'textScore' } } })
	})

	// ⚠️ The one bound on the work, and it is placed *before* the join deliberately: a category can
	// span every shop on the platform, and joining company rows onto a hundred thousand items to
	// return sixty is not a query, it is an outage. `OVERFETCH` absorbs the rows the join then drops —
	// a mitigation, never a fix, which is why these paths report `totalIsExact: false`.
	it('bounds the pre-join window at (skip + limit) × OVERFETCH', async () => {
		const pipeline = await runPipeline({ idCategory: idCompany }, {}, { _id: 1 }, 40, 20)

		expect(pipeline[2]).toEqual({ $limit: 180 })
	})

	// The `$lookup` is a filter as much as a fetch: a company failing the sub-pipeline's predicates
	// produces an empty array, and the `$unwind` then drops the item. Projecting two fields is what
	// keeps the legal-entity half of `company` out of this service's memory entirely.
	it('joins the shop through a filtering sub-pipeline that projects two fields', async () => {
		const pipeline = await runPipeline()

		expect(pipeline[3]).toEqual({
			$lookup: {
				from: 'company',
				localField: 'idCompany',
				foreignField: '_id',
				as: 'company',
				pipeline: [{ $match: { published: true, deleted: { $exists: false } } }, { $project: { slug: 1, publicName: 1 } }]
			}
		})
	})

	// The geographic bound of "items near me" travels here: an item has no coordinates and inherits
	// its shop's, so the predicate belongs on the company being joined, ANDed with *its* liveness pair.
	it('ANDs a company-side predicate into the sub-pipeline’s match', async () => {
		const geo = { 'address.position': { $geoWithin: { $centerSphere: [[9.19, 45.46], 0.001] } } }
		const pipeline = await runPipeline({ $text: { $search: 'focaccia' } }, geo)

		expect((pipeline[3] as PipelineStage.Lookup).$lookup.pipeline![0]).toEqual({
			$match: { ...geo, published: true, deleted: { $exists: false } }
		})
	})

	// ⚠️ No `preserveNullAndEmptyArrays` — the dropping IS the company-published check. Adding it
	// would make every item of an unpublished shop public again, and nothing else in the pipeline
	// would notice.
	it('unwinds without preserving the empty joins', async () => {
		const pipeline = await runPipeline()

		expect(pipeline[4]).toEqual({ $unwind: '$company' })
	})

	// Skip and limit are applied *after* the join, on the survivors, which is what makes the page the
	// caller asked for the page it gets — short, when shops have gone dark, but never misaligned.
	it('pages the survivors, then projects the hit shape with the shop flattened onto it', async () => {
		const pipeline = await runPipeline({ idCategory: idCompany }, {}, { _id: 1 }, 40, 20)

		expect(pipeline[5]).toEqual({ $skip: 40 })
		expect(pipeline[6]).toEqual({ $limit: 20 })
		expect(pipeline[7]).toEqual({
			$project: {
				_id: 1,
				idCategory: 1,
				name: 1,
				description: 1,
				slug: 1,
				companySlug: '$company.slug',
				companyPublicName: '$company.publicName'
			}
		})
		expect(pipeline).toHaveLength(8)
	})
})
