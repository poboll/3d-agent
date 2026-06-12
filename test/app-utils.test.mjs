import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterModelsForIndex } from '../app/src/lib/modelIndex.ts'
import {
  GENERATED_MODEL_LIMIT,
  compactGeneratedModelsForIndex,
  mergeGeneratedModelsStable,
  resolveCompactGeneratedModelId,
  resolveLatestGeneratedModelIdForActive,
  selectNewestGeneratedModel,
  upsertGeneratedModelStable,
} from '../app/src/lib/generatedModels.ts'
import { buildReferenceQualityGate } from '../app/src/lib/referenceQualityGate.ts'
import { buildWorkflowNextAction } from '../app/src/lib/workflowNextAction.ts'
import { buildChainReadiness, buildTextureArtifactHealth, buildTextureResultStatus, buildTextureStabilityHealth } from '../app/src/lib/workflowRuntime.ts'

describe('LearningCell app ordering utilities', () => {
  it('keeps specimen index order stable when active model changes elsewhere', () => {
    const models = [
      makeModel('plant-cell', '植物细胞', false),
      makeModel('mitochondrion', '线粒体', false),
      makeModel('generated-a', 'AI 生成：线粒体', true),
    ]

    assert.deepEqual(filterModelsForIndex(models, '').map((model) => model.id), [
      'plant-cell',
      'mitochondrion',
      'generated-a',
    ])
  })

  it('uses search ranking without promoting the currently selected specimen', () => {
    const models = [
      makeModel('plant-cell', '植物细胞', false),
      makeModel('mitochondrion', '线粒体', false),
      makeModel('generated-a', 'AI 生成：线粒体', true),
    ]

    assert.deepEqual(filterModelsForIndex(models, '线粒体').map((model) => model.id), [
      'mitochondrion',
      'generated-a',
    ])
  })

  it('updates existing generated models in place and appends new models', () => {
    const first = makeModel('generated-a', 'AI 生成：植物细胞', true, '/a.glb')
    const second = makeModel('generated-b', 'AI 生成：线粒体', true, '/b.glb')
    const updatedFirst = { ...first, subtitle: '更新后的模型' }
    const third = makeModel('generated-c', 'AI 生成：叶绿体', true, '/c.glb')

    assert.deepEqual(upsertGeneratedModelStable([first, second], updatedFirst).map((model) => model.id), [
      'generated-a',
      'generated-b',
    ])
    assert.deepEqual(mergeGeneratedModelsStable([first, second], [updatedFirst, third]).map((model) => model.id), [
      'generated-a',
      'generated-b',
      'generated-c',
    ])
  })

  it('keeps a newly completed generated model visible when the saved list is full', () => {
    const existing = Array.from({ length: GENERATED_MODEL_LIMIT }, (_, index) =>
      makeModel(`generated-job-${1000 + index}`, `AI 生成：缓存 ${index + 1}`, true, `/api/3d/local-model/generated-job-${1000 + index}.glb`)
    )
    const newest = makeModel(
      'generated-job-1779684202804-89fd5241',
      'AI 生成：植物细胞',
      true,
      '/api/3d/local-model/generated-job-1779684202804-89fd5241-plant-cell.glb'
    )

    const next = upsertGeneratedModelStable(existing, newest, GENERATED_MODEL_LIMIT)

    assert.equal(next.length, GENERATED_MODEL_LIMIT)
    assert.equal(next[0].id, existing[0].id)
    assert.equal(next[next.length - 1].id, newest.id)
  })

  it('merges job history models in timestamp order so the latest result survives trimming', () => {
    const existing = Array.from({ length: GENERATED_MODEL_LIMIT - 1 }, (_, index) =>
      makeModel(`generated-job-${2000 + index}`, `AI 生成：缓存 ${index + 1}`, true, `/api/3d/local-model/generated-job-${2000 + index}.glb`)
    )
    const older = makeModel(
      'generated-job-1779676882515-8214b82b',
      'AI 生成：植物细胞',
      true,
      '/api/3d/local-model/generated-job-1779676882515-8214b82b-plant-cell.glb'
    )
    const newer = makeModel(
      'generated-job-1779684202804-89fd5241',
      'AI 生成：植物细胞',
      true,
      '/api/3d/local-model/generated-job-1779684202804-89fd5241-plant-cell.glb'
    )

    const next = mergeGeneratedModelsStable(existing, [newer, older], GENERATED_MODEL_LIMIT)

    assert.equal(next.length, GENERATED_MODEL_LIMIT)
    assert.equal(next.at(-1).id, newer.id)
    assert.equal(selectNewestGeneratedModel(next).id, newer.id)
  })

  it('compacts generated specimens by template for the visible index while preserving search text', () => {
    const plant = makeModel('plant-cell', '植物细胞', false, '/plant.glb')
    const oldChloroplast = makeModel(
      'generated-job-1779700000000-old',
      'AI 生成：叶绿体',
      true,
      '/api/3d/local-model/generated-job-1779700000000-old-chloroplast.glb',
      'chloroplast'
    )
    const newChloroplast = makeModel(
      'generated-job-1779701454057-new',
      'AI 生成：叶绿体',
      true,
      '/api/3d/local-model/generated-job-1779701454057-new-chloroplast.glb',
      'chloroplast'
    )
    const mitochondrion = makeModel(
      'generated-job-1779700801850-mito',
      'AI 生成：线粒体',
      true,
      '/api/3d/local-model/generated-job-1779700801850-mitochondrion.glb',
      'mitochondrion'
    )

    const compact = compactGeneratedModelsForIndex([plant, oldChloroplast, newChloroplast, mitochondrion])

    assert.deepEqual(compact.map((model) => model.id), [
      'plant-cell',
      'generated-job-1779701454057-new',
      'generated-job-1779700801850-mito',
    ])
    assert.equal(compact[1].indexGroupCount, 2)
    assert.match(compact[1].indexSearchText, /old-chloroplast/)
  })

  it('resolves hidden generated versions to the visible compact index row', () => {
    const oldChloroplast = makeModel(
      'generated-job-1779700000000-old',
      'AI 生成：叶绿体',
      true,
      '/api/3d/local-model/generated-job-1779700000000-old-chloroplast.glb',
      'chloroplast'
    )
    const newChloroplast = makeModel(
      'generated-job-1779701454057-new',
      'AI 生成：叶绿体',
      true,
      '/api/3d/local-model/generated-job-1779701454057-new-chloroplast.glb',
      'chloroplast'
    )

    assert.equal(
      resolveCompactGeneratedModelId([oldChloroplast, newChloroplast], oldChloroplast.id),
      newChloroplast.id
    )
  })

  it('moves an active generated model to the latest version in the same template group', () => {
    const fixed = makeModel('mitochondrion', '线粒体', false)
    const oldMito = makeModel(
      'generated-job-1779700000000-old',
      'AI 生成：线粒体',
      true,
      '/api/3d/local-model/generated-job-1779700000000-old-mitochondrion.glb',
      'mitochondrion'
    )
    const latestMito = makeModel(
      'generated-job-1779799119502-latest',
      'AI 生成：线粒体',
      true,
      '/api/3d/local-model/display-textured-color-job-1779799119502-latest-mitochondrion.glb',
      'mitochondrion'
    )

    assert.equal(resolveLatestGeneratedModelIdForActive([fixed, oldMito, latestMito], fixed.id), fixed.id)
    assert.equal(resolveLatestGeneratedModelIdForActive([fixed, oldMito, latestMito], oldMito.id), latestMito.id)
  })

  it('does not reorder compact generated rows when a fixed specimen becomes active', () => {
    const models = [
      makeModel('plant-cell', '植物细胞', false),
      makeModel('animal-cell', '动物细胞', false),
      makeModel(
        'generated-job-1779700000000-mito',
        'AI 生成：线粒体',
        true,
        '/api/3d/local-model/generated-job-1779700000000-mitochondrion.glb',
        'mitochondrion'
      ),
      makeModel(
        'generated-job-1779799119502-mito',
        'AI 生成：线粒体',
        true,
        '/api/3d/local-model/display-textured-color-job-1779799119502-mitochondrion.glb',
        'mitochondrion'
      ),
      makeModel(
        'generated-job-1779701454057-chloro',
        'AI 生成：叶绿体',
        true,
        '/api/3d/local-model/generated-job-1779701454057-chloroplast.glb',
        'chloroplast'
      ),
    ]
    const before = compactGeneratedModelsForIndex(models).map((model) => model.id)
    const afterSelectAnimal = compactGeneratedModelsForIndex(models).map((model) => model.id)

    assert.deepEqual(before, [
      'plant-cell',
      'animal-cell',
      'generated-job-1779799119502-mito',
      'generated-job-1779701454057-chloro',
    ])
    assert.deepEqual(afterSelectAnimal, before)
  })

  it('marks local gateway 3D-ready reference images as stable for image-to-3D', () => {
    const gate = buildReferenceQualityGate({
      source: '本地图片网关',
      model: 'gpt-image-2',
      promptModel: 'gpt-5.5',
      imageSize: '1536x1536',
      imageQuality: 'high',
      imagePrompt: [
        'Create a single centered 3D-ready mitochondrion on a clean white background.',
        'Show a three-quarter open cutaway with one large cut window.',
        'Avoid labels, text, arrows, UI marks, transparent glass jelly glossy material, multi-view collage grid panels.',
      ].join(' '),
    })

    assert.equal(gate.state, 'ok')
    assert.equal(gate.title, '3D-ready 通过')
    assert.deepEqual(gate.checks.map((check) => check.state), ['ok', 'ok', 'ok', 'ok'])
  })

  it('keeps uploaded reference images in manual review instead of overclaiming stability', () => {
    const gate = buildReferenceQualityGate({
      uploaded: true,
      source: '上传图片',
      imageSize: '1024x1024',
      imageQuality: 'medium',
    })

    assert.equal(gate.state, 'ready')
    assert.match(gate.summary, /人工确认|人工复核|人工检查/)
  })

  it('warns when generated reference metadata is too weak for stable 3D reconstruction', () => {
    const gate = buildReferenceQualityGate({
      source: '本地图片网关',
      model: 'gpt-image-2',
      imageSize: '512x512',
      imageQuality: 'medium',
      imagePrompt: 'Create a decorative biological poster with labels and a dark background.',
    })

    assert.equal(gate.state, 'warn')
    assert.equal(gate.title, '建议重试')
  })

  it('recommends uploading a reference when text-to-image is blocked but image-to-3D can continue', () => {
    const action = buildWorkflowNextAction({
      prompt: '线粒体开放剖面 3D 教学模型',
      busy: false,
      referenceImage: null,
      referenceAccepted: false,
      activeJob: null,
      canResumeActiveJob: false,
      imageProviderReady: false,
      imageProviderBlockedReason: '48760 图片上游最近返回 upstream_error / 502。',
      model3dReady: true,
      syncing: false,
    })

    assert.equal(action.id, 'upload-reference')
    assert.equal(action.label, '上传图片')
    assert.equal(action.state, 'warn')
    assert.match(action.hint, /上传已有图片继续图生 3D/)
  })

  it('keeps the preflight action while image provider status is still loading', () => {
    const action = buildWorkflowNextAction({
      prompt: '叶绿体剖面 3D 教学模型',
      busy: false,
      referenceImage: null,
      referenceAccepted: false,
      activeJob: null,
      canResumeActiveJob: false,
      imageProviderChecking: true,
      imageProviderReady: false,
      model3dReady: true,
      syncing: false,
    })

    assert.equal(action.id, 'refresh-preflight')
    assert.equal(action.state, 'pending')
  })

  it('distinguishes native Hunyuan texture from protected color fallback in result copy', () => {
    const native = buildTextureResultStatus(makeCompletedJob({
      effectiveTextureMode: 'hunyuan',
      result: {
        effectiveTextureMode: 'hunyuan',
        texturedModelUrl: '/api/3d/local-model/textured.glb',
        modelUrl: '/api/3d/local-model/final.glb',
      },
    }))
    assert.equal(native.state, 'ok')
    assert.equal(native.mode, 'hunyuan')
    assert.match(native.label, /原生混元/)

    const protectedFallback = buildTextureResultStatus(makeCompletedJob({
      effectiveTextureMode: 'fallback-color',
      requestedTextureMode: 'hunyuan',
      textureFallbackReason: '20GB 低内存模式：默认不提交远端贴图。',
      result: {
        effectiveTextureMode: 'fallback-color',
        requestedTextureMode: 'hunyuan',
        textureFallbackReason: '20GB 低内存模式：默认不提交远端贴图。',
        modelUrl: '/api/3d/local-model/fallback.glb',
      },
    }))
    assert.equal(protectedFallback.state, 'ok')
    assert.equal(protectedFallback.mode, 'fallback-color')
    assert.match(protectedFallback.label, /fallback 彩色版/)
    assert.match(protectedFallback.detail, /20GB 低内存资源保护/)
    assert.match(protectedFallback.detail, /不是原生混元 textured\.glb/)

    const whiteRisk = buildTextureResultStatus(makeCompletedJob({
      requestedTextureMode: 'hunyuan',
      effectiveTextureMode: 'stable',
      result: {
        requestedTextureMode: 'hunyuan',
        effectiveTextureMode: 'stable',
        modelUrl: '/api/3d/local-model/final.glb',
      },
    }))
    assert.equal(whiteRisk.state, 'warn')
    assert.match(whiteRisk.detail, /可能仍是稳定几何版/)
  })

  it('summarizes read-only texture artifact health for the workbench', () => {
    const loading = buildTextureArtifactHealth(null, true)
    assert.equal(loading.state, 'pending')
    assert.match(loading.detail, /不会提交新的 Hunyuan3D-Paint/)

    const empty = buildTextureArtifactHealth({ ok: false, checked: 0, failed: 0, generatedAt: '', summary: '', artifacts: [] }, false)
    assert.equal(empty.state, 'idle')
    assert.match(empty.title, /暂无贴图产物/)

    const ok = buildTextureArtifactHealth({
      ok: true,
      checked: 2,
      failed: 0,
      generatedAt: '2026-05-27T00:00:00.000Z',
      summary: '最近 2 个贴图产物通过 active material 检查。',
      artifacts: [
        { jobId: 'native', ok: true, effectiveTextureMode: 'hunyuan' },
        {
          jobId: 'fallback',
          ok: true,
          effectiveTextureMode: 'fallback-color',
          reason: 'embedded-texture-on-active-material',
          modelUrl: '/api/3d/local-model/fallback.glb',
          model: { bytes: 1364892 },
        },
      ],
    })
    assert.equal(ok.state, 'ok')
    assert.equal(ok.chips.find((chip) => chip.id === 'native')?.value, '1 个')
    assert.equal(ok.chips.find((chip) => chip.id === 'fallback')?.value, '1 个')
    assert.equal(ok.chips.find((chip) => chip.id === 'mode')?.value, '只读')
    assert.equal(ok.latest?.mode, '原生混元贴图')
    assert.equal(ok.paths.find((path) => path.id === 'hunyuan')?.value, '1 个通过')
    assert.equal(ok.paths.find((path) => path.id === 'fallback-color')?.value, '1 个通过')

    const warn = buildTextureArtifactHealth({
      ok: false,
      checked: 1,
      failed: 1,
      generatedAt: '2026-05-27T00:00:00.000Z',
      summary: '1/1 个贴图产物没有通过 active material 检查。',
      artifacts: [{ jobId: 'white-risk', ok: false, effectiveTextureMode: 'stable' }],
    })
    assert.equal(warn.state, 'warn')
    assert.equal(warn.chips.find((chip) => chip.id === 'failed')?.state, 'warn')
  })

  it('summarizes consecutive fallback-color texture stability evidence', () => {
    const loading = buildTextureStabilityHealth(null, true, false)
    assert.equal(loading.state, 'pending')
    assert.match(loading.detail, /连续验证/)

    const empty = buildTextureStabilityHealth(null, false, false)
    assert.equal(empty.state, 'idle')
    assert.match(empty.detail, /只读预检 raw GLB|资源闸门/)

    const ok = buildTextureStabilityHealth({
      ok: true,
      running: false,
      generatedAt: '2026-05-27T00:00:00.000Z',
      message: '连续贴图验证通过。',
      summary: {
        ok: true,
        requestedRuns: 3,
        completedRuns: 3,
        coloredRuns: 3,
        hunyuanRuns: 0,
        fallbackColorRuns: 3,
        failedRuns: 0,
        textureMode: 'fallback-color',
        sourceJobId: 'job-source',
        lastJobId: 'job-1779853229919-91e72542',
        lastModelUrl: '/api/3d/local-model/fallback.glb',
      },
      report: null,
    }, false, false)

    assert.equal(ok.state, 'ok')
    assert.equal(ok.title, 'fallback 长测 3/3')
    assert.match(ok.detail, /20GB/)
    assert.match(ok.detail, /未调用原生混元贴图重任务/)
    assert.equal(ok.chips.find((chip) => chip.id === 'colored')?.value, '3 次')
    assert.equal(ok.chips.find((chip) => chip.id === 'mode')?.value, '轻量彩色贴图')
    assert.equal(ok.latest?.modelUrl, '/api/3d/local-model/fallback.glb')
    assert.equal(ok.paths.find((path) => path.id === 'fallback-color')?.value, '3/3 可用')
    assert.equal(ok.paths.find((path) => path.id === 'hunyuan')?.value, '未调用')

    const running = buildTextureStabilityHealth(null, false, true)
    assert.equal(running.state, 'pending')
    assert.match(running.detail, /不会提交远端 Hunyuan3D-Paint/)

    const serverRunning = buildTextureStabilityHealth({
      ok: false,
      running: true,
      generatedAt: '',
      message: '已有连续贴图验证正在运行。',
      summary: null,
      report: null,
    }, false, false)
    assert.equal(serverRunning.state, 'pending')
    assert.equal(serverRunning.title, '贴图预检运行中')
    assert.equal(serverRunning.chips.find((chip) => chip.id === 'queue')?.value, '不提交')
  })

  it('summarizes dry-run texture preflight without overclaiming colored outputs', () => {
    const dryRun = buildTextureStabilityHealth({
      ok: true,
      running: false,
      generatedAt: '2026-05-27T00:00:00.000Z',
      message: '贴图链路只读预检通过。',
      summary: {
        ok: true,
        dryRun: true,
        requestedRuns: 0,
        completedRuns: 1,
        coloredRuns: 0,
        hunyuanRuns: 0,
        fallbackColorRuns: 0,
        failedRuns: 0,
        textureMode: 'fallback-color',
        sourceJobId: 'job-source',
        lastJobId: 'job-source',
        lastModelUrl: '/api/3d/local-model/final.glb',
        resourceGate: 'fallback-ready',
        resourceMessage: '只读预检通过。',
      },
      report: null,
    }, false, false)

    assert.equal(dryRun.state, 'ok')
    assert.equal(dryRun.title, '只读预检通过')
    assert.match(dryRun.detail, /没有提交贴图任务/)
    assert.equal(dryRun.chips.find((chip) => chip.id === 'runs')?.value, '0 重任务')
    assert.equal(dryRun.chips.find((chip) => chip.id === 'colored')?.value, '只读未生成')
    assert.equal(dryRun.latest?.modelUrl, '/api/3d/local-model/final.glb')

    const dryRunWithConsecutive = buildTextureStabilityHealth({
      ok: true,
      running: false,
      generatedAt: '2026-05-27T00:04:00.000Z',
      message: '贴图链路只读预检通过。',
      summary: {
        ok: true,
        dryRun: true,
        requestedRuns: 0,
        completedRuns: 1,
        coloredRuns: 0,
        hunyuanRuns: 0,
        fallbackColorRuns: 0,
        failedRuns: 0,
        textureMode: 'fallback-color',
        sourceJobId: 'job-source',
        lastJobId: 'job-source',
        lastModelUrl: '/api/3d/local-model/final.glb',
        resourceGate: 'fallback-ready',
        resourceMessage: '只读预检通过。',
      },
      report: null,
      latestConsecutive: {
        generatedAt: '2026-05-27T00:03:00.000Z',
        summary: {
          ok: true,
          requestedRuns: 3,
          completedRuns: 3,
          coloredRuns: 3,
          hunyuanRuns: 0,
          fallbackColorRuns: 3,
          failedRuns: 0,
          textureMode: 'fallback-color',
          sourceJobId: 'job-source',
          lastJobId: 'job-color',
          lastModelUrl: '/api/3d/local-model/color.glb',
        },
        report: null,
      },
    }, false, false)

    assert.equal(dryRunWithConsecutive.title, '预检通过 · fallback 长测 3/3')
    assert.match(dryRunWithConsecutive.detail, /最近连续长测仍保留 3\/3/)
    assert.match(dryRunWithConsecutive.detail, /不能标记为 textured\.glb 成功/)
    assert.equal(dryRunWithConsecutive.chips.find((chip) => chip.id === 'colored')?.value, '3 次')
    assert.equal(dryRunWithConsecutive.latest?.modelUrl, '/api/3d/local-model/color.glb')
    assert.equal(dryRunWithConsecutive.paths.find((path) => path.id === 'fallback-color')?.value, '稳定 3/3')
    assert.equal(dryRunWithConsecutive.paths.find((path) => path.id === 'hunyuan')?.value, '本轮未调用')
  })

  it('summarizes full text-to-image to image-to-3d readiness without overclaiming low-memory texture', () => {
    const readiness = buildChainReadiness({
      status: makeProviderStatus(),
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'hunyuan',
    })

    assert.equal(readiness.state, 'pending')
    assert.match(readiness.title, /低内存保护/)
    assert.match(readiness.detail, /gpt-5.5 -> gpt-image-2 -> TripoSG\/Bio3D/)
    assert.equal(readiness.steps.find((step) => step.id === 'prompt')?.state, 'ok')
    assert.equal(readiness.steps.find((step) => step.id === 'image')?.value, 'gpt-image-2')
    assert.equal(readiness.steps.find((step) => step.id === 'model')?.value, '在线')
    assert.equal(readiness.steps.find((step) => step.id === 'texture')?.value, '低内存试跑')
    assert.equal(readiness.steps.find((step) => step.id === 'texture')?.state, 'pending')
    assert.equal(readiness.badge.value, '低内存 fallback')
  })

  it('marks chain readiness as warn when the local image route is not matched', () => {
    const readiness = buildChainReadiness({
      status: makeProviderStatus({
        imageRoute: {
          ok: false,
          state: 'missing',
          status: 200,
          message: '图片模型路由未匹配。',
          requestedModels: ['gpt-image-2'],
          matchedModels: [],
          availableModelIds: ['gpt-5.5'],
        },
        modelIds: ['gpt-5.5'],
      }),
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'stable',
    })

    assert.equal(readiness.state, 'warn')
    assert.match(readiness.title, /文生图链路需复查/)
    assert.equal(readiness.steps.find((step) => step.id === 'image')?.state, 'warn')
    assert.deepEqual(readiness.badge, {
      label: '链路状态',
      value: '需复查',
      state: 'warn',
    })
  })

  it('keeps chain readiness pending before deep 3d resource stats are loaded', () => {
    const status = makeProviderStatus()
    delete status.model3d.selfhostTriposg.status
    const readiness = buildChainReadiness({
      status,
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'hunyuan',
    })

    assert.equal(readiness.state, 'pending')
    assert.match(readiness.title, /等待远端资源读数/)
    assert.doesNotMatch(readiness.title, /需复查/)
    assert.match(readiness.detail, /只读同步/)
    assert.deepEqual(readiness.badge, {
      label: '同步方式',
      value: '只读刷新',
      state: 'pending',
    })
  })

  it('marks stable chain readiness as directly runnable when geometry mode is selected', () => {
    const readiness = buildChainReadiness({
      status: makeProviderStatus(),
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'stable',
    })

    assert.equal(readiness.state, 'ok')
    assert.equal(readiness.badge.value, '可直接生成')
    assert.equal(readiness.badge.state, 'ok')
  })

  it('surfaces cached image route evidence without blocking the chain', () => {
    const readiness = buildChainReadiness({
      status: makeProviderStatus({
        imageRoute: {
          ok: true,
          state: 'ready-cached',
          status: 200,
          cached: true,
          message: '图片模型路由近期已匹配。',
          requestedModels: ['gpt-image-2'],
          matchedModels: ['gpt-image-2'],
          availableModelIds: ['gpt-5.5', 'gpt-image-2'],
        },
      }),
      loading: false,
      imageProvider: 'local-gateway',
      modelProvider: 'selfhost-triposg',
      textureMode: 'stable',
    })

    assert.equal(readiness.state, 'ok')
    assert.match(readiness.steps.find((step) => step.id === 'image')?.note || '', /近期成功缓存/)
    assert.match(readiness.steps.find((step) => step.id === 'image')?.note || '', /不会阻断参考图生成/)
  })
})

function makeModel(id, name, custom, modelUrl = `/${id}.glb`, templateId = '') {
  return {
    id,
    name,
    subtitle: `${name} subtitle`,
    category: custom ? 'AI 生成示意模型' : '真核细胞',
    description: `${name} description`,
    size: '10 微米',
    location: '测试位置',
    visibleInLM: '是',
    accent: '#7fb069',
    features: [{ name, detail: '测试特征' }],
    funFact: '测试事实',
    whereItOccurs: { text: '测试分布', habitat: '测试生境' },
    concepts: [],
    modelUrl,
    imageUrl: `/${id}.png`,
    fileSize: 1000,
    defaultRotationY: 0,
    displayScale: 1,
    custom,
    templateId,
  }
}

function makeCompletedJob(overrides = {}) {
  return {
    id: 'job-test',
    prompt: '线粒体开放剖面 3D 教学模型',
    provider: 'selfhost-triposg',
    template: 'mitochondrion',
    workflowMode: 'texture-enhance',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    costEstimateCny: 0,
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:30:00.000Z',
    result: {
      id: 'generated-job-test',
      name: '线粒体',
      subtitle: 'AI 生成',
      category: 'AI 生成示意模型',
      accent: '#7fb069',
      description: '测试模型',
      fileSize: 1000,
      modelUrl: '/api/3d/local-model/final.glb',
      provider: 'selfhost-triposg',
      template: 'mitochondrion',
    },
    ...overrides,
    result: {
      id: 'generated-job-test',
      name: '线粒体',
      subtitle: 'AI 生成',
      category: 'AI 生成示意模型',
      accent: '#7fb069',
      description: '测试模型',
      fileSize: 1000,
      modelUrl: '/api/3d/local-model/final.glb',
      provider: 'selfhost-triposg',
      template: 'mitochondrion',
      ...(overrides.result || {}),
    },
  }
}

function makeProviderStatus(overrides = {}) {
  const imageRoute = overrides.imageRoute || {
    ok: true,
    state: 'ready',
    status: 200,
    message: '图片模型路由已匹配。',
    requestedModels: ['gpt-image-2'],
    matchedModels: ['gpt-image-2'],
    availableModelIds: ['gpt-5.5', 'gpt-image-2'],
  }
  const modelIds = overrides.modelIds || ['gpt-5.5', 'gpt-image-2']
  const gib = 1024 * 1024 * 1024
  return {
    image: {
      localGateway: {
        configured: true,
        baseUrl: 'http://127.0.0.1:48760',
        promptModel: 'gpt-5.5',
        imageModel: 'gpt-image-2',
        imageSize: '1536x1536',
        imageQuality: 'high',
        imageRoute,
        health: { ok: true, status: 200, message: 'ok' },
        models: { ok: true, status: 200, message: 'ok', modelIds },
      },
      openai: { configured: false, baseUrl: '', auth: { ok: false, status: 401, message: 'disabled' } },
    },
    model3d: {
      selfhostTriposg: {
        configured: true,
        baseUrl: 'http://127.0.0.1:8188',
        texture: {
          enabled: true,
          minRamFreeGb: 16.5,
          minVramFreeGb: 14,
          lowMemoryTotalRamGb: 24,
          lowMemoryRemoteEnabled: true,
          autoFallback: true,
        },
        resourceGuard: {
          enabled: true,
          minRamFreeGb: 10,
          minVramFreeGb: 6,
          maxLocalPending: 1,
          blockWhenRemoteBusy: true,
        },
        runtime: { running: 0, pending: 0, maxPending: 1, blockWhenRemoteBusy: true },
        status: {
          ok: true,
          state: 'ready',
          recoverable: false,
          message: '自部署 3D 服务在线。',
          ram: { total: 20 * gib, free: 19 * gib },
          gpu: [{ vramTotal: 20 * gib, vramFree: 19 * gib }],
          queue: { running: 0, pending: 0 },
        },
      },
      localCache: { configured: true },
      tencentHunyuan: { configured: false },
    },
  }
}
