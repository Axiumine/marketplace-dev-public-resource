import { GraphQLNonNull, GraphQLString } from 'graphql'

export const publicMutNoArgs = {
	description: 'publicMutNoArgs',
	type: new GraphQLNonNull(GraphQLString),
	resolve() {
		return 'publicMutNoArgs'
	}
}
