import { throwErrorWrongUserInput } from '@axiumine/koa-utils/graphQL/throw/throwErrorWrongUserInput'
import { checkEmailLen } from '@axiumine/koa-utils/lib/checkEmailLen'
import { checkPwdLen } from '@axiumine/koa-utils/lib/checkPwdLen'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { guardPublicWrite } from '@lib/access/guardPublicWrite.mjs'
import { submitUserRegistration } from '@lib/registration/submitRegistration.mjs'
import { GraphQLBoolean, GraphQLError, GraphQLNonNull, GraphQLString } from 'graphql'

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
 * outcomes are therefore indistinguishable to the caller and distinguishable only in the inbox — a
 * registration gets an activation link, and an address that already has a *live* account gets the "you
 * are already registered" mail. The person who owns the address learns everything; the person who does
 * not learns nothing.
 *
 * ⚠️ **Nothing is written to MongoDB here** (ADR-042). A submitted registration is a Redis record with a
 * three-day TTL, and the account document is created by the confirmation click and by nothing else. What
 * this replaces was four branches over a half-built `user` document: an unverified row held the address
 * against everybody else, an abandoned one was tombstoned lazily and so often never at all, and a closed
 * one had to be hard-deleted to free its address. None of those states can exist now, because the state
 * that used to hold them is not in the collection.
 *
 * ⚠️ **A closed account is not touched here either.** Its address is reclaimed at the confirmation click,
 * by overwriting rather than by deleting — see `confirmRegistration`. Submitting a form must not be able
 * to disturb a document that records that a person once held an account (ADR-041).
 *
 * ⚠️ **`repeatPassword` is checked here as well as in the form.** The frontend check exists to give the
 * typist a message before they submit; it is not a control, because nothing stops a client from not
 * being that frontend. Checking it server-side is what makes "the customer confirmed their password"
 * true rather than merely rendered.
 *
 * A write that commits and a mail that then fails is still possible and is still recoverable by design:
 * that is what `userVerifyEmailResend` is for.
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

		try {
			await submitUserRegistration(uEmail, password)
		} catch (e: unknown) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return true
	}
}
