// schema-validate — minimal JSON-Schema validator for tool-call arguments.
//
// Rationale (v1.2.110): provider-base / openai-compat-provider pass tool
// schemas to the LLM verbatim but do not validate the args the model
// sends back. Per-dispatcher defensive parsing catches some malformed
// inputs but its error messages — when surfaced at all — aren't shaped
// for the model to fix on the next iteration. Result: the model often
// retries with the same wrong shape, eating iterations until something
// breaks.
//
// We intentionally do NOT pull `ajv` for this:
//   * agim's tool schemas are flat object types with simple type / enum
//     / required constraints. The 250+ KB cost and license footprint
//     are not justified.
//   * A focused 80-line validator covers the cases we actually see
//     (missing required, wrong scalar type, bad enum, extra fields when
//     additionalProperties:false). When real-world schemas grow beyond
//     this, swapping in ajv is straightforward.
//
// What's covered:
//   - `type` for primitives + array/object (`integer` distinct from `number`)
//   - `required: string[]` on objects
//   - `properties[k]` recurses one level for nested objects
//   - `items` recurses for array elements (homogeneous schema only)
//   - `enum`: exact set membership (deep-equal for objects/arrays)
//   - `additionalProperties: false`: extra keys reported
//
// What's NOT covered (returns "ok" silently):
//   - $ref, oneOf / anyOf / allOf, conditional schemas
//   - format keywords (`format: "email"` etc.)
//   - numeric constraints (`minimum`, `maximum`, `multipleOf`)
//   - string constraints (`minLength`, `pattern`)
//   - `prefixItems`, tuple validation
//
// Failing closed on unsupported keywords would create false positives
// against schemas authored for ajv. The intent here is "catch the
// frequent + cheap cases" not "be a complete validator".

export interface SchemaValidationError {
  /** Dot-path from the args root, e.g. `path` or `filters.from`. */
  path: string
  message: string
}

function getRuntimeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function typeMatches(value: unknown, declared: string): boolean {
  const actual = getRuntimeType(value)
  if (declared === 'integer') return actual === 'number' && Number.isInteger(value)
  return actual === declared
}

/** Shallow deep-equal for enum membership. Covers primitives, plain
 *  arrays, and one level of object nesting — enough for typical enum
 *  values (strings, numbers, simple option objects). */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => looseEqual(x, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as object)
    const bk = Object.keys(b as object)
    if (ak.length !== bk.length) return false
    return ak.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k)
      && looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  }
  return false
}

/**
 * Validate `value` against `schema`. Returns an empty array on success
 * or one entry per violation. Continues past most errors so the caller
 * (the agent loop) can give the model a single message listing
 * everything wrong, not iterations of one-error-at-a-time corrections.
 * Stops short of recursing through a type-mismatched root — once we know
 * the value is the wrong shape, deeper checks would be noise.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: unknown,
  path = '',
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = []
  if (!schema || typeof schema !== 'object') return errors
  const s = schema as Record<string, unknown>

  const declaredType = typeof s.type === 'string' ? (s.type as string) : null
  if (declaredType && !typeMatches(value, declaredType)) {
    errors.push({
      path: path || '$',
      message: `expected ${declaredType}, got ${getRuntimeType(value)}`,
    })
    return errors // structural mismatch — deeper checks would be misleading
  }

  if (Array.isArray(s.enum)) {
    const allowed = s.enum
    if (!allowed.some((v) => looseEqual(v, value))) {
      const allowedShown = allowed.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')
        + (allowed.length > 5 ? `, … (+${allowed.length - 5} more)` : '')
      errors.push({
        path: path || '$',
        message: `must be one of [${allowedShown}], got ${JSON.stringify(value)}`,
      })
    }
  }

  const actualType = getRuntimeType(value)

  if (actualType === 'object' && (declaredType === 'object' || declaredType === null)) {
    const obj = value as Record<string, unknown>
    const required = Array.isArray(s.required) ? (s.required as string[]) : []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) {
        errors.push({ path: path ? `${path}.${key}` : key, message: 'required field missing' })
      }
    }
    const props = (s.properties && typeof s.properties === 'object'
      ? s.properties as Record<string, unknown>
      : {}) as Record<string, unknown>
    for (const [key, propVal] of Object.entries(obj)) {
      const propSchema = props[key]
      if (propSchema !== undefined) {
        errors.push(...validateAgainstSchema(propVal, propSchema, path ? `${path}.${key}` : key))
      }
    }
    if (s.additionalProperties === false) {
      const allowed = new Set(Object.keys(props))
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({
            path: path ? `${path}.${key}` : key,
            message: 'unexpected field (additionalProperties: false)',
          })
        }
      }
    }
  }

  if (actualType === 'array' && (declaredType === 'array' || declaredType === null)) {
    const arr = value as unknown[]
    const itemSchema = s.items
    if (itemSchema) {
      arr.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, itemSchema, `${path}[${i}]`))
      })
    }
  }

  return errors
}

/** Format an error list as a single multi-line string suitable for
 *  injection into a `role:'tool'` message so the model sees a clear
 *  "your args were wrong because X, Y, Z — fix and retry" signal. */
export function formatValidationErrors(
  toolName: string,
  errors: SchemaValidationError[],
): string {
  if (errors.length === 0) return ''
  const lines: string[] = [`tool call validation failed for \`${toolName}\`:`]
  for (const e of errors) {
    lines.push(`  - ${e.path || '$'}: ${e.message}`)
  }
  lines.push('Tool was NOT dispatched. Please retry with corrected arguments.')
  return lines.join('\n')
}
