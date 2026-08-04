import HelloType from '@ptypes/HelloType.mjs'
import { GraphQLNonNull } from 'graphql'

export const publicHelloNoArgs = {
	description: 'publicHelloNoArgs',
	type: new GraphQLNonNull(HelloType),
	resolve() {
		return {
			txt: `Hello from publicHelloNoArgs`
		}
	}
}
