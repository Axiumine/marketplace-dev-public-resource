import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { ClientSession, Types } from 'mongoose'

/** The three fields the registration paths branch on, and nothing else. */
export interface IUserForRegistration {
	_id: Types.ObjectId
	emailVerify?: { valid?: boolean }
	deleted?: Date
}

/**
 * Looks up a registration by address.
 *
 * ⚠️ **No `deleted` filter, deliberately.** `login.email` carries a plain unique index with no
 * `partialFilterExpression`, so a soft-deleted document still occupies its address and a `create` behind a
 * liveness filter would fail on the index rather than on a branch anyone can read. Same rule as the
 * delete paths on `company`: liveness filters belong on read paths that serve data, not on the
 * existence check in front of a write.
 *
 * ⚠️ **`deleted` alone does not say what happened, which is why `emailVerify.valid` is projected
 * beside it.** The stamp has two entirely different causes on this collection and `userRegister` answers
 * them oppositely. Unverified and stamped is an *abandoned attempt* — five wrong hashes or a link left
 * three days — and it is restarted in place, keeping the document. Verified and stamped is a *closed
 * account*, somebody who exercised Art. 17, and it is destroyed and registered fresh. Reading either
 * field without the other picks the wrong one of those two.
 *
 * The projection is the point of having this helper at all: nothing here reads `login.password`, so
 * nothing here can leak it into a log line or a Sentry breadcrumb.
 */
export async function userForRegistration(uEmail: string, session: ClientSession): Promise<IUserForRegistration | null> {
	return await User.findOne({ 'login.email': uEmail }, '_id emailVerify.valid deleted')
		.session(session)
		.lean<IUserForRegistration>()
}
