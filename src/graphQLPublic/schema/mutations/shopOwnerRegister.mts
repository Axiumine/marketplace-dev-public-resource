import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { submitShopOwnerRegistration } from '@lib/registration/submitRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

/** Activation mails one address can be made to receive per hour, across every source. */
const PER_EMAIL_PER_HOUR = 3

export interface IShopOwnerRegisterArgs {
	email: string
	password: string
	repeatPassword: string
	turnstileToken?: string
}

/**
 * Registers a seller: email and password, an activation link, and — once that link is opened — a document
 * nobody may log into yet.
 *
 * ⚠️ **The account this leads to cannot be used.** The confirmation writes `waitApprov: true`, and
 * `checkShopOwnerApproval` refuses a session at login and at every refresh while the flag is up. That is
 * the whole reason this mutation is safe to expose: selling on the platform is a commercial relationship
 * with the admin, so a stranger may *ask* to become a shop owner but may not *become* one by filling
 * in a form. Confirming the address proves the person exists; an admin clearing the flag through
 * `shopOwnerUpdateStatus` is what admits them.
 *
 * ⚠️ **`shopOwnerAdd` on the Admin service writes no `waitApprov`, deliberately.** The asymmetry is the
 * decision: an admin creating an account by hand has approved it by the act of creating it, and
 * routing those through the same queue would leave it permanently full of accounts nobody is waiting on.
 *
 * ⚠️ **Nothing is written to MongoDB here** (ADR-042). A submitted registration is a Redis record with a
 * three-day TTL, and the `shopOwner` document is created by the confirmation click and by nothing else —
 * so an address is never held against anybody by a half-built row, and an abandoned attempt stops
 * existing on its own rather than waiting for somebody to visit a link that would notice it.
 *
 * ⚠️ **It answers `true` whatever happened**, exactly as the customer's does, and for the same reason: a
 * 409 on a taken address turns the mutation into an account-enumeration oracle anybody may query one
 * address at a time. The outcomes are indistinguishable to the caller and distinguishable only in the
 * inbox. The approval state is never part of the answer either.
 *
 * ⚠️ **`repeatPassword` is checked here as well as in the form.** The frontend check exists to give the
 * typist a message before they submit; it is not a control, because nothing stops a client from not
 * being that frontend.
 *
 * The bucket is `shopOwnerRegister`, its own counter rather than `userRegister`'s. Sharing one would let
 * three seller attempts spend a customer's hourly budget for the same address — one person may
 * legitimately be both, since the two collections are unrelated by design (ADR-002).
 *
 * A record that is written and a mail that then fails is recoverable by submitting the form again: it
 * lands on the same Redis key, mints a new hash and re-arms the window. The customer tier has a separate
 * `userVerifyEmailResend` because its account area offers a resend button; the seller has no account area
 * to offer one from until it is approved.
 */
export const shopOwnerRegister = {
	description: 'Register a new shop owner, pending admin approval, and send the activation link',
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

		try {
			await submitShopOwnerRegistration(uEmail, password)
		} catch (e: unknown) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
