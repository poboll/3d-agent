import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { WORKFLOW_JOBS_FILE } from './config.mjs'
import { sanitizeFileName } from './http-utils.mjs'
import { LOCAL_MODEL_DIR } from './config.mjs'
import { inspectGlbBuffer, isUsableColoredModel } from '../scripts/texture-stability-check.mjs'

const DEFAULT_LIMIT = 3

export async function getTextureArtifactStatus(options = {}) {
  const jobs = Array.isArray(options.jobs) ? options.jobs : await readStoredJobs(options.jobsFile || WORKFLOW_JOBS_FILE)
  const candidates = selectTextureArtifactJobs(jobs, {
    limit: options.limit || DEFAULT_LIMIT,
    jobId: options.jobId || '',
  })
  const artifacts = []
  for (const job of candidates) {
    try {
      artifacts.push(await inspectTextureArtifactJob(job))
    } catch (error) {
      artifacts.push({
        jobId: job.id,
        workflowMode: job.workflowMode,
        textureMode: job.textureMode,
        requestedTextureMode: job.requestedTextureMode || job.result?.requestedTextureMode,
        effectiveTextureMode: getEffectiveTextureMode(job),
        textureFallbackReason: job.textureFallbackReason || job.result?.textureFallbackReason,
        modelUrl: job.result?.modelUrl || '',
        ok: false,
        error: error.message || String(error),
      })
    }
  }

  const failed = artifacts.filter((artifact) => !artifact.ok)
  return {
    ok: artifacts.length > 0 && failed.length === 0,
    checked: artifacts.length,
    failed: failed.length,
    generatedAt: new Date().toISOString(),
    artifacts,
    summary: buildArtifactSummary(artifacts, failed),
  }
}

export function selectTextureArtifactJobs(jobs, options = {}) {
  if (!Array.isArray(jobs)) return []
  const requestedId = String(options.jobId || '').trim()
  const sorted = [...jobs]
    .filter((job) => job?.status === 'completed' && job.provider === 'selfhost-triposg' && job.result?.modelUrl)
    .sort((left, right) => getJobTime(right) - getJobTime(left))
  if (requestedId) return sorted.filter((job) => job.id === requestedId)

  const textureJobs = sorted.filter((job) => {
    const mode = job.workflowMode || ''
    const requested = job.requestedTextureMode || job.result?.requestedTextureMode || ''
    const effective = getEffectiveTextureMode(job)
    return mode === 'texture-enhance' || requested === 'hunyuan' || effective === 'hunyuan' || effective === 'fallback-color'
  })
  const source = textureJobs.length ? textureJobs : sorted
  return source.slice(0, positiveNumber(options.limit, DEFAULT_LIMIT))
}

async function inspectTextureArtifactJob(job) {
  const modelUrl = job.result?.modelUrl
  if (!modelUrl) throw new Error('任务缺少 modelUrl。')
  const model = await inspectLocalModelUrl(modelUrl)
  const effectiveTextureMode = getEffectiveTextureMode(job)
  const usableColoredModel = isUsableColoredModel(model, effectiveTextureMode)
  return {
    jobId: job.id,
    workflowMode: job.workflowMode,
    textureMode: job.textureMode,
    requestedTextureMode: job.requestedTextureMode || job.result?.requestedTextureMode,
    effectiveTextureMode,
    textureFallbackReason: job.textureFallbackReason || job.result?.textureFallbackReason,
    modelUrl,
    ok: usableColoredModel.ok,
    reason: usableColoredModel.reason,
    message: usableColoredModel.message,
    model,
  }
}

async function inspectLocalModelUrl(modelUrl) {
  const fileName = localModelFileName(modelUrl)
  const buffer = await readFile(path.join(LOCAL_MODEL_DIR, fileName))
  return {
    url: modelUrl,
    bytes: buffer.byteLength,
    ...inspectGlbBuffer(buffer),
  }
}

function localModelFileName(modelUrl) {
  const marker = '/api/3d/local-model/'
  const value = String(modelUrl || '')
  if (!value.includes(marker)) {
    throw new Error('只读贴图健康检查只支持本地缓存 GLB。')
  }
  return sanitizeFileName(decodeURIComponent(value.slice(value.lastIndexOf(marker) + marker.length)))
}

async function readStoredJobs(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.jobs) ? parsed.jobs : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function buildArtifactSummary(artifacts, failed) {
  if (!artifacts.length) return '还没有可检查的 selfhost 贴图产物。'
  if (!failed.length) {
    const native = artifacts.filter((item) => item.effectiveTextureMode === 'hunyuan').length
    const fallback = artifacts.filter((item) => item.effectiveTextureMode === 'fallback-color').length
    return `最近 ${artifacts.length} 个贴图产物通过 active material 检查：原生混元 ${native} 个，轻量 fallback ${fallback} 个。`
  }
  return `${failed.length}/${artifacts.length} 个贴图产物没有通过 active material 检查，请优先查看最新失败任务。`
}

function getEffectiveTextureMode(job) {
  return job?.result?.effectiveTextureMode || job?.effectiveTextureMode || job?.result?.textureMode || job?.textureMode || ''
}

function getJobTime(job) {
  const time = Date.parse(job.updatedAt || job.createdAt || '')
  return Number.isFinite(time) ? time : 0
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
