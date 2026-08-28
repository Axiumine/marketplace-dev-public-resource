import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import type { TAccessModel } from '@axiumine/koa-utils/lib/access/accessPaths'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { revokeAllSessionsForAccount } from '@axiumine/marketplace-common/others/revokeAllSessionsForAccount'
import { TIER, type Tier } from '@axiumine/marketplace-common/others/Tier'
import { Types } from 'mongoose'

/**
 * The login-address path, identical on `shopOwner` and on `user`.
 *
 * ⚠️ **A constant here rather than `RESET_PWD_PATHS.email` read across the module boundary.** Importing
 * either flow map would make this module build both koa-utils flows — two models, two mailers — just to
 * learn one string. `endEverySession.test.mts` pins it against both maps instead, so a rename in either
 * one fails a test rather than silently reading a field that does not exist: a `findOne` that matches
 * nothing here is an account whose sessions quietly survive a password change.
 *
 * The field is deterministically encrypted (CSFLE), which is what makes a plain `$eq` on it a working
 * lookup rather than a scan that never matches.
 */
const EMAIL_PATH = 'login.email'

/** What binds one copy of the routine: the collection the account lives in, and the tier that collection is. */
export interface ICreateEndEverySessionArgs {
	/** `Model<any>` — koa-utils' own type for a model an access flow is pointed at. */
	model: TAccessModel
	/**
	 * The tier of that collection, passed rather than derived.
	 *
	 * ⚠️ Nothing on a Mongoose model says which tier it is, and a session index keyed on the id alone
	 * would revoke a stranger's sessions the moment two collections minted the same `ObjectId` string —
	 * which nothing prevents. Model and tier are one choice made twice, and they are made together, on
	 * the two lines at the bottom of this file, so the pair can be read at a glance.
	 */
	tier: Tier
}

/** The one field the read projects. Not the account: nothing here needs, or wants, `login.password` in scope. */
interface IAccountId {
	_id: Types.ObjectId
}

/**
 * Ends every session an account holds, named by the address that just completed a password reset (E15-S10).
 *
 * The public reset flow is the fourth credential write on this platform and was the last one that revoked
 * nothing: E15-S05 covered the three authenticated ones, and this service was never in that story's landing
 * order. Until this existed, somebody who reset their password because they believed another person was
 * inside their account changed the lock and left every stolen session open — the whole scenario the reset
 * form exists for.
 *
 * ⚠️ **The read is this service's own, and it has to be.** koa-utils' `updatePassword.resolve` answers
 * `Promise<boolean>` and never surfaces the account it wrote to; `getResetPwd`, which holds the `_id`, lives
 * at `private/lib/access/db/getResetPwd` and is outside the package's `exports` map, so importing it throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. `createResetPwdFlow` returns `{ resetPwd, updatePassword }` and offers
 * neither a deps object nor a hook. One extra `findOne` is the whole cost of not forking the delegate.
 *
 * ⚠️ **Called after the delegate has returned, never before it.** Two reasons beyond the credential-write
 * rule. A read placed before would run on every wrong hash, every expired link and every unknown address —
 * the entire rate-limited abuse surface — to serve the one caller in a thousand who is about to succeed. And
 * it would be work this process does *only* for addresses that exist, which is a timing difference on a
 * mutation anybody may call: all four of the delegate's refusal branches throw the same 403 before any
 * write, so a caller without a valid hash never reaches this function at all. There is no race in waiting —
 * `session.withTransaction` settles only after the commit.
 *
 * ⚠️ **`revokeAllSessionsForAccount` is the whole revoke.** No `deleteSession`, no `ctx`. E15-S05's helper
 * additionally deletes the caller's own access key because an authenticated caller *presents* a bearer
 * token; this caller presents none — the reset form is reachable with no session at all. Since R54 the
 * routine retires both halves of every session it names, so there is nothing left for a second call to do.
 *
 * ⚠️ **A parked shop owner reaches this code, and that is correct.** `waitApprov` is deliberately absent
 * from `RESET_PWD_PATHS`, so an owner awaiting approval can complete a reset; ending the sessions they held
 * before they were parked is exactly what should happen. Deleted and disabled accounts never get here —
 * `getResetPwd` answers `null` for both and the delegate throws the unknown-address 403.
 *
 * The failure mode is loud, and the cost of that is real: `removeResetReq` runs *inside* the delegate's
 * transaction, so by the time this throws the hash is already consumed and the caller has to request a
 * fresh link. They are not locked out — the new password is live and committed. The alternative was
 * koa-utils' own precedent one line below the commit, where a failed confirmation mail is swallowed; that
 * is right for a mail and wrong here. A notice that never arrives is an inconvenience. A live session the
 * caller believes they have just closed is the attack.
 */
export const createEndEverySession = ({ model, tier }: ICreateEndEverySessionArgs) =>
	async function endEverySession(uEmail: string): Promise<void> {
		const account: IAccountId | null = await model.findOne({ [EMAIL_PATH]: uEmail }, '_id').lean<IAccountId>()

		// Unreachable through the front door: the delegate committed a write to this address moments ago.
		// A plain Error rather than `throwInternalError`, because the call sites hand it to
		// `tryCatchRethrow`, which reports a plain Error to Sentry and answers 500 — a GraphQLError would
		// pass straight through and the 500 would be silent. No address in the message: the tier is enough
		// to find it and carries no PII.
		if (account === null) {
			throw new Error(`endEverySession: no ${tier} account matched the address of a completed reset`)
		}

		await revokeAllSessionsForAccount({ store: redisClient, tier, accountId: `${account._id}` })
	}

/** Bound to `shopOwner`, for the `updatePwd` half of the seller reset flow. */
export const endEverySessionShopOwner = createEndEverySession({ model: ShopOwner, tier: TIER.shopOwner })

/** Bound to `user`, for the `userUpdatePwd` half of the customer reset flow. */
export const endEverySessionUser = createEndEverySession({ model: User, tier: TIER.user })
