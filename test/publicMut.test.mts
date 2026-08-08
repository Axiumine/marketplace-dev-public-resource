import { graphql, GraphQLBoolean, GraphQLNonNull, GraphQLSchema, GraphQLString } from 'graphql'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// resetPwd and updatePwd are real GraphQL fields, but both are now built by koa-utils' factory
// against koa-utils' OWN copy of the `graphql` package. Vitest inlines/transforms the `graphql`
// this file imports, while `@axiumine/koa-utils` itself is loaded externally by Node - so the two
// `graphql` copies are version-identical but fail `instanceof` checks against each other ("Cannot
// use GraphQLNonNull ... from another module or realm") the instant a schema mixing both is
// constructed. Stub the bound flow, rebuilt from THIS file's `graphql` import, so the rest of
// MutationsPublic - all authored locally - is exercised for real. The field shapes below mirror
// koa-utils'; what actually binds them to `shopOwner` is pinned in resetPwdFlow.test.mts.
vi.mock('../src/lib/access/resetPwdFlow.mts', () => ({
	resetPwd: {
		description: 'send reset password link',
		type: new GraphQLNonNull(GraphQLBoolean),
		args: { email: { type: new GraphQLNonNull(GraphQLString) } },
		resolve: vi.fn()
	},
	updatePwd: {
		description: "changes the user's password",
		type: new GraphQLNonNull(GraphQLBoolean),
		args: {
			email: { type: new GraphQLNonNull(GraphQLString) },
			hash: { type: new GraphQLNonNull(GraphQLString) },
			password: { type: new GraphQLNonNull(GraphQLString) }
		},
		resolve: vi.fn()
	}
}))

// Imported dynamically inside beforeEach, not at module top level and not in beforeAll. A
// top-level import (even a top-level `await import()`) runs during Vitest's file-collection
// phase, before any test executes, and beforeAll is not enough either: a mutant that wipes
// MutationsPublic's/QueriesPublic's config object empties `name`, and graphql-js's `devAssert`
// throws "Must provide name." while building it - a throw inside beforeAll fails the hook itself,
// which Vitest reports as every test in the file being SKIPPED, not FAILED, and a skipped test
// still reads as Survived to Stryker. beforeEach runs inside the per-test window Stryker does
// track, so the same throw now fails each test individually. The repeated dynamic imports are
// cheap: Node's module cache resolves them from the first (real) evaluation, it does not re-run
// the module body.
let publicMutArgs: (typeof import('../src/graphQLPublic/schema/mutations/publicMutArgs.mts'))['publicMutArgs']
let publicMutNoArgs: (typeof import('../src/graphQLPublic/schema/mutations/publicMutNoArgs.mts'))['publicMutNoArgs']
let QueriesPublic: (typeof import('../src/graphQLPublic/schema/queries.mts'))['default']
let MutationsPublic: (typeof import('../src/graphQLPublic/schema/mutations.mts'))['default']

beforeEach(async () => {
	;({ publicMutArgs } = await import('../src/graphQLPublic/schema/mutations/publicMutArgs.mts'))
	;({ publicMutNoArgs } = await import('../src/graphQLPublic/schema/mutations/publicMutNoArgs.mts'))
	;({ default: QueriesPublic } = await import('../src/graphQLPublic/schema/queries.mts'))
	;({ default: MutationsPublic } = await import('../src/graphQLPublic/schema/mutations.mts'))
})

describe('mutations.publicMutNoArgs', () => {
	it('is of non-nullable String type', () => {
		expect(publicMutNoArgs.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicMutNoArgs.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})

	it('takes no arguments', () => {
		expect('args' in publicMutNoArgs).toBe(false)
	})

	it('describes itself as publicMutNoArgs', () => {
		expect(publicMutNoArgs.description).toBe('publicMutNoArgs')
	})

	it('resolves the literal string', () => {
		expect(publicMutNoArgs.resolve()).toBe('publicMutNoArgs')
	})
})

describe('mutations.publicMutArgs', () => {
	it('is of non-nullable String type', () => {
		expect(publicMutArgs.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicMutArgs.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})

	it('declares name as a non-nullable String argument', () => {
		expect(Object.keys(publicMutArgs.args)).toEqual(['name'])
		expect(publicMutArgs.args.name.type).toBeInstanceOf(GraphQLNonNull)
		expect((publicMutArgs.args.name.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})

	it('describes itself as publicMutArgs', () => {
		expect(publicMutArgs.description).toBe('publicMutArgs')
	})

	it('interpolates the name into the returned string', () => {
		expect(publicMutArgs.resolve(null, { name: 'Mark' })).toBe('publicMutArgs Mark')
	})
})

describe('MutationsPublic', () => {
	it('mounts the demo pair, the reset flow and the two customer mutations as its fields', () => {
		expect(MutationsPublic.name).toBe('MutationsPublic')
		expect(Object.keys(MutationsPublic.getFields())).toEqual([
			'publicMutArgs',
			'publicMutNoArgs',
			'resetPwd',
			'updatePwd',
			'userRegister',
			'userResetPwd',
			'userUpdatePwd',
			'userVerifyEmailResend'
		])
	})

	it('runs the no-args mutation end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic, mutation: MutationsPublic }),
			source: 'mutation { publicMutNoArgs }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ publicMutNoArgs: 'publicMutNoArgs' })
	})

	it('runs the args mutation end-to-end', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic, mutation: MutationsPublic }),
			source: 'mutation { publicMutArgs(name: "Luigi") }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ publicMutArgs: 'publicMutArgs Luigi' })
	})

	it('rejects the args mutation without the mandatory name', async () => {
		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesPublic, mutation: MutationsPublic }),
			source: 'mutation { publicMutArgs }'
		})

		expect(result.errors).toBeDefined()
		expect(result.errors?.[0].message).toMatch(/argument "name"/i)
	})
})
