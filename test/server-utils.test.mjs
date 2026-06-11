import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE, COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE, COMFYUI_WORKFLOW_TEMPLATE, DEFAULT_IMAGE_PROVIDER, WORKFLOW_JOBS_FILE } from '../server/config.mjs'
import { getModelExtension, sanitizeModelId, validateModelBuffer } from '../server/model-store.mjs'
import {
  buildBioReadyPrompt,
  buildLocalGatewayImageRouteStatus,
  extractGatewayModelIds,
  LOCAL_GATEWAY_STATUS_LIMITS,
  normalizeLocalGatewayModelsCacheRecord,
  normalizeImageGenerationOptions,
  normalizeImagePromptOverride,
  normalizeReferencePrompt,
  publicLocalGatewayModelsCacheRecord,
  selectLocalGatewayRouteModels,
  summarizeLocalGatewayImageFailure,
  validateImageBuffer,
} from '../server/reference-store.mjs'
import { sanitizeFileName } from '../server/http-utils.mjs'
import { isAnalyticsEventAllowed } from '../server/analytics-store.mjs'
import {
  COMFYUI_DIAGNOSTIC_LIMITS,
  COMFYUI_MEMORY_RELEASE,
  COMFYUI_OUTPUT_SETTLE_LIMITS,
  COMFYUI_RESOURCE_LIMITS,
  COMFYUI_STATUS_LIMITS,
  classifyComfyServiceError,
  evaluateComfyResourceGuard,
  evaluateComfyTextureSubmissionGuard,
  clearTextureRuntimeBackoff,
  getTextureRuntimeBackoff,
  isTransientComfyError,
  normalizeComfyFetchError,
  pruneComfyHistoryCache,
  recoverComfyHistoryItemWithOutputs,
  recordTextureRuntimeBackoff,
  scrubComfyEndpoint,
  selectComfyHistoryCacheEntries,
  shouldEnhanceTexturedDisplay,
  summarizeComfyQueue,
  summarizeComfyHistoryOutputs,
  textureBackoffKey,
  writeColorizedDisplayModel,
} from '../server/comfyui-provider.mjs'
import { formatModelBytes, getModelLoadDetail, getModelLoadHint, isHeavyModel } from '../app/src/lib/modelWeight.ts'
import { getWorkflowWaitHint } from '../app/src/lib/workflowWait.ts'
import { buildJobHistorySummary } from '../app/src/lib/jobHistory.ts'
import { buildGenerationTimeline } from '../app/src/lib/workflowTimeline.ts'
import { buildWorkflowPhaseBoard } from '../app/src/lib/workflowPhaseBoard.ts'
import { buildWorkflowNextAction } from '../app/src/lib/workflowNextAction.ts'
import { buildWorkflowPreflight } from '../app/src/lib/workflowPreflight.ts'
import { buildModelRoleRail, buildRuntimeRail, buildTextureResourcePlan, buildWorkflowGuardSummary } from '../app/src/lib/workflowRuntime.ts'
import { WORKFLOW_STORE_RETENTION, compactWorkflowJobs, createTextureEnhancementJob, createWorkflowJob } from '../server/job-store.mjs'
import { colorizeGlbBuffer, colorizeGlbFile } from '../server/glb-colorizer.mjs'
import {
  evaluateTextureGate,
  inspectGlbBuffer,
  isUsableColoredModel,
  normalizeTextureStabilityMode,
  normalizeTextureStabilityOptions,
  readLatestConsecutiveStabilityReport,
  selectTextureSourceJob,
  summarizeProviderStatus,
  summarizeStabilityReport,
} from '../scripts/texture-stability-check.mjs'
import { selectTextureArtifactJobs } from '../server/texture-artifacts.mjs'
import {
  buildTextureCompletionStage,
  canRestartSelfhostAfterMissingHistory,
  isTextureResourceFallbackReason,
} from '../server/workflow-runner.mjs'
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
  normalizeTextureMode,
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
    assert.equal(normalizeTextureMode('fallback-color'), 'fallback-color')
    assert.equal(normalizeTextureMode('other'), 'stable')
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
      assert.equal(job.textureMode, 'stable')
    } finally {
      if (job?.id) await removeWorkflowJobFromStore(job.id)
    }
  })

  it('stores requested Hunyuan texture mode on self-hosted workflow jobs', async () => {
    let job
    try {
      job = await createWorkflowJob({
        prompt: '线粒体开放剖面 3D 教学模型，突出嵴结构',
        provider: 'selfhost-triposg',
        template: 'mitochondrion',
        deferReference: true,
        textureMode: 'hunyuan',
      })

      assert.equal(job.textureMode, 'hunyuan')
      assert.equal(job.workflowMode, 'full-text-to-3d')
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
    assert.equal(getModelLoadHint(60656016), '重模型 · 已启用轻量渲染并保留光影')
    assert.match(getModelLoadDetail(60656016), /保留阴影、环境贴图和主光/)
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
    assert.equal(workflow['3']?.class_type, 'Bio3DPostProcessGLB')
    assert.equal(workflow['4']?.class_type, 'Preview3D')
    assert.deepEqual(workflow['3']?.inputs?.model_3d, ['2', 1])
    assert.deepEqual(workflow['4']?.inputs?.model_file, ['3', 1])
    assert.equal(workflow['3']?.inputs?.output_prefix, 'bio_single_final')
  })

  it('keeps the optional Hunyuan texture workflow wired after TripoSG', async () => {
    const workflow = JSON.parse(await readFile(COMFYUI_HY3DPAINT_WORKFLOW_TEMPLATE, 'utf8'))

    assert.equal(workflow['2']?.class_type, 'TripoSGImageTo3D')
    assert.equal(workflow['3']?.class_type, 'Hunyuan3DPaintExistingMesh')
    assert.equal(workflow['4']?.class_type, 'Bio3DPostProcessGLB')
    assert.equal(workflow['5']?.class_type, 'Preview3D')
    assert.deepEqual(workflow['3']?.inputs?.model_3d, ['2', 0])
    assert.deepEqual(workflow['3']?.inputs?.image, ['1', 0])
    assert.deepEqual(workflow['4']?.inputs?.model_3d, ['3', 1])
    assert.deepEqual(workflow['5']?.inputs?.model_file, ['4', 1])
    assert.equal(workflow['3']?.inputs?.output_prefix, 'bio_single_hy3dpaint_textured')
    assert.equal(workflow['4']?.inputs?.polish_materials, false)
    assert.ok(COMFYUI_RESOURCE_LIMITS.hy3dpaintSteps >= 10)
  })

  it('uses a separate existing-mesh Hunyuan texture workflow without rerunning TripoSG', async () => {
    const workflow = JSON.parse(await readFile(COMFYUI_HY3DPAINT_EXISTING_MESH_WORKFLOW_TEMPLATE, 'utf8'))
    const nodeTypes = Object.values(workflow).map((node) => node.class_type)

    assert.equal(nodeTypes.includes('TripoSGImageTo3D'), false)
    assert.equal(workflow['1']?.class_type, 'LoadImage')
    assert.equal(workflow['2']?.class_type, 'Hunyuan3DPaintExistingMesh')
    assert.equal(workflow['3']?.class_type, 'Bio3DPostProcessGLB')
    assert.equal(workflow['4']?.class_type, 'Preview3D')
    assert.equal(typeof workflow['2']?.inputs?.model_3d, 'string')
    assert.match(workflow['2']?.inputs?.model_3d, /bio_existing_raw\.glb/)
    assert.deepEqual(workflow['2']?.inputs?.image, ['1', 0])
    assert.deepEqual(workflow['3']?.inputs?.model_3d, ['2', 1])
    assert.deepEqual(workflow['4']?.inputs?.model_file, ['3', 1])
    assert.equal(workflow['3']?.inputs?.polish_materials, false)
  })

  it('normalizes transient ComfyUI network failures for recovery', () => {
    const fetchError = new TypeError('fetch failed')
    const normalized = normalizeComfyFetchError(fetchError, '查询 ComfyUI 任务历史', 'http://47.242.195.8:8010/history/abc?client=secret')

    assert.equal(isTransientComfyError(fetchError), true)
    assert.match(normalized.message, /查询 ComfyUI 任务历史失败/)
    assert.match(normalized.message, /诊断远端/)
    assert.match(normalized.message, /续接输出/)
    assert.equal(normalized.recoverable, true)
    const timeout = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const timeoutError = normalizeComfyFetchError(timeout, '查询 ComfyUI 任务历史', 'http://47.242.195.8:8010/history/timeout-id')
    assert.match(timeoutError.message, /任务历史超时/)
    assert.match(timeoutError.message, /续接输出/)
    assert.equal(timeoutError.recoverable, true)
    assert.equal(isTransientComfyError(timeoutError), true)
    assert.equal(normalized.endpoint, 'http://47.242.195.8:8010/history/abc')
    assert.equal(scrubComfyEndpoint('http://47.242.195.8:8010/view?filename=model.glb&token=secret'), 'http://47.242.195.8:8010/view')
  })

  it('classifies ComfyUI cold start and unreachable states for resumable jobs', () => {
    const socketError = new TypeError('fetch failed')
    socketError.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' }
    const coldStart = classifyComfyServiceError(socketError)
    assert.equal(coldStart.state, 'cold_starting')
    assert.equal(coldStart.recoverable, true)
    assert.match(coldStart.message, /冷启动|OOM/)

    const refused = Object.assign(new Error('connect ECONNREFUSED 47.242.195.8:8010'), { code: 'ECONNREFUSED' })
    const unreachable = classifyComfyServiceError(refused)
    assert.equal(unreachable.state, 'unreachable')
    assert.equal(unreachable.recoverable, true)

    const badGateway = Object.assign(new Error('检查 ComfyUI 服务失败：HTTP 502'), { status: 502, recoverable: true })
    const gatewayState = classifyComfyServiceError(badGateway)
    assert.equal(isTransientComfyError(badGateway), true)
    assert.equal(gatewayState.state, 'unreachable')
    assert.equal(gatewayState.recoverable, true)
  })

  it('recognizes partial GLB outputs when later ComfyUI nodes fail', () => {
    const history = {
      status: {
        status_str: 'error',
        messages: [
          ['execution_error', { exception_message: 'Hunyuan3D-Paint OOM' }],
        ],
      },
      outputs: {
        2: {
          result: [
            {
              filename: 'learningcell-job_raw_20260524.glb',
              subfolder: '3d',
              type: 'output',
            },
          ],
        },
      },
    }
    const diagnostics = summarizeComfyHistoryOutputs(history)

    assert.ok(diagnostics.outputs.length >= 1)
    assert.equal(diagnostics.hasExecutionError, true)
    assert.match(diagnostics.recommendation, /raw GLB/)
  })

  it('does not treat ComfyUI exception text as real textured GLB output', () => {
    const history = {
      status: {
        status_str: 'error',
        messages: [
          ['execution_error', {
            exception_message: [
              'Hunyuan3D-Paint timed out.',
              '/home/kk/projects/3d/ComfyUI/output/3d/fake_painted.glb',
            ].join(' '),
          }],
        ],
      },
      outputs: {
        2: {
          text: [
            'TripoSG GLB saved: /home/kk/projects/3d/ComfyUI/output/3d/real_raw.glb',
          ],
        },
      },
    }
    const diagnostics = summarizeComfyHistoryOutputs(history)

    assert.equal(diagnostics.outputs.length, 1)
    assert.equal(diagnostics.outputs[0].fileName, 'real_raw.glb')
    assert.equal(diagnostics.outputs.some((output) => /painted/i.test(output.fileName)), false)
    assert.match(diagnostics.recommendation, /raw GLB/)
  })

  it('recommends raw fallback instead of textured success when Hunyuan paint times out', () => {
    const history = {
      prompt: [
        3,
        'prompt-id',
        {
          3: {
            class_type: 'Hunyuan3DPaintExistingMesh',
            inputs: {
              output_prefix: 'learningcell-job_painted',
            },
          },
        },
      ],
      status: {
        status_str: 'error',
        messages: [
          ['execution_error', {
            node_type: 'Hunyuan3DPaintExistingMesh',
            exception_message: [
              'Hunyuan3D-Paint timed out before producing textured GLB.',
              'Command: /home/kk/projects/3d/bin/run_hy3dpaint_3080.sh',
              '--output /home/kk/projects/3d/ComfyUI/output/3d/learningcell-job_painted_20260525.glb',
            ].join(' '),
          }],
        ],
      },
      outputs: {
        2: {
          text: [
            'TripoSG GLB saved: /home/kk/projects/3d/ComfyUI/output/3d/learningcell-job_raw_20260525.glb',
          ],
        },
      },
    }
    const diagnostics = summarizeComfyHistoryOutputs(history)

    assert.equal(diagnostics.outputs.length, 1)
    assert.equal(diagnostics.outputs[0].fileName, 'learningcell-job_raw_20260525.glb')
    assert.equal(diagnostics.outputs.some((output) => /painted|textured/i.test(output.fileName || '')), false)
    assert.match(diagnostics.recommendation, /raw GLB/)
  })

  it('recovers a painted GLB from interrupted Hunyuan history before using fallback', async () => {
    const promptId = 'prompt-painted-recovered'
    const historyItem = {
      prompt: [
        0,
        promptId,
        {
          2: {
            class_type: 'Hunyuan3DPaintExistingMesh',
            inputs: {
              output_prefix: 'learningcell-job_painted',
            },
          },
          3: {
            class_type: 'Bio3DPostProcessGLB',
            inputs: {
              output_prefix: 'learningcell-job_final',
            },
          },
        },
      ],
      outputs: {
        2: {
          text: [
            'Hunyuan3D-Paint textured GLB saved: /home/kk/projects/3d/ComfyUI/output/3d/learningcell-job_painted_20260526-203841.glb',
          ],
        },
      },
      status: {
        status_str: 'error',
        completed: false,
        messages: [
          ['execution_interrupted', {
            prompt_id: promptId,
            node_id: '3',
            node_type: 'Bio3DPostProcessGLB',
            executed: ['1', '2'],
          }],
        ],
      },
    }

    const recovered = await recoverComfyHistoryItemWithOutputs(promptId, { [promptId]: historyItem })
    const diagnostics = summarizeComfyHistoryOutputs(recovered)

    assert.equal(recovered, historyItem)
    assert.equal(diagnostics.outputs.length, 1)
    assert.equal(diagnostics.outputs[0].fileName, 'learningcell-job_painted_20260526-203841.glb')
    assert.equal(diagnostics.outputs.some((output) => /painted|textured/i.test(output.fileName || '')), true)
    assert.match(diagnostics.recommendation, /textured GLB/)
  })

  it('marks successful ComfyUI history without GLB as recoverable missing output', () => {
    const history = {
      status: {
        status_str: 'success',
        messages: [['execution_success', { prompt_id: 'prompt-without-glb' }]],
      },
      outputs: {
        4: {
          result: [{ filename: 'preview.png', type: 'output' }],
        },
      },
    }
    const diagnostics = summarizeComfyHistoryOutputs(history)

    assert.equal(diagnostics.outputs.length, 0)
    assert.equal(diagnostics.missingGlb, true)
    assert.match(diagnostics.recommendation, /未发现 GLB/)
  })

  it('keeps ComfyUI diagnostics short and non-retrying for responsive UI', () => {
    assert.equal(COMFYUI_DIAGNOSTIC_LIMITS.queueTimeoutMs, 5000)
    assert.equal(COMFYUI_DIAGNOSTIC_LIMITS.historyTimeoutMs, 7000)
    assert.equal(COMFYUI_DIAGNOSTIC_LIMITS.retries, 0)
  })

  it('does not treat an unreachable ComfyUI queue as an empty queue', () => {
    const missingQueue = summarizeComfyQueue(null, 'prompt-123')
    assert.equal(missingQueue.ok, false)
    assert.equal(missingQueue.running, 0)
    assert.equal(missingQueue.pending, 0)
    assert.match(missingQueue.message, /不可达|不能据此判断/)

    const emptyQueue = summarizeComfyQueue({ queue_running: [], queue_pending: [] }, 'prompt-123')
    assert.equal(emptyQueue.ok, true)
    assert.equal(emptyQueue.running, 0)
    assert.equal(emptyQueue.pending, 0)
    assert.match(emptyQueue.message, /队列为空/)
  })

  it('keeps ComfyUI status checks short so preflight does not block the workbench', () => {
    assert.equal(COMFYUI_STATUS_LIMITS.systemStatsTimeoutMs, 6000)
    assert.equal(COMFYUI_STATUS_LIMITS.queueTimeoutMs, 6000)
    assert.equal(COMFYUI_STATUS_LIMITS.retries, 0)
  })

  it('requests ComfyUI memory release after heavy self-hosted jobs', () => {
    assert.equal(COMFYUI_MEMORY_RELEASE.enabled, true)
    assert.equal(COMFYUI_MEMORY_RELEASE.timeoutMs, 12000)
    assert.equal(COMFYUI_MEMORY_RELEASE.historyCacheLimit, 60)
  })

  it('uses a guarded low-memory ComfyUI profile by default', () => {
    assert.equal(COMFYUI_RESOURCE_LIMITS.enabled, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.steps, 16)
    assert.equal(COMFYUI_RESOURCE_LIMITS.faces, 12000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.guidanceScale, 6)
    assert.equal(COMFYUI_RESOURCE_LIMITS.minRamFreeGb, 10)
    assert.equal(COMFYUI_RESOURCE_LIMITS.minVramFreeGb, 6)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintEnabled, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintMinRamFreeGb, 16.5)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintMinTotalRamGb, 19)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintLowMemoryTotalRamGb, 24)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintLowMemoryRemoteEnabled, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintMinVramFreeGb, 14)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintRuntimeMinRamFreeGb, 5.5)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintRuntimeMinVramFreeGb, 8)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintRuntimeGuardGracePolls, 1)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintRuntimeFallbackBackoffCount, 2)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintRuntimeFallbackBackoffMs, 3 * 60 * 60 * 1000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintAbortOnUnobservable, false)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintPollIntervalMs, 5000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFullRetryOnTimeout, false)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFullWorkflowFirst, false)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintSteps, 10)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFaces, 3000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintGuidanceScale, 4)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFullWorkflowSteps, 12)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFullWorkflowFaces, 6000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintFullWorkflowGuidanceScale, 5)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintStableSteps, 12)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintStableFaces, 3000)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintStableGuidanceScale, 5)
    assert.match(COMFYUI_RESOURCE_LIMITS.hy3dpaintExistingMeshWorkflowTemplate, /bio_existing_mesh_hy3dpaint_postprocess_api\.json/)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintAutoFallback, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintStaleHistoryLimit, 80)
    assert.equal(COMFYUI_RESOURCE_LIMITS.hy3dpaintUnobservableRecoveryLimit, 48)
    assert.equal(COMFYUI_RESOURCE_LIMITS.maxLocalPending, 1)
    assert.equal(COMFYUI_RESOURCE_LIMITS.blockWhenRemoteBusy, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.preflightFreeBeforeGuard, true)
    assert.equal(COMFYUI_RESOURCE_LIMITS.historyCacheLimit, 60)

    const lowRam = evaluateComfyResourceGuard({
      ok: true,
      ram: { available: 5 * 1024 ** 3 },
      gpu: [{ vramFree: 12 * 1024 ** 3 }],
    })
    assert.equal(lowRam.ok, false)
    assert.equal(lowRam.reason, 'ram-low')

    const enough = evaluateComfyResourceGuard({
      ok: true,
      ram: { available: 12 * 1024 ** 3 },
      gpu: [{ vramFree: 8 * 1024 ** 3 }],
    })
    assert.equal(enough.ok, true)

    const hy3dLowRam = evaluateComfyResourceGuard({
      ok: true,
      ram: { total: 32 * 1024 ** 3, available: 12 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 18,
        minVramFreeGb: 14,
      },
    })
    assert.equal(hy3dLowRam.ok, false)
    assert.equal(hy3dLowRam.reason, 'ram-low')

    const hy3dLowTotalRam = evaluateComfyResourceGuard({
      ok: true,
      ram: { total: 18 * 1024 ** 3, available: 17 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 16,
        minVramFreeGb: 14,
      },
    })
    assert.equal(hy3dLowTotalRam.ok, false)
    assert.equal(hy3dLowTotalRam.reason, 'ram-total-low')

    const hy3dEnough = evaluateComfyResourceGuard({
      ok: true,
      ram: { total: 32 * 1024 ** 3, available: 19 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 18,
        minVramFreeGb: 14,
      },
    })
    assert.equal(hy3dEnough.ok, true)
  })

  it('marks idle 20GB hosts as low-memory instead of hard-blocking them', () => {
    const guard = evaluateComfyResourceGuard({
      ok: true,
      ram: { available: 12 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 18,
        minVramFreeGb: 14,
      },
    })
    assert.equal(guard.ok, false)
    assert.equal(guard.reason, 'ram-low')

    const lowMemoryTotalGuard = evaluateComfyResourceGuard({
      ok: true,
      ram: { total: 20 * 1024 ** 3, available: 19 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 18,
        minVramFreeGb: 14,
      },
    })
    assert.equal(lowMemoryTotalGuard.ok, true)
    assert.equal(lowMemoryTotalGuard.lowMemoryMode, true)

    const tooSmallTotalGuard = evaluateComfyResourceGuard({
      ok: true,
      ram: { total: 18 * 1024 ** 3, available: 17 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
    }, {
      profile: {
        textured: true,
        minRamFreeGb: 16,
        minVramFreeGb: 14,
      },
    })
    assert.equal(tooSmallTotalGuard.ok, false)
    assert.equal(tooSmallTotalGuard.reason, 'ram-total-low')
    assert.match(tooSmallTotalGuard.message, /总内存/)
  })

  it('allows guarded low-memory remote Hunyuan texture attempts on idle 20GB hosts', () => {
    const lowMemoryHost = evaluateComfyTextureSubmissionGuard({
      ok: true,
      ram: { total: 20 * 1024 ** 3, available: 19 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
      queue: { running: 0, pending: 0 },
    })

    assert.equal(lowMemoryHost.ok, true)
    assert.equal(lowMemoryHost.reason, 'low-memory-remote-ready')
    assert.equal(lowMemoryHost.autoFallback, false)
    assert.equal(lowMemoryHost.lowMemoryMode, true)
    assert.match(lowMemoryHost.message, /20GB 低内存贴图试跑/)
    assert.match(lowMemoryHost.message, /运行中低于/)

    const readyHost = evaluateComfyTextureSubmissionGuard({
      ok: true,
      ram: { total: 32 * 1024 ** 3, available: 20 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
      queue: { running: 0, pending: 0 },
    })

    assert.equal(readyHost.ok, true)
    assert.equal(readyHost.reason, 'ready')
    assert.equal(readyHost.autoFallback, false)
  })

  it('backs off repeated Hunyuan runtime guards for the same resolved raw mesh', () => {
    const rawJob = {
      id: 'job-backoff-source',
      sourceJobId: 'job-backoff-source',
      rawModelUrl: '/api/3d/local-model/raw-backoff.glb',
      rawMeshServerPath: '/home/kk/projects/3d/ComfyUI/output/3d/raw-backoff.glb',
    }
    const pendingJob = {
      id: 'job-backoff-next',
      sourceJobId: 'job-backoff-source',
      rawModelUrl: '/api/3d/local-model/raw-backoff.glb',
      rawMeshServerPath: '/home/kk/projects/3d/ComfyUI/output/3d/raw-backoff.glb',
    }

    try {
      assert.equal(textureBackoffKey(rawJob), textureBackoffKey(pendingJob))
      assert.equal(getTextureRuntimeBackoff(pendingJob), null)
      assert.equal(recordTextureRuntimeBackoff(rawJob, new Error('runtime guard')).active, false)
      const recorded = recordTextureRuntimeBackoff(rawJob, new Error('runtime guard'))
      assert.equal(recorded.active, true)
      const backoff = getTextureRuntimeBackoff(pendingJob)
      assert.equal(backoff.active, true)
      assert.match(backoff.message, /连续 2 次/)
    } finally {
      clearTextureRuntimeBackoff(rawJob)
    }
  })

  it('can still force local fallback on 20GB hosts when remote low-memory texture is disabled', () => {
    const lowMemoryHost = evaluateComfyTextureSubmissionGuard({
      ok: true,
      ram: { total: 20 * 1024 ** 3, available: 19 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
      queue: { running: 0, pending: 0 },
    }, {
      lowMemoryRemoteEnabled: false,
    })

    assert.equal(lowMemoryHost.ok, false)
    assert.equal(lowMemoryHost.reason, 'low-memory-remote-disabled')
    assert.equal(lowMemoryHost.autoFallback, true)
    assert.match(lowMemoryHost.message, /不提交远端贴图/)
  })

  it('describes low-memory Hunyuan skips as protected texture fallback completions', () => {
    const lowMemoryReason = '服务器总内存约 20GB，处于 20GB 低内存模式；实测 Hunyuan3D-Paint 会把可用 RAM 压到危险区，默认不提交远端贴图，改用稳定 GLB 的本地轻量贴图 fallback。'
    assert.equal(isTextureResourceFallbackReason(lowMemoryReason), true)
    assert.equal(isTextureResourceFallbackReason('low-memory-remote-disabled'), true)
    assert.equal(isTextureResourceFallbackReason('Hunyuan3D-Paint timed out before producing textured GLB.'), false)

    assert.match(
      buildTextureCompletionStage({
        effectiveTextureMode: 'fallback-color',
        textureFallbackReason: lowMemoryReason,
      }),
      /20G 资源保护/
    )
    assert.match(
      buildTextureCompletionStage({
        effectiveTextureMode: 'fallback-color',
        textureFallbackReason: '混元贴图运行中可用内存约 5.2GB，低于 5.5GB 运行熔断线；已主动中断混元贴图任务，保留稳定 raw GLB，避免触发 OOM。',
      }, 'enhance'),
      /触发运行硬熔断/
    )
    assert.match(
      buildTextureCompletionStage({
        effectiveTextureMode: 'fallback-color',
        textureFallbackReason: 'Hunyuan3D-Paint timed out before producing textured GLB.',
      }, 'enhance'),
      /未产出 textured GLB/
    )
  })

  it('does not submit Hunyuan texture while the remote ComfyUI queue is busy', () => {
    const guard = evaluateComfyTextureSubmissionGuard({
      ok: true,
      ram: { total: 32 * 1024 ** 3, available: 24 * 1024 ** 3 },
      gpu: [{ vramFree: 18 * 1024 ** 3 }],
      queue: { running: 1, pending: 0 },
    })

    assert.equal(guard.ok, false)
    assert.equal(guard.reason, 'remote-queue-busy')
    assert.equal(guard.autoFallback, true)
    assert.match(guard.message, /远端 ComfyUI 队列/)
    assert.match(guard.message, /不会提交 Hunyuan3D-Paint/)
  })

  it('waits briefly for ComfyUI GLB outputs to settle before asking for resume', () => {
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.emptyOutputRetryLimit, 6)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.staleHistoryLimit, 8)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.historyRecoveryLimit, 36)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.historyPollTimeoutMs, 20000)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.queuePollTimeoutMs, 8000)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.unobservableRecoveryLimit, 3)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.hy3dpaintStaleHistoryLimit, 80)
    assert.equal(COMFYUI_OUTPUT_SETTLE_LIMITS.hy3dpaintUnobservableRecoveryLimit, 48)
  })

  it('keeps local image gateway status checks lightweight while generation keeps long timeouts', () => {
    assert.equal(LOCAL_GATEWAY_STATUS_LIMITS.healthTimeoutMs, 3000)
    assert.equal(LOCAL_GATEWAY_STATUS_LIMITS.modelsTimeoutMs, 3500)
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

  it('keeps queue wait copy focused on a compact task summary', () => {
    const hint = getWorkflowWaitHint(88, 'queue')

    assert.ok(hint)
    assert.equal(hint?.label, '后台仍在生成')
    assert.match(hint?.hint || '', /关键任务摘要/)
    assert.doesNotMatch(hint?.hint || '', /关键 3 条/)
  })

  it('compacts workflow jobs while keeping live and recoverable self-hosted tasks', () => {
    const oldCompleted = Array.from({ length: 4 }, (_, index) => ({
      ...makeJob(`job-old-${index}`, 'completed', `旧任务 ${index} 教学模型`),
      updatedAt: `2026-05-23T03:5${index}:00.000Z`,
    }))
    const live = {
      ...makeJob('job-live', 'processing', '正在生成的线粒体模型'),
      updatedAt: '2026-05-23T03:10:00.000Z',
    }
    const recoverable = {
      ...makeJob('job-recoverable', 'failed', '可续接远端任务'),
      provider: 'selfhost-triposg',
      providerJobId: 'prompt-keep-me',
      updatedAt: '2026-05-23T03:11:00.000Z',
    }
    const newestCompleted = {
      ...makeJob('job-newest', 'completed', '最新完成任务'),
      updatedAt: '2026-05-23T04:30:00.000Z',
    }

    const compact = compactWorkflowJobs([...oldCompleted, live, recoverable, newestCompleted], 3)

    assert.deepEqual(compact.map((job) => job.id), ['job-live', 'job-recoverable', 'job-newest'])
    assert.equal(WORKFLOW_STORE_RETENTION.jobLimit, 80)
    assert.equal(WORKFLOW_STORE_RETENTION.eventLimit, 800)
    assert.equal(WORKFLOW_STORE_RETENTION.eventCompactInterval, 40)
  })

  it('keeps only the newest ComfyUI history cache entries for long-running stability', async () => {
    const selected = selectComfyHistoryCacheEntries([
      { name: 'comfyui-old.json', mtimeMs: 1 },
      { name: 'comfyui-new.json', mtimeMs: 3 },
      { name: 'comfyui-mid.json', mtimeMs: 2 },
    ], 2)

    assert.deepEqual(selected.keep.map((item) => item.name), ['comfyui-new.json', 'comfyui-mid.json'])
    assert.deepEqual(selected.stale.map((item) => item.name), ['comfyui-old.json'])

    const disabled = await pruneComfyHistoryCache(0)
    assert.equal(disabled.skipped, true)
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
      modelProviderLabel: '本地 TripoSG + Bio3D',
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
      modelProviderLabel: '本地 TripoSG + Bio3D',
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
      modelProviderLabel: '本地 TripoSG + Bio3D',
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
      modelProviderLabel: 'TripoSG + Bio3D',
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
      modelProviderLabel: 'TripoSG + Bio3D',
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
      model3dReady: true,
      syncing: false,
    }

    assert.equal(buildWorkflowNextAction({ ...base, prompt: '' }).id, 'write-prompt')
    assert.equal(buildWorkflowNextAction(base).id, 'generate-reference')
    assert.equal(buildWorkflowNextAction({ ...base, referenceImage: { id: 'ref-1' } }).id, 'accept-reference')
    assert.equal(buildWorkflowNextAction({ ...base, referenceImage: { id: 'ref-1' }, referenceAccepted: true }).id, 'confirm-modeling')
    const blockedNextAction = buildWorkflowNextAction({
      ...base,
      referenceImage: { id: 'ref-1' },
      referenceAccepted: true,
      model3dReady: false,
      model3dBlockedKind: 'resource',
      model3dBlockedReason: '资源保护已生效：服务器可用内存约 9.9GB，低于 10GB 安全线。',
    })
    assert.equal(blockedNextAction.id, 'refresh-preflight')
    assert.equal(blockedNextAction.title, '3D 资源保护中')
    assert.match(blockedNextAction.hint, /9\.9GB/)

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

    const diagnoseFirst = buildWorkflowNextAction({
      ...base,
      canResumeActiveJob: true,
      canDiagnoseActiveJob: true,
      resumeShouldDiagnoseFirst: true,
      resumeBlockedReason: '远端 queue/history 暂不可观测。',
      activeJob: { ...makeJob('job-diagnose-next', 'failed', '线粒体开放剖面'), providerJobId: 'prompt-2', provider: 'selfhost-triposg' },
    })
    assert.equal(diagnoseFirst.id, 'diagnose-job')
    assert.equal(diagnoseFirst.targetTestId, 'diagnose-active-job')
    assert.match(diagnoseFirst.hint, /queue\/history/)
  })

  it('summarizes local gateway and self-hosted 3D preflight status', () => {
    const status = makeProviderStatus()
    status.image.localGateway.imageRoute = {
      ok: true,
      state: 'ready',
      message: '图片模型路由已匹配：gpt-image-2。',
      requestedModels: ['gpt-image-2'],
      matchedModels: ['gpt-image-2'],
      availableModelIds: ['gpt-5.5', 'gpt-5.2', 'gpt-image-2'],
    }
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

    const roleRail = buildModelRoleRail({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    assert.equal(roleRail.find((item) => item.id === 'prompt-model')?.value, 'gpt-5.5')
    assert.equal(roleRail.find((item) => item.id === 'image-model')?.value, 'gpt-image-2')
    assert.equal(roleRail.find((item) => item.id === 'image-route')?.value, 'gpt-image-2')
    assert.notEqual(roleRail.find((item) => item.id === 'image-model')?.value, 'gpt-5.2')
  })

  it('separates local gateway health from an unavailable image upstream route', () => {
    const route = buildLocalGatewayImageRouteStatus({
      configured: true,
      imageModel: 'gpt-image-2',
      imageModelFallbacks: ['gpt-image-1.5', 'gpt-image-1'],
      models: {
        ok: true,
        status: 200,
        message: 'ok',
        modelIds: ['gpt-5.2', 'gpt-5.4'],
      },
    })
    assert.equal(route.ok, false)
    assert.equal(route.state, 'model-missing')
    assert.match(route.message, /图片模型/)

    const status = makeProviderStatus()
    status.image.localGateway.models.modelIds = ['gpt-5.2', 'gpt-5.4']
    status.image.localGateway.imageRoute = route
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })
    const rail = buildRuntimeRail({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })

    assert.equal(preflight.state, 'warn')
    assert.equal(preflight.checks.find((check) => check.id === 'image')?.value, '上游需检查')
    assert.match(preflight.checks.find((check) => check.id === 'image')?.hint || '', /上传图片继续图生 3D/)
    assert.equal(rail.find((item) => item.id === 'gateway')?.value, '需检查')
    assert.equal(rail.find((item) => item.id === 'gateway')?.state, 'warn')
  })

  it('keeps image models that appear after long gateway model lists', () => {
    const payload = {
      data: [
        ...Array.from({ length: 14 }, (_, index) => ({ id: `text-model-${index + 1}` })),
        { id: 'gpt-image-2' },
        { id: 'gpt-image-1.5' },
      ],
    }
    const modelIds = extractGatewayModelIds(payload)
    const route = buildLocalGatewayImageRouteStatus({
      configured: true,
      imageModel: 'gpt-image-2',
      imageModelFallbacks: ['gpt-image-1.5', 'gpt-image-1'],
      models: {
        ok: true,
        status: 200,
        message: 'ok',
        modelIds,
      },
    })

    assert.equal(modelIds.length, 16)
    assert.equal(route.ok, true)
    assert.equal(route.state, 'ready')
    assert.deepEqual(route.matchedModels, ['gpt-image-2', 'gpt-image-1.5'])
  })

  it('keeps the local image route ready from recent cache when models status times out', () => {
    const routeModels = selectLocalGatewayRouteModels({
      models: {
        ok: false,
        status: 504,
        message: '本地图片网关模型检查超时。',
      },
      cachedModels: {
        ok: true,
        status: 200,
        message: 'ok',
        modelIds: ['gpt-5.5', 'gpt-image-2'],
        checkedAt: '2026-05-27T02:00:00.000Z',
        ageMs: 12000,
      },
    })
    const route = buildLocalGatewayImageRouteStatus({
      configured: true,
      imageModel: 'gpt-image-2',
      imageModelFallbacks: ['gpt-image-1.5', 'gpt-image-1'],
      models: routeModels,
    })

    assert.equal(routeModels.cached, true)
    assert.equal(routeModels.sourceStatus, 504)
    assert.equal(route.ok, true)
    assert.equal(route.state, 'ready-cached')
    assert.equal(route.cached, true)
    assert.match(route.message, /暂用最近成功状态/)
    assert.deepEqual(route.matchedModels, ['gpt-image-2'])
  })

  it('normalizes persisted local image route cache and drops stale records', () => {
    const now = Date.parse('2026-05-27T02:10:00.000Z')
    const record = normalizeLocalGatewayModelsCacheRecord(
      {
        ok: true,
        status: 200,
        modelIds: ['gpt-5.5', 'gpt-image-2', 'gpt-image-2', ''],
      },
      { now }
    )

    assert.deepEqual(record.modelIds, ['gpt-5.5', 'gpt-image-2'])
    const fresh = publicLocalGatewayModelsCacheRecord(record, { now: now + 30_000 })
    assert.equal(fresh.ok, true)
    assert.equal(fresh.ageMs, 30_000)
    assert.deepEqual(fresh.modelIds, ['gpt-5.5', 'gpt-image-2'])
    assert.equal(publicLocalGatewayModelsCacheRecord(record, { now: now + 11 * 60_000 }), null)
    assert.equal(publicLocalGatewayModelsCacheRecord({ ok: true, modelIds: [] }, { now }), null)
  })

  it('surfaces recent local gateway image generation failures after model route match', () => {
    const route = buildLocalGatewayImageRouteStatus({
      configured: true,
      imageModel: 'gpt-image-2',
      imageModelFallbacks: ['gpt-image-1.5', 'gpt-image-1'],
      models: {
        ok: true,
        status: 200,
        message: 'ok',
        modelIds: ['gpt-5.5', 'gpt-image-2'],
      },
      lastImageError: {
        at: '2026-05-26T10:00:00.000Z',
        status: 502,
        model: 'gpt-image-2',
        message: 'Upstream service temporarily unavailable',
        attempts: ['gpt-image-2#1: Upstream service temporarily unavailable'],
        retryAfterMs: 120000,
      },
    })

    assert.equal(route.ok, false)
    assert.equal(route.state, 'image-upstream-error')
    assert.equal(route.recoverable, true)
    assert.match(route.message, /最近一次真实生图失败/)
    assert.equal(route.lastImageError.status, 502)
  })

  it('summarizes local image upstream failures without leaking long request ids', () => {
    const summary = summarizeLocalGatewayImageFailure(
      Object.assign(new Error('本地图片网关未返回可用图片。gpt-image-2#1: type=upstream_error Upstream service temporarily unavailable [request_id=secret-1]'), { status: 502 }),
      [
        'gpt-image-2#1: type=upstream_error Upstream service temporarily unavailable [request_id=secret-1]',
        'gpt-image-1.5#1: type=upstream_error Upstream service temporarily unavailable [request_id=secret-2]',
      ],
    )

    assert.match(summary, /gpt-image-2 \/ gpt-image-1\.5/)
    assert.match(summary, /upstream_error \/ 502/)
    assert.doesNotMatch(summary, /request_id/)
  })

  it('shows local protected self-host queue when the API is serializing heavy jobs', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.runtime = {
      running: 1,
      pending: 2,
      runningJobId: 'job-running',
      pendingJobIds: ['job-next-a', 'job-next-b'],
    }
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'pending')
    assert.equal(preflight.title, '3D 队列保护中')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, '本地保护 1/2')
    assert.match(preflight.checks.find((check) => check.id === 'model')?.hint || '', /队列保护/)
    assert.match(preflight.recommendation, /ComfyUI 队列清空/)
  })

  it('keeps self-hosted 3D pending while the remote ComfyUI queue is busy', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.resourceGuard = {
      enabled: true,
      minRamFreeGb: 10,
      minVramFreeGb: 6,
      steps: 16,
      faces: 12000,
      blockWhenRemoteBusy: true,
    }
    status.model3d.selfhostTriposg.runtime = {
      running: 0,
      pending: 0,
      maxPending: 1,
      blockWhenRemoteBusy: true,
    }
    status.model3d.selfhostTriposg.status.queue = { running: 1, pending: 0 }

    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })
    const rail = buildRuntimeRail({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    const summary = buildWorkflowGuardSummary({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })

    assert.equal(preflight.state, 'pending')
    assert.equal(preflight.title, '3D 队列保护中')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, '远端保护 1/0')
    assert.match(preflight.checks.find((check) => check.id === 'model')?.hint || '', /避免并发触发 OOM/)
    assert.equal(rail.find((item) => item.id === 'remote')?.value, '队列保护')
    assert.equal(rail.find((item) => item.id === 'remote')?.state, 'pending')
    assert.equal(summary.title, '队列保护中')
    assert.equal(summary.chips.find((chip) => chip.id === 'model')?.value, '队列保护')
    assert.equal(summary.chips.find((chip) => chip.id === 'queue')?.value, '远端 1/0')
  })

  it('builds a compact runtime rail for gateway, queue and resource headroom', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.runtime = {
      running: 1,
      pending: 1,
      runningJobId: 'job-running',
      pendingJobIds: ['job-next'],
    }
    status.model3d.selfhostTriposg.status.gpu = [
      {
        name: 'cuda:0 NVIDIA GeForce RTX 3080',
        type: 'cuda',
        vramTotal: 20 * 1024 ** 3,
        vramFree: 15 * 1024 ** 3,
      },
    ]
    status.model3d.selfhostTriposg.status.ram = {
      total: 20 * 1024 ** 3,
      available: 12 * 1024 ** 3,
    }
    status.model3d.selfhostTriposg.resourceGuard = {
      enabled: true,
      minRamFreeGb: 10,
      minVramFreeGb: 6,
      steps: 16,
      faces: 12000,
      guidanceScale: 6,
    }
    const rail = buildRuntimeRail({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })

    assert.equal(rail.length, 6)
    assert.equal(rail.find((item) => item.id === 'gateway')?.value, '可生成')
    assert.equal(rail.find((item) => item.id === 'queue')?.value, '1/1')
    assert.equal(rail.find((item) => item.id === 'queue')?.state, 'pending')
    assert.equal(rail.find((item) => item.id === 'ram')?.value, '12GB')
    assert.equal(rail.find((item) => item.id === 'ram')?.state, 'ok')
    assert.equal(rail.find((item) => item.id === 'gpu')?.value, '75%')
    assert.equal(rail.find((item) => item.id === 'gpu')?.state, 'ok')
  })

  it('shows a guarded Hunyuan texture plan for idle 20GB hosts', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.texture.lowMemoryRemoteEnabled = true
    status.model3d.selfhostTriposg.texture.minRamFreeGb = 16.5
    status.model3d.selfhostTriposg.texture.minTotalRamGb = 19
    status.model3d.selfhostTriposg.texture.runtimeBackoffCount = 2
    status.model3d.selfhostTriposg.texture.runtimeBackoffMs = 3 * 60 * 60 * 1000
    status.model3d.selfhostTriposg.texture.steps = 10
    status.model3d.selfhostTriposg.texture.faces = 3000
    status.model3d.selfhostTriposg.status.ram = {
      total: 20 * 1024 ** 3,
      available: 18 * 1024 ** 3,
    }
    status.model3d.selfhostTriposg.status.gpu = [
      {
        name: 'cuda:0 NVIDIA GeForce RTX 3080',
        type: 'cuda',
        vramTotal: 20 * 1024 ** 3,
        vramFree: 18 * 1024 ** 3,
      },
    ]

    const plan = buildTextureResourcePlan({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'hunyuan',
    })

    assert.equal(plan.state, 'ok')
    assert.match(plan.title, /20GB/)
    assert.match(plan.detail, /32GB/)
    assert.match(plan.detail, /连续 2 次熔断/)
    assert.match(plan.detail, /退避约 3 小时/)
    assert.equal(plan.strategy.label, '提交策略')
    assert.equal(plan.strategy.value, '可试跑混元')
    assert.equal(plan.strategy.state, 'ok')
    assert.match(plan.strategy.detail, /20GB 低内存档/)
    assert.equal(plan.items.find((item) => item.id === 'memory')?.value, '18GB / 20GB')
    assert.equal(plan.items.find((item) => item.id === 'memory')?.state, 'ok')
    assert.equal(plan.items.find((item) => item.id === 'vram')?.value, '18GB / 20GB')
    assert.equal(plan.items.find((item) => item.id === 'vram')?.state, 'ok')
    assert.equal(plan.items.find((item) => item.id === 'profile')?.value, '10 steps / 3000 faces')
    assert.equal(plan.items.find((item) => item.id === 'time')?.value, '15-45 分钟')
    assert.equal(plan.items.find((item) => item.id === 'time')?.state, 'pending')
  })

  it('shows a fallback-first texture strategy when low-memory remote paint is disabled', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.texture.lowMemoryRemoteEnabled = false
    status.model3d.selfhostTriposg.texture.minTotalRamGb = 19
    status.model3d.selfhostTriposg.status.ram = {
      total: 20 * 1024 ** 3,
      available: 18 * 1024 ** 3,
    }
    status.model3d.selfhostTriposg.status.gpu = [
      {
        name: 'cuda:0 NVIDIA GeForce RTX 3080',
        type: 'cuda',
        vramTotal: 20 * 1024 ** 3,
        vramFree: 18 * 1024 ** 3,
      },
    ]

    const plan = buildTextureResourcePlan({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'hunyuan',
    })

    assert.equal(plan.state, 'pending')
    assert.equal(plan.strategy.value, 'fallback 优先')
    assert.equal(plan.strategy.state, 'warn')
    assert.match(plan.strategy.detail, /禁用远端低内存贴图/)
  })

  it('does not mark self-hosted 3D online before a deep status check', () => {
    const status = makeProviderStatus()
    delete status.model3d.selfhostTriposg.status
    const rail = buildRuntimeRail({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    const summary = buildWorkflowGuardSummary({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(rail.find((item) => item.id === 'remote')?.value, '待同步')
    assert.equal(rail.find((item) => item.id === 'remote')?.state, 'pending')
    assert.equal(summary.state, 'pending')
    assert.equal(summary.chips.find((chip) => chip.id === 'model')?.value, '待同步')
    assert.equal(preflight.state, 'pending')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, '待同步')
  })

  it('shows resource guard pressure in workflow preflight', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.status.ram = {
      total: 20 * 1024 ** 3,
      available: 4 * 1024 ** 3,
    }
    status.model3d.selfhostTriposg.resourceGuard = {
      enabled: true,
      minRamFreeGb: 10,
      minVramFreeGb: 6,
      steps: 16,
      faces: 12000,
      guidanceScale: 6,
    }
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'pending')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, 'RAM 4.0GB')
    assert.match(preflight.checks.find((check) => check.id === 'model')?.hint || '', /资源保护/)

    const summary = buildWorkflowGuardSummary({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    assert.equal(summary.state, 'pending')
    assert.equal(summary.title, '资源保护中')
    assert.equal(summary.chips.find((chip) => chip.id === 'resource')?.value, '资源保护')
    assert.equal(summary.chips.find((chip) => chip.id === 'model')?.value, '受保护')
    assert.equal(preflight.title, '3D 资源保护中')
    assert.match(preflight.recommendation, /参考图/)
  })

  it('keeps preflight pending instead of hard failing while self-hosted 3D is cold-starting', () => {
    const status = makeProviderStatus()
    status.model3d.selfhostTriposg.status = {
      ok: false,
      state: 'cold_starting',
      recoverable: true,
      message: '自部署 3D 服务正在冷启动或刚从 OOM 重启恢复，稍后会自动重试。',
    }
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'pending')
    assert.equal(preflight.checks.find((check) => check.id === 'model')?.value, '冷启动')
    assert.match(preflight.checks.find((check) => check.id === 'model')?.hint || '', /自动重试/)

    const summary = buildWorkflowGuardSummary({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
    })
    assert.equal(summary.title, '远端恢复中')
    assert.match(summary.detail, /已暂停新的 3D 重任务/)
    assert.equal(summary.chips.find((chip) => chip.id === 'model')?.value, '恢复中')
  })

  it('keeps preflight usable when OpenAI direct image route is unavailable but local gateway can be used', () => {
    const status = makeProviderStatus()
    const preflight = buildWorkflowPreflight({
      status,
      loading: false,
      imageProvider: 'openai',
      modelProvider: 'selfhost-triposg',
      imageSpecLabel: '标准教学 1536x1536',
    })

    assert.equal(preflight.state, 'ok')
    assert.match(preflight.recommendation, /48760/)
    assert.equal(preflight.checks.find((check) => check.id === 'image')?.value, '备用异常')
    assert.match(preflight.checks.find((check) => check.id === 'image')?.hint || '', /主链路继续生成/)
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
    assert.equal(isResumableSelfhostWorkflowJob({
      ...baseJob,
      status: 'completed',
      workflowMode: 'texture-enhance',
      effectiveTextureMode: 'fallback-color',
      result: {
        effectiveTextureMode: 'fallback-color',
        modelUrl: '/api/3d/local-model/fallback.glb',
      },
    }, { now }), true)
    assert.equal(
      isResumableSelfhostWorkflowJob({ ...baseJob, updatedAt: '2026-05-21T03:58:00.000Z' }, { now }),
      false
    )
  })

  it('falls back to re-submitting self-hosted 3D when old ComfyUI history was cleared', () => {
    const job = {
      ...makeJob('job-selfhost-restart', 'failed', '线粒体开放剖面模型'),
      provider: 'selfhost-triposg',
      providerJobId: 'old-prompt-id',
      referenceId: 'ref-cached',
    }

    assert.equal(
      canRestartSelfhostAfterMissingHistory(
        job,
        new Error('远端队列为空且 history 暂未返回该 prompt_id，可能已被清理。')
      ),
      true
    )
    assert.equal(
      canRestartSelfhostAfterMissingHistory(
        { ...job, referenceId: '' },
        new Error('history 暂未返回该 prompt_id')
      ),
      false
    )
    assert.equal(
      canRestartSelfhostAfterMissingHistory(
        { ...job, provider: 'local-demo' },
        new Error('history 暂未返回该 prompt_id')
      ),
      false
    )
    assert.equal(
      canRestartSelfhostAfterMissingHistory(
        { ...job, restartFromReferenceAttempted: true },
        new Error('history 暂未返回该 prompt_id')
      ),
      false
    )
  })

  it('creates texture enhancement jobs that reuse the completed raw GLB path', async () => {
    const sourceJob = {
      id: 'job-source-texture-test',
      prompt: '叶绿体开放剖面 3D 教学模型，突出类囊体和基粒',
      provider: 'selfhost-triposg',
      template: 'chloroplast',
      imageProvider: DEFAULT_IMAGE_PROVIDER,
      referenceId: 'ref-source-texture-test',
      reference: {
        id: 'ref-source-texture-test',
        imageUrl: '/api/references/ref-source-texture-test/image',
        title: '叶绿体参考图',
      },
      status: 'completed',
      stage: '已完成稳定几何版。',
      progress: 100,
      providerJobId: 'source-prompt-id',
      result: {
        modelUrl: '/api/3d/local-model/generated-source.glb',
        rawModelUrl: '/api/3d/local-model/raw-source.glb',
      },
      createdAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:00.000Z',
    }
    let job
    try {
      job = await createTextureEnhancementJob(sourceJob)

      assert.equal(job.workflowMode, 'texture-enhance')
      assert.equal(job.provider, 'selfhost-triposg')
      assert.equal(job.sourceJobId, sourceJob.id)
      assert.equal(job.sourceProviderJobId, 'source-prompt-id')
      assert.equal(job.referenceId, sourceJob.referenceId)
      assert.equal(job.textureMode, 'hunyuan')
      assert.equal(job.requestedTextureMode, 'hunyuan')
      assert.equal(job.rawModelUrl, sourceJob.result.rawModelUrl)
      assert.match(job.stage, /复用当前 raw GLB/)
    } finally {
      if (job?.id) await removeWorkflowJobFromStore(job.id)
    }
  })

  it('creates fallback-only texture jobs for repeatable white-model recoloring', async () => {
    const sourceJob = {
      id: 'job-source-texture-fallback-test',
      prompt: '线粒体开放剖面 3D 教学模型，突出嵴结构',
      provider: 'selfhost-triposg',
      template: 'mitochondrion',
      imageProvider: DEFAULT_IMAGE_PROVIDER,
      referenceId: 'ref-source-texture-fallback-test',
      reference: {
        id: 'ref-source-texture-fallback-test',
        imageUrl: '/api/references/ref-source-texture-fallback-test/image',
        title: '线粒体参考图',
      },
      status: 'completed',
      stage: '已完成稳定几何版。',
      progress: 100,
      providerJobId: 'source-prompt-id',
      rawMeshServerPath: '/home/kk/projects/3d/ComfyUI/output/3d/source.glb',
      result: {
        modelUrl: '/api/3d/local-model/generated-source.glb',
        rawModelUrl: '/api/3d/local-model/raw-source.glb',
      },
      createdAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:00.000Z',
    }
    let job
    try {
      job = await createTextureEnhancementJob(sourceJob, { textureMode: 'fallback-color' })

      assert.equal(job.workflowMode, 'texture-enhance')
      assert.equal(job.textureMode, 'fallback-color')
      assert.equal(job.requestedTextureMode, 'fallback-color')
      assert.equal(job.effectiveTextureMode, 'fallback-color')
      assert.equal(job.forceTextureFallback, true)
      assert.equal(job.rawModelUrl, sourceJob.result.rawModelUrl)
      assert.match(job.stage, /不提交远端混元重任务/)
    } finally {
      if (job?.id) await removeWorkflowJobFromStore(job.id)
    }
  })

  it('selects the latest completed self-host raw job for texture stability checks', () => {
    const older = {
      id: 'job-old-raw',
      status: 'completed',
      provider: 'selfhost-triposg',
      workflowMode: 'image-to-3d',
      referenceId: 'ref-old',
      rawMeshServerPath: '/tmp/old.glb',
      result: { rawModelUrl: '/api/3d/local-model/raw-old.glb' },
      updatedAt: '2026-05-25T00:00:00.000Z',
    }
    const latest = {
      id: 'job-latest-raw',
      status: 'completed',
      provider: 'selfhost-triposg',
      workflowMode: 'image-to-3d',
      referenceId: 'ref-latest',
      rawMeshServerPath: '/tmp/latest.glb',
      result: { rawModelUrl: '/api/3d/local-model/raw-latest.glb' },
      updatedAt: '2026-05-26T00:00:00.000Z',
    }
    const textureEnhance = {
      ...latest,
      id: 'job-texture-enhance',
      workflowMode: 'texture-enhance',
      updatedAt: '2026-05-27T00:00:00.000Z',
    }

    assert.equal(selectTextureSourceJob([older, textureEnhance, latest]).id, 'job-latest-raw')
    assert.equal(selectTextureSourceJob([older, latest], 'job-old-raw').id, 'job-old-raw')
  })

  it('selects recent self-host texture artifacts without submitting new jobs', () => {
    const jobs = [
      makeJob('local-latest', 'completed', '本地缓存任务'),
      {
        ...makeJob('selfhost-stable', 'completed', '稳定几何任务'),
        provider: 'selfhost-triposg',
        workflowMode: 'image-to-3d',
        updatedAt: '2026-05-25T01:00:00.000Z',
        result: { modelUrl: '/api/3d/local-model/stable.glb' },
      },
      {
        ...makeJob('texture-old', 'completed', '旧贴图任务'),
        provider: 'selfhost-triposg',
        workflowMode: 'texture-enhance',
        requestedTextureMode: 'hunyuan',
        effectiveTextureMode: 'fallback-color',
        updatedAt: '2026-05-25T02:00:00.000Z',
        result: { modelUrl: '/api/3d/local-model/old.glb', effectiveTextureMode: 'fallback-color' },
      },
      {
        ...makeJob('texture-new', 'completed', '新贴图任务'),
        provider: 'selfhost-triposg',
        workflowMode: 'texture-enhance',
        requestedTextureMode: 'hunyuan',
        effectiveTextureMode: 'hunyuan',
        updatedAt: '2026-05-25T03:00:00.000Z',
        result: { modelUrl: '/api/3d/local-model/new.glb', effectiveTextureMode: 'hunyuan' },
      },
    ]

    assert.deepEqual(selectTextureArtifactJobs(jobs, { limit: 2 }).map((job) => job.id), [
      'texture-new',
      'texture-old',
    ])
    assert.deepEqual(selectTextureArtifactJobs(jobs, { jobId: 'selfhost-stable' }).map((job) => job.id), [
      'selfhost-stable',
    ])
  })

  it('summarizes provider resources and blocks unsafe texture stability runs', () => {
    const status = {
      model3d: {
        selfhostTriposg: {
          baseUrl: 'http://47.242.195.8:8010',
          runtime: { running: 0, pending: 0 },
          texture: { minRamFreeGb: 16.5, minVramFreeGb: 14, steps: 10, faces: 3000 },
          status: {
            ok: true,
            state: 'ready',
            message: 'ready',
            ram: { total: 20 * 1024 ** 3, free: 18 * 1024 ** 3 },
            gpu: [{ vramTotal: 20 * 1024 ** 3, vramFree: 19 * 1024 ** 3 }],
            queue: { running: 0, pending: 0 },
          },
        },
      },
    }

    const summary = summarizeProviderStatus(status)
    assert.equal(summary.ready, true)
    assert.equal(summary.ramFreeGiB, 18)
    assert.equal(summary.vramFreeGiB, 19)
    assert.equal(evaluateTextureGate(status).ok, true)
    assert.equal(evaluateTextureGate(status, { textureMode: 'fallback-color' }).reason, 'fallback-ready')

    status.model3d.selfhostTriposg.status.queue.running = 1
    const busy = evaluateTextureGate(status)
    assert.equal(busy.ok, false)
    assert.equal(busy.reason, 'remote-queue-busy')

    status.model3d.selfhostTriposg.status.queue.running = 0
    status.model3d.selfhostTriposg.status.ram.free = 12 * 1024 ** 3
    const lowRam = evaluateTextureGate(status)
    assert.equal(lowRam.ok, false)
    assert.equal(lowRam.reason, 'ram-low')
  })

  it('inspects GLB texture signals for non-white stability outputs', () => {
    const white = makeMinimalGlb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
      buffers: [{ byteLength: 0 }],
      bufferViews: [],
      accessors: [],
    }, Buffer.alloc(0))
    const colored = colorizeGlbBuffer(white, { template: 'mitochondrion' })

    const whiteInfo = { bytes: white.byteLength, ...inspectGlbBuffer(white) }
    assert.equal(isUsableColoredModel(whiteInfo).ok, false)
    const whiteHunyuan = isUsableColoredModel(whiteInfo, 'hunyuan')
    assert.equal(whiteHunyuan.ok, false)
    assert.match(whiteHunyuan.message, /mode=hunyuan/)

    const coloredInfo = { bytes: colored.byteLength, ...inspectGlbBuffer(colored) }
    assert.equal(coloredInfo.nonWhiteMaterials > 0, true)
    assert.equal(isUsableColoredModel(coloredInfo, 'fallback-color').ok, true)
  })

  it('checks the material actually used by meshes when judging colored outputs', () => {
    const staleColored = makeMinimalGlb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
        { pbrMetallicRoughness: { baseColorFactor: [0.72, 0.28, 0.14, 1] } },
      ],
      buffers: [{ byteLength: 0 }],
      bufferViews: [],
      accessors: [],
    }, Buffer.alloc(0))
    const activeTextured = makeMinimalGlb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 1 }] }],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
        { pbrMetallicRoughness: { baseColorFactor: [0.72, 0.28, 0.14, 1], baseColorTexture: { index: 0 } } },
      ],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      buffers: [{ byteLength: 8 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
      accessors: [],
    }, Buffer.from('pngbytes'))

    const staleInfo = { bytes: staleColored.byteLength, ...inspectGlbBuffer(staleColored) }
    assert.equal(staleInfo.nonWhiteMaterials, 1)
    assert.equal(staleInfo.usedNonWhiteMaterials, 0)
    assert.equal(isUsableColoredModel(staleInfo, 'fallback-color').ok, false)

    const activeInfo = { bytes: activeTextured.byteLength, ...inspectGlbBuffer(activeTextured) }
    assert.deepEqual(activeInfo.usedMaterialIndexes, [1])
    assert.equal(activeInfo.texturedUsedMaterials, 1)
    assert.equal(activeInfo.usedNonWhiteMaterials, 1)
    assert.equal(isUsableColoredModel(activeInfo, 'fallback-color').ok, true)
  })

  it('summarizes consecutive texture stability evidence', () => {
    const report = {
      options: { runs: 3 },
      sourceJob: { id: 'job-source' },
      runs: [
        {
          status: 'completed',
          jobId: 'job-a',
          completedJob: { effectiveTextureMode: 'hunyuan', modelUrl: '/api/3d/local-model/a.glb' },
          usableColoredModel: { ok: true },
        },
        {
          status: 'completed',
          jobId: 'job-b',
          completedJob: { effectiveTextureMode: 'fallback-color', modelUrl: '/api/3d/local-model/b.glb' },
          usableColoredModel: { ok: true },
        },
        {
          status: 'completed',
          jobId: 'job-c',
          completedJob: { effectiveTextureMode: 'hunyuan', modelUrl: '/api/3d/local-model/c.glb' },
          usableColoredModel: { ok: true },
        },
      ],
    }

    assert.deepEqual(summarizeStabilityReport(report), {
      ok: true,
      requestedRuns: 3,
      completedRuns: 3,
      coloredRuns: 3,
      hunyuanRuns: 2,
      fallbackColorRuns: 1,
      failedRuns: 0,
      sourceJobId: 'job-source',
      lastJobId: 'job-c',
      lastModelUrl: '/api/3d/local-model/c.glb',
      reportPath: undefined,
    })
  })

  it('summarizes dry-run texture stability without claiming generated colored runs', () => {
    const report = {
      options: { runs: 1, textureMode: 'fallback-color', dryRun: true },
      sourceJob: {
        id: 'job-dry-source',
        rawModelUrl: '/api/3d/local-model/raw.glb',
        modelUrl: '/api/3d/local-model/final.glb',
      },
      runs: [
        {
          status: 'completed',
          dryRun: true,
          resourceGate: {
            ok: true,
            reason: 'fallback-ready',
            message: '只读预检通过。',
          },
        },
      ],
    }

    assert.deepEqual(summarizeStabilityReport(report), {
      ok: true,
      dryRun: true,
      requestedRuns: 0,
      completedRuns: 1,
      coloredRuns: 0,
      hunyuanRuns: 0,
      fallbackColorRuns: 0,
      failedRuns: 0,
      textureMode: 'fallback-color',
      sourceJobId: 'job-dry-source',
      lastJobId: 'job-dry-source',
      lastModelUrl: '/api/3d/local-model/final.glb',
      resourceGate: 'fallback-ready',
      resourceMessage: '只读预检通过。',
      reportPath: undefined,
    })
  })

  it('keeps the latest consecutive texture report available after a dry-run preflight', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'texture-stability-report-'))
    try {
      await writeFile(path.join(dir, 'texture-stability-latest.json'), JSON.stringify({
        summary: {
          ok: true,
          dryRun: true,
          requestedRuns: 0,
          completedRuns: 1,
          coloredRuns: 0,
          hunyuanRuns: 0,
          fallbackColorRuns: 0,
          failedRuns: 0,
        },
      }))
      await writeFile(path.join(dir, 'texture-stability-2026-05-27T09-40-15-753Z.json'), JSON.stringify({
        summary: {
          ok: true,
          requestedRuns: 3,
          completedRuns: 3,
          coloredRuns: 3,
          hunyuanRuns: 0,
          fallbackColorRuns: 3,
          failedRuns: 0,
          lastJobId: 'job-color',
          lastModelUrl: '/api/3d/local-model/color.glb',
        },
      }))

      const report = await readLatestConsecutiveStabilityReport(dir)

      assert.equal(report.summary.requestedRuns, 3)
      assert.equal(report.summary.coloredRuns, 3)
      assert.equal(report.summary.lastJobId, 'job-color')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes texture stability options to fallback-color unless Hunyuan is explicit', () => {
    assert.equal(normalizeTextureStabilityMode('hunyuan'), 'hunyuan')
    assert.equal(normalizeTextureStabilityMode('fallback-color'), 'fallback-color')
    assert.equal(normalizeTextureStabilityMode('unexpected'), 'fallback-color')

    const options = normalizeTextureStabilityOptions({
      runs: 0,
      textureMode: 'unexpected',
      pollMs: 250,
      cooldownMs: 0,
      drainTimeoutMs: 0,
      minRamRecoveryGiB: 0,
      sourceJobId: 'job-source',
      apiBase: 'http://127.0.0.1:8791///',
    })

    assert.equal(options.runs, 3)
    assert.equal(options.textureMode, 'fallback-color')
    assert.equal(options.pollMs, 250)
    assert.equal(options.cooldownMs, 15000)
    assert.equal(options.drainTimeoutMs, 120000)
    assert.equal(options.minRamRecoveryGiB, 16.5)
    assert.equal(options.sourceJobId, 'job-source')
    assert.equal(options.apiBase, 'http://127.0.0.1:8791')
    assert.equal(options.dryRun, false)

    const dryRunOptions = normalizeTextureStabilityOptions({
      runs: 3,
      textureMode: 'hunyuan',
      'dry-run': 'true',
    })
    assert.equal(dryRunOptions.dryRun, true)
    assert.equal(dryRunOptions.textureMode, 'hunyuan')
    assert.equal(dryRunOptions.runs, 3)
  })

  it('adds a lightweight color fallback material to GLB without changing geometry buffers', () => {
    const source = makeMinimalGlb({
      asset: { version: '2.0', generator: 'unit-test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 0, type: 'VEC3' }],
    }, Buffer.from([1, 2, 3, 4]))

    const colored = colorizeGlbBuffer(source, { template: 'chloroplast' })
    const parsed = readGlbJson(colored)

    assert.equal(parsed.json.materials.length, 1)
    assert.equal(parsed.json.meshes[0].primitives[0].material, 0)
    assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.3, 0.62, 0.25, 1])
    assert.match(parsed.json.asset.generator, /LearningCell Bio3D color fallback/)
    assert.deepEqual([...parsed.bin], [1, 2, 3, 4])
  })

  it('adds lightweight texture coordinates and template vertex colors to positioned GLB fallbacks', () => {
    const positionBuffer = Buffer.alloc(36)
    const vertices = [
      [-1, 0, 0],
      [0, 1, 0.5],
      [1, 0.25, 1],
    ]
    vertices.flat().forEach((value, index) => {
      positionBuffer.writeFloatLE(value, index * 4)
    })
    const source = makeMinimalGlb({
      asset: { version: '2.0', generator: 'unit-test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: positionBuffer.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBuffer.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }, positionBuffer)

    const colored = colorizeGlbBuffer(source, { template: 'mitochondrion' })
    const parsed = readGlbJson(colored)
    const primitive = parsed.json.meshes[0].primitives[0]
    const colorAccessorIndex = primitive.attributes.COLOR_0
    const texcoordAccessorIndex = primitive.attributes.TEXCOORD_0
    const colorAccessor = parsed.json.accessors[colorAccessorIndex]
    const texcoordAccessor = parsed.json.accessors[texcoordAccessorIndex]
    const colorView = parsed.json.bufferViews[colorAccessor.bufferView]
    const firstColorOffset = (colorView.byteOffset || 0) + (colorAccessor.byteOffset || 0)
    const firstColor = [
      parsed.bin.readFloatLE(firstColorOffset),
      parsed.bin.readFloatLE(firstColorOffset + 4),
      parsed.bin.readFloatLE(firstColorOffset + 8),
      parsed.bin.readFloatLE(firstColorOffset + 12),
    ]

    assert.equal(Number.isInteger(colorAccessorIndex), true)
    assert.equal(colorAccessor.type, 'VEC4')
    assert.equal(colorAccessor.componentType, 5126)
    assert.equal(colorAccessor.count, 3)
    assert.equal(texcoordAccessor.type, 'VEC2')
    assert.equal(texcoordAccessor.componentType, 5126)
    assert.equal(texcoordAccessor.count, 3)
    assert.equal(colorView.byteLength, 48)
    assert.equal(parsed.json.images.length, 1)
    assert.equal(parsed.json.images[0].mimeType, 'image/png')
    assert.equal(parsed.json.textures.length, 1)
    assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorTexture, { index: 0, texCoord: 0 })
    assert.equal(parsed.json.buffers[0].byteLength > positionBuffer.length + 48, true)
    assert.match(parsed.json.asset.generator, /lightweight texture fallback/)
    assert.notDeepEqual(firstColor.map((value) => Number(value.toFixed(2))), [0.84, 0.43, 0.27, 1])
  })

  it('embeds the confirmed reference image as the lightweight fallback texture when available', () => {
    const positionBuffer = Buffer.alloc(36)
    const vertices = [
      [-1, 0, 0],
      [0, 1, 0.5],
      [1, 0.25, 1],
    ]
    vertices.flat().forEach((value, index) => {
      positionBuffer.writeFloatLE(value, index * 4)
    })
    const source = makeMinimalGlb({
      asset: { version: '2.0', generator: 'unit-test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: positionBuffer.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBuffer.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }, positionBuffer)
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('learningcell-reference-texture'),
    ])

    const colored = colorizeGlbBuffer(source, {
      template: 'mitochondrion',
      textureImage: png,
      textureMimeType: 'image/png',
    })
    const parsed = readGlbJson(colored)
    const image = parsed.json.images[0]
    const imageView = parsed.json.bufferViews[image.bufferView]
    const imageBytes = parsed.bin.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength)

    assert.equal(image.mimeType, 'image/png')
    assert.match(image.name, /reference_texture/)
    assert.deepEqual([...imageBytes], [...png])
  })

  it('uses prominent reference image colors for lightweight fallback materials', () => {
    const positionBuffer = Buffer.alloc(36)
    const vertices = [
      [-1, 0, 0],
      [0, 1, 0.5],
      [1, 0.25, 1],
    ]
    vertices.flat().forEach((value, index) => {
      positionBuffer.writeFloatLE(value, index * 4)
    })
    const source = makeMinimalGlb({
      asset: { version: '2.0', generator: 'unit-test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: positionBuffer.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBuffer.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }, positionBuffer)
    const referencePng = makeTinyPng(4, 2, [
      [255, 255, 255, 255], [250, 250, 246, 255], [210, 58, 28, 255], [232, 112, 44, 255],
      [255, 255, 255, 255], [247, 246, 242, 255], [188, 42, 34, 255], [238, 128, 58, 255],
    ])

    const colored = colorizeGlbBuffer(source, {
      template: 'chloroplast',
      textureImage: referencePng,
      textureMimeType: 'image/png',
    })
    const parsed = readGlbJson(colored)
    const baseColor = parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor

    assert.equal(parsed.json.images[0].mimeType, 'image/png')
    assert.equal(baseColor[0] > 0.70, true)
    assert.equal(baseColor[1] < 0.45, true)
    assert.equal(baseColor[2] < 0.30, true)
    assert.notDeepEqual(baseColor, [0.3, 0.62, 0.25, 1])
  })

  it('compacts stale source materials out of reference-colored fallbacks', () => {
    const positionBuffer = Buffer.alloc(36)
    const vertices = [
      [-1, 0, 0],
      [0, 1, 0.5],
      [1, 0.25, 1],
    ]
    vertices.flat().forEach((value, index) => {
      positionBuffer.writeFloatLE(value, index * 4)
    })
    const source = makeMinimalGlb({
      asset: { version: '2.0', generator: 'unit-test' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ name: 'old-white', pbrMetallicRoughness: { baseColorFactor: [0.96, 0.96, 0.94, 1] } }],
      buffers: [{ byteLength: positionBuffer.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positionBuffer.length }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }, positionBuffer)
    const referencePng = makeTinyPng(3, 1, [
      [255, 255, 255, 255], [222, 84, 34, 255], [176, 42, 31, 255],
    ])

    const colored = colorizeGlbBuffer(source, {
      template: 'mitochondrion',
      textureImage: referencePng,
      textureMimeType: 'image/png',
    })
    const parsed = readGlbJson(colored)
    const primitive = parsed.json.meshes[0].primitives[0]

    assert.equal(parsed.json.materials.length, 1)
    assert.equal(primitive.material, 0)
    assert.equal(parsed.json.materials[0].name, 'bio3d_mitochondrion_fallback_material')
    assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorTexture, { index: 0, texCoord: 0 })
    assert.equal(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor[0] > 0.60, true)
    assert.equal(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor[1] < 0.40, true)
  })

  it('writes a color fallback GLB file for stable model recovery', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'learningcell-glb-color-'))
    try {
      const input = path.join(dir, 'input.glb')
      const output = path.join(dir, 'output.glb')
      await writeFile(input, makeMinimalGlb({
        asset: { version: '2.0' },
        meshes: [{ primitives: [{}] }],
        buffers: [{ byteLength: 0 }],
      }))

      const result = await colorizeGlbFile(input, output, { template: 'mitochondrion' })
      const parsed = readGlbJson(await readFile(output))

      assert.equal(result.bytes > 32, true)
      assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.84, 0.43, 0.27, 1])
      assert.equal(parsed.json.meshes[0].primitives[0].material, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('writes a non-white color display GLB for stable self-hosted outputs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'learningcell-display-color-'))
    try {
      const input = path.join(dir, 'stable.glb')
      await writeFile(input, makeMinimalGlb({
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{}] }],
        buffers: [{ byteLength: 0 }],
      }))

      const display = await writeColorizedDisplayModel({
        job: { id: 'job-display-color', template: 'chloroplast' },
        sourcePath: input,
        outputDir: dir,
      })
      const parsed = readGlbJson(await readFile(display.localPath))

      assert.match(display.fileName, /^display-color-job-display-color-chloroplast\.glb$/)
      assert.equal(display.modelUrl, '/api/3d/local-model/display-color-job-display-color-chloroplast.glb')
      assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.3, 0.62, 0.25, 1])
      assert.equal(parsed.json.meshes[0].primitives[0].material, 0)
      assert.match(parsed.json.asset.generator, /LearningCell Bio3D/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('enhances washed-out Hunyuan textured GLB for classroom display while preserving texture success', () => {
    const washedOut = makeMinimalGlb({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      buffers: [{ byteLength: 4 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 4 },
        { buffer: 0, byteOffset: 4, byteLength: 12 },
      ],
      accessors: [{ bufferView: 0, componentType: 5126, count: 0, type: 'VEC3' }],
      images: [{ bufferView: 1, mimeType: 'image/png' }],
      textures: [{ source: 0 }],
      materials: [{
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [1, 1, 1, 1],
          roughnessFactor: 0.91,
        },
      }],
    }, Buffer.concat([Buffer.from([1, 2, 3, 4]), Buffer.from('fake-png-data')]))
    const saturated = makeMinimalGlb({
      asset: { version: '2.0' },
      materials: [{
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          baseColorFactor: [0.84, 0.43, 0.27, 1],
          roughnessFactor: 0.55,
        },
      }],
      textures: [{ source: 0 }],
      images: [{ uri: 'texture.png' }],
      buffers: [{ byteLength: 0 }],
    })

    assert.equal(shouldEnhanceTexturedDisplay(washedOut), true)
    assert.equal(shouldEnhanceTexturedDisplay(saturated), false)
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
        resourceGuard: {
          enabled: true,
          minRamFreeGb: 10,
          minVramFreeGb: 6,
          steps: 16,
          faces: 12000,
          guidanceScale: 6,
          maxLocalPending: 1,
          blockWhenRemoteBusy: true,
        },
        texture: {
          enabled: true,
          minRamFreeGb: 18,
          minTotalRamGb: 19,
          lowMemoryTotalRamGb: 24,
          lowMemoryRemoteEnabled: false,
          minVramFreeGb: 14,
          steps: 12,
          faces: 10000,
          guidanceScale: 5.5,
        },
        status: {
          ok: true,
          queue: { running: 0, pending: 0 },
          ram: { total: 20 * 1024 ** 3, available: 19 * 1024 ** 3 },
          gpu: [{ name: 'cuda:0 NVIDIA GeForce RTX 3080', vramTotal: 20 * 1024 ** 3, vramFree: 18 * 1024 ** 3 }],
        },
      },
      localCache: { configured: true },
      tencentHunyuan: { configured: false },
    },
  }
}

function makeMinimalGlb(json, bin = Buffer.alloc(0)) {
  const jsonBuffer = padGlbChunk(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const binBuffer = bin.length ? padGlbChunk(bin, 0x00) : null
  const totalLength = 12 + 8 + jsonBuffer.length + (binBuffer ? 8 + binBuffer.length : 0)
  const output = Buffer.alloc(totalLength)
  output.writeUInt32LE(0x46546c67, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(totalLength, 8)
  output.writeUInt32LE(jsonBuffer.length, 12)
  output.writeUInt32LE(0x4e4f534a, 16)
  jsonBuffer.copy(output, 20)
  if (binBuffer) {
    const offset = 20 + jsonBuffer.length
    output.writeUInt32LE(binBuffer.length, offset)
    output.writeUInt32LE(0x004e4942, offset + 4)
    binBuffer.copy(output, offset + 8)
  }
  return output
}

function readGlbJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12)
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\u0000\s]+$/g, ''))
  const binOffset = 20 + jsonLength
  const hasBin = binOffset + 8 <= buffer.length
  const binLength = hasBin ? buffer.readUInt32LE(binOffset) : 0
  const bin = hasBin ? buffer.subarray(binOffset + 8, binOffset + 8 + binLength) : Buffer.alloc(0)
  return { json, bin }
}

function padGlbChunk(buffer, padByte) {
  const padding = (4 - (buffer.length % 4)) % 4
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, padByte)]) : buffer
}

function makeTinyPng(width, height, pixels) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4)
    row[0] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x] || [0, 0, 0, 255]
      const offset = 1 + x * 4
      row[offset] = pixel[0] || 0
      row[offset + 1] = pixel[1] || 0
      row[offset + 2] = pixel[2] || 0
      row[offset + 3] = pixel[3] ?? 255
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.concat([
      uint32be(width),
      uint32be(height),
      Buffer.from([8, 6, 0, 0, 0]),
    ])),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type, data) {
  return Buffer.concat([
    uint32be(data.length),
    Buffer.from(type, 'ascii'),
    data,
    Buffer.alloc(4),
  ])
}

function uint32be(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}
