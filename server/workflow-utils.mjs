import { randomUUID } from 'node:crypto'
import { HUNYUAN_3D_MODEL_COST_CNY, SUPPORTED_IMAGE_PROVIDERS, SUPPORTED_WORKFLOW_PROVIDERS } from './config.mjs'

export const WORKFLOW_STATUSES = ['queued', 'processing', 'completed', 'failed']

export function buildJobId(now = Date.now()) {
  return `job-${now}-${randomUUID().slice(0, 8)}`
}

export function normalizePrompt(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim()
  if (prompt.length < 6) {
    throw Object.assign(new Error('请输入更具体的生物结构描述。'), { status: 400 })
  }
  if (prompt.length > 600) {
    throw Object.assign(new Error('描述过长，请控制在 600 字以内。'), { status: 400 })
  }
  return prompt
}

export function normalizeProvider(value) {
  const provider = String(value || 'selfhost-triposg').trim()
  if (SUPPORTED_WORKFLOW_PROVIDERS.includes(provider)) return provider
  throw Object.assign(new Error('不支持的生成 provider。'), { status: 400 })
}

export function normalizeImageProvider(value) {
  const provider = String(value || 'openai').trim()
  if (SUPPORTED_IMAGE_PROVIDERS.includes(provider)) return provider
  throw Object.assign(new Error('不支持的图片生成 provider。'), { status: 400 })
}

export function estimateGenerationCost(provider) {
  if (provider === 'tencent-hunyuan') return HUNYUAN_3D_MODEL_COST_CNY
  return 0
}

export function chooseTemplateForPrompt(prompt, requestedTemplate = 'auto') {
  const requested = String(requestedTemplate || 'auto').trim()
  if (requested && requested !== 'auto') return requested

  const text = String(prompt || '').toLowerCase()
  if (/dna|基因|染色体|双螺旋|核酸/.test(text)) return 'dna'
  if (/神经|neuron|突触|轴突|树突/.test(text)) return 'neuron'
  if (/白细胞|免疫|吞噬|淋巴|血液/.test(text)) return 'white-blood-cell'
  if (/线粒体|mitochondrion|mitochondria|嵴|双层膜/.test(text)) return 'mitochondrion'
  if (/植物细胞|细胞壁|液泡|plant cell/.test(text)) return 'plant-cell'
  if (/叶绿体|chloroplast|类囊体/.test(text)) return 'chloroplast'
  if (/细菌|bacterium|bacteria|杆状/.test(text)) return 'bacterium'
  if (/植物|叶绿体|细胞壁|液泡|plant|chloroplast/.test(text)) return 'plant-cell'
  if (/上皮|动物|细胞膜|线粒体|animal|epithelial/.test(text)) return 'animal-cell'
  return 'plant-cell'
}

export function createPromptTitle(prompt) {
  const cleaned = String(prompt || '')
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 16 ? `${cleaned.slice(0, 16)}...` : cleaned || '生物结构'
}

export function getTemplateDisplayName(template) {
  const names = {
    'plant-cell': '植物细胞',
    'animal-cell': '动物细胞',
    'white-blood-cell': '白细胞',
    neuron: '神经元',
    dna: 'DNA 双螺旋',
    mitochondrion: '线粒体',
    chloroplast: '叶绿体',
    bacterium: '细菌',
  }
  return names[template] || '生物结构'
}

export function publicJob(job) {
  return {
    id: job.id,
    prompt: job.prompt,
    provider: job.provider,
    template: job.template,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    costEstimateCny: job.costEstimateCny,
    imageProvider: job.imageProvider,
    referenceId: job.referenceId,
    referenceImageUrl: job.referenceImageUrl,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    result: job.result,
  }
}
