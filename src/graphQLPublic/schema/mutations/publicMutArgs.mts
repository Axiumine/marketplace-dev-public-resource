import { GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	name: string
}

export const publicMutArgs = {
	description: 'publicMutArgs',
	type: new GraphQLNonNull(GraphQLString),
	args: {
		name: { type: new GraphQLNonNull(GraphQLString) }
	},
	resolve(parent: unknown, args: IArgs) {
		return `publicMutArgs ${args.name}`
	}
}
