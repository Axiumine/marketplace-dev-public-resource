import HelloType from '@ptypes/HelloType.mjs'
import { GraphQLNonNull, GraphQLString } from 'graphql'

interface IArgs {
	name: string
}

export const publicHelloArgs = {
	description: 'publicHelloArgs',
	type: new GraphQLNonNull(HelloType),
	args: {
		name: { type: new GraphQLNonNull(GraphQLString) }
	},
	resolve(_: unknown, args: IArgs) {
		console.debug('publicHelloArgs: name: ', args.name)

		return {
			txt: `Hello from publicHelloArgs - ${args.name}!`
		}
	}
}
