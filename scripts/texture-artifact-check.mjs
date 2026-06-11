import '../server/env-loader.mjs'
import { getTextureArtifactStatus, selectTextureArtifactJobs } from '../server/texture-artifacts.mjs'

const API_BASE = (process.env.TEXTURE_ARTIFACT_API_BASE || process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`).replace(/\/+$/, '')
const JOBS_FILE = process.env.TEXTURE_ARTIFACT_JOBS_FILE || '.workflow-store/jobs.json'
const DEFAULT_LIMIT = Number(process.env.TEXTURE_ARTIFACT_LIMIT || 3)

const args = parseArgs(process.argv.slice(2))

async function main() {
  const options = {
    apiBase: args.api || API_BASE,
    jobsFile: args.jobs || JOBS_FILE,
    limit: positiveNumber(args.limit, DEFAULT_LIMIT),
    jobId: args.job || process.env.TEXTURE_ARTIFACT_JOB || '',
  }
  const report = await getTextureArtifactStatus({
    jobsFile: options.jobsFile,
    limit: options.limit,
    jobId: options.jobId,
  })
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

function parseArgs(argv) {
  const parsed = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, ...rest] = arg.slice(2).split('=')
    parsed[key] = rest.length ? rest.join('=') : true
  }
  return parsed
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export { selectTextureArtifactJobs }

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exitCode = process.exitCode || 1
  })
}
