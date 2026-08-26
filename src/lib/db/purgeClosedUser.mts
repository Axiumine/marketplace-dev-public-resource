import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { ClientSession, trusted, Types } from 'mongoose'

/**
 * Removes a closed customer account outright, so the address it holds can be registered again.
 *
 * ⚠️ **The only hard delete any application code on this platform performs, and it is deliberate
 * rather than an oversight** — ADR-011 §Amendment 2026-08-26, which carves exactly this case out of a
 * convention it otherwise leaves standing. Every other delete here is a `deleted` stamp: a company, a
 * shop owner, an item and a category all keep their document, because something points at them or
 * because their unique keys are a legal identity that must never be reassigned. A closed customer is
 * neither. Nothing references `user`, and its address is a credential rather than an identity — the
 * same person coming back is the ordinary case, not a collision.
 *
 * **This is the retention purge, running early.** `user.deleted_ttl` (`20260301000300-create-user.js`)
 * already destroys this document thirty days after `funUserDel` stamped it; the owner's retention
 * decision condemned it and only the clock is left. Doing it here moves the moment forward to the
 * request that needs the address, which makes the erasure *earlier* than the obligation requires, not
 * later. Retention therefore reads "thirty days after closure, or until the address registers again,
 * whichever comes first" (`phase1/NFR.md` open question 6).
 *
 * ⚠️ **Why the document is destroyed rather than emptied.** The rejected alternative was to keep it
 * and clear the personal paths in place — `$unset` on `personalData`, `addresses`, `defaultAddress`,
 * `resetPwd`, then reset the credential. It fails for two reasons that only get worse with time.
 * First, it is a list, and a list has to be extended by hand every time `user` grows a personal
 * field: forget one and the next holder of that address silently inherits the previous person's data,
 * with nothing failing. Second, keeping `_id` makes one document two data subjects, and the first
 * thing that ever references a customer — an order — would attach the new person to the old one's
 * history. A delete has nothing to forget and mints a new `_id`.
 *
 * ⚠️ **`deleted` is in the FILTER, not merely checked by the caller.** `userRegister` has already
 * branched on it, so this clause can never fail there — which is the point. This is the one write in
 * the repo that cannot be undone, and the guard that matters is the one a future caller cannot skip
 * by reading the branch wrongly. A live account reaching this function deletes nothing and the
 * transaction goes on to fail on `login.email_unique`, loudly, instead of destroying somebody's
 * account quietly. Same reasoning ADR-011 gives for putting "one VAT number, one company" in the
 * index rather than in application code.
 *
 * `trusted()` because `sanitizeFilter` is on globally: a bare `{ $exists: true }` would be cast as a
 * literal value to match against, which matches no document at all — so the delete would silently
 * remove nothing and the registration behind it would fail on the unique index. It fails safe, but it
 * fails.
 *
 * No return value is read and none is offered. `deletedCount` cannot distinguish "the account was not
 * closed" from "another request purged it a moment ago", and both are states the caller has nothing
 * different to do about; the transaction is what makes the pair atomic.
 */
export async function purgeClosedUser(session: ClientSession, userId: Types.ObjectId) {
	await User.deleteOne({ _id: userId, deleted: trusted({ $exists: true }) }, { session })
}
