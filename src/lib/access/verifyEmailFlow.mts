import type { IVerifyEmailPaths } from '@axiumine/koa-utils/lib/access/accessPaths'
import { createVerifyEmailFlow, IVerifyEmailFlow } from '@axiumine/koa-utils/lib/access/createVerifyEmailFlow'
import { Imprenditore } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/Imprenditore'

/**
 * Where the email-verification flow finds its fields on `imprenditore`.
 *
 * Same story as `RESET_PWD_PATHS` next door, one step further along: koa-utils used to hard-code its
 * own `UserBase` layout (collection `user`, `account.email.*`). Marketplace has 18 collections and none
 * of them is `user`, so `GET /check/verify-email/:email/:hash` was not merely unconfigured — it was
 * dead. Every request queried a collection that does not exist, found nothing, reported the miss to
 * Sentry and redirected to `/x/email-check`. No verification link on this platform has ever worked.
 *
 * As with the reset map, an unset key silently falls back to the `UserBase` default and a path that
 * does not exist on this schema is a runtime no-op rather than a type error, so every key is spelled
 * out. `deleted` and `disabled` are again the sharp pair: the defaults point at `account.deleted` /
 * `account.disabled`, which do not exist here, and the account-state gate would read `undefined`
 * forever. On `imprenditore` both sit at the document root — and `deleted` being a Date rather than a
 * bool is fine, the gate only asks whether the value is truthy.
 *
 * ⚠️ `verifyClear` IS the list of leaf paths here, and that is the deliberate opposite of
 * `RESET_PWD_PATHS.resetClear`, which has to be the `['resetPwd']` container. The difference is in the
 * validator: `resetPwd` declares `required: ['resetDateReq', 'resetHash']`, so unsetting one member
 * leaves a document strict validation rejects, while `emailVerify` declares no `required` array at
 * all — precisely so the flow can unset three of its five members and leave `valid` standing. Unset
 * the `emailVerify` container instead and `valid: true`, the one thing the verification was for,
 * would be thrown away with it.
 */
export const VERIFY_EMAIL_PATHS: IVerifyEmailPaths = {
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
 * Two guards dispose of an abandoned registration: `handleIfTooMuchRequestsTimes` (five wrong hashes)
 * and `handleIfMoreThan3DaysPassed` (a link older than three days).
 *
 * Through koa-utils 5.6.1 disposal was a hard `deleteOne` and there was no way to override it. On
 * `imprenditore` that removed the row while its `puntoVendita` → `categoria` → 13 food collections kept
 * pointing at an `idImprenditore` that no longer resolved — Mongo has no foreign keys, so nothing
 * stopped it and nothing cleaned up after it. 5.7.0 added `onAbandon`, and `'soft-delete'` is the only
 * defensible mode here: it writes the same `deleted` tombstone every other path on this platform uses
 * and leaves the row and its children standing. The guards still throw either way — disposal never
 * decides whether the link is honoured.
 *
 * `deletedValue` must be the function form. koa-utils defaults it to boolean `true`, which is right for
 * its own `UserBase` and wrong here twice over: `imprenditore.deleted` is `bsonType: 'date'` in the
 * collection validator and `Date` on the model, so `true` is rejected by both. A function is also what
 * keeps the timestamp the moment of the write rather than the moment this module was first imported.
 */
const flow = createVerifyEmailFlow({
	model: Imprenditore,
	paths: VERIFY_EMAIL_PATHS,
	onAbandon: 'soft-delete',
	deletedValue: () => new Date()
})

/**
 * The Koa handler factory for `GET /check/verify-email/:email/:hash`.
 *
 * Re-exported under the same name the package exports so the router reads unchanged; the only
 * difference is that this one is bound to `Imprenditore` and the paths above instead of `UserBase`.
 *
 * Il tipo è annotato a mano: quello inferito è `TVerifyEmailRouter`, che nomina `IContextVerifyEmail`
 * da `dist/private/`, fuori dalla exports map di koa-utils. TypeScript 6 rifiuta di emettere una
 * dichiarazione che non sia scrivibile da chi consuma il pacchetto (TS2883), quindi si passa per la
 * chiave pubblica dell'interfaccia della flow.
 */
export const routerVerifyEmail: IVerifyEmailFlow['routerVerifyEmail'] = flow.routerVerifyEmail
