import path from 'node:path'

export const API_HOST = process.env.API_HOST || '127.0.0.1'
export const API_PORT = Number(process.env.API_PORT || 8791)
export const BODY_LIMIT = 28 * 1024 * 1024
export const MODEL_UPLOAD_LIMIT = 180 * 1024 * 1024
export const REFERENCE_IMAGE_LIMIT = 18 * 1024 * 1024
export const LOCAL_MODEL_DIR = path.resolve(process.env.LOCAL_MODEL_DIR || '.generated-models')
export const UPLOAD_WORK_DIR = path.resolve(process.env.UPLOAD_WORK_DIR || '.upload-work')
export const UPLOAD_CACHE_DIR = path.resolve(process.env.UPLOAD_CACHE_DIR || '.upload-cache')
export const UPLOAD_TRASH_DIR = path.resolve(process.env.UPLOAD_TRASH_DIR || '.upload-trash')
export const REFERENCE_WORK_DIR = path.resolve(process.env.REFERENCE_WORK_DIR || '.reference-work')
export const REFERENCE_CACHE_DIR = path.resolve(process.env.REFERENCE_CACHE_DIR || '.reference-cache')
export const REFERENCE_TRASH_DIR = path.resolve(process.env.REFERENCE_TRASH_DIR || '.reference-trash')
export const CELLFORGE_MODEL_DIR = path.resolve(process.env.CELLFORGE_MODEL_DIR || '../3DCellForge/public/generated-models')
export const WORKFLOW_STORE_DIR = path.resolve(process.env.WORKFLOW_STORE_DIR || '.workflow-store')
export const WORKFLOW_JOBS_FILE = path.join(WORKFLOW_STORE_DIR, 'jobs.json')
export const WORKFLOW_EVENTS_FILE = path.join(WORKFLOW_STORE_DIR, 'job-events.jsonl')
export const REFERENCE_STORE_FILE = path.join(WORKFLOW_STORE_DIR, 'references.json')
export const ANALYTICS_EVENTS_FILE = path.join(WORKFLOW_STORE_DIR, 'analytics-events.jsonl')
export const LOCAL_GATEWAY_MODELS_CACHE_FILE = path.join(WORKFLOW_STORE_DIR, 'local-gateway-models-cache.json')
export const WORKFLOW_JOB_RETENTION_LIMIT = Number(process.env.WORKFLOW_JOB_RETENTION_LIMIT || 80)
export const WORKFLOW_EVENT_RETENTION_LIMIT = Number(process.env.WORKFLOW_EVENT_RETENTION_LIMIT || 800)
export const WORKFLOW_EVENT_COMPACT_INTERVAL = Number(process.env.WORKFLOW_EVENT_COMPACT_INTERVAL || 40)
export const MOCK_WORKFLOW_STEP_DELAY = Number(process.env.MOCK_WORKFLOW_STEP_DELAY || 650)
export const HUNYUAN_3D_MODEL_COST_CNY = Number(process.env.HUNYUAN_3D_MODEL_COST_CNY || 1)
export const BIO3D_COLOR_FALLBACK_ENABLED = process.env.BIO3D_COLOR_FALLBACK_ENABLED !== 'false'
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
export const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
export const OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION || ''
export const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''
export const OPENAI_PROMPT_MODEL = process.env.OPENAI_PROMPT_MODEL || 'gpt-5.5'
export const OPENAI_REVIEW_MODEL = process.env.OPENAI_REVIEW_MODEL || OPENAI_PROMPT_MODEL
export const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'xhigh'
export const OPENAI_DISABLE_RESPONSE_STORAGE = process.env.OPENAI_DISABLE_RESPONSE_STORAGE !== 'false'
export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-5.5'
export const OPENAI_IMAGE_TOOL_MODEL = process.env.OPENAI_IMAGE_TOOL_MODEL || 'gpt-image-2'
export const OPENAI_IMAGE_MODE = process.env.OPENAI_IMAGE_MODE || 'responses-tool'
export const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1536x1536'
export const OPENAI_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'high'
export const OPENAI_IMAGE_FORMAT = process.env.OPENAI_IMAGE_FORMAT || 'png'
export const OPENAI_RESPONSES_ENDPOINT = process.env.OPENAI_RESPONSES_ENDPOINT || `${OPENAI_BASE_URL}/responses`
export const OPENAI_IMAGE_ENDPOINT = process.env.OPENAI_IMAGE_ENDPOINT || `${OPENAI_BASE_URL}/images/generations`
export const OPENAI_IMAGE_CONFIGURED = Boolean(OPENAI_API_KEY)
export const LOCAL_IMAGE_GATEWAY_BASE_URL = (process.env.LOCAL_IMAGE_GATEWAY_BASE_URL || 'http://127.0.0.1:48760').replace(/\/+$/, '')
export const LOCAL_IMAGE_GATEWAY_API_KEY = process.env.LOCAL_IMAGE_GATEWAY_API_KEY || ''
export const LOCAL_IMAGE_GATEWAY_HEALTH_ENDPOINT =
  process.env.LOCAL_IMAGE_GATEWAY_HEALTH_ENDPOINT || `${LOCAL_IMAGE_GATEWAY_BASE_URL}/health`
export const LOCAL_IMAGE_GATEWAY_MODELS_ENDPOINT =
  process.env.LOCAL_IMAGE_GATEWAY_MODELS_ENDPOINT || `${LOCAL_IMAGE_GATEWAY_BASE_URL}/models`
export const LOCAL_IMAGE_GATEWAY_RESPONSES_ENDPOINT =
  process.env.LOCAL_IMAGE_GATEWAY_RESPONSES_ENDPOINT || `${LOCAL_IMAGE_GATEWAY_BASE_URL}/responses`
export const LOCAL_IMAGE_GATEWAY_IMAGE_ENDPOINT =
  process.env.LOCAL_IMAGE_GATEWAY_IMAGE_ENDPOINT || `${LOCAL_IMAGE_GATEWAY_BASE_URL}/images/generations`
export const LOCAL_IMAGE_GATEWAY_PROMPT_MODEL = process.env.LOCAL_IMAGE_GATEWAY_PROMPT_MODEL || 'gpt-5.5'
export const LOCAL_IMAGE_GATEWAY_IMAGE_MODEL = process.env.LOCAL_IMAGE_GATEWAY_IMAGE_MODEL || 'gpt-image-2'
export const LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS = (
  process.env.LOCAL_IMAGE_GATEWAY_IMAGE_MODEL_FALLBACKS || 'gpt-image-2,gpt-image-1.5,gpt-image-1'
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
export const LOCAL_IMAGE_GATEWAY_REASONING_EFFORT = process.env.LOCAL_IMAGE_GATEWAY_REASONING_EFFORT || 'xhigh'
export const LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE =
  process.env.LOCAL_IMAGE_GATEWAY_DISABLE_RESPONSE_STORAGE !== 'false'
export const LOCAL_IMAGE_GATEWAY_IMAGE_SIZE = process.env.LOCAL_IMAGE_GATEWAY_IMAGE_SIZE || OPENAI_IMAGE_SIZE
export const LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY = process.env.LOCAL_IMAGE_GATEWAY_IMAGE_QUALITY || OPENAI_IMAGE_QUALITY
export const LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT = process.env.LOCAL_IMAGE_GATEWAY_IMAGE_FORMAT || OPENAI_IMAGE_FORMAT
export const LOCAL_IMAGE_GATEWAY_TIMEOUT_MS = Number(process.env.LOCAL_IMAGE_GATEWAY_TIMEOUT_MS || 420000)
export const LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES = Number(process.env.LOCAL_IMAGE_GATEWAY_IMAGE_RETRIES || 2)
export const PROMPT_POLISH_TIMEOUT_MS = Number(process.env.PROMPT_POLISH_TIMEOUT_MS || 60000)
export const PROMPT_PREVIEW_TIMEOUT_MS = Number(process.env.PROMPT_PREVIEW_TIMEOUT_MS || 15000)
export const LOCAL_IMAGE_GATEWAY_CONFIGURED = Boolean(LOCAL_IMAGE_GATEWAY_API_KEY)
export const COMFYUI_BASE_URL = (process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '')
export const COMFYUI_OUTPUT_PREFIX = process.env.COMFYUI_OUTPUT_PREFIX || '/path/to/ComfyUI/output/'
export const COMFYUI_WORKFLOW_TEMPLATE = path.resolve(
  process.env.COMFYUI_WORKFLOW_TEMPLATE || 'server/workflows/bio_single_image_triposg_bio3d_api.json'
)
export const COMFYUI_TIMEOUT_MS = Number(process.env.COMFYUI_TIMEOUT_MS || 2 * 60 * 60 * 1000)
export const COMFYUI_POLL_INTERVAL_MS = Number(process.env.COMFYUI_POLL_INTERVAL_MS || 15 * 1000)
export const COMFYUI_STEPS = Number(process.env.COMFYUI_STEPS || 16)
export const COMFYUI_FACES = Number(process.env.COMFYUI_FACES || 12000)
export const COMFYUI_GUIDANCE_SCALE = Number(process.env.COMFYUI_GUIDANCE_SCALE || 6)
export const COMFYUI_HY3DPAINT_ENABLED = process.env.COMFYUI_HY3DPAINT_ENABLED !== 'false'
export const COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE = path.resolve(
  process.env.COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE || 'server/workflows/bio_single_image_triposg_hy3dpaint_api.json'
)
export const COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE = path.resolve(
  process.env.COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE || 'server/workflows/bio_existing_mesh_hy3dpaint_postprocess_api.json'
)
export const COMFYUI_HY3DPAINT_TIMEOUT_MS = Number(process.env.COMFYUI_HY3DPAINT_TIMEOUT_MS || 3 * 60 * 60 * 1000)
export const COMFYUI_HY3DPAINT_STEPS = Number(process.env.COMFYUI_HY3DPAINT_STEPS || 10)
export const COMFYUI_HY3DPAINT_FACES = Number(process.env.COMFYUI_HY3DPAINT_FACES || 3000)
export const COMFYUI_HY3DPAINT_GUIDANCE_SCALE = Number(process.env.COMFYUI_HY3DPAINT_GUIDANCE_SCALE || 4)
export const COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST =
  process.env.COMFYUI_HY3DPAINT_FULL_WORKFLOW_FIRST === 'true'
export const COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS = Number(
  process.env.COMFYUI_HY3DPAINT_FULL_WORKFLOW_STEPS || 12
)
export const COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES = Number(
  process.env.COMFYUI_HY3DPAINT_FULL_WORKFLOW_FACES || 6000
)
export const COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE = Number(
  process.env.COMFYUI_HY3DPAINT_FULL_WORKFLOW_GUIDANCE_SCALE || 5
)
export const COMFYUI_HY3DPAINT_STABLE_STEPS = Number(process.env.COMFYUI_HY3DPAINT_STABLE_STEPS || 12)
export const COMFYUI_HY3DPAINT_STABLE_FACES = Number(process.env.COMFYUI_HY3DPAINT_STABLE_FACES || 3000)
export const COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE = Number(process.env.COMFYUI_HY3DPAINT_STABLE_GUIDANCE_SCALE || 5)
export const COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB = Number(process.env.COMFYUI_HY3DPAINT_MIN_RAM_FREE_GB || 16.5)
export const COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB = Number(process.env.COMFYUI_HY3DPAINT_MIN_VRAM_FREE_GB || 14)
export const COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB = Number(process.env.COMFYUI_HY3DPAINT_MIN_TOTAL_RAM_GB || 19)
export const COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB = Number(process.env.COMFYUI_HY3DPAINT_LOW_MEMORY_TOTAL_RAM_GB || 24)
export const COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED =
  process.env.COMFYUI_HY3DPAINT_LOW_MEMORY_REMOTE_ENABLED !== 'false'
export const COMFYUI_HY3DPAINT_AUTO_FALLBACK = process.env.COMFYUI_HY3DPAINT_AUTO_FALLBACK !== 'false'
export const COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT =
  process.env.COMFYUI_HY3DPAINT_FULL_RETRY_ON_TIMEOUT === 'true'
export const COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT = Number(
  process.env.COMFYUI_HY3DPAINT_UNOBSERVABLE_RECOVERY_LIMIT || 48
)
export const COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT = Number(
  process.env.COMFYUI_HY3DPAINT_STALE_HISTORY_LIMIT || 80
)
export const COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB = Number(
  process.env.COMFYUI_HY3DPAINT_RUNTIME_MIN_RAM_FREE_GB || 5.5
)
export const COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB = Number(
  process.env.COMFYUI_HY3DPAINT_RUNTIME_MIN_VRAM_FREE_GB || 8
)
export const COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS = Number(
  process.env.COMFYUI_HY3DPAINT_RUNTIME_GUARD_GRACE_POLLS || 1
)
export const COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT = Number(
  process.env.COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_COUNT || 2
)
export const COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS = Number(
  process.env.COMFYUI_HY3DPAINT_RUNTIME_FALLBACK_BACKOFF_MS || 3 * 60 * 60 * 1000
)
export const COMFYUI_HY3DPAINT_POLL_INTERVAL_MS = Number(process.env.COMFYUI_HY3DPAINT_POLL_INTERVAL_MS || 5000)
export const COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE =
  process.env.COMFYUI_HY3DPAINT_ABORT_ON_UNOBSERVABLE === 'true'
export const COMFYUI_RESOURCE_GUARD = process.env.COMFYUI_RESOURCE_GUARD !== 'false'
export const COMFYUI_MIN_RAM_FREE_GB = Number(process.env.COMFYUI_MIN_RAM_FREE_GB || 10)
export const COMFYUI_MIN_VRAM_FREE_GB = Number(process.env.COMFYUI_MIN_VRAM_FREE_GB || 6)
export const COMFYUI_LOCAL_QUEUE_MAX_PENDING = Number(process.env.COMFYUI_LOCAL_QUEUE_MAX_PENDING || 1)
export const COMFYUI_BLOCK_WHEN_REMOTE_BUSY = process.env.COMFYUI_BLOCK_WHEN_REMOTE_BUSY !== 'false'
export const COMFYUI_FREE_AFTER_JOB = process.env.COMFYUI_FREE_AFTER_JOB !== 'false'
export const COMFYUI_FREE_TIMEOUT_MS = Number(process.env.COMFYUI_FREE_TIMEOUT_MS || 12000)
export const COMFYUI_DRAIN_AFTER_JOB_TIMEOUT_MS = Number(process.env.COMFYUI_DRAIN_AFTER_JOB_TIMEOUT_MS || 90000)
export const COMFYUI_DRAIN_AFTER_JOB_POLL_MS = Number(process.env.COMFYUI_DRAIN_AFTER_JOB_POLL_MS || 5000)
export const COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD = process.env.COMFYUI_PREFLIGHT_FREE_BEFORE_GUARD !== 'false'
export const COMFYUI_HISTORY_CACHE_LIMIT = Number(process.env.COMFYUI_HISTORY_CACHE_LIMIT || 60)
export const TENCENT_HUNYUAN_CONFIGURED = Boolean(
  process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY && process.env.TENCENT_HUNYUAN_3D_ENDPOINT
)
export const SUPPORTED_IMAGE_PROVIDERS = ['local-gateway', 'openai']
export const DEFAULT_IMAGE_PROVIDER = process.env.DEFAULT_IMAGE_PROVIDER || (LOCAL_IMAGE_GATEWAY_CONFIGURED ? 'local-gateway' : 'openai')
export const SUPPORTED_WORKFLOW_PROVIDERS = ['selfhost-triposg', 'local-demo', 'tencent-hunyuan']

export const DEMO_MODELS = [
  {
    id: 'cellforge-tripo-plant',
    fileName: 'tripo-plant-cell-test.glb',
    name: 'Tripo 植物细胞缓存模型',
    subtitle: '3DCellForge 缓存生成模型',
    category: 'AI 生成示意模型',
    accent: '#7fb069',
    imageHint: 'plant-cell',
    description:
      '来自 3DCellForge 的 Tripo 缓存模型，用于验证图片转 3D 生成结果进入 LearningCell 展示链路后的浏览效果。',
    template: 'plant-cell',
  },
  {
    id: 'cellforge-tripo-epithelial',
    fileName: 'tripo-epithelial-cell-test.glb',
    name: 'Tripo 上皮细胞缓存模型',
    subtitle: '3DCellForge 缓存生成模型',
    category: 'AI 生成示意模型',
    accent: '#e8859a',
    imageHint: 'animal-cell',
    description:
      '来自 3DCellForge 的 epithelial cell 生成模型，用于说明外部 image-to-3D 生成资产如何被缓存并加载到 LearningCell 的 3D 舞台。',
    template: 'animal-cell',
  },
]
