import { describe, expect, it, vi } from 'vitest'

const THROTTLE = { __sentinel: 'throttle' }
const THROTTLED_MAILER = { __sentinel: 'throttled' }
const SOCKET_LABS = { __sentinel: 'socketLabs' }

const createMailThrottle = vi.fn(() => THROTTLE)
const throttleMailer = vi.fn(() => THROTTLED_MAILER)

vi.mock('@axiumine/koa-utils/lib/access/createMailThrottle', () => ({ createMailThrottle }))
vi.mock('@axiumine/koa-utils/lib/access/verifyEmailMailer', () => ({
	socketLabsVerifyEmailMailer: SOCKET_LABS,
	throttleMailer
}))

const { registrationMailer } = await import('../src/lib/registration/registrationMailer.mts')

describe('registrationMailer', () => {
	// ⚠️ **The debounce is the reason this module exists rather than a `new SocketLabsLib()` at each call
	// site**, which is what the flows it replaced did. Three of these notifications are reachable from an
	// unauthenticated `GET` and two from an unauthenticated mutation, so an undebounced mailer lets anybody
	// who knows a registered address make the platform's own SocketLabs account mail its owner once per
	// request — a mail bomb aimed at a third party, out of a request nobody had to authenticate.
	it('is SocketLabs behind a throttle', () => {
		expect(throttleMailer).toHaveBeenCalledExactlyOnceWith(SOCKET_LABS, THROTTLE)
		expect(registrationMailer).toBe(THROTTLED_MAILER)
	})

	// ⚠️ **One window for the process, shared by submit, confirm and resend.** `createMailThrottle` keeps
	// its state per instance, so a throttle built per call site — or per request — would be three separate
	// windows for one address, and the debounce would let three of every burst through.
	it('builds exactly one throttle', () => {
		expect(createMailThrottle).toHaveBeenCalledExactlyOnceWith()
	})

	// The module is a value, not a factory, so importing it twice cannot produce two throttles. This is the
	// same assertion from the consumers' side: every call site shares the instance the first import built.
	it('hands every importer the same instance', async () => {
		const again = await import('../src/lib/registration/registrationMailer.mts')

		expect(again.registrationMailer).toBe(registrationMailer)
		expect(throttleMailer).toHaveBeenCalledOnce()
	})
})
