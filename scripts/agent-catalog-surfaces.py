from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


# CLI config wizard ---------------------------------------------------------
path = Path('src/cli-ui/config-wizard.ts')
text = path.read_text()
text = replace_once(
    text,
    "import { listAdmins, listKnownImUsers, promoteAdmin, revokeAdmin } from '../core/admin-allowlist.js'\n",
    "import { listAdmins, listKnownImUsers, promoteAdmin, revokeAdmin } from '../core/admin-allowlist.js'\n"
    "import { BUILT_IN_AGENT_CATALOG, getAgentInstallCommand } from '../core/agent-catalog.js'\n",
    'config wizard catalog import',
)

start = text.index('const CONFIG_COMPONENT_SECTIONS: Record<string, ConfigSection> = {')
end = text.index('\n\nexport function sectionForConfigComponent', start)
text = text[:start] + """const CONFIG_COMPONENT_SECTIONS: Record<string, ConfigSection> = {
  messengers: 'messengers',
  messenger: 'messengers',
  im: 'messengers',
  wechat: 'messengers',
  'wechat-ilink': 'messengers',
  feishu: 'messengers',
  lark: 'messengers',
  dingtalk: 'messengers',
  telegram: 'messengers',
  discord: 'messengers',
  email: 'messengers',

  agents: 'agents',
  agentcli: 'agents',

  admins: 'admins',
  admin: 'admins',

  acp: 'acp',
  agent: 'acp',
  remote: 'acp',
  'remote-agent': 'acp',

  web: 'web',
  smtp: 'smtp',
  baidu: 'baidu',
}

for (const entry of BUILT_IN_AGENT_CATALOG) {
  for (const name of [entry.id, ...entry.aliases, ...(entry.configAliases ?? [])]) {
    CONFIG_COMPONENT_SECTIONS[name] = entry.configSection
  }
}
""" + text[end:]

start = text.index("type AgentId = 'native'")
end = text.index('\n\nasync function nativeLlmConfigured', start)
text = text[:start] + """type AgentId = string

interface AgentSpec {
  id: AgentId
  /** CLI binary to probe; `__native__` delegates to the LLM config probe. */
  cmd: string
  /** Some CLIs do not expose --version; override with a cheap success path. */
  probeArgs?: string[]
  /** Localized auth guidance stays in CLI i18n, while presence is catalog-driven. */
  authHintKey?: Key
  /** Canonical install command/guidance from the catalog. */
  installHint: string
}

const AGENT_SPECS: AgentSpec[] = BUILT_IN_AGENT_CATALOG.map((entry) => ({
  id: entry.id,
  cmd: entry.kind === 'in-process' ? '__native__' : entry.install.command,
  probeArgs: entry.install.probeArgs ? [...entry.install.probeArgs] : undefined,
  authHintKey: entry.install.requiresAuthHint
    ? (`agents.auth_hint.${entry.id}` as Key)
    : undefined,
  installHint: getAgentInstallCommand(entry.id)
    ?? `Install the ${entry.displayName} adapter and ensure its CLI is on PATH.`,
}))
""" + text[end:]

text = replace_once(
    text,
    "      console.log(t(lang, ('agents.install_hint.' + spec.id) as Key))",
    "      console.log(spec.installHint)",
    'catalog install hint',
)
path.write_text(text)


# Backend Web route ---------------------------------------------------------
path = Path('src/web/server.ts')
text = path.read_text()
text = replace_once(
    text,
    "import { handleAgimSkillsApi } from './agim-skills-api.js'\n",
    "import { handleAgimSkillsApi } from './agim-skills-api.js'\n"
    "import { handleAgentCatalog } from './agent-catalog-api.js'\n",
    'server catalog handler import',
)
text = replace_once(
    text,
    "    if (url.pathname === '/api/agents/status' && req.method === 'GET') {\n"
    "      return handleAgentsStatus(req, res)\n"
    "    }\n",
    "    if (url.pathname === '/api/agents/status' && req.method === 'GET') {\n"
    "      return handleAgentsStatus(req, res)\n"
    "    }\n"
    "    if (url.pathname === '/api/agents/catalog' && req.method === 'GET') {\n"
    "      return handleAgentCatalog(res)\n"
    "    }\n",
    'server catalog route',
)
path.write_text(text)


# Web agent settings --------------------------------------------------------
path = Path('src/web-app/src/routes/settings/agents.tsx')
text = path.read_text()
text = replace_once(
    text,
    "import { useAgentsStatus } from '@/hooks/use-workspace'",
    "import { useAgentCatalog, useAgentsStatus } from '@/hooks/use-workspace'",
    'settings catalog hook import',
)
text = text.replace("import { agentDisplayName } from '@/lib/agent-label'\n", '')
text = replace_once(
    text,
    "import type { ACPAgentConfig, ACPAuthConfig, ACPAuthType } from '@/types/api'\n",
    "import type { ACPAgentConfig, ACPAuthConfig, ACPAuthType } from '@/types/api'\n"
    "import type { BuiltInAgentSurface } from '@/types/agent-catalog'\n",
    'settings surface type import',
)

start = text.index('/** Mirror of v1 settings.html:BUILTIN_AGENTS.')
end = text.index('\n\nexport default function SettingsAgentsRoute', start)
text = text[:start] + """function installLabel(info: BuiltInAgentSurface): string {
  if (info.kind === 'in-process') return 'in-process'
  return info.install.npmPackage
    ?? info.install.installCommand
    ?? info.install.command
    ?? info.id
}
""" + text[end:]

text = replace_once(
    text,
    "  const statusQuery = useAgentsStatus()\n  const updateCfg = useUpdateConfig()",
    "  const statusQuery = useAgentsStatus()\n  const catalogQuery = useAgentCatalog()\n  const updateCfg = useUpdateConfig()",
    'settings catalog query',
)
text = replace_once(
    text,
    "  const status = statusQuery.data ?? {}\n",
    "  const status = statusQuery.data ?? {}\n"
    "  const catalog = catalogQuery.data?.agents ?? []\n"
    "  const agentNames = catalog.map((entry) => entry.id)\n"
    "  const bridgedAgents = catalog.filter((entry) => entry.scope === 'bridged')\n",
    'settings catalog derived lists',
)

start = text.index('  /** Eligible defaults = installed + enabled.')
end = text.index('\n\n  function toggleAgent', start)
text = text[:start] + """  /** Eligible defaults = installed + enabled. In-process backends are
   * always runtime-enabled and therefore do not require a toggle. */
  const eligibleDefaults = useMemo(
    () => agentNames.filter((name) => {
      const info = catalog.find((entry) => entry.id === name)
      if (!info) return false
      const enabledOrInProcess = info.kind === 'in-process' || enabled.includes(name)
      return enabledOrInProcess && status[name]
    }),
    [agentNames, catalog, enabled, status],
  )
""" + text[end:]

text = replace_once(
    text,
    "              void statusQuery.refetch()\n",
    "              void statusQuery.refetch()\n              void catalogQuery.refetch()\n",
    'settings refresh catalog',
)
text = replace_once(
    text,
    "disabled={cfgQuery.isFetching || statusQuery.isFetching}",
    "disabled={cfgQuery.isFetching || statusQuery.isFetching || catalogQuery.isFetching}",
    'settings refresh disabled',
)
text = replace_once(
    text,
    "{(cfgQuery.isFetching || statusQuery.isFetching)",
    "{(cfgQuery.isFetching || statusQuery.isFetching || catalogQuery.isFetching)",
    'settings refresh spinner',
)
text = replace_once(
    text,
    "      {cfgQuery.isLoading ? (",
    "      {(cfgQuery.isLoading || catalogQuery.isLoading) ? (",
    'settings loading catalog',
)
text = replace_once(
    text,
    "            {BRIDGED_AGENT_NAMES.map((name) => {\n"
    "              const info = BUILTIN_AGENTS[name]!\n",
    "            {bridgedAgents.map((info) => {\n"
    "              const name = info.id\n",
    'settings catalog rows',
)
text = replace_once(
    text,
    "                  displayName={agentDisplayName(name)}\n"
    "                  aliases={info.aliases}\n"
    "                  pkg={info.pkg}\n",
    "                  displayName={info.displayName}\n"
    "                  aliases={info.aliases}\n"
    "                  pkg={installLabel(info)}\n",
    'settings catalog row props',
)
path.write_text(text)


# Web test fixture ----------------------------------------------------------
path = Path('src/web-app/src/routes/settings/agents.test.tsx')
text = path.read_text()
insert_after = """const STATUS = {
  'claude-code': true,
  'codex': false, // installed but circuit-open
  'copilot': true,
  'opencode': true,
  'antigravity': false,
  'cursor': true,
  'kimi-code': true,
  'qoder': true,
  'pi': true,
  'mimo': true,
}
"""
catalog_fixture = """
const CATALOG = {
  agents: [
    ['claude-code', 'Claude Code', ['cc', 'claude'], '@anthropic-ai/claude-code'],
    ['codex', 'Codex', ['cx'], '@openai/codex'],
    ['copilot', 'GitHub Copilot', ['co', 'gh-copilot', 'github-copilot'], '@github/copilot'],
    ['opencode', 'OpenCode', ['oc'], 'opencode-ai'],
    ['antigravity', 'Antigravity', ['agy', 'gemini', 'ag'], 'agy'],
    ['kimi-code', 'Kimi Code', ['kimi', 'km'], '@moonshot-ai/kimi-code'],
    ['qoder', 'Qoder', ['qd', 'qodercli'], 'qodercli'],
    ['pi', 'PI', ['pi-agent'], '@earendil-works/pi-coding-agent'],
    ['mimo', 'MiMo Code', ['mo', 'mimo-code'], '@mimo-ai/cli'],
    ['cursor', 'Cursor', ['cs', 'cur'], 'cursor-agent'],
  ].map(([id, displayName, aliases, npmPackage]) => ({
    id,
    displayName,
    aliases,
    configAliases: [],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 10,
    install: {
      command: String(id),
      probeArgs: ['--version'],
      npmPackage,
      requiresAuthHint: false,
    },
  })),
}
"""
text = replace_once(text, insert_after, insert_after + catalog_fixture, 'settings test catalog fixture')
text = replace_once(
    text,
    "    if (u === '/api/agents/status') return jsonResponse(STATUS)\n",
    "    if (u === '/api/agents/status') return jsonResponse(STATUS)\n"
    "    if (u === '/api/agents/catalog') return jsonResponse(CATALOG)\n",
    'settings test catalog fetch',
)
text = text.replace(
    "// Order = AGENT_NAMES = ['claude-code','codex','copilot','opencode','antigravity','cursor','kimi-code','qoder','pi','mimo','native']",
    "// Catalog order starts claude-code, codex, copilot, opencode.",
)
path.write_text(text)

print('agent catalog surfaces codemod applied')
