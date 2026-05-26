import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ENV_FILES = ['.env.local', '.env']

for (const fileName of ENV_FILES) {
  const filePath = path.resolve(fileName)
  if (!existsSync(filePath)) continue
  loadEnvFile(filePath)
}

function loadEnvFile(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    const { key, value } = parsed
    if (process.env[key] == null) {
      process.env[key] = value
    }
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (!match) return null

  return {
    key: match[1],
    value: stripEnvQuotes(match[2]),
  }
}

function stripEnvQuotes(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}
