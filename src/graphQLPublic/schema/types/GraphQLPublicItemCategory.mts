import { GraphQLItemCategoryFrag } from '@thedoctorweb_agency/marketplace-common/schema/types/fragments/GraphQLItemCategoryFrag'
import { GraphQLID, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * One node of the platform-wide taxonomy — a category or a subcategory, the two being one collection
 * distinguished only by whether `idParent` is set.
 *
 * ⚠️ **`position` here is a sort ordinal, not a coordinate.** `IItemCategorySchema` shares the field
 * name with `ICompanyAddress` and shares nothing else with it; this collection stores no geometry.
 * The name collision is inherited and is called out at every layer that can see it.
 *
 * `idParent` is exposed and nullable, and the nullability **is** the tree: absent means top level,
 * present names the parent. Depth is capped at two by the Admin tier's write resolvers — a cap no
 * validator can express, since the parent's own `idParent` is in another document — so a client may
 * assemble the entire taxonomy from one flat list with a single pass and no recursion.
 *
 * The ShopOwner tier's `GraphQLItemCategory` is this type minus nothing: both tiers read the same
 * fields, because a taxonomy has no private half. The two are separate declarations only because a
 * GraphQL type belongs to exactly one schema.
 */
export const GraphQLPublicItemCategory = new GraphQLObjectType({
	name: 'GraphQLPublicItemCategory',
	fields: () => ({
		_id: { type: new GraphQLNonNull(GraphQLID) },
		idParent: { type: GraphQLID },
		...GraphQLItemCategoryFrag
	})
})
