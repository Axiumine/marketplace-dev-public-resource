import type { IVerifyEmailPaths } from '@axiumine/koa-utils/lib/access/accessPaths'
import { createVerifyEmailFlow, IVerifyEmailFlow } from '@axiumine/koa-utils/lib/access/createVerifyEmailFlow'
import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'

/**
 * Where the email-verification flow finds its fields on `user`.
 *
 * Field for field the same map as `VERIFY_EMAIL_PATHS` next door, and that is not a copy waiting to be
 * de-duplicated: `user` and `shopOwner` are two collections with two validators in two migrations, and
 * either may move without the other. Sharing one constant would make a path change made for one
 * collection silently retarget the flow bound to the other — the same argument `User.mts` records for
 * not sharing `BirthSubDocSchema`. The two maps agreeing today is a fact about the schemas, not a
 * dependency between them.
 *
 * Every key is spelled out for the reason the ShopOwner map spells them out: an unset key falls back to
 * koa-utils' `UserBase` layout (`account.email.*`, collection `user` — which on this platform *does*
 * exist now and holds the customer, so a silent fallback would no longer even miss loudly), and a path
 * that does not exist on this schema is a runtime no-op rather than a type error.
 *
 * `verifyClear` is the list of leaf paths, not the `emailVerify` container, exactly as on the shop
 * owner: `emailVerify` declares no `required` array, so three of its five members can be unset while
 * `valid: true` — the one thing the verification was for — stays standing.
 */
export const VERIFY_EMAIL_PATHS_USER: IVerifyEmailPaths = {
	email: 'login.email',
	valid: 'emailVerify.valid',
	hash: 'emailVerify.hash',
	dateLastReq: 'emailVerify.dateLastReq',
	requestTimes: 'emailVerify.requestTimes',
	newEmailTmp: 'emailVerify.newEmailTmp',
	deleted: 'deleted',
	disabled: 'disabled',
	verifyClear: ['emailVerify.hash', 'emailVerify.dateLastReq', 'emailVerify.requestTimes'],
	emailChangeClear: ['emailVerify.hash', 'emailVerify.dateLastReq', 'emailVerify.requestTimes', 'emailVerify.newEmailTmp']
}

/**
 * `'soft-delete'` for the same reason the ShopOwner flow uses it, arrived at from the other direction.
 *
 * A shop owner is soft-deleted because rows point at them. A customer is soft-deleted because the
 * address does: `login.email` carries a unique index with no `partialFilterExpression`, so a hard
 * `deleteOne` on an abandoned registration frees that address for anyone to claim — including whoever
 * was typing it into the form by mistake. Keeping the tombstone keeps the address bound to the person
 * who first proved they could receive mail at it, which is the same reasoning that leaves a retired
 * company holding its VAT number.
 *
 * `deletedValue` must be the function form: koa-utils defaults it to boolean `true`, and `user.deleted`
 * is `bsonType: 'date'` in the collection validator and `Date` on the model, so `true` is rejected by
 * both. A function also stamps the moment of the write rather than the moment this module was imported.
 */
const flow = createVerifyEmailFlow({
	model: User,
	paths: VERIFY_EMAIL_PATHS_USER,
	onAbandon: 'soft-delete',
	deletedValue: () => new Date()
})

/**
 * The Koa handler factory for `GET /check/verify-email-user/:email/:hash`.
 *
 * ⚠️ A **different path** from the shop owner's `/check/verify-email/:email/:hash`, and it is load
 * bearing. Both routes live in this one process, both take an email and a hash, and neither can tell
 * from those which collection minted them — a shared path would resolve to whichever flow the router
 * matched first and report every customer link as a bad hash. The link the customer receives also sits
 * on a different domain (`APP_DOMAIN_USER`), so the two are distinct twice over and nginx needs no
 * rewrite to tell them apart.
 *
 * The type is annotated by hand: the inferred one names `IContextVerifyEmail` from koa-utils'
 * `dist/private/`, outside its exports map, and TypeScript 6 refuses to emit a declaration a consumer
 * cannot write (TS2883).
 */
export const routerVerifyEmailUser: IVerifyEmailFlow['routerVerifyEmail'] = flow.routerVerifyEmail

/**
 * Mints a fresh 50-character hash on an existing row, resetting `requestTimes` to 1 and `dateLastReq`
 * to now — which is what restarts the three-day window and clears the wrong-hash strike count.
 *
 * Exposed because `userVerifyEmailResend` needs it and because `userRegister` needs it for the
 * already-registered-but-unverified case; both would otherwise reimplement the `$set` and drift from
 * the paths map above.
 */
export const setEmailHashUser: IVerifyEmailFlow['setEmailHash'] = flow.setEmailHash
