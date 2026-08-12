import { encryptPassword } from '@axiumine/koa-utils/lib/encryptPassword'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { ClientSession, Types } from 'mongoose'

/**
 * Puts an unverified seller registration back to the state a fresh one is in: the newly supplied
 * password, and no tombstone.
 *
 * ⚠️ **This overwrites the stored password without proving anything, and that is safe here only
 * because the document is not yet an account.** Two gates stand between it and a session:
 * `checkShopOwnerEmailVerified` refuses every shop owner whose `emailVerify.valid` is `false`, and
 * `checkShopOwnerApproval` refuses one whose `waitApprov` is up — which every self-registration's is.
 * Never call it on a document whose `valid` is true: there it *would* be an unauthenticated password
 * reset, and the reset flow exists for that.
 *
 * ⚠️ **`waitApprov` is not touched, in either direction.** Restarting a registration must not raise
 * the flag on a document an operator has already approved — that would be a public mutation
 * un-approving an account — and it must not clear one either. The caller only ever reaches this path
 * for an unverified document, and an unverified document that has somehow been approved stays
 * approved. Writing the field here at all would put an approval decision on the public service.
 *
 * `$unset: { deleted: '' }` because the abandon guards soft-delete: five wrong hashes or a link older
 * than three days stamps `deleted` and leaves the document standing, holding its unique `login.email`
 * against a second registration. Without clearing it the address would be permanently unusable by the
 * person who chose it.
 *
 * The activation hash is *not* minted here — `setEmailHash` does that, so the three `emailVerify`
 * paths are written in exactly one place and cannot drift from the flow's paths map.
 */
export async function restartShopOwnerRegistration(session: ClientSession, shopOwnerId: Types.ObjectId, password: string) {
	await ShopOwner.updateOne(
		{ _id: shopOwnerId },
		{
			$set: { 'login.password': await encryptPassword(password) },
			$unset: { deleted: '' }
		},
		{ session, runValidators: true }
	)
}
