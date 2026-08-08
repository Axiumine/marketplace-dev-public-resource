import { Context } from 'koa'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisClient = { __sentinel: 'redisClient' }
const assertUnderRateLimit = vi.fn()
const assertTurnstile = vi.fn()

vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient }))
vi.mock('@axiumine/marketplace-common/others/assertUnderRateLimit', () => ({ assertUnderRateLimit }))
vi.mock('@axiumine/marketplace-common/others/assertTurnstile', () => ({ assertTurnstile }))

const { guardPublicWrite, RATE_WINDOW_SECONDS } = await import('../src/lib/access/guardPublicWrite.mts')

const ctx = { ip: '203.0.113.7' } as Context

const args = {
	bucket: 'userRegister',
	email: 'customer@marketplace.test',
	turnstileToken: 'cf-token',
	perIpPerHour: 10,
	perEmailPerHour: 3
}

beforeEach(() => vi.clearAllMocks())

describe('guardPublicWrite', () => {
	it('meters over one hour', () => {
		expect(RATE_WINDOW_SECONDS).toBe(3600)
	})

	// ⚠️ **Two counters, not one, and they are separate buckets.** The per-IP limit bounds a single
	// source enumerating addresses; the per-email limit bounds a distributed source mail-bombing one
	// inbox. Either alone leaves the other attack unmetered, and exhausting one must never consume the
	// other — which is why the key suffixes differ and both are asserted.
	it('meters the caller’s IP and the target address in separate buckets', async () => {
		await guardPublicWrite(ctx, args)

		expect(assertUnderRateLimit).toHaveBeenCalledTimes(2)
		expect(assertUnderRateLimit).toHaveBeenNthCalledWith(1, redisClient, 'userRegister:ip', '203.0.113.7', 10, 3600)
		expect(assertUnderRateLimit).toHaveBeenNthCalledWith(
			2,
			redisClient,
			'userRegister:email',
			'customer@marketplace.test',
			3,
			3600
		)
	})

	// The bucket name is the caller's, so the four public writes never share a counter: burning the
	// resend allowance must not spend the registration one.
	it('names the counters after the caller’s bucket', async () => {
		await guardPublicWrite(ctx, { ...args, bucket: 'userVerifyEmailResend' })

		expect(assertUnderRateLimit.mock.calls.map((call) => call[1])).toEqual([
			'userVerifyEmailResend:ip',
			'userVerifyEmailResend:email'
		])
	})

	// ⚠️ **Rate limit first, captcha second**, and the order is a cost decision rather than taste:
	// verifying a Turnstile token is an outbound HTTPS round trip to Cloudflare, so checking it first
	// would let a flood of tokenless requests each cost this process a connection. One Redis `INCR`
	// refuses them for nothing.
	it('checks the counters before it spends a round trip on Cloudflare', async () => {
		await guardPublicWrite(ctx, args)

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith('cf-token', '203.0.113.7')
		expect(assertUnderRateLimit.mock.invocationCallOrder[0]).toBeLessThan(assertTurnstile.mock.invocationCallOrder[0])
		expect(assertUnderRateLimit.mock.invocationCallOrder[1]).toBeLessThan(assertTurnstile.mock.invocationCallOrder[0])
	})

	it('does not reach Cloudflare at all once a counter has refused', async () => {
		assertUnderRateLimit.mockRejectedValueOnce(new Error('Too many requests'))

		await expect(guardPublicWrite(ctx, args)).rejects.toThrow('Too many requests')

		expect(assertUnderRateLimit).toHaveBeenCalledOnce()
		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	// The email counter is checked too, not only started: a refusal there has to stop the request
	// exactly as the IP one does, or the mail-bombing bound is decorative.
	it('stops on the per-address counter as well', async () => {
		assertUnderRateLimit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Too many requests'))

		await expect(guardPublicWrite(ctx, args)).rejects.toThrow('Too many requests')

		expect(assertTurnstile).not.toHaveBeenCalled()
	})

	// A missing token is Cloudflare's call, not this function's: `assertTurnstile` is what knows
	// whether the platform is configured to require one, and duplicating that decision here would let
	// the two disagree.
	it('forwards an absent token rather than deciding about it', async () => {
		await guardPublicWrite(ctx, { ...args, turnstileToken: undefined })

		expect(assertTurnstile).toHaveBeenCalledExactlyOnceWith(undefined, '203.0.113.7')
	})

	// `ctx.ip` is Koa's, so it honours `app.proxy` and `X-Forwarded-For`; with `app.proxy` off — the
	// current setting — it is the socket address and cannot be spoofed. Neither configuration lets a
	// caller pick its own bucket, which is the only property that matters here.
	it('reads the address off the Koa context, for both the counter and the captcha', async () => {
		await guardPublicWrite({ ip: '198.51.100.4' } as Context, args)

		expect(assertUnderRateLimit.mock.calls[0][2]).toBe('198.51.100.4')
		expect(assertTurnstile.mock.calls[0][1]).toBe('198.51.100.4')
	})
})
