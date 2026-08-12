import { emailHash } from '@axiumine/koa-utils/lib/emailHash'
import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { ClientSession, Types } from 'mongoose'

/**
 * Writes the minimal seller document and returns the activation hash the mail has to carry.
 *
 * **Minimal is the whole point**, exactly as it is for the customer: `login` and `registeredAt` are
 * the only members the `shopOwner` validator requires. `personalData` stopped being required when
 * this mutation shipped — a stranger filling in a sign-up form has not been asked for their date of
 * birth or their home address, and writing an empty block to "have the shape there" would fail
 * validation anyway, since its own `required` list names all five members.
 *
 * ⚠️ **`waitApprov: true`, and this is the one place on the platform outside the Admin service that
 * writes the field.** It is what makes self-registration safe to expose at all: the account exists,
 * it can confirm its address and it can reset its password, but `checkShopOwnerApproval` refuses it a
 * session at login and at every refresh until an operator clears the flag through
 * `shopOwnerUpdateStatus`. Without it, anybody who can type an address into a form would be a shop
 * owner on this platform the moment they opened the activation mail.
 *
 * `shopOwnerAdd` on the Admin service deliberately writes nothing here, and that asymmetry is the
 * decision rather than an oversight: an operator creating an account by hand has approved it by the
 * act of creating it, and making them approve it twice would leave a queue that is always full of
 * accounts nobody is waiting on.
 *
 * `requestTimes: 1` matches what koa-utils' `setEmailHash` writes, and it is a strike counter, not a
 * send counter: the verify router increments it on a *wrong* hash and disposes of the registration at
 * five.
 */
export async function registerNewShopOwner(uEmail: string, password: string, session: ClientSession) {
	const hashConfirmEmail = emailHash()
	const nowDt = new Date()

	await ShopOwner.create(
		[
			{
				_id: new Types.ObjectId(),
				login: {
					email: uEmail,
					password: await encryptPassword(password)
				},
				registeredAt: nowDt,
				waitApprov: true,
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
