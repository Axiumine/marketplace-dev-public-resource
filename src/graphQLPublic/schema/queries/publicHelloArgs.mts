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
	// ⚠️ **Nothing here writes `args.name` anywhere but the response** (E12-S20). This resolver used to
	// `console.debug` the argument, and it was the single planted marker that came back out of nine
	// service logs when E12-S12 measured them: an anonymous caller on the public surface chose what got
	// written to disk. Console output is also telemetry — it becomes `event.breadcrumbs` on any error
	// event from the same request — so a demo resolver was a supply line into two sinks at once.
	resolve(_: unknown, args: IArgs) {
		return {
			txt: `Hello from publicHelloArgs - ${args.name}!`
		}
	}
}
