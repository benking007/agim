import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * `cn` — canonical tailwind class composer. Accepts the usual `clsx`
 * input shapes (strings / arrays / objects / falsy values) and then
 * runs the result through `tailwind-merge` so conflicting Tailwind
 * utilities (e.g. `px-2 px-4`) resolve to a single value.
 *
 * Every shadcn component expects this exact helper at `@/lib/utils`.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
