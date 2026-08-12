import { SocketLabsLib } from '@axiumine/koa-utils/email/SocketLabsLib'
import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { sendShopOwnerVerifyEmail } from '@lib/access/sendShopOwnerVerifyEmail.mjs'
import { setEmailHash } from '@lib/access/verifyEmailFlow.mjs'
import { registerNewShopOwner } from '@lib/db/registerNewShopOwner.mjs'
import { restartShopOwnerRegistration } from '@lib/db/restartShopOwnerRegistration.mjs'
import { shopOwnerForRegistration } from '@lib/db/shopOwnerForRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'
import mongoose from 'mongoose'

/** Activation mails one address can be made to receive per hour, across every source. */
const PER_EMAIL_PER_HOUR = 3

export interface IShopOwnerRegisterArgs {
	email: string
	password: string
	repeatPassword: string
	turnstileToken?: string
}

/**
 * Registers a seller: email and password, an activation link, and a document nobody may log into yet.
 *
 * ⚠️ **The account this creates cannot be used.** `registerNewShopOwner` writes `waitApprov: true`, and
 * `checkShopOwnerApproval` refuses a session at login and at every refresh while the flag is up. That is
 * the whole reason this mutation is safe to expose: selling on the platform is a commercial relationship
 * with the operator, so a stranger may *ask* to become a shop owner but may not *become* one by filling
 * in a form. Confirming the address proves the person exists; an operator clearing the flag through
 * `shopOwnerUpdateStatus` is what admits them.
 *
 * ⚠️ **`shopOwnerAdd` on the Admin service writes no `waitApprov`, deliberately.** The asymmetry is the
 * decision: an operator creating an account by hand has approved it by the act of creating it, and
 * routing those through the same queue would leave it permanently full of accounts nobody is waiting on.
 *
 * ⚠️ **It answers `true` whatever happened**, exactly as the customer's does, and for the same reason: a
 * 409 on a taken address turns the mutation into an account-enumeration oracle anybody may query one
 * address at a time. The three outcomes are indistinguishable to the caller and distinguishable only in
 * the inbox — new and restarted registrations get an activation link, an address that already has a
 * verified account gets koa-utils' "you are already registered" mail. The owner of the address learns
 * everything, the person who is not learns nothing. The approval state is never part of the answer
 * either, which is why `shopOwnerForRegistration` does not project it.
 *
 * ⚠️ **`repeatPassword` is checked here as well as in the form.** The frontend check exists to give the
 * typist a message before they submit; it is not a control, because nothing stops a client from not
 * being that frontend.
 *
 * The bucket is `shopOwnerRegister`, its own counter rather than `userRegister`'s. Sharing one would let
 * three seller attempts spend a customer's hourly budget for the same address — one person may legitimately
 * be both, since the two collections are unrelated by design (ADR-002).
 *
 * The whole thing runs in one transaction so a mail is never sent for a document that failed to write.
 * The reverse is still possible — the write commits and SocketLabs then refuses the mail — and the
 * restart branch below is the recovery: submitting the form again re-mints the hash and re-sends. The
 * customer tier has a separate `userVerifyEmailResend` because its account area offers a resend button;
 * the seller has no account area to offer one from until it is approved.
 */
export const shopOwnerRegister = {
	description: 'Register a new shop owner, pending operator approval, and send the activation link',
	type: new GraphQLNonNull(GraphQLBoolean),
	args: {
		email: { type: new GraphQLNonNull(GraphQLString) },
		password: { type: new GraphQLNonNull(GraphQLString) },
		repeatPassword: { type: new GraphQLNonNull(GraphQLString) },
		turnstileToken: { type: GraphQLString }
	},
	async resolve(_: unknown, args: IShopOwnerRegisterArgs) {
		const { email, password, repeatPassword, turnstileToken } = args

		const uEmail = email.toLowerCase().trim()
		checkEmailLen(uEmail)
		checkPwdLen(password)

		if (password !== repeatPassword) throw throwErrorWrongUserInput('The two passwords do not match')

		await guardPublicWrite({
			bucket: 'shopOwnerRegister',
			email: uEmail,
			turnstileToken,
			perEmailPerHour: PER_EMAIL_PER_HOUR
		})

		const session = await mongoose.startSession()

		try {
			await session.withTransaction(async () => {
				const existing = await shopOwnerForRegistration(uEmail, session)

				if (!existing) {
					await sendShopOwnerVerifyEmail(uEmail, await registerNewShopOwner(uEmail, password, session))
					return
				}

				// A verified document is somebody's account — an approved seller, or one still in the queue.
				// Nothing is written to it, not the password and not the hash, and the mail says so: the one
				// message that helps its owner (they forgot they registered) without telling anyone else that
				// the address is taken.
				if (existing.emailVerify?.valid) {
					const SocketLabsObj = new SocketLabsLib()
					await SocketLabsObj.emailAlreadyValid(uEmail)
					return
				}

				// Unverified: an attempt that was never finished, possibly with a mistyped password, possibly
				// tombstoned by the three-day guard. Start it over rather than leaving the address unusable.
				// `waitApprov` is not touched here — the restart re-opens a registration, it does not decide
				// an approval, and an operator who has already cleared the flag must not see it come back.
				await restartShopOwnerRegistration(session, existing._id, password)
				await sendShopOwnerVerifyEmail(uEmail, await setEmailHash(session, existing._id))
			})
		} catch (e: unknown) {
			tryCatchRethrow(e as GraphQLError | Error)
		} finally {
			await session.endSession()
		}

		return true
	}
}
