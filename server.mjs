import http from 'node:http'
import './server/env-loader.mjs'
import {
  API_HOST,
  API_PORT,
  CELLFORGE_MODEL_DIR,
  COMFYUI_BASE_URL,
  COMFYUI_WORKFLOW_TEMPLATE,
  LOCAL_MODEL_DIR,
  LOCAL_IMAGE_GATEWAY_CONFIGURED,
  OPENAI_IMAGE_CONFIGURED,
  REFERENCE_CACHE_DIR,
  REFERENCE_TRASH_DIR,
  REFERENCE_WORK_DIR,
  TENCENT_HUNYUAN_CONFIGURED,
  UPLOAD_CACHE_DIR,
  UPLOAD_TRASH_DIR,
  UPLOAD_WORK_DIR,
  WORKFLOW_STORE_DIR,
  COMFYUI_FACES,
  COMFYUI_HISTORY_CACHE_LIMIT,
  COMFYUI_GUIDANCE_SCALE,
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
  COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED,
  COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB,
  COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB,
  COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB,
  COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB,
  COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE,
  COMFYUI_HY3DPAINT_POLL_INTERVAL_MS,
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
  COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
  COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE,
  COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
  COMFYUI_LOCAL_QUEUE_MAX_PENDING,
  COMFYUI_MIN_RAM_FREE_GB,
  COMFYUI_MIN_VRAM_FREE_GB,
  COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD,
  COMFYUI_RESOURCE_GUARD,
  COMFYUI_STEPS,
} from './server/config.mjs'
import { readJsonBody, sendJson, setCorsHeaders } from './server/http-utils.mjs'
import {
  WORKFLOW_STORE_RETENTION,
  createTextureEnhancementJob,
  createWorkflowJob,
  getWorkflowJob,
  listRecoverableWorkflowJobs,
  listWorkflowJobs,
} from './server/job-store.mjs'
import { getDemoModels, importLocalModel, serveDemoModel, serveLocalModel } from './server/model-store.mjs'
import {
  getWorkflowRuntimeStatus,
  resumeSelfhostWorkflowJob,
  resumeWorkflowJob,
  startFullTextTo3dWorkflow,
  startTextureEnhancementJob,
  startWorkflowJob,
} from './server/workflow-runner.mjs'
import { appendAnalyticsEvents } from './server/analytics-store.mjs'
import { diagnoseComfyUiJob, getComfyUiStatus } from './server/comfyui-provider.mjs'
import { getTextureArtifactStatus } from './server/texture-artifacts.mjs'
import { readLatestConsecutiveStabilityReport, readLatestStabilityReport, runTextureStabilityCheck } from './scripts/texture-stability-check.mjs'
import {
  assertLocalGatewayImageRouteReady,
  createReferenceImage,
  getLocalImageGatewayStatus,
  getReferenceImageStatus,
  getOpenAiProviderStatus,
  importReferenceImage,
  previewReferencePrompt,
  serveReferenceImage,
} from './server/reference-store.mjs'

let textureStabilityRunPromise = null

const server = http.createServer(async (request, response) => {
  try {
    setCorsHeaders(response)

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    const url = new URL(request.url, `http://${request.headers.host}`)

    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'LearningCell fusion API',
        localModelDir: LOCAL_MODEL_DIR,
        uploadWorkDir: UPLOAD_WORK_DIR,
        uploadCacheDir: UPLOAD_CACHE_DIR,
        uploadTrashDir: UPLOAD_TRASH_DIR,
        referenceWorkDir: REFERENCE_WORK_DIR,
        referenceCacheDir: REFERENCE_CACHE_DIR,
        referenceTrashDir: REFERENCE_TRASH_DIR,
        cellforgeModelDir: CELLFORGE_MODEL_DIR,
        workflowStoreDir: WORKFLOW_STORE_DIR,
        workflowStoreRetention: WORKFLOW_STORE_RETENTION,
        comfyuiBaseUrl: COMFYUI_BASE_URL,
        comfyuiWorkflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
        runtime: getWorkflowRuntimeStatus(),
        providers: {
          localCache: true,
          localGlb: true,
          localImageGateway: await getLocalImageGatewayStatus({ check: false }),
          openai: await getOpenAiProviderStatus({ check: false }),
          openaiImage: OPENAI_IMAGE_CONFIGURED,
          localImageGatewayImage: LOCAL_IMAGE_GATEWAY_CONFIGURED,
          selfhostTriposg: true,
          tencentHunyuan: TENCENT_HUNYUAN_CONFIGURED,
        },
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/3d/demo-models') {
      sendJson(response, 200, { models: await getDemoModels() })
      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/3d/demo-model/')) {
      await serveDemoModel(url, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/3d/local-model') {
      sendJson(response, 200, await importLocalModel(request, url))
      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/3d/local-model/')) {
      await serveLocalModel(url, response)
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/providers/status') {
      const check = url.searchParams.get('check') === '1'
      const [localGateway, openai, selfhostStatus] = await Promise.all([
        getLocalImageGatewayStatus({ check }),
        getOpenAiProviderStatus({ check }),
        check ? getComfyUiStatus() : Promise.resolve(undefined),
      ])
      sendJson(response, 200, {
        image: {
          localGateway,
          openai,
        },
        model3d: {
          selfhostTriposg: {
            configured: true,
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
              fullWorkflowFirst: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST,
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
              fullWorkflowSteps: COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS,
              fullWorkflowFaces: COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES,
              fullWorkflowGuidanceScale: COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE,
              stableSteps: COMFYUI_HY3DPAINT_STABLE_STEPS,
              stableFaces: COMFYUI_HY3DPAINT_STABLE_FACES,
              stableGuidanceScale: COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE,
              autoFallback: COMFYUI_HY3DPAINT_AUTO_FALLBACK,
              staleHistoryLimit: COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT,
              unobservableRecoveryLimit: COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT,
            },
            resourceGuard: {
              enabled: COMFYUI_RESOURCE_GUARD,
              minRamFreeGb: COMFYUI_MIN_RAM_FREE_GB,
              minVramFreeGb: COMFYUI_MIN_VRAM_FREE_GB,
              steps: COMFYUI_STEPS,
              faces: COMFYUI_FACES,
              guidanceScale: COMFYUI_GUIDANCE_SCALE,
              maxLocalPending: COMFYUI_LOCAL_QUEUE_MAX_PENDING,
              blockWhenRemoteBusy: COMFYUI_BLOCK_WHEN_REMOTE_BUSY,
              preflightFreeBeforeGuard: COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD,
              historyCacheLimit: COMFYUI_HISTORY_CACHE_LIMIT,
            },
            runtime: getWorkflowRuntimeStatus().selfhost,
            status: selfhostStatus,
          },
          localCache: { configured: true },
          tencentHunyuan: { configured: TENCENT_HUNYUAN_CONFIGURED },
        },
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/references/text-to-image') {
      sendJson(response, 201, { reference: await createReferenceImage(await readJsonBody(request)) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/references/prompt-preview') {
      sendJson(response, 200, { prompt: await previewReferencePrompt(await readJsonBody(request)) })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/references/upload') {
      sendJson(response, 201, { reference: await importReferenceImage(request, url) })
      return
    }

    if (request.method === 'GET' && /^\/api\/references\/[^/]+$/.test(url.pathname)) {
      const referenceId = decodeURIComponent(url.pathname.replace('/api/references/', ''))
      sendJson(response, 200, { reference: await getReferenceImageStatus(referenceId) })
      return
    }

    if (request.method === 'GET' && /^\/api\/references\/[^/]+\/image$/.test(url.pathname)) {
      await serveReferenceImage(url, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/workflows/text-to-cell') {
      const job = await createWorkflowJob(await readJsonBody(request))
      startWorkflowJob(job)
      sendJson(response, 202, { job })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/workflows/full-text-to-3d') {
      const input = await readJsonBody(request)
      const sourcePrompt = String(input.prompt || '')
      const requestedImageProvider = input.imageProvider || (LOCAL_IMAGE_GATEWAY_CONFIGURED ? 'local-gateway' : 'openai')
      if (requestedImageProvider === 'local-gateway') {
        await assertLocalGatewayImageRouteReady({ ignoreRecentFailure: Boolean(input.forceImageRetry) })
      }
      const job = await createWorkflowJob({
        prompt: sourcePrompt.length >= 6 ? sourcePrompt : `${sourcePrompt} 3D-ready 生物教学模型`,
        provider: input.provider || 'selfhost-triposg',
        imageProvider: input.imageProvider,
        imageProfile: input.imageProfile,
        imageSize: input.imageSize,
        imageQuality: input.imageQuality,
        imagePromptOverride: input.imagePromptOverride,
        forceImageRetry: input.forceImageRetry,
        textureMode: input.textureMode,
        template: input.template,
        workflowMode: 'full-text-to-3d',
        deferReference: true,
      })
      startFullTextTo3dWorkflow(job)
      sendJson(response, 202, { reference: null, job })
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/analytics/events') {
      sendJson(response, 202, await appendAnalyticsEvents(await readJsonBody(request)))
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      sendJson(response, 200, { jobs: await listWorkflowJobs(url.searchParams.get('limit') || 20) })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/texture-artifacts') {
      sendJson(response, 200, await getTextureArtifactStatus({
        limit: url.searchParams.get('limit') || 3,
        jobId: url.searchParams.get('job') || '',
      }))
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/texture-stability/latest') {
      const latestReport = await readLatestStabilityReport()
      const latestConsecutiveReport = await readLatestConsecutiveStabilityReport()
      sendJson(response, 200, buildTextureStabilityPayload(latestReport, {
        latestConsecutiveReport,
        running: Boolean(textureStabilityRunPromise),
      }))
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/texture-stability/run') {
      if (textureStabilityRunPromise) {
        sendJson(response, 202, buildTextureStabilityPayload(await readLatestStabilityReport(), {
          latestConsecutiveReport: await readLatestConsecutiveStabilityReport(),
          running: true,
          message: '已有连续贴图验证正在运行；为保护 20GB 服务器，新的验证请求已被串行等待。',
        }))
        return
      }

      const options = normalizeTextureStabilityRequest(await readJsonBody(request))
      textureStabilityRunPromise = runTextureStabilityCheck(options)
      try {
        const report = await textureStabilityRunPromise
        sendJson(response, 200, buildTextureStabilityPayload(report))
      } finally {
        textureStabilityRunPromise = null
      }
      return
    }

    if (request.method === 'POST' && /^\/api\/jobs\/[^/]+\/resume$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.replace(/^\/api\/jobs\//, '').replace(/\/resume$/, ''))
      const job = await getWorkflowJob(jobId)
      const result = await resumeSelfhostWorkflowJob(job)
      sendJson(response, result.resumed ? 202 : 409, {
        ...result,
        job: result.job || job,
        message: result.resumed
          ? '已开始续接本地三维输出。'
          : '该任务当前不能续接，请重新生成参考图或重新建模。',
      })
      return
    }

    if (request.method === 'POST' && /^\/api\/jobs\/[^/]+\/texture-enhance$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.replace(/^\/api\/jobs\//, '').replace(/\/texture-enhance$/, ''))
      const sourceJob = await getWorkflowJob(jobId)
      const input = await readJsonBody(request)
      const job = await createTextureEnhancementJob(sourceJob, input)
      startTextureEnhancementJob(job)
      sendJson(response, 202, {
        job,
        message: job.forceTextureFallback
          ? '已开始原参考图轻量贴图：复用来源任务 raw GLB，不提交远端混元重任务。'
          : '已开始混元贴图后处理：复用来源任务 raw GLB，不重新执行 TripoSG。',
      })
      return
    }

    if (request.method === 'GET' && /^\/api\/jobs\/[^/]+\/diagnostics$/.test(url.pathname)) {
      const jobId = decodeURIComponent(url.pathname.replace(/^\/api\/jobs\//, '').replace(/\/diagnostics$/, ''))
      const job = await getWorkflowJob(jobId)
      if (job.provider !== 'selfhost-triposg') {
        sendJson(response, 409, { error: '只有本地 TripoSG + Hunyuan3D-Paint 任务支持远端诊断。' })
        return
      }
      sendJson(response, 200, { diagnostics: await diagnoseComfyUiJob(job) })
      return
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(url.pathname.replace('/api/jobs/', ''))
      sendJson(response, 200, { job: await getWorkflowJob(jobId) })
      return
    }

    sendJson(response, 404, { error: '接口不存在。' })
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error)
      return
    }

    sendJson(response, error.status || 500, {
      error: error.message || '服务端错误。',
      detail: error.detail,
    })
  }
})

server.listen(API_PORT, API_HOST, () => {
  console.log(`LearningCell fusion API running at http://${API_HOST}:${API_PORT}`)
  console.log(`Local generated model cache: ${LOCAL_MODEL_DIR}`)
  console.log(`3DCellForge demo model source: ${CELLFORGE_MODEL_DIR}`)
  void recoverInterruptedJobs()
})

async function recoverInterruptedJobs() {
  try {
    const jobs = await listRecoverableWorkflowJobs()
    if (!jobs.length) return
    console.log(`Recovering ${jobs.length} unfinished workflow job(s).`)
    for (const job of jobs) {
      const result = await resumeWorkflowJob(job)
      console.log(`Recovery check ${job.id}: ${result.reason}`)
    }
  } catch (error) {
    console.error(`Workflow recovery failed: ${error.message || error}`)
  }
}

function buildTextureStabilityPayload(report, overrides = {}) {
  const summary = report?.summary || null
  const latestConsecutiveSummary = overrides.latestConsecutiveReport?.summary || null
  const message = overrides.message || (summary
    ? summary.dryRun
      ? summary.ok
        ? '贴图链路只读预检通过：来源 raw GLB、参考图和资源闸门可用，未提交贴图任务。'
        : report?.error || summary.resourceMessage || '贴图链路只读预检未通过，请先处理资源闸门。'
      : summary.ok
        ? `连续贴图验证通过：${summary.coloredRuns}/${summary.requestedRuns} 次均产出非白模彩色 GLB。`
        : report?.error || `连续贴图验证未通过：${summary.failedRuns}/${summary.requestedRuns} 次需要复查。`
    : '暂无连续贴图验证报告。')
  return {
    ok: Boolean(summary?.ok),
    running: Boolean(overrides.running),
    generatedAt: report?.finishedAt || report?.createdAt || '',
    summary,
    report: report || null,
    latestConsecutive: latestConsecutiveSummary
      ? {
          generatedAt: overrides.latestConsecutiveReport?.finishedAt || overrides.latestConsecutiveReport?.createdAt || '',
          summary: latestConsecutiveSummary,
          report: overrides.latestConsecutiveReport,
        }
      : null,
    message,
  }
}

function normalizeTextureStabilityRequest(input = {}) {
  const requestedMode = String(input.textureMode || '').trim()
  const allowHeavyHunyuan = input.allowHunyuan === true || input.allowHeavy === true
  const textureMode = requestedMode === 'hunyuan' && allowHeavyHunyuan ? 'hunyuan' : 'fallback-color'
  const maxRuns = textureMode === 'hunyuan' ? 1 : 3
  return {
    runs: clampNumber(input.runs, 1, maxRuns, maxRuns),
    textureMode,
    timeoutMinutes: textureMode === 'hunyuan'
      ? clampNumber(input.timeoutMinutes, 10, 80, 75)
      : clampNumber(input.timeoutMinutes, 1, 10, 5),
    pollMs: clampNumber(input.pollMs, 1000, 10000, 1000),
    cooldownMs: clampNumber(input.cooldownMs, 0, 10000, 1000),
    drainTimeoutMs: clampNumber(input.drainTimeoutMs, 30000, 180000, 60000),
    minRamRecoveryGiB: clampNumber(input.minRamRecoveryGiB, 14, 20, 16.5),
    dryRun: input.dryRun === true,
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}
