// The part of the verify-email binding that is the same on both collections.
//
// `verifyEmailFlow.test.mts` binds the flow to `shopOwner`, `userFlows.test.mts` binds a second one
// to `user`, and the two bindings are deliberately separate modules — a shared one would confirm a
// customer's link against `shopOwner` and report every valid hash as a bad one. What they are NOT
// free to differ on is the argument shape koa-utils is handed: the same four keys, the same disposal
// policy, the same Date factory. That contract lives here, so it is asserted once and both suites
// state which model, which paths and which domain they hang off it.
//
// This file is NOT a test file — see `queryChain.mts` for why nothing under `test/support/` is
// collected.

import { expect } from 'vitest'

/**
 * The whole argument object, key set included.
 *
 * ⚠️ A mutant that drops `onAbandon` fails no per-key assertion: koa-utils then defaults it to
 * `'delete'`, which is precisely the behaviour both bindings exist to avoid. The shop owner's
 * integration suite additionally builds its own flow from these same values plus a recording mailer,
 * an argument that only holds while nothing else is being passed.
 */
export const expectFlowArguments = (call: Record<string, unknown>): void => {
	expect(Object.keys(call)).toEqual(['model', 'paths', 'onAbandon', 'deletedValue'])
}

/** Disposal policy: the document is tombstoned, never dropped. Each suite says why for its own tier. */
export const expectSoftDeleteOnAbandon = (call: { onAbandon: unknown }): void => {
	expect(call.onAbandon).toBe('soft-delete')
}

/**
 * ⚠️ Called twice rather than captured once. koa-utils defaults `deletedValue` to boolean `true`,
 * and the function form is the only reason the tombstone carries the moment of the write rather than
 * the moment the module was first imported — a constant would pass every `instanceof Date` check and
 * stamp every account with the same second.
 *
 * That the collection actually declares a Date is the caller's assertion: the two suites hold two
 * different models.
 */
export const expectFreshDateFactory = (deletedValue: () => Date): void => {
	expect(typeof deletedValue).toBe('function')

	const first = deletedValue()
	const second = deletedValue()

	expect(first).toBeInstanceOf(Date)
	expect(second).toBeInstanceOf(Date)
	expect(second).not.toBe(first)
	expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime())
}
