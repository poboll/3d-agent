import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  OPENAI_API_KEY,
  OPENAI_IMAGE_CONFIGURED,
  OPENAI_IMAGE_ENDPOINT,
  OPENAI_IMAGE_FORMAT,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_QUALITY,
  OPENAI_IMAGE_SIZE,
  OPENAI_ORGANIZATION,
  OPENAI_PROJECT,
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
  const prompt = normalizePrompt(input.prompt)
  const template = chooseTemplateForPrompt(prompt, input.template)
  const provider = normalizeImageProvider(input.provider)

  if (provider !== 'openai') {
    throw Object.assign(new Error('当前图片生成接口仅开放 OpenAI GPT Image。'), { status: 400 })
  }

  const promptPackage = await buildBioReadyPrompt(prompt, template)

  if (!OPENAI_IMAGE_CONFIGURED) {
    throw Object.assign(new Error('OpenAI 图片生成尚未配置，请在后端环境变量中设置 OPENAI_API_KEY。'), {
      status: 503,
      detail: {
        requiredEnv: ['OPENAI_API_KEY'],
        optionalEnv: ['OPENAI_IMAGE_MODEL', 'OPENAI_IMAGE_SIZE', 'OPENAI_IMAGE_QUALITY', 'OPENAI_IMAGE_FORMAT'],
        imagePrompt: promptPackage.imagePrompt,
      },
    })
  }

  const imageBuffer = await requestOpenAiImage(promptPackage.imagePrompt)
  const saved = await saveReferenceBuffer({
    buffer: imageBuffer,
    prompt,
    template,
    provider,
    source: 'OpenAI GPT Image',
    title: `${getTemplateDisplayName(template)} · GPT 参考图`,
    note: '已生成适合图生 3D 的单图参考图，请确认主体、剖面和结构间距后再建模。',
    imagePrompt: promptPackage.imagePrompt,
    negativePrompt: promptPackage.negativePrompt,
    model: OPENAI_IMAGE_MODEL,
    ext: normalizeImageExtension(OPENAI_IMAGE_FORMAT),
  })

  return publicReference(saved)
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

async function requestOpenAiImage(prompt) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OPENAI_IMAGE_TIMEOUT_MS)
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  }
  if (OPENAI_ORGANIZATION) headers['OpenAI-Organization'] = OPENAI_ORGANIZATION
  if (OPENAI_PROJECT) headers['OpenAI-Project'] = OPENAI_PROJECT

  try {
    const response = await fetch(OPENAI_IMAGE_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        size: OPENAI_IMAGE_SIZE,
        quality: OPENAI_IMAGE_QUALITY,
        output_format: OPENAI_IMAGE_FORMAT,
        n: 1,
      }),
      signal: controller.signal,
    })

    const payload = await response.json().catch(async () => ({ error: { message: await response.text() } }))
    if (!response.ok) {
      const message = payload?.error?.message || `OpenAI 图片接口返回 ${response.status}`
      throw Object.assign(new Error(message), { status: response.status, detail: payload })
    }

    const item = payload?.data?.[0]
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item?.url) {
      const imageResponse = await fetch(item.url, { signal: controller.signal })
      if (!imageResponse.ok) throw new Error(`参考图下载失败：${imageResponse.status}`)
      return Buffer.from(await imageResponse.arrayBuffer())
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
  model,
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
    imagePrompt: record.imagePrompt,
    negativePrompt: record.negativePrompt,
    imageUrl: `/api/references/${encodeURIComponent(record.id)}/image`,
    createdAt: record.createdAt,
  }
}
