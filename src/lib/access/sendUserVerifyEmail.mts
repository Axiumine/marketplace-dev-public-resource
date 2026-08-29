import { SocketLabsLib } from '@axiumine/koa-utils/email/SocketLabsLib'

/**
 * The router prefix (`/check`) plus the customer route, as one string.
 *
 * ⚠️ Keep this in step with `middleware/router/index.mts`. The router mounts the path; this is what
 * goes in the mail. They are two literals in two files because the mail is built from
 * `APP_DOMAIN_USER` and the route is mounted on this service — nothing joins them at runtime, so a
 * change to one and not the other produces a link that 404s and no error anywhere.
 */
export const USER_VERIFY_LINK_PATH = '/check/verify-email-user'

/**
 * Sends the customer's activation link.
 *
 * ⚠️ **`APP_DOMAIN_USER`, not `APP_DOMAIN`.** This one process serves two audiences: the shop owner's
 * link points at the admin-facing domain that `SocketLabsLib` reads from `APP_DOMAIN` at
 * construction time, and the customer's must point at the storefront. koa-utils 5.8.0 added the
 * `linkBase` / `linkPath` parameters for exactly this — before it, one process could only ever send one
 * domain's links, and the choice was made when the object was built rather than when the mail was sent.
 *
 * With `APP_DOMAIN_USER` unset the call falls back to `APP_DOMAIN`, so a misconfigured environment
 * sends a *working* link on the wrong domain rather than a broken one — the failure is visible to
 * whoever clicks it and costs nobody their registration. The variable is in the `env` template for the
 * same reason every other one is: the template is the only place the intended set is written down.
 */
export async function sendUserVerifyEmail(email: string, hash: string) {
	const SocketLabsObj = new SocketLabsLib()
	await SocketLabsObj.sendEmailVerify(email, hash, '', process.env.APP_DOMAIN_USER, USER_VERIFY_LINK_PATH)
}
