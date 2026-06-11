import { readFile } from 'node:fs/promises'
import path from 'node:path'

import '../server/env-loader.mjs'

const API_BASE = process.env.SMOKE_API_BASE || `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 8791}`
const LIVE_OPENAI = boolEnv('SMOKE_LIVE_OPENAI', 'LIVE_OPENAI')
const LIVE_IMAGE_GATEWAY = boolEnv('SMOKE_LIVE_IMAGE_GATEWAY', 'LIVE_IMAGE_GATEWAY')
const LIVE_3D = boolEnv('SMOKE_LIVE_3D', 'LIVE_3D')
const FULL_WORKFLOW = boolEnv('SMOKE_FULL_WORKFLOW', 'FULL_WORKFLOW')
const REFERENCE_IMAGE = process.env.SMOKE_REFERENCE_IMAGE || 'app/public/images/plant-cell.jpg'
const IMAGE_PROVIDER = process.env.SMOKE_IMAGE_PROVIDER || (LIVE_OPENAI ? 'openai' : 'local-gateway')
const IMAGE_PROFILE = process.env.SMOKE_IMAGE_PROFILE || (LIVE_IMAGE_GATEWAY ? 'fast' : 'standard')
const IMAGE_SIZE = process.env.SMOKE_IMAGE_SIZE || ''
const IMAGE_QUALITY = process.env.SMOKE_IMAGE_QUALITY || ''
const TEXTURE_MODE = process.env.SMOKE_TEXTURE_MODE || 'stable'
const EXPECTED_IMAGE_MODEL = process.env.SMOKE_EXPECT_IMAGE_MODEL || (IMAGE_PROVIDER === 'local-gateway' ? 'gpt-image-2' : '')
const EXPECTED_PROMPT_MODEL = process.env.SMOKE_EXPECT_PROMPT_MODEL || (IMAGE_PROVIDER === 'local-gateway' ? 'gpt-5.5' : '')

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
          textureMode: TEXTURE_MODE,
          ...imageProfileRequest(),
        },
      })
      return payload.job
    })
  } else if (LIVE_OPENAI || LIVE_IMAGE_GATEWAY) {
    reference = await step(`${IMAGE_PROVIDER} 文生参考图`, async () => {
      const payload = await api('/api/references/text-to-image', {
        method: 'POST',
        body: { prompt, template: 'auto', provider: IMAGE_PROVIDER, ...imageProfileRequest() },
      })
      return payload.reference
    })
  } else {
    reference = await step('上传本地参考图', async () => {
      const file = await readFile(REFERENCE_IMAGE)
      const uploadImage = detectUploadImageInfo(file, REFERENCE_IMAGE)
      const query = new URLSearchParams({
        fileName: uploadImage.fileName,
        prompt,
        template: 'auto',
      })
      const payload = await api(`/api/references/upload?${query.toString()}`, {
        method: 'POST',
        rawBody: file,
        headers: { 'Content-Type': uploadImage.contentType },
      })
      return payload.reference
    })
  }

  if (reference) {
    await step('参考图资产检查', async () => inspectReference(reference))
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
          textureMode: provider === 'selfhost-triposg' ? TEXTURE_MODE : 'stable',
          referenceId: reference.id,
          ...imageProfileRequest(),
        },
      })
      return payload.job
    })
  }

  const completed = await step('任务轮询', async () => pollJob(job.id, LIVE_3D || FULL_WORKFLOW ? 7200 : 60))

  if (completed.reference) {
    await step('完成任务参考图检查', async () => inspectReference(completed.reference))
  }

  await step('完整链路断言', async () => assertWorkflowInvariants(completed))

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
      textureMode: completed.result.textureMode,
      effectiveTextureMode: completed.result.effectiveTextureMode,
      signature,
    }
  })

  await step('任务列表恢复检查', async () => {
    const payload = await api('/api/jobs?limit=8')
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : []
    const latest = jobs.find((item) => item.id === completed.id)
    if (!latest) throw new Error(`最近任务列表没有找到完成任务：${completed.id}`)
    if (latest.status !== 'completed') throw new Error(`最近任务状态异常：${latest.status}`)
    if (!latest.result?.modelUrl) throw new Error('最近任务缺少模型结果。')
    if (latest.result.modelUrl !== completed.result?.modelUrl) throw new Error('最近任务模型地址和完成任务不一致。')
    return {
      total: jobs.length,
      id: latest.id,
      workflowMode: latest.workflowMode,
      imageProvider: latest.imageProvider,
      provider: latest.provider,
      textureMode: latest.textureMode,
      effectiveTextureMode: latest.result?.effectiveTextureMode,
      referenceId: latest.referenceId,
      modelUrl: latest.result.modelUrl,
    }
  })

  console.log(JSON.stringify({
    ok: true,
    mode: { LIVE_OPENAI, LIVE_IMAGE_GATEWAY, LIVE_3D, FULL_WORKFLOW, IMAGE_PROVIDER, IMAGE_PROFILE, IMAGE_SIZE, IMAGE_QUALITY, TEXTURE_MODE },
    report,
  }, null, 2))
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

async function inspectReference(reference) {
  if (!reference?.imageUrl) throw new Error('参考图缺少 imageUrl')
  const response = await fetch(url(reference.imageUrl))
  if (!response.ok) throw new Error(`参考图访问失败：${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const head = buffer.subarray(0, 8)
  const png = head.length >= 8 && head[0] === 0x89 && head.subarray(1, 4).toString('ascii') === 'PNG'
  const jpg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  if (!png && !jpg) throw new Error(`参考图格式异常：${head.toString('hex')}`)
  return {
    id: reference.id,
    provider: reference.provider,
    source: reference.source,
    model: reference.model,
    promptModel: reference.promptModel,
    bytes: buffer.byteLength,
    imageUrl: reference.imageUrl,
    imageProfile: reference.imageProfile,
    imageSize: reference.imageSize,
    imageQuality: reference.imageQuality,
    signature: png ? 'PNG' : 'JPEG',
  }
}

function detectUploadImageInfo(buffer, filePath) {
  const head = buffer.subarray(0, 16)
  const sourceName = path.basename(filePath || 'smoke-reference')
  if (isPngHead(head)) return { fileName: ensureImageExtension(sourceName, 'png'), contentType: 'image/png' }
  if (isJpegHead(head)) return { fileName: ensureImageExtension(sourceName, 'jpg'), contentType: 'image/jpeg' }
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { fileName: ensureImageExtension(sourceName, 'webp'), contentType: 'image/webp' }
  }
  return { fileName: ensureImageExtension(sourceName, 'jpg'), contentType: 'image/jpeg' }
}

function ensureImageExtension(fileName, ext) {
  const base = path.basename(fileName || 'smoke-reference').replace(/\.(png|jpe?g|webp)$/i, '') || 'smoke-reference'
  return `${base}.${ext}`
}

function isPngHead(head) {
  return head.length >= 8 && head[0] === 0x89 && head.subarray(1, 4).toString('ascii') === 'PNG'
}

function isJpegHead(head) {
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}

async function assertWorkflowInvariants(job) {
  if (job.status !== 'completed') throw new Error(`任务没有完成：${job.status}`)
  if (!job.result?.modelUrl) throw new Error('任务完成但没有模型地址。')
  if (!job.result?.fileName && !job.result?.modelUrl) throw new Error('任务结果缺少模型文件信息。')

  const expectedProvider = LIVE_3D ? 'selfhost-triposg' : 'local-demo'
  if (job.provider !== expectedProvider) {
    throw new Error(`建模 provider 异常：${job.provider}，期望 ${expectedProvider}`)
  }

  if (FULL_WORKFLOW) {
    if (job.workflowMode !== 'full-text-to-3d') throw new Error(`完整链路模式异常：${job.workflowMode}`)
    if (job.imageProvider !== IMAGE_PROVIDER) throw new Error(`图片 provider 异常：${job.imageProvider}，期望 ${IMAGE_PROVIDER}`)
    if (!job.referenceId || !job.reference?.id) throw new Error('完整链路缺少已缓存参考图。')
    if (job.reference.id !== job.referenceId) throw new Error('referenceId 与 reference.id 不一致。')
    assertReferenceMetadata(job.reference)
  }

  if (TEXTURE_MODE === 'hunyuan') {
    const effective = job.result.effectiveTextureMode || job.result.textureMode || job.textureMode
    if (!['hunyuan', 'fallback-color', 'stable'].includes(effective)) {
      throw new Error(`混元模式返回了未知贴图状态：${effective}`)
    }
  }

  return {
    id: job.id,
    workflowMode: job.workflowMode,
    imageProvider: job.imageProvider,
    provider: job.provider,
    referenceId: job.referenceId,
    referenceProvider: job.reference?.provider,
    referenceModel: job.reference?.model,
    promptModel: job.reference?.promptModel,
    imageProfile: job.reference?.imageProfile || job.imageProfile,
    imageSize: job.reference?.imageSize || job.imageSize,
    imageQuality: job.reference?.imageQuality || job.imageQuality,
    resultTextureMode: job.result?.textureMode,
    resultEffectiveTextureMode: job.result?.effectiveTextureMode,
  }
}

function assertReferenceMetadata(reference) {
  if (reference.provider !== IMAGE_PROVIDER) {
    throw new Error(`参考图 provider 异常：${reference.provider}，期望 ${IMAGE_PROVIDER}`)
  }
  if (EXPECTED_IMAGE_MODEL && !String(reference.model || '').includes(EXPECTED_IMAGE_MODEL)) {
    throw new Error(`参考图模型异常：${reference.model || 'unknown'}，期望包含 ${EXPECTED_IMAGE_MODEL}`)
  }
  if (EXPECTED_PROMPT_MODEL && !String(reference.promptModel || '').includes(EXPECTED_PROMPT_MODEL)) {
    throw new Error(`Prompt 模型异常：${reference.promptModel || 'unknown'}，期望包含 ${EXPECTED_PROMPT_MODEL}`)
  }
  if (IMAGE_PROFILE && reference.imageProfile !== IMAGE_PROFILE) {
    throw new Error(`参考图 profile 异常：${reference.imageProfile || 'empty'}，期望 ${IMAGE_PROFILE}`)
  }
  if (IMAGE_SIZE && reference.imageSize !== IMAGE_SIZE) {
    throw new Error(`参考图尺寸异常：${reference.imageSize || 'empty'}，期望 ${IMAGE_SIZE}`)
  }
  if (IMAGE_QUALITY && reference.imageQuality !== IMAGE_QUALITY) {
    throw new Error(`参考图质量异常：${reference.imageQuality || 'empty'}，期望 ${IMAGE_QUALITY}`)
  }
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

function boolEnv(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined) continue
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
  }
  return false
}

function imageProfileRequest() {
  return {
    imageProfile: IMAGE_PROFILE,
    ...(IMAGE_SIZE ? { imageSize: IMAGE_SIZE } : {}),
    ...(IMAGE_QUALITY ? { imageQuality: IMAGE_QUALITY } : {}),
  }
}

main().catch((error) => {
  console.error(error.message)
})
