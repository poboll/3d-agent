import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_IMAGE_PROVIDER,
  WORKFLOW_EVENT_COMPACT_INTERVAL,
  WORKFLOW_EVENT_RETENTION_LIMIT,
  WORKFLOW_EVENTS_FILE,
  WORKFLOW_JOB_RETENTION_LIMIT,
  WORKFLOW_JOBS_FILE,
  WORKFLOW_STORE_DIR,
} from './config.mjs'
import {
  buildJobId,
  chooseTemplateForPrompt,
  estimateGenerationCost,
  isRecoverableWorkflowJob,
  isResumableSelfhostWorkflowJob,
  normalizeImageProfile,
  normalizePrompt,
  normalizeProvider,
  normalizeTextureMode,
  normalizeWorkflowImageProvider,
  publicJob,
} from './workflow-utils.mjs'
import { getReferenceImageStatus, normalizeImageGenerationOptions, normalizeImagePromptOverride } from './reference-store.mjs'

export async function createWorkflowJob(input = {}) {
  const prompt = normalizePrompt(input.prompt)
  const provider = normalizeProvider(input.provider)
  const imageProvider = normalizeWorkflowImageProvider(input.imageProvider || DEFAULT_IMAGE_PROVIDER)
  const template = chooseTemplateForPrompt(prompt, input.template)
  const imageOptions = normalizeImageGenerationOptions({
    imageProfile: normalizeImageProfile(input.imageProfile),
    imageSize: input.imageSize,
    imageQuality: input.imageQuality,
  }, imageProvider === 'openai' ? 'openai' : 'local-gateway')
  const imageProfile = imageOptions.profile
  const imageSize = imageOptions.size
  const imageQuality = imageOptions.quality
  const imagePromptOverride = normalizeImagePromptOverride(input.imagePromptOverride)
  const forceImageRetry = Boolean(input.forceImageRetry)
  const textureMode = normalizeTextureMode(input.textureMode)
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
    imagePromptOverride: imagePromptOverride || undefined,
    forceImageRetry,
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
    textureMode,
    costEstimateCny: estimateGenerationCost(provider),
    createdAt: now,
    updatedAt: now,
  }

  await upsertJob(job)
  await appendJobEvent(job.id, 'created', {
    provider: job.provider,
    imageProvider: job.imageProvider,
    template: job.template,
    promptConfirmed: Boolean(job.imagePromptOverride),
    forceImageRetry,
    referenceId: job.referenceId,
    workflowMode: job.workflowMode,
    deferReference,
    imageProfile,
    imageSize,
    imageQuality,
    textureMode,
    costEstimateCny: job.costEstimateCny,
  })
  return publicJob(job)
}

export async function createTextureEnhancementJob(sourceJob = {}, input = {}) {
  if (!sourceJob?.id) {
    throw Object.assign(new Error('缺少可增强的来源任务。'), { status: 400 })
  }
  if (sourceJob.provider !== 'selfhost-triposg') {
    throw Object.assign(new Error('只有自部署 TripoSG 任务支持混元贴图后处理。'), { status: 409 })
  }
  if (sourceJob.status !== 'completed' || !sourceJob.result?.modelUrl) {
    throw Object.assign(new Error('请先完成稳定图生 3D，拿到 raw/final GLB 后再做混元贴图增强。'), { status: 409 })
  }

  const referenceId = String(sourceJob.referenceId || sourceJob.reference?.id || '').trim()
  if (!referenceId) {
    throw Object.assign(new Error('来源任务缺少参考图，无法复用图片进行混元贴图。'), { status: 409 })
  }

  const reference = sourceJob.reference || await getReferenceImageStatus(referenceId)
  const textureMode = normalizeTextureMode(input.textureMode || (input.forceFallback ? 'fallback-color' : 'hunyuan'))
  const fallbackOnly = textureMode === 'fallback-color'
  const now = new Date().toISOString()
  const job = {
    id: buildJobId(),
    prompt: normalizePrompt(sourceJob.prompt || sourceJob.result?.name || '生物结构 3D 教学模型'),
    provider: 'selfhost-triposg',
    imageProvider: sourceJob.imageProvider || DEFAULT_IMAGE_PROVIDER,
    template: sourceJob.template || sourceJob.result?.template || chooseTemplateForPrompt(sourceJob.prompt || ''),
    imagePromptOverride: sourceJob.imagePromptOverride,
    referenceId: reference.id,
    referenceImageUrl: reference.imageUrl || sourceJob.referenceImageUrl || sourceJob.result?.referenceImageUrl,
    reference,
    status: 'queued',
    stage: fallbackOnly
      ? '原参考图轻量贴图任务已创建，将复用当前 raw GLB，不提交远端混元重任务。'
      : '混元贴图增强任务已创建，将复用当前 raw GLB，不重新执行 TripoSG。',
    progress: 12,
    workflowMode: 'texture-enhance',
    sourceJobId: sourceJob.id,
    sourceProviderJobId: sourceJob.providerJobId || sourceJob.recoveredProviderJobId,
    rawMeshServerPath: sourceJob.rawMeshServerPath,
    rawModelUrl: sourceJob.rawModelUrl || sourceJob.result?.rawModelUrl || sourceJob.result?.modelUrl,
    sourceModelUrl: sourceJob.sourceModelUrl || sourceJob.result?.sourceModelUrl || sourceJob.result?.fallbackModelUrl || sourceJob.result?.modelUrl,
    imageProfile: sourceJob.imageProfile,
    imageSize: sourceJob.imageSize,
    imageQuality: sourceJob.imageQuality,
    textureMode,
    requestedTextureMode: textureMode,
    effectiveTextureMode: textureMode,
    forceTextureFallback: fallbackOnly || undefined,
    costEstimateCny: estimateGenerationCost('selfhost-triposg'),
    createdAt: now,
    updatedAt: now,
  }

  await upsertJob(job)
  await appendJobEvent(job.id, 'texture-enhance-created', {
    provider: job.provider,
    template: job.template,
    referenceId: job.referenceId,
    workflowMode: job.workflowMode,
    sourceJobId: job.sourceJobId,
    sourceProviderJobId: job.sourceProviderJobId,
    rawModelUrl: job.rawModelUrl,
    textureMode: job.textureMode,
    forceTextureFallback: Boolean(job.forceTextureFallback),
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
  await writeFile(tmpPath, JSON.stringify({ jobs: compactWorkflowJobs(jobs) }, null, 2))
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
  void compactWorkflowEventsIfNeeded().catch((error) => {
    console.warn(`Workflow event compaction skipped: ${error.message || error}`)
  })
}

export function compactWorkflowJobs(jobs, limit = WORKFLOW_JOB_RETENTION_LIMIT) {
  if (!Number.isFinite(limit) || limit <= 0 || jobs.length <= limit) return jobs
  const live = []
  const completed = []
  for (const job of jobs) {
    if (
      job.status === 'queued' ||
      job.status === 'processing' ||
      isRecoverableWorkflowJob(job) ||
      isResumableSelfhostWorkflowJob(job, { maxAgeMs: Number.POSITIVE_INFINITY })
    ) live.push(job)
    else completed.push(job)
  }
  const sortNewest = (a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
  const liveSorted = live.sort(sortNewest)
  const completedSorted = completed.sort(sortNewest)
  const keep = [...liveSorted, ...completedSorted].slice(0, limit)
  const keepIds = new Set(keep.map((job) => job.id))
  return jobs.filter((job) => keepIds.has(job.id))
}

async function compactWorkflowEventsIfNeeded() {
  if (!Number.isFinite(WORKFLOW_EVENT_RETENTION_LIMIT) || WORKFLOW_EVENT_RETENTION_LIMIT <= 0) return
  if (!Number.isFinite(WORKFLOW_EVENT_COMPACT_INTERVAL) || WORKFLOW_EVENT_COMPACT_INTERVAL <= 0) return

  let raw
  try {
    raw = await readFile(WORKFLOW_EVENTS_FILE, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }

  const lines = raw.split(/\r?\n/).filter(Boolean)
  if (lines.length <= WORKFLOW_EVENT_RETENTION_LIMIT) return
  if (lines.length % WORKFLOW_EVENT_COMPACT_INTERVAL !== 0) return

  const kept = lines.slice(-WORKFLOW_EVENT_RETENTION_LIMIT)
  const tmpPath = path.join(WORKFLOW_STORE_DIR, `job-events-${Date.now()}.tmp`)
  await writeFile(tmpPath, `${kept.join('\n')}\n`)
  await rename(tmpPath, WORKFLOW_EVENTS_FILE)
}

export const WORKFLOW_STORE_RETENTION = Object.freeze({
  jobLimit: WORKFLOW_JOB_RETENTION_LIMIT,
  eventLimit: WORKFLOW_EVENT_RETENTION_LIMIT,
  eventCompactInterval: WORKFLOW_EVENT_COMPACT_INTERVAL,
})
