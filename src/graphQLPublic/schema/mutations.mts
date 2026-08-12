// Both halves of the reset now come from the same bound flow: the local updatePwd fork and the
// three src/lib/db helpers behind it existed only because koa-utils' pair was welded to UserBase.
import { resetPwd, updatePwd } from '@lib/access/resetPwdFlow.mjs'
import { GraphQLObjectType } from 'graphql'

import { publicMutArgs } from './mutations/publicMutArgs.mjs'
import { publicMutNoArgs } from './mutations/publicMutNoArgs.mjs'
import { shopOwnerRegister } from './mutations/shopOwnerRegister.mjs'
import { userRegister } from './mutations/userRegister.mjs'
import { userResetPwd } from './mutations/userResetPwd.mjs'
import { userUpdatePwd } from './mutations/userUpdatePwd.mjs'
import { userVerifyEmailResend } from './mutations/userVerifyEmailResend.mjs'

const MutationsPublic = new GraphQLObjectType({
	name: 'MutationsPublic',
	fields: {
		publicMutArgs,
		publicMutNoArgs,
		// ⚠️ The ShopOwner pair. `resetPwd` mails a link on `APP_DOMAIN`; the customer pair below mails one
		// on `APP_DOMAIN_USER`. Two fields rather than one flow choosing at runtime because it cannot:
		// `user` and `shopOwner` are two collections, and an email plus a hash says nothing about which.
		resetPwd,
		updatePwd,
		// ⚠️ Only the mutations below are behind the Turnstile + rate-limit guard. `resetPwd` and
		// `updatePwd` above are not, and neither are `login` / `loginAdmin` on 4028 — both shipped
		// frontends call them today and send no token, so gating them would break the operator and
		// shop-owner apps on deploy. Adding the gate there is a coordinated change: the frontend has to
		// mint a token first. These have no such constraint because no shipped frontend calls them yet,
		// so they are born with the gate on.
		//
		// ⚠️ `shopOwnerRegister` is a seller *asking* to sell here, not becoming one: it writes
		// `waitApprov` and the account cannot log in until an operator clears it. The Admin service's
		// `shopOwnerAdd` writes no such flag, because an operator creating an account has approved it by
		// creating it. Do not "harmonise" the two.
		shopOwnerRegister,
		userRegister,
		userResetPwd,
		userUpdatePwd,
		userVerifyEmailResend
	}
})

export default MutationsPublic
