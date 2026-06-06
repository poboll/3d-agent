import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { COMFYUI_WORKFLOW_TEMPLATE } from '../server/config.mjs'
import { getModelExtension, sanitizeModelId, validateModelBuffer } from '../server/model-store.mjs'
import {
  buildBioReadyPrompt,
  normalizeImageGenerationOptions,
  normalizeImagePromptOverride,
  normalizeReferencePrompt,
  validateImageBuffer,
} from '../server/reference-store.mjs'
import { sanitizeFileName } from '../server/http-utils.mjs'
import { DEFAULT_IMAGE_PROVIDER, WORKFLOW_JOBS_FILE } from '../server/config.mjs'
import { isAnalyticsEventAllowed } from '../server/analytics-store.mjs'
import { isTransientComfyError, normalizeComfyFetchError, scrubComfyEndpoint } from '../server/comfyui-provider.mjs'
import { formatModelBytes, getModelLoadHint, isHeavyModel } from '../app/src/lib/modelWeight.ts'
import { getWorkflowWaitHint } from '../app/src/lib/workflowWait.ts'
import { buildJobHistorySummary } from '../app/src/lib/jobHistory.ts'
import { buildGenerationTimeline } from '../app/src/lib/workflowTimeline.ts'
import { buildWorkflowPhaseBoard } from '../app/src/lib/workflowPhaseBoard.ts'
import { buildWorkflowNextAction } from '../app/src/lib/workflowNextAction.ts'
import { buildWorkflowPreflight } from '../app/src/lib/workflowPreflight.ts'
import { createWorkflowJob } from '../server/job-store.mjs'
import {
  chooseTemplateForPrompt,
  createPromptTitle,
  estimateGenerationCost,
  getTemplateDisplayName,
  isRecoverableWorkflowJob,
  isResumableSelfhostWorkflowJob,
  normalizeImageProvider,
  normalizeImageProfile,
  normalizePrompt,
  normalizeProvider,
  normalizeWorkflowImageProvider,
} from '../server/workflow-utils.mjs'

describe('LearningCell fusion API utilities', () => {
  it('sanitizes file and model names', () => {
    assert.equal(sanitizeFileName('../plant cell ✨.glb'), 'plant cell .glb')
    assert.equal(sanitizeModelId('local plant cell.glb'), 'local-plant-cell')
  })

  it('detects supported model extensions', () => {
    assert.equal(getModelExtension('cell.glb'), 'glb')
    assert.equal(getModelExtension('cell.gltf'), 'gltf')
    assert.throws(() => getModelExtension('cell.obj'), /GLB/)
  })

  it('validates GLB and GLTF buffers', () => {
    assert.doesNotThrow(() => validateModelBuffer(Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28)]), 'glb'))
    assert.throws(() => validateModelBuffer(Buffer.concat([Buffer.from('nope'), Buffer.alloc(28)]), 'glb'), /GLB/)
    assert.doesNotThrow(() => validateModelBuffer(Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(40)), 'gltf'))
  })

  it('validates supported reference image signatures', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(40),
    ])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)])
    assert.doesNotThrow(() => validateImageBuffer(png, 'png'))
    assert.doesNotThrow(() => validateImageBuffer(jpeg, 'jpg'))
    assert.throws(() => validateImageBuffer(Buffer.concat([Buffer.from('not-image'), Buffer.alloc(40)]), 'png'), /PNG/)
  })

  it('normalizes workflow input and provider names', () => {
    assert.equal(normalizePrompt('  叶绿体   植物细胞 结构  '), '叶绿体 植物细胞 结构')
    assert.throws(() => normalizePrompt('细胞'), /更具体/)
    assert.equal(normalizeReferencePrompt('线粒体'), '线粒体')
    assert.throws(() => normalizeReferencePrompt('x'), /生物结构术语/)
    assert.equal(normalizeImagePromptOverride(''), '')
    assert.throws(() => normalizeImagePromptOverride('too short'), /过短/)
    assert.throws(() => normalizeImagePromptOverride('x'.repeat(2401)), /2400/)
    assert.equal(normalizeProvider('selfhost-triposg'), 'selfhost-triposg')
    assert.equal(normalizeProvider('local-demo'), 'local-demo')
    assert.equal(normalizeProvider(''), 'selfhost-triposg')
    assert.equal(normalizeImageProvider('openai'), 'openai')
    assert.equal(normalizeImageProvider('local-gateway'), 'local-gateway')
    assert.equal(normalizeImageProvider(''), DEFAULT_IMAGE_PROVIDER)
    assert.equal(normalizeImageProfile('fast'), 'fast')
    assert.equal(normalizeImageProfile('detailed'), 'detailed')
    assert.equal(normalizeImageProfile('nope'), 'standard')
    assert.equal(normalizeWorkflowImageProvider('upload'), 'upload')
    assert.throws(() => normalizeProvider('unknown'), /provider/)
    assert.throws(() => normalizeImageProvider('unknown'), /图片生成/)
  })

  it('chooses sensible model templates from prompts', () => {
    assert.equal(chooseTemplateForPrompt('展示植物细胞、叶绿体和细胞壁'), 'plant-cell')
    assert.equal(chooseTemplateForPrompt('线粒体开放剖面'), 'mitochondrion')
    assert.equal(chooseTemplateForPrompt('叶绿体开放剖面 3D 教学模型，突出类囊体、基粒和双层膜'), 'chloroplast')
    assert.equal(chooseTemplateForPrompt('杆状细菌教学模型'), 'bacterium')
    assert.equal(chooseTemplateForPrompt('DNA 双螺旋和碱基对'), 'dna')
    assert.equal(chooseTemplateForPrompt('神经元轴突树突结构'), 'neuron')
    assert.equal(chooseTemplateForPrompt('白细胞吞噬病原体'), 'white-blood-cell')
    assert.equal(chooseTemplateForPrompt('上皮动物细胞结构'), 'animal-cell')
    assert.equal(chooseTemplateForPrompt('whatever', 'dna'), 'dna')
  })

  it('builds 3D-ready image prompts from biology terms', async () => {
    const result = await buildBioReadyPrompt('线粒体开放剖面教学模型', 'auto')
    assert.equal(result.term, '线粒体')
    assert.match(result.imagePrompt, /bean-shaped mitochondrion/)
    assert.match(result.imagePrompt, /three-quarter open cutaway/)
    assert.match(result.negativePrompt, /transparent jelly/)
  })

  it('normalizes image generation profiles for the local gateway', () => {
    assert.deepEqual(normalizeImageGenerationOptions({}), {
      profile: 'standard',
      size: '1536x1536',
      quality: 'high',
      label: '标准教学',
    })
    assert.deepEqual(normalizeImageGenerationOptions({ imageProfile: 'fast' }), {
      profile: 'fast',
      size: '1024x1024',
      quality: 'medium',
      label: '快速预览',
    })
    assert.deepEqual(normalizeImageGenerationOptions({ imageProfile: 'detailed' }), {
      profile: 'detailed',
      size: '2048x2048',
      quality: 'high',
      label: '精细单图',
    })
    assert.deepEqual(normalizeImageGenerationOptions({ imageProfile: 'unknown', imageSize: 'bad', imageQuality: 'ultra' }), {
      profile: 'standard',
      size: '1536x1536',
      quality: 'high',
      label: '标准教学',
    })
  })

  it('builds customer-facing titles and cost estimates', () => {
    assert.equal(createPromptTitle('  复杂植物细胞三维模型，包含叶绿体和液泡  '), '复杂植物细胞三维模型包含叶绿体和...')
    assert.equal(getTemplateDisplayName('plant-cell'), '植物细胞')
    assert.equal(getTemplateDisplayName('mitochondrion'), '线粒体')
    assert.equal(getTemplateDisplayName('unknown'), '生物结构')
    assert.equal(estimateGenerationCost('local-demo'), 0)
    assert.equal(estimateGenerationCost('tencent-hunyuan') > 0, true)
  })

  it('defaults workflow jobs to the configured local image gateway', async () => {
    let job
    try {
      job = await createWorkflowJob({
        prompt: '叶绿体开放剖面 3D 教学模型，突出类囊体和基粒',
        provider: 'local-demo',
        template: 'chloroplast',
        deferReference: true,
        imageProfile: 'fast',
      })

      assert.equal(job.imageProvider, DEFAULT_IMAGE_PROVIDER)
      assert.equal(job.imageProfile, 'fast')
      assert.equal(job.imageSize, '1024x1024')
      assert.equal(job.imageQuality, 'medium')
    } finally {
      if (job?.id) await removeWorkflowJobFromStore(job.id)
    }
  })

  it('preserves confirmed image prompts for full text-to-3D jobs', async () => {
    const imagePromptOverride = [
      'Botanical biology teaching model, single 3D-ready square reference image, three-quarter open cutaway plant cell.',
      'Show cell wall, chloroplasts, nucleus and large vacuole as readable sculptural forms with soft studio light.',
      'Use clean beige background, centered object, no labels, no multiple views, suitable for TripoSG image-to-3D.',
    ].join(' ')
    let job
    try {
      job = await createWorkflowJob({
        prompt: '植物细胞开放剖面 3D 教学模型，突出叶绿体、细胞壁和大型液泡',
        provider: 'local-demo',
        template: 'plant-cell',
        deferReference: true,
        imagePromptOverride,
      })

      assert.equal(job.workflowMode, 'full-text-to-3d')
      assert.equal(job.imagePromptOverride, imagePromptOverride)
    } finally {
      if (job?.id) await removeWorkflowJobFromStore(job.id)
    }
  })

  it('accepts frontend workflow analytics used by the generation panel', () => {
    assert.equal(isAnalyticsEventAllowed('workflow_prompt_confirm'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_prompt_regenerate'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_full_reference_ready'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_job_prompt_reuse'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_job_manual_sync'), true)
    assert.equal(isAnalyticsEventAllowed('workflow_result_review_action'), true)
    assert.equal(isAnalyticsEventAllowed('unknown_workflow_event'), false)
  })

  it('labels large generated GLB files for lighter classroom loading', () => {
    assert.equal(formatModelBytes(60656016), '57.8 MB')
    assert.equal(isHeavyModel(60656016), true)
    assert.equal(isHeavyModel(2838504), false)
    assert.equal(getModelLoadHint(60656016), '重模型 · 建议加载完成后再切换标本')
    assert.equal(getModelLoadHint(2838504), '轻量模型 · 可快速预览')
  })

  it('describes long-running generation without growing the queue UI', () => {
    assert.equal(getWorkflowWaitHint(45, 'image'), null)
    assert.match(getWorkflowWaitHint(90, 'image').label, /后台仍在生成/)
    assert.match(getWorkflowWaitHint(90, 'image').hint, /1536x1536/)
    assert.match(getWorkflowWaitHint(220, 'modeling').label, /可稍后恢复/)
    assert.match(getWorkflowWaitHint(220, 'modeling').hint, /final\.glb/)
    assert.match(getWorkflowWaitHint(90, 'modeling').hint, /标本列表/)
    assert.match(getWorkflowWaitHint(330, 'queue').label, /建议同步状态/)
    assert.match(getWorkflowWaitHint(330, 'queue').hint, /队列/)
  })

  it('uses the finalized single-image ComfyUI workflow with Bio3D postprocess', async () => {
    const workflow = JSON.parse(await readFile(COMFYUI_WORKFLOW_TEMPLATE, 'utf8'))

    assert.equal(workflow['2']?.class_type, 'TripoSGImageTo3D')
    assert.equal(workflow['3']?.class_type, 'Hunyuan3DPaintExistingMesh')
    assert.equal(workflow['4']?.class_type, 'Bio3DPostProcessGLB')
    assert.equal(workflow['5']?.class_type, 'Preview3D')
    assert.deepEqual(workflow['4']?.inputs?.model_3d, ['3', 1])
    assert.deepEqual(workflow['5']?.inputs?.model_file, ['4', 1])
    assert.equal(workflow['4']?.inputs?.output_prefix, 'bio_single_final')
  })

  it('normalizes transient ComfyUI network failures for recovery', () => {
    const fetchError = new TypeError('fetch failed')
    const normalized = normalizeComfyFetchError(fetchError, '查询 ComfyUI 任务历史', 'http://47.242.195.8:8010/history/abc?client=secret')

    assert.equal(isTransientComfyError(fetchError), true)
    assert.match(normalized.message, /查询 ComfyUI 任务历史失败/)
    assert.match(normalized.message, /同步状态/)
    assert.equal(normalized.endpoint, 'http://47.242.195.8:8010/history/abc')
    assert.equal(scrubComfyEndpoint('http://47.242.195.8:8010/view?filename=model.glb&token=secret'), 'http://47.242.195.8:8010/view')
  })

  it('summarizes job history instead of rendering a long queue', () => {
    const jobs = [
      makeJob('job-live', 'processing', '线粒体开放剖面教学模型'),
      makeJob('job-done', 'completed', '叶绿体开放剖面教学模型'),
      makeJob('job-failed', 'failed', '植物细胞完整教学模型'),
      makeJob('job-old-1', 'completed', '植物细胞完整教学模型'),
      makeJob('job-old-2', 'completed', '白细胞吞噬过程教学模型'),
      makeJob('job-old-3', 'completed', 'DNA 双螺旋教学模型'),
    ]
    const active = makeJob('job-active', 'queued', '动物细胞 3D 教学模型')
    const summary = buildJobHistorySummary(jobs, active)

    assert.equal(summary.visible.length, 2)
    assert.deepEqual(summary.visible.map((job) => job.id), ['job-active', 'job-live'])
    assert.equal(summary.hiddenCount, 5)
    assert.equal(summary.totalCount, 7)
    assert.equal(summary.liveCount, 2)
  })

  it('keeps the job history summary pinned to a compact visible set', () => {
    const jobs = Array.from({ length: 12 }, (_, index) => makeJob(`job-${index}`, index === 0 ? 'processing' : 'completed', `生物结构 ${index} 教学模型`))
    const summary = buildJobHistorySummary(jobs, null)

    assert.equal(summary.visible.length, 2)
    assert.equal(summary.hiddenCount, 10)
    assert.equal(summary.totalCount, 12)
    assert.equal(summary.visible[0].id, 'job-0')
  })

  it('replaces stale completed active jobs with newer completed jobs for the same prompt', () => {
    const active = {
      ...makeJob('job-old-active', 'completed', '叶绿体开放剖面教学模型'),
      updatedAt: '2026-05-24T01:03:15.000Z',
    }
    const jobs = [
      {
        ...makeJob('job-new-completed', 'completed', '叶绿体开放剖面教学模型'),
        updatedAt: '2026-05-24T01:23:36.000Z',
      },
      makeJob('job-live-different', 'processing', '线粒体开放剖面教学模型'),
    ]

    const summary = buildJobHistorySummary(jobs, active)

    assert.equal(summary.visible.length, 2)
    assert.equal(summary.visible[0].id, 'job-new-completed')
    assert.equal(summary.visible[1].id, 'job-live-different')
  })

  it('summarizes resumable self-hosted failures before old completed jobs', () => {
    const failedSelfhost = {
      ...makeJob('job-selfhost-failed', 'failed', '线粒体远端三维任务'),
      provider: 'selfhost-triposg',
      providerJobId: 'comfy-prompt-123',
      updatedAt: '2026-05-23T03:59:00.000Z',
    }
    const jobs = [
      makeJob('job-done-a', 'completed', '叶绿体教学模型'),
      makeJob('job-done-b', 'completed', '植物细胞教学模型'),
      makeJob('job-done-c', 'completed', 'DNA 教学模型'),
      failedSelfhost,
    ]
    const summary = buildJobHistorySummary(jobs, null)

    assert.equal(summary.visible.length, 2)
    assert.equal(summary.visible[0].id, failedSelfhost.id)
    assert.equal(summary.hiddenCount, 2)
  })

  it('builds a clear full-generation timeline for the workbench', () => {
    const idle = buildGenerationTimeline({
      prompt: '植物细胞 3D 教学模型',
      promptPreviewReady: false,
      referenceReady: false,
      referenceAccepted: false,
      activeJob: null,
      busy: false,
      imageProviderLabel: '本地图片网关',
      imageSpecLabel: '标准教学 1536x1536',
      modelProviderLabel: '本地 TripoSG + 混元贴图',
    })
    assert.equal(idle.currentLabel, '可生成参考图')
    assert.equal(idle.steps.find((step) => step.id === 'input').state, 'done')
    assert.equal(idle.steps.find((step) => step.id === 'prompt').state, 'idle')
    assert.match(idle.nextAction, /预览 Prompt/)

    const live = buildGenerationTimeline({
      prompt: '叶绿体开放剖面 3D 教学模型',
      promptPreviewReady: true,
      referenceReady: true,
      referenceAccepted: true,
      activeJob: { ...makeJob('job-modeling', 'processing', '叶绿体开放剖面 3D 教学模型'), referenceId: 'ref-1', workflowMode: 'full-text-to-3d' },
      busy: true,
      imageProviderLabel: '本地图片网关',
      imageSpecLabel: '快速预览 1024x1024',
      modelProviderLabel: '本地 TripoSG + 混元贴图',
    })
    assert.equal(live.currentLabel, '正在图生3D')
    assert.equal(live.steps.find((step) => step.id === 'modeling').state, 'active')
    assert.match(live.nextAction, /正在建模与贴图/)

    const done = buildGenerationTimeline({
      prompt: '线粒体开放剖面 3D 教学模型',
      promptPreviewReady: true,
      referenceReady: true,
      referenceAccepted: true,
      activeJob: { ...makeJob('job-done-timeline', 'completed', '线粒体开放剖面 3D 教学模型'), result: { modelUrl: '/api/3d/local-model/demo.glb' } },
      busy: false,
      imageProviderLabel: '本地图片网关',
      imageSpecLabel: '标准教学 1536x1536',
      modelProviderLabel: '本地 TripoSG + 混元贴图',
    })
    assert.equal(done.state, 'done')
    assert.equal(done.currentLabel, '模型已入库')
    assert.equal(done.steps.find((step) => step.id === 'library').state, 'done')
  })

  it('builds a compact phase board for long text-to-3d tasks', () => {
    const imageJob = {
      ...makeJob('job-image-phase', 'processing', '线粒体 3D-ready 单图'),
      workflowMode: 'full-text-to-3d',
      imageProvider: 'local-gateway',
      imageProfile: 'standard',
      imageSize: '1536x1536',
      imageQuality: 'high',
      createdAt: '2026-05-23T04:00:00.000Z',
      updatedAt: '2026-05-23T04:01:00.000Z',
    }
    const imageBoard = buildWorkflowPhaseBoard({
      prompt: imageJob.prompt,
      activeJob: imageJob,
      referenceImage: null,
      referenceAccepted: false,
      busy: true,
      now: Date.parse('2026-05-23T04:03:10.000Z'),
      operationStartedAt: null,
      imageProviderLabel: '本地图片网关',
      imageSpecLabel: '标准教学 1536x1536',
      modelProviderLabel: 'TripoSG + 混元贴图',
    })

    assert.equal(imageBoard.title, '正在生成参考图')
    assert.equal(imageBoard.phases.find((phase) => phase.id === 'reference').state, 'active')
    assert.match(imageBoard.summary, /1536x1536/)
    assert.match(imageBoard.queueNote, /避免队列面板一直向下增长/)
    assert.equal(imageBoard.phases.find((phase) => phase.id === 'reference')?.meta, '本地图片网关')

    const modelingBoard = buildWorkflowPhaseBoard({
      prompt: '线粒体开放剖面 3D 教学模型',
      activeJob: { ...makeJob('job-modeling-phase', 'processing', '线粒体开放剖面 3D 教学模型'), referenceId: 'ref-1', workflowMode: 'full-text-to-3d' },
      referenceImage: { id: 'ref-1' },
      referenceAccepted: true,
      busy: true,
      now: Date.parse('2026-05-23T04:08:00.000Z'),
      operationStartedAt: Date.parse('2026-05-23T04:00:00.000Z'),
      imageProviderLabel: '本地图片网关',
      imageSpecLabel: '标准教学 1536x1536',
      modelProviderLabel: 'TripoSG + 混元贴图',
    })

    assert.equal(modelingBoard.title, '正在图生 3D')
    assert.equal(modelingBoard.phases.find((phase) => phase.id === 'modeling').state, 'active')
    assert.equal(modelingBoard.phases.find((phase) => phase.id === 'reference')?.meta, '标准教学 1536x1536')
    assert.match(modelingBoard.phases.find((phase) => phase.id === 'modeling').hint, /final\.glb/)
  })

  it('recommends the next workflow action from the current state', () => {
    const base = {
      prompt: '植物细胞 3D 教学模型',
      busy: false,
      referenceImage: null,
      referenceAccepted: false,
      activeJob: null,
      canResumeActiveJob: false,
      syncing: false,
    }

    assert.equal(buildWorkflowNextAction({ ...base, prompt: '' }).id, 'write-prompt')
    assert.equal(buildWorkflowNextAction(base).id, 'generate-reference')
    assert.equal(buildWorkflowNextAction({ ...base, referenceImage: { id: 'ref-1' } }).id, 'accept-reference')
    assert.equal(buildWorkflowNextAction({ ...base, referenceImage: { id: 'ref-1' }, referenceAccepted: true }).id, 'confirm-modeling')

    assert.equal(
      buildWorkflowNextAction({
        ...base,
        busy: true,
        activeJob: { ...makeJob('job-live-next', 'processing', '线粒体开放剖面'), referenceId: 'ref-1' },
      }).id,
      'sync-job'
    )

    assert.equal(
      buildWorkflowNextAction({
        ...base,
        activeJob: {
          ...makeJob('job-done-next', 'completed', '线粒体开放剖面'),
          result: { modelUrl: '/api/3d/local-model/mitochondrion.glb' },
        },
      }).id,
      'view-model'
    )

    assert.equal(
      buildWorkflowNextAction({
        ...base,
        canResumeActiveJob: true,
        activeJob: { ...makeJob('job-resume-next', 'failed', '线粒体开放剖面'), providerJobId: 'prompt-1', provider: 'selfhost-triposg' },
      }).id,
      'resume-job'
    )
  })

  it('summarizes local gateway and self-hosted 3D preflight status', () => {
    const status = makeProviderStatus()
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'ok')
    assert.match(preflight.title, /通过/)
    assert.match(preflight.summary, /均可用/)
    assert.equal(preflight.checks.length, 5)
    assert.equal(preflight.checks.find((check) => check.id === 'image')?.value, 'gpt-image-2 · 48760')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, '0/0')
  })

  it('warns when OpenAI direct image route is unavailable but local gateway can be used', () => {
    const status = makeProviderStatus()
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'openai',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'warn')
    assert.match(preflight.recommendation, /切回 48760/)
    assert.match(preflight.checks.find((check) => check.id === 'image')?.hint || '', /disabled/)
  })

  it('detects recoverable workflow jobs without reviving stale or completed work', () => {
    const now = Date.parse('2026-05-23T04:00:00.000Z')
    const baseJob = {
      id: 'job-1',
      prompt: '线粒体开放剖面模型',
      provider: 'local-demo',
      status: 'processing',
      updatedAt: '2026-05-23T03:58:00.000Z',
    }

    assert.equal(isRecoverableWorkflowJob(baseJob, { now }), true)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'queued' }, { now }), true)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'completed' }, { now }), false)
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, status: 'failed' }, { now }), false)
    assert.equal(
      isRecoverableWorkflowJob({ ...baseJob, updatedAt: '2026-05-22T23:00:00.000Z' }, { now }),
      false
    )
    assert.equal(isRecoverableWorkflowJob({ ...baseJob, prompt: '' }, { now }), false)
  })

  it('allows only recent self-hosted ComfyUI jobs to be manually resumed', () => {
    const now = Date.parse('2026-05-23T04:00:00.000Z')
    const baseJob = {
      id: 'job-resume-1',
      prompt: '线粒体开放剖面模型',
      provider: 'selfhost-triposg',
      providerJobId: 'comfy-prompt-123',
      template: 'mitochondrion',
      status: 'failed',
      updatedAt: '2026-05-23T03:58:00.000Z',
    }

    assert.equal(isResumableSelfhostWorkflowJob(baseJob, { now }), true)
    assert.equal(isResumableSelfhostWorkflowJob({ ...baseJob, status: 'processing' }, { now }), true)
    assert.equal(isResumableSelfhostWorkflowJob({ ...baseJob, providerJobId: '' }, { now }), false)
    assert.equal(isResumableSelfhostWorkflowJob({ ...baseJob, provider: 'local-demo' }, { now }), false)
    assert.equal(isResumableSelfhostWorkflowJob({ ...baseJob, status: 'completed' }, { now }), false)
    assert.equal(
      isResumableSelfhostWorkflowJob({ ...baseJob, updatedAt: '2026-05-21T03:58:00.000Z' }, { now }),
      false
    )
  })
})

async function removeWorkflowJobFromStore(jobId) {
  try {
    const raw = await readFile(WORKFLOW_JOBS_FILE, 'utf8')
    const payload = JSON.parse(raw)
    if (!Array.isArray(payload.jobs)) return
    payload.jobs = payload.jobs.filter((job) => job.id !== jobId)
    await writeFile(WORKFLOW_JOBS_FILE, JSON.stringify(payload, null, 2))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

function makeJob(id, status, prompt) {
  return {
    id,
    prompt,
    provider: 'local-demo',
    template: 'plant-cell',
    status,
    stage: '测试任务',
    progress: status === 'completed' ? 100 : status === 'failed' ? 70 : 38,
    costEstimateCny: 0,
    createdAt: '2026-05-23T03:50:00.000Z',
    updatedAt: '2026-05-23T03:58:00.000Z',
    workflowMode: status === 'queued' ? 'full-text-to-3d' : 'image-to-3d',
  }
}

function makeProviderStatus() {
  return {
    image: {
      localGateway: {
        configured: true,
        baseUrl: 'http://127.0.0.1:48760',
        promptModel: 'gpt-5.5',
        imageModel: 'gpt-image-2',
        imageSize: '1536x1536',
        imageQuality: 'high',
        health: { ok: true, status: 200, message: 'ok' },
        models: { ok: true, status: 200, message: 'ok', modelIds: ['gpt-image-2'] },
      },
      openai: {
        configured: true,
        baseUrl: 'https://api.anhesea.top:9443/v1',
        imageModel: 'gpt-5.5',
        imageToolModel: 'gpt-image-2',
        imageSize: '1536x1536',
        imageQuality: 'high',
        auth: { ok: false, status: 401, message: 'API key is disabled' },
      },
    },
    model3d: {
      selfhostTriposg: {
        configured: true,
        baseUrl: 'http://47.242.195.8:8010',
        status: {
          ok: true,
          queue: { running: 0, pending: 0 },
        },
      },
      localCache: { configured: true },
      tencentHunyuan: { configured: false },
    },
  }
}
