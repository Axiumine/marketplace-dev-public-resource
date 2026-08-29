import type { TAccessModel } from '@axiumine/koa-utils/lib/access/accessPaths'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_SHOP_OWNER,
	ENCRYPTED_FIELDS_USER,
	KEY_ALT_NAME_SHOP_OWNER,
	KEY_ALT_NAME_USER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ShopOwner } from '@axiumine/marketplace-common/models/MongoDB/ShopOwner'
import { User } from '@axiumine/marketplace-common/models/MongoDB/User'
import type { ScrubbableTier } from '@axiumine/marketplace-common/others/accountScrub'
import { TIER } from '@axiumine/marketplace-common/others/Tier'
import { sendShopOwnerVerifyEmail } from '@lib/access/sendShopOwnerVerifyEmail.mjs'
import { sendUserVerifyEmail } from '@lib/access/sendUserVerifyEmail.mjs'
import { Binary } from 'mongodb'

/**
 * The login-address path, identical on `shopOwner` and on `user`.
 *
 * The same constant `endEverySession.mts` keeps for the same reason, and the reason has grown: it is the
 * one path the registration flow both queries by and encrypts, and it is spelled here rather than read
 * out of a koa-utils paths map because those maps went with the flows they configured (ADR-042).
 * `registrationTargets.test.mts` pins it against both schemas, so a rename fails a test rather than
 * silently producing a filter that matches nothing.
 */
export const EMAIL_PATH = 'login.email'

/**
 * Encrypts one address exactly as its destination collection would, and hands back the ciphertext.
 *
 * ⚠️ **The whole document goes through `encryptDocument`, rather than `encryptValue` being called with a
 * hard-coded algorithm.** ADR-043 requires the record's encryption to be *derived* from
 * `ENCRYPTED_FIELDS_*` and not restated: this call reads the same list the model's plugin reads, picks up
 * the same `ALGORITHM_DETERMINISTIC`, and would pick up a second registration field on the day one is
 * added. Naming the algorithm here would be the second enumeration that ADR's compliance section greps
 * for.
 *
 * The `fields` parameter is typed off `encryptDocument` itself because `IEncryptedFieldSpec` is not in
 * `marketplace-common`'s exports map, and TypeScript refuses to emit a declaration naming a type a
 * consumer cannot import (TS2883). `Parameters<typeof encryptDocument>[1]` names only the exported
 * function, so it survives the emit.
 *
 * The guard is not defensive noise. If `login.email` ever leaves the encrypted lists, every other part of
 * this flow keeps working — a plaintext string hexes into a perfectly good Redis key — and the failure
 * would surface as personal data sitting in Redis in the clear, which is the one thing ADR-043 exists to
 * prevent. It fails at the first registration instead.
 */
async function encryptLoginEmail(
	uEmail: string,
	fields: Parameters<typeof encryptDocument>[1],
	keyAltName: string
): Promise<Binary> {
	const encrypted = await encryptDocument<{ login: { email: string | Binary } }>(
		{ login: { email: uEmail } },
		fields,
		keyAltName
	)

	if (!(encrypted.login.email instanceof Binary)) {
		throw new Error(`encryptLoginEmail: ${EMAIL_PATH} came back in the clear — it is no longer an encrypted field`)
	}

	return encrypted.login.email
}

/** Everything one tier's registration differs by. Two values of it exist and no third is expected. */
export interface IRegistrationTarget {
	/**
	 * Which collection this is, as data.
	 *
	 * ⚠️ Typed `ScrubbableTier` rather than `Tier` on purpose: it is handed to `buildAccountScrub` on the
	 * confirm path, and `admin` has no closure story at all. A fourth tier that cannot be scrubbed cannot
	 * be registered through here either, and the compiler says so.
	 */
	tier: ScrubbableTier
	/** `Model<any>` — koa-utils' own type for a model an access flow is pointed at. */
	model: TAccessModel
	/**
	 * Whether a confirmed account starts parked behind the operator's approval queue.
	 *
	 * ⚠️ **`true` on `shopOwner`, and it is written at confirm rather than at submit** — which is the point
	 * of moving it here. Selling on the platform is a commercial relationship with the operator, so a
	 * stranger may ask to become a shop owner but may not become one by filling in a form; before ADR-042
	 * the flag lived on a document a public mutation could reach, and the shop owner's restart path
	 * left it cleared on a revived account. The only writer is now the one place that creates the document.
	 */
	waitApprov: boolean
	/** Deterministic ciphertext of an address, under this collection's data key. */
	encryptEmail(uEmail: string): Promise<Binary>
	/** The activation link, on this tier's own domain and route. */
	sendVerifyEmail(email: string, hash: string): Promise<void>
}

/** `user` — the end customer. */
export const REGISTRATION_TARGET_USER: IRegistrationTarget = {
	tier: TIER.user,
	model: User,
	waitApprov: false,
	encryptEmail: async (uEmail) => await encryptLoginEmail(uEmail, ENCRYPTED_FIELDS_USER, KEY_ALT_NAME_USER),
	sendVerifyEmail: sendUserVerifyEmail
}

/** `shopOwner` — the person who runs shops on the platform. */
export const REGISTRATION_TARGET_SHOP_OWNER: IRegistrationTarget = {
	tier: TIER.shopOwner,
	model: ShopOwner,
	waitApprov: true,
	encryptEmail: async (uEmail) => await encryptLoginEmail(uEmail, ENCRYPTED_FIELDS_SHOP_OWNER, KEY_ALT_NAME_SHOP_OWNER),
	sendVerifyEmail: sendShopOwnerVerifyEmail
}
