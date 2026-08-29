import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { redisClient } from '@axiumine/koa-utils/dataSources/Redis'
import { decryptDocument } from '@axiumine/marketplace-common/encryption/decryptDocument'
import { encryptDocument } from '@axiumine/marketplace-common/encryption/encryptDocument'
import {
	ENCRYPTED_FIELDS_SHOP_OWNER,
	KEY_ALT_NAME_SHOP_OWNER,
	KEY_ALT_NAME_USER
} from '@axiumine/marketplace-common/encryption/encryptedFields'
import { ALGORITHM_DETERMINISTIC } from '@axiumine/marketplace-common/encryption/EncryptionAlgorithm'
import { encryptValue } from '@axiumine/marketplace-common/encryption/fieldEncryption'
import { isCiphertext } from '@axiumine/marketplace-common/encryption/isCiphertext'
import {
	SCRUBBED_FIRST_NAME,
	SCRUBBED_LAST_NAME,
	SCRUBBED_PASSWORD_HASH,
	SCRUBBED_TEXT,
	scrubbedEmail
} from '@axiumine/marketplace-common/others/accountScrub'
import bcrypt from '@node-rs/bcrypt'
import * as dotenv from 'dotenv'
import type { Server } from 'http'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The sources call dotenv.config() transitively (MongoDB/Redis datasources); this is a
// belt-and-suspenders load so the values are present when this file's top level reads them.
dotenv.config()

/****************************************************************************************
 * The three mail edges, recorded instead of sent — and the only mocks in this file.
 *
 * Every notification this service can produce goes out through SocketLabs, from a real account with
 * a real reputation, and three of them are reachable from an unauthenticated `GET` while two more
 * are reachable from an unauthenticated mutation. The integration environment pins placeholder
 * credentials for that reason (see vitest.config.mts), so an unmocked send here would be an outbound
 * HTTPS call that fails and turns a passing branch into a thrown one.
 *
 * Recording them is what makes the whole registration chain drivable against real stores: the
 * activation hash arrives here exactly as it would arrive in somebody's inbox, and the tests below
 * click the link with it.
 *
 * ⚠️ The mailer is mocked at the module that *builds* it, not at `SocketLabsLib`. `registrationMailer`
 * is a value — one throttle for the process, shared by submit, confirm and resend — so the flows keep
 * their production bindings and only the far end of them is a recorder.
 ****************************************************************************************/

const { sent, sentLinks } = vi.hoisted(() => ({
	/** `[method, address, …]` for every guard notification the flows raised. */
	sent: [] as Array<Array<string | number>>,
	/** Every activation link that would have been mailed, by tier. */
	sentLinks: [] as Array<{ tier: string; email: string; hash: string }>
}))

vi.mock('../../src/lib/registration/registrationMailer.mts', () => ({
	registrationMailer: {
		emailAlreadyValid: async (email: string) => void sent.push(['emailAlreadyValid', email]),
		wrongHash: async (email: string, times: number) => void sent.push(['wrongHash', email, times]),
		tooMuchVerifyRequests: async (email: string) => void sent.push(['tooMuchVerifyRequests', email]),
		hashReqTooOld: async (email: string) => void sent.push(['hashReqTooOld', email]),
		accountDisabled: async (email: string) => void sent.push(['accountDisabled', email]),
		sendWelcome: async (email: string) => void sent.push(['sendWelcome', email])
	}
}))

// `importOriginal` because the route path each module exports is imported by the tests below to build
// the URL they call: replacing the send must not replace the literal that says where the link points.
vi.mock('../../src/lib/access/sendUserVerifyEmail.mts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/lib/access/sendUserVerifyEmail.mts')>()),
	sendUserVerifyEmail: async (email: string, hash: string) => void sentLinks.push({ tier: 'user', email, hash })
}))

vi.mock('../../src/lib/access/sendShopOwnerVerifyEmail.mts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/lib/access/sendShopOwnerVerifyEmail.mts')>()),
	sendShopOwnerVerifyEmail: async (email: string, hash: string) => void sentLinks.push({ tier: 'shopOwner', email, hash })
}))

import { ENDPOINT, start } from '../../src/index.mts'
import { SHOP_OWNER_VERIFY_LINK_PATH } from '../../src/lib/access/sendShopOwnerVerifyEmail.mts'
import { USER_VERIFY_LINK_PATH } from '../../src/lib/access/sendUserVerifyEmail.mts'
import {
	MAX_VERIFY_ATTEMPTS,
	PENDING_TTL_SECONDS,
	pendingSlot,
	readPendingRegistration,
	writePendingRegistration
} from '../../src/lib/registration/pendingRegistration.mts'
import { REGISTRATION_TARGET_SHOP_OWNER, REGISTRATION_TARGET_USER } from '../../src/lib/registration/registrationTargets.mts'
import { submitShopOwnerRegistration, submitUserRegistration } from '../../src/lib/registration/submitRegistration.mts'

const REDIS_KEY = process.env.REDIS_KEY as string

let httpServer: Server
let base: string

/** POST a GraphQL document to the real endpoint and return the parsed body. */
async function gql(query: string, variables?: Record<string, unknown>) {
	const res = await fetch(`${base}${ENDPOINT}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables })
	})

	return {
		status: res.status,
		json: (await res.json()) as {
			data?: Record<string, unknown>
			errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
		}
	}
}

/****************************************************************************************
 * Seeds for the resetPwd/updatePwd/verify-email describes below. Everything writes to this
 * service's own throwaway integration database (see vitest.mongo.mts), and every document
 * carries an `itest-…@marketplace.invalid` address besides, so it is also harmless if ever pointed
 * at a shared one. `_id`s are tracked at creation time and drained in afterAll.
 ****************************************************************************************/

const seededShopOwnerIds: mongoose.Types.ObjectId[] = []

/** Accounts opened by a registration this run confirmed, and the ids it minted for them. */
const registeredIds: Array<{ collection: 'user' | 'shopOwner'; _id: mongoose.Types.ObjectId }> = []

/** Pending-registration keys this run wrote. Their own TTL is three days, so they need draining. */
const pendingKeys: string[] = []

/** The raw driver handle — only defined once start() has connected. */
function db() {
	return mongoose.connection.db!
}

function itestEmail() {
	return `itest-${randomUUID()}@marketplace.invalid`
}

/** Fixed-length filler, not a real bcrypt hash: the validator only checks the 60-char length,
 * and neither resetPwd nor updatePwd ever reads this field on the seeded document — updatePwd
 * only ever WRITES a new one, on the success path this file deliberately does not drive (see
 * the comment on the describe block below). */
const FAKE_PASSWORD_HASH = '$2b$14$' + 'x'.repeat(53)

/**
 * Inserted with the raw driver rather than the Mongoose model, the platform seeding convention:
 * the insert is then shaped by the collection's own `$jsonSchema` and by nothing else, so a seed
 * cannot inherit whatever the model happens to believe today. That is not hypothetical — the model
 * used to spell `personalData.birth.date` as `date` and carry no `contacts` path at all, both of
 * which the validator refuses under `additionalProperties: false`, so a model write failed outright
 * (fixed in marketplace-common 1.17.0). The raw path was never affected, and will not be by the next
 * drift either.
 *
 * `login` merges into the `login` sub-document; `extra` merges at the document root, which is
 * where the validator puts `disabled`, `deleted`, `resetPwd` and `emailVerify` (see marketplace-db-setup's
 * create-shopOwner migration and the later alter-shopOwner-emailVerify one) — a gate, a
 * pre-seeded reset request or a pending verification link all need this second bucket.
 */
async function seedShopOwner(login: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const email = itestEmail()
	const _id = new mongoose.Types.ObjectId()

	// ⚠️ Encrypted after both override bags are spread in, and before the insert (ADR-029): a caller
	// overriding `login.email` or `emailVerify.newEmailTmp` gets its own value encrypted too, and the
	// fields those two name are `binData` subtype 6 in the collection. A plaintext seed would be a
	// document no resolver on the platform can produce, and the validator refuses it outright.
	await db()
		.collection('shopOwner')
		.insertOne(
			await encryptDocument(
				{
					_id,
					login: { email, password: FAKE_PASSWORD_HASH, ...login },
					personalData: {
						firstName: 'Itest',
						lastName: 'PublicResource',
						birth: { date: new Date('1985-06-15T00:00:00Z') },
						address: { street: '2 Test Street', postalCode: '01103', city: 'Springfield', province: 'MA' },
						contacts: { mobile: '3900000001', email }
					},
					registeredAt: new Date(),
					...extra
				},
				ENCRYPTED_FIELDS_SHOP_OWNER,
				KEY_ALT_NAME_SHOP_OWNER
			)
		)
	seededShopOwnerIds.push(_id)

	return { _id, email }
}

/**
 * The raw driver read every assertion in this file goes through, decrypted on the way back.
 *
 * The read is deliberately still the raw driver rather than the Mongoose model — the point of the
 * seeding convention above is that nothing in these tests is shaped by what the model believes — but
 * a raw read now answers `binData` where a personal field used to be, so what comes back has to be
 * put through the same key the write used. `decryptDocument` mutates in place and returns void: the
 * document handed back is the one just read, with every ciphertext replaced by its plaintext.
 *
 * `shopOwnerByIdEncrypted` is the deliberate exception, for the one test that has to prove the
 * ciphertext is really on disk.
 */
async function shopOwnerById(_id: mongoose.Types.ObjectId) {
	const stored = await db().collection('shopOwner').findOne({ _id })

	await decryptDocument(stored)

	return stored
}

function shopOwnerByIdEncrypted(_id: mongoose.Types.ObjectId) {
	return db().collection('shopOwner').findOne({ _id })
}

beforeAll(async () => {
	const server = await start()
	if (!server) throw new Error('server failed to start against the real Redis cluster / MongoDB')
	httpServer = server.httpServer
	const address = httpServer.address() as AddressInfo | null
	if (!address || typeof address === 'string') throw new Error('no TCP address on the booted server')
	base = `http://127.0.0.1:${address.port}`
})

/**
 * Cleanup must never abort halfway. `afterAll` drains MongoDB first and Redis second, so a single
 * failed delete — a cluster MOVED mid-resharding, a handle closed early — would otherwise strand
 * every id and key registered after it, and would skip the Redis drain entirely. Mongo residue is
 * harmless, globalSetup drops and re-migrates the database on the next run; a stranded Redis key
 * sits in the cluster for its whole TTL, which for a refresh session is 90 days.
 */
async function drainSafely(what: string, remove: () => Promise<unknown>) {
	try {
		await remove()
	} catch (error) {
		console.error(`[afterAll] cleanup failed for ${what}:`, error)
	}
}

afterAll(async () => {
	// Drop whatever this run created while the handles are still open. One document per id — the
	// index that would matter for a multi-key operation (CROSSSLOT) is a Redis concern; this loop
	// only ever touches MongoDB, but it keeps the same "one at a time" shape as the Redis cleanups
	// elsewhere in the platform for consistency.
	for (const _id of seededShopOwnerIds) {
		await drainSafely(`shopOwner ${_id.toString()}`, () => db().collection('shopOwner').deleteOne({ _id }))
	}
	for (const { collection, _id } of registeredIds) {
		await drainSafely(`${collection} ${_id.toString()}`, () => db().collection(collection).deleteOne({ _id }))
	}
	// Redis last, and one key at a time: a multi-key DEL is a CROSSSLOT error on a cluster.
	for (const key of pendingKeys) {
		await drainSafely(`pending registration ${key}`, () => redisClient.del(key))
	}
	await new Promise<void>((resolve) => httpServer.close(() => resolve()))
	await redisClient.close()
	await mongoose.disconnect()
})

describe('public-resource service (integration, real MongoDB + real Redis cluster)', () => {
	// start() is what wires both datasources; asserting the live handles is what makes the rest of
	// this file an integration suite rather than an in-process schema test.
	it('has a live MongoDB connection', () => {
		expect(mongoose.connection.readyState).toBe(1)
	})

	it('has a live Redis cluster connection, round-tripping a key in the isolated namespace', async () => {
		const key = `${REDIS_KEY}itest:${randomUUID()}`

		// EX so this one cannot outlive the run. It is never registered for the afterAll drain, so
		// without a TTL a hard kill — or a throw on the assertion below — strands it on the cluster
		// forever. 60s is far longer than the round trip and short enough to be self-cleaning.
		await redisClient.set(key, 'pong', { EX: 60 })
		expect(await redisClient.get(key)).toBe('pong')

		await redisClient.del(key)
		expect(await redisClient.get(key)).toBeNull()
	})
})

describe('GraphQL over HTTP', () => {
	it('serves the no-args query', async () => {
		const { status, json } = await gql('{ publicHelloNoArgs { txt } }')

		expect(status).toBe(200)
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicHelloNoArgs: { txt: 'Hello from publicHelloNoArgs' } })
	})

	it('serves the args query', async () => {
		const { json } = await gql('query ($name: String!) { publicHelloArgs(name: $name) { txt } }', { name: 'Luigi' })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicHelloArgs: { txt: 'Hello from publicHelloArgs - Luigi!' } })
	})

	it('serves the no-args mutation', async () => {
		const { json } = await gql('mutation { publicMutNoArgs }')

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicMutNoArgs: 'publicMutNoArgs' })
	})

	it('serves the args mutation', async () => {
		const { json } = await gql('mutation ($name: String!) { publicMutArgs(name: $name) }', { name: 'Mark' })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ publicMutArgs: 'publicMutArgs Mark' })
	})

	// Introspection stays open outside production (buildValidationRules returns no rules), and the
	// schema it reports is the one really assembled in createServer — not a copy rebuilt by a test.
	it('exposes the assembled schema through introspection', async () => {
		const { json } = await gql('{ __schema { queryType { name } mutationType { name } } }')

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ __schema: { queryType: { name: 'QueriesPublic' }, mutationType: { name: 'MutationsPublic' } } })
	})

	it('rejects a GET on the GraphQL endpoint (csrfPrevention / method not allowed)', async () => {
		const res = await fetch(`${base}${ENDPOINT}?query=%7B__typename%7D`)

		expect(res.status).toBeGreaterThanOrEqual(400)
	})
})

// Both halves of the reset really hit MongoDB — including mongoose.startSession() and
// withTransaction, which need the replica set. An address that does not exist is used on purpose:
// resetPwd answers true without persisting or mailing anything (no enumeration oracle), and
// updatePwd answers 403 for the same reason. Neither writes.
describe('reset-password flow bound to the shopOwner collection', () => {
	const unknownEmail = `itest-${randomUUID()}@marketplace.invalid`

	it('resetPwd answers true for an unknown address, without sending anything', async () => {
		const { json } = await gql('mutation ($email: String!) { resetPwd(email: $email) }', { email: unknownEmail })

		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })
	})

	it('updatePwd is forbidden for an unknown address', async () => {
		const { json } = await gql(
			'mutation ($e: String!, $h: String!, $p: String!) { updatePwd(email: $e, hash: $h, password: $p) }',
			{
				e: unknownEmail,
				h: 'x'.repeat(32),
				p: 'Str0ngPwd!2026'
			}
		)

		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()
	})
})

// The describe above only ever reaches the "email not found" branch of resetPwd/updatePwd — the
// one pair of branches that never touches a real document. Everything below seeds a real
// shopOwner through the raw driver and reads it back, to prove the OTHER branches for real:
// the account-state gate (deleted/disabled), the 10-minute resend throttle, and updatePwd's
// hash/expiry checks.
//
// Deliberately NOT driven here: either mutation's full SUCCESS path (a brand-new resetPwd
// request, or a completed updatePwd). Both end by really calling SocketLabsLib with the live
// SOCKETLABS_SERVER_ID/SERVER_APIKEY this service loads from .env (see the workspace CLAUDE.md's
// protected-secrets list) — resetPwd's send is fire-and-forget so it would not even block this
// suite, but updatePwd's confirmation IS awaited before the mutation returns. Firing a real send
// through the production email account from an automated test run is a materially different kind
// of side effect than a write to this service's own throwaway database, so it is listed under
// "uncovered" in the report rather than exercised here without a decision from whoever owns that
// account.
describe('resetPwd / updatePwd against a real seeded shopOwner (refusal branches)', () => {
	const resetPwdMutation = 'mutation ($email: String!) { resetPwd(email: $email) }'
	const updatePwdMutation = 'mutation ($e: String!, $h: String!, $p: String!) { updatePwd(email: $e, hash: $h, password: $p) }'

	/**
	 * Every refusal branch below makes the same three claims — the mutation errors, it resolves to
	 * null, and the seeded hash is still the stored password afterwards — and differs only in *why*
	 * the request was refused. The document is returned so each test can add the check that is its
	 * own reason for existing.
	 */
	async function expectUpdatePwdRefused(_id: mongoose.Types.ObjectId, email: string, hash: string) {
		const { json } = await gql(updatePwdMutation, { e: email, h: hash, p: 'Str0ngPwd!2026' })
		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()

		const doc = await shopOwnerById(_id)
		expect(doc?.login.password).toBe(FAKE_PASSWORD_HASH)

		return doc
	}

	it('resetPwd leaves a disabled account untouched: true is returned, no resetPwd sub-document is written', async () => {
		// ⚠️ `disabledReason` is not decoration: the validator carries `dependencies: { disabled:
		// ['disabledReason'] }`, so a suspension with no reason is a document the server refuses
		// outright (the platform owner's rule of 2026-08-29). A seed is held to it like any other write.
		const { _id, email } = await seedShopOwner({}, { disabled: true, disabledReason: 'itest suspension' })

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		// getResetPwd (see koa-utils getResetPwd.mjs) answers null for a disabled account, exactly
		// as it does for an unknown one — so resetPwd returns before saveResetReq is ever called.
		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd).toBeUndefined()
	})

	it('resetPwd leaves a deleted account untouched: true is returned, no resetPwd sub-document is written', async () => {
		const { _id, email } = await seedShopOwner({}, { deleted: new Date() })

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd).toBeUndefined()
	})

	// The 10-minute throttle (see koa-utils resetPwd.mjs) compares "now" against a real stored
	// resetDateReq: only a document already carrying one, read back through Mongo, can prove the
	// "too soon, don't regenerate" branch instead of the "first request" one.
	it('resetPwd throttles a resend requested less than 10 minutes after the last one: the stored hash is left exactly as seeded', async () => {
		const seededHash = 'a'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ resetPwd: { resetDateReq: new Date(Date.now() - 2 * 60 * 1000), resetHash: seededHash } }
		)

		const { json } = await gql(resetPwdMutation, { email })
		expect(json.errors).toBeUndefined()
		expect(json.data).toEqual({ resetPwd: true })

		const doc = await shopOwnerById(_id)
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	it('updatePwd refuses a wrong hash: 403, and neither the password nor the pending request are touched', async () => {
		const seededHash = 'b'.repeat(50)
		const { _id, email } = await seedShopOwner({}, { resetPwd: { resetDateReq: new Date(), resetHash: seededHash } })

		const doc = await expectUpdatePwdRefused(_id, email, 'c'.repeat(50))
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	it('updatePwd refuses a link older than 60 minutes even with the correct hash: 403, nothing is touched', async () => {
		const seededHash = 'd'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ resetPwd: { resetDateReq: new Date(Date.now() - 61 * 60 * 1000), resetHash: seededHash } }
		)

		const doc = await expectUpdatePwdRefused(_id, email, seededHash)
		expect(doc?.resetPwd.resetHash).toBe(seededHash)
	})

	// getResetPwd answers resetHash: null whenever resetDateReq is undefined — i.e. an account that
	// exists but has never requested a reset. koa-utils answers the SAME 403 as an unknown address
	// on purpose (see applyPasswordReset's own comment): a different status here would let
	// updatePwd enumerate registered accounts by which email holds a pending reset.
	it('updatePwd refuses an account with no pending reset request at all: the same 403 as an unknown address', async () => {
		const { email } = await seedShopOwner()

		const { json } = await gql(updatePwdMutation, { e: email, h: 'e'.repeat(50), p: 'Str0ngPwd!2026' })
		expect(json.errors).toBeDefined()
		expect(json.data?.updatePwd ?? null).toBeNull()
	})

	it('updatePwd refuses a disabled account even with a correct, unexpired hash: password is left exactly as seeded', async () => {
		const seededHash = 'f'.repeat(50)
		const { _id, email } = await seedShopOwner(
			{},
			{ disabled: true, disabledReason: 'itest suspension', resetPwd: { resetDateReq: new Date(), resetHash: seededHash } }
		)

		await expectUpdatePwdRefused(_id, email, seededHash)
	})
})

/****************************************************************************************
 * Registration, against the two stores it really spans.
 *
 * ADR-042 moved the pending half of a registration out of MongoDB and into Redis; ADR-043 made the
 * Redis record carry the address as the very ciphertext the collection indexes, so the confirm step
 * is a copy rather than a second encryption. Both claims are about what two live stores do with each
 * other, and neither is visible to a mocked model: the unit suite proves `confirmRegistration` runs
 * the scrub before the insert, but only a real `login.email_unique` proves that order is *enough*,
 * and only a real `$jsonSchema` proves the copied `Binary` is a document the collection accepts.
 *
 * ⚠️ **Three edges are mocked and only three, all of them mail.** `registrationMailer` and the two
 * link senders are recorded instead of sent — see the mock block at the top of this file. Everything
 * between the form and the account is the production path: the encryption, the Redis record and its
 * TTL, the transaction, the scrub, the unique index, the mounted route and the redirect it answers.
 *
 * ⚠️ **Every refusal below lands on the same page**, and that is the property rather than a loss of
 * resolution. A dead link, a wrong hash, a spent record and a link for the other tier all answer
 * `/x/email-check`, so an unauthenticated `GET` cannot be used to ask whether an address is
 * registered here. The one page that differs is `/x/error`, and it is reached only by a failure that
 * says nothing about the address — see the live-holder collision below.
 ****************************************************************************************/

/** The one plaintext every registration in this file is opened with. */
const REGISTRATION_PASSWORD = 'itest-registration-plaintext'

type Tier = 'user' | 'shopOwner'

/**
 * Everything the two tiers differ by, as this file needs it.
 *
 * `linkPath` is imported from the sender rather than written out, so this suite fails if the link
 * that goes in the mail and the route this service mounts ever drift apart. That pair is two
 * literals in two files with nothing joining them at run time — the failure mode their own comments
 * warn about is a link that 404s, and only a test that builds the URL from one and calls the other
 * notices.
 */
const TARGETS = {
	user: {
		keyAltName: KEY_ALT_NAME_USER,
		linkPath: USER_VERIFY_LINK_PATH,
		submit: submitUserRegistration,
		target: REGISTRATION_TARGET_USER
	},
	shopOwner: {
		keyAltName: KEY_ALT_NAME_SHOP_OWNER,
		linkPath: SHOP_OWNER_VERIFY_LINK_PATH,
		submit: submitShopOwnerRegistration,
		target: REGISTRATION_TARGET_SHOP_OWNER
	}
} as const

/**
 * Submits a registration exactly as the resolver does, and hands back what the click needs.
 *
 * The pending key and the account's `_id` are registered for the afterAll drain here — the `_id` is
 * minted at submit, so it is drainable before the document it names exists, which is the same
 * property that makes a replayed confirmation safe.
 *
 * ⚠️ It clears the two mail recorders, so a test that asserts on the mail is asserting on what its
 * own submit and clicks produced. The one caller that must see a mail sent *by* the submit does not
 * come through here.
 */
async function submitRegistration(tier: Tier, email = itestEmail(), password = REGISTRATION_PASSWORD) {
	sent.length = 0
	sentLinks.length = 0

	await TARGETS[tier].submit(email, password)

	const slot = await pendingSlot(TARGETS[tier].target, email)
	pendingKeys.push(slot.key)

	const record = await readPendingRegistration(slot.key)
	if (record === null) throw new Error(`submit wrote no pending record for ${email}`)

	registeredIds.push({ collection: tier, _id: record._id })

	return { email, password, record, slot }
}

/**
 * Clicks an activation link over HTTP, on the route this service really mounts, and answers the page
 * the browser ended on.
 *
 * The redirect itself is asserted in here because every branch of the confirm ends in one: there is
 * no path through this handler that renders a body, so a response that was not a redirect is a
 * failure whichever test hit it.
 */
async function click(tier: Tier, email: string, hash: string) {
	const res = await fetch(`${base}${TARGETS[tier].linkPath}/${encodeURIComponent(email)}/${hash}`)

	expect(res.redirected).toBe(true)

	return res.url.slice(base.length)
}

/** Every document of a tier holding an address, found the only way there is: by the ciphertext. */
async function accountsByEmail(tier: Tier, email: string) {
	return await db()
		.collection(tier)
		.find({ 'login.email': await encryptValue(email, ALGORITHM_DETERMINISTIC, TARGETS[tier].keyAltName) })
		.toArray()
}

/** Closes an account the way the admin service will: a stamp, and nothing removed. */
async function closeShopOwner(_id: mongoose.Types.ObjectId) {
	await db()
		.collection('shopOwner')
		.updateOne({ _id }, { $set: { deleted: new Date() } })
}

describe('a submitted registration is a Redis record and nothing else', () => {
	// ⚠️ The claim ADR-042 rests on, and the one the platform owner asked for in those words: a closed
	// account's address is reclaimed "when he will click the link to confirm the email, not before
	// that". An anonymous form post is not a click, so until one arrives nothing exists in MongoDB.
	it('writes no document, and a key that expires on its own', async () => {
		const { email, slot } = await submitRegistration('user')

		await expect(accountsByEmail('user', email)).resolves.toEqual([])

		// The three-day window is the key's own TTL now, so an abandoned registration is not a state
		// anybody has to notice — which is what the old lazily-evaluated guard could never manage.
		const ttl = await redisClient.ttl(slot.key)
		expect(ttl).toBeLessThanOrEqual(PENDING_TTL_SECONDS)
		expect(ttl).toBeGreaterThan(PENDING_TTL_SECONDS - 60)
	})

	// ⚠️ ADR-043, against the real cipher: the record holds the address as the deterministic
	// ciphertext MongoDB indexes, so the same bytes key the record, find the account and get inserted.
	// A `sha256` would key the record just as well and would put a second representation of the
	// address on this path; a plaintext one would put personal data in Redis in the clear.
	it('keeps the address as the ciphertext the collection indexes, never in the clear', async () => {
		const { email, slot } = await submitRegistration('user')

		const stored = await redisClient.hGetAll(slot.key)
		const ciphertext = await encryptValue(email, ALGORITHM_DETERMINISTIC, KEY_ALT_NAME_USER)

		expect(stored.email).toBe(Buffer.from(ciphertext.buffer).toString('hex'))

		// The local part alone, so this fails on a record that carries the address in any field at all
		// rather than only on one that carries it whole.
		expect(JSON.stringify(stored)).not.toContain(email.split('@')[0])
	})

	// bcrypt at submit rather than at confirm, so the plaintext dies with the request that carried it.
	// It is also what makes the confirm's `insertMany` correct: no `save` middleware runs there, so
	// this value lands in `login.password` exactly as it is — hashing in both places is what stored
	// `bcrypt(bcrypt(password))` in E18-S09 and opened accounts nobody could log in to.
	it('bcrypts the password once, at submit', async () => {
		const { password, slot } = await submitRegistration('user')

		const stored = await redisClient.hGetAll(slot.key)

		expect(stored.password).toMatch(/^\$2[aby]\$/)
		await expect(bcrypt.verify(password, stored.password)).resolves.toBe(true)
	})

	it('mails the link the record was written with', async () => {
		const { email, record } = await submitRegistration('user')

		expect(sentLinks).toEqual([{ tier: 'user', email, hash: record.hash }])
	})

	// The live branch: the address is taken, so the person who owns it is told and nothing is written.
	// The caller still answers `true` — the outcomes are distinguishable only in the inbox.
	it('mails the live holder and writes no record when the address is already registered', async () => {
		const { email } = await seedShopOwner()
		sent.length = 0

		await submitShopOwnerRegistration(email, REGISTRATION_PASSWORD)

		const slot = await pendingSlot(REGISTRATION_TARGET_SHOP_OWNER, email)
		await expect(readPendingRegistration(slot.key)).resolves.toBeNull()
		expect(sent).toEqual([['emailAlreadyValid', email]])
	})
})

describe('the activation link is what opens the account', () => {
	it('opens a customer account out of the record, and drops the key', async () => {
		const { email, password, record, slot } = await submitRegistration('user')

		expect(await click('user', email, record.hash)).toBe('/x/registration-done')

		const [account] = await accountsByEmail('user', email)

		// The `_id` was minted at submit, three days before this click was allowed to happen.
		expect(account._id.equals(record._id)).toBe(true)
		expect(account.registeredAt).toEqual(record.registeredAt)

		// `emailVerify` keeps `valid` and nothing else: the hash, the window and the strike counter
		// were the pending state, and the pending state was the Redis key.
		expect(account.emailVerify).toEqual({ valid: true })
		expect(account).not.toHaveProperty('waitApprov')
		expect(account).not.toHaveProperty('personalData')

		// ⚠️ Byte for byte what Redis held. Nothing on the confirm path encrypts anything — the
		// model's `pre('insertMany')` pass is idempotent over a `Binary` subtype 6, which is the only
		// reason a copy is safe to hand it.
		expect(isCiphertext(account.login.email)).toBe(true)
		expect(Buffer.from(account.login.email.buffer)).toEqual(Buffer.from(record.email.buffer))

		// And it is a ciphertext this collection's own key produced, not merely some ciphertext.
		expect(account.login.email).toEqual(await encryptValue(email, ALGORITHM_DETERMINISTIC, KEY_ALT_NAME_USER))

		await expect(bcrypt.verify(password, account.login.password)).resolves.toBe(true)
		await expect(redisClient.exists(slot.key)).resolves.toBe(0)
	})

	// ⚠️ `waitApprov` is written here or nowhere. Selling on the platform is a commercial relationship
	// with the operator, so a stranger may ask to become a shop owner but may not become one by
	// filling in a form — and before ADR-042 the flag lived on a document a public mutation could
	// reach, which is how the deleted restart path revived an account with the gate already cleared.
	it('opens a shop owner parked behind the approval queue', async () => {
		const { email, record } = await submitRegistration('shopOwner')

		expect(await click('shopOwner', email, record.hash)).toBe('/x/registration-done')

		const [account] = await accountsByEmail('shopOwner', email)

		expect(account.waitApprov).toBe(true)
		expect(account.emailVerify).toEqual({ valid: true })
	})

	it('sends one welcome mail, and refuses the second click on the link it honoured', async () => {
		const { email, record } = await submitRegistration('user')

		expect(await click('user', email, record.hash)).toBe('/x/registration-done')
		expect(await click('user', email, record.hash)).toBe('/x/email-check')

		expect(sent).toEqual([['sendWelcome', email]])
		await expect(accountsByEmail('user', email)).resolves.toHaveLength(1)
	})

	// ⚠️ The tier is in the Redis key because `user` and `shopOwner` are unrelated collections
	// (ADR-002) and one person may legitimately be both, at the same address, at the same time. The
	// two routes differ only in path and both take an address, so a customer's link answered by the
	// seller's confirm would open a `shopOwner` account for somebody who asked to be a customer.
	it('will not confirm a customer registration on the seller route', async () => {
		const { email, record } = await submitRegistration('user')

		expect(await click('shopOwner', email, record.hash)).toBe('/x/email-check')

		await expect(accountsByEmail('shopOwner', email)).resolves.toEqual([])
		await expect(accountsByEmail('user', email)).resolves.toEqual([])
	})

	it('answers a link nobody ever submitted with the same page as a wrong one', async () => {
		sent.length = 0

		expect(await click('user', itestEmail(), 'x'.repeat(50))).toBe('/x/email-check')

		expect(sent).toEqual([])
	})
})

describe('a closed account holds its address until somebody proves they can read mail at it', () => {
	// The first half of the platform owner's rule, and the reason submit writes nothing: for the whole
	// three days the registration is pending, the closed document is exactly as its owner left it.
	it('is untouched while the new registration is only pending', async () => {
		const { _id, email } = await seedShopOwner()
		await closeShopOwner(_id)

		await submitRegistration('shopOwner', email)

		const closed = await shopOwnerById(_id)
		expect(closed?.login.email).toBe(email)
		expect(closed).not.toHaveProperty('scrubbedAt')
	})

	// ⚠️ **The claim no mock can make.** `login.email_unique` carries no `partialFilterExpression`
	// (ADR-011), so the closed document holds the address until its value moves — and MongoDB enforces
	// a unique index at each write rather than at commit, so scrub-then-insert inside one transaction
	// is the only ordering that works. The unit suite proves the calls are in that order; this proves
	// the order is enough.
	//
	// The scrub is `buildAccountScrub`, the same update the day-30 retention sweep runs, and it goes
	// through Mongoose with `runValidators: true` — so the plugin encrypts the `$set` on the way past
	// and the collection's own `$jsonSchema` gets a vote. `shopOwner.personalData` is all-or-nothing:
	// its `required` list names five members and `address`'s names four of its own, so a scrub that
	// wrote the customer's two-field shape here would be refused by the server.
	it('is scrubbed and replaced at the click, past login.email_unique', async () => {
		const { _id: closedId, email } = await seedShopOwner()
		await closeShopOwner(closedId)
		const before = await shopOwnerById(closedId)

		const { record } = await submitRegistration('shopOwner', email)

		expect(await click('shopOwner', email, record.hash)).toBe('/x/registration-done')

		// One holder of the address, and it is the account this click opened.
		const holders = await accountsByEmail('shopOwner', email)
		expect(holders).toHaveLength(1)
		expect(holders[0]._id.equals(record._id)).toBe(true)

		// The row stays, the person does not (ADR-041). Everything that says *who* they were is
		// overwritten; everything that records *that they held an account* survives.
		const closed = await shopOwnerById(closedId)
		expect(closed?.login.email).toBe(scrubbedEmail(`${closedId}`))
		expect(closed?.login.password).toBe(SCRUBBED_PASSWORD_HASH)
		expect(closed?.personalData.firstName).toBe(SCRUBBED_FIRST_NAME)
		expect(closed?.personalData.lastName).toBe(SCRUBBED_LAST_NAME)
		expect(closed?.personalData.address.city).toBe(SCRUBBED_TEXT)
		expect(closed?.personalData.contacts.email).toBe(scrubbedEmail(`${closedId}`))
		expect(closed?.scrubbedAt).toBeInstanceOf(Date)
		expect(closed?.deleted).toEqual(before?.deleted)
		expect(closed?.registeredAt).toEqual(before?.registeredAt)
	})

	// ⚠️ **`deleted` is in the scrub's filter, not merely checked by the caller**, and this is what
	// proves the clause carries weight. Submit already refused the live case, so no browser can get
	// here — the guard is for the caller that does not exist yet. A live account is not scrubbed, the
	// insert is refused by the index, and the failure is loud: no account is opened, the live document
	// keeps everything, and the record survives so the click can be retried once the collision is dealt
	// with. `/x/error` rather than `/x/email-check` because the driver's message is not a safe redirect
	// target and the handler's allowlist refuses it — which is also the only thing standing between a
	// message derived from a request parameter and an open redirect.
	it('refuses loudly rather than scrubbing a live account holding the address', async () => {
		const { email, record, slot } = await submitRegistration('shopOwner')
		const { _id: liveId } = await seedShopOwner({ email })

		expect(await click('shopOwner', email, record.hash)).toBe('/x/error')

		const holders = await accountsByEmail('shopOwner', email)
		expect(holders).toHaveLength(1)
		expect(holders[0]._id.equals(liveId)).toBe(true)
		expect(holders[0]).not.toHaveProperty('scrubbedAt')

		await expect(redisClient.exists(slot.key)).resolves.toBe(1)
	})
})

describe('a replayed confirmation', () => {
	// ⚠️ The failure ADR-042 names by hand: the confirm spans Redis and MongoDB and can only be
	// idempotent, not atomic, so a crash between the commit and the `DEL` leaves a live key over a
	// live account. The pre-minted `_id` is what makes the replay knowable — the insert fails on the
	// duplicate, and a document carrying *this record's* `_id` can only have been written by an
	// earlier run of this same confirmation. Re-writing the record here is that crash, exactly.
	it('opens one account, mails one welcome, and still clears the key', async () => {
		const { email, record, slot } = await submitRegistration('user')

		expect(await click('user', email, record.hash)).toBe('/x/registration-done')

		await writePendingRegistration(slot, record)

		expect(await click('user', email, record.hash)).toBe('/x/registration-done')

		await expect(accountsByEmail('user', email)).resolves.toHaveLength(1)
		expect(sent).toEqual([['sendWelcome', email]])
		await expect(redisClient.exists(slot.key)).resolves.toBe(0)
	})
})

describe('the strike counter belongs to the record, and does not buy time', () => {
	// ⚠️ **A wrong hash spends a strike; it does not extend the window.** `strikePendingRegistration`
	// is the one write on this path that must not go through the module's `writeRecord`, because that
	// one re-arms the TTL — and a strike that re-armed it would let anybody keep somebody else's
	// pending registration alive indefinitely by guessing at their link. The TTL is shortened first so
	// a re-arm would be visible: on a fresh key both readings are three days and nothing is provable.
	it('counts a wrong hash without re-arming the three-day window', async () => {
		const { email, slot } = await submitRegistration('user')
		await redisClient.expire(slot.key, 120)

		expect(await click('user', email, 'w'.repeat(50))).toBe('/x/email-check')

		await expect(redisClient.hGet(slot.key, 'requestTimes')).resolves.toBe('2')
		expect(await redisClient.ttl(slot.key)).toBeLessThanOrEqual(120)
		expect(sent).toEqual([['wrongHash', email, 2]])
		await expect(accountsByEmail('user', email)).resolves.toEqual([])
	})

	// The ceiling is checked before the hash, so the correct link no longer works either: at five
	// strikes the link is being guessed at rather than clicked, and what is left of the registration
	// is destroyed rather than left for the guesser to keep working on.
	it('destroys a record whose five attempts are spent, and opens nothing', async () => {
		const { email, record, slot } = await submitRegistration('user')
		await redisClient.hSet(slot.key, { requestTimes: `${MAX_VERIFY_ATTEMPTS}` })

		expect(await click('user', email, record.hash)).toBe('/x/email-check')

		await expect(redisClient.exists(slot.key)).resolves.toBe(0)
		await expect(accountsByEmail('user', email)).resolves.toEqual([])
		expect(sent).toEqual([['tooMuchVerifyRequests', email]])
	})
})

/**
 * The at-rest half of ADR-029, on the service that has to *find* an account by its email address.
 *
 * Both flows this file drives — reset-password and verify-email — look a shopOwner up by address,
 * and the address in the collection is a ciphertext. The lookup works only because `login.email` is
 * encrypted **deterministically**: the same address always produces the same bytes, so an equality
 * match on the bytes is an equality match on the address. Everything else personal is random, which
 * is why two shopOwners spelling `Springfield` are two different ciphertexts.
 *
 * That difference is the whole assertion. A field quietly switched from random to deterministic
 * would still round-trip, still pass every other test in this file, and would still answer every
 * query correctly — while handing anyone with read access to the collection an equality oracle over
 * the personal data. Nothing but a same-value/different-ciphertext check notices.
 */
describe('personal fields at rest', () => {
	it('stores login.email deterministically and every other personal field randomly', async () => {
		const { _id, email } = await seedShopOwner()
		const other = await seedShopOwner()

		const stored = await shopOwnerByIdEncrypted(_id)
		const storedOther = await shopOwnerByIdEncrypted(other._id)

		// Nothing readable survives the write.
		expect(isCiphertext(stored?.login.email)).toBe(true)
		expect(isCiphertext(stored?.personalData.contacts.mobile)).toBe(true)
		expect(isCiphertext(stored?.personalData.address.street)).toBe(true)
		expect(isCiphertext(stored?.personalData.birth.date)).toBe(true)

		// Deterministic: re-encrypting the plaintext address reproduces the stored bytes exactly,
		// which is what makes `{ 'login.email': <ciphertext> }` a working filter for both flows.
		expect(stored?.login.email).toEqual(await encryptValue(email, ALGORITHM_DETERMINISTIC, KEY_ALT_NAME_SHOP_OWNER))

		// Random: two shopOwners seeded with the identical street are stored as different bytes.
		expect(stored?.personalData.address.street).not.toEqual(storedOther?.personalData.address.street)

		// NOT encrypted, deliberately: the password is already a hash and the city is a sort key on
		// the shop-owner table in the admin frontend, which a ciphertext would order by its bytes.
		expect(isCiphertext(stored?.login.password)).toBe(false)
		expect(stored?.personalData.address.city).toBe('Springfield')
	})
})

describe('non-GraphQL routes', () => {
	it('serves /health', async () => {
		const res = await fetch(`${base}/health`)

		expect(res.status).toBe(200)
		const json = (await res.json()) as { status: string; timestamp: string }
		expect(json.status).toBe('OK')
		expect(json.timestamp).toBe(new Date(json.timestamp).toISOString())
	})

	it('mounts the /check router', async () => {
		const res = await fetch(`${base}/check/`)

		expect(res.status).toBe(200)
		expect(await res.text()).toBe('')
	})

	it('falls through to 404 for an unknown path', async () => {
		const res = await fetch(`${base}/nope`)

		expect(res.status).toBe(404)
	})
})
