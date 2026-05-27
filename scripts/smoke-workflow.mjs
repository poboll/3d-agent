import { readFile } from 'node:fs/promises'

import '../server/env-loader.mjs'

const API_BASE = process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`
const LIVE_OPENAI = process.env.SMOKE_LIVE_OPENAI === '1'
const LIVE_IMAGE_GATEWAY = process.env.SMOKE_LIVE_IMAGE_GATEWAY === '1'
const LIVE_3D = process.env.SMOKE_LIVE_3D === '1'
const FULL_WORKFLOW = process.env.SMOKE_FULL_WORKFLOW === '1'
const REFERENCE_IMAGE = process.env.SMOKE_REFERENCE_IMAGE || 'app/public/images/plant-cell.jpg'
const IMAGE_PROVIDER = process.env.SMOKE_IMAGE_PROVIDER || (LIVE_IMAGE_GATEWAY ? 'local-gateway' : 'openai')

const prompt = process.argv.slice(2).join(' ').trim() || '线粒体开放剖面 3D 教学模型，突出外膜、内膜和嵴'

const report = []

async function main() {
  await step('健康检查', async () => {
    const health = await api('/api/health')
    return {
      service: health.service,
      openaiConfigured: health.providers?.openaiImage,
      localImageGatewayConfigured: health.providers?.localImageGatewayImage,
      comfyuiBaseUrl: health.comfyuiBaseUrl,
    }
  })

  await step('Provider 状态', async () => api('/api/providers/status?check=1'))

  await step('Prompt 预览', async () => {
    const preview = await api('/api/references/prompt-preview', {
      method: 'POST',
      body: { prompt, template: 'auto' },
    })
    return {
      template: preview.prompt?.template,
      model: preview.prompt?.model,
      imagePromptLength: preview.prompt?.imagePrompt?.length || 0,
      first120: `${preview.prompt?.imagePrompt || ''}`.slice(0, 120),
    }
  })

  let reference
  let job
  if (FULL_WORKFLOW) {
    job = await step('完整默认链路任务创建', async () => {
      const payload = await api('/api/workflows/full-text-to-3d', {
        method: 'POST',
        body: {
          prompt,
          template: 'auto',
          imageProvider: IMAGE_PROVIDER,
          provider: LIVE_3D ? 'selfhost-triposg' : 'local-demo',
        },
      })
      return payload.job
    })
  } else if (LIVE_OPENAI || LIVE_IMAGE_GATEWAY) {
    reference = await step(`${IMAGE_PROVIDER} 文生参考图`, async () => {
      const payload = await api('/api/references/text-to-image', {
        method: 'POST',
        body: { prompt, template: 'auto', provider: IMAGE_PROVIDER },
      })
      return payload.reference
    })
  } else {
    reference = await step('上传本地参考图', async () => {
      const file = await readFile(REFERENCE_IMAGE)
      const query = new URLSearchParams({
        fileName: 'smoke-reference.jpg',
        prompt,
        template: 'auto',
      })
      const payload = await api(`/api/references/upload?${query.toString()}`, {
        method: 'POST',
        rawBody: file,
        headers: { 'Content-Type': 'image/jpeg' },
      })
      return payload.reference
    })
  }

  if (!job) {
    const provider = LIVE_3D ? 'selfhost-triposg' : 'local-demo'
    job = await step(`${provider} 建模任务`, async () => {
      const payload = await api('/api/workflows/text-to-cell', {
        method: 'POST',
        body: {
          prompt,
          template: reference.template,
          imageProvider: LIVE_OPENAI || LIVE_IMAGE_GATEWAY ? IMAGE_PROVIDER : 'upload',
          provider,
          referenceId: reference.id,
        },
      })
      return payload.job
    })
  }

  const completed = await step('任务轮询', async () => pollJob(job.id, LIVE_3D || FULL_WORKFLOW ? 7200 : 60))

  await step('GLB 访问检查', async () => {
    const modelUrl = completed.result?.modelUrl
    if (!modelUrl) throw new Error('任务完成但没有 modelUrl')
    const response = await fetch(url(modelUrl))
    if (!response.ok) throw new Error(`GLB 下载失败：${response.status}`)
    const signature = Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('ascii')
    if (signature !== 'glTF') throw new Error(`GLB 文件头异常：${signature}`)
    return {
      modelUrl,
      fileSize: completed.result.fileSize,
      signature,
    }
  })

  console.log(JSON.stringify({ ok: true, mode: { LIVE_OPENAI, LIVE_IMAGE_GATEWAY, LIVE_3D, FULL_WORKFLOW, IMAGE_PROVIDER }, report }, null, 2))
}

async function step(name, fn) {
  const started = Date.now()
  try {
    const result = await fn()
    report.push({ name, ok: true, ms: Date.now() - started, result })
    return result
  } catch (error) {
    report.push({ name, ok: false, ms: Date.now() - started, error: error.message })
    console.error(JSON.stringify({ ok: false, report }, null, 2))
    process.exitCode = 1
    throw error
  }
}

async function pollJob(jobId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    const payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`)
    const job = payload.job
    if (job.status === 'completed') return job
    if (job.status === 'failed') throw new Error(job.error || job.stage || '任务失败')
    await delay(LIVE_3D ? 8000 : 700)
  }
  throw new Error(`任务超时：${jobId}`)
}

async function api(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const response = await fetch(url(path), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: rawBody || (body ? JSON.stringify(body) : undefined),
  })
  const payload = await response.json().catch(async () => ({ error: await response.text() }))
  if (!response.ok || payload.error) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { payload })
  }
  return payload
}

function url(path) {
  if (/^https?:\/\//i.test(path)) return path
  return `${API_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error(error.message)
})
