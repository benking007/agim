// cli-ui/prompts.ts — thin wrappers around @inquirer/prompts with two
// conveniences the underlying library doesn't bake in:
//
//   1. A standardized "← Back" choice that callers can detect by the
//      sentinel return value `BACK`. This lets loops at any level handle
//      navigation without each call site reaching into the prompt API.
//   2. Graceful exit on Ctrl-C — inquirer throws `ExitPromptError`; we
//      catch + re-throw as our own `UserAbortError` so callers can decide
//      whether to exit (top-level) or treat as Back (nested).

import {
  select,
  checkbox,
  input,
  password,
  confirm,
  Separator,
} from '@inquirer/prompts'
import { t, type Lang, type Key } from './i18n.js'

export const BACK = Symbol('back')
export type BackSentinel = typeof BACK

export class UserAbortError extends Error {
  constructor() {
    super('User pressed Ctrl-C')
    this.name = 'UserAbortError'
  }
}

function rethrowAbort(err: unknown): never {
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ExitPromptError') {
    throw new UserAbortError()
  }
  throw err
}

export interface MenuChoice<T> {
  /** Value returned when this choice is picked. */
  value: T
  /** Display name (already localized). */
  name: string
  /** Optional dim-text description shown to the right. */
  description?: string
  /** Optional separator before this item (renders a divider). */
  separatorBefore?: boolean
  /** When true, item is shown but cannot be selected. */
  disabled?: boolean | string
}

/**
 * Single-choice menu with arrow keys + Enter. If `back` is provided
 * (a key from i18n.ts pointing at a `← Back`-style string), an extra
 * back entry is appended; picking it returns the BACK sentinel.
 */
export async function menu<T>(opts: {
  lang: Lang
  message: string
  choices: MenuChoice<T>[]
  back?: Key
  default?: T
}): Promise<T | BackSentinel> {
  const choices: Array<MenuChoice<T | BackSentinel> | Separator> = []
  for (const c of opts.choices) {
    if (c.separatorBefore) {
      // Statically imported above. require() doesn't exist in ESM modules,
      // so an earlier lazy-import attempt crashed at runtime.
      choices.push(new Separator())
    }
    choices.push({
      value: c.value as T | BackSentinel,
      name: c.name,
      description: c.description,
      disabled: c.disabled,
    })
  }
  if (opts.back) {
    choices.push({ value: BACK as T | BackSentinel, name: t(opts.lang, opts.back) })
  }
  try {
    return await select<T | BackSentinel>({
      message: opts.message,
      choices: choices as { value: T | BackSentinel; name: string }[],
      default: opts.default as T | BackSentinel | undefined,
      loop: false,
    })
  } catch (err) { rethrowAbort(err) }
}

/**
 * Multi-select with Space to toggle. Always returns an array (possibly
 * empty). No back option — typical usage is "pick which IMs to enable";
 * cancel is via Ctrl-C → UserAbortError.
 */
export async function multiSelect<T extends string>(opts: {
  lang: Lang
  message: string
  choices: Array<{ value: T; name: string; description?: string; checked?: boolean }>
  required?: boolean
}): Promise<T[]> {
  try {
    return await checkbox<T>({
      message: opts.message,
      choices: opts.choices,
      required: opts.required ?? false,
      loop: false,
    })
  } catch (err) { rethrowAbort(err) }
}

/** Free-text input with optional default + validator. */
export async function inputText(opts: {
  message: string
  default?: string
  validate?: (v: string) => true | string
  required?: boolean
}): Promise<string> {
  try {
    return await input({
      message: opts.message,
      default: opts.default,
      validate: (v: string) => {
        if (opts.required && !v.trim()) return 'Required'
        if (opts.validate) return opts.validate(v)
        return true
      },
    })
  } catch (err) { rethrowAbort(err) }
}

/** Hidden input for secrets (no echo). */
export async function inputSecret(opts: {
  message: string
  required?: boolean
  validate?: (v: string) => true | string
}): Promise<string> {
  try {
    return await password({
      message: opts.message,
      mask: '*',
      validate: (v: string) => {
        if (opts.required && !v) return 'Required'
        if (opts.validate) return opts.validate(v)
        return true
      },
    })
  } catch (err) { rethrowAbort(err) }
}

/** Yes/no with arrow-key navigation. */
export async function yesNo(opts: { message: string; default?: boolean }): Promise<boolean> {
  try {
    return await confirm({ message: opts.message, default: opts.default ?? false })
  } catch (err) { rethrowAbort(err) }
}
