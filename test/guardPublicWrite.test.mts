import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisClient = { __sentinel: 'redisClient' }
const assertUnderRateLimit = vi.fn()
const assertTurnstile = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))
vi.mock('@axiumine/marketplace-common/others/assertUnderRateLimit', () => ({ assertUnderRateLimit }))
vi.mock('@axiumine/marketplace-common/others/assertTurnstile', () => ({ assertTurnstile }))

const { guardPublicWrite, RATE_WINDOW_SECONDS } = await import('../src/lib/access/guardPublicWrite.mts')

const args = {
	bucket: 'userRegister',
	email: 'customer@marketplace.test',
	turnstileToken: 'cf-token',
	perEmailPerHour: 3
}

beforeEach(() => vi.clearAllMocks())

describe('guardPublicWrite', () => {
	it('meters over one hour', () => {
		expect(RATE_WINDOW_SECONDS).toBe(3600)
	})

	// ⚠️ **One counter, and it is the per-address one** — the half no nginx zone can express, since a
	// zone keyed on the client address never sees the inbox a distributed source is mail-bombing. The
	// other half is the edge's for the opposite reason: `app.proxy` is off, so the address reachable in
	// this process is nginx's own and a counter kept against it metered the whole platform at once.
	it('meters the target address in a bucket named after the caller', async () => {
		await guardPublicWrite(args)

		expect(assertUnderRateLimit).toHaveBeenCalledExactlyOnceWith(
			redisClient,
			'userRegister:email',
			'customer@marketplace.test',
			3,
			3600
		)
	})

	// The bucket name is the caller's, so the four public writes never share a counter: burning the
	// resend allowance must not spend the registration one.
	it('names the counter after the caller’s bucket', async () => {
		await guardPublicWrite({ ...args, bucket: 'userVerifyEmailResend' })

		expect(assertUnderRateLimit.mock.calls.map((call) => call[1])).toEqual(['userVerifyEmailResend:email'])
	})

	// ⚠️ **Rate limit first, captcha second**, and the order is a cost decision rather than taste:
	// verifying a Turnstile token is an outbound HTTPS round trip to Cloudflare, so checking it first
	// would let a flood of tokenless requests each cost this process a connection. One Redis `INCR`
	// refuses them for nothing.
	it('checks the counter before it spends a round trip on Cloudflare', async () => {
		await guardPublicWrite(args)

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith('cf-token')
		expect(assertUnderRateLimit.mock.invocationCallOrder[0]).toBeLessThan(assertTurnstile.mock.invocationCallOrder[0])
	})

	it('does not reach Cloudflare at all once the counter has refused', async () => {
		assertUnderRateLimit.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(guardPublicWrite(args)).rejects.toThrow('Too many requests')

		expect(assertUnderRateLimit).toHaveBeenCalledOnce()
		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	// A missing token is Cloudflare's call, not this function's: `assertTurnstile` is what knows
	// whether the platform is configured to require one, and duplicating that decision here would let
	// the two disagree.
	it('forwards an absent token rather than deciding about it', async () => {
		await guardPublicWrite({ ...args, turnstileToken: undefined })

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(undefined)
	})

	// ⚠️ **The caller's address is not read here and must not come back.** `ctx.ip` honours `app.proxy`,
	// which is off — so it is the socket address of nginx, identical for every visitor. Both the counter
	// this guard used to keep against it and the `remoteip` it used to forward to siteverify were
	// therefore platform-wide rather than per-caller. Neither argument exists any more.
	it('passes the limiter and the captcha the address and the token only', async () => {
		await guardPublicWrite(args)

		expect(assertUnderRateLimit.mock.calls[0][2]).toBe('customer@marketplace.test')
		expect(assertTurnstile.mock.calls[0]).toHaveLength(1)
	})
})
