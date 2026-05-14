import http from 'node:http'
import {
  API_HOST,
  API_PORT,
  CELLFORGE_MODEL_DIR,
  LOCAL_MODEL_DIR,
  TENCENT_HUNYUAN_CONFIGURED,
  WORKFLOW_STORE_DIR,
} from './server/config.mjs'
import { readJsonBody, sendJson, setCorsHeaders } from './server/http-utils.mjs'
import { createWorkflowJob, getWorkflowJob, listWorkflowJobs } from './server/job-store.mjs'
import { getDemoModels, importLocalModel, serveDemoModel, serveLocalModel } from './server/model-store.mjs'
import { startWorkflowJob } from './server/workflow-runner.mjs'

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
        cellforgeModelDir: CELLFORGE_MODEL_DIR,
        workflowStoreDir: WORKFLOW_STORE_DIR,
        providers: {
          demo: true,
          localGlb: true,
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

    if (request.method === 'POST' && url.pathname === '/api/workflows/text-to-cell') {
      const job = await createWorkflowJob(await readJsonBody(request))
      startWorkflowJob(job)
      sendJson(response, 202, { job })
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
