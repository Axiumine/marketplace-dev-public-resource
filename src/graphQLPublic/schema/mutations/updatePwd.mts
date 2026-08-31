import type { IUpdatePasswordArgs } from '@axiumine/koa-utils/graphQL/schema/mutations/updatePassword'
import { tryCatchRethrow } from '@axiumine/koa-utils/lib/tryCatchRethrow'
import { endEverySessionShopOwner } from '@lib/access/endEverySession.mjs'
import { updatePwd as boundUpdatePwd } from '@lib/access/resetPwdFlow.mjs'
import { GraphQLError } from 'graphql'

/**
 * Reset confirmation for a shop owner: the bound flow writes the new password, then every session the
 * account holds is revoked.
 *
 * ⚠️ **The field's shape is the delegate's, borrowed rather than restated** — description, type and the
 * three arguments all come off `boundUpdatePwd`. This wrapper exists to add behaviour after the write, not
 * to change the public schema, and a hand-copied `args` map here would be a second place for the reset
 * triple to drift from the one koa-utils actually reads.
 *
 * ⚠️ **No `guardPublicWrite`, unlike `userUpdatePwd` next door, and the asymmetry is deliberate** — the
 * shop-owner and admin frontends already call this pair and send no Turnstile token, so gating it would
 * break them on deploy. The same note is on the field list in `mutations.mts`. Adding the gate here is a
 * coordinated change with `marketplace-shopowner`, not a tidy-up.
 *
 * ⚠️ **The revoke is inside the try and after the delegate, both deliberately** — the shape the
 * authenticated services' call sites established. Before the write, a reset that then failed validation
 * would have logged the owner out of every device for nothing. Outside the try, a Redis that refused would
 * leave this answering `true` with every stolen session still live, which is the exact lie this wrapper
 * exists to stop telling.
 */
export const updatePwd = {
	description: boundUpdatePwd.description,
	type: boundUpdatePwd.type,
	args: boundUpdatePwd.args,
	async resolve(source: unknown, args: IUpdatePasswordArgs) {
		const changed = await boundUpdatePwd.resolve(source, args)

		try {
			// Normalised the same way the delegate normalises it — `email.trim().toLowerCase()` inside
			// `updatePassword.resolve` — because the address that was matched is the address whose sessions
			// must go. Handed the raw argument, a stray capital would read a document that does not exist.
			await endEverySessionShopOwner(args.email.toLowerCase().trim())
		} catch (e) {
			tryCatchRethrow(e as GraphQLError | Error)
		}

		return changed
	}
}
