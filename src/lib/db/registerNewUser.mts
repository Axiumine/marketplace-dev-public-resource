import { emailHash } from '@axiumine/koa-utils/lib/emailHash'
import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import { ClientSession, Types } from 'mongoose'

/**
 * Writes the minimal customer row and returns the activation hash the mail has to carry.
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
					password: await encryptPassword(password)
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
