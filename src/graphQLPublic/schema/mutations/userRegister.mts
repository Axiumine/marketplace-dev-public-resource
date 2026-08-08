import { SocketLabsLib } from '@axiumine/koa-utils/email/SocketLabsLib'
import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { sendUserVerifyEmail } from '@lib/access/sendUserVerifyEmail.mjs'
import { setEmailHashUser } from '@lib/access/verifyEmailFlowUser.mjs'
import { registerNewUser } from '@lib/db/registerNewUser.mjs'
import { restartUserRegistration } from '@lib/db/restartUserRegistration.mjs'
import { userForRegistration } from '@lib/db/userForRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import { Context } from 'koa'
import mongoose from 'mongoose'

/** Registrations allowed from one IP per hour. Generous — an office or a phone network is one IP. */
const PER_IP_PER_HOUR = 10

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
 * three outcomes are therefore indistinguishable to the caller and distinguishable only in the inbox —
 * a new registration and a restarted one get an activation link, an address that already has a
 * verified account gets the "you are already registered" mail koa-utils sends for exactly this case.
 * The person who owns the address learns everything; the person who does not learns nothing.
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
	async resolve(_: unknown, args: IUserRegisterArgs, ctx: Context) {
		const { email, password, repeatPassword, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)
		checkPwdLen(password)

		if (password !== repeatPassword) throw throwErrorWrongUserInput('The two passwords do not match')

		await guardPublicWrite(ctx, {
			bucket: 'userRegister',
			email: uEmail,
			turnstileToken,
			perIpPerHour: PER_IP_PER_HOUR,
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

				// A verified document is somebody's account. Nothing is written to it — not the password, not the
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
