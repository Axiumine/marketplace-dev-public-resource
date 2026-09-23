import { emailHash } from '@axiumine/koa-utils/lib/emailHash'
import { pendingSlot, readPendingRegistration, renewPendingRegistration } from '@lib/registration/pendingRegistration.mjs'
import { type IRegistrationTarget, REGISTRATION_TARGET_USER } from '@lib/registration/registrationTargets.mjs'

/**
 * Issues a fresh link for a registration that is still pending.
 *
 * It exists because a mail can be written and still never arrive — SocketLabs refuses it, the address
 * bounces, the inbox eats it — and because the link stops working when the record expires.
 *
 * ⚠️ **No record means nothing happens, and that is the whole of it.** In the old flow this branch had to
 * think: a document could be there and verified, or there and tombstoned, and reviving a tombstone from an
 * argument list carrying no password would have let anybody keep somebody else's abandoned registration
 * alive for ever. None of that survives — a pending registration is a Redis key or it is not, and once it
 * is gone (confirmed, expired, or spent on five wrong hashes) the only way forward is to register again,
 * which is the path that proves who is asking by setting a password only the new mail can activate.
 *
 * ⚠️ **The record is read before it is written, and the write is what actually decides.** The read exists
 * so an address with nothing pending costs one `HGETALL` and mails nothing; it is not what makes the
 * renewal safe. `renewPendingRegistration` runs its own existence check in the same script as the write,
 * so a confirmation that deletes the key in the gap between this read and that write leaves the renewal
 * refusing rather than resurrecting a three-field ghost record — no `_id`, no address, no password — that
 * would otherwise sit there looking like a valid link for three days. The mail below is sent only when the
 * write reports it actually renewed something, never on the strength of the read alone.
 *
 * ⚠️ **Answers nothing either way**, and the caller answers `true` for every address. A mutation that
 * behaved differently for an address that is registered is an enumeration oracle, and one that costs
 * nothing to call is a good one.
 *
 * The renewal resets the strike counter along with the hash, which is right: those strikes counted
 * attempts against a hash that no longer opens anything.
 */
export const createResendRegistration = (target: IRegistrationTarget) =>
	async function resendRegistration(uEmail: string): Promise<void> {
		const slot = await pendingSlot(target, uEmail)

		if ((await readPendingRegistration(slot.key)) === null) {
			return
		}

		const hash = emailHash()

		if (!(await renewPendingRegistration(slot, hash, new Date()))) {
			return
		}

		await target.sendVerifyEmail(uEmail, hash)
	}

/**
 * Bound to `user`.
 *
 * There is no shop-owner twin, and none is missing: that tier's form has no resend button, and submitting
 * the registration again is its recovery — which lands on the same key, mints a new hash and re-arms the
 * window (ADR-042).
 */
export const resendUserRegistration = createResendRegistration(REGISTRATION_TARGET_USER)
