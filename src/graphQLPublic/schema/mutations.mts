// Both halves of the reset now come from the same bound flow: the local updatePwd fork and the
// three src/lib/db helpers behind it existed only because koa-utils' pair was welded to UserBase.
import { resetPwd, updatePwd } from '@lib/access/resetPwdFlow.mjs'
import { GraphQLObjectType } from 'graphql'

import { publicMutArgs } from './mutations/publicMutArgs.mjs'
import { publicMutNoArgs } from './mutations/publicMutNoArgs.mjs'

const MutationsPublic = new GraphQLObjectType({
	name: 'MutationsPublic',
	fields: {
		publicMutArgs,
		publicMutNoArgs,
		resetPwd,
		updatePwd
	}
})

export default MutationsPublic
