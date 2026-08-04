import type { IResetPwdArgs } from '@axiumine/koa-utils/graphQL/schema/mutations/resetPwd'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { userResetPwd as boundResetPwd } from '@lib/access/resetPwdFlowUser.mjs'
import { GraphQLNonNull, GraphQLString } from 'graphql'
import { Context } from 'koa'

/** Same ceiling as the activation resend: both paths cost one outbound mail and write nothing else. */
const PER_IP_PER_HOUR = 5

/** Lower than the IP bucket, and separate from it — one address cannot be mail-bombed from many sources. */
const PER_EMAIL_PER_HOUR = 3

export interface IUserResetPwdArgs extends IResetPwdArgs {
	turnstileToken?: string
}

/**
 * `resetPwd` for the customer tier, behind the Turnstile + rate-limit guard.
 *
 * A wrapper rather than the bound flow re-exported directly, because koa-utils' mutation takes no Koa
 * context and cannot be given one: the guard needs `ctx.ip`, and everything the flow itself needs is
 * already baked into the closure. Delegation keeps the throttle, the privacy behaviour and the mail all
 * exactly as the library defines them.
 *
 * ⚠️ The shop-owner `resetPwd` next to it in the schema is **not** guarded, and that asymmetry is
 * deliberate: the operator and shop-owner apps ship today and send no Turnstile token, so gating them is
 * a coordinated frontend change. The customer tier has no such constraint — its frontend does not exist
 * yet, so it is born with the gate on.
 *
 * ⚠️ **The mail this sends carries a link on `APP_DOMAIN_USER`**, not `APP_DOMAIN` — see
 * `resetPwdFlowUser.mts`. Calling the shop-owner `resetPwd` with a customer's address would find nothing
 * (different collection) and answer `true`, which is the privacy behaviour working as intended and also
 * exactly what a silently broken wiring looks like. The two are separate fields for that reason.
 */
export const userResetPwd = {
	description: 'Send a customer password-reset link',
	type: boundResetPwd.type,
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(source: unknown, args: IUserResetPwdArgs, ctx: Context) {
		const { email, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)

		await guardPublicWrite(ctx, {
			bucket: 'userResetPwd',
			email: uEmail,
			turnstileToken,
			perIpPerHour: PER_IP_PER_HOUR,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		// The email is passed on as typed, not lowercased: the delegate normalises it itself, and handing
		// it a pre-normalised value would hide a change of mind there. Only the guard needs the canonical
		// form, so that two spellings of one address share a counter.
		return boundResetPwd.resolve(source, args)
	}
}
