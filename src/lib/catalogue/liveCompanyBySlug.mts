import { Company } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Company'
import { Types } from 'mongoose'

import { livePublic } from './publicRead.mjs'

/** The three fields a caller that resolved a shop by its URL segment actually needs downstream. */
export interface ILiveCompanyRef {
	_id: Types.ObjectId
	slug: string
	publicName: string
}

/**
 * Resolve `/shop/:slug` to a live company, or `null`.
 *
 * ⚠️ **This is the cross-document `published` check, and every item read has to go through it.**
 * An item is publicly visible only if `item.published` *and* `company.published` are true. No
 * MongoDB validator can express that — a validator sees one document — and no index can either, so
 * the AND lives in the resolvers or it does not exist. Resolving the company first turns the rule
 * into a filter the item query never has to know about: if this returns `null` there is nothing
 * below it to read, and if it returns a company then every item under `idCompany` needs only its own
 * flag checked.
 *
 * The projection is deliberate. `slug` and `publicName` come back because callers building an item
 * URL or an item card need the shop's identity and would otherwise issue a second read for it;
 * nothing else does, and in particular none of `vatNumber`, `certifiedEmail`, `legalName`,
 * `registryExtract` or `taxCode` — the legal-entity half of this collection — can leave this service.
 * A public resolver that reads the whole document and lets the GraphQL type do the filtering is one
 * `...on` selection away from leaking a partita IVA.
 *
 * `slug_unique` is a partial unique index on `{ slug: { $type: 'string' } }`, so this is a single
 * index seek; the two liveness predicates are applied on the fetched document, not scanned for.
 */
export async function liveCompanyBySlug(slug: string): Promise<ILiveCompanyRef | null> {
	return await Company.findOne({ slug, ...livePublic() }, '_id slug publicName').lean<ILiveCompanyRef>()
}
