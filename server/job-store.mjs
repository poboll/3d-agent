import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WORKFLOW_EVENTS_FILE, WORKFLOW_JOBS_FILE, WORKFLOW_STORE_DIR } from './config.mjs'
import {
  buildJobId,
  chooseTemplateForPrompt,
  estimateGenerationCost,
  isRecoverableWorkflowJob,
  normalizeImageProfile,
  normalizePrompt,
  normalizeProvider,
  normalizeWorkflowImageProvider,
  publicJob,
} from './workflow-utils.mjs'
import { getReferenceImageStatus, normalizeImageGenerationOptions } from './reference-store.mjs'

export async function createWorkflowJob(input = {}) {
  const prompt = normalizePrompt(input.prompt)
  const provider = normalizeProvider(input.provider)
  const imageProvider = normalizeWorkflowImageProvider(input.imageProvider || 'openai')
  const template = chooseTemplateForPrompt(prompt, input.template)
  const imageOptions = normalizeImageGenerationOptions({
    imageProfile: normalizeImageProfile(input.imageProfile),
    imageSize: input.imageSize,
    imageQuality: input.imageQuality,
  }, imageProvider === 'openai' ? 'openai' : 'local-gateway')
  const imageProfile = imageOptions.profile
  const imageSize = imageOptions.size
  const imageQuality = imageOptions.quality
  const referenceId = String(input.referenceId || '').trim()
  const deferReference = Boolean(input.deferReference)
  const reference = referenceId ? await getReferenceImageStatus(referenceId) : null
  const publicReferenceUrl = reference?.imageUrl
  if ((provider === 'selfhost-triposg' || provider === 'tencent-hunyuan') && !reference && !deferReference) {
    throw Object.assign(new Error('请先生成或上传参考图，再提交图生 3D 建模。'), { status: 400 })
  }
  const now = new Date().toISOString()
  const job = {
    id: buildJobId(),
    prompt,
    provider,
    imageProvider,
    template,
    referenceId: reference?.id,
    referenceImageUrl: publicReferenceUrl,
    reference,
    status: 'queued',
    stage: deferReference ? '完整生成任务已创建，正在等待参考图生成。' : '任务已创建，等待工作流处理。',
    progress: deferReference ? 3 : 5,
    workflowMode: input.workflowMode || (deferReference ? 'full-text-to-3d' : 'image-to-3d'),
    imageProfile,
    imageSize,
    imageQuality,
    costEstimateCny: estimateGenerationCost(provider),
    createdAt: now,
    updatedAt: now,
  }

  await upsertJob(job)
  await appendJobEvent(job.id, 'created', {
    provider: job.provider,
    imageProvider: job.imageProvider,
    template: job.template,
    referenceId: job.referenceId,
    workflowMode: job.workflowMode,
    deferReference,
    imageProfile,
    imageSize,
    imageQuality,
    costEstimateCny: job.costEstimateCny,
  })
  return publicJob(job)
}

export async function updateWorkflowJob(jobId, patch = {}, eventName = 'updated') {
  const jobs = await readJobs()
  const index = jobs.findIndex((job) => job.id === jobId)
  if (index === -1) {
    throw Object.assign(new Error('生成任务不存在。'), { status: 404 })
  }

  const updated = {
    ...jobs[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  }

  jobs[index] = updated
  await writeJobs(jobs)
  await appendJobEvent(jobId, eventName, patch)
  return publicJob(updated)
}

export async function getWorkflowJob(jobId) {
  const jobs = await readJobs()
  const job = jobs.find((item) => item.id === jobId)
  if (!job) {
    throw Object.assign(new Error('生成任务不存在。'), { status: 404 })
  }
  return publicJob(job)
}

export async function listWorkflowJobs(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 60)
  const jobs = await readJobs()
  return jobs
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, safeLimit)
    .map(publicJob)
}

export async function listRecoverableWorkflowJobs(options = {}) {
  const jobs = await readJobs()
  return jobs
    .filter((job) => isRecoverableWorkflowJob(job, options))
    .sort((a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime())
    .map(publicJob)
}

async function upsertJob(job) {
  const jobs = await readJobs()
  const index = jobs.findIndex((item) => item.id === job.id)
  if (index >= 0) jobs[index] = job
  else jobs.push(job)
  await writeJobs(jobs)
}

async function readJobs() {
  try {
    const raw = await readFile(WORKFLOW_JOBS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.jobs) ? parsed.jobs : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeJobs(jobs) {
  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const tmpPath = path.join(WORKFLOW_STORE_DIR, `jobs-${Date.now()}.tmp`)
  await writeFile(tmpPath, JSON.stringify({ jobs }, null, 2))
  await rename(tmpPath, WORKFLOW_JOBS_FILE)
}

async function appendJobEvent(jobId, eventName, payload = {}) {
  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const line = `${JSON.stringify({
    jobId,
    eventName,
    payload,
    createdAt: new Date().toISOString(),
  })}\n`

  await writeFile(WORKFLOW_EVENTS_FILE, line, { flag: 'a' })
}
