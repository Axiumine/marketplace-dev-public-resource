import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { ClientSession, Types } from 'mongoose'

/**
 * Puts an unverified registration back to the state a fresh one is in: the newly supplied password, and
 * no tombstone.
 *
 * ⚠️ **This overwrites the stored password without proving anything, and that is safe here only
 * because the document is not yet an account.** `loginUser` refuses every document whose `emailVerify.valid` is
 * not true, so nothing can be done with these credentials until somebody opens the mail sent to that
 * address — which is the proof. What the write costs an attacker is nothing they did not already have;
 * what it buys the honest caller is the ability to recover from mistyping their password into a form
 * whose confirmation mail they then never received. Never call it on a document whose `valid` is true: there
 * it *would* be an unauthenticated password reset, and the reset flow exists for that.
 *
 * `$unset: { deleted: '' }` because the abandon guards soft-delete: five wrong hashes or a link older
 * than three days stamps `deleted` and leaves the document standing, holding its unique `login.email`
 * against a second registration. Without clearing it the address would be permanently unusable by the
 * person who chose it, which is not what a three-day timeout is supposed to mean.
 *
 * ⚠️ **The stamp this clears is always an abandoned attempt, never a closed account.** Both spell
 * themselves `deleted` on this collection, and only `emailVerify.valid` separates them — a closed
 * account is verified, and `userRegister` branches on that pair before it ever reaches this call, so
 * what arrives here has never been an account. The distinction is not cosmetic: clearing the stamp on a
 * closed account would rearm `user.deleted_ttl` from an unauthenticated request, and one registration
 * attempt every thirty days would then keep a document the retention rule condemned alive forever.
 *
 * The activation hash is *not* minted here — `setEmailHashUser` does that, so the three `emailVerify`
 * paths are written in exactly one place and cannot drift from the flow's paths map.
 */
export async function restartUserRegistration(session: ClientSession, userId: Types.ObjectId, password: string) {
	await User.updateOne(
		{ _id: userId },
		{
			$set: { 'login.password': await encryptPassword(password) },
			$unset: { deleted: '' }
		},
		{ session, runValidators: true }
	)
}
