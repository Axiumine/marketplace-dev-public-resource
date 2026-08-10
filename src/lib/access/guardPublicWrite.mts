import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { assertTurnstile } from '@axiumine/marketplace-common/others/assertTurnstile'
import { assertUnderRateLimit } from '@axiumine/marketplace-common/others/assertUnderRateLimit'

/** One hour, in seconds — the window every public write on this service is metered over. */
export const RATE_WINDOW_SECONDS = 3600

export interface IGuardPublicWriteArgs {
	/** Names the Redis counter. One key is derived from it, `<bucket>:email`. */
	bucket: string
	/**
	 * Already lowercased and trimmed by the caller — otherwise `A@x.it` and `a@x.it` meter separately.
	 *
	 * ⚠️ **Nothing shows you when that is forgotten any more.** The address used to be readable in the
	 * Redis key, so a stray capital was visible to anyone looking at the counters; it is hashed now, and
	 * two spellings simply produce two unrelated digests and two budgets nobody can tell apart.
	 */
	email: string
	turnstileToken?: string
	perEmailPerHour: number
}

/**
 * The gate in front of every unauthenticated mutation that writes a document or sends a mail.
 *
 * **Rate limit first, captcha second.** Verifying a Turnstile token is an outbound HTTPS round trip to
 * Cloudflare, so checking it before the counter would let a flood of tokenless requests each cost this
 * process a connection. The counter is one Redis `INCR`. Refusing early is also the cheaper answer for
 * the caller that is merely retrying.
 *
 * ⚠️ **The per-address half of the limit is nginx's, and this process cannot do it.** `app.proxy` is off
 * and stays off — a test pins it — so the address Koa reports here is the proxy's, never the visitor's.
 * The counter this guard used to keep against it was therefore **one global bucket**: the 21st
 * registration attempt in an hour, from anybody at all, was refused. The edge meters per client address
 * instead (`conf.d/20-rate-limit.conf`), which is the only layer that has one to meter.
 *
 * **The per-email counter is the half no nginx zone can express** — a zone keyed on the address never
 * sees the inbox a distributed source is mail-bombing, which is exactly the attack this bounds.
 *
 * ⚠️ The per-email counter means one address can be locked out of registering for an hour by somebody
 * else — a targeted denial of service, accepted knowingly. The alternative is worse: without it, an
 * attacker with a botnet turns this service into a mail relay pointed at any inbox they choose, and
 * SocketLabs' reputation, not just this platform's, pays for it. An hour of "try again later" against
 * an unbounded flood of activation mail is not a close call.
 */
export async function guardPublicWrite(args: IGuardPublicWriteArgs) {
	const { bucket, email, turnstileToken, perEmailPerHour } = args

	await assertUnderRateLimit(redisClient, `${bucket}:email`, email, perEmailPerHour, RATE_WINDOW_SECONDS)

	await assertTurnstile(turnstileToken)
}
