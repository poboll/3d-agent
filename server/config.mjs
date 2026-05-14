import path from 'node:path'

export const API_HOST = process.env.API_HOST || '127.0.0.1'
export const API_PORT = Number(process.env.API_PORT || 8791)
export const BODY_LIMIT = 28 * 1024 * 1024
export const MODEL_UPLOAD_LIMIT = 180 * 1024 * 1024
export const LOCAL_MODEL_DIR = path.resolve(process.env.LOCAL_MODEL_DIR || '.generated-models')
export const CELLFORGE_MODEL_DIR = path.resolve(process.env.CELLFORGE_MODEL_DIR || '../3DCellForge/public/generated-models')
export const WORKFLOW_STORE_DIR = path.resolve(process.env.WORKFLOW_STORE_DIR || '.workflow-store')
export const WORKFLOW_JOBS_FILE = path.join(WORKFLOW_STORE_DIR, 'jobs.json')
export const WORKFLOW_EVENTS_FILE = path.join(WORKFLOW_STORE_DIR, 'job-events.jsonl')
export const MOCK_WORKFLOW_STEP_DELAY = Number(process.env.MOCK_WORKFLOW_STEP_DELAY || 650)
export const HUNYUAN_3D_MODEL_COST_CNY = Number(process.env.HUNYUAN_3D_MODEL_COST_CNY || 1)
export const TENCENT_HUNYUAN_CONFIGURED = Boolean(
  process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY && process.env.TENCENT_HUNYUAN_3D_ENDPOINT
)
export const SUPPORTED_WORKFLOW_PROVIDERS = ['local-demo', 'tencent-hunyuan']

export const DEMO_MODELS = [
  {
    id: 'cellforge-tripo-plant',
    fileName: 'tripo-plant-cell-test.glb',
    name: 'Tripo 植物细胞样例',
    subtitle: '3DCellForge 缓存生成模型',
    category: 'AI 生成示意模型',
    accent: '#7fb069',
    imageHint: 'plant-cell',
    description:
      '来自 3DCellForge 的 Tripo 缓存样例模型，用于验证图片转 3D 生成结果进入 LearningCell 展示链路后的浏览效果。',
    template: 'plant-cell',
  },
  {
    id: 'cellforge-tripo-epithelial',
    fileName: 'tripo-epithelial-cell-test.glb',
    name: 'Tripo 上皮细胞样例',
    subtitle: '3DCellForge 缓存生成模型',
    category: 'AI 生成示意模型',
    accent: '#e8859a',
    imageHint: 'animal-cell',
    description:
      '来自 3DCellForge 的 epithelial cell 生成样例，用于演示外部 image-to-3D 生成资产如何被缓存并加载到 LearningCell 的 3D 舞台。',
    template: 'animal-cell',
  },
]
