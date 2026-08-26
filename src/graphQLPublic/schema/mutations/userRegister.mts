import { SocketLabsLib } from '@axiumine/koa-utils/email/SocketLabsLib'
import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { sendUserVerifyEmail } from '@lib/access/sendUserVerifyEmail.mjs'
import { setEmailHashUser } from '@lib/access/verifyEmailFlowUser.mjs'
import { purgeClosedUser } from '@lib/db/purgeClosedUser.mjs'
import { registerNewUser } from '@lib/db/registerNewUser.mjs'
import { restartUserRegistration } from '@lib/db/restartUserRegistration.mjs'
import { userForRegistration } from '@lib/db/userForRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose from 'mongoose'

/** Activation mails one address can be made to receive per hour, across every source. */
const PER_EMAIL_PER_HOUR = 3

export interface IUserRegisterArgs {
	email: string
	password: string
	repeatPassword: string
	turnstileToken?: string
}

/**
 * Registers a customer: email and password, an activation link, nothing else.
 *
 * ⚠️ **It answers `true` whatever happened, and that is the security property, not laziness.**
 * koa-utils' `signUp` throws a 409 when the address is taken, which turns this mutation into an
 * account-enumeration oracle: anybody can ask it, one address at a time, who has an account here. The
 * four outcomes are therefore indistinguishable to the caller and distinguishable only in the inbox —
 * a new registration, a restarted one and a reopened one all get an activation link, and an address
 * that already has a *live* verified account gets the "you are already registered" mail koa-utils sends
 * for exactly this case. The person who owns the address learns everything; the person who does not
 * learns nothing.
 *
 * ⚠️ **A closed account is destroyed here and registered again from scratch — the platform's one
 * application hard delete** (ADR-011 §Amendment 2026-08-26). That document was already condemned:
 * `user.deleted_ttl` removes it thirty days after `userDel` stamped it, and this only brings the
 * removal forward to the request that needs the address. So the wait to register again drops from a
 * month to nothing, and the erasure happens *earlier* than the retention rule requires rather than
 * later. Emptying the old document in place instead of destroying it was considered and rejected;
 * `purgeClosedUser` carries that argument. The account that replaces it starts as any other new one
 * does — new `_id`, no personal data, no addresses, unverified — so nothing is inherited and nothing
 * is reachable until the activation link is opened in the mailbox.
 *
 * ⚠️ **`repeatPassword` is checked here as well as in the form.** The frontend check exists to give
 * the typist a message before they submit; it is not a control, because nothing stops a client from
 * not being that frontend. Checking it server-side is what makes "the customer confirmed their
 * password" true rather than merely rendered.
 *
 * The whole thing runs in one transaction so a mail is never sent for a document that failed to write.
 * The reverse is still possible — the write commits and SocketLabs then refuses the mail — and is
 * recoverable by design: that is what `userVerifyEmailResend` is for.
 */
export const userRegister = {
	description: 'Register a new customer and send the activation link',
	type: new GraphQLNonNull(GraphQLBoolean),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		repeatPassword: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IUserRegisterArgs) {
		const { email, password, repeatPassword, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)
		checkPwdLen(password)

		if (password !== repeatPassword) throw throwErrorWrongUserInput('The two passwords do not match')

		await guardPublicWrite({
			bucket: 'userRegister',
			email: uEmail,
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				const existing = await userForRegistration(uEmail, session)

				if (!existing) {
					await sendUserVerifyEmail(uEmail, await registerNewUser(uEmail, password, session))
					return
				}

				// A closed account, kept only by the retention clock. Destroy it and register the address fresh
				// rather than answering "already registered" for a month about an account nobody can log into.
				// Ordered before the verified branch on purpose: a closed document is verified too, so the two
				// conditions overlap and the wrong order would make this branch unreachable.
				if (existing.deleted && existing.emailVerify?.valid) {
					await purgeClosedUser(session, existing._id)
					await sendUserVerifyEmail(uEmail, await registerNewUser(uEmail, password, session))
					return
				}

				// A live verified document is somebody's account. Nothing is written to it — not the password, not the
				// hash — and the mail says so, which is the one message that helps its owner (they forgot
				// they registered) without telling anyone else the address is taken.
				if (existing.emailVerify?.valid) {
					const SocketLabsObj = new SocketLabsLib()
					await SocketLabsObj.emailAlreadyValid(uEmail)
					return
				}

				// Unverified: an attempt that was never finished, possibly with a mistyped password, possibly
				// tombstoned by the three-day guard. Start it over rather than leaving the address unusable.
				await restartUserRegistration(session, existing._id, password)
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
