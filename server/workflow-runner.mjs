import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CELLFORGE_MODEL_DIR,
  COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
  COMFYUI_DRAIN_AFTER_JOB_POLL_MS,
  COMFYUI_DRAIN_AFTER_JOB_TIMEOUT_MS,
  COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD,
  COMFYUI_LOCAL_QUEUE_MAX_PENDING,
  DEFAULT_IMAGE_PROVIDER,
  DEMO_MODELS,
  LOCAL_MODEL_DIR,
  MOCK_WORKFLOW_STEP_DELAY,
  TENCENT_HUNYUAN_CONFIGURED,
} from './config.mjs'
import { sanitizeModelId } from './model-store.mjs'
import { getTemplateDisplayName, isResumableSelfhostWorkflowJob } from './workflow-utils.mjs'
import { updateWorkflowJob } from './job-store.mjs'
import {
  buildColorFallbackModel,
  enhanceComfyUiModelTexture,
  evaluateComfyTextureSubmissionGuard,
  freeComfyUiMemory,
  generateComfyUiModel,
  getComfyUiStatus,
  resumeComfyUiModel,
} from './comfyui-provider.mjs'
import { createReferenceImage } from './reference-store.mjs'

const inMemoryJobs = new Set()
const selfhostQueueState = {
  runningJobId: '',
  queuedJobIds: [],
}
let selfhostQueueTail = Promise.resolve()

export function isTextureResourceFallbackReason(reason = '') {
  const text = String(reason || '')
  return [
    '不会提交 Hunyuan3D-Paint',
    '默认不提交远端贴图',
    '低内存模式',
    'low-memory-remote-disabled',
    '资源保护',
    '运行熔断线',
    '主动中断',
  ].some((keyword) => text.includes(keyword))
}

export function buildTextureCompletionStage(result = {}, mode = 'full') {
  const effectiveMode = result.effectiveTextureMode || result.textureMode
  const fallbackReason = result.textureFallbackReason || ''
  if (effectiveMode === 'hunyuan') {
    return mode === 'enhance'
      ? '混元贴图后处理已完成，全彩模型已写入缓存并加入标本索引。'
      : '图生 3D 与混元贴图后处理已完成，全彩模型已写入缓存并加入标本索引。'
  }
  if (effectiveMode === 'fallback-color') {
    if (/运行熔断线|主动中断/.test(fallbackReason)) {
      return '混元贴图已提交但触发运行硬熔断，已中断远端贴图并生成 Bio3D 轻量贴图 fallback，避免 OOM。'
    }
    return isTextureResourceFallbackReason(fallbackReason)
      ? '20G 资源保护已按预期跳过远端混元贴图重任务，已生成 Bio3D 轻量贴图 fallback 并写入标本索引。'
      : '混元贴图未产出 textured GLB，已自动生成 Bio3D 轻量贴图 fallback 并写入标本索引。'
  }
  return mode === 'enhance'
    ? '混元贴图未完整返回，已保留可用几何模型并写入标本索引。'
    : '图生 3D 已完成，混元贴图未完整返回，当前展示稳定几何模型。'
}

export function getWorkflowRuntimeStatus() {
  return {
    inMemoryJobs: inMemoryJobs.size,
    selfhost: {
      running: selfhostQueueState.runningJobId ? 1 : 0,
      pending: selfhostQueueState.queuedJobIds.length,
      maxPending: COMFYUI_LOCAL_QUEUE_MAX_PENDING,
      blockWhenRemoteBusy: COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
      runningJobId: selfhostQueueState.runningJobId || undefined,
      pendingJobIds: selfhostQueueState.queuedJobIds.slice(0, 4),
    },
  }
}

export function startWorkflowJob(job) {
  if (inMemoryJobs.has(job.id)) return
  inMemoryJobs.add(job.id)

  void executeWorkflowJob(job).catch((error) => {
    return updateWorkflowJob(
      job.id,
      buildWorkflowFailurePatch(job, error, '本地生成工作流执行失败。'),
      'failed'
    )
  }).finally(() => inMemoryJobs.delete(job.id))
}

export function startTextureEnhancementJob(job) {
  if (inMemoryJobs.has(job.id)) return
  inMemoryJobs.add(job.id)

  void runTextureEnhancementWorkflow(job).catch((error) => {
    return updateWorkflowJob(
      job.id,
      buildWorkflowFailurePatch(job, error, '混元贴图后处理失败，原稳定几何模型仍可继续使用。', '混元贴图后处理暂未完成。'),
      'texture-enhance-failed'
    )
  }).finally(() => inMemoryJobs.delete(job.id))
}

function isFallbackOnlyTextureJob(job = {}) {
  return job.forceTextureFallback || job.textureMode === 'fallback-color' || job.requestedTextureMode === 'fallback-color'
}

export function startFullTextTo3dWorkflow(job) {
  if (inMemoryJobs.has(job.id)) return
  inMemoryJobs.add(job.id)

  void runFullTextTo3dWorkflow(job).catch((error) => {
    return updateWorkflowJob(
      job.id,
      buildWorkflowFailurePatch(job, error, '参考图生成或三维建模失败。', '完整生成链路失败。'),
      'full-workflow-failed'
    )
  }).finally(() => inMemoryJobs.delete(job.id))
}

export async function resumeWorkflowJob(job) {
  if (!job || (job.status === 'completed' && !isResumableSelfhostWorkflowJob(job)) || job.status === 'failed') return { resumed: false, reason: 'not-recoverable' }
  if (inMemoryJobs.has(job.id)) return { resumed: false, reason: 'already-running' }

  if (job.provider === 'selfhost-triposg' && job.providerJobId) {
    inMemoryJobs.add(job.id)
    void runResumedSelfHostedWorkflow(job)
      .catch((error) => {
        if (canRestartSelfhostAfterMissingHistory(job, error)) {
          return restartSelfhostFromCachedReference(job, error, 'auto-recover-selfhost-restart')
        }
        return updateWorkflowJob(
          job.id,
          buildWorkflowFailurePatch(job, error, '无法根据 ComfyUI prompt_id 续接任务。', '续接本地三维任务失败。'),
          'resume-selfhost-failed'
        )
      })
      .finally(() => inMemoryJobs.delete(job.id))
    return { resumed: true, reason: 'selfhost-prompt-id' }
  }

  if (job.workflowMode === 'full-text-to-3d' && !job.referenceId) {
    startFullTextTo3dWorkflow(job)
    return { resumed: true, reason: 'full-text-to-3d' }
  }

  if (job.referenceId) {
    startWorkflowJob(job)
    return { resumed: true, reason: 'image-to-3d' }
  }

  await updateWorkflowJob(
    job.id,
    {
      status: 'failed',
      progress: 100,
      stage: '任务恢复失败：没有可复用的参考图，请重新生成参考图后再提交建模。',
      error: '缺少 referenceId，无法恢复图生 3D 任务。',
    },
    'resume-missing-reference'
  )
  return { resumed: false, reason: 'missing-reference' }
}

export async function resumeSelfhostWorkflowJob(job) {
  if (!isResumableSelfhostWorkflowJob(job)) return { resumed: false, reason: 'not-selfhost-resumable' }
  if (inMemoryJobs.has(job.id)) return { resumed: false, reason: 'already-running' }

  const nextJob = await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: Math.max(job.progress || 0, 58),
      stage: '正在续接本地三维输出：按 ComfyUI prompt_id 拉取 history 与 GLB，不重新生成参考图。',
      error: undefined,
    },
    'manual-resume-selfhost-started'
  )

  inMemoryJobs.add(nextJob.id)
    void runResumedSelfHostedWorkflow(nextJob)
      .catch((error) => {
        if (canRestartSelfhostAfterMissingHistory(nextJob, error)) {
          return restartSelfhostFromCachedReference(nextJob, error)
        }
        return updateWorkflowJob(
          nextJob.id,
          buildWorkflowFailurePatch(
            nextJob,
            error,
            '无法根据 ComfyUI prompt_id 续接任务。',
            nextJob.providerJobId ? '手动续接暂未拿到 GLB，任务仍可稍后继续诊断或续接。' : '手动续接本地三维任务失败。'
          ),
          'manual-resume-selfhost-failed'
        )
    })
    .finally(() => inMemoryJobs.delete(nextJob.id))

  return { resumed: true, reason: 'selfhost-prompt-id', job: nextJob }
}

async function restartSelfhostFromCachedReference(job, resumeError, eventPrefix = 'manual-resume-selfhost-restart') {
  const fallbackJob = await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: Math.max(job.progress || 0, 60),
      stage: '远端 history 已清理，正在复用已确认参考图重新提交本地 3D；不会重新生成参考图。',
      error: undefined,
      // Keep the last prompt_id visible until ComfyUI accepts a new one; this preserves diagnostics if the remote is still cold-starting.
      lastProviderJobId: job.providerJobId,
      restartFromReferenceAttempted: true,
      resumeError: resumeError.message || 'history missing',
    },
    `${eventPrefix}-from-reference`
  )

  try {
    return await runSelfHostedWorkflow(fallbackJob)
  } catch (error) {
    return updateWorkflowJob(
      fallbackJob.id,
      buildWorkflowFailurePatch(fallbackJob, error, '重新提交本地三维任务失败。', '重新提交本地 3D 暂未完成。'),
      `${eventPrefix}-failed`
    )
  }
}

export function canRestartSelfhostAfterMissingHistory(job, error) {
  if (!job?.referenceId || job.provider !== 'selfhost-triposg') return false
  if (job.restartFromReferenceAttempted) return false
  return /history.*(暂未发现|没有返回|暂未返回|missing|清理)|队列已为空|未发现 GLB|history 已返回，但暂未发现 GLB/i.test(error?.message || '')
}

function buildWorkflowFailurePatch(job, error, fallbackError, fallbackStage = '生成任务失败。') {
  const isRecoverableSelfhost =
    job?.provider === 'selfhost-triposg' &&
    (error?.recoverable || /ComfyUI|history|队列|超时|timeout|续接|GLB/i.test(error?.message || ''))

  return {
    status: 'failed',
    progress: isRecoverableSelfhost ? Math.max(job?.progress || 0, 88) : 100,
    stage: isRecoverableSelfhost
      ? '远端三维输出暂未完成，本地任务已保留 prompt_id，可稍后诊断或续接。'
      : fallbackStage,
    error: error?.message || fallbackError,
  }
}

async function runFullTextTo3dWorkflow(job) {
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 8,
      stage: '正在将生物结构描述打磨成 3D-ready 单图 prompt。',
    },
    'full-workflow-prompt-started'
  )

  const reference = await createReferenceImage({
    prompt: job.prompt,
    template: job.template,
    provider: job.imageProvider || DEFAULT_IMAGE_PROVIDER,
    imageProfile: job.imageProfile,
    imageSize: job.imageSize,
    imageQuality: job.imageQuality,
    imagePromptOverride: job.imagePromptOverride,
    forceImageRetry: job.forceImageRetry,
    onProgress: async ({ progress, stage, eventName, patch = {} }) => {
      await updateWorkflowJob(
        job.id,
        {
          status: 'processing',
          progress: Math.max(job.progress || 0, progress),
          stage,
          ...patch,
        },
        `full-workflow-${eventName}`
      )
    },
  })

  const nextJob = await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 24,
      stage: '参考图已生成并自动接收，正在接续图生 3D 建模。',
      reference,
      referenceId: reference.id,
      referenceImageUrl: reference.imageUrl,
      imageProfile: reference.imageProfile || job.imageProfile,
      imageSize: reference.imageSize || job.imageSize,
      imageQuality: reference.imageQuality || job.imageQuality,
      textureMode: job.textureMode || 'stable',
    },
    'full-workflow-reference-ready'
  )

  await executeWorkflowJob(nextJob)
}

async function executeWorkflowJob(job) {
  if (job.provider === 'tencent-hunyuan' && !TENCENT_HUNYUAN_CONFIGURED) {
    await updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '腾讯混元生 3D provider 尚未配置，请切换到本地三维生成或本地缓存链路。',
        error: '缺少 TENCENT_SECRET_ID、TENCENT_SECRET_KEY 或 TENCENT_HUNYUAN_3D_ENDPOINT。',
      },
      'provider-not-configured'
    )
    return
  }

  const runner = job.provider === 'selfhost-triposg' ? runSelfHostedWorkflow : runLocalDemoWorkflow
  await runner(job)
}

async function runSelfHostedWorkflow(job) {
  return runExclusiveSelfhost3d(job, async (currentJob) => {
    if (currentJob.textureMode === 'hunyuan') {
      return runTwoStageTextureWorkflow(currentJob)
    }

    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'processing',
        progress: Math.max(currentJob.progress || 0, 28),
        stage: '已进入本地 3D 执行槽，正在准备 TripoSG + Bio3D 稳定工作流。',
      },
      'selfhost-3d-started'
    )

    const result = await generateComfyUiModel(currentJob, async ({ progress, stage, eventName, patch = {} }) => {
      await updateWorkflowJob(
        currentJob.id,
        {
          status: 'processing',
          progress,
          stage,
          ...patch,
        },
        eventName
      )
    })

    const completedStage = result.textureFallbackReason
      ? '混元贴图资源保护已生效，本次已安全降级为稳定几何版并写入标本索引。'
      : result.textureMode === 'hunyuan'
        ? '本地图生 3D 贴图增强已完成，模型已写入缓存并加入标本索引。'
        : '本地图生 3D 稳定几何版已完成，模型已写入缓存并加入标本索引。'

    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'completed',
        progress: 100,
        stage: completedStage,
        textureMode: result.textureMode || currentJob.textureMode,
        effectiveTextureMode: result.textureMode || currentJob.textureMode,
        requestedTextureMode: result.requestedTextureMode || currentJob.requestedTextureMode,
        textureFallbackReason: result.textureFallbackReason,
        result,
      },
      'completed'
    )
  })
}

async function runTwoStageTextureWorkflow(currentJob) {
  await updateWorkflowJob(
    currentJob.id,
    {
      status: 'processing',
      progress: Math.max(currentJob.progress || 0, 28),
      stage: '已进入本地 3D 执行槽，将先生成低面数稳定 raw/final GLB，再单独执行混元贴图后处理，降低 20GB 服务器内存压力。',
      requestedTextureMode: 'hunyuan',
      effectiveTextureMode: 'stable',
    },
    'selfhost-3d-two-stage-started'
  )

  const stableJob = {
    ...currentJob,
    textureMode: 'stable',
    requestedTextureMode: 'hunyuan',
    effectiveTextureMode: 'stable',
  }
  const stableResult = await generateComfyUiModel(stableJob, async ({ progress, stage, eventName, patch = {} }) => {
    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'processing',
        progress: Math.min(78, Math.max(currentJob.progress || 0, progress)),
        stage,
        ...patch,
        requestedTextureMode: 'hunyuan',
        effectiveTextureMode: 'stable',
        textureMode: 'stable',
      },
      eventName
    )
  })

  await updateWorkflowJob(
    currentJob.id,
    {
      status: 'processing',
      progress: 82,
      stage: '低面数稳定图生 3D 已缓存，正在复用 raw GLB 进行混元贴图后处理；若贴图超时或触发熔断会自动生成轻量贴图 fallback。',
      result: stableResult,
      rawModelUrl: stableResult.rawModelUrl,
      rawMeshServerPath: stableResult.rawMeshServerPath,
      providerJobId: stableResult.providerJobId,
      sourceProviderJobId: stableResult.providerJobId,
      requestedTextureMode: 'hunyuan',
      effectiveTextureMode: 'stable',
      textureMode: 'hunyuan',
    },
    'selfhost-3d-stable-stage-completed'
  )

  const textureJob = {
    ...currentJob,
    result: stableResult,
    rawModelUrl: stableResult.rawModelUrl,
    rawMeshServerPath: stableResult.rawMeshServerPath,
    sourceModelUrl: stableResult.sourceModelUrl || stableResult.fallbackModelUrl || stableResult.modelUrl,
    workflowMode: 'texture-enhance',
    sourceJobId: currentJob.id,
    sourceProviderJobId: stableResult.providerJobId,
    textureMode: 'hunyuan',
    requestedTextureMode: 'hunyuan',
    effectiveTextureMode: 'hunyuan',
  }
  const reportTextureProgress = async ({ progress, stage, eventName, patch = {} }) => {
    const mappedProgress = Math.min(96, Math.max(82, Math.round(82 + Math.max(0, progress - 34) * 0.24)))
    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'processing',
        progress: mappedProgress,
        stage,
        ...patch,
        result: stableResult,
        requestedTextureMode: 'hunyuan',
      },
      eventName
    )
  }

  let result
  try {
    result = await runTextureEnhancementOrFallback(textureJob, reportTextureProgress, {
      startProgress: 84,
      fallbackStage: '混元贴图资源仍不安全：本次不会提交 Hunyuan3D-Paint，正在直接生成 Bio3D 轻量贴图 fallback。',
    })
  } catch (error) {
    result = await buildColorFallbackModel(textureJob, error, reportTextureProgress)
  }

    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'completed',
        progress: 100,
        stage: buildTextureCompletionStage(result, 'full'),
      textureMode: result.textureMode || result.effectiveTextureMode || 'hunyuan',
      effectiveTextureMode: result.effectiveTextureMode || result.textureMode || 'stable',
      requestedTextureMode: result.requestedTextureMode || 'hunyuan',
      textureFallbackReason: result.textureFallbackReason,
      providerJobId: result.providerJobId || stableResult.providerJobId,
      sourceProviderJobId: stableResult.providerJobId,
      rawMeshServerPath: result.rawMeshServerPath || stableResult.rawMeshServerPath,
      rawModelUrl: result.rawModelUrl || stableResult.rawModelUrl,
      result,
    },
    'completed'
  )
}

async function runResumedSelfHostedWorkflow(job) {
  return runExclusiveSelfhost3d(job, async (currentJob) => {
    const result = await resumeComfyUiModel(currentJob, async ({ progress, stage, eventName, patch = {} }) => {
      await updateWorkflowJob(
        currentJob.id,
        {
          status: 'processing',
          progress,
          stage,
          ...patch,
        },
        eventName
      )
    })

    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'completed',
        progress: 100,
        stage: buildTextureCompletionStage(result, currentJob.workflowMode === 'texture-enhance' ? 'enhance' : 'full'),
        textureMode: result.textureMode || currentJob.textureMode,
        requestedTextureMode: result.requestedTextureMode || currentJob.requestedTextureMode,
        effectiveTextureMode: result.effectiveTextureMode || result.textureMode || currentJob.effectiveTextureMode,
        textureFallbackReason: result.textureFallbackReason,
        rawModelUrl: result.rawModelUrl || currentJob.rawModelUrl,
        rawMeshServerPath: result.rawMeshServerPath || currentJob.rawMeshServerPath,
        result,
      },
      'resume-selfhost-completed'
    )
  }, { blockRemoteBusy: false })
}

async function runTextureEnhancementWorkflow(job) {
  const fallbackOnly = isFallbackOnlyTextureJob(job)
  return runExclusiveSelfhost3d(job, async (currentJob) => {
    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'processing',
        progress: Math.max(currentJob.progress || 0, 30),
        stage: fallbackOnly
          ? '已进入本地 3D 执行槽，正在把确认参考图嵌入稳定 raw GLB，生成可复现轻量贴图版。'
          : '已进入本地 3D 执行槽，正在复用稳定 raw GLB 进行混元贴图后处理。',
        textureMode: fallbackOnly ? 'fallback-color' : 'hunyuan',
        requestedTextureMode: fallbackOnly ? 'fallback-color' : 'hunyuan',
        effectiveTextureMode: fallbackOnly ? 'fallback-color' : 'hunyuan',
      },
      'selfhost-3d-texture-started'
    )

    const reportProgress = async ({ progress, stage, eventName, patch = {} }) => {
      await updateWorkflowJob(
        currentJob.id,
        {
          status: 'processing',
          progress,
          stage,
          ...patch,
        },
        eventName
      )
    }

    let result
    try {
      result = await runTextureEnhancementOrFallback(currentJob, reportProgress, {
        startProgress: Math.max(currentJob.progress || 0, 36),
        fallbackStage: '混元贴图资源保护已生效：本次不会提交 Hunyuan3D-Paint，正在复用当前稳定 GLB 生成 Bio3D 轻量贴图 fallback。',
      })
    } catch (error) {
      result = await buildColorFallbackModel(currentJob, error, reportProgress)
    }

    await updateWorkflowJob(
      currentJob.id,
      {
        status: 'completed',
        progress: 100,
        stage: buildTextureCompletionStage(result, 'enhance'),
        textureMode: result.textureMode || result.effectiveTextureMode || 'hunyuan',
        effectiveTextureMode: result.effectiveTextureMode || result.textureMode || 'hunyuan',
        requestedTextureMode: result.requestedTextureMode || (fallbackOnly ? 'fallback-color' : 'hunyuan'),
        result,
      },
      'texture-enhance-completed'
    )
  }, { blockRemoteBusy: !fallbackOnly, skipRemoteCleanup: fallbackOnly })
}

async function runTextureEnhancementOrFallback(job, reportProgress, options = {}) {
  if (isFallbackOnlyTextureJob(job)) {
    const fallbackReason = Object.assign(
      new Error('连续稳定验证默认不提交远端贴图重任务，直接把确认参考图嵌入稳定 Bio3D final。'),
      {
        status: 200,
        recoverable: true,
        code: 'BIO3D_FORCE_COLOR_FALLBACK',
      }
    )
    await reportProgress?.({
      progress: options.startProgress ?? 84,
      stage: '连续稳定验证正在执行原参考图轻量贴图：跳过 Hunyuan3D-Paint，避免 20G 环境被贴图重任务挤爆。',
      eventName: 'selfhost-3d-texture-forced-fallback',
      patch: {
        textureMode: 'fallback-color',
        requestedTextureMode: 'fallback-color',
        effectiveTextureMode: 'fallback-color',
        textureFallbackReason: fallbackReason.message,
      },
    })
    return buildColorFallbackModel(job, fallbackReason, reportProgress)
  }

  let status = await getComfyUiStatus()
  let guard = evaluateComfyTextureSubmissionGuard(status)
  if (
    !guard.ok &&
    COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD &&
    (guard.reason === 'ram-low' || guard.reason === 'vram-low')
  ) {
    await reportProgress?.({
      progress: Math.max(36, (options.startProgress ?? 84) - 2),
      stage: `${guard.message}；正在先释放 ComfyUI 缓存并复查一次，仍不安全才转轻量贴图 fallback。`,
      eventName: 'selfhost-3d-texture-preflight-free',
    })
    await freeComfyUiMemory()
    status = await getComfyUiStatus()
    guard = evaluateComfyTextureSubmissionGuard(status)
  }
  if (!guard.ok && guard.autoFallback) {
    const guardError = Object.assign(new Error(guard.message), {
      status: 503,
      recoverable: true,
      code: 'COMFYUI_HY3DPAINT_PREFLIGHT_FALLBACK',
      detail: guard,
    })
    await reportProgress?.({
      progress: options.startProgress ?? 84,
      stage: options.fallbackStage || guard.message,
      eventName: 'selfhost-3d-texture-preflight-fallback',
      patch: {
        textureMode: 'fallback-color',
        requestedTextureMode: 'hunyuan',
        effectiveTextureMode: 'fallback-color',
        textureFallbackReason: guard.message,
      },
    })
    return buildColorFallbackModel(job, guardError, reportProgress)
  }
  return enhanceComfyUiModelTexture(job, reportProgress)
}

async function runExclusiveSelfhost3d(job, work, options = {}) {
  const { blockRemoteBusy = COMFYUI_BLOCK_WHEN_REMOTE_BUSY, skipRemoteCleanup = false } = options
  const jobsAhead = (selfhostQueueState.runningJobId ? 1 : 0) + selfhostQueueState.queuedJobIds.length
  if (selfhostQueueState.queuedJobIds.length >= COMFYUI_LOCAL_QUEUE_MAX_PENDING) {
    const message = `本地 3D 保护队列已满：当前已有 ${selfhostQueueState.queuedJobIds.length} 个等待任务。请等待当前建模完成后再提交，避免远端 ComfyUI 再次 OOM。`
    await updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: Math.max(job.progress || 0, 30),
        stage: '本地 3D 保护队列已满，任务已安全拦截。',
        error: message,
      },
      'selfhost-3d-local-queue-limited'
    )
    throw Object.assign(new Error(message), {
      status: 429,
      recoverable: true,
      code: 'COMFYUI_LOCAL_QUEUE_FULL',
    })
  }

  selfhostQueueState.queuedJobIds.push(job.id)
  let currentJob = job

  if (jobsAhead > 0) {
    currentJob = await updateWorkflowJob(
      job.id,
      {
        status: 'processing',
        progress: Math.max(job.progress || 0, 26),
        stage: `本地 3D 保护队列已接收，前面还有 ${jobsAhead} 个三维任务；系统会按顺序提交，避免远端 GPU 因并发 OOM。`,
      },
      'selfhost-3d-local-queue'
    )
  }

  const execution = selfhostQueueTail.catch(() => {}).then(async () => {
    selfhostQueueState.queuedJobIds = selfhostQueueState.queuedJobIds.filter((id) => id !== job.id)
    selfhostQueueState.runningJobId = job.id
    try {
      if (jobsAhead > 0) {
        currentJob = await updateWorkflowJob(
          job.id,
          {
            status: 'processing',
            progress: Math.max(currentJob.progress || 0, 28),
            stage: '已获得本地 3D 执行槽，开始提交远端 ComfyUI 工作流。',
          },
          'selfhost-3d-local-slot-acquired'
        )
      }
      if (blockRemoteBusy) {
        await ensureRemoteQueueIsIdle(job.id)
      }
      return await work(currentJob)
    } finally {
      if (!skipRemoteCleanup) {
        const cleanup = await freeComfyUiMemory()
        if (cleanup?.ok) {
          console.log(`ComfyUI memory release requested after ${job.id}.`)
        } else if (cleanup && !cleanup.skipped) {
          console.warn(`ComfyUI memory release skipped/failed after ${job.id}: ${cleanup.message || cleanup.reason || 'unknown'}`)
        }
        const drain = await waitForRemoteQueueDrain(job.id)
        if (drain?.ok) {
          console.log(`ComfyUI queue drained after ${job.id}.`)
        } else {
          console.warn(`ComfyUI queue drain timed out after ${job.id}: ${drain?.message || 'unknown'}`)
        }
      }
      if (selfhostQueueState.runningJobId === job.id) selfhostQueueState.runningJobId = ''
    }
  })

  selfhostQueueTail = execution.catch(() => {})
  return execution
}

async function ensureRemoteQueueIsIdle(jobId) {
  const status = await getComfyUiStatus()
  const running = status?.status?.queue?.running ?? status?.queue?.running ?? 0
  const pending = status?.status?.queue?.pending ?? status?.queue?.pending ?? 0
  if (!status?.ok || running > 0 || pending > 0) {
    const message = status?.ok
      ? `远端 ComfyUI 队列仍有 ${running} 个运行 / ${pending} 个等待任务，已暂停提交新的 3D 重任务。`
      : status?.message || '远端 ComfyUI 暂未恢复，已暂停提交新的 3D 重任务。'
    const blockedStage = status?.ok
      ? '远端 3D 队列繁忙，任务已安全拦截。'
      : '远端 3D 服务暂不可观测，任务已保留可续接。'
    const blockedEvent = status?.ok ? 'selfhost-3d-remote-queue-busy' : 'selfhost-3d-remote-unobservable'
    await updateWorkflowJob(
      jobId,
      {
        status: 'failed',
        progress: 88,
        stage: blockedStage,
        error: `${message} 请稍后使用“诊断远端 / 续接输出”，不要重复堆积建模任务。`,
      },
      blockedEvent
    )
    throw Object.assign(new Error(message), {
      status: 503,
      recoverable: true,
      code: status?.ok ? 'COMFYUI_REMOTE_QUEUE_BUSY' : 'COMFYUI_REMOTE_UNOBSERVABLE',
      detail: status,
    })
  }
}

async function waitForRemoteQueueDrain(jobId) {
  const deadline = Date.now() + COMFYUI_DRAIN_AFTER_JOB_TIMEOUT_MS
  let lastSummary = null
  while (Date.now() < deadline) {
    const status = await getComfyUiStatus()
    const running = status?.status?.queue?.running ?? status?.queue?.running ?? 0
    const pending = status?.status?.queue?.pending ?? status?.queue?.pending ?? 0
    lastSummary = { ok: Boolean(status?.ok), running, pending, message: status?.message }
    if (status?.ok && running === 0 && pending === 0) return { ok: true, ...lastSummary }
    await delay(COMFYUI_DRAIN_AFTER_JOB_POLL_MS)
  }
  return {
    ok: false,
    ...lastSummary,
    message: lastSummary?.ok
      ? `远端队列仍有 ${lastSummary.running} 个运行 / ${lastSummary.pending} 个等待。`
      : lastSummary?.message || `等待远端队列清空超时：${jobId}`,
  }
}

async function runLocalDemoWorkflow(job) {
  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: Math.max(job.progress || 0, 32),
      stage: '已接收确认参考图，正在整理适合图生 3D 的结构描述。',
    },
    'prompt-refined'
  )

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 48,
      stage: '参考图预处理已完成，正在提交本地缓存建模链路。',
    },
    'reference-image-ready'
  )

  const demoModel = pickDemoModel(job.template)
  const sourcePath = await resolveDemoSourcePath(job.template, demoModel)
  await stat(sourcePath)

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 76,
      stage: '正在写入本地 GLB 缓存，准备交给 LearningCell 查看器。',
    },
    'model-caching'
  )

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`generated-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  await copyFile(sourcePath, targetPath)
  const info = await stat(targetPath)

  await delay(Math.round(MOCK_WORKFLOW_STEP_DELAY * 0.6))
  await updateWorkflowJob(
    job.id,
    {
      status: 'completed',
      progress: 100,
      stage: '生成模型已完成，可在标本索引中打开。',
      result: {
        id: `generated-${job.id}`,
        name: `AI 生成：${getTemplateDisplayName(job.template)}`,
        subtitle: '图生 3D 建模结果',
        category: 'AI 生成示意模型',
        accent: accentForTemplate(job.template),
        description: `根据「${job.prompt}」确认参考图后进入本地缓存链路，可用于课堂中快速验证参考图、任务记录、模型缓存与 3D 舞台展示。`,
        fileName: targetName,
        fileSize: info.size,
        imageHint: job.template,
        template: job.template,
        provider: '本地缓存链路',
        referenceImageUrl: job.referenceImageUrl,
        modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
      },
    },
    'completed'
  )
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

function pickDemoModel(template) {
  if (template === 'plant-cell' || template === 'chloroplast') return DEMO_MODELS[0]
  return DEMO_MODELS[1] || DEMO_MODELS[0]
}

async function resolveDemoSourcePath(template, demoModel) {
  if (template === 'chloroplast' || template === 'plant-cell') {
    return path.join(CELLFORGE_MODEL_DIR, DEMO_MODELS[0].fileName)
  }
  const cachedTemplateModel = await findLatestCachedTemplateModel(template)
  if (cachedTemplateModel) return cachedTemplateModel
  return path.join(CELLFORGE_MODEL_DIR, demoModel.fileName)
}

async function findLatestCachedTemplateModel(template) {
  if (!template || template === 'plant-cell' || template === 'animal-cell') return ''

  try {
    const files = await readdir(LOCAL_MODEL_DIR, { withFileTypes: true })
    const candidates = []
    for (const file of files) {
      if (!file.isFile()) continue
      if (!file.name.endsWith(`-${template}.glb`)) continue
      if (!file.name.startsWith('generated-job-')) continue
      const localPath = path.join(LOCAL_MODEL_DIR, file.name)
      const info = await stat(localPath)
      candidates.push({ localPath, mtimeMs: info.mtimeMs })
    }
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.localPath || ''
  } catch {
    return ''
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
