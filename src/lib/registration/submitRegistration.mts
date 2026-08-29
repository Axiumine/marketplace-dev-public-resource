import { emailHash } from '@axiumine/koa-utils/lib/emailHash'
import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { pendingSlot, writePendingRegistration } from '@lib/registration/pendingRegistration.mjs'
import { registrationMailer } from '@lib/registration/registrationMailer.mjs'
import {
	EMAIL_PATH,
	type IRegistrationTarget,
	REGISTRATION_TARGET_SHOP_OWNER,
	REGISTRATION_TARGET_USER
} from '@lib/registration/registrationTargets.mjs'
import { Types } from 'mongoose'

/** The one field the submit branches on. Not the account: nothing here needs `login.password` in scope. */
interface IAccountLiveness {
	deleted?: Date
}

/**
 * Takes a registration as far as the pending record, and stops there.
 *
 * ⚠️ **Nothing is written to MongoDB, on any branch.** That is the decision of ADR-042 and it is what
 * makes ADR-041's window honourable *as specified*: the owner asked that a closed account's address be
 * reclaimed "when he will click the link to confirm the email, **not before that**", and an anonymous form
 * post is not a click. Until somebody proves they can read mail at the address, the only thing this flow
 * has created is a Redis key that expires on its own.
 *
 * The three answers, and the branch order:
 *
 * | What MongoDB holds for that address | What happens |
 * |---|---|
 * | a live document | the *"you are already registered"* mail. Nothing is written |
 * | a document with `deleted` stamped | the pending record is written and the link sent. The closed document is **not touched** |
 * | nothing | the pending record is written and the link sent |
 *
 * ⚠️ **The caller answers `true` in all three cases**, which is the security property rather than
 * laziness: a mutation that answers differently for a taken address is an account-enumeration oracle
 * anybody may query one address at a time. The outcomes are distinguishable only in the inbox, so the
 * person who owns the address learns everything and the person who does not learns nothing.
 *
 * ⚠️ **A pending record already existing is not a fourth case.** The submit overwrites the same key and
 * refreshes its TTL — idempotent because it is one key — which is also how somebody who never received the
 * first mail recovers by simply submitting the form again. `guardPublicWrite` bounds that at three per
 * hour, per address, in front of all of it.
 *
 * ⚠️ **There is no longer a branch for an unverified document, because there is no longer such a
 * document.** That branch is what the two `restart*Registration` modules, now deleted,
 * existed for, and the shop owner's got it wrong: it revived an admin-closed account through an
 * unauthenticated mutation, with a caller-supplied password, without restoring `waitApprov`. ADR-042 fixes
 * it by deletion. A document that predates that change and is still sitting unverified reads as live here
 * and gets the already-registered mail; there are none outside development, and the recovery is the same
 * one it always was — the operator.
 */
export const createSubmitRegistration = (target: IRegistrationTarget) =>
	async function submitRegistration(uEmail: string, password: string): Promise<void> {
		// No liveness filter on the read, for the reason the deleted `userForRegistration` gave before it: a closed
		// document still occupies the address, so the branch has to see it rather than have it filtered
		// away. `login.email` is deterministically encrypted, which is what makes this `$eq` a lookup.
		const existing = await target.model.findOne({ [EMAIL_PATH]: uEmail }, 'deleted').lean<IAccountLiveness>()

		if (existing !== null && existing.deleted === undefined) {
			await registrationMailer.emailAlreadyValid(uEmail)

			return
		}

		const slot = await pendingSlot(target, uEmail)
		const hash = emailHash()
		const now = new Date()

		// bcrypt here rather than at confirm, so the plaintext password never outlives the request that
		// carried it. The account is opened with `insertMany`, which runs no `save` middleware — so
		// `LoginSubDocSchema`'s hashing hook does not fire there and this value lands in `login.password`
		// exactly as it is. Hashing in both places is what stored `bcrypt(bcrypt(password))` in E18-S09.
		await writePendingRegistration(slot, {
			_id: new Types.ObjectId(),
			password: await encryptPassword(password),
			hash,
			registeredAt: now,
			dateLastReq: now,
			requestTimes: 1
		})

		await target.sendVerifyEmail(uEmail, hash)
	}

/** Bound to `user`, for `userRegister`. */
export const submitUserRegistration = createSubmitRegistration(REGISTRATION_TARGET_USER)

/** Bound to `shopOwner`, for `shopOwnerRegister`. */
export const submitShopOwnerRegistration = createSubmitRegistration(REGISTRATION_TARGET_SHOP_OWNER)
