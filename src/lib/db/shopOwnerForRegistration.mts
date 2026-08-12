import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { ClientSession, Types } from 'mongoose'

/** The three fields the registration paths branch on, and nothing else. */
export interface IShopOwnerForRegistration {
	_id: Types.ObjectId
	emailVerify?: { valid?: boolean }
	deleted?: Date
}

/**
 * Looks up a seller registration by address.
 *
 * The customer's `userForRegistration` next door, pointed at the other collection, and separate for
 * the reason `VERIFY_EMAIL_PATHS` and `VERIFY_EMAIL_PATHS_USER` are separate: `shopOwner` and `user`
 * are two collections with two validators, an address registered in one says nothing about the other,
 * and a shared helper would have to be told which — at which point it is two functions with a
 * parameter in front of them.
 *
 * ⚠️ **No `deleted` filter, deliberately**, same as the customer's. `login.email` carries a plain
 * unique index with no `partialFilterExpression`, so a soft-deleted document still occupies its
 * address and a `create` behind a liveness filter would fail on the index rather than on a branch
 * anyone can read.
 *
 * ⚠️ **`waitApprov` is not projected and must not be.** A registration that is waiting for an
 * operator is still a registration: whether the account was approved changes nothing about what this
 * caller does next, and the only thing reading it here could add is a branch that behaves differently
 * for parked accounts — which is an oracle for which addresses are parked, on a mutation anyone may
 * call. The approval gate belongs at login, and that is where it is.
 *
 * The projection is the point of having this helper at all: nothing here reads `login.password`, so
 * nothing here can leak it into a log line or a Sentry breadcrumb.
 */
export async function shopOwnerForRegistration(
	uEmail: string,
	session: ClientSession
): Promise<IShopOwnerForRegistration | null> {
	return await ShopOwner.findOne({ 'login.email': uEmail }, '_id emailVerify.valid deleted')
		.session(session)
		.lean<IShopOwnerForRegistration>()
}
