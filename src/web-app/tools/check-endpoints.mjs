#!/usr/bin/env node
/**
 * Verify that every client.* call in the hand-curated SPA API facade maps to
 * a direct backend route in tools/endpoints.json. This script never writes.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const toolDir = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(toolDir, 'endpoints.json')
const apiPath = resolve(toolDir, '../src/lib/api/endpoints.ts')
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete'])

function normalizePath(path) {
  return path.replace(/:[^/]+/g, ':param')
}

function routeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`
}

function readCallPath(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  let path = node.head.text
  for (const span of node.templateSpans) {
    path += `:param${span.literal.text}`
  }
  return path
}

function collectClientRoutes(sourceText) {
  const sourceFile = ts.createSourceFile(apiPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const routes = []
  const unsupported = []

  function visit(node) {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'client'
      && verbs.has(node.expression.name.text)
    ) {
      const pathNode = node.arguments[0]
      const path = pathNode ? readCallPath(pathNode) : null
      if (!path) {
        const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        unsupported.push(`${apiPath}:${pos.line + 1}`)
      } else {
        routes.push({ method: node.expression.name.text.toUpperCase(), path })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { routes, unsupported }
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const serverRoutes = new Set(manifest.endpoints.map((endpoint) => routeKey(endpoint.method, endpoint.path)))
const { routes: clientRoutes, unsupported } = collectClientRoutes(readFileSync(apiPath, 'utf8'))
const clientKeys = clientRoutes.map((route) => routeKey(route.method, route.path))
const duplicateKeys = [...new Set(clientKeys.filter((key, index) => clientKeys.indexOf(key) !== index))]
const missingKeys = [...new Set(clientKeys.filter((key) => !serverRoutes.has(key)))]

if (unsupported.length > 0 || duplicateKeys.length > 0 || missingKeys.length > 0) {
  console.error('✗ SPA API endpoint contract check failed.')
  for (const location of unsupported) console.error(`  Unsupported dynamic path at ${location}`)
  for (const key of duplicateKeys) console.error(`  Duplicate SPA wrapper: ${key}`)
  for (const key of missingKeys) console.error(`  No direct server route: ${key}`)
  process.exitCode = 1
} else {
  const covered = new Set(clientKeys).size
  console.log(`✓ ${covered} SPA API wrappers map to ${serverRoutes.size} direct REST routes`)
}
