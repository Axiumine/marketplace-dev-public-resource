import { isSafeRedirectTarget } from '@axiumine/koa-utils/lib/isSafeRedirectTarget'
import type { RouterContext } from '@koa/router'
import {
	confirmShopOwnerRegistration,
	confirmUserRegistration,
	REGISTRATION_DONE_LINK
} from '@lib/registration/confirmRegistration.mjs'

/** Where a throw nobody planned for sends the browser. */
export const ERROR_LINK = '/x/error'

/** What `confirmRegistration` is, seen from the handler: two strings in, nothing out, a throw for every refusal. */
type TConfirmRegistration = (uEmail: string, hash: string) => Promise<void>

/**
 * Turns one confirmation function into the Koa handler for its route.
 *
 * ⚠️ **The redirect contract is koa-utils' `createVerifyEmailRouter`, kept byte for byte**: success goes
 * to `/x/registration-done`, a refusal goes wherever the thrown message names, and anything else goes to
 * `/x/error`. The links in mail already sent point at these two routes and the three frontends already
 * serve those three pages — a handler that answered a status code instead would be correct and would
 * still break every registration in flight.
 *
 * ⚠️ **`isSafeRedirectTarget` is not interchangeable with an inline check.** The message being redirected
 * to is derived from a request parameter, so this is an open redirect unless something narrows it, and
 * `koa-utils.open-redirect.unvalidated` recognises *this function* as the sanitizer and nothing else —
 * `link.startsWith('/')` passes both semgrep and the suite while accepting `//evil.com`. Do not replace
 * it, and do not widen what it accepts.
 *
 * The address is lower-cased here because that is what every other entry point does with it
 * (`userRegister`, `shopOwnerRegister`, `userVerifyEmailResend`) and the pending key is derived from a
 * *deterministic* ciphertext — `Foo@bar.com` and `foo@bar.com` encrypt to two different keys, so a mail
 * client that capitalised the link would otherwise find no record and report a dead link.
 */
export const createConfirmRegistrationRouter =
	(confirmRegistration: TConfirmRegistration) =>
	async (ctx: RouterContext): Promise<void> => {
		const { email, hash } = ctx.params

		try {
			await confirmRegistration(email.toLowerCase().trim(), hash)

			ctx.redirect(REGISTRATION_DONE_LINK)
		} catch (err: unknown) {
			const link = (err as Error).message

			if (isSafeRedirectTarget(link)) {
				ctx.redirect(link)
			} else {
				ctx.redirect(ERROR_LINK)
			}
		}
	}

/** `GET /check/verify-email-user/:email/:hash`. */
export const routerConfirmUserRegistration = createConfirmRegistrationRouter(confirmUserRegistration)

/** `GET /check/verify-email/:email/:hash`. */
export const routerConfirmShopOwnerRegistration = createConfirmRegistrationRouter(confirmShopOwnerRegistration)
