import {
	deletePendingRegistration,
	type IPendingRegistration,
	MAX_VERIFY_ATTEMPTS,
	pendingSlot,
	readPendingRegistration,
	strikePendingRegistration
} from '@lib/registration/pendingRegistration.mjs'
import { registrationMailer } from '@lib/registration/registrationMailer.mjs'
import {
	EMAIL_PATH,
	type IRegistrationTarget,
	REGISTRATION_TARGET_SHOP_OWNER,
	REGISTRATION_TARGET_USER
} from '@lib/registration/registrationTargets.mjs'
import mongoose, { type ClientSession, type Types } from 'mongoose'

/**
 * Where every refusal sends the browser.
 *
 * ⚠️ **One destination for all of them, and that is the design.** Dead link, expired record, wrong hash,
 * five strikes spent — the page is the same, because the difference is only ever visible to somebody who
 * can read the mailbox. koa-utils' `EMAIL_CHECK_LINK` said the same thing at the same address; the literal
 * is repeated here rather than imported because that constant lives under the package's `dist/private/`,
 * outside its exports map.
 */
export const EMAIL_CHECK_LINK = '/x/email-check'

/** Where a confirmed registration sends the browser. */
export const REGISTRATION_DONE_LINK = '/x/registration-done'

/** What the address lookup projects: who holds it, whether they are closed, and what they log in with. */
interface IAddressHolder {
	_id: Types.ObjectId
	deleted?: Date
	login: { password: string }
}

/**
 * The account document, exactly as the record carries it.
 *
 * `emailVerify` keeps only `valid`, which is what the old flow's `verifyClear` unset the other three paths
 * to arrive at — the hash, the window and the strike counter were the pending state, and the pending state
 * was the Redis key. `waitApprov` is written here or nowhere, so no path can open a shop-owner account
 * that skips the approval gate.
 */
function accountDocument(target: IRegistrationTarget, record: IPendingRegistration) {
	return {
		_id: record._id,
		login: { email: record.email, password: record.password },
		registeredAt: record.registeredAt,
		emailVerify: { valid: true },
		...(target.waitApprov ? { waitApprov: true } : {})
	}
}

/**
 * The update that hands a closed account back to the person who closed it (ADR-046).
 *
 * ⚠️ **`registeredAt` and `_id` are deliberately not in it.** The whole point of an undo is that this is the
 * *same* account: the id every `company.idShopOwner` and every `address` still points at, and the date the
 * person actually joined. A restore that minted either would be a new account wearing an old one's data.
 *
 * ⚠️ **`waitApprov` goes back up on the seller tier, by the platform owner's ruling of 2026-08-29** — *"the
 * state of waitApprove is true, so admin can not approve the user if it is a problem"*. A closure is the
 * platform's last look at an account, so coming back is re-entry through the same door a first registration
 * uses, and an operator who closed a seller for cause simply never approves the account again. It is also
 * the only human checkpoint on the recycled-mailbox risk this flow carries; the customer tier has no
 * equivalent because it has no approval gate at all.
 *
 * ⚠️ **`disabled` is untouched, and a suspended-then-closed account comes back suspended.** Only the Admin
 * tier lifts a suspension (ADR-044), and an undo performed by the subject must not be a way around one.
 *
 * `login.password` becomes the one just submitted: the person proved they can read mail at the address and
 * chose a password doing it, which is exactly what a reset proves. The old hash is not kept — nothing may
 * outlive the closure that could be used to log in as the account before this moment.
 */
function restoreUpdate(target: IRegistrationTarget, record: IPendingRegistration) {
	return {
		$set: {
			'login.password': record.password,
			emailVerify: { valid: true },
			...(target.waitApprov ? { waitApprov: true } : {})
		},
		$unset: { deleted: '', deletedBy: '' }
	}
}

/**
 * Who holds this address right now, projected to the three things the decisions below need: which
 * document it is, whether it is closed, and what it logs in with.
 *
 * ⚠️ **No `deleted` clause in the filter, deliberately.** The address is the only value either collection
 * indexes uniquely (ADR-011: no `partialFilterExpression`, no `sparse`), so *whoever* holds it is the
 * answer, and narrowing to the closed ones would hide the live holder that every replay and every race
 * turns on. `record.email` is already the deterministic ciphertext the index is built over, so this is a
 * point lookup and never a scan.
 *
 * The session is passed explicitly rather than defaulted: the transaction body wants the read inside the
 * transaction, and the recovery path below wants it emphatically outside one.
 */
function findAddressHolder(target: IRegistrationTarget, record: IPendingRegistration, session: ClientSession | null) {
	return target.model
		.findOne({ [EMAIL_PATH]: record.email }, '_id deleted login.password')
		.session(session)
		.lean<IAddressHolder>()
}

/**
 * True when the holder this registration was trying to produce is already there.
 *
 * The credential is the discriminator, and it works the same for both writes: `login.password` is the
 * record's bcrypt hash byte for byte only if *this* registration is what put it there — `insertMany` runs
 * no `save` middleware and the restore `$set`s the same string, while two registrations at one address
 * hash to different values, salts being what they are. A closed holder is not it: whatever landed, it was
 * not the restore.
 */
function isOurs(holder: IAddressHolder | null, record: IPendingRegistration): boolean {
	return holder !== null && holder.deleted === undefined && holder.login.password === record.password
}

/**
 * Opens the account this confirmation is for, and answers whether it wrote anything.
 *
 * ⚠️ **A closed account holding this address is restored, never replaced (ADR-046).** Within the retention
 * window the document still holds everything — the platform owner's window *is* the undo window — so the
 * confirmation clears `deleted` and hands the account back with its id, its history and its shops. The
 * ADR-041 scrub is what makes this window finite, and it now has exactly one caller: the day-30 sweep. A
 * scrubbed document can never be found here, because scrubbing is precisely what moves the address off it.
 *
 * ⚠️ **A live holder that is not this registration's doing throws**, and the caller answers the
 * check-your-mail page. It is the two-people-one-address race — both submitted before either clicked — and
 * the loser must not be told which of the two they are, nor handed somebody else's account.
 *
 * ⚠️ **The recovery read is what makes this idempotent, and it covers both writes.** The confirm step spans
 * Redis and MongoDB and can only be idempotent, not atomic: a crash between the commit and the `DEL`
 * replays the whole transaction, and a commit whose acknowledgement was lost reports an error over work
 * that landed. Only the collection can say which happened, so the recovery asks it the same question the
 * body asked and reads the answer with `isOurs`. An `_id` check would only have covered the insert — a
 * restore mints no id — and would have failed a lost-ack restore that had in fact succeeded.
 *
 * @returns `true` when this call opened an account or handed one back, `false` when it was a replay of a
 * confirmation that had already done so. Opened and restored are one answer on purpose: the welcome mail is
 * the same either way, and telling the two apart would say what the platform still holds about an address.
 */
async function openAccount(target: IRegistrationTarget, record: IPendingRegistration): Promise<boolean> {
	const session = await mongoose.startSession()
	let wrote = true

	try {
		await session.withTransaction(async () => {
			const holder = await findAddressHolder(target, record, session)

			if (holder === null) {
				await target.model.insertMany([accountDocument(target, record)], { session })

				return
			}

			if (holder.deleted !== undefined) {
				await target.model.updateOne({ _id: holder._id }, restoreUpdate(target, record), {
					session,
					runValidators: true
				})

				return
			}

			if (!isOurs(holder, record)) {
				throw new Error(EMAIL_CHECK_LINK)
			}

			wrote = false
		})
	} catch (e: unknown) {
		if (!isOurs(await findAddressHolder(target, record, null), record)) {
			throw e
		}

		return false
	} finally {
		await session.endSession()
	}

	return wrote
}

/**
 * Turns a confirmation link into an account. The only writer of a `user` or a `shopOwner` document on this
 * service.
 *
 * Every refusal throws `EMAIL_CHECK_LINK` and the handler above redirects to it, which is the contract
 * koa-utils' `router/verifyEmail.mts` had and this replaces byte for byte at the same three addresses.
 *
 * The guards, in koa-utils' own order:
 *
 * 1. **no record** — expired, never written, or already consumed. The link is dead;
 * 2. **five strikes spent** — the record is destroyed and its owner told, because at that point the link
 *    is being guessed at rather than clicked;
 * 3. **wrong hash** — one strike, and a mail naming the strike this attempt made.
 *
 * ⚠️ **The three-day guard is gone and is not missing.** It was a comparison run lazily on a visit, so a
 * registration nobody visited was never abandoned and held its address for ever; the window is now the
 * key's TTL, and an abandoned registration simply stops existing (ADR-042).
 *
 * ⚠️ **A strike must not re-arm the TTL** — see `strikePendingRegistration`. Guessing at somebody else's
 * link spends their attempts; it does not extend their window.
 *
 * ⚠️ **The key is deleted after the transaction, never before it.** Deleting first would turn any failure
 * of the write into a registration that cannot be retried and cannot be recovered — the person would have
 * to start again with an address that a closed account may still be holding.
 *
 * ⚠️ **Inside the retention window this flow is the undo, and it is the only one (ADR-046).** There is no
 * "restore my account" login and there cannot be one: a closed account is refused at the login gate, so the
 * person has no session from which to ask. Signing up again at the same address is the request, and the
 * activation link is the proof — the same proof a password reset accepts.
 */
export const createConfirmRegistration = (target: IRegistrationTarget) =>
	async function confirmRegistration(uEmail: string, hash: string): Promise<void> {
		const slot = await pendingSlot(target, uEmail)
		const record = await readPendingRegistration(slot.key)

		if (record === null) {
			throw new Error(EMAIL_CHECK_LINK)
		}

		if (record.requestTimes >= MAX_VERIFY_ATTEMPTS) {
			await deletePendingRegistration(slot.key)
			await registrationMailer.tooMuchVerifyRequests(uEmail)

			throw new Error(EMAIL_CHECK_LINK)
		}

		if (record.hash !== hash) {
			await strikePendingRegistration(slot.key)
			await registrationMailer.wrongHash(uEmail, record.requestTimes + 1)

			throw new Error(EMAIL_CHECK_LINK)
		}

		// A replay whose first run already committed sends no second welcome mail: it is the same account
		// being confirmed twice, and the person read the first one.
		if (await openAccount(target, record)) {
			await registrationMailer.sendWelcome(uEmail)
		}

		await deletePendingRegistration(slot.key)
	}

/** Bound to `user`, for `GET /check/verify-email-user/:email/:hash`. */
export const confirmUserRegistration = createConfirmRegistration(REGISTRATION_TARGET_USER)

/** Bound to `shopOwner`, for `GET /check/verify-email/:email/:hash`. */
export const confirmShopOwnerRegistration = createConfirmRegistration(REGISTRATION_TARGET_SHOP_OWNER)
