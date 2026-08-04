import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

const HelloType = new GraphQLObjectType({
	name: 'HelloType',
	fields: () => ({
		txt: { type: new GraphQLNonNull(GraphQLString) }
	})
})

export default HelloType
