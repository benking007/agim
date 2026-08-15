// cli-ui/token-menu.ts — interactive menu the entry-menu dispatches to
// when the user picks "Manage web access tokens".
//
// Wraps src/core/access-token.ts CRUD with a small terminal UI that
// matches the rest of the agim wizard look (menu / input / confirm).

import { menu, inputText, yesNo, BACK, UserAbortError } from './prompts.js'
import { t, type Lang } from './i18n.js'
import {
  createToken,
  listTokens,
  revokeToken,
  getTokensFilePath,
} from '../core/access-token.js'

function fmtDate(unix: number | null): string {
  if (!unix) return '(never)'
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

export async function runTokenMenu(lang: Lang): Promise<void> {
  while (true) {
    console.log('')
    console.log(t(lang, 'token.title'))
    console.log(t(lang, 'token.subtitle'))
    console.log(`  ${getTokensFilePath()}`)
    console.log('')
    let pick: 'create' | 'list' | 'revoke' | 'back' | typeof BACK
    try {
      pick = await menu<'create' | 'list' | 'revoke' | 'back'>({
        lang,
        message: t(lang, 'token.cli.prompt'),
        choices: [
          { value: 'create', name: t(lang, 'token.choice.create') },
          { value: 'list',   name: t(lang, 'token.choice.list') },
          { value: 'revoke', name: t(lang, 'token.choice.revoke') },
          { value: 'back',   name: t(lang, 'token.choice.back'), separatorBefore: true },
        ],
      })
    } catch (err) {
      if (err instanceof UserAbortError) return
      throw err
    }
    if (pick === 'back' || pick === BACK) return
    if (pick === 'create') await handleCreate(lang)
    else if (pick === 'list') await handleList(lang)
    else if (pick === 'revoke') await handleRevoke(lang)
  }
}

async function handleCreate(lang: Lang): Promise<void> {
  let label = ''
  try {
    label = await inputText({ message: t(lang, 'token.create.label_prompt') })
  } catch (err) {
    if (err instanceof UserAbortError) return
    throw err
  }
  const r = createToken(label.trim())
  console.log('')
  console.log(t(lang, 'token.create.printed'))
  console.log('')
  console.log(`   id    : ${r.id}`)
  console.log(`   label : ${label.trim() || '(unlabeled)'}`)
  console.log(`   token : ${r.raw}`)
  console.log('')
}

async function handleList(lang: Lang): Promise<void> {
  const rows = listTokens()
  console.log('')
  if (rows.length === 0) {
    console.log(t(lang, 'token.list.empty'))
    return
  }
  for (const r of rows) {
    console.log(`  ${r.id}  label=${r.label || '(unlabeled)'}  created=${fmtDate(r.created_at)}  last_used=${fmtDate(r.last_used_at)}`)
  }
}

async function handleRevoke(lang: Lang): Promise<void> {
  const rows = listTokens()
  if (rows.length === 0) {
    console.log(t(lang, 'token.list.empty'))
    return
  }
  let pickId: string | typeof BACK
  try {
    pickId = await menu<string>({
      lang,
      message: t(lang, 'token.revoke.prompt'),
      choices: rows.map((r) => ({
        value: r.id,
        name: `${r.id}  ${r.label || '(unlabeled)'}  (created ${fmtDate(r.created_at)})`,
      })),
    })
  } catch (err) {
    if (err instanceof UserAbortError) return
    throw err
  }
  if (pickId === BACK) return
  const row = rows.find((r) => r.id === pickId)
  if (!row) return
  let ok = false
  try {
    ok = await yesNo({
      message: t(lang, 'token.revoke.confirm')
        .replace('{label}', row.label || '(unlabeled)')
        .replace('{id}', row.id),
      default: false,
    })
  } catch (err) {
    if (err instanceof UserAbortError) return
    throw err
  }
  if (!ok) return
  if (revokeToken(row.id)) console.log(t(lang, 'token.revoke.success'))
  else console.log(t(lang, 'token.revoke.not_found'))
}
