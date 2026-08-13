import { emailHash } from '@axiumine/koa-utils/lib/emailHash'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { ClientSession, Types } from 'mongoose'

/**
 * Writes the minimal customer document and returns the activation hash the mail has to carry.
 *
 * Not koa-utils' `registerNewUser`: that one is welded to `UserBase` and writes its `account.email.*`
 * layout, which this collection's validator rejects outright (`additionalProperties: false`, and there
 * is no `account` here). Same three steps, this platform's field names.
 *
 * **Minimal is the whole point.** `login` and `registeredAt` are the only members the `user` validator
 * requires, and `personalData` is deliberately optional on this tier — a customer registers with an
 * address and a password and fills in a name later, or never. Writing an empty `personalData` to "have
 * the shape there" would fail validation anyway, since its own `required` list names `firstName` and
 * `lastName`.
 *
 * `requestTimes: 1` matches what koa-utils' `setEmailHash` writes, and it is a strike counter, not a
 * send counter: the verify router increments it on a *wrong* hash and disposes of the registration at
 * five. Starting it at 1 rather than 0 is koa-utils' convention and the guard's threshold is set
 * against it — see `handleIfTooMuchRequestsTimes`.
 *
 * ⚠️ **The plaintext password is handed over deliberately: `create` hashes it and this function must
 * not.** `LoginSubDocSchema` carries a `pre('save')` that bcrypts `password` whenever the path is
 * modified, so a `create` on a fresh document always runs it. Calling `encryptPassword` here as well
 * stored `bcrypt(bcrypt(password))`, and the account it opened could never log in — the login compares
 * the plaintext against a hash of a hash. That is not a hypothetical: it is what this line did until
 * 2026-08-13, and it was found by registering an account against the running stack (E18-S09), not by
 * reading. Nothing in a unit test could see it, because a mocked model runs no middleware.
 *
 * The two restart-registration siblings hash explicitly and are right to: they write with `updateOne`,
 * which runs no document middleware at all. **Which of the two rules applies is decided by the write
 * operator, never by the field** — `create`/`save` hash themselves, `updateOne`/`findOneAndUpdate` do
 * not. `shopOwnerAdd` on the Admin service passes its operator's plaintext straight to `create` for the
 * same reason this does.
 */
export async function registerNewUser(uEmail: string, password: string, session: ClientSession) {
	const hashConfirmEmail = emailHash()
	const nowDt = new Date()

	await User.create(
		[
			{
				_id: new Types.ObjectId(),
				login: {
					email: uEmail,
					password
				},
				registeredAt: nowDt,
				emailVerify: {
					valid: false,
					hash: hashConfirmEmail,
					dateLastReq: nowDt,
					requestTimes: 1
				}
			}
		],
		{ session }
	)

	return hashConfirmEmail
}
