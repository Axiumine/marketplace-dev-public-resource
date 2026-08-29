import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { resendUserRegistration } from '@lib/registration/resendRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

/** Same ceiling as registration, and the two buckets are separate — one cannot be used to top up the other. */
const PER_EMAIL_PER_HOUR = 3

export interface IUserVerifyEmailResendArgs {
	email: string
	turnstileToken?: string
}

/**
 * Re-sends the activation link for a registration whose mail never arrived.
 *
 * It exists because the pending record can be written and the mail can still fail — SocketLabs refuses
 * it, the address bounces, the inbox eats it.
 *
 * ⚠️ **Answers `true` for every address, pending or not**, for the reason `userRegister` does: a mutation
 * that answers differently for a known address is an enumeration oracle, and one that costs nothing to
 * call is a good one. Both outcomes — no pending registration, link re-issued — look identical from
 * outside.
 *
 * ⚠️ **It cannot reach a `user` document, and after ADR-042 there is none to reach.** A pending
 * registration lives only in Redis, so this either re-mints the hash on that record or does nothing at
 * all; the three branches it used to need — verified, tombstoned, absent — described states a half-built
 * document could be in, and no half-built document exists any more. Re-registering remains the recovery
 * for everything else, and it is the path that proves who is asking by setting a password only the new
 * mail can activate.
 *
 * The renewal resets the strike counter along with the hash, which is right: a caller who burned four of
 * their five wrong-hash strikes gets a clean slate with the new link, because those strikes counted
 * attempts against a hash that no longer opens anything.
 */
export const userVerifyEmailResend = {
	description: 'Re-send the customer activation link',
	type: new GraphQLNonNull(GraphQLBoolean),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IUserVerifyEmailResendArgs) {
		const { email, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)

		await guardPublicWrite({
			bucket: 'userVerifyEmailResend',
			email: uEmail,
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		try {
			await resendUserRegistration(uEmail)
		} catch (e: unknown) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
