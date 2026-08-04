import type { IResetPwdPaths } from '@axiumine/koa-utils/lib/access/accessPaths'
import { createResetPwdFlow } from '@axiumine/koa-utils/lib/access/createResetPwdFlow'
import { ShopOwner } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/ShopOwner'

/**
 * Where the password-reset flow finds its fields on `shopOwner`.
 *
 * koa-utils used to hard-code its own `UserBase` layout (collection `user`, `account.resetDateReq`,
 * `account.resetHash`). Marketplace has no `user` collection, so the flow was inert: every reset request
 * queried a collection that does not exist and quietly returned true. Since 5.3.0 the collection and
 * the field paths are data, and this map is what makes the flow point at a real document.
 *
 * Every key matters, including the ones that look like boilerplate: an unset key silently falls back
 * to the `UserBase` default, and a path that does not exist on this schema is a runtime no-op, not a
 * type error. `deleted` and `disabled` are the sharp case — koa-utils defaults them to
 * `account.deleted` / `account.disabled`, neither of which exists here, so leaving them out would
 * leave the 5.4.0 account-state gate reading `undefined` forever and never firing. On `shopOwner`
 * both flags sit at the document root.
 *
 * `resetClear` is deliberately NOT the pair of leaf paths above it. The migration declares
 * `resetPwd` as an object with `required: ['resetDateReq', 'resetHash']` under
 * `validationLevel: 'strict'` + `validationAction: 'error'`, so unsetting one member leaves a
 * document the validator rejects. The whole container is the only legal cleanup.
 */
export const RESET_PWD_PATHS: IResetPwdPaths = {
	email: 'login.email',
	password: 'login.password',
	name: 'personalData.firstName',
	resetDateReq: 'resetPwd.resetDateReq',
	resetHash: 'resetPwd.resetHash',
	deleted: 'deleted',
	disabled: 'disabled',
	resetClear: ['resetPwd']
}

/**
 * Since koa-utils 5.4.0 the reader answers `null` for a soft-deleted or disabled account, exactly as
 * it does for an unknown address, so `resetPwd` sends nothing and `updatePwd` answers 403 — no new
 * enumeration oracle. koa-utils warns that on un-migrated data a `disabled` stored as the string
 * `'false'` would read truthy and block resets; that cannot happen here, because the migration pins
 * `disabled` to `bsonType: 'bool'` and `deleted` to `bsonType: 'date'` under a strict validator.
 *
 * `waitApprov` is deliberately absent. Nothing gates on it anywhere — login neither projects nor
 * reads it, and only the admin area writes and displays it — so the reset flow ignoring it changes
 * nothing. If the manual-approval gate is meant to bite, it has to bite at login first.
 */
const flow = createResetPwdFlow({ model: ShopOwner, paths: RESET_PWD_PATHS })

/** Reset request: sends the link by email. Field name kept as-is, the clients already call it. */
export const resetPwd = flow.resetPwd

/**
 * Conferma del reset: cambia la password.
 *
 * Exported as `updatePwd` because that is the field name the public schema has always exposed;
 * koa-utils calls the same mutation `updatePassword`.
 */
export const updatePwd = flow.updatePassword
