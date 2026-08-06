import type { IResetPwdPaths } from '@axiumine/koa-utils/lib/access/accessPaths'
import { createResetPwdFlow } from '@axiumine/koa-utils/lib/access/createResetPwdFlow'
import { createResetPwdMailer } from '@axiumine/koa-utils/lib/access/resetPwdMailer'
import { User } from '@thedoctorweb_agency/marketplace-common/models/MongoDB/User'

/**
 * Where the password-reset flow finds its fields on `user`.
 *
 * Field for field the same map as `RESET_PWD_PATHS` next door, kept separate for the reason
 * `VERIFY_EMAIL_PATHS_USER` is kept separate from its shop-owner twin: `user` and `shopOwner` are two
 * collections with two validators in two migrations, either free to move without the other. One shared
 * constant would turn a path change made for one collection into a silent retarget of the flow bound to
 * the other.
 *
 * `resetClear` is the container, not the two leaf paths above it, and for the same reason it is on the
 * shop owner: the migration declares `resetPwd` with `required: ['resetDateReq', 'resetHash']` under a
 * strict validator, so unsetting one member leaves a document the database rejects.
 */
export const RESET_PWD_PATHS_USER: IResetPwdPaths = {
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
 * The front-end route that renders the new-password form on the storefront.
 *
 * ⚠️ A **front-end** path, unlike `/check/verify-email-user/:email/:hash`, which is a router mount in
 * this process. Nothing here fails when it is wrong — the link is only ever followed by a person, who
 * lands on a 404 with a valid hash in the URL. It has to keep matching `marketplace-user`'s
 * `/reset-password/$email/$hash` route; changing one without the other is invisible to every gate.
 */
const RESET_PATH_USER = '/reset-password'

/**
 * `personalData.firstName` is optional on `user` — registration is email and password only, and the
 * name arrives later, if at all. koa-utils reads it for the mail greeting and the greeting degrades to
 * empty, which is why the path is still declared: leaving it unset would fall back to `UserBase`'s
 * `account.name` and read `undefined` for every customer, named or not.
 *
 * The mailer is the whole reason this module is not one line. `sendEmailReset` builds its link on
 * `APP_DOMAIN`, the operator/shop-owner origin, and a customer who followed it would land on a panel
 * that cannot complete the reset. The resolver cannot pick the host itself — by the time it holds an
 * email and a hash, two collections behind this one process look identical — so the choice is made here,
 * where the collection is already chosen. `APP_DOMAIN_USER` unset falls back to `APP_DOMAIN`: a working
 * link on the wrong domain, exactly as the `env` template warns for the verification link.
 */
const flow = createResetPwdFlow({
	model: User,
	paths: RESET_PWD_PATHS_USER,
	mailer: createResetPwdMailer(process.env.APP_DOMAIN_USER, RESET_PATH_USER)
})

/** Reset request for a customer: sends the link on the storefront domain. */
export const userResetPwd = flow.resetPwd

/** Confirms a customer's reset: takes email + hash + new password and writes it. */
export const userUpdatePwd = flow.updatePassword
