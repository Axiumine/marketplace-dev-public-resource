import { GraphQLPublicCompany } from '@ptypes/GraphQLPublicCompany.mjs'
import { GraphQLPublicItemHit } from '@ptypes/GraphQLPublicItemHit.mjs'
import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * What one search returns: shops that matched, and items that matched, kept apart.
 *
 * ⚠️ **Two lists rather than one ranked list, and this is a decision rather than a shortcut.**
 * MongoDB's `textScore` is computed per collection against that collection's own term statistics and
 * its own field weights. A shop scoring 1.4 and an item scoring 1.1 have not been compared —
 * interleaving them by score produces an order that looks authoritative and is arbitrary. Two lists
 * are honest about what the database actually knows, and they are also the better interface: "3
 * shops, 41 items" is a result page a user can navigate, while a single mixed column of two
 * different kinds of thing is one they have to read linearly.
 *
 * Merging them into one relevance order is what a real search engine is for. The plan keeps
 * Meilisearch documented as the later swap behind this exact resolver, and this shape is what makes
 * the swap cheap: the client already treats the two as separate result sets, so a future single
 * ranked list is an added field rather than a rewritten page.
 *
 * Both lists are non-null and may be empty. An empty search is an empty result, not `null` — a
 * client that has to distinguish "no matches" from "field absent" is a client with two empty states.
 */
export const GraphQLPublicSearchResult = new GraphQLObjectType({
	name: 'GraphQLPublicSearchResult',
	fields: () => ({
		companies: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicCompany))) },
		items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicItemHit))) }
	})
})
