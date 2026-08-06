import type { IUpdatePasswordArgs } from '@axiumine/koa-utils/graphQL/schema/mutations/updatePassword'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { userUpdatePwd as boundUpdatePwd } from '@lib/access/resetPwdFlowUser.mjs'
import { GraphQLNonNull, GraphQLString } from 'graphql'
import { Context } from 'koa'

/**
 * Higher than the request side, and on purpose: this one is metered against **guessing the hash**, not
 * against sending mail. A legitimate caller submits the form once, maybe twice if the password rules
 * reject the first try. A caller working through the 50-character hash space needs many orders of
 * magnitude more than any ceiling here, so the number only has to be large enough not to bite a person
 * who mistypes.
 */
const PER_IP_PER_HOUR = 20

/** Per address, so one hijack attempt cannot be spread across a botnet to evade the IP bucket. */
const PER_EMAIL_PER_HOUR = 10

export interface IUserUpdatePwdArgs extends IUpdatePasswordArgs {
	turnstileToken?: string
}

/**
 * `updatePassword` for the customer tier, behind the Turnstile + rate-limit guard.
 *
 * The guard matters more here than on the request side. koa-utils already refuses a wrong hash and an
 * expired one with the same 403 an unknown address gets, so nothing leaks — but nothing *costs* the
 * caller anything either, and an unmetered 403 is an invitation to keep asking. The rate limit turns
 * the hash into a secret that has to be received rather than found.
 *
 * ⚠️ The delegate enforces a **60-minute** validity window on the hash, not the three days the activation
 * link gets. A customer who lets the reset mail sit overnight has to request a new one; that is the
 * library's behaviour and it is not overridden here.
 */
export const userUpdatePwd = {
	description: "Confirm a customer's password reset",
	type: boundUpdatePwd.type,
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		hash: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(source: unknown, args: IUserUpdatePwdArgs, ctx: Context) {
		const { email, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)

		await guardPublicWrite(ctx, {
			bucket: 'userUpdatePwd',
			email: uEmail,
			turnstileToken,
			perIpPerHour: PER_IP_PER_HOUR,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		return boundUpdatePwd.resolve(source, args)
	}
}
