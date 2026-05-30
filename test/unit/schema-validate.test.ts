// v1.2.110 — pins the minimal JSON-Schema validator used to gate tool
// calls before dispatch. Pure-function tests; the agent-loop wiring is
// covered separately by agent-loop-schema.test.ts.

import { describe, it, expect } from 'bun:test'
import {
  validateAgainstSchema,
  formatValidationErrors,
  type SchemaValidationError,
} from '../../src/core/llm/schema-validate.js'

describe('validateAgainstSchema — happy path', () => {
  it('no schema → no errors (open)', () => {
    expect(validateAgainstSchema({ anything: 1 }, undefined)).toEqual([])
    expect(validateAgainstSchema({ anything: 1 }, null)).toEqual([])
    expect(validateAgainstSchema(null, {})).toEqual([])
  })

  it('basic types match', () => {
    expect(validateAgainstSchema('hi', { type: 'string' })).toEqual([])
    expect(validateAgainstSchema(42, { type: 'number' })).toEqual([])
    expect(validateAgainstSchema(true, { type: 'boolean' })).toEqual([])
    expect(validateAgainstSchema([1, 2], { type: 'array' })).toEqual([])
    expect(validateAgainstSchema({}, { type: 'object' })).toEqual([])
    expect(validateAgainstSchema(null, { type: 'null' })).toEqual([])
  })

  it('integer accepted only for whole numbers', () => {
    expect(validateAgainstSchema(3, { type: 'integer' })).toEqual([])
    expect(validateAgainstSchema(3.5, { type: 'integer' })).toEqual([
      { path: '$', message: 'expected integer, got number' },
    ])
  })

  it('happy object: required + property types', () => {
    const schema = {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer' },
      },
    }
    expect(validateAgainstSchema({ path: '/a', limit: 5 }, schema)).toEqual([])
  })
})

describe('validateAgainstSchema — type mismatches', () => {
  it('wrong scalar type at root', () => {
    expect(validateAgainstSchema(123, { type: 'string' })).toEqual([
      { path: '$', message: 'expected string, got number' },
    ])
  })

  it('array vs object distinguished', () => {
    expect(validateAgainstSchema([1, 2], { type: 'object' })).toEqual([
      { path: '$', message: 'expected object, got array' },
    ])
  })

  it('null vs object distinguished', () => {
    expect(validateAgainstSchema(null, { type: 'object' })).toEqual([
      { path: '$', message: 'expected object, got null' },
    ])
  })

  it('stops at root type mismatch (no false-positive children)', () => {
    const schema = {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    }
    const errs = validateAgainstSchema('not-an-object', schema)
    // Should only flag the root mismatch, not "required field missing"
    expect(errs).toEqual([{ path: '$', message: 'expected object, got string' }])
  })
})

describe('validateAgainstSchema — required fields', () => {
  it('missing required → one error per missing field, with field path', () => {
    const schema = {
      type: 'object',
      required: ['ts_code', 'start_date'],
      properties: {
        ts_code: { type: 'string' },
        start_date: { type: 'string' },
      },
    }
    const errs = validateAgainstSchema({ ts_code: '600519.SH' }, schema)
    expect(errs).toEqual([{ path: 'start_date', message: 'required field missing' }])
  })

  it('present but null still counts as present (key in obj)', () => {
    // JSON Schema "required" checks key existence, not value-truthiness.
    const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }
    const errs = validateAgainstSchema({ path: null }, schema)
    // null fails the type check but NOT the required check.
    expect(errs).toEqual([{ path: 'path', message: 'expected string, got null' }])
  })
})

describe('validateAgainstSchema — enum', () => {
  it('matching enum is fine', () => {
    expect(validateAgainstSchema('C', { type: 'string', enum: ['C', 'P'] })).toEqual([])
  })

  it('non-matching enum errors with a readable allowed list', () => {
    const errs = validateAgainstSchema('X', { type: 'string', enum: ['C', 'P'] })
    expect(errs.length).toBe(1)
    expect(errs[0]!.path).toBe('$')
    expect(errs[0]!.message).toContain('must be one of')
    expect(errs[0]!.message).toContain('"C"')
    expect(errs[0]!.message).toContain('"P"')
  })

  it('large enum is truncated with overflow hint', () => {
    const enum10 = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const errs = validateAgainstSchema('z', { enum: enum10 })
    expect(errs[0]!.message).toContain('+5 more')
  })
})

describe('validateAgainstSchema — nested + arrays', () => {
  it('nested object: errors carry dot-path', () => {
    const schema = {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          required: ['from'],
          properties: { from: { type: 'string' }, to: { type: 'string' } },
        },
      },
    }
    const errs = validateAgainstSchema({ filters: { to: 'y' } }, schema)
    expect(errs).toEqual([{ path: 'filters.from', message: 'required field missing' }])
  })

  it('array items: errors carry bracket-index path', () => {
    const schema = {
      type: 'array',
      items: { type: 'integer' },
    }
    const errs = validateAgainstSchema([1, 'two', 3], schema)
    expect(errs).toEqual([{ path: '[1]', message: 'expected integer, got string' }])
  })
})

describe('validateAgainstSchema — additionalProperties: false', () => {
  it('extra fields flagged when explicitly opted in', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string' } },
    }
    const errs = validateAgainstSchema({ path: '/a', extra: 1 }, schema)
    expect(errs).toEqual([
      { path: 'extra', message: 'unexpected field (additionalProperties: false)' },
    ])
  })

  it('extras ignored by default (no additionalProperties keyword)', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } }
    expect(validateAgainstSchema({ path: '/a', extra: 1 }, schema)).toEqual([])
  })
})

describe('formatValidationErrors', () => {
  it('empty list → empty string', () => {
    expect(formatValidationErrors('any', [])).toBe('')
  })

  it('multiple errors → multi-line block with tool name + retry hint', () => {
    const errs: SchemaValidationError[] = [
      { path: 'path', message: 'required field missing' },
      { path: 'limit', message: 'expected integer, got string' },
    ]
    const out = formatValidationErrors('native_read_file', errs)
    expect(out).toContain('native_read_file')
    expect(out).toContain('path: required field missing')
    expect(out).toContain('limit: expected integer, got string')
    expect(out).toContain('NOT dispatched')
    expect(out).toContain('retry')
  })
})
