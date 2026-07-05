export function agentDisplayName(name: string): string {
  if (name === 'native') return 'agim'
  if (name === 'kimi-code') return 'Kimi Code'
  if (name === 'qoder') return 'Qoder'
  if (name === 'pi') return 'PI'
  if (name === 'mimo') return 'MiMo Code'
  if (name === 'copilot') return 'GitHub Copilot'
  if (name === 'antigravity') return 'Antigravity'
  return name
}
