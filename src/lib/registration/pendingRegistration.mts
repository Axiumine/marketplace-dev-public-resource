import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { pendingRegistrationKey } from '@axiumine/marketplace-common/others/registrationKeys'
import type { IRegistrationTarget } from '@lib/registration/registrationTargets.mjs'
import { Binary } from 'mongodb'
import { Types } from 'mongoose'

/**
 * How long a registration stays claimable, and therefore how long the activation link works.
 *
 * The same three days koa-utils' `handleIfMoreThan3DaysPassed` enforced, arrived at from the other end:
 * that guard was a comparison run lazily on a visit to the link, so a registration nobody ever visited
 * was never abandoned and held its address for ever. Here the window is the key's own TTL, so
 * **abandonment is not a state anybody has to notice** (ADR-042).
 */
export const PENDING_TTL_SECONDS = 3 * 24 * 60 * 60

/**
 * Wrong hashes a pending registration survives.
 *
 * koa-utils' threshold and its off-by-one convention both kept: `requestTimes` starts at 1, so the fifth
 * strike is the one that disposes of the record.
 */
export const MAX_VERIFY_ATTEMPTS = 5

/**
 * The one Redis verb `strikePendingRegistration` and `renewPendingRegistration` need beyond `hSet`,
 * `expire` and the rest of `redisClient`'s ordinary surface, narrowed out rather than cast to either
 * client type: `redisClient` is a union of the cluster and single-node clients, and a method both members
 * carry is still not callable through their union in TypeScript. One key per call, so a cluster never
 * sees a cross-slot script.
 */
interface IPendingRegistrationScriptStore {
	eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Where one tier's pending registration for one address lives, and the address as MongoDB will store it. */
export interface IPendingSlot {
	/** The Redis key. One key, because a multi-key operation throws `CROSSSLOT` on a cluster. */
	key: string
	/** The deterministic ciphertext of `login.email` — the key material and the value that gets inserted. */
	email: Binary
}

/** A registration between the form and the click. */
export interface IPendingRegistration {
	/**
	 * The `_id` the account will be created with, minted at submit.
	 *
	 * ⚠️ **This is what makes a replayed confirmation safe.** The confirm step spans two stores and cannot
	 * be atomic across them, so a crash between the commit and the `DEL` leaves a live key over a live
	 * account. A replay then re-runs the transaction and the insert fails on the duplicate `_id` instead
	 * of opening a second account for the same person (ADR-042).
	 */
	_id: Types.ObjectId
	email: Binary
	/** bcrypt, hashed at submit. `login.password` is not an encrypted field — it is already one-way. */
	password: string
	/** The 50-character confirmation hash the activation link carries. */
	hash: string
	/** When the form was submitted. Becomes `registeredAt`, and a resend does not move it. */
	registeredAt: Date
	/** When the current link was minted. A resend moves it. */
	dateLastReq: Date
	/** Wrong-hash strikes, starting at 1. */
	requestTimes: number
}

/**
 * Where a tier's pending registration for an address lives.
 *
 * ⚠️ The key shape itself — ciphertext over digest, the hex encoding, the tier segment — is
 * `pendingRegistrationKey`'s, in `marketplace-common` (ADR-043). What stays here is pairing it with the
 * encryption: `target.encryptEmail` produces the one ciphertext both the key and `login.email` are built
 * from, so the slot hands back key and ciphertext together and no caller can assemble one from a second,
 * independently-encrypted address.
 */
export async function pendingSlot(target: IRegistrationTarget, uEmail: string): Promise<IPendingSlot> {
	const email = await target.encryptEmail(uEmail)

	return { key: pendingRegistrationKey(target.tier, email), email }
}

/**
 * The hash write and its expiry, in one function.
 *
 * ⚠️ **Never write the hash anywhere else.** `HSET` on a missing key creates it with no TTL, so a path
 * that writes the fields and returns holds an address's attempt slot for ever — the exact failure the
 * three-day window exists to prevent, and one that no test on a fresh Redis would ever show. ADR-042
 * names it as a risk and this is the whole mitigation: there is one writer.
 */
async function writeRecord(key: string, fields: Record<string, string>): Promise<void> {
	await redisClient.hSet(key, fields)

	await redisClient.expire(key, PENDING_TTL_SECONDS)
}

/**
 * Writes a fresh pending registration, replacing whatever was under that key.
 *
 * A second submit for the same address is not a special case: it overwrites the same key and refreshes
 * the same TTL, which is idempotent precisely because it is one key. `guardPublicWrite` is what
 * bounds how often that may happen.
 *
 * `email` is not a parameter — it comes from the slot, so the value in the record and the value the key
 * is derived from cannot drift apart.
 */
export async function writePendingRegistration(slot: IPendingSlot, record: Omit<IPendingRegistration, 'email'>): Promise<void> {
	await writeRecord(slot.key, {
		id: `${record._id}`,
		email: Buffer.from(slot.email.buffer).toString('hex'),
		password: record.password,
		hash: record.hash,
		registeredAt: `${record.registeredAt.getTime()}`,
		dateLastReq: `${record.dateLastReq.getTime()}`,
		requestTimes: `${record.requestTimes}`
	})
}

/**
 * Reads a pending registration back, or `null` if the key is not there.
 *
 * Expired, never written and already consumed are one answer on purpose — all three mean the link is
 * dead, and telling them apart would be an oracle on a route anybody may call.
 *
 * ⚠️ **Nothing here decrypts anything.** The ciphertext is rebuilt as the `Binary` subtype 6 the driver
 * produced, so `isCiphertext` recognises it and both the model's `pre('insertMany')` pass and its filter
 * hook let it through untouched. That is what ADR-043 means by *confirm is a copy*: the bytes that reach
 * MongoDB are the bytes Redis held.
 */
export async function readPendingRegistration(key: string): Promise<IPendingRegistration | null> {
	const record = await redisClient.hGetAll(key)

	// `HGETALL` answers an empty hash for a key that does not exist rather than a nil, so the absence has
	// to be read off a field. `hash` rather than the object's key count: it is the field the caller cannot
	// do anything without.
	if (record.hash === undefined) {
		return null
	}

	return {
		_id: new Types.ObjectId(record.id),
		email: new Binary(Buffer.from(record.email, 'hex'), Binary.SUBTYPE_ENCRYPTED),
		password: record.password,
		hash: record.hash,
		registeredAt: new Date(Number(record.registeredAt)),
		dateLastReq: new Date(Number(record.dateLastReq)),
		requestTimes: Number(record.requestTimes)
	}
}

/**
 * `strikePendingRegistration`'s one command, guarded by the one check that makes it safe to run
 * unconditionally: `HINCRBY` on a key nobody holds any more creates it from nothing, with no TTL, so the
 * `EXISTS` has to run in the same round trip as the increment or a deletion landing between the two wins
 * the race and leaks the key for ever.
 */
const STRIKE_IF_EXISTS = `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HINCRBY', KEYS[1], 'requestTimes', 1)
return 1`

/**
 * Counts one wrong hash against the record.
 *
 * ⚠️ **No `EXPIRE`, deliberately** — and this is the one write that must not go through `writeRecord`.
 * Re-arming the TTL on a failed attempt would let anybody keep somebody else's pending registration alive
 * indefinitely by guessing at the link, which is the same shape of defect the old flow had on the
 * document. A wrong hash spends a strike; it does not buy time.
 *
 * ⚠️ **The existence check and the increment are one script, not two commands.** A plain `hIncrBy` auto-
 * vivifies a missing key with no TTL — so a strike racing another request's successful confirm or
 * five-strike disposal on the same key could recreate it, holding nothing but `requestTimes`, for ever.
 * Checking `EXISTS` a moment earlier would not close that: the deletion could still land in the gap
 * between the check and the increment. One round trip is what removes the gap.
 */
export async function strikePendingRegistration(key: string): Promise<void> {
	const store = redisClient as unknown as IPendingRegistrationScriptStore

	await store.eval(STRIKE_IF_EXISTS, { keys: [key], arguments: [] })
}

/** Removes a pending registration: consumed, or spent on five wrong hashes. */
export async function deletePendingRegistration(key: string): Promise<void> {
	await redisClient.del(key)
}

/**
 * `renewPendingRegistration`'s one write, guarded the same way `STRIKE_IF_EXISTS` guards its own: the
 * fields and the TTL land in the same round trip as the existence check, so nothing between a caller's
 * own read and this script can still slip a deletion into the gap.
 */
const RENEW_IF_EXISTS = `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'hash', ARGV[1], 'dateLastReq', ARGV[2], 'requestTimes', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1`

/**
 * Re-mints the link on an existing record: a new hash, a new window, and the strike count back to 1.
 *
 * The strikes counted attempts against the *old* hash, so clearing them with it is the honest reading —
 * the same thing koa-utils' `setEmailHash` did on the document.
 *
 * `_id`, `password` and `registeredAt` are untouched: this re-sends a registration, it does not restart
 * one.
 *
 * ⚠️ **The existence check runs in the same script as the write, not as a separate read beforehand.** A
 * caller such as `resendRegistration` reads the record first to decide whether there is anything to renew
 * at all — but that read and this write are two Redis round trips with no lock between them, and a
 * confirmation landing in the gap can delete the key the read just saw. A plain `HSET` there would build a
 * three-field ghost record — a hash with no `id`, no `email`, no `password` — that looks like a live link
 * for the rest of the TTL and that `readPendingRegistration` cannot turn back into an account. Folding the
 * check into the script closes the gap the caller's own read cannot: the answer this returns is current as
 * of the write, not as of some earlier read.
 *
 * @returns `true` when the key was still there and was renewed, `false` when it was not — the caller's
 * signal that there is nothing left to mail a link for.
 */
export async function renewPendingRegistration(slot: IPendingSlot, hash: string, at: Date): Promise<boolean> {
	const store = redisClient as unknown as IPendingRegistrationScriptStore

	const renewed = await store.eval(RENEW_IF_EXISTS, {
		keys: [slot.key],
		arguments: [hash, `${at.getTime()}`, '1', `${PENDING_TTL_SECONDS}`]
	})

	return renewed === 1
}
