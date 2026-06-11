import { readFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BIO3D_COLOR_FALLBACK_ENABLED,
  COMFYUI_BASE_URL,
  COMFYUI_FACES,
  COMFYUI_FREE_AFTER_JOB,
  COMFYUI_FREE_TIMEOUT_MS,
  COMFYUI_GUIDANCE_SCALE,
  COMFYUI_HISTORY_CACHE_LIMIT,
  COMFYUI_HY3DPAINT_ENABLED,
  COMFYUI_HY3DPAINT_FACES,
  COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES,
  COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
  COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE,
  COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS,
  COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT,
  COMFYUI_HY3DPAINT_GUIDANCE_SCALE,
  COMFYUI_HY3DPAINT_AUTO_FALLBACK,
  COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE,
  COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB,
  COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
  COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
  COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED,
  COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE,
  COMFYUI_HY3DPAINT_POLL_INTERVAL_MS,
  COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB,
  COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS,
  COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT,
  COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS,
  COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB,
  COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB,
  COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
  COMFYUI_HY3DPAINT_STEPS,
  COMFYUI_HY3DPAINT_STABLE_STEPS,
  COMFYUI_HY3DPAINT_STABLE_FACES,
  COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE,
  COMFYUI_HY3DPAINT_TIMEOUT_MS,
  COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
  COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE,
  COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
  COMFYUI_LOCAL_QUEUE_MAX_PENDING,
  COMFYUI_MIN_RAM_FREE_GB,
  COMFYUI_MIN_VRAM_FREE_GB,
  COMFYUI_OUTPUT_PREFIX,
  COMFYUI_POLL_INTERVAL_MS,
  COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD,
  COMFYUI_RESOURCE_GUARD,
  COMFYUI_STEPS,
  COMFYUI_TIMEOUT_MS,
  COMFYUI_WORKFLOW_TEMPLATE,
  LOCAL_MODEL_DIR,
  WORKFLOW_STORE_DIR,
} from './config.mjs'
import { getReferenceImage } from './reference-store.mjs'
import { sanitizeFileName } from './http-utils.mjs'
import { sanitizeModelId, validateModelBuffer } from './model-store.mjs'
import { getTemplateDisplayName } from './workflow-utils.mjs'
import { colorizeGlbFile } from './glb-colorizer.mjs'

const COMFYUI_HISTORY_RETRY_LIMIT = 8
const COMFYUI_DOWNLOAD_RETRY_LIMIT = 3
const COMFYUI_STALE_HISTORY_LIMIT = Number(process.env.COMFYUI_STALE_HISTORY_LIMIT || 8)
const COMFYUI_READY_RETRY_LIMIT = Number(process.env.COMFYUI_READY_RETRY_LIMIT || 10)
const COMFYUI_READY_RETRY_BASE_MS = Number(process.env.COMFYUI_READY_RETRY_BASE_MS || 2500)
const COMFYUI_HISTORY_RECOVERY_LIMIT = Number(process.env.COMFYUI_HISTORY_RECOVERY_LIMIT || 36)
const COMFYUI_EMPTY_OUTPUT_RETRY_LIMIT = Number(process.env.COMFYUI_EMPTY_OUTPUT_RETRY_LIMIT || 6)
const COMFYUI_HISTORY_POLL_TIMEOUT_MS = Number(process.env.COMFYUI_HISTORY_POLL_TIMEOUT_MS || 20000)
const COMFYUI_QUEUE_POLL_TIMEOUT_MS = Number(process.env.COMFYUI_QUEUE_POLL_TIMEOUT_MS || 8000)
const COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT = Number(process.env.COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT || 3)
const textureRuntimeBackoffState = new Map()

function getComfyJobProfile(job = {}) {
  const textureMode = job.textureMode === 'hunyuan' ? 'hunyuan' : 'stable'
  const textured = textureMode === 'hunyuan'
  const existingMeshTexture = textured && job.workflowMode === 'texture-enhance'
  const fullTextureWorkflow = textured && job.workflowMode === 'full-hunyuan-texture'
  const stableSourceForTexture = !textured && job.requestedTextureMode === 'hunyuan'
  return {
    textureMode,
    textured,
    existingMeshTexture,
    fullTextureWorkflow,
    stableSourceForTexture,
    workflowTemplate: existingMeshTexture
      ? COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE
      : textured
        ? COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE
        : COMFYUI_WORKFLOW_TEMPLATE,
    timeoutMs: textured ? COMFYUI_HY3DPAINT_TIMEOUT_MS : COMFYUI_TIMEOUT_MS,
    pollIntervalMs: textured ? COMFYUI_HY3DPAINT_POLL_INTERVAL_MS : COMFYUI_POLL_INTERVAL_MS,
    steps: fullTextureWorkflow
      ? COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS
      : textured
      ? COMFYUI_HY3DPAINT_STEPS
      : stableSourceForTexture
        ? COMFYUI_HY3DPAINT_STABLE_STEPS
        : COMFYUI_STEPS,
    faces: fullTextureWorkflow
      ? COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES
      : textured
      ? COMFYUI_HY3DPAINT_FACES
      : stableSourceForTexture
        ? COMFYUI_HY3DPAINT_STABLE_FACES
        : COMFYUI_FACES,
    guidanceScale: fullTextureWorkflow
      ? COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE
      : textured
      ? COMFYUI_HY3DPAINT_GUIDANCE_SCALE
      : stableSourceForTexture
        ? COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE
        : COMFYUI_GUIDANCE_SCALE,
    minRamFreeGb: textured ? COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB : COMFYUI_MIN_RAM_FREE_GB,
    minVramFreeGb: textured ? COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB : COMFYUI_MIN_VRAM_FREE_GB,
    staleHistoryLimit: textured ? COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT : COMFYUI_STALE_HISTORY_LIMIT,
    unobservableRecoveryLimit: textured ? COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT : COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT,
    label: existingMeshTexture
      ? 'Hunyuan3D-Paint existing raw GLB + Bio3D'
      : fullTextureWorkflow
        ? 'TripoSG full-resolution + Hunyuan3D-Paint + Bio3D'
        : textured
        ? 'TripoSG + Hunyuan3D-Paint + Bio3D'
        : stableSourceForTexture
          ? 'TripoSG low-poly raw + Bio3D'
          : 'TripoSG + Bio3D',
  }
}

function buildStableFallbackJob(job, guard) {
  return {
    ...job,
    textureMode: 'stable',
    requestedTextureMode: job.textureMode || 'stable',
    textureFallbackReason: guard?.message || '混元贴图资源保护已生效，自动切回稳定几何版。',
  }
}

export async function getComfyUiStatus() {
  try {
    const stats = await fetchJson(`${COMFYUI_BASE_URL}/system_stats`, {
      timeoutMs: COMFYUI_STATUS_LIMITS.systemStatsTimeoutMs,
      retries: COMFYUI_STATUS_LIMITS.retries,
      context: '检查 ComfyUI 服务',
    })
    if (!stats?.system && !Array.isArray(stats?.devices)) {
      throw Object.assign(new Error('ComfyUI 已连接但尚未返回完整 system_stats，可能正在冷启动。'), {
        recoverable: true,
        code: 'COMFYUI_EMPTY_STATUS',
      })
    }
    const queue = await fetchJson(`${COMFYUI_BASE_URL}/queue`, {
      timeoutMs: COMFYUI_STATUS_LIMITS.queueTimeoutMs,
      retries: COMFYUI_STATUS_LIMITS.retries,
      context: '检查 ComfyUI 队列',
    }).catch(() => null)
    return {
      ok: true,
      state: 'ready',
      recoverable: false,
      message: '自部署 3D 服务在线。',
      baseUrl: COMFYUI_BASE_URL,
      workflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
      texture: {
        enabled: COMFYUI_HY3DPAINT_ENABLED,
        workflowTemplate: COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE,
        existingMeshWorkflowTemplate: COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE,
        minRamFreeGb: COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB,
        minTotalRamGb: COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
        lowMemoryTotalRamGb: COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
        lowMemoryRemoteEnabled: COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED,
        fullRetryOnTimeout: COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT,
        minVramFreeGb: COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB,
        runtimeMinRamFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB,
        runtimeMinVramFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB,
        runtimeGuardGracePolls: COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS,
        runtimeBackoffCount: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT,
        runtimeBackoffMs: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS,
        abortOnUnobservable: COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE,
        pollIntervalMs: COMFYUI_HY3DPAINT_POLL_INTERVAL_MS,
        steps: COMFYUI_HY3DPAINT_STEPS,
        faces: COMFYUI_HY3DPAINT_FACES,
        guidanceScale: COMFYUI_HY3DPAINT_GUIDANCE_SCALE,
        fullWorkflowFirst: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
        fullWorkflowSteps: COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS,
        fullWorkflowFaces: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES,
        fullWorkflowGuidanceScale: COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE,
        stableSteps: COMFYUI_HY3DPAINT_STABLE_STEPS,
        stableFaces: COMFYUI_HY3DPAINT_STABLE_FACES,
        stableGuidanceScale: COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE,
        staleHistoryLimit: COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
        unobservableRecoveryLimit: COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
      },
      gpu: stats?.devices?.map((device) => ({
        name: device.name,
        type: device.type,
        vramTotal: device.vram_total,
        vramFree: device.vram_free,
      })) || [],
      ram: summarizeSystemMemory(stats?.system),
      queue: queue
        ? {
            running: Array.isArray(queue.queue_running) ? queue.queue_running.length : 0,
            pending: Array.isArray(queue.queue_pending) ? queue.queue_pending.length : 0,
        }
        : null,
    }
  } catch (error) {
    const serviceState = classifyComfyServiceError(error)
    return {
      ok: false,
      state: serviceState.state,
      recoverable: serviceState.recoverable,
      message: serviceState.message,
      baseUrl: COMFYUI_BASE_URL,
      workflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
      texture: {
        enabled: COMFYUI_HY3DPAINT_ENABLED,
        workflowTemplate: COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE,
        existingMeshWorkflowTemplate: COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE,
        minRamFreeGb: COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB,
        minTotalRamGb: COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
        lowMemoryTotalRamGb: COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
        lowMemoryRemoteEnabled: COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED,
        fullRetryOnTimeout: COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT,
        minVramFreeGb: COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB,
        runtimeMinRamFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB,
        runtimeMinVramFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB,
        runtimeGuardGracePolls: COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS,
        runtimeBackoffCount: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT,
        runtimeBackoffMs: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS,
        abortOnUnobservable: COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE,
        pollIntervalMs: COMFYUI_HY3DPAINT_POLL_INTERVAL_MS,
        steps: COMFYUI_HY3DPAINT_STEPS,
        faces: COMFYUI_HY3DPAINT_FACES,
        guidanceScale: COMFYUI_HY3DPAINT_GUIDANCE_SCALE,
        fullWorkflowFirst: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
        fullWorkflowSteps: COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS,
        fullWorkflowFaces: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES,
        fullWorkflowGuidanceScale: COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE,
        stableSteps: COMFYUI_HY3DPAINT_STABLE_STEPS,
        stableFaces: COMFYUI_HY3DPAINT_STABLE_FACES,
        stableGuidanceScale: COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE,
        staleHistoryLimit: COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
        unobservableRecoveryLimit: COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
      },
      error: error.message || 'ComfyUI 健康检查失败。',
    }
  }
}

export async function freeComfyUiMemory({ unloadModels = true, freeMemory = true } = {}) {
  if (!COMFYUI_FREE_AFTER_JOB) return { skipped: true, reason: 'disabled' }
  try {
    await fetchJson(`${COMFYUI_BASE_URL}/free`, {
      method: 'POST',
      body: JSON.stringify({ unload_models: unloadModels, free_memory: freeMemory }),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: COMFYUI_FREE_TIMEOUT_MS,
      retries: 0,
      context: '释放 ComfyUI 显存缓存',
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      recoverable: true,
      message: error.message || '释放 ComfyUI 显存缓存失败。',
    }
  }
}

export async function diagnoseComfyUiJob(job) {
  if (!job?.providerJobId) {
    throw Object.assign(new Error('缺少 ComfyUI prompt_id，无法诊断远端三维任务。'), { status: 400 })
  }

  const [queue, historyPayload] = await Promise.all([
    fetchJson(`${COMFYUI_BASE_URL}/queue`, {
      timeoutMs: COMFYUI_DIAGNOSTIC_LIMITS.queueTimeoutMs,
      retries: COMFYUI_DIAGNOSTIC_LIMITS.retries,
      context: '查询 ComfyUI 队列',
    }).catch((error) => ({
      error: error.message || '队列查询失败。',
    })),
    fetchJson(`${COMFYUI_BASE_URL}/history/${encodeURIComponent(job.providerJobId)}`, {
      timeoutMs: COMFYUI_DIAGNOSTIC_LIMITS.historyTimeoutMs,
      retries: COMFYUI_DIAGNOSTIC_LIMITS.retries,
      context: '查询 ComfyUI 任务历史',
    }).catch((error) => ({
      error: error.message || '历史查询失败。',
    })),
  ])

  const historyItem = pickPromptHistoryItem(historyPayload, job.providerJobId)
  const outputs = historyItem ? findGlbOutputs(historyItem) : []
  const queueSummary = summarizeComfyQueue(queue, job.providerJobId)
  const historyStatus = summarizeHistoryStatus(historyItem, historyPayload?.error)
  if (historyItem) await saveHistory(job.id, job.providerJobId, historyItem)

  return {
    promptId: job.providerJobId,
    shortPromptId: shortPromptId(job.providerJobId),
    baseUrl: COMFYUI_BASE_URL,
    queue: queueSummary,
    history: historyStatus,
    outputs: {
      glbCount: outputs.length,
      final: outputs.some((item) => isFinalOutput(item)),
      textured: outputs.some((item) => isTexturedOutput(item)),
      raw: outputs.some((item) => /raw/i.test(item.label || item.fileName || item.serverPath || '')),
      candidates: outputs.slice(0, 4).map((item) => ({
        fileName: item.fileName,
        label: item.label,
        type: item.type || 'output',
        subfolder: item.subfolder || '',
      })),
    },
    recommendation: buildComfyDiagnosisRecommendation({ queueSummary, historyStatus, outputs }),
    checkedAt: new Date().toISOString(),
  }
}

export function summarizeComfyHistoryOutputs(historyItem) {
  const outputs = historyItem ? findGlbOutputs(historyItem) : []
  const historyStatus = summarizeHistoryStatus(historyItem, null)
  const queueSummary = {
    ok: true,
    running: 0,
    pending: 0,
    containsPrompt: false,
    message: '测试或离线 history 摘要。',
  }
  return {
    outputs,
    historyStatus,
    hasExecutionError: Boolean(getExecutionErrorMessage(historyItem?.status || {})),
    missingGlb: Boolean(historyItem && !outputs.length && !getExecutionErrorMessage(historyItem?.status || {})),
    recommendation: buildComfyDiagnosisRecommendation({ queueSummary, historyStatus, outputs }),
  }
}

export async function recoverComfyHistoryItemWithOutputs(promptId, historyPayload) {
  const historyItem = pickPromptHistoryItem(historyPayload, promptId)
  if (!historyItem) return null

  const outputs = findGlbOutputs(historyItem)
  const executionError = getExecutionErrorMessage(historyItem.status || {})
  if (executionError) {
    outputs.push(...await recoverGlbOutputsFromExecutionError(executionError))
  }

  return outputs.length ? historyItem : null
}

export async function generateComfyUiModel(job, onProgress) {
  if (!job.referenceId) {
    throw Object.assign(new Error('缺少参考图，请先确认图片。'), { status: 400 })
  }

  const { record: reference, localPath: referencePath } = await getReferenceImage(job.referenceId)
  await onProgress({
    progress: Math.max(job.progress || 0, 34),
    stage: '已读取确认参考图，正在连接本地三维生成服务。',
    eventName: 'selfhost-3d-reference-loaded',
  })

  let effectiveJob = job
  let profile = getComfyJobProfile(effectiveJob)
  let textureFallbackReason = ''
  try {
    await waitForComfyResources(onProgress, { profile })
  } catch (error) {
    if (
      profile.textured &&
      COMFYUI_HY3DPAINT_AUTO_FALLBACK &&
      (error?.code === 'COMFYUI_RESOURCE_GUARD' || error?.code === 'COMFYUI_HY3DPAINT_DISABLED')
    ) {
      textureFallbackReason = error?.detail?.message || error?.message || '混元贴图资源保护已生效，自动切回稳定几何版。'
      await onProgress({
        progress: Math.max(job.progress || 0, 38),
        stage: `${textureFallbackReason}；本次先自动降级为 TripoSG + Bio3D 稳定几何版，避免触发 OOM。`,
        eventName: 'selfhost-3d-texture-fallback',
        patch: {
          textureFallbackReason,
          requestedTextureMode: job.textureMode || 'hunyuan',
          effectiveTextureMode: 'stable',
          textureMode: 'stable',
        },
      })
      effectiveJob = buildStableFallbackJob(job, error?.detail)
      profile = getComfyJobProfile(effectiveJob)
      await waitForComfyResources(onProgress, { profile })
    } else {
      throw error
    }
  }
  const remoteImage = await uploadComfyImage(referencePath, reference)
  await onProgress({
    progress: Math.max(job.progress || 0, 42),
    stage: `参考图已上传到 ComfyUI，正在提交 ${profile.label} 工作流。`,
    eventName: 'selfhost-3d-reference-uploaded',
  })

  const prompt = await submitWorkflow(effectiveJob, remoteImage)
  await onProgress({
    progress: Math.max(job.progress || 0, 52),
    stage: profile.textured
      ? '三维生成任务已进入本地队列，正在等待几何与混元贴图输出。'
      : '三维生成任务已进入本地队列，正在等待稳定几何与后处理输出。',
    eventName: 'selfhost-3d-submitted',
    patch: { providerJobId: prompt.promptId },
  })

  const historyItem = await pollHistory(prompt.promptId, async (progress, stage) => {
    await onProgress({ progress, stage, eventName: 'selfhost-3d-polling' })
  }, { profile })

  return persistComfyUiOutputs(effectiveJob, prompt.promptId, historyItem, onProgress, { textureFallbackReason })
}

export async function enhanceComfyUiModelTexture(job, onProgress) {
  return enhanceComfyUiModelTextureWithTemplate(job, onProgress, {
    fullWorkflow: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
    retryAttempted: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
  })
}

async function enhanceComfyUiModelTextureWithTemplate(job, onProgress, options = {}) {
  if (!job.referenceId) {
    throw Object.assign(new Error('缺少参考图，请先完成稳定图生 3D 后再提交贴图增强。'), { status: 400 })
  }

  const fullWorkflow = Boolean(options.fullWorkflow)
  const rawSource = fullWorkflow ? null : await resolveRawMeshForTexture(job)
  const { record: reference, localPath: referencePath } = await getReferenceImage(job.referenceId)
  await onProgress({
    progress: Math.max(job.progress || 0, 34),
    stage: fullWorkflow
      ? '正在用历史成功的完整 TripoSG -> Hunyuan -> Bio3D 链路执行贴图；运行中仍保留 RAM/VRAM 硬熔断。'
      : '已读取稳定几何模型与参考图，准备单独执行混元贴图后处理。',
    eventName: fullWorkflow ? 'selfhost-3d-texture-full-workflow-reference-loaded' : 'selfhost-3d-texture-reference-loaded',
    patch: {
      rawModelUrl: job.rawModelUrl || job.result?.rawModelUrl,
      sourceJobId: job.sourceJobId,
    },
  })

  let profile = getComfyJobProfile({
    ...job,
    textureMode: 'hunyuan',
    workflowMode: fullWorkflow ? 'full-hunyuan-texture' : 'texture-enhance',
  })
  const rawBackoffJob = {
    ...job,
    rawMeshServerPath: rawSource?.serverPath || job.rawMeshServerPath,
  }
  const backoff = fullWorkflow ? null : getTextureRuntimeBackoff(rawBackoffJob)
  if (backoff?.active) {
    throw Object.assign(new Error(backoff.message), {
      status: 503,
      recoverable: true,
      code: 'COMFYUI_HY3DPAINT_RUNTIME_BACKOFF',
      detail: backoff,
    })
  }
  await waitForComfyResources(onProgress, { profile })

  const remoteImage = await uploadComfyImage(referencePath, reference)
  await onProgress({
    progress: Math.max(job.progress || 0, 42),
    stage: fullWorkflow
      ? `参考图已上传，正在提交完整 Hunyuan 贴图工作流（${profile.steps} steps / ${profile.faces} faces / guidance ${profile.guidanceScale}）。`
      : '参考图已上传，正在提交“已有 raw GLB -> 混元贴图 -> Bio3D final”后处理工作流。',
    eventName: fullWorkflow ? 'selfhost-3d-texture-full-workflow-uploaded' : 'selfhost-3d-texture-reference-uploaded',
  })

  const prompt = await submitWorkflow({
    ...job,
    textureMode: 'hunyuan',
    workflowMode: fullWorkflow ? 'full-hunyuan-texture' : 'texture-enhance',
    rawMeshServerPath: rawSource?.serverPath,
  }, remoteImage)
  await onProgress({
    progress: Math.max(job.progress || 0, 54),
    stage: fullWorkflow
      ? '完整混元贴图工作流已进入远端队列；系统会继续观察 RAM/VRAM 硬熔断线，避免 OOM。'
      : '混元贴图后处理已进入远端队列；本次不会重跑 TripoSG，只等待 textured/final GLB。',
    eventName: fullWorkflow ? 'selfhost-3d-texture-full-workflow-submitted' : 'selfhost-3d-texture-submitted',
    patch: {
      providerJobId: prompt.promptId,
      rawMeshServerPath: rawSource?.serverPath || job.rawMeshServerPath,
      sourceProviderJobId: rawSource?.promptId || job.sourceProviderJobId,
      textureRetryMode: fullWorkflow ? 'full-hunyuan' : 'existing-mesh',
    },
  })

  let historyItem
  try {
    historyItem = await pollHistory(prompt.promptId, async (progress, stage) => {
      await onProgress({
        progress,
        stage,
        eventName: fullWorkflow ? 'selfhost-3d-texture-full-workflow-polling' : 'selfhost-3d-texture-polling',
      })
    }, { profile })
  } catch (error) {
    if (!fullWorkflow && error?.code === 'COMFYUI_HY3DPAINT_RUNTIME_GUARD') {
      const recorded = recordTextureRuntimeBackoff(rawBackoffJob, error)
      if (recorded?.active) {
        await onProgress({
          progress: 84,
          stage: `同一 raw 白模已连续 ${recorded.count} 次触发混元贴图运行熔断；系统已进入短期退避，后续会直接生成确认参考图轻量贴图 fallback，避免重复挤占 20GB 服务器。`,
          eventName: 'selfhost-3d-texture-runtime-backoff-armed',
          patch: {
            textureRuntimeBackoffUntil: recorded.backoffUntil,
            textureFallbackReason: firstLine(error.message),
          },
        })
      }
    }
    if (
      shouldRetryFullHunyuanAfterExistingMeshFailure(error, { fullWorkflow, retryAttempted: options.retryAttempted })
    ) {
      await onProgress({
        progress: 84,
        stage: `${firstLine(error.message)}；existing-mesh 贴图没有按时产出，正在释放缓存并切换到历史成功的完整 Hunyuan 链路重试一次。`,
        eventName: 'selfhost-3d-texture-full-retry-started',
        patch: {
          textureRetryMode: 'full-hunyuan',
          textureFallbackReason: firstLine(error.message),
        },
      })
      await freeComfyUiMemory()
      return enhanceComfyUiModelTextureWithTemplate(job, onProgress, {
        fullWorkflow: true,
        retryAttempted: true,
        previousError: error,
      })
    }
    throw error
  }

  const result = await persistComfyUiOutputs({
    ...job,
    textureMode: 'hunyuan',
    requestedTextureMode: 'hunyuan',
    workflowMode: fullWorkflow ? 'full-hunyuan-texture' : 'texture-enhance',
    rawModelUrl: job.rawModelUrl || job.result?.rawModelUrl,
    textureFallbackReason: job.textureFallbackReason,
  }, prompt.promptId, historyItem, onProgress)
  if (result?.effectiveTextureMode === 'hunyuan') {
    clearTextureRuntimeBackoff(rawBackoffJob)
  }
  return result
}

export function getTextureRuntimeBackoff(job = {}) {
  const key = textureBackoffKey(job)
  if (!key) return null
  const entry = textureRuntimeBackoffState.get(key)
  if (!entry) return null
  if (entry.backoffUntil <= Date.now()) {
    textureRuntimeBackoffState.delete(key)
    return null
  }
  const remainingMinutes = Math.ceil((entry.backoffUntil - Date.now()) / 60000)
  return {
    active: true,
    key,
    count: entry.count,
    backoffUntil: new Date(entry.backoffUntil).toISOString(),
    remainingMinutes,
    message: `同一 raw 白模最近连续 ${entry.count} 次触发 Hunyuan3D-Paint 运行内存熔断；未来约 ${remainingMinutes} 分钟直接使用确认参考图轻量贴图 fallback，避免重复挤爆 20GB 服务器。`,
  }
}

export function recordTextureRuntimeBackoff(job = {}, reason = {}) {
  const key = textureBackoffKey(job)
  if (!key) return null
  const existing = textureRuntimeBackoffState.get(key) || { count: 0, backoffUntil: 0 }
  const count = existing.count + 1
  const shouldBackoff = count >= COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT
  const entry = {
    count,
    lastReason: reason?.message || String(reason || ''),
    lastAt: Date.now(),
    backoffUntil: shouldBackoff ? Date.now() + COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS : 0,
  }
  textureRuntimeBackoffState.set(key, entry)
  return {
    key,
    count,
    active: shouldBackoff,
    backoffUntil: shouldBackoff ? new Date(entry.backoffUntil).toISOString() : undefined,
  }
}

export function clearTextureRuntimeBackoff(job = {}) {
  const key = textureBackoffKey(job)
  if (key) textureRuntimeBackoffState.delete(key)
}

export function textureBackoffKey(job = {}) {
  return String(job.rawMeshServerPath || job.rawModelUrl || job.result?.rawModelUrl || job.sourceJobId || '').trim()
}

function shouldRetryFullHunyuanAfterExistingMeshFailure(error, options = {}) {
  if (!COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT) return false
  if (options.fullWorkflow || options.retryAttempted) return false
  const message = `${error?.message || ''} ${error?.code || ''}`
  return /timed out|超时|timeout/i.test(message) && !/运行熔断线|OOM|out of memory|内存|vram|显存/i.test(message)
}

export async function buildColorFallbackModel(job, reason, onProgress) {
  if (!BIO3D_COLOR_FALLBACK_ENABLED) throw reason instanceof Error ? reason : new Error(String(reason || '混元贴图增强失败。'))
  const sourceUrl = pickColorFallbackSourceUrl(job)
  if (!sourceUrl) throw reason instanceof Error ? reason : new Error(String(reason || '混元贴图增强失败，且没有可复用的稳定 GLB。'))
  const sourcePath = localModelUrlToPath(sourceUrl)
  if (!sourcePath) throw reason instanceof Error ? reason : new Error(String(reason || '无法定位稳定 GLB，不能生成轻量贴图 fallback。'))
  const preflightSkipped =
    reason?.code === 'COMFYUI_HY3DPAINT_PREFLIGHT_FALLBACK' || reason?.code === 'BIO3D_FORCE_COLOR_FALLBACK'

  await onProgress?.({
    progress: 90,
    stage: preflightSkipped
      ? '资源保护已跳过 Hunyuan3D-Paint，正在把确认参考图嵌入稳定 Bio3D final，生成本地轻量贴图版。'
      : '混元贴图暂未返回，正在把确认参考图嵌入稳定 Bio3D final，生成本地轻量贴图版。',
    eventName: 'selfhost-3d-color-fallback-started',
  })

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`color-fallback-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  const info = await colorizeGlbFile(sourcePath, targetPath, {
    template: job.template,
    materialName: `learningcell_${job.template || 'bio'}_color_fallback`,
    ...(await getReferenceTextureOptions(job)),
  })
  const buffer = await readFile(targetPath)
  validateModelBuffer(buffer, 'glb')
  const errorMessage = reason?.message || String(reason || '混元贴图增强未返回。')
  const requestedTextureMode = job.requestedTextureMode === 'fallback-color' ? 'fallback-color' : 'hunyuan'

  return {
    id: `generated-${job.id}`,
    name: `AI 生成：${getTemplateDisplayName(job.template)}`,
    subtitle: 'Bio3D 轻量贴图 fallback',
    category: 'AI 生成示意模型',
    accent: accentForTemplate(job.template),
    description: `根据「${job.prompt}」确认参考图后生成的本地三维模型。${preflightSkipped ? '资源保护已跳过 Hunyuan3D-Paint 重贴图' : 'Hunyuan3D-Paint 暂未产出 textured GLB'}，系统已复用稳定 Bio3D final 嵌入确认参考图、轻量贴图与顶点彩色，保证课堂展示不断链。原始原因：${firstLine(errorMessage)}`,
    fileName: targetName,
    fileSize: info.bytes,
    imageHint: job.template,
    template: job.template,
    textureMode: 'fallback-color',
    requestedTextureMode,
    effectiveTextureMode: 'fallback-color',
    sourceJobId: job.sourceJobId,
    textureFallbackReason: firstLine(errorMessage),
    provider: '本地 Bio3D 轻量贴图 fallback',
    referenceImageUrl: job.referenceImageUrl,
    rawModelUrl: job.rawModelUrl || job.result?.rawModelUrl,
    fallbackModelUrl: sourceUrl,
    modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
  }
}

function pickColorFallbackSourceUrl(job = {}) {
  return (
    job.rawModelUrl ||
    job.result?.rawModelUrl ||
    job.sourceModelUrl ||
    job.result?.sourceModelUrl ||
    job.result?.fallbackModelUrl ||
    job.result?.modelUrl ||
    job.modelUrl
  )
}

export async function resumeComfyUiModel(job, onProgress) {
  const promptIds = getComfyResumePromptIds(job)
  if (!promptIds.length) {
    throw Object.assign(new Error('缺少 ComfyUI prompt_id，无法续接本地三维任务。'), { status: 400 })
  }

  await onProgress({
    progress: Math.max(job.progress || 0, 55),
    stage: '服务已重启，正在根据 ComfyUI prompt_id 续接三维生成结果。',
    eventName: 'selfhost-3d-resume-started',
  })

  await waitForComfyReady(onProgress, {
    progress: Math.max(job.progress || 0, 58),
    stage: '正在确认自部署 3D 服务已从冷启动恢复，随后只拉取 history / GLB，不提交新的重任务。',
  })

  const cachedFirst = await findCachedHistoryWithOutputs(job.id, promptIds)
  if (cachedFirst) {
    await onProgress({
      progress: Math.max(job.progress || 0, 84),
      stage: cachedFirst.promptId === job.providerJobId
        ? '已发现本地缓存的 ComfyUI history，正在拉取已生成 GLB。'
        : '当前 prompt 未产出可用 GLB，正在用上一次 ComfyUI history 恢复已生成的 raw/textured GLB。',
      eventName: 'selfhost-3d-resume-cached-history',
      patch: cachedFirst.promptId === job.providerJobId
        ? {}
        : {
            recoveredProviderJobId: cachedFirst.promptId,
            resumeError: `使用缓存 prompt ${shortPromptId(cachedFirst.promptId)} 恢复已生成 GLB。`,
          },
    })
    return persistComfyUiOutputs(job, cachedFirst.promptId, cachedFirst.historyItem, onProgress)
  }

  let lastError
  for (const promptId of promptIds) {
    try {
      const historyItem = await pollHistory(promptId, async (progress, stage) => {
        await onProgress({
          progress: Math.max(progress, Math.max(job.progress || 0, 55)),
          stage,
          eventName: 'selfhost-3d-resume-polling',
          patch: promptId === job.providerJobId ? {} : { recoveredProviderJobId: promptId },
        })
      })
      return persistComfyUiOutputs(job, promptId, historyItem, onProgress)
    } catch (error) {
      lastError = error
      const cachedHistory = await findCachedHistoryWithOutputs(job.id, [promptId])
      if (cachedHistory) {
        await onProgress({
          progress: Math.max(job.progress || 0, 84),
          stage: '远端 history 暂不可达，正在使用本地缓存的 ComfyUI history 拉取已生成 GLB。',
          eventName: 'selfhost-3d-resume-cached-history',
          patch: { recoveredProviderJobId: cachedHistory.promptId },
        })
        return persistComfyUiOutputs(job, cachedHistory.promptId, cachedHistory.historyItem, onProgress)
      }
    }
  }

  const cachedFallback = await findCachedHistoryWithOutputs(job.id)
  if (cachedFallback) {
    await onProgress({
      progress: Math.max(job.progress || 0, 84),
      stage: '未在当前 prompt 找到 GLB，正在扫描同任务缓存 history 恢复已生成输出。',
      eventName: 'selfhost-3d-resume-cached-history-scan',
      patch: {
        recoveredProviderJobId: cachedFallback.promptId,
        resumeError: `使用缓存 prompt ${shortPromptId(cachedFallback.promptId)} 恢复已生成 GLB。`,
      },
    })
    return persistComfyUiOutputs(job, cachedFallback.promptId, cachedFallback.historyItem, onProgress)
  }

  throw lastError || new Error('无法根据 ComfyUI prompt_id 续接任务。')
}

export function getComfyResumePromptIds(job) {
  return Array.from(new Set([
    job?.providerJobId,
    job?.lastProviderJobId,
    job?.recoveredProviderJobId,
  ].filter(Boolean).map((value) => String(value))))
}

async function findCachedHistoryWithOutputs(jobId, promptIds = []) {
  const checked = new Set()
  for (const promptId of promptIds) {
    checked.add(promptId)
    const historyItem = await readCachedHistory(jobId, promptId)
    if (historyItem && findGlbOutputs(historyItem).length) {
      return { promptId, historyItem, source: 'exact' }
    }
  }

  const cachedItems = await readCachedHistoriesForJob(jobId)
  return cachedItems
    .filter((item) => !checked.has(item.promptId))
    .filter((item) => findGlbOutputs(item.historyItem).length)
    .sort((a, b) => scoreHistoryForRecovery(b.historyItem) - scoreHistoryForRecovery(a.historyItem) || b.mtimeMs - a.mtimeMs)[0] || null
}

function scoreHistoryForRecovery(historyItem) {
  const outputs = findGlbOutputs(historyItem)
  if (outputs.some((item) => isFinalOutput(item))) return 40
  if (outputs.some((item) => isTexturedOutput(item))) return 30
  if (outputs.some((item) => isRawOutput(item))) return 20
  return outputs.length ? 10 : 0
}

async function resolveRawMeshForTexture(job) {
  const promptIds = getComfyResumePromptIds({
    ...job,
    providerJobId: job.sourceProviderJobId || job.providerJobId,
  })
  const cachedHistory = await findCachedHistoryWithOutputs(job.sourceJobId || job.id, promptIds)
    || await findCachedHistoryWithOutputs(job.id, promptIds)

  const rawFromHistory = cachedHistory
    ? findGlbOutputs(cachedHistory.historyItem).find((item) => isRawOutput(item))
      || pickBestOutput(findGlbOutputs(cachedHistory.historyItem))
    : null
  const serverPath = rawFromHistory?.serverPath || outputToServerPath(rawFromHistory)
  if (serverPath) {
    return {
      serverPath,
      promptId: cachedHistory?.promptId,
      source: 'cached-history',
    }
  }

  const knownServerPath = String(job.rawMeshServerPath || '').trim()
  if (knownServerPath) {
    return {
      serverPath: knownServerPath,
      promptId: job.sourceProviderJobId || job.providerJobId,
      source: 'job',
    }
  }

  throw Object.assign(new Error('没有找到可供混元贴图复用的远端 raw GLB。请先完成一次稳定图生 3D，或点击“诊断远端/续接输出”恢复 raw 输出。'), {
    status: 409,
    recoverable: true,
    code: 'COMFYUI_RAW_MESH_MISSING',
  })
}

async function readCachedHistoriesForJob(jobId) {
  try {
    const prefix = sanitizeFileName(`comfyui-${jobId}-`, 'comfyui-')
    const files = await readdir(WORKFLOW_STORE_DIR, { withFileTypes: true })
    const histories = []
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith(prefix) || !file.name.endsWith('.json')) continue
      const localPath = path.join(WORKFLOW_STORE_DIR, file.name)
      const promptId = file.name.slice(prefix.length, -'.json'.length)
      try {
        const [info, historyItem] = await Promise.all([
          stat(localPath),
          readFile(localPath, 'utf8').then((text) => JSON.parse(text)),
        ])
        histories.push({ promptId, historyItem, mtimeMs: info.mtimeMs })
      } catch {
        // Ignore malformed cache entries; they should not block recovery from a valid history file.
      }
    }
    return histories
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function persistComfyUiOutputs(job, promptId, historyItem, onProgress, options = {}) {
  const profile = getComfyJobProfile(job)
  const outputs = findGlbOutputs(historyItem)
  const executionError = getExecutionErrorMessage(historyItem.status || {})
  if (executionError) {
    const recoveredOutputs = await recoverGlbOutputsFromExecutionError(executionError)
    outputs.push(...recoveredOutputs)
  }
  if (!outputs.length) {
    await saveHistory(job.id, promptId, historyItem)
    throw new Error('本地三维工作流已结束，但没有找到 GLB 输出。')
  }

  const selected = pickBestOutput(outputs, { preferTextured: profile.textured })
  const raw = outputs.find((item) => isRawOutput(item))
  const textured = outputs.find((item) => isTexturedOutput(item))
  const stableRawModelUrl = job.rawModelUrl || job.result?.rawModelUrl

  await onProgress({
    progress: 86,
    stage: '已找到三维生成结果，正在下载并写入工作台模型缓存。',
    eventName: 'selfhost-3d-downloading',
  })

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`generated-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  await downloadOutput(selected, targetPath)
  const buffer = await readFile(targetPath)
  validateModelBuffer(buffer, 'glb')
  const targetUrl = `/api/3d/local-model/${encodeURIComponent(targetName)}`

  let rawModelUrl = isRawOutput(selected) ? targetUrl : stableRawModelUrl
  if (raw && raw !== selected) {
    const rawName = `${sanitizeModelId(`raw-${job.id}-${job.template}`)}.glb`
    const rawPath = path.join(LOCAL_MODEL_DIR, rawName)
    await downloadOutput(raw, rawPath)
    rawModelUrl = `/api/3d/local-model/${encodeURIComponent(rawName)}`
  }

  let texturedModelUrl = isTexturedOutput(selected) ? targetUrl : undefined
  if (textured && textured !== selected && textured !== raw) {
    const texturedName = `${sanitizeModelId(`textured-${job.id}-${job.template}`)}.glb`
    const texturedPath = path.join(LOCAL_MODEL_DIR, texturedName)
    await downloadOutput(textured, texturedPath)
    texturedModelUrl = `/api/3d/local-model/${encodeURIComponent(texturedName)}`
  }

  const selectedIsFinal = isFinalOutput(selected)
  const selectedIsTextured = isTexturedOutput(selected)
  const hasTexturedStage = Boolean(texturedModelUrl || textured || selectedIsTextured || (selectedIsFinal && profile.textured && !raw))
  const actualHunyuanTextured = selectedIsTextured || (selectedIsFinal && profile.textured && hasTexturedStage)
  let effectiveTextureMode = actualHunyuanTextured
    ? 'hunyuan'
    : 'stable'
  const requestedTextureMode = job.requestedTextureMode || (profile.textured ? 'hunyuan' : job.textureMode)
  let displayName = targetName
  let displayPath = targetPath
  let displayUrl = targetUrl
  let displayInfo = await stat(targetPath)
  let displayProvider = isFinalOutput(selected)
    ? profile.textured
      ? '本地 TripoSG + Hunyuan3D-Paint + Bio3D Final（保留贴图材质）'
      : '本地 TripoSG + Bio3D Final'
    : isTexturedOutput(selected)
      ? '本地 TripoSG + Hunyuan3D-Paint'
      : '本地 TripoSG raw 几何'
  let displaySubtitle = isFinalOutput(selected)
    ? 'Bio3D 后处理最终模型'
    : isTexturedOutput(selected)
      ? '贴图阶段模型'
      : '几何阶段模型'
  let displayColorReason = ''
  const textureVisualizationNeeded = actualHunyuanTextured && shouldEnhanceTexturedDisplay(buffer)
  const shouldColorizeDisplay = BIO3D_COLOR_FALLBACK_ENABLED && (!actualHunyuanTextured || textureVisualizationNeeded)
  if (shouldColorizeDisplay) {
    displayColorReason = textureVisualizationNeeded
      ? 'Hunyuan3D-Paint 已返回 textured GLB，但材质接近纯白或贴图可视度偏低；系统已保留原始 textured GLB，并生成 Bio3D 彩色可视化展示版。'
      : options.textureFallbackReason || job.textureFallbackReason || '稳定 TripoSG/Bio3D 输出已自动写入轻量贴图与顶点彩色，避免前端展示白模。'
    await onProgress?.({
      progress: 90,
      stage: textureVisualizationNeeded
        ? '已缓存 Hunyuan textured GLB，正在生成 Bio3D 彩色可视化展示版；原始贴图 GLB 会保留为 Textured/Source GLB。'
        : '已缓存稳定 GLB，正在嵌入确认参考图并写入 Bio3D 轻量贴图展示版；原始几何会保留为 Raw/Source GLB。',
      eventName: textureVisualizationNeeded ? 'selfhost-3d-texture-visualization-pass' : 'selfhost-3d-display-color-fallback',
    })
    const colorized = await writeColorizedDisplayModel({
      job,
      sourcePath: targetPath,
      targetPrefix: textureVisualizationNeeded ? 'display-textured-color' : 'display-color',
    })
    displayName = colorized.fileName
    displayPath = colorized.localPath
    displayUrl = colorized.modelUrl
    displayInfo = await stat(displayPath)
    displayProvider = textureVisualizationNeeded
      ? '本地 Hunyuan3D-Paint + Bio3D 彩色展示版'
      : '本地 Bio3D 轻量贴图展示版'
    displaySubtitle = textureVisualizationNeeded
      ? 'Hunyuan 贴图彩色展示模型'
      : 'Bio3D 轻量贴图展示模型'
    effectiveTextureMode = textureVisualizationNeeded ? 'hunyuan' : 'fallback-color'
  }

  await saveHistory(job.id, promptId, historyItem)
  const partialReason = getExecutionErrorMessage(historyItem.status || '')
  const partialNote = partialReason && !isFinalOutput(selected)
    ? `远端贴图/后处理节点未完整结束，已优先保留可用的 ${isTexturedOutput(selected) ? 'textured' : 'raw'} GLB；任务 history 中保留了错误详情。`
    : ''
  const fallbackNote = options.textureFallbackReason || job.textureFallbackReason
    ? `混元贴图本次未提交：${options.textureFallbackReason || job.textureFallbackReason}；已安全降级为稳定几何版。`
    : ''
  const chainSummary = isFinalOutput(selected)
    ? profile.existingMeshTexture
      ? '链路已复用稳定 raw GLB，完成 Hunyuan3D-Paint 贴图与 Bio3D 校验导出；当前展示全彩后处理模型。'
      : profile.textured
      ? '链路已完成 TripoSG 几何重建、Hunyuan3D-Paint 贴图与 Bio3D 校验导出，当前展示优先保留贴图材质。'
      : shouldColorizeDisplay && !textureVisualizationNeeded
        ? '链路已完成 TripoSG 几何重建与 Bio3D 后处理；系统已自动写入轻量贴图与顶点彩色，当前默认展示非白模。'
        : '链路已完成 TripoSG 几何重建与 Bio3D 后处理；当前为稳定几何版，混元贴图可在资源充足时作为增强步骤单独生成。'
    : isTexturedOutput(selected)
      ? textureVisualizationNeeded
        ? '链路已完成 TripoSG 几何重建与 Hunyuan3D-Paint 贴图；原始 textured GLB 已保留，当前默认展示 Bio3D 彩色可视化版，避免课堂舞台继续像白模。'
        : '链路已完成 TripoSG 几何重建与 Hunyuan3D-Paint 贴图，Bio3D final 后处理可稍后继续复查。'
      : shouldColorizeDisplay
        ? '链路已完成 TripoSG raw 几何重建；系统已自动写入轻量贴图与顶点彩色，当前默认展示非白模。'
        : '链路已完成 TripoSG raw 几何重建；贴图或后处理超时/失败时，系统会先把可用 raw GLB 写入标本索引。'

  return {
    id: `generated-${job.id}`,
    name: `AI 生成：${getTemplateDisplayName(job.template)}`,
    subtitle: displaySubtitle,
    category: 'AI 生成示意模型',
    accent: accentForTemplate(job.template),
    description: `根据「${job.prompt}」确认参考图后生成的本地三维模型。${chainSummary}${partialNote}${fallbackNote}${displayColorReason && !fallbackNote ? `彩色处理：${displayColorReason}` : ''}`,
    fileName: displayName,
    fileSize: displayInfo.size,
    imageHint: job.template,
    template: job.template,
    textureMode: effectiveTextureMode,
    requestedTextureMode,
    effectiveTextureMode,
    sourceJobId: job.sourceJobId,
    textureFallbackReason: options.textureFallbackReason || job.textureFallbackReason,
    provider: displayProvider,
    referenceImageUrl: job.referenceImageUrl,
    rawModelUrl,
    sourceModelUrl: targetUrl,
    fallbackModelUrl: shouldColorizeDisplay && !textureVisualizationNeeded ? targetUrl : undefined,
    rawMeshServerPath: raw?.serverPath || job.rawMeshServerPath || outputToServerPath(raw || selected),
    providerJobId: promptId,
    texturedModelUrl: texturedModelUrl || (actualHunyuanTextured ? targetUrl : undefined),
    modelUrl: displayUrl,
  }
}

export function shouldEnhanceTexturedDisplay(buffer) {
  try {
    const json = readGlbJson(buffer)
    const materials = Array.isArray(json.materials) ? json.materials : []
    if (!materials.length) return false
    const texturedMaterials = materials.filter((material) => material?.pbrMetallicRoughness?.baseColorTexture)
    if (!texturedMaterials.length) return false
    return texturedMaterials.every((material) => {
      const pbr = material.pbrMetallicRoughness || {}
      const color = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1]
      const rgb = color.slice(0, 3).map((value) => Number(value))
      const avg = rgb.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 1), 0) / 3
      const spread = Math.max(...rgb) - Math.min(...rgb)
      const roughness = Number(pbr.roughnessFactor ?? material.roughnessFactor ?? 1)
      return avg >= 0.92 && spread <= 0.08 && (!Number.isFinite(roughness) || roughness >= 0.82)
    })
  } catch {
    return false
  }
}

function readGlbJson(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) return {}
  if (buffer.readUInt32LE(0) !== 0x46546c67) return {}
  const jsonLength = buffer.readUInt32LE(12)
  const chunkType = buffer.readUInt32LE(16)
  if (chunkType !== 0x4e4f534a || 20 + jsonLength > buffer.length) return {}
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\u0000\s]+$/g, ''))
}

export async function writeColorizedDisplayModel({ job, sourcePath, outputDir = LOCAL_MODEL_DIR, targetPrefix = 'display-color' }) {
  await mkdir(outputDir, { recursive: true })
  const fileName = `${sanitizeModelId(`${targetPrefix}-${job.id}-${job.template}`)}.glb`
  const localPath = path.join(outputDir, fileName)
  const info = await colorizeGlbFile(sourcePath, localPath, {
    template: job.template,
    materialName: `learningcell_${job.template || 'bio'}_display_color`,
    ...(await getReferenceTextureOptions(job)),
  })
  const buffer = await readFile(localPath)
  validateModelBuffer(buffer, 'glb')
  return {
    fileName,
    fileSize: info.bytes,
    localPath,
    modelUrl: `/api/3d/local-model/${encodeURIComponent(fileName)}`,
  }
}

async function getReferenceTextureOptions(job) {
  const referenceId = job?.referenceId || job?.reference?.id
  if (!referenceId) return {}
  try {
    const { record, localPath } = await getReferenceImage(referenceId)
    return {
      textureImagePath: localPath,
      textureMimeType: record.mimeType,
    }
  } catch {
    return {}
  }
}

async function uploadComfyImage(imagePath, reference) {
  const imageBytes = await readFile(imagePath)
  const boundary = `----learningCellComfy${randomUUID().replace(/-/g, '')}`
  const remoteName = sanitizeFileName(`${reference.id}.${reference.ext || 'png'}`, 'reference.png')
  const subfolder = 'learningcell'
  const parts = []

  appendField(parts, boundary, 'type', 'input')
  appendField(parts, boundary, 'subfolder', subfolder)
  appendField(parts, boundary, 'overwrite', 'true')
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${remoteName}"\r\n` +
        `Content-Type: ${reference.mimeType || 'image/png'}\r\n\r\n`
    )
  )
  parts.push(imageBytes)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

  const result = await fetchJson(`${COMFYUI_BASE_URL}/upload/image`, {
    method: 'POST',
    body: Buffer.concat(parts),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    timeoutMs: 120000,
    retries: 2,
    context: '上传参考图到 ComfyUI',
  })

  const name = result.name || remoteName
  const folder = result.subfolder ?? subfolder
  return folder ? `${folder}/${name}` : name
}

function appendField(parts, boundary, name, value) {
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
    )
  )
}

async function submitWorkflow(job, remoteImage) {
  const profile = getComfyJobProfile(job)
  if (profile.textured && !COMFYUI_HY3DPAINT_ENABLED) {
    throw Object.assign(new Error('混元贴图增强当前未启用；请先关闭贴图增强或设置 COMFYUI_HY3DPAINT_ENABLED=true。'), {
      status: 409,
      recoverable: true,
      code: 'COMFYUI_HY3DPAINT_DISABLED',
    })
  }
  const workflow = JSON.parse(await readFile(profile.workflowTemplate, 'utf8'))
  const prefix = sanitizeModelId(`learningcell-${job.id}`)
  const imageNode = findWorkflowNodeByClass(workflow, 'LoadImage') || workflow['1']
  if (imageNode?.inputs) imageNode.inputs.image = remoteImage
  const tripoNode = findWorkflowNodeByClass(workflow, 'TripoSGImageTo3D')
  if (tripoNode?.inputs) {
    tripoNode.inputs.output_prefix = `${prefix}_raw`
    tripoNode.inputs.num_inference_steps = profile.steps
    tripoNode.inputs.guidance_scale = profile.guidanceScale
    tripoNode.inputs.faces = profile.faces
  }
  const paintNode = findWorkflowNodeByClass(workflow, 'Hunyuan3DPaintExistingMesh')
  if (paintNode) {
    paintNode.inputs.output_prefix = `${prefix}_painted`
    if (profile.existingMeshTexture && job.rawMeshServerPath) {
      paintNode.inputs.model_3d = job.rawMeshServerPath
    }
  }
  const finalNode = findWorkflowNodeByClass(workflow, 'Bio3DPostProcessGLB')
  if (finalNode) {
    finalNode.inputs.output_prefix = `${prefix}_final`
  }

  const payload = {
    client_id: randomUUID(),
    prompt: workflow,
  }
  const result = await fetchJson(`${COMFYUI_BASE_URL}/prompt`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 60000,
  })

  if (!result.prompt_id) throw new Error('ComfyUI 没有返回 prompt_id。')
  return { promptId: result.prompt_id }
}

function findWorkflowNodeByClass(workflow, classType) {
  return Object.values(workflow).find((node) => node?.class_type === classType)
}

async function pollHistory(promptId, onTick, options = {}) {
  const profile = options.profile || getComfyJobProfile()
  const staleHistoryLimit = profile.staleHistoryLimit || COMFYUI_STALE_HISTORY_LIMIT
  const unobservableRecoveryLimit = profile.unobservableRecoveryLimit || COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT
  const deadline = Date.now() + profile.timeoutMs
  let tick = 0
  let consecutiveQueueEmptyMisses = 0
  let consecutiveEmptyOutputHistory = 0
  let consecutiveUnobservableMisses = 0
  let consecutiveRuntimePressure = 0

  while (Date.now() < deadline) {
    await delay(profile.pollIntervalMs || COMFYUI_POLL_INTERVAL_MS)
    tick += 1
    const progress = Math.min(82, 52 + tick * 3)
    if (profile.textured) {
      const runtimeGuard = await evaluateRuntimeResourceGuard(promptId)
      if (!runtimeGuard.ok) {
        consecutiveRuntimePressure += 1
        await onTick(
          Math.min(82, progress),
          `${runtimeGuard.message}；系统正在观察第 ${consecutiveRuntimePressure}/${COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS} 次，必要时会中断贴图任务以保护服务器。`
        )
        if (consecutiveRuntimePressure >= COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS) {
          await interruptComfyUiPrompt(promptId)
          const recoveredHistoryItem = await recoverPromptHistoryWithOutputs(promptId, {
            progress: Math.min(84, progress + 1),
            onTick,
            message: '运行熔断已触发，但远端可能已经写出 painted GLB；正在先回收可用贴图结果，避免误降级为 fallback。',
          })
          if (recoveredHistoryItem) return recoveredHistoryItem
          throw Object.assign(new Error(`${runtimeGuard.message}；已主动中断混元贴图任务，保留稳定 raw GLB，避免触发 OOM。`), {
            status: 503,
            recoverable: true,
            code: 'COMFYUI_HY3DPAINT_RUNTIME_GUARD',
            detail: runtimeGuard,
          })
        }
      } else {
        consecutiveRuntimePressure = 0
      }
    }
    await onTick(
      progress,
      profile.textured
        ? '本地三维服务正在输出几何与混元贴图，完成后会自动下载 GLB 并写入标本索引。'
        : '本地三维服务正在输出稳定几何与后处理，完成后会自动下载 GLB 并写入标本索引。'
    )
    const historyUrl = `${COMFYUI_BASE_URL}/history/${encodeURIComponent(promptId)}`
    const history = await fetchJson(historyUrl, {
      timeoutMs: COMFYUI_HISTORY_POLL_TIMEOUT_MS,
      context: '查询 ComfyUI 任务历史',
    }).catch((error) => {
      if (isTransientComfyError(error) && tick <= COMFYUI_HISTORY_RECOVERY_LIMIT) {
        return null
      }
      throw error
    })
    if (!history) {
      const queue = await fetchJson(`${COMFYUI_BASE_URL}/queue`, {
        timeoutMs: COMFYUI_QUEUE_POLL_TIMEOUT_MS,
        context: '查询 ComfyUI 队列',
      }).catch((error) => ({
        error: error.message || '队列查询失败。',
      }))
      const queueSummary = summarizeComfyQueue(queue, promptId)
      if (queueSummary.containsPrompt) {
        consecutiveQueueEmptyMisses = 0
        consecutiveUnobservableMisses = 0
      } else if (!queueSummary.ok) {
        consecutiveUnobservableMisses += 1
        if (consecutiveUnobservableMisses >= unobservableRecoveryLimit) {
          throw buildRemoteUnobservableError(promptId, queueSummary, consecutiveUnobservableMisses)
        }
      } else if (queueSummary.ok && !queueSummary.running && !queueSummary.pending) {
        consecutiveUnobservableMisses = 0
        consecutiveQueueEmptyMisses += 1
        if (consecutiveQueueEmptyMisses >= staleHistoryLimit) {
          throw Object.assign(new Error('ComfyUI history 查询超时且远端队列已为空；任务已保留 prompt_id，可稍后诊断或续接。'), {
            status: 504,
            recoverable: true,
            detail: { promptId, queue: queueSummary, misses: consecutiveQueueEmptyMisses },
          })
        }
      } else {
        consecutiveQueueEmptyMisses = 0
        consecutiveUnobservableMisses = 0
      }
      await onTick(
        progress,
        queueSummary.containsPrompt
          ? '远端队列仍在运行该 3D 任务，history 暂时查询超时；系统继续等待，不会追加长队列。'
          : !queueSummary.ok
            ? profile.textured
              ? '混元贴图会短暂阻塞远端 API；系统正在延长等待，不会重复提交新任务。'
              : '远端 3D 队列暂时不可达，任务可能仍在运行；系统继续等待并保留 prompt_id。'
          : tick <= COMFYUI_HISTORY_RETRY_LIMIT
          ? '远端 3D 服务正在恢复或忙于写入 history，任务已保留 prompt_id，系统会继续轮询。'
          : '远端 3D 服务仍未稳定返回 history；系统继续等待，必要时可稍后点“续接输出”。'
      )
      continue
    }

    const item = history[promptId] || Object.values(history)[0]
    if (!item) {
      const queue = await fetchJson(`${COMFYUI_BASE_URL}/queue`, {
        timeoutMs: COMFYUI_QUEUE_POLL_TIMEOUT_MS,
        context: '查询 ComfyUI 队列',
      }).catch((error) => ({
        error: error.message || '队列查询失败。',
      }))
      const queueSummary = summarizeComfyQueue(queue, promptId)
      if (!queueSummary.ok) {
        consecutiveUnobservableMisses += 1
        if (consecutiveUnobservableMisses >= unobservableRecoveryLimit) {
          throw buildRemoteUnobservableError(promptId, queueSummary, consecutiveUnobservableMisses)
        }
      } else {
        consecutiveUnobservableMisses = 0
      }
      if (queueSummary.ok && !queueSummary.running && !queueSummary.pending && !queueSummary.containsPrompt) {
        consecutiveQueueEmptyMisses += 1
        if (consecutiveQueueEmptyMisses >= staleHistoryLimit) {
          throw Object.assign(new Error('ComfyUI 队列已为空，但 history 没有返回该 prompt_id；远端服务可能冷启动、OOM 重启或 history 尚未落盘。任务已保留，可稍后诊断或续接。'), {
            status: 504,
            recoverable: true,
            detail: { promptId, queue: queueSummary, misses: consecutiveQueueEmptyMisses },
          })
        }
      } else {
        consecutiveQueueEmptyMisses = 0
      }
      continue
    }

    const status = item.status || {}
    consecutiveUnobservableMisses = 0
    const executionError = getExecutionErrorMessage(status)
    const glbOutputs = findGlbOutputs(item)
    if (executionError) {
      if (glbOutputs.length) {
        await onTick(84, '远端贴图或后处理节点报错，但已发现可用 GLB，正在按部分结果写入标本索引。')
        return item
      }
      throw new Error(executionError)
    }

    if (status.status_str && status.status_str !== 'success') {
      if (glbOutputs.length) {
        await onTick(84, `ComfyUI 返回 ${status.status_str}，但已发现可用 GLB，正在保留部分结果。`)
        return item
      }
      throw new Error(`ComfyUI 工作流状态异常：${status.status_str}`)
    }

    if (!glbOutputs.length) {
      consecutiveEmptyOutputHistory += 1
      if (consecutiveEmptyOutputHistory <= COMFYUI_EMPTY_OUTPUT_RETRY_LIMIT) {
        await onTick(
          Math.min(84, progress + 1),
          'ComfyUI history 已返回，GLB 输出仍在落盘或写入缓存；系统会继续复查，避免过早判定失败。'
        )
        continue
      }
      throw Object.assign(new Error('ComfyUI history 已返回，但暂未发现 GLB 输出；任务已保留 prompt_id，可稍后诊断远端或续接输出。'), {
        status: 504,
        recoverable: true,
        detail: {
          promptId,
          status: status.status_str || 'unknown',
          misses: consecutiveEmptyOutputHistory,
        },
      })
    }

    return item
  }

  throw Object.assign(new Error('本地三维生成超时，请检查 ComfyUI 队列或 GPU 服务状态。'), { status: 504 })
}

async function recoverPromptHistoryWithOutputs(promptId, { progress = 84, onTick, message } = {}) {
  if (!promptId) return null
  await onTick?.(progress, message || '正在检查 ComfyUI history 是否已经写出可用 GLB。')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const historyPayload = await fetchJson(`${COMFYUI_BASE_URL}/history/${encodeURIComponent(promptId)}`, {
      timeoutMs: COMFYUI_HISTORY_POLL_TIMEOUT_MS,
      retries: 0,
      context: '回收 ComfyUI 贴图输出',
    }).catch(() => null)

    const historyItem = await recoverComfyHistoryItemWithOutputs(promptId, historyPayload)
    if (historyItem) {
      await onTick?.(
        progress,
        '已在 ComfyUI history 中回收到可用 GLB，优先写入全彩贴图结果；不会重新提交重任务。'
      )
      return historyItem
    }
    await delay(Math.min(3000, 900 * (attempt + 1)))
  }

  return null
}

function buildRemoteUnobservableError(promptId, queueSummary, misses) {
  return Object.assign(
    new Error('远端 3D 服务在长任务末段暂时不可观测；已保留 ComfyUI prompt_id，可稍后诊断或续接输出，系统不会重复提交重任务。'),
    {
      status: 504,
      recoverable: true,
      code: 'COMFYUI_REMOTE_UNOBSERVABLE',
      detail: { promptId, queue: queueSummary, misses },
    }
  )
}

function getExecutionErrorMessage(status) {
  for (const message of status.messages || []) {
    const [event, data] = Array.isArray(message) ? message : []
    if (event === 'execution_error') {
      return data?.exception_message || 'ComfyUI 执行工作流失败。'
    }
  }
  return ''
}

function pickPromptHistoryItem(historyPayload, promptId) {
  if (!historyPayload || historyPayload.error) return null
  if (promptId && historyPayload[promptId]) return historyPayload[promptId]
  return Object.values(historyPayload)[0] || null
}

async function waitForComfyReady(onProgress, options = {}) {
  let lastStatus
  for (let attempt = 0; attempt <= COMFYUI_READY_RETRY_LIMIT; attempt += 1) {
    lastStatus = await getComfyUiStatus()
    if (lastStatus.ok) return lastStatus

    const delayMs = Math.min(18000, COMFYUI_READY_RETRY_BASE_MS * (attempt + 1))
    await onProgress?.({
      progress: options.progress ?? 36,
      stage: options.stage || `${lastStatus.message || '自部署 3D 服务正在恢复'}，${Math.round(delayMs / 1000)} 秒后自动重试。`,
      eventName: 'selfhost-3d-wait-ready',
    })
    await delay(delayMs)
  }

  const error = Object.assign(
    new Error(lastStatus?.message || '自部署 3D 服务暂不可用，请稍后诊断或续接。'),
    {
      status: 503,
      recoverable: true,
      detail: lastStatus,
    }
  )
  throw error
}

async function waitForComfyResources(onProgress, options = {}) {
  const profile = options.profile || getComfyJobProfile()
  if (profile.textured && !COMFYUI_HY3DPAINT_ENABLED) {
    throw Object.assign(new Error('混元贴图增强当前未启用；稳定几何版仍可正常生成。'), {
      status: 409,
      recoverable: true,
      code: 'COMFYUI_HY3DPAINT_DISABLED',
    })
  }
  let status = await waitForComfyReady(onProgress, options)
  if (profile.textured && COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD) {
    await onProgress?.({
      progress: Math.max(30, (options.progress ?? 38) - 3),
      stage: '混元贴图会占用更多内存，正在先释放远端 ComfyUI 缓存并重新检查 RAM/VRAM。',
      eventName: 'selfhost-3d-hy3dpaint-preflight-free',
    })
    await freeComfyUiMemory()
    status = await waitForComfyReady(onProgress, options)
  }
  let guard = evaluateComfyResourceGuard(status, { profile })
  if (!guard.ok && COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD && (guard.reason === 'ram-low' || guard.reason === 'vram-low')) {
    await onProgress?.({
      progress: Math.max(30, (options.progress ?? 38) - 2),
      stage: `${guard.message}；正在先释放远端 ComfyUI 缓存后复查，避免直接提交导致 OOM。`,
      eventName: 'selfhost-3d-preflight-free',
    })
    await freeComfyUiMemory()
    status = await waitForComfyReady(onProgress, options)
    guard = evaluateComfyResourceGuard(status, { profile })
  }
  if (guard.ok) return status

  const taskLabel = profile.textured ? 'TripoSG/Hunyuan3D-Paint 贴图增强' : 'TripoSG/Bio3D'
  const message = `${guard.message}；已暂停提交新的 ${taskLabel} 重任务，避免再次触发 OOM。`
  await onProgress?.({
    progress: options.progress ?? 38,
    stage: message,
    eventName: 'selfhost-3d-resource-guard',
  })

  throw Object.assign(new Error(message), {
    status: 503,
    recoverable: true,
    code: 'COMFYUI_RESOURCE_GUARD',
    detail: guard,
  })
}

export function evaluateComfyResourceGuard(status, options = {}) {
  const profile = options.profile || getComfyJobProfile()
  const minRamFreeGb = profile.minRamFreeGb ?? COMFYUI_MIN_RAM_FREE_GB
  const minVramFreeGb = profile.minVramFreeGb ?? COMFYUI_MIN_VRAM_FREE_GB
  if (!COMFYUI_RESOURCE_GUARD) return { ok: true, skipped: true, reason: 'disabled' }
  if (!status?.ok) {
    return {
      ok: false,
      reason: 'service-not-ready',
      message: status?.message || '自部署 3D 服务尚未恢复到可提交状态',
    }
  }

  const ram = status.ram || {}
  const ramTotalGiB = bytesToGiB(ram.total)
  if (profile.textured && Number.isFinite(ramTotalGiB) && ramTotalGiB < COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB) {
    return {
      ok: false,
      reason: 'ram-total-low',
      ramTotalGiB,
      ramRequiredGiB: COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
      message: `服务器总内存约 ${formatGiB(ramTotalGiB)}，低于 ${COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB}GB 混元贴图最低运行线`,
    }
  }
  const lowMemoryMode = Boolean(
    profile.textured &&
    Number.isFinite(ramTotalGiB) &&
    ramTotalGiB < COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB
  )

  const ramFreeGiB = bytesToGiB(ram.available ?? ram.free)
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < minRamFreeGb) {
    return {
      ok: false,
      reason: 'ram-low',
      ramFreeGiB,
      ramRequiredGiB: minRamFreeGb,
      message: `服务器可用内存约 ${formatGiB(ramFreeGiB)}，低于 ${minRamFreeGb}GB ${profile.textured ? '混元贴图安全线' : '安全线'}`,
    }
  }

  const gpu = Array.isArray(status.gpu) ? status.gpu[0] : null
  const vramFreeGiB = bytesToGiB(gpu?.vramFree)
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < minVramFreeGb) {
    return {
      ok: false,
      reason: 'vram-low',
      vramFreeGiB,
      vramRequiredGiB: minVramFreeGb,
      message: `3080 可用显存约 ${formatGiB(vramFreeGiB)}，低于 ${minVramFreeGb}GB ${profile.textured ? '混元贴图安全线' : '安全线'}`,
    }
  }

  return {
    ok: true,
    ramFreeGiB: Number.isFinite(ramFreeGiB) ? ramFreeGiB : undefined,
    ramTotalGiB: Number.isFinite(ramTotalGiB) ? ramTotalGiB : undefined,
    lowMemoryMode,
    lowMemoryTotalRamGb: COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
    vramFreeGiB: Number.isFinite(vramFreeGiB) ? vramFreeGiB : undefined,
  }
}

export function evaluateComfyTextureSubmissionGuard(status, options = {}) {
  const profile = getComfyJobProfile({
    textureMode: 'hunyuan',
    workflowMode: options.workflowMode || 'texture-enhance',
  })
  const autoFallback = Boolean(COMFYUI_HY3DPAINT_AUTO_FALLBACK && BIO3D_COLOR_FALLBACK_ENABLED)
  const lowMemoryRemoteEnabled = options.lowMemoryRemoteEnabled ?? COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED

  if (!COMFYUI_HY3DPAINT_ENABLED) {
    return {
      ok: false,
      reason: 'hy3dpaint-disabled',
      autoFallback,
      message: '混元贴图增强当前未启用',
      profileLabel: profile.label,
    }
  }

  const remoteRunning = status?.queue?.running ?? 0
  const remotePending = status?.queue?.pending ?? 0
  if (COMFYUI_BLOCK_WHEN_REMOTE_BUSY && remoteRunning + remotePending > 0) {
    return {
      ok: false,
      reason: 'remote-queue-busy',
      autoFallback,
      remoteRunning,
      remotePending,
      message: `远端 ComfyUI 队列仍有 ${remoteRunning} 个运行 / ${remotePending} 个等待任务；不会提交 Hunyuan3D-Paint，改用稳定 GLB 的本地轻量贴图 fallback。`,
      profileLabel: profile.label,
    }
  }

  const guard = evaluateComfyResourceGuard(status, { profile })
  if (guard.ok) {
    if (guard.lowMemoryMode && !lowMemoryRemoteEnabled) {
      return {
        ok: false,
        reason: 'low-memory-remote-disabled',
        autoFallback,
        lowMemoryMode: true,
        profileLabel: profile.label,
        message: `服务器总内存约 ${formatGiB(guard.ramTotalGiB)}，处于 20GB 低内存模式；实测 Hunyuan3D-Paint 会把可用 RAM 压到危险区，默认不提交远端贴图，改用稳定 GLB 的本地轻量贴图 fallback。`,
        detail: guard,
      }
    }
    if (guard.lowMemoryMode && lowMemoryRemoteEnabled) {
      return {
        ok: true,
        reason: 'low-memory-remote-ready',
        autoFallback: false,
        lowMemoryMode: true,
        profileLabel: profile.label,
        message: `20GB 低内存贴图试跑已放行：服务器总内存约 ${formatGiB(guard.ramTotalGiB)}，将只提交 existing-mesh Hunyuan3D-Paint，运行中低于 ${COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB}GB RAM 或 ${COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB}GB VRAM 硬熔断线时会中断并生成本地彩色 fallback。`,
        detail: guard,
      }
    }
    return {
      ok: true,
      reason: 'ready',
      autoFallback: false,
      lowMemoryMode: Boolean(guard.lowMemoryMode),
      message: guard.lowMemoryMode
        ? `混元贴图资源检查通过：服务器总内存约 ${formatGiB(guard.ramTotalGiB)}，已显式允许 20GB 低内存远端贴图，将提交 existing-mesh Hunyuan3D-Paint，并保留运行中熔断与轻量贴图 fallback。`
        : '混元贴图资源检查通过，可以提交 Hunyuan3D-Paint 后处理。',
      profileLabel: profile.label,
      detail: guard,
    }
  }

  return {
    ...guard,
    ok: false,
    autoFallback,
    profileLabel: profile.label,
    message: `${guard.message || '混元贴图资源检查未通过'}；不会提交 Hunyuan3D-Paint，改用稳定 GLB 的本地轻量贴图 fallback。`,
    detail: guard,
  }
}

async function evaluateRuntimeResourceGuard(promptId) {
  const status = await getComfyUiStatus()
  if (!status?.ok) {
    if (!COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE) {
      return {
        ok: true,
        reason: 'service-not-observable',
        promptId,
        status,
        message: status?.message || '混元贴图运行中远端服务暂不可观测，继续等待 history/queue 恢复',
      }
    }
    return {
      ok: false,
      reason: 'service-not-observable',
      message: status?.message || '混元贴图运行中远端服务暂不可观测',
      promptId,
      status,
    }
  }

  const ramFreeGiB = bytesToGiB(status.ram?.available ?? status.ram?.free)
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB) {
    return {
      ok: false,
      reason: 'runtime-ram-low',
      promptId,
      ramFreeGiB,
      ramRequiredGiB: COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB,
      message: `混元贴图运行中可用内存约 ${formatGiB(ramFreeGiB)}，低于 ${COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB}GB 运行熔断线`,
    }
  }

  const gpu = Array.isArray(status.gpu) ? status.gpu[0] : null
  const vramFreeGiB = bytesToGiB(gpu?.vramFree)
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB) {
    return {
      ok: false,
      reason: 'runtime-vram-low',
      promptId,
      vramFreeGiB,
      vramRequiredGiB: COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB,
      message: `混元贴图运行中可用显存约 ${formatGiB(vramFreeGiB)}，低于 ${COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB}GB 运行熔断线`,
    }
  }

  return {
    ok: true,
    promptId,
    ramFreeGiB: Number.isFinite(ramFreeGiB) ? ramFreeGiB : undefined,
    vramFreeGiB: Number.isFinite(vramFreeGiB) ? vramFreeGiB : undefined,
  }
}

async function interruptComfyUiPrompt(promptId) {
  try {
    await fetchJson(`${COMFYUI_BASE_URL}/interrupt`, {
      method: 'POST',
      timeoutMs: 5000,
      retries: 0,
      context: `中断 ComfyUI 任务 ${shortPromptId(promptId)}`,
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      recoverable: true,
      message: error.message || '中断 ComfyUI 任务失败。',
    }
  }
}

function findGlbOutputs(historyItem) {
  const outputs = []
  walk(historyItem, (value, key) => {
    if (isDiagnosticOnlyHistoryKey(key)) return

    if (typeof value === 'string') {
      for (const match of value.matchAll(/\/[^"'\n\r]+?\.glb/g)) {
        outputs.push({
          serverPath: match[0],
          fileName: path.basename(match[0]),
          label: `${key || ''} ${match[0]}`,
        })
      }
      if (/\.glb$/i.test(value) && !/[\\/"']/.test(value)) {
        outputs.push({
          fileName: value,
          subfolder: '',
          type: 'output',
          label: `${key || ''} ${value}`,
        })
      }
      if (/^[A-Za-z0-9_.-][A-Za-z0-9_./-]*\.glb$/i.test(value) && value.includes('/')) {
        outputs.push({
          fileName: path.basename(value),
          subfolder: path.dirname(value) === '.' ? '' : path.dirname(value),
          type: 'output',
          label: `${key || ''} ${value}`,
        })
      }
    }

    if (value && typeof value === 'object' && typeof value.filename === 'string' && /\.glb$/i.test(value.filename)) {
      outputs.push({
        fileName: value.filename,
        subfolder: value.subfolder || '',
        type: value.type || 'output',
        label: `${key || ''} ${value.filename}`,
      })
    }

    if (value && typeof value === 'object') {
      for (const field of ['model_file', 'model_3d', 'path']) {
        if (typeof value[field] === 'string' && /\.glb$/i.test(value[field])) {
          const candidate = value[field]
          outputs.push(
            candidate.startsWith('/')
              ? {
                  serverPath: candidate,
                  fileName: path.basename(candidate),
                  label: `${key || ''} ${field} ${candidate}`,
                }
              : {
                  fileName: path.basename(candidate),
                  subfolder: path.dirname(candidate) === '.' ? '' : path.dirname(candidate),
                  type: value.type || 'output',
                  label: `${key || ''} ${field} ${candidate}`,
                }
          )
        }
      }
    }
  })

  return dedupeOutputs(outputs)
}

function isDiagnosticOnlyHistoryKey(key = '') {
  return /status\.messages|traceback|exception|current_inputs|prompt\./i.test(key)
}

export function summarizeComfyQueue(queue, promptId) {
  if (!queue || queue?.error) {
    return {
      ok: false,
      running: 0,
      pending: 0,
      containsPrompt: false,
      message: queue?.error || '远端队列暂时不可达，不能据此判断任务已结束。',
    }
  }

  const runningItems = Array.isArray(queue?.queue_running) ? queue.queue_running : []
  const pendingItems = Array.isArray(queue?.queue_pending) ? queue.queue_pending : []
  const containsPrompt = [...runningItems, ...pendingItems].some((item) => JSON.stringify(item).includes(promptId))
  return {
    ok: true,
    running: runningItems.length,
    pending: pendingItems.length,
    containsPrompt,
    message: containsPrompt
      ? '远端队列仍包含该任务。'
      : runningItems.length || pendingItems.length
        ? '远端队列有其他任务，该任务暂未出现在队列摘要中。'
        : '远端队列为空，该任务可能已离队，需检查 history 输出。',
  }
}

function summarizeHistoryStatus(historyItem, historyError) {
  if (historyError) {
    return {
      ok: false,
      found: false,
      status: 'error',
      message: historyError,
    }
  }
  if (!historyItem) {
    return {
      ok: true,
      found: false,
      status: 'missing',
      message: 'history 暂未返回该 prompt_id，可能仍在远端写入或已被清理。',
    }
  }

  const status = historyItem.status || {}
  const statusText = status.status_str || 'unknown'
  const hasExecutionError = (status.messages || []).some((message) => {
    const [event] = Array.isArray(message) ? message : []
    return event === 'execution_error'
  })
  return {
    ok: !hasExecutionError && statusText !== 'error',
    found: true,
    status: hasExecutionError ? 'execution_error' : statusText,
    message: hasExecutionError
      ? 'history 已返回执行错误，请展开任务详情查看服务端错误。'
      : statusText === 'success'
        ? 'history 已返回成功状态，正在检查 GLB 输出。'
        : `history 已返回状态：${statusText}。`,
  }
}

function buildComfyDiagnosisRecommendation({ queueSummary, historyStatus, outputs }) {
  if (outputs.length) {
    const picked = pickBestOutput(outputs)
    if (isFinalOutput(picked)) return 'history 已发现 Bio3D final GLB，可点击“续接输出”下载最终模型并写入标本索引。'
    if (isTexturedOutput(picked)) return 'history 已发现 textured GLB，可点击“续接输出”下载贴图模型；建议后续检查 Bio3D final 节点。'
    return 'history 已发现 raw GLB，可点击“续接输出”下载几何模型；贴图/后处理节点可能还需检查。'
  }
  if (historyStatus.found && historyStatus.status === 'success') return 'history 成功但未发现 GLB，建议检查 Preview3D / Bio3DPostProcessGLB 输出节点或 output_prefix。'
  if (!queueSummary.ok) return '远端队列暂时不可达，任务可能仍在运行；建议稍后同步或继续续接，不要重新生成参考图。'
  if (!queueSummary.running && !queueSummary.pending && !historyStatus.found) return '远端队列为空且 history 暂缺，建议稍后再次诊断；若持续如此，可能需要检查远端 history 保留策略。'
  if (queueSummary.containsPrompt) return '远端队列仍包含该任务，请等待或稍后同步状态。'
  return '请保持任务记录，可稍后点击“诊断远端”或“续接输出”。'
}

function shortPromptId(promptId) {
  return String(promptId || '').slice(-8).toUpperCase() || 'COMFYUI'
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).find(Boolean) || '混元贴图增强未返回。'
}

function walk(value, visit, key = '') {
  visit(value, key)
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${key}.${index}`))
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      walk(childValue, visit, key ? `${key}.${childKey}` : childKey)
    }
  }
}

function dedupeOutputs(outputs) {
  const seen = new Set()
  return outputs.filter((item) => {
    const key = item.serverPath || `${item.subfolder}/${item.fileName}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pickBestOutput(outputs, options = {}) {
  if (options.preferTextured) {
    return (
      outputs.find((item) => isTexturedOutput(item)) ||
      outputs.find((item) => isFinalOutput(item)) ||
      outputs.find((item) => !/raw/i.test(item.label || item.fileName || item.serverPath || '')) ||
      outputs[0]
    )
  }
  return (
    outputs.find((item) => isFinalOutput(item)) ||
    outputs.find((item) => isTexturedOutput(item)) ||
    outputs.find((item) => !/raw/i.test(item.label || item.fileName || item.serverPath || '')) ||
    outputs[0]
  )
}

function isFinalOutput(item) {
  return /bio3d|final|latest/i.test(item?.label || item?.fileName || item?.serverPath || '')
}

function isTexturedOutput(item) {
  return /painted|hy3dpaint|textured/i.test(item?.label || item?.fileName || item?.serverPath || '')
}

function isRawOutput(item) {
  return /raw/i.test(item?.label || item?.fileName || item?.serverPath || '')
}

async function recoverGlbOutputsFromExecutionError(message = '') {
  const candidates = []
  for (const match of String(message || '').matchAll(/(?:--output\s+)?(\/[^\s"']+?\.glb)\b/g)) {
    const serverPath = match[1]
    if (!/painted|hy3dpaint|textured|final|bio3d/i.test(serverPath)) continue
    const output = {
      serverPath,
      fileName: path.basename(serverPath),
      label: `execution_error verified ${serverPath}`,
      recoveredFromError: true,
    }
    if (await canDownloadGlbOutput(output)) candidates.push(output)
  }
  return dedupeOutputs(candidates)
}

async function canDownloadGlbOutput(output) {
  const url = output.serverPath ? outputPathToViewUrl(output.serverPath) : outputObjectToViewUrl(output)
  try {
    const response = await fetchWithRetry(url, {
      timeoutMs: 12000,
      retries: 0,
      context: '验证 ComfyUI 错误日志中的 GLB 输出',
    })
    if (!response.ok) return false
    const buffer = Buffer.from(await response.arrayBuffer())
    validateModelBuffer(buffer, 'glb')
    return true
  } catch {
    return false
  }
}

async function downloadOutput(output, targetPath) {
  const url = output.serverPath ? outputPathToViewUrl(output.serverPath) : outputObjectToViewUrl(output)
  const response = await fetchWithRetry(url, {
    timeoutMs: 120000,
    retries: COMFYUI_DOWNLOAD_RETRY_LIMIT,
    context: '下载 ComfyUI GLB 输出',
  })
  if (!response.ok) {
    throw Object.assign(new Error(`下载 ComfyUI GLB 输出失败：HTTP ${response.status}`), {
      status: response.status,
      endpoint: scrubComfyEndpoint(url),
      recoverable: isRecoverableComfyStatus(response.status),
    })
  }
  const tmpPath = `${targetPath}.downloading`
  const buffer = Buffer.from(await response.arrayBuffer())
  validateModelBuffer(buffer, 'glb')
  await writeFile(tmpPath, buffer)
  await rename(tmpPath, targetPath)
}

function outputPathToViewUrl(serverPath) {
  const relative = serverPath.startsWith(COMFYUI_OUTPUT_PREFIX)
    ? serverPath.slice(COMFYUI_OUTPUT_PREFIX.length)
    : path.basename(serverPath)
  const subfolder = path.dirname(relative) === '.' ? '' : path.dirname(relative)
  const fileName = path.basename(relative)
  const query = new URLSearchParams({ filename: fileName, subfolder, type: 'output' })
  return `${COMFYUI_BASE_URL}/view?${query.toString()}`
}

function outputToServerPath(output) {
  if (!output) return ''
  if (output.serverPath) return output.serverPath
  if (!output.fileName) return ''
  const subfolder = output.subfolder || ''
  return `${COMFYUI_OUTPUT_PREFIX}${subfolder ? `${subfolder.replace(/^\/+|\/+$/g, '')}/` : ''}${output.fileName}`
}

function outputObjectToViewUrl(output) {
  const query = new URLSearchParams({
    filename: output.fileName,
    subfolder: output.subfolder || '',
    type: output.type || 'output',
  })
  return `${COMFYUI_BASE_URL}/view?${query.toString()}`
}

function localModelUrlToPath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  let pathname = text
  try {
    pathname = new URL(text, 'http://127.0.0.1').pathname
  } catch {
    pathname = text
  }
  const marker = '/api/3d/local-model/'
  if (!pathname.includes(marker)) return ''
  const fileName = sanitizeFileName(decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length)))
  return path.join(LOCAL_MODEL_DIR, fileName)
}

async function saveHistory(jobId, promptId, historyItem) {
  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const fileName = sanitizeFileName(`comfyui-${jobId}-${promptId}.json`)
  await writeFile(path.join(WORKFLOW_STORE_DIR, fileName), JSON.stringify(historyItem, null, 2))
  await pruneComfyHistoryCache().catch((error) => {
    console.warn(`ComfyUI history cache cleanup skipped: ${error.message || error}`)
  })
}

async function readCachedHistory(jobId, promptId) {
  try {
    const fileName = sanitizeFileName(`comfyui-${jobId}-${promptId}.json`)
    return JSON.parse(await readFile(path.join(WORKFLOW_STORE_DIR, fileName), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function pruneComfyHistoryCache(limit = COMFYUI_HISTORY_CACHE_LIMIT) {
  if (!Number.isFinite(limit) || limit <= 0) return { skipped: true, reason: 'disabled' }
  let entries
  try {
    entries = await readdir(WORKFLOW_STORE_DIR, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { deleted: 0, kept: 0 }
    throw error
  }

  const histories = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^comfyui-.+\.json$/i.test(entry.name)) continue
    const localPath = path.join(WORKFLOW_STORE_DIR, entry.name)
    try {
      const info = await stat(localPath)
      histories.push({ localPath, name: entry.name, mtimeMs: info.mtimeMs })
    } catch {
      // Ignore files that disappear during cleanup; the cache is opportunistic.
    }
  }

  if (histories.length <= limit) return { deleted: 0, kept: histories.length }
  const { stale } = selectComfyHistoryCacheEntries(histories, limit)
  await Promise.all(stale.map((item) => unlink(item.localPath).catch(() => {})))
  return { deleted: stale.length, kept: Math.min(histories.length, limit) }
}

export function selectComfyHistoryCacheEntries(entries, limit = COMFYUI_HISTORY_CACHE_LIMIT) {
  const safeEntries = Array.isArray(entries) ? entries : []
  if (!Number.isFinite(limit) || limit <= 0) {
    return { keep: safeEntries, stale: [] }
  }
  const sorted = [...safeEntries].sort((a, b) => b.mtimeMs - a.mtimeMs || String(b.name || '').localeCompare(String(a.name || '')))
  return {
    keep: sorted.slice(0, limit),
    stale: sorted.slice(limit),
  }
}

async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30000,
  context = '请求 ComfyUI',
  retries = method === 'GET' ? 2 : 0,
} = {}) {
  const response = await fetchWithRetry(url, {
    method,
    headers,
    body,
    timeoutMs,
    context,
    retries,
  })
  const text = await response.text()
  const payload = text ? parseJsonPayload(text, context) : {}
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error?.message || payload?.error || `${context}失败：HTTP ${response.status}`), {
      status: response.status,
      detail: payload,
      endpoint: scrubComfyEndpoint(url),
      recoverable: isRecoverableComfyStatus(response.status),
    })
  }
  return payload
}

async function fetchWithRetry(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30000,
  retries = 0,
  context = '请求 ComfyUI',
} = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      })
      if (response.ok || attempt >= retries || !isRetryableStatus(response.status)) return response
      lastError = Object.assign(new Error(`${context}失败：HTTP ${response.status}`), {
        status: response.status,
        endpoint: scrubComfyEndpoint(url),
        recoverable: isRecoverableComfyStatus(response.status),
      })
    } catch (error) {
      lastError = normalizeComfyFetchError(error, context, url)
      if (attempt >= retries || !isTransientComfyError(error)) throw lastError
    } finally {
      clearTimeout(timeout)
    }
    await delay(Math.min(6000, 700 * (attempt + 1)))
  }
  throw lastError || new Error(`${context}失败。`)
}

function parseJsonPayload(text, context) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw Object.assign(new Error(`${context}返回了无法解析的 JSON。`), {
      cause: error,
      detail: text.slice(0, 240),
    })
  }
}

export function normalizeComfyFetchError(error, context = '请求 ComfyUI', url = COMFYUI_BASE_URL) {
  const endpoint = scrubComfyEndpoint(url)
  if (error?.name === 'AbortError') {
    return Object.assign(new Error(`${context}超时，任务已保留 ComfyUI prompt_id；请稍后点击“诊断远端”或“续接输出”拉取 GLB。`), {
      cause: error,
      endpoint,
      recoverable: true,
    })
  }
  const reason = error?.cause?.code || error?.code || error?.message || '网络请求失败'
  return Object.assign(new Error(`${context}失败：${reason}。请确认 3D 服务仍可访问，稍后可点击“诊断远端”或“续接输出”恢复任务。`), {
    cause: error,
    endpoint,
    recoverable: isTransientComfyError(error),
  })
}

export function isTransientComfyError(error) {
  const message = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(' ')
  return Boolean(error?.recoverable) || /AbortError|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|network|socket|terminated|other side closed|Empty reply|超时|timeout|COMFYUI_EMPTY_STATUS|HTTP 502|HTTP 503|HTTP 504|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(message)
}

export function classifyComfyServiceError(error) {
  const message = [
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(' ')

  if (/COMFYUI_EMPTY_STATUS|other side closed|Empty reply|terminated|UND_ERR_SOCKET|socket/i.test(message)) {
    return {
      state: 'cold_starting',
      recoverable: true,
      message: '自部署 3D 服务正在冷启动或刚从 OOM 重启恢复，稍后会自动重试。',
    }
  }

  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|AbortError|fetch failed|network/i.test(message)) {
    return {
      state: 'unreachable',
      recoverable: true,
      message: '自部署 3D 服务暂时不可达，任务可保留并稍后续接。',
    }
  }

  if (/HTTP 502|HTTP 503|HTTP 504|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(message)) {
    return {
      state: 'unreachable',
      recoverable: true,
      message: '自部署 3D 网关暂时返回异常，任务会保留并稍后自动续接。',
    }
  }

  return {
    state: 'error',
    recoverable: Boolean(error?.recoverable),
    message: '自部署 3D 服务状态异常，请查看诊断信息。',
  }
}

export const COMFYUI_DIAGNOSTIC_LIMITS = Object.freeze({
  queueTimeoutMs: 5000,
  historyTimeoutMs: 7000,
  retries: 0,
})

export const COMFYUI_STATUS_LIMITS = Object.freeze({
  systemStatsTimeoutMs: 6000,
  queueTimeoutMs: 6000,
  retries: 0,
})

export const COMFYUI_MEMORY_RELEASE = Object.freeze({
  enabled: COMFYUI_FREE_AFTER_JOB,
  timeoutMs: COMFYUI_FREE_TIMEOUT_MS,
  historyCacheLimit: COMFYUI_HISTORY_CACHE_LIMIT,
})

export const COMFYUI_RESOURCE_LIMITS = Object.freeze({
  enabled: COMFYUI_RESOURCE_GUARD,
  minRamFreeGb: COMFYUI_MIN_RAM_FREE_GB,
  minVramFreeGb: COMFYUI_MIN_VRAM_FREE_GB,
  hy3dpaintEnabled: COMFYUI_HY3DPAINT_ENABLED,
  hy3dpaintMinRamFreeGb: COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB,
  hy3dpaintMinTotalRamGb: COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
  hy3dpaintLowMemoryTotalRamGb: COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
  hy3dpaintLowMemoryRemoteEnabled: COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED,
  hy3dpaintFullRetryOnTimeout: COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT,
  hy3dpaintFullWorkflowFirst: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
  hy3dpaintMinVramFreeGb: COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB,
  hy3dpaintRuntimeMinRamFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB,
  hy3dpaintRuntimeMinVramFreeGb: COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB,
  hy3dpaintRuntimeGuardGracePolls: COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS,
  hy3dpaintRuntimeFallbackBackoffCount: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT,
  hy3dpaintRuntimeFallbackBackoffMs: COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS,
  hy3dpaintAbortOnUnobservable: COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE,
  hy3dpaintPollIntervalMs: COMFYUI_HY3DPAINT_POLL_INTERVAL_MS,
  hy3dpaintSteps: COMFYUI_HY3DPAINT_STEPS,
  hy3dpaintFaces: COMFYUI_HY3DPAINT_FACES,
  hy3dpaintGuidanceScale: COMFYUI_HY3DPAINT_GUIDANCE_SCALE,
  hy3dpaintFullWorkflowSteps: COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS,
  hy3dpaintFullWorkflowFaces: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES,
  hy3dpaintFullWorkflowGuidanceScale: COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE,
  hy3dpaintStableSteps: COMFYUI_HY3DPAINT_STABLE_STEPS,
  hy3dpaintStableFaces: COMFYUI_HY3DPAINT_STABLE_FACES,
  hy3dpaintStableGuidanceScale: COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE,
  hy3dpaintExistingMeshWorkflowTemplate: COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE,
  hy3dpaintAutoFallback: COMFYUI_HY3DPAINT_AUTO_FALLBACK,
  hy3dpaintStaleHistoryLimit: COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
  hy3dpaintUnobservableRecoveryLimit: COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
  maxLocalPending: COMFYUI_LOCAL_QUEUE_MAX_PENDING,
  blockWhenRemoteBusy: COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
  preflightFreeBeforeGuard: COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD,
  historyCacheLimit: COMFYUI_HISTORY_CACHE_LIMIT,
  steps: COMFYUI_STEPS,
  faces: COMFYUI_FACES,
  guidanceScale: COMFYUI_GUIDANCE_SCALE,
})

export const COMFYUI_OUTPUT_SETTLE_LIMITS = Object.freeze({
  emptyOutputRetryLimit: COMFYUI_EMPTY_OUTPUT_RETRY_LIMIT,
  staleHistoryLimit: COMFYUI_STALE_HISTORY_LIMIT,
  historyRecoveryLimit: COMFYUI_HISTORY_RECOVERY_LIMIT,
  historyPollTimeoutMs: COMFYUI_HISTORY_POLL_TIMEOUT_MS,
  queuePollTimeoutMs: COMFYUI_QUEUE_POLL_TIMEOUT_MS,
  unobservableRecoveryLimit: COMFYUI_UNOBSERVABLE_RECOVERY_LIMIT,
  hy3dpaintStaleHistoryLimit: COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
  hy3dpaintUnobservableRecoveryLimit: COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
})

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function isRecoverableComfyStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 502 || status === 503 || status === 504
}

export function scrubComfyEndpoint(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return String(url).split('?')[0]
  }
}

function accentForTemplate(template) {
  const accents = {
    'plant-cell': '#7fb069',
    'animal-cell': '#e8859a',
    'white-blood-cell': '#c8a2d8',
    neuron: '#f0a868',
    dna: '#9cc4e4',
    mitochondrion: '#d8844c',
    chloroplast: '#6fa55d',
    bacterium: '#5b9aa8',
  }
  return accents[template] || '#7fb069'
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function summarizeSystemMemory(system) {
  if (!system || typeof system !== 'object') return null
  const candidates = [
    {
      total: system.ram_total,
      free: system.ram_free,
      available: system.ram_available,
    },
    {
      total: system.total_ram,
      free: system.free_ram,
      available: system.available_ram,
    },
    {
      total: system.memory_total,
      free: system.memory_free,
      available: system.memory_available,
    },
  ]

  const picked = candidates.find((item) => [item.total, item.free, item.available].some((value) => Number.isFinite(Number(value))))
  if (!picked) return null
  return {
    total: normalizeMemoryBytes(picked.total),
    free: normalizeMemoryBytes(picked.free),
    available: normalizeMemoryBytes(picked.available),
  }
}

function normalizeMemoryBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return number < 1024 * 1024 ? number * 1024 * 1024 : number
}

function bytesToGiB(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return Number.NaN
  return number / 1024 / 1024 / 1024
}

function formatGiB(value) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}GB`
}
