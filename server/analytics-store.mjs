import { mkdir, writeFile } from 'node:fs/promises'
import { ANALYTICS_EVENTS_FILE, WORKFLOW_STORE_DIR } from './config.mjs'

export const ALLOWED_ANALYTICS_EVENTS = new Set([
  'workflow_prompt_focus',
  'workflow_reference_generate_start',
  'workflow_reference_generate',
  'workflow_reference_generate_failed',
  'workflow_reference_upload_start',
  'workflow_reference_upload',
  'workflow_reference_upload_failed',
  'workflow_reference_accept',
  'workflow_reference_reject',
  'workflow_model_confirm',
  'workflow_full_run_start',
  'workflow_full_reference_ready',
  'workflow_job_prompt_reuse',
  'workflow_job_manual_sync',
  'workflow_job_created',
  'workflow_job_completed',
  'workflow_job_failed',
  'local_model_upload_start',
  'local_model_upload_completed',
  'local_model_upload_failed',
  'specimen_select',
  'guide_open',
  'guide_step',
])

export async function appendAnalyticsEvents(input = {}) {
  const rawEvents = Array.isArray(input.events) ? input.events : [input]
  const events = rawEvents.map(normalizeAnalyticsEvent).filter(Boolean)
  if (!events.length) {
    throw Object.assign(new Error('没有可记录的埋点事件。'), { status: 400 })
  }

  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const lines = events.map((event) => `${JSON.stringify(event)}\n`).join('')
  await writeFile(ANALYTICS_EVENTS_FILE, lines, { flag: 'a' })
  return { ok: true, accepted: events.length }
}

function normalizeAnalyticsEvent(event) {
  const name = String(event?.name || '').trim()
  if (!isAnalyticsEventAllowed(name)) return null

  return {
    name,
    payload: sanitizePayload(event.payload),
    clientCreatedAt: String(event.createdAt || ''),
    receivedAt: new Date().toISOString(),
  }
}

export function isAnalyticsEventAllowed(name) {
  return ALLOWED_ANALYTICS_EVENTS.has(String(name || '').trim())
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return {}
  return Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => /^[\w.-]{1,48}$/.test(key))
      .map(([key, value]) => [key, sanitizeValue(value)])
  )
}

function sanitizeValue(value) {
  if (value == null) return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 300)
  if (Array.isArray(value)) return value.slice(0, 12).map(sanitizeValue)
  if (typeof value === 'object') return sanitizePayload(value)
  return String(value).slice(0, 120)
}
