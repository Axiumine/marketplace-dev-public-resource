import { GraphQLItemFrag } from '@axiumine/marketplace-common/schema/types/fragments/GraphQLItemFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

/**
 * An item as the public tier emits it — **the only item type on this tier**, in every context.
 *
 * Spreads the same `GraphQLItemFrag` the ShopOwner tier spreads (`name`, `description`, `slug`),
 * which is the whole reason that fragment lives in `marketplace-common`: two tiers cannot drift on
 * what an item's public face is when there is one definition of it.
 *
 * **Why it always carries its shop.** The item URL is `/shop/:companySlug/item/:slug`, so the shop's
 * slug is not decoration — it is half of every link on the page. Search results and the cross-shop
 * category listing arrive with no shop context at all (an item called "Aurora" is unlinkable
 * without knowing whose it is), and the shop page has the context but for free: the resolver already
 * looked the company up to check it was published. A single node type across all three paths costs
 * the shop page two repeated strings per item and saves the client a second shape, a second fragment
 * and a second cache entry for the same item.
 *
 * `companyPublicName` rides along because a result card renders "Aurora — North Loop Goods", and
 * fetching the shop name per hit would be N+1 reads on the query that can least afford them. On the
 * cross-shop paths it comes out of the `$lookup` that already had to touch `company` to check the
 * shop is published, so it costs nothing that was not already being paid.
 *
 * `published` is absent, unlike on the ShopOwner tier's `GraphQLItem`. There, drafts and live items
 * come back together and the flag is what the listing renders; here every path has already filtered
 * `published: true` on the item **and** on its company, so the field could only ever answer `true` —
 * a constant dressed as data, and one that invites a client to filter on it and get the emptiness
 * wrong. `idCompany` is absent for the same reason `companySlug` is present: what a client does with
 * an item is build a URL, and the URL is spelled with the slug.
 *
 * ⚠️ **No `score`.** The text score orders `items` in a search result, and the order is the answer;
 * exposing the raw number invites a client to threshold on it, and MongoDB's `textScore` is not
 * comparable across queries — it depends on the terms searched, so 0.75 means one thing for "lamp"
 * and another for "brass table lamp".
 */
export const GraphQLPublicItemHit = new GraphQLObjectType({
	name: 'GraphQLPublicItemHit',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idCategory: { type: new GraphQLNonNull(GraphQLID) },
		...GraphQLItemFrag,
		companySlug: { type: new GraphQLNonNull(GraphQLString) },
		companyPublicName: { type: new GraphQLNonNull(GraphQLString) }
	})
})
