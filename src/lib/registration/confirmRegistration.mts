import { buildAccountScrub } from '@axiumine/marketplace-common/others/accountScrub'
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
import type { Binary } from 'mongodb'
import mongoose, { type ClientSession, trusted, type Types } from 'mongoose'

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

/** The one field the closed-holder lookup projects. */
interface IClosedHolder {
	_id: Types.ObjectId
}

/**
 * Frees the address, if a closed account is still holding it, by overwriting rather than removing.
 *
 * This is ADR-041's retention scrub brought forward: the sweep would run it on day 30, and this runs it at
 * the moment somebody proves they can read mail at the address, which is earlier than the retention rule
 * requires rather than later. `buildAccountScrub` is the *same* update in both places by construction —
 * a hand-written second copy is how a field added to `user` survives one of the two paths in silence.
 *
 * ⚠️ **`deleted` is in the filter, not merely checked by the caller.** A live document holding this
 * address never reaches here, because submit answered *"already registered"* and wrote no pending record —
 * but the guard that matters is the one a future caller cannot skip by reading a branch wrongly. With it,
 * a live account is not scrubbed and the insert below fails on `login.email_unique`, loudly.
 *
 * `trusted()` because `sanitizeFilter` is on globally: a bare `{ $exists: true }` is cast to a literal to
 * match against, which matches nothing at all — so the scrub would silently skip and the insert would then
 * fail on the unique index. It fails safe, but it fails.
 *
 * ⚠️ **This runs before the insert and inside the same transaction, and the order is load bearing.**
 * MongoDB enforces a unique index at each write rather than at commit, so the address has to have moved to
 * `deleted-<id>@invalid.local` before the new document claims it.
 */
async function scrubClosedHolder(target: IRegistrationTarget, email: Binary, session: ClientSession): Promise<void> {
	const closed = await target.model
		.findOne({ [EMAIL_PATH]: email, deleted: trusted({ $exists: true }) }, '_id')
		.session(session)
		.lean<IClosedHolder>()

	if (closed === null) {
		return
	}

	await target.model.updateOne({ _id: closed._id }, buildAccountScrub(target.tier, `${closed._id}`, new Date()), {
		session,
		runValidators: true
	})
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
 * Reclaims the address and opens the account, in one transaction. Answers whether this call is the one
 * that did it.
 *
 * ⚠️ **`insertMany`, not `create`.** `LoginSubDocSchema`'s `pre('save')` bcrypts `password` whenever the
 * path is modified, and `create` routes through `save` — so a `create` here would store
 * `bcrypt(bcrypt(password))` and open an account that can never log in. `insertMany` runs no `save`
 * middleware and still runs `pre('insertMany')`, whose encryption pass is idempotent over the `Binary` the
 * record carries. **Which rule applies is decided by the write operator, never by the field.**
 *
 * ⚠️ **A failure is not necessarily a failure.** The confirm step spans Redis and MongoDB and can only be
 * idempotent, not atomic: a crash between the commit and the `DEL` leaves a live key over a live account,
 * and the replay re-runs this transaction. The pre-minted `_id` is what makes that knowable — the insert
 * fails on the duplicate, and an account carrying *this record's* `_id` can only have been written by an
 * earlier run of this same confirmation. So the error is swallowed exactly when that document is there,
 * and rethrown when it is not.
 *
 * The check is a read rather than an inspection of the driver's error, and that is deliberate: it is
 * correct for every reason a transaction can fail — including a commit whose acknowledgement was lost,
 * which reports an error over work that landed — and it does not depend on how a duplicate-key error
 * happens to be shaped this major version. It costs one indexed read, on a path that is already
 * exceptional.
 */
async function openAccount(target: IRegistrationTarget, record: IPendingRegistration): Promise<boolean> {
	const session = await mongoose.startSession()

	try {
		await session.withTransaction(async () => {
			await scrubClosedHolder(target, record.email, session)

			await target.model.insertMany([accountDocument(target, record)], { session })
		})
	} catch (e: unknown) {
		// Read outside the session: the transaction has aborted, and what is being asked is what the
		// collection holds now.
		if ((await target.model.exists({ _id: record._id })) === null) {
			throw e
		}

		return false
	} finally {
		await session.endSession()
	}

	return true
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
