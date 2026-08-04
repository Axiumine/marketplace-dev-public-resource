import { GraphQLObjectType } from 'graphql'

import { publicHelloArgs } from './queries/publicHelloArgs.mjs'
import { publicHelloNoArgs } from './queries/publicHelloNoArgs.mjs'

const QueriesPublic = new GraphQLObjectType({
	name: 'QueriesPublic',
	fields: {
		publicHelloNoArgs,
		publicHelloArgs
	}
})

export default QueriesPublic
