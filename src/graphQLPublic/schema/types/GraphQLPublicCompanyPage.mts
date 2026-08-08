import { GraphQLPublicCompany } from '@ptypes/GraphQLPublicCompany.mjs'
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql'

/**
 * One page of shops, plus the three numbers a paginated listing needs to render honestly.
 *
 * An envelope rather than a bare list because `/shops?page=N` is a crawled, indexed URL: the page
 * needs `rel=next`, a "page N of M" heading and a decision about whether to emit page N+1 at all,
 * and none of those can be derived from a list of 24 documents. A client that has to fetch a second page
 * to discover the first was the last is a client that doubles the load on the busiest route.
 *
 * ⚠️ **`total` is capped and `totalIsExact` is how you find out.** The count is issued with a
 * `limit`, so the server stops walking the index at `COUNT_CAP` matches instead of at the end of the
 * collection — the difference between a bounded cost and a per-request scan of every published
 * company at target scale. When `totalIsExact` is `false`, `total` is the cap and the real figure is
 * larger: render "5000+", and do **not** compute a page count from it.
 *
 * `hasMore` is computed from the documents actually fetched, not from `total`, so it stays exact even
 * when `total` is not — which is what makes deep pagination behave correctly past the cap.
 */
export const GraphQLPublicCompanyPage = new GraphQLObjectType({
	name: 'GraphQLPublicCompanyPage',
	fields: () => ({
		nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLPublicCompany))) },
		total: { type: new GraphQLNonNull(GraphQLInt) },
		totalIsExact: { type: new GraphQLNonNull(GraphQLBoolean) },
		hasMore: { type: new GraphQLNonNull(GraphQLBoolean) }
	})
})
