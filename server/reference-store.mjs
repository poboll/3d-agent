import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LOCAL_IMAGE_GATEWAY_API_KEY,
  LOCAL_IMAGE_GATEWAY_BASE_URL,
  LOCAL_IMAGE_GATEWAY_CONFIGURED,
  LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE,
  LOCAL_IMAGE_GATEWAY_HEALTH_ENDPOINT,
  LOCAL_IMAGE_GATEWAY_IMAGE_ENDPOINT,
  LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT,
  LOCAL_IMAGE_GATEWAY_IMAGE_MODEL,
  LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS,
  LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY,
  LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES,
  LOCAL_IMAGE_GATEWAY_IMAGE_SIZE,
  LOCAL_IMAGE_GATEWAY_MODELS_ENDPOINT,
  LOCAL_IMAGE_GATEWAY_PROMPT_MODEL,
  LOCAL_IMAGE_GATEWAY_REASONING_EFFORT,
  LOCAL_IMAGE_GATEWAY_RESPONSES_ENDPOINT,
  LOCAL_IMAGE_GATEWAY_TIMEOUT_MS,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_DISABLE_RESPONSE_STORAGE,
  OPENAI_IMAGE_CONFIGURED,
  OPENAI_IMAGE_ENDPOINT,
  OPENAI_IMAGE_FORMAT,
  OPENAI_IMAGE_MODE,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_QUALITY,
  OPENAI_IMAGE_SIZE,
  OPENAI_IMAGE_TOOL_MODEL,
  OPENAI_ORGANIZATION,
  OPENAI_PROMPT_MODEL,
  OPENAI_PROJECT,
  OPENAI_REASONING_EFFORT,
  OPENAI_RESPONSES_ENDPOINT,
  PROMPT_POLISH_TIMEOUT_MS,
  PROMPT_PREVIEW_TIMEOUT_MS,
  REFERENCE_CACHE_DIR,
  REFERENCE_IMAGE_LIMIT,
  REFERENCE_STORE_FILE,
  REFERENCE_TRASH_DIR,
  REFERENCE_WORK_DIR,
  WORKFLOW_STORE_DIR,
} from './config.mjs'
import { readRawBody, sanitizeFileName } from './http-utils.mjs'
import { chooseTemplateForPrompt, getTemplateDisplayName, normalizeImageProvider, normalizePrompt } from './workflow-utils.mjs'

const PROMPT_TEMPLATE_PATH = path.resolve('server/workflows/bio_3d_ready_prompt_templates.json')
const OPENAI_IMAGE_TIMEOUT_MS = 180000

export async function createReferenceImage(input = {}) {
  const prompt = normalizeReferencePrompt(input.prompt)
  const template = chooseTemplateForPrompt(prompt, input.template)
  const provider = normalizeImageProvider(input.provider)
  const imageOptions = normalizeImageGenerationOptions(input, provider)
  const promptOverride = normalizeImagePromptOverride(input.imagePromptOverride)
  const notify = typeof input.onProgress === 'function' ? input.onProgress : null

  await notifyReferenceProgress(notify, {
    progress: 10,
    stage: '正在构建 3D-ready 单图 prompt。',
    eventName: 'reference-prompt-template-ready',
  })
  const promptPackage = await buildBioReadyPrompt(prompt, template)
  let polishedPromptPackage
  if (promptOverride) {
    polishedPromptPackage = {
      ...promptPackage,
      imagePrompt: promptOverride,
      promptModel: 'user-confirmed',
    }
    await notifyReferenceProgress(notify, {
      progress: 16,
      stage: '已使用用户确认的 3D-ready prompt，跳过再次打磨。',
      eventName: 'reference-prompt-confirmed',
    })
  } else {
    await notifyReferenceProgress(notify, {
      progress: 14,
      stage: '基础 prompt 已生成，正在进行模型打磨。',
      eventName: 'reference-prompt-polish-started',
    })
    polishedPromptPackage = await polishBioReadyPrompt(promptPackage, prompt, {
      provider,
      timeoutMs: PROMPT_POLISH_TIMEOUT_MS,
    })
  }
  await notifyReferenceProgress(notify, {
    progress: 18,
    stage: `已完成 prompt 打磨，正在调用${provider === 'local-gateway' ? '本地图片网关' : 'OpenAI 图片服务'}生成单张参考图。`,
    eventName: 'reference-image-request-started',
    patch: {
      imagePromptPreview: polishedPromptPackage.imagePrompt.slice(0, 220),
      imagePromptModel: polishedPromptPackage.promptModel || 'local-template',
      imageSize: imageOptions.size,
      imageQuality: imageOptions.quality,
    },
  })

  if (provider === 'openai' && !OPENAI_IMAGE_CONFIGURED) {
    throwProviderConfigError({
      providerName: 'OpenAI 图片生成',
      requiredEnv: ['OPENAI_API_KEY'],
      optionalEnv: ['OPENAI_IMAGE_MODEL', 'OPENAI_IMAGE_SIZE', 'OPENAI_IMAGE_QUALITY', 'OPENAI_IMAGE_FORMAT'],
      imagePrompt: polishedPromptPackage.imagePrompt,
    })
  }

  if (provider === 'local-gateway' && !LOCAL_IMAGE_GATEWAY_CONFIGURED) {
    throwProviderConfigError({
      providerName: '本地图片网关',
      requiredEnv: ['LOCAL_IMAGE_GATEWAY_API_KEY'],
      optionalEnv: [
        'LOCAL_IMAGE_GATEWAY_BASE_URL',
        'LOCAL_IMAGE_GATEWAY_PROMPT_MODEL',
        'LOCAL_IMAGE_GATEWAY_IMAGE_MODEL',
        'LOCAL_IMAGE_GATEWAY_IMAGE_SIZE',
      ],
      imagePrompt: polishedPromptPackage.imagePrompt,
    })
  }

  const imageResult =
    provider === 'local-gateway'
      ? await requestLocalGatewayImage(polishedPromptPackage.imagePrompt, imageOptions)
      : await requestOpenAiImage(polishedPromptPackage.imagePrompt, imageOptions)
  await notifyReferenceProgress(notify, {
    progress: 22,
    stage: '参考图已返回，正在写入本地参考图缓存。',
    eventName: 'reference-image-cache-started',
    patch: {
      referenceImageModel: imageResult.model,
      referenceGenerationMode: imageResult.mode,
      referenceImageSize: imageResult.size,
      referenceImageQuality: imageResult.quality,
    },
  })
  const imageExt =
    imageResult.ext ||
    detectImageExtension(imageResult.buffer) ||
    normalizeImageExtension(provider === 'local-gateway' ? LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT : OPENAI_IMAGE_FORMAT)
  const providerLabel = provider === 'local-gateway' ? '本地图片网关' : 'OpenAI GPT Image'
  const saved = await saveReferenceBuffer({
    buffer: imageResult.buffer,
    prompt,
    template,
    provider,
    source: providerLabel,
    title: `${getTemplateDisplayName(template)} · ${provider === 'local-gateway' ? '本地参考图' : 'GPT 参考图'}`,
    note: '已生成适合图生 3D 的单图参考图，请确认主体、剖面和结构间距后再建模。',
    imagePrompt: polishedPromptPackage.imagePrompt,
    negativePrompt: polishedPromptPackage.negativePrompt,
    promptModel: polishedPromptPackage.promptModel,
    model: imageResult.model,
    generationMode: imageResult.mode,
    imageSize: imageResult.size,
    imageQuality: imageResult.quality,
    imageProfile: imageResult.profile,
    ext: imageExt,
  })

  await notifyReferenceProgress(notify, {
    progress: 24,
    stage: '参考图已写入缓存，准备接续图生 3D。',
    eventName: 'reference-image-cache-ready',
    patch: { referenceId: saved.id },
  })

  return publicReference(saved)
}

async function notifyReferenceProgress(callback, { progress, stage, eventName, patch = {} }) {
  if (!callback) return
  await callback({ progress, stage, eventName, patch })
}

function throwProviderConfigError({ providerName, requiredEnv, optionalEnv, imagePrompt }) {
  throw Object.assign(new Error(`${providerName}尚未配置，请在后端环境变量中设置 ${requiredEnv.join('、')}。`), {
    status: 503,
    detail: { requiredEnv, optionalEnv, imagePrompt },
  })
}

export async function getOpenAiProviderStatus({ check = false } = {}) {
  const status = {
    configured: OPENAI_IMAGE_CONFIGURED,
    baseUrl: OPENAI_BASE_URL,
    responsesEndpoint: OPENAI_RESPONSES_ENDPOINT,
    imageEndpoint: OPENAI_IMAGE_ENDPOINT,
    promptModel: OPENAI_PROMPT_MODEL,
    imageModel: OPENAI_IMAGE_MODEL,
    imageToolModel: OPENAI_IMAGE_TOOL_MODEL,
    imageMode: OPENAI_IMAGE_MODE,
    disableResponseStorage: OPENAI_DISABLE_RESPONSE_STORAGE,
  }

  if (!check || !OPENAI_IMAGE_CONFIGURED) return status

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: buildOpenAiHeaders(),
      body: JSON.stringify({
        model: OPENAI_PROMPT_MODEL || OPENAI_IMAGE_MODEL,
        input: 'Return the single word ok.',
        store: !OPENAI_DISABLE_RESPONSE_STORAGE,
        reasoning: { effort: OPENAI_REASONING_EFFORT },
      }),
      signal: controller.signal,
    })
    const payload = await readOpenAiPayload(response)
    return {
      ...status,
      auth: {
        ok: response.ok,
        status: response.status,
        message: response.ok ? 'ok' : extractOpenAiErrorMessage(payload, `OpenAI Responses 接口返回 ${response.status}`),
      },
    }
  } catch (error) {
    return {
      ...status,
      auth: {
        ok: false,
        status: error.name === 'AbortError' ? 504 : 0,
        message: error.name === 'AbortError' ? 'OpenAI 授权检查超时。' : error.message || 'OpenAI 授权检查失败。',
      },
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function getLocalImageGatewayStatus({ check = false } = {}) {
  const status = {
    configured: LOCAL_IMAGE_GATEWAY_CONFIGURED,
    baseUrl: LOCAL_IMAGE_GATEWAY_BASE_URL,
    healthEndpoint: LOCAL_IMAGE_GATEWAY_HEALTH_ENDPOINT,
    modelsEndpoint: LOCAL_IMAGE_GATEWAY_MODELS_ENDPOINT,
    responsesEndpoint: LOCAL_IMAGE_GATEWAY_RESPONSES_ENDPOINT,
    imageEndpoint: LOCAL_IMAGE_GATEWAY_IMAGE_ENDPOINT,
    promptModel: LOCAL_IMAGE_GATEWAY_PROMPT_MODEL,
    imageModel: LOCAL_IMAGE_GATEWAY_IMAGE_MODEL,
    imageModelFallbacks: LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS,
    imageSize: LOCAL_IMAGE_GATEWAY_IMAGE_SIZE,
    imageQuality: LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY,
    timeoutMs: LOCAL_IMAGE_GATEWAY_TIMEOUT_MS,
    disableResponseStorage: LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE,
  }

  if (!check) return status

  const health = await checkGatewayTextEndpoint(LOCAL_IMAGE_GATEWAY_HEALTH_ENDPOINT, {
    method: 'GET',
    headers: LOCAL_IMAGE_GATEWAY_CONFIGURED ? buildLocalGatewayHeaders({ json: false }) : {},
    timeoutMs: 5000,
  })
  const models = LOCAL_IMAGE_GATEWAY_CONFIGURED
    ? await checkGatewayJsonEndpoint(LOCAL_IMAGE_GATEWAY_MODELS_ENDPOINT, {
        method: 'GET',
        headers: buildLocalGatewayHeaders({ json: false }),
        timeoutMs: 12000,
      })
    : { ok: false, status: 0, message: '缺少本地图片网关 API Key。' }

  return {
    ...status,
    health,
    models,
  }
}

export async function previewReferencePrompt(input = {}) {
  const prompt = normalizeReferencePrompt(input.prompt)
  const template = chooseTemplateForPrompt(prompt, input.template)
  const provider = normalizeImageProvider(input.provider)
  const promptPackage = await buildBioReadyPrompt(prompt, template)
  const polishedPromptPackage = await polishBioReadyPrompt(promptPackage, prompt, {
    provider,
    timeoutMs: PROMPT_PREVIEW_TIMEOUT_MS,
  })

  return {
    template,
    sourcePrompt: prompt,
    provider,
    model: polishedPromptPackage.promptModel || 'local-template',
    imagePrompt: polishedPromptPackage.imagePrompt,
    negativePrompt: polishedPromptPackage.negativePrompt,
    qualityChecklist: polishedPromptPackage.qualityChecklist,
  }
}

export async function importReferenceImage(request, url) {
  const fileName = sanitizeFileName(url.searchParams.get('fileName') || 'reference.png', 'reference.png')
  const ext = imageExtensionFromName(fileName)
  const prompt = normalizePrompt(url.searchParams.get('prompt') || `${fileName} 生物 3D 教学参考图`)
  const template = chooseTemplateForPrompt(prompt, url.searchParams.get('template') || 'auto')
  const buffer = await readRawBody(request, REFERENCE_IMAGE_LIMIT)
  validateImageBuffer(buffer, ext)

  const saved = await saveReferenceBuffer({
    buffer,
    prompt,
    template,
    provider: 'upload',
    source: '上传参考图',
    title: trimReferenceTitle(fileName),
    note: '图片已进入参考图缓存，可确认后提交本地图生 3D 服务。',
    imagePrompt: '',
    negativePrompt: '',
    model: 'uploaded-image',
    ext,
  })

  return publicReference(saved)
}

export function normalizeReferencePrompt(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim()
  if (prompt.length < 2) {
    throw Object.assign(new Error('请输入生物结构术语或更具体的课堂描述。'), { status: 400 })
  }
  if (prompt.length > 600) {
    throw Object.assign(new Error('描述过长，请控制在 600 字以内。'), { status: 400 })
  }
  return prompt
}

export function normalizeImagePromptOverride(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim()
  if (!prompt) return ''
  if (prompt.length < 80) {
    throw Object.assign(new Error('确认后的 3D-ready prompt 过短，请先重新生成提示词。'), { status: 400 })
  }
  if (prompt.length > 2400) {
    throw Object.assign(new Error('确认后的 3D-ready prompt 过长，请控制在 2400 字以内。'), { status: 400 })
  }
  return prompt
}

export async function serveReferenceImage(url, response) {
  const id = decodeURIComponent(url.pathname.replace('/api/references/', '').replace(/\/image$/, ''))
  const { record, localPath } = await getReferenceImage(id)
  const info = await stat(localPath)

  response.writeHead(200, {
    'Content-Type': record.mimeType || contentTypeForExt(record.ext),
    'Content-Length': info.size,
    'Cache-Control': 'private, max-age=3600',
  })
  createReadStream(localPath).pipe(response)
}

export async function getReferenceImage(id) {
  const references = await readReferences()
  const record = references.find((item) => item.id === id)
  if (!record) {
    throw Object.assign(new Error('参考图不存在或已被清理。'), { status: 404 })
  }

  const localPath = path.join(REFERENCE_CACHE_DIR, record.fileName)
  await access(localPath)
  return { record, localPath }
}

export async function getReferenceImageStatus(id) {
  const { record } = await getReferenceImage(id)
  return publicReference(record)
}

export async function buildBioReadyPrompt(prompt, template = 'auto') {
  const templateData = await loadPromptTemplate()
  const term = inferBiologyTerm(prompt, template, templateData)
  const { resolvedTerm, preset } = resolvePreset(term, templateData.object_presets)
  const objectEn = preset?.object_en || term
  const addon = preset?.addon_en || ''
  const base = templateData.base_prompt_en.replace('{object}', objectEn)
  const imagePrompt = [
    base,
    addon,
    `User teaching intent: ${prompt}.`,
    `Avoid: ${templateData.negative_prompt_en}`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return {
    term,
    resolvedTerm,
    recommended: preset?.recommended ?? 'custom',
    imagePrompt,
    negativePrompt: templateData.negative_prompt_en,
    qualityChecklist: templateData.quality_checklist,
  }
}

async function polishBioReadyPrompt(promptPackage, userPrompt, { provider = 'openai', timeoutMs } = {}) {
  const useLocalGateway = provider === 'local-gateway'
  const configured = useLocalGateway ? LOCAL_IMAGE_GATEWAY_CONFIGURED : OPENAI_IMAGE_CONFIGURED
  const promptModel = useLocalGateway ? LOCAL_IMAGE_GATEWAY_PROMPT_MODEL : OPENAI_PROMPT_MODEL

  if (!configured || !promptModel) {
    return promptPackage
  }

  const instruction = [
    'You are preparing a prompt for a single-image image-to-3D biology workflow.',
    'Rewrite the prompt in English only.',
    'Keep exactly one centered subject, three-quarter open cutaway, thick visible cut rim, matte opaque material, bright even studio lighting, plain white or very light gray background, soft ground shadow.',
    'Keep the subject visibly bright: no dark render, no low-key lighting, no black background, no heavy vignette, no dramatic shadow hiding internal structures.',
    'Keep 5-7 major readable structures maximum. Increase spacing between structures. Avoid labels, arrows, text, multi-view grids, transparent jelly, glass, wet plastic, glossy toy material, crowded tiny details, floating parts.',
    'Return only the final image prompt, no markdown, no explanation.',
  ].join(' ')

  try {
    const payload = useLocalGateway
      ? await requestLocalGatewayResponse({
          model: promptModel,
          input: `${instruction}\n\nUser term/request: ${userPrompt}\n\nBase prompt:\n${promptPackage.imagePrompt}\n\nNegative constraints:\n${promptPackage.negativePrompt}`,
        }, { timeoutMs })
      : await requestOpenAiResponse({
          model: promptModel,
          input: `${instruction}\n\nUser term/request: ${userPrompt}\n\nBase prompt:\n${promptPackage.imagePrompt}\n\nNegative constraints:\n${promptPackage.negativePrompt}`,
        }, { timeoutMs })
    const text = normalizeGeneratedPrompt(extractResponseText(payload))
    if (text.length < 80) return promptPackage
    return {
      ...promptPackage,
      imagePrompt: text,
      promptModel,
    }
  } catch {
    return {
      ...promptPackage,
      promptModel: 'local-template',
    }
  }
}

function normalizeGeneratedPrompt(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''

  const midpoint = Math.floor(cleaned.length / 2)
  const left = cleaned.slice(0, midpoint).trim()
  const right = cleaned.slice(midpoint).trim()
  if (left.length > 100 && normalizedForCompare(left) === normalizedForCompare(right)) {
    return left
  }

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
  const seen = new Set()
  const deduped = []
  for (const sentence of sentences) {
    const key = normalizedForCompare(sentence)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(sentence)
  }
  return deduped.join(' ')
}

function normalizedForCompare(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function normalizeImageGenerationOptions(input = {}, provider = 'local-gateway') {
  const profile = String(input.imageProfile || input.profile || 'standard').trim()
  const preset = getImageProfilePreset(profile)
  const fallbackSize = provider === 'openai' ? OPENAI_IMAGE_SIZE : LOCAL_IMAGE_GATEWAY_IMAGE_SIZE
  const fallbackQuality = provider === 'openai' ? OPENAI_IMAGE_QUALITY : LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY
  const size = normalizeImageSize(input.imageSize || input.size || preset.size || fallbackSize)
  const quality = normalizeImageQuality(input.imageQuality || input.quality || preset.quality || fallbackQuality)

  return {
    profile: preset.id,
    size,
    quality,
    label: preset.label,
  }
}

function getImageProfilePreset(profile) {
  const presets = {
    fast: {
      id: 'fast',
      label: '快速预览',
      size: '1024x1024',
      quality: 'medium',
    },
    standard: {
      id: 'standard',
      label: '标准教学',
      size: '1536x1536',
      quality: 'high',
    },
    detailed: {
      id: 'detailed',
      label: '精细单图',
      size: '2048x2048',
      quality: 'high',
    },
  }
  return presets[profile] || presets.standard
}

function normalizeImageSize(value) {
  const size = String(value || '').trim().toLowerCase()
  if (/^\d{3,4}x\d{3,4}$/.test(size)) return size
  return '1536x1536'
}

function normalizeImageQuality(value) {
  const quality = String(value || '').trim().toLowerCase()
  if (['low', 'medium', 'high', 'auto'].includes(quality)) return quality
  return 'high'
}

async function requestOpenAiImage(prompt, options = {}) {
  if (OPENAI_IMAGE_MODE !== 'images-api') {
    try {
      return await requestOpenAiImageViaResponses(prompt, options)
    } catch (error) {
      if (OPENAI_IMAGE_MODE === 'responses-tool') throw error
    }
  }

  return requestOpenAiImageViaImagesApi(prompt, options)
}

async function requestOpenAiImageViaResponses(prompt, options = {}) {
  const imageOptions = normalizeImageGenerationOptions(options, 'openai')
  const payload = await requestOpenAiResponse({
    model: OPENAI_IMAGE_MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              'Generate one 3D-ready educational biology reference image.',
              'Use the following prompt exactly as visual direction.',
              prompt,
            ].join('\n\n'),
          },
        ],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        model: OPENAI_IMAGE_TOOL_MODEL,
        size: imageOptions.size,
        quality: imageOptions.quality,
        output_format: OPENAI_IMAGE_FORMAT,
      },
    ],
  })

  const image = extractResponseImage(payload)
  if (!image) {
    throw new Error('Responses 图像工具未返回可用图片。')
  }

  return {
    buffer: Buffer.from(image, 'base64'),
    model: `${OPENAI_IMAGE_MODEL} / ${OPENAI_IMAGE_TOOL_MODEL}`,
    mode: 'responses-image-generation',
    size: imageOptions.size,
    quality: imageOptions.quality,
    profile: imageOptions.profile,
    ext: normalizeImageExtension(OPENAI_IMAGE_FORMAT),
  }
}

async function requestOpenAiImageViaImagesApi(prompt, options = {}) {
  const imageOptions = normalizeImageGenerationOptions(options, 'openai')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_IMAGE_TIMEOUT_MS)

  try {
    const response = await fetch(OPENAI_IMAGE_ENDPOINT, {
      method: 'POST',
      headers: buildOpenAiHeaders(),
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        size: imageOptions.size,
        quality: imageOptions.quality,
        output_format: OPENAI_IMAGE_FORMAT,
        n: 1,
      }),
      signal: controller.signal,
    })

    const payload = await readOpenAiPayload(response)
    if (!response.ok) {
      const message = extractOpenAiErrorMessage(payload, `OpenAI 图片接口返回 ${response.status}`)
      throw Object.assign(new Error(message), { status: response.status, detail: payload })
    }

    const item = payload?.data?.[0]
    if (item?.b64_json) {
      return {
        buffer: Buffer.from(item.b64_json, 'base64'),
        model: OPENAI_IMAGE_MODEL,
        mode: 'images-api',
        size: imageOptions.size,
        quality: imageOptions.quality,
        profile: imageOptions.profile,
        ext: normalizeImageExtension(OPENAI_IMAGE_FORMAT),
      }
    }
    if (item?.url) {
      const imageResponse = await fetch(item.url, { signal: controller.signal })
      if (!imageResponse.ok) throw new Error(`参考图下载失败：${imageResponse.status}`)
      return {
        buffer: Buffer.from(await imageResponse.arrayBuffer()),
        model: OPENAI_IMAGE_MODEL,
        mode: 'images-api',
        size: imageOptions.size,
        quality: imageOptions.quality,
        profile: imageOptions.profile,
        ext: extensionFromContentType(imageResponse.headers.get('content-type')) || normalizeImageExtension(OPENAI_IMAGE_FORMAT),
      }
    }

    throw new Error('OpenAI 图片接口未返回可用图片。')
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('OpenAI 图片生成超时，请稍后重试。'), { status: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function requestLocalGatewayImage(prompt, options = {}) {
  const imageOptions = normalizeImageGenerationOptions(options, 'local-gateway')
  const models = uniqueImageModels([
    LOCAL_IMAGE_GATEWAY_IMAGE_MODEL,
    ...LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS,
  ])
  const errors = []
  const attemptsPerModel = Math.max(1, LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES)

  for (const model of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      try {
        return await requestLocalGatewayImageWithModel(prompt, model, imageOptions)
      } catch (error) {
        const reason = `${model}#${attempt}: ${error.message || '生成失败'}`
        errors.push(reason)
        if (!isRetryableImageGatewayError(error)) throw error
        if (attempt < attemptsPerModel) {
          await delay(Math.min(1500 * attempt, 4000))
        }
      }
    }
  }

  throw Object.assign(new Error(`本地图片网关未返回可用图片。${errors.join('；')}`), {
    status: 502,
    detail: { attempts: errors },
  })
}

async function requestLocalGatewayImageWithModel(prompt, model, imageOptions) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LOCAL_IMAGE_GATEWAY_TIMEOUT_MS)

  try {
    const response = await fetch(LOCAL_IMAGE_GATEWAY_IMAGE_ENDPOINT, {
      method: 'POST',
      headers: buildLocalGatewayHeaders(),
      body: JSON.stringify({
        model,
        prompt,
        size: imageOptions.size,
        quality: imageOptions.quality,
        output_format: LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT,
        response_format: 'b64_json',
        n: 1,
      }),
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') || ''
    const payload = await readImageGatewayPayload(response, contentType)
    if (!response.ok) {
      const message = extractOpenAiErrorMessage(payload, `本地图片网关返回 ${response.status}`)
      throw Object.assign(new Error(message), { status: response.status, detail: payload, model })
    }

    const parsed = await imageResultFromPayload(payload, {
      signal: controller.signal,
      contentType,
      fallbackExt: LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT,
    })
    return {
      ...parsed,
      model,
      mode: 'local-gateway-images-api',
      size: imageOptions.size,
      quality: imageOptions.quality,
      profile: imageOptions.profile,
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('本地图片网关生成超时，请稍后重试。'), { status: 504, model })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function requestLocalGatewayResponse(body, { timeoutMs = LOCAL_IMAGE_GATEWAY_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(LOCAL_IMAGE_GATEWAY_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: buildLocalGatewayHeaders(),
      body: JSON.stringify({
        store: !LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE,
        reasoning: { effort: LOCAL_IMAGE_GATEWAY_REASONING_EFFORT },
        ...body,
      }),
      signal: controller.signal,
    })
    const payload = await readOpenAiPayload(response)
    if (!response.ok) {
      const message = extractOpenAiErrorMessage(payload, `本地图片网关 Responses 接口返回 ${response.status}`)
      throw Object.assign(new Error(message), { status: response.status, detail: payload })
    }
    return payload
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('本地图片网关 Responses 请求超时，请稍后重试。'), { status: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readImageGatewayPayload(response, contentType = '') {
  if (/^image\//i.test(contentType)) {
    return Buffer.from(await response.arrayBuffer())
  }
  return readOpenAiPayload(response)
}

async function imageResultFromPayload(payload, { signal, contentType = '', fallbackExt = 'png' } = {}) {
  if (Buffer.isBuffer(payload)) {
    return {
      buffer: payload,
      ext: extensionFromContentType(contentType) || detectImageExtension(payload) || normalizeImageExtension(fallbackExt),
    }
  }

  const image = extractResponseImage(payload)
  if (image) {
    const buffer = Buffer.from(image, 'base64')
    return {
      buffer,
      ext: detectImageExtension(buffer) || normalizeImageExtension(fallbackExt),
    }
  }

  const imageUrl = findImageUrl(payload)
  if (imageUrl) {
    const imageResponse = await fetch(imageUrl, { signal })
    if (!imageResponse.ok) throw new Error(`参考图下载失败：${imageResponse.status}`)
    const buffer = Buffer.from(await imageResponse.arrayBuffer())
    return {
      buffer,
      ext:
        extensionFromContentType(imageResponse.headers.get('content-type')) ||
        detectImageExtension(buffer) ||
        normalizeImageExtension(fallbackExt),
    }
  }

  throw new Error('图片生成接口未返回可用图片。')
}

function uniqueImageModels(models) {
  return [...new Set(models.map((item) => String(item || '').trim()).filter(Boolean))]
}

function isRetryableImageGatewayError(error) {
  if (['AbortError', 'TypeError'].includes(error?.name)) return true
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(Number(error?.status))) return true
  const message = String(error?.message || '')
  return /image model|model|not found|invalid_request|unsupported|requires|upstream|gateway|timeout|timed? out|fetch failed|api\.[\w.-]+\/v1\/images\/generations/i.test(message)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestOpenAiResponse(body, { timeoutMs = OPENAI_IMAGE_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: buildOpenAiHeaders(),
      body: JSON.stringify({
        store: !OPENAI_DISABLE_RESPONSE_STORAGE,
        reasoning: { effort: OPENAI_REASONING_EFFORT },
        ...body,
      }),
      signal: controller.signal,
    })
    const payload = await readOpenAiPayload(response)
    if (!response.ok) {
      const message = extractOpenAiErrorMessage(payload, `OpenAI Responses 接口返回 ${response.status}`)
      throw Object.assign(new Error(message), { status: response.status, detail: payload })
    }
    return payload
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(new Error('OpenAI Responses 请求超时，请稍后重试。'), { status: 504 })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function readOpenAiPayload(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.slice(0, 1000) } }
  }
}

function buildOpenAiHeaders() {
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  }
  if (OPENAI_ORGANIZATION) headers['OpenAI-Organization'] = OPENAI_ORGANIZATION
  if (OPENAI_PROJECT) headers['OpenAI-Project'] = OPENAI_PROJECT
  return headers
}

function buildLocalGatewayHeaders({ json = true } = {}) {
  const headers = {
    Authorization: `Bearer ${LOCAL_IMAGE_GATEWAY_API_KEY}`,
  }
  if (json) headers['Content-Type'] = 'application/json'
  return headers
}

async function checkGatewayTextEndpoint(endpoint, { method, headers, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { method, headers, signal: controller.signal })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? text.slice(0, 160) || 'ok' : text.slice(0, 240) || `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      status: error.name === 'AbortError' ? 504 : 0,
      message: error.name === 'AbortError' ? '本地图片网关检查超时。' : error.message || '本地图片网关检查失败。',
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function checkGatewayJsonEndpoint(endpoint, { method, headers, timeoutMs }) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint, { method, headers, signal: controller.signal })
    const payload = await readOpenAiPayload(response)
    const modelIds = Array.isArray(payload?.data)
      ? payload.data.map((item) => item?.id).filter(Boolean).slice(0, 12)
      : []
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? 'ok' : extractOpenAiErrorMessage(payload, `HTTP ${response.status}`),
      modelIds,
    }
  } catch (error) {
    return {
      ok: false,
      status: error.name === 'AbortError' ? 504 : 0,
      message: error.name === 'AbortError' ? '本地图片网关模型检查超时。' : error.message || '本地图片网关模型检查失败。',
    }
  } finally {
    clearTimeout(timeout)
  }
}

function extractOpenAiErrorMessage(payload, fallback) {
  if (!payload) return fallback
  if (typeof payload === 'string') return payload || fallback
  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.error ||
    payload?.detail?.message ||
    fallback
  )
}

function extractResponseText(payload) {
  const parts = []
  for (const output of payload?.output || []) {
    for (const content of output?.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text)
      if (typeof content?.text === 'string') parts.push(content.text)
    }
  }
  if (payload?.output_text) parts.push(payload.output_text)
  return parts.join('\n').trim()
}

function extractResponseImage(payload) {
  const direct = findBase64Image(payload)
  if (direct) return direct

  for (const output of payload?.output || []) {
    if (output?.type === 'image_generation_call' && output.result) return output.result
    for (const content of output?.content || []) {
      if (content?.type === 'image_generation_call' && content.result) return content.result
      if (content?.type === 'output_image' && content.image_base64) return content.image_base64
      if (content?.type === 'input_image' && content.image_base64) return content.image_base64
    }
  }
  return ''
}

function findImageUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') {
    if (/^https?:\/\/.+/i.test(value)) return value
    return ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'image_url', 'imageUrl']) {
      const found = findImageUrl(value[key])
      if (found) return found
    }
    for (const child of Object.values(value)) {
      const found = findImageUrl(child)
      if (found) return found
    }
  }
  return ''
}

function findBase64Image(value) {
  if (!value) return ''
  if (typeof value === 'string') {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    }
    if (looksLikeImageBase64(value)) return value
    return ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBase64Image(item)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const key of ['result', 'image_base64', 'b64_json', 'base64', 'data']) {
      const found = findBase64Image(value[key])
      if (found) return found
    }
    for (const child of Object.values(value)) {
      const found = findBase64Image(child)
      if (found) return found
    }
  }
  return ''
}

function looksLikeImageBase64(value) {
  if (value.length < 128 || !/^[A-Za-z0-9+/=]+$/.test(value)) return false
  try {
    return Boolean(detectImageExtension(Buffer.from(value.slice(0, 96), 'base64')))
  } catch {
    return false
  }
}

async function saveReferenceBuffer({
  buffer,
  prompt,
  template,
  provider,
  source,
  title,
  note,
  imagePrompt,
  negativePrompt,
  promptModel,
  model,
  generationMode,
  imageSize,
  imageQuality,
  imageProfile,
  ext,
}) {
  validateImageBuffer(buffer, ext)
  await Promise.all([
    mkdir(REFERENCE_WORK_DIR, { recursive: true }),
    mkdir(REFERENCE_CACHE_DIR, { recursive: true }),
    mkdir(REFERENCE_TRASH_DIR, { recursive: true }),
    mkdir(WORKFLOW_STORE_DIR, { recursive: true }),
  ])

  const id = `ref-${Date.now()}-${randomUUID().slice(0, 8)}`
  const safeExt = normalizeImageExtension(ext)
  const fileName = `${sanitizeFileName(`${id}-${template}.${safeExt}`, `reference.${safeExt}`)}`
  const workPath = path.join(REFERENCE_WORK_DIR, `${fileName}.uploading`)
  const cachePath = path.join(REFERENCE_CACHE_DIR, fileName)

  try {
    await writeFile(workPath, buffer)
    validateImageBuffer(await readFile(workPath), safeExt)
    await rename(workPath, cachePath)
  } catch (error) {
    await moveFailedReference(workPath, fileName)
    throw error
  }

  const record = {
    id,
    prompt,
    template,
    provider,
    source,
    title,
    note,
    fileName,
    ext: safeExt,
    mimeType: contentTypeForExt(safeExt),
    fileSize: buffer.length,
    model,
    promptModel,
    generationMode,
    imageSize,
    imageQuality,
    imageProfile,
    imagePrompt,
    negativePrompt,
    createdAt: new Date().toISOString(),
  }

  await upsertReference(record)
  return record
}

async function loadPromptTemplate() {
  const raw = await readFile(PROMPT_TEMPLATE_PATH, 'utf8')
  return JSON.parse(raw)
}

function inferBiologyTerm(prompt, template, templateData) {
  const byTemplate = {
    'plant-cell': '植物细胞',
    'animal-cell': '动物细胞',
    'white-blood-cell': '动物细胞',
    neuron: '动物细胞',
    dna: '细胞核',
    mitochondrion: '线粒体',
    chloroplast: '叶绿体',
    bacterium: '细菌',
  }
  const text = String(prompt || '')
  const keys = Object.keys(templateData.object_presets).sort((a, b) => b.length - a.length)
  const matched = keys.find((key) => !templateData.object_presets[key].alias_of && text.includes(key))
  if (matched) return matched
  if (template && template !== 'auto' && byTemplate[template]) return byTemplate[template]
  return '植物细胞'
}

function resolvePreset(term, presets) {
  let current = term
  const seen = new Set()
  while (presets[current]?.alias_of) {
    if (seen.has(current)) throw new Error(`Prompt preset alias loop: ${current}`)
    seen.add(current)
    current = presets[current].alias_of
  }
  return { resolvedTerm: current, preset: presets[current] }
}

async function upsertReference(record) {
  const references = await readReferences()
  const index = references.findIndex((item) => item.id === record.id)
  if (index >= 0) references[index] = record
  else references.push(record)
  await writeReferences(references.slice(-80))
}

async function readReferences() {
  try {
    const raw = await readFile(REFERENCE_STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.references) ? parsed.references : []
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function writeReferences(references) {
  await mkdir(WORKFLOW_STORE_DIR, { recursive: true })
  const tmpPath = path.join(WORKFLOW_STORE_DIR, `references-${Date.now()}.tmp`)
  await writeFile(tmpPath, JSON.stringify({ references }, null, 2))
  await rename(tmpPath, REFERENCE_STORE_FILE)
}

export function validateImageBuffer(buffer, ext = 'png') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    throw Object.assign(new Error('参考图文件过小或格式无效。'), { status: 400 })
  }

  const safeExt = normalizeImageExtension(ext)
  const signature = buffer.subarray(0, 12)
  const isPng = hasPngSignature(buffer)
  const isJpeg = hasJpegSignature(buffer)
  const isWebp = signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP'

  if (safeExt === 'png' && isPng) return
  if ((safeExt === 'jpg' || safeExt === 'jpeg') && isJpeg) return
  if (safeExt === 'webp' && isWebp) return

  throw Object.assign(new Error('参考图仅支持 PNG、JPEG 或 WebP。'), { status: 400 })
}

export function hasPngSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false
  return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

export function hasJpegSignature(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

function imageExtensionFromName(fileName) {
  return normalizeImageExtension(path.extname(String(fileName || '')).replace('.', '') || 'png')
}

function detectImageExtension(buffer) {
  if (hasPngSignature(buffer)) return 'png'
  if (hasJpegSignature(buffer)) return 'jpg'
  const signature = Buffer.isBuffer(buffer) ? buffer.subarray(0, 12) : Buffer.from(buffer || [])
  if (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp'
  }
  return ''
}

function extensionFromContentType(contentType = '') {
  if (/image\/png/i.test(contentType)) return 'png'
  if (/image\/jpe?g/i.test(contentType)) return 'jpg'
  if (/image\/webp/i.test(contentType)) return 'webp'
  return ''
}

function normalizeImageExtension(value) {
  const ext = String(value || 'png').toLowerCase().replace(/^\./, '')
  if (ext === 'jpeg') return 'jpg'
  if (ext === 'png' || ext === 'jpg' || ext === 'webp') return ext
  throw Object.assign(new Error('参考图仅支持 PNG、JPEG 或 WebP。'), { status: 400 })
}

function contentTypeForExt(ext) {
  if (ext === 'jpg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

function trimReferenceTitle(value) {
  const cleaned = String(value || '参考图').replace(/\.(png|jpg|jpeg|webp)$/i, '').trim()
  return cleaned.length > 18 ? `${cleaned.slice(0, 18)}...` : cleaned || '参考图'
}

async function moveFailedReference(workPath, fileName) {
  try {
    await access(workPath)
    await rename(workPath, path.join(REFERENCE_TRASH_DIR, `${fileName}.failed-${Date.now()}`))
  } catch {
    // Keep the original validation or provider error as the public response.
  }
}

function publicReference(record) {
  return {
    id: record.id,
    prompt: record.prompt,
    template: record.template,
    provider: record.provider,
    source: record.source,
    title: record.title,
    note: record.note,
    fileName: record.fileName,
    fileSize: record.fileSize,
    model: record.model,
    promptModel: record.promptModel,
    generationMode: record.generationMode,
    imageSize: record.imageSize,
    imageQuality: record.imageQuality,
    imageProfile: record.imageProfile,
    imagePrompt: record.imagePrompt,
    negativePrompt: record.negativePrompt,
    imageUrl: `/api/references/${encodeURIComponent(record.id)}/image`,
    createdAt: record.createdAt,
  }
}
