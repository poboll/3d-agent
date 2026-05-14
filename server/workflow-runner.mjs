import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CELLFORGE_MODEL_DIR,
  DEMO_MODELS,
  LOCAL_MODEL_DIR,
  MOCK_WORKFLOW_STEP_DELAY,
  TENCENT_HUNYUAN_CONFIGURED,
} from './config.mjs'
import { sanitizeModelId } from './model-store.mjs'
import { getTemplateDisplayName } from './workflow-utils.mjs'
import { updateWorkflowJob } from './job-store.mjs'

export function startWorkflowJob(job) {
  if (job.provider === 'tencent-hunyuan' && !TENCENT_HUNYUAN_CONFIGURED) {
    void updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '腾讯混元生 3D provider 尚未配置，当前仅开放本地演示工作流。',
        error: '缺少 TENCENT_SECRET_ID、TENCENT_SECRET_KEY 或 TENCENT_HUNYUAN_3D_ENDPOINT。',
      },
      'provider-not-configured'
    )
    return
  }

  void runLocalDemoWorkflow(job).catch((error) => {
    void updateWorkflowJob(
      job.id,
      {
        status: 'failed',
        progress: 100,
        stage: '生成任务失败。',
        error: error.message || '本地生成工作流执行失败。',
      },
      'failed'
    )
  })
}

async function runLocalDemoWorkflow(job) {
  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 22,
      stage: '正在整理文本提示词，生成适合图片到 3D 的结构描述。',
    },
    'prompt-refined'
  )

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 48,
      stage: '参考图阶段已模拟完成，正在进入 3D 生成与模型缓存。',
    },
    'reference-image-ready'
  )

  const demoModel = pickDemoModel(job.template)
  const sourcePath = path.join(CELLFORGE_MODEL_DIR, demoModel.fileName)
  await stat(sourcePath)

  await delay(MOCK_WORKFLOW_STEP_DELAY)
  await updateWorkflowJob(
    job.id,
    {
      status: 'processing',
      progress: 76,
      stage: '正在写入本地 GLB 缓存，准备交给 LearningCell 查看器。',
    },
    'model-caching'
  )

  await mkdir(LOCAL_MODEL_DIR, { recursive: true })
  const targetName = `${sanitizeModelId(`generated-${job.id}-${job.template}`)}.glb`
  const targetPath = path.join(LOCAL_MODEL_DIR, targetName)
  await copyFile(sourcePath, targetPath)
  const info = await stat(targetPath)

  await delay(Math.round(MOCK_WORKFLOW_STEP_DELAY * 0.6))
  await updateWorkflowJob(
    job.id,
    {
      status: 'completed',
      progress: 100,
      stage: '生成模型已完成，可在左侧生成模型列表中打开。',
      result: {
        id: `generated-${job.id}`,
        name: `AI 生成：${getTemplateDisplayName(job.template)}`,
        subtitle: '文本生成生物模型',
        category: 'AI 生成示意模型',
        accent: demoModel.accent,
        description: `根据「${job.prompt}」创建的本地演示模型。当前版本复用 3DCellForge 缓存 GLB 验证端到端链路，真实 provider 接入后将替换为云端生成结果。`,
        fileName: targetName,
        fileSize: info.size,
        imageHint: job.template,
        template: job.template,
        provider: '本地演示工作流',
        modelUrl: `/api/3d/local-model/${encodeURIComponent(targetName)}`,
      },
    },
    'completed'
  )
}

function pickDemoModel(template) {
  if (template === 'plant-cell') return DEMO_MODELS[0]
  return DEMO_MODELS[1] || DEMO_MODELS[0]
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
