import { ItemCategory } from '@axiumine/marketplace-common/models/MongoDB/ItemCategory'
import { GraphQLPublicItemCategory } from '@ptypes/GraphQLPublicItemCategory.mjs'
import { GraphQLList, GraphQLNonNull } from 'graphql'
import { trusted } from 'mongoose'

/**
 * The whole taxonomy, flat, in one read.
 *
 * ⚠️ **No pagination, and it is the only public read here without any.** The collection is
 * Admin-curated, capped at two levels, and shared by the entire platform — it is a navigation menu,
 * not a data set. Every consumer needs all of it at once (the nav renders the tree, the category
 * page needs its parent's slug for the breadcrumb, the filter sidebar needs the siblings), so
 * paginating it would mean every caller looping to page N to assemble a menu.
 *
 * The flat list **is** the tree: `idParent` absent means top level, present names the parent, and
 * the Admin write resolvers refuse a third level — so a client assembles the whole shape in one pass
 * with no recursion and no second query. That depth cap lives in resolvers rather than in a
 * validator because a parent's own `idParent` is in another document and a `$jsonSchema` sees one.
 *
 * `deleted` is filtered; `published` is not, because categories have no such flag. A category is not
 * a draft — it exists platform-wide the moment an operator creates it. Soft-deleted rows stay in the
 * collection because `item.idCategory` is required and MongoDB has no foreign keys, so a hard delete
 * would leave items pointing at nothing.
 *
 * Sorted by `position` — a **sort ordinal**, not the GeoJSON `position` that `company.address`
 * carries; the two share a name and nothing else. `_id` breaks the tie so two categories given the
 * same ordinal do not swap places between two reads of the same data. The sort is not index-backed
 * (`idParent_position` leads with the parent) and does not need to be: an admin-curated menu is tens
 * of rows, and the alternative — a `{ position: 1 }` index — would cost a write per category edit to
 * save a sort of a page that nginx caches anyway.
 *
 * trusted(): `sanitizeFilter` is on globally, so a bare `{ $exists: false }` would be cast as a
 * literal against the `deleted` path instead of read as an operator, and the query would silently
 * match nothing.
 */
export const itemCategories = {
	type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicItemCategory))),
	description: 'Get the whole item category tree, flat',
	async resolve() {
		return await ItemCategory.find({ deleted: trusted({ $exists: false }) }, '_id idParent name slug position')
			.sort({ position: 1, _id: 1 })
			.lean()
	}
}
