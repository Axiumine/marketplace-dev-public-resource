import type { IUpdatePasswordArgs } from '@axiumine/koa-utils/graphQL/schema/mutations/updatePassword'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEverySessionUser } from '@lib/access/endEverySession.mjs'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { userUpdatePwd as boundUpdatePwd } from '@lib/access/resetPwdFlowUser.mjs'
import { GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

/** Per address, so one hijack attempt spread across a botnet still spends a single budget. */
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
 *
 * ⚠️ **The revoke is inside the try and after the delegate, both deliberately** — the shape the
 * authenticated services' call sites established. Before the write, a reset that then failed validation
 * would have logged the customer out of every device for nothing. Outside the try, a Redis that refused
 * would leave this answering `true` with every stolen session still live — the exact lie this wrapper
 * exists to stop telling. Nothing is revoked when the guard or the delegate throws, because neither is
 * reached.
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
	async resolve(source: unknown, args: IUserUpdatePwdArgs) {
		const { email, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)

		await guardPublicWrite({
			bucket: 'userUpdatePwd',
			email: uEmail,
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		const changed = await boundUpdatePwd.resolve(source, args)

		try {
			// The address is already normalised — the same normalisation the delegate applies internally —
			// so the read below matches the document the write just landed on.
			await endEverySessionUser(uEmail)
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return changed
	}
}
