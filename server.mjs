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
} from './server/config.mjs'
import { readJsonBody, sendJson, setCorsHeaders } from './server/http-utils.mjs'
import { createWorkflowJob, getWorkflowJob, listWorkflowJobs } from './server/job-store.mjs'
import { getDemoModels, importLocalModel, serveDemoModel, serveLocalModel } from './server/model-store.mjs'
import { startFullTextTo3dWorkflow, startWorkflowJob } from './server/workflow-runner.mjs'
import { appendAnalyticsEvents } from './server/analytics-store.mjs'
import { getComfyUiStatus } from './server/comfyui-provider.mjs'
import {
  createReferenceImage,
  getLocalImageGatewayStatus,
  getReferenceImageStatus,
  getOpenAiProviderStatus,
  importReferenceImage,
  previewReferencePrompt,
  serveReferenceImage,
} from './server/reference-store.mjs'

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
        comfyuiBaseUrl: COMFYUI_BASE_URL,
        comfyuiWorkflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
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
      sendJson(response, 200, {
        image: {
          localGateway: await getLocalImageGatewayStatus({ check }),
          openai: await getOpenAiProviderStatus({ check }),
        },
        model3d: {
          selfhostTriposg: {
            configured: true,
            baseUrl: COMFYUI_BASE_URL,
            workflowTemplate: COMFYUI_WORKFLOW_TEMPLATE,
            status: check ? await getComfyUiStatus() : undefined,
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
      const job = await createWorkflowJob({
        prompt: sourcePrompt.length >= 6 ? sourcePrompt : `${sourcePrompt} 3D-ready 生物教学模型`,
        provider: input.provider || 'selfhost-triposg',
        imageProvider: input.imageProvider,
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
})
