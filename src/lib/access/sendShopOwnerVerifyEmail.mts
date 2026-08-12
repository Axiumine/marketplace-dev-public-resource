import { SocketLabsLib } from '@axiumine/koa-utils/email/SocketLabsLib'

/**
 * The router prefix (`/check`) plus the seller route, as one string.
 *
 * ⚠️ Keep this in step with `middleware/router/index.mts`. The router mounts the path; this is what
 * goes in the mail. Two literals in two files because nothing joins them at runtime — a change to one
 * and not the other produces a link that 404s and no error anywhere.
 */
export const SHOP_OWNER_VERIFY_LINK_PATH = '/check/verify-email'

/**
 * Sends the seller's activation link.
 *
 * ⚠️ **The two overridable parameters are passed explicitly even though both hold what koa-utils would
 * have defaulted to.** `SocketLabsLib` reads `APP_DOMAIN` at construction time and the shop owner's
 * link belongs on exactly that domain, so `sendEmailVerify(email, hash)` would send the same mail
 * today. It is spelled out anyway because the customer's sender next door overrides both, and a reader
 * comparing the two files has to be able to see that this one's defaults are a decision rather than the
 * parameters not having been noticed. It also survives the day a third audience makes `APP_DOMAIN` the
 * wrong default for somebody.
 *
 * The empty `name` is not a placeholder for a missing lookup: a self-registered seller has typed an
 * address and a password and nothing else — `personalData` is optional precisely so this mutation can
 * exist — so there is no name to greet them by until onboarding asks for one.
 */
export async function sendShopOwnerVerifyEmail(email: string, hash: string) {
	const SocketLabsObj = new SocketLabsLib()
	await SocketLabsObj.sendEmailVerify(email, hash, '', process.env.APP_DOMAIN, SHOP_OWNER_VERIFY_LINK_PATH)
}
