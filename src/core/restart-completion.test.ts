// Tests for the platform → adapter resolution that backs the
// post-restart completion message. Regression coverage for v1.0.13:
// initiator.platform="wechat" must find the "wechat-ilink" adapter
// instead of silently dropping the push.

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { registry } from './registry.js'
import { resolveMessenger } from './restart-completion.js'
import type { MessengerAdapter } from './types.js'

function fakeAdapter(name: string): MessengerAdapter {
  return {
    name,
    async start() {},
    async stop() {},
    onMessage() {},
    async sendMessage() {},
  }
}

const platformsTouched: string[] = []

function register(name: string): MessengerAdapter {
  const a = fakeAdapter(name)
  registry.registerMessenger(a)
  platformsTouched.push(name)
  return a
}

beforeEach(() => {
  platformsTouched.length = 0
})

afterEach(() => {
  // PluginRegistry has no unregister; reach in via the internal map.
  // Acceptable for tests since registry is the actual singleton we
  // need to keep clean between cases.
  const internal = (registry as unknown as { messengers: Map<string, unknown> }).messengers
  for (const name of platformsTouched) internal.delete(name)
})

test('resolveMessenger exact match wins', () => {
  const telegram = register('telegram')
  expect(resolveMessenger('telegram')).toBe(telegram)
})

test('resolveMessenger falls back from "wechat" to "wechat-ilink"', () => {
  const wechat = register('wechat-ilink')
  expect(resolveMessenger('wechat')).toBe(wechat)
})

test('resolveMessenger prefers exact name when both forms registered', () => {
  const shortForm = register('wechat')
  register('wechat-ilink')
  expect(resolveMessenger('wechat')).toBe(shortForm)
})

test('resolveMessenger returns undefined when nothing matches', () => {
  register('telegram')
  expect(resolveMessenger('wechat')).toBeUndefined()
})

test('resolveMessenger does not match unrelated prefixes', () => {
  // "discord" should not accidentally match "discord-bridge-rest" etc
  // through some looser rule. We only allow exact + "<platform>-..."
  register('discord-bridge')
  expect(resolveMessenger('disc')).toBeUndefined()
})
