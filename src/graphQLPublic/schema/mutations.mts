// Both halves of the reset now come from the same bound flow: the local updatePwd fork and the
// three src/lib/db helpers behind it existed only because koa-utils' pair was welded to UserBase.
import { resetPwd, updatePwd } from '@lib/access/resetPwdFlow.mjs'
import { GraphQLObjectType } from 'graphql'

import { publicMutArgs } from './mutations/publicMutArgs.mjs'
import { publicMutNoArgs } from './mutations/publicMutNoArgs.mjs'
import { userRegister } from './mutations/userRegister.mjs'
import { userVerifyEmailResend } from './mutations/userVerifyEmailResend.mjs'

const MutationsPublic = new GraphQLObjectType({
	name: 'MutationsPublic',
	fields: {
		publicMutArgs,
		publicMutNoArgs,
		resetPwd,
		updatePwd,
		// ⚠️ Only the two customer mutations are behind the Turnstile + rate-limit guard. `resetPwd` and
		// `updatePwd` are not, and neither are `login` / `loginAdmin` on 4028 — both shipped frontends
		// call them today and send no token, so gating them would break the operator and shop-owner apps
		// on deploy. Adding the gate there is a coordinated change: the frontend has to mint a token
		// first. The customer tier has no such constraint because its frontend does not exist yet.
		userRegister,
		userVerifyEmailResend
	}
})

export default MutationsPublic
