import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertTurnstile } from '@thedoctorweb_agency/marketplace-common/others/assertTurnstile'
import { assertUnderRateLimit } from '@thedoctorweb_agency/marketplace-common/others/assertUnderRateLimit'
import { Context } from 'koa'

/** One hour, in seconds — the window every public write on this service is metered over. */
export const RATE_WINDOW_SECONDS = 3600

export interface IGuardPublicWriteArgs {
	/** Names the Redis counters. Two keys are derived from it, `<bucket>:ip` and `<bucket>:email`. */
	bucket: string
	/** Already lowercased and trimmed by the caller — otherwise `A@x.it` and `a@x.it` meter separately. */
	email: string
	turnstileToken?: string
	perIpPerHour: number
	perEmailPerHour: number
}

/**
 * The gate in front of every unauthenticated mutation that writes a row or sends a mail.
 *
 * **Rate limit first, captcha second.** Verifying a Turnstile token is an outbound HTTPS round trip to
 * Cloudflare, so checking it before the counter would let a flood of tokenless requests each cost this
 * process a connection. The counter is one Redis `INCR`. Refusing early is also the cheaper answer for
 * the caller that is merely retrying.
 *
 * **Two counters, not one.** The per-IP limit bounds a single source enumerating addresses; the
 * per-email limit bounds a distributed source mail-bombing one inbox. Either alone leaves the other
 * attack unmetered, and they are separate buckets so exhausting one never consumes the other.
 *
 * ⚠️ The per-email counter means one address can be locked out of registering for an hour by somebody
 * else — a targeted denial of service, accepted knowingly. The alternative is worse: without it, an
 * attacker with a botnet turns this service into a mail relay pointed at any inbox they choose, and
 * SocketLabs' reputation, not just this platform's, pays for it. An hour of "try again later" against
 * an unbounded flood of activation mail is not a close call.
 *
 * `ctx.ip` is Koa's, so it honours `app.proxy` and `X-Forwarded-For`. Behind the nginx in
 * `marketplace-user/docs/nginx/` that header is set by the proxy and stripped from the client request;
 * with `app.proxy` off — the default, and the current setting — it is the socket address and cannot be
 * spoofed at all. Neither configuration lets a caller pick its own bucket, which is the only property
 * that matters here.
 */
export async function guardPublicWrite(ctx: Context, args: IGuardPublicWriteArgs) {
	const { bucket, email, turnstileToken, perIpPerHour, perEmailPerHour } = args

	await assertUnderRateLimit(redisClient, `${bucket}:ip`, ctx.ip, perIpPerHour, RATE_WINDOW_SECONDS)
	await assertUnderRateLimit(redisClient, `${bucket}:email`, email, perEmailPerHour, RATE_WINDOW_SECONDS)

	await assertTurnstile(turnstileToken, ctx.ip)
}
