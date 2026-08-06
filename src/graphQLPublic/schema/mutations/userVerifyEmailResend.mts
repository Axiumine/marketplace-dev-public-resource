import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { sendUserVerifyEmail } from '@lib/access/sendUserVerifyEmail.mjs'
import { setEmailHashUser } from '@lib/access/verifyEmailFlowUser.mjs'
import { userForRegistration } from '@lib/db/userForRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import { Context } from 'koa'
import mongoose from 'mongoose'

/** Deliberately tighter than registration's: this path sends a mail and writes nothing else. */
const PER_IP_PER_HOUR = 5

/** Same ceiling as registration, and the two buckets are separate — one cannot be used to top up the other. */
const PER_EMAIL_PER_HOUR = 3

export interface IUserVerifyEmailResendArgs {
	email: string
	turnstileToken?: string
}

/**
 * Re-sends the activation link for a registration that never got one, or whose link expired.
 *
 * It exists because the registration transaction can commit and the mail can still fail — SocketLabs
 * refuses it, the address bounces, the inbox eats it — and because the link is only good for three
 * days. Without this, the only recovery is to register again, which the unique index on `login.email`
 * makes a different code path with different failure modes.
 *
 * ⚠️ **Answers `true` for every address, registered or not**, for the reason `userRegister` does: a
 * mutation that answers differently for a known address is an enumeration oracle, and one that costs
 * nothing to call is a good one. All four outcomes — no such row, tombstoned row, already-verified row,
 * link re-issued — look identical from outside.
 *
 * ⚠️ **A tombstoned row is left alone**, and unlike in `userRegister` it is not restarted. The abandon
 * guards stamp `deleted` after five wrong hashes or three days, and reviving that from an argument list
 * with no password in it would let anyone keep somebody else's abandoned row alive indefinitely.
 * Registering again is the recovery path, and it is the one that proves who is asking by setting a new
 * password that only the mail can activate.
 *
 * Minting the hash goes through `setEmailHashUser`, so the resend also resets `requestTimes` — a
 * caller who burned four of their five wrong-hash strikes gets a clean slate along with the new link,
 * which is right: the strikes counted attempts against the *old* hash.
 */
export const userVerifyEmailResend = {
	description: 'Re-send the customer activation link',
	type: new GraphQLNonNull(GraphQLBoolean),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IUserVerifyEmailResendArgs, ctx: Context) {
		const { email, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)

		await guardPublicWrite(ctx, {
			bucket: 'userVerifyEmailResend',
			email: uEmail,
			turnstileToken,
			perIpPerHour: PER_IP_PER_HOUR,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				const existing = await userForRegistration(uEmail, session)

				if (!existing || existing.deleted || existing.emailVerify?.valid) return

				await sendUserVerifyEmail(uEmail, await setEmailHashUser(session, existing._id))
			})
		} catch (e: unknown) {
			tryCatchRethrow(e as GraphQLError | Error)
		} finally {
			await session.endSession()
		}

		return true
	}
}
