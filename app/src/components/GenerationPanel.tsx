import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellModel } from '../data/models';
import { getModelTemplate } from '../data/models';
import {
  createFullTextTo3dJob,
  createReferenceImage,
  createTextureEnhancementJob,
  fetchTextureArtifactStatus,
  fetchTextureStabilityStatus,
  fetchProviderStatus,
  createTextToCellJob,
  fetchDemoGeneratedModels,
  fetchWorkflowDiagnostics,
  fetchWorkflowJob,
  fetchWorkflowJobs,
  previewReferencePrompt,
  resumeWorkflowJob,
  runTextureStabilityCheck,
  uploadLocalModel,
  uploadReferenceImage,
  workflowJobToCellModel,
} from '../services/fusionApi';
import type { PromptPreviewPayload, ProviderStatusPayload, ReferenceImagePayload, TextureArtifactStatusPayload, TextureStabilityStatusPayload, WorkflowDiagnosticsPayload, WorkflowJob } from '../services/fusionApi';
import { trackEvent } from '../lib/analytics';
import { buildJobHistorySummary } from '../lib/jobHistory';
import { buildGenerationTimeline } from '../lib/workflowTimeline';
import { getWorkflowWaitHint } from '../lib/workflowWait';
import { buildWorkflowPhaseBoard } from '../lib/workflowPhaseBoard';
import { buildWorkflowNextAction } from '../lib/workflowNextAction';
import { buildWorkflowPreflight } from '../lib/workflowPreflight';
import { buildChainReadiness, buildModelRoleRail, buildRuntimeRail, buildTextureArtifactHealth, buildTextureResourcePlan, buildTextureResultStatus, buildTextureStabilityHealth, buildWorkflowGuardSummary } from '../lib/workflowRuntime';
import { selectNewestGeneratedModel } from '../lib/generatedModels';
import { buildReferenceQualityGate } from '../lib/referenceQualityGate';
import { TaskWatchCard, type TaskWatchViewModel } from './TaskWatchCard';

interface Props {
  id?: string;
  captureMode?: boolean;
  generatedModels: CellModel[];
  onModelsLoaded: (models: CellModel[]) => void;
  onModelCreated: (model: CellModel) => void;
  onSelect: (id: string) => void;
}

const CAPTURE_GIB = 1024 ** 3;

const CAPTURE_PROVIDER_STATUS: ProviderStatusPayload = {
  image: {
    localGateway: {
      configured: true,
      baseUrl: 'http://127.0.0.1:48760',
      promptModel: 'gpt-5.5',
      imageModel: 'gpt-image-2',
      imageSize: '1536x1536',
      imageQuality: 'high',
      timeoutMs: 420_000,
      health: {
        ok: true,
        status: 200,
        message: 'capture-ready',
      },
      models: {
        ok: true,
        status: 200,
        message: 'capture-ready',
        modelIds: ['gpt-image-2'],
      },
      imageRoute: {
        ok: true,
        state: 'ready',
        status: 200,
        message: '48760 本地图片网关展示为可用状态。',
      },
    },
    openai: {
      configured: false,
      baseUrl: '',
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
        runtimeMinRamFreeGb: 5.5,
        runtimeMinVramFreeGb: 8,
        maxLocalPending: 1,
        blockWhenRemoteBusy: true,
      },
      texture: {
        enabled: true,
        minTotalRamGb: 24,
        lowMemoryTotalRamGb: 24,
        lowMemoryRemoteEnabled: false,
        minRamFreeGb: 18,
        minVramFreeGb: 14,
        runtimeMinRamFreeGb: 5.5,
        runtimeMinVramFreeGb: 8,
        steps: 12,
        faces: 10000,
        autoFallback: true,
      },
      runtime: {
        running: 0,
        pending: 0,
        maxPending: 1,
        blockWhenRemoteBusy: true,
      },
      status: {
        ok: true,
        state: 'ready',
        message: '3D 服务展示为就绪，重任务仍受单队列和内存闸门保护。',
        ram: {
          total: 20 * CAPTURE_GIB,
          available: 13 * CAPTURE_GIB,
          free: 13 * CAPTURE_GIB,
        },
        gpu: [{
          name: 'RTX 3090',
          type: 'cuda',
          vramTotal: 24 * CAPTURE_GIB,
          vramFree: 18 * CAPTURE_GIB,
        }],
        queue: {
          running: 0,
          pending: 0,
        },
      },
    },
    localCache: {
      configured: true,
    },
    tencentHunyuan: {
      configured: false,
    },
  },
};

export function GenerationPanel({
  id,
  captureMode = false,
  generatedModels,
  onModelsLoaded,
  onModelCreated,
  onSelect,
}: Props) {
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const reportedFullReferenceIds = useRef<Set<string>>(new Set());
  const reportedCompletedJobIds = useRef<Set<string>>(new Set());
  const restoredLatestJobRef = useRef(false);
  const [status, setStatus] = useState(() => (
    captureMode
      ? '展示模式已隐藏历史任务和调试监控；真实生成仍会按 48760 图片网关、单队列和内存闸门执行。'
      : '先得到一张可确认的参考图，再进入图生 3D 建模。'
  ));
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('植物细胞 3D 教学模型，突出叶绿体、细胞壁和大型液泡');
  const [imageProvider, setImageProvider] = useState('local-gateway');
  const [imageProfile, setImageProfile] = useState('standard');
  const [modelProvider, setModelProvider] = useState('selfhost-triposg');
  const [textureMode, setTextureMode] = useState<'stable' | 'hunyuan'>('hunyuan');
  const [template, setTemplate] = useState('plant-cell');
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [referenceAccepted, setReferenceAccepted] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewPayload | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusPayload | null>(() => (
    captureMode ? CAPTURE_PROVIDER_STATUS : null
  ));
  const [providerStatusLoading, setProviderStatusLoading] = useState(() => !captureMode);
  const [textureArtifactStatus, setTextureArtifactStatus] = useState<TextureArtifactStatusPayload | null>(null);
  const [textureArtifactLoading, setTextureArtifactLoading] = useState(() => !captureMode);
  const [textureArtifactFeedback, setTextureArtifactFeedback] = useState(() => (
    captureMode
      ? '展示模式：贴图产物检查会在真实运行时只读执行。'
      : '只读检查现有 GLB，不占用 3D 队列。'
  ));
  const [textureStabilityStatus, setTextureStabilityStatus] = useState<TextureStabilityStatusPayload | null>(null);
  const [textureStabilityLoading, setTextureStabilityLoading] = useState(() => !captureMode);
  const [textureStabilityRunning, setTextureStabilityRunning] = useState(false);
  const [textureStabilityRunMode, setTextureStabilityRunMode] = useState<'dry-run' | 'fallback-long-check' | null>(null);
  const [textureStabilityFeedback, setTextureStabilityFeedback] = useState(() => (
    captureMode
      ? '展示模式：长测入口保留，真实运行时按串行与低内存保护执行。'
      : '先只读预检 raw GLB 与资源闸门，不提交远端混元重任务。'
  ));
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [jobHistory, setJobHistory] = useState<WorkflowJob[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmedPrompt, setConfirmedPrompt] = useState<PromptPreviewPayload | null>(null);
  const [operationStartedAt, setOperationStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(getTimestamp);
  const [syncingJobId, setSyncingJobId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnosticsPayload | null>(null);
  const [diagnosingJobId, setDiagnosingJobId] = useState<string | null>(null);

  const phase = getWorkflowPhase({ referenceImage, activeJob, busy });
  const failedPhase = getWorkflowFailedPhase(activeJob);
  const promptPreviewMatchesCurrent =
    Boolean(promptPreview?.imagePrompt) &&
    promptPreview?.sourcePrompt.trim() === prompt.trim() &&
    promptPreview?.template === template &&
    normalizeUiImageProvider(promptPreview?.provider || imageProvider) === imageProvider;
  const confirmedPromptMatchesCurrent =
    Boolean(confirmedPrompt?.imagePrompt) &&
    confirmedPrompt?.sourcePrompt.trim() === prompt.trim() &&
    confirmedPrompt?.template === template &&
    normalizeUiImageProvider(confirmedPrompt?.provider || imageProvider) === imageProvider;

  const loadTextureArtifactStatus = useCallback(async () => {
    setTextureArtifactLoading(true);
    try {
      const payload = await fetchTextureArtifactStatus(3);
      setTextureArtifactStatus(payload);
      setTextureArtifactFeedback(buildTextureArtifactFeedback(payload));
      return payload;
    } catch {
      setTextureArtifactStatus(null);
      setTextureArtifactFeedback('贴图产物检查失败：请确认任务记录和 GLB 缓存仍可读取。');
      return null;
    } finally {
      setTextureArtifactLoading(false);
    }
  }, []);

  const applyTextureStabilityStatus = useCallback((payload: TextureStabilityStatusPayload) => {
    setTextureStabilityStatus(payload);
    setTextureStabilityRunning(Boolean(payload.running));
    setTextureStabilityFeedback(payload.running
      ? '服务端已有连续验证正在运行：按钮已锁定，等待当前 3 次轻量贴图验证完成。'
      : buildTextureStabilityFeedback(payload));
  }, []);

  const applyWorkflowJobUpdate = useCallback((
    job: WorkflowJob,
    options: { selectModel?: boolean; statusOverride?: string; trackCompletion?: boolean } = {}
  ) => {
    setActiveJob(job);
    const jobReference = job.reference;
    if (jobReference) {
      setReferenceImage((current) => {
        if (current?.id === jobReference.id) return current;
        return toReferenceImage(jobReference, false);
      });
      setReferenceAccepted(Boolean(job.referenceId));
      setPromptPreview((current) => current ?? {
        template: jobReference.template,
        sourcePrompt: jobReference.prompt,
        model: jobReference.promptModel || 'local-template',
        imagePrompt: jobReference.imagePrompt || '',
        negativePrompt: jobReference.negativePrompt || '',
        qualityChecklist: [],
      });
      if (!reportedFullReferenceIds.current.has(jobReference.id)) {
        reportedFullReferenceIds.current.add(jobReference.id);
        trackEvent('workflow_full_reference_ready', {
          jobId: job.id,
          template: job.template,
          referenceId: jobReference.id,
        });
      }
    }

    setStatus(options.statusOverride || job.stage);
    setJobHistory((current) => mergeJobs(job, current));

    const model = workflowJobToCellModel(job);
    if (model) {
      onModelCreated(model);
      if (options.selectModel !== false) onSelect(model.id);
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(options.statusOverride || '建模完成：结果已缓存并加入模型索引。');
      if (options.trackCompletion !== false && !reportedCompletedJobIds.current.has(job.id)) {
        reportedCompletedJobIds.current.add(job.id);
        trackEvent('workflow_job_completed', {
          jobId: job.id,
          template: job.template,
          provider: job.provider,
          modelId: model.id,
        });
      }
      if (job.provider === 'selfhost-triposg') void loadTextureArtifactStatus();
    }

    if (job.status === 'failed') {
      const failedMessage = isSelfhostJobResumable(job)
        ? '远端三维输出暂未完成；已保留 ComfyUI prompt_id，请先诊断远端，恢复后再续接输出。'
        : job.error || job.stage || '生成任务失败。';
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(failedMessage);
      trackEvent('workflow_job_failed', {
        jobId: job.id,
        template: job.template,
        provider: job.provider,
        message: failedMessage,
      });
    }
  }, [loadTextureArtifactStatus, onModelCreated, onSelect]);

  useEffect(() => {
    const shouldTick = busy || activeJob?.status === 'queued' || activeJob?.status === 'processing';
    if (!shouldTick) return undefined;
    const timer = window.setInterval(() => setClockNow(getTimestamp()), 1000);
    return () => window.clearInterval(timer);
  }, [activeJob?.status, busy]);

  useEffect(() => {
    if (captureMode) {
      restoredLatestJobRef.current = true;
      return;
    }

    let cancelled = false;
    fetchProviderStatus(false)
      .then((statusPayload) => {
        if (cancelled) return;
        setProviderStatus(statusPayload);
        setProviderStatusLoading(false);
        return fetchProviderStatus(true);
      })
      .then((statusPayload) => {
        if (cancelled || !statusPayload) return;
        setProviderStatus(statusPayload);
      })
      .catch(() => {
        if (!cancelled) setProviderStatus(null);
      })
      .finally(() => {
        if (!cancelled) setProviderStatusLoading(false);
      });

    fetchWorkflowJobs()
      .then((jobs) => {
        if (cancelled) return;
        setJobHistory(jobs);
        const completedModels = jobs.map(workflowJobToCellModel).filter((model): model is CellModel => Boolean(model));
        if (completedModels.length) {
          onModelsLoaded(completedModels);
        }
        if (!restoredLatestJobRef.current) {
          const latestInspectableJob = selectLatestInspectableJob(jobs);
          if (latestInspectableJob?.reference) {
            restoredLatestJobRef.current = true;
            const resumable = isSelfhostJobResumable(latestInspectableJob);
            setActiveJob(latestInspectableJob);
            setDetailsOpen(isLiveWorkflowJob(latestInspectableJob) || resumable);
            setReferenceImage(toReferenceImage(latestInspectableJob.reference, false));
            setReferenceAccepted(Boolean(latestInspectableJob.referenceId));
            setPromptPreview({
              template: latestInspectableJob.reference.template,
              sourcePrompt: latestInspectableJob.reference.prompt,
              model: latestInspectableJob.reference.promptModel || 'local-template',
              imagePrompt: latestInspectableJob.reference.imagePrompt || '',
              negativePrompt: latestInspectableJob.reference.negativePrompt || '',
              qualityChecklist: [],
            });
            setStatus(
              isLiveWorkflowJob(latestInspectableJob)
                ? `已恢复正在处理的任务：${latestInspectableJob.stage}`
                : resumable
                  ? '已恢复远端三维任务：参考图和 ComfyUI prompt_id 均已保留，请先诊断远端。'
                : '已恢复最近完成任务：参考图、建模结果与标本索引均可继续查看。'
            );
          } else if (latestInspectableJob) {
            restoredLatestJobRef.current = true;
            setActiveJob(latestInspectableJob);
            setDetailsOpen(true);
            setReferenceAccepted(false);
            setStatus(`已恢复正在处理的任务：${latestInspectableJob.stage}`);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setJobHistory([]);
      });

    fetchTextureArtifactStatus(3)
      .then((payload) => {
        if (!cancelled) {
          setTextureArtifactStatus(payload);
          setTextureArtifactFeedback(buildTextureArtifactFeedback(payload));
        }
      })
      .catch(() => {
        if (!cancelled) setTextureArtifactStatus(null);
      })
      .finally(() => {
        if (!cancelled) setTextureArtifactLoading(false);
      });

    fetchTextureStabilityStatus()
      .then((payload) => {
        if (!cancelled) {
          applyTextureStabilityStatus(payload);
        }
      })
      .catch(() => {
        if (!cancelled) setTextureStabilityStatus(null);
      })
      .finally(() => {
        if (!cancelled) setTextureStabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTextureStabilityStatus, captureMode, onModelsLoaded]);

  useEffect(() => {
    if (!textureStabilityStatus?.running) return undefined;
    const timer = window.setInterval(() => {
      fetchTextureStabilityStatus()
        .then((payload) => {
          applyTextureStabilityStatus(payload);
          if (!payload.running && payload.summary) void loadTextureArtifactStatus();
        })
        .catch(() => {
          setTextureStabilityFeedback('连续验证状态刷新失败：稍后会再次同步。');
        });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [applyTextureStabilityStatus, loadTextureArtifactStatus, textureStabilityStatus?.running]);

  useEffect(() => {
    if (providerStatusLoading || textureMode !== 'hunyuan' || !providerStatus) return;
    const timer = window.setTimeout(() => {
      setStatus((current) => {
        if (
          current.includes('正在同步 ComfyUI 资源状态') ||
          current.includes('正在检查混元贴图资源')
        ) {
          return buildHy3dTextureRunMessage(providerStatus);
        }
        return current;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [providerStatus, providerStatusLoading, textureMode]);

  useEffect(() => {
    if (!activeJob || activeJob.status === 'completed' || activeJob.status === 'failed') return;

    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchWorkflowJob(activeJob.id)
        .then((job) => {
          if (cancelled) return;
          applyWorkflowJobUpdate(job);
        })
        .catch((error) => {
          if (cancelled) return;
          setBusy(false);
          setOperationStartedAt(null);
          setStatus(error instanceof Error ? error.message : '任务状态查询失败。');
        });
    }, 900);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob, applyWorkflowJobUpdate]);

  const handleRefreshProviderStatus = async () => {
    setProviderStatusLoading(true);
    setStatus('正在刷新本地图片网关与 3D 队列状态...');
    try {
      const statusPayload = await fetchProviderStatus(true);
      setProviderStatus(statusPayload);
      const imageReady = isImageProviderReady(statusPayload, imageProvider);
      const modelReady = isModel3dReady(statusPayload);
      setStatus(imageReady && modelReady
        ? '链路预检完成：图片网关与 3D 服务均可用。'
        : `链路预检完成：${!imageReady ? buildImageProviderBlockedMessage(statusPayload, imageProvider) : buildModel3dBlockedMessage(statusPayload)}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '链路预检失败。');
    } finally {
      setProviderStatusLoading(false);
    }
  };

  const handleRefreshTextureArtifacts = async () => {
    setStatus('正在只读检查最近贴图 GLB；这不会提交混元贴图任务，也不会占用 3D 队列。');
    const payload = await loadTextureArtifactStatus();
    if (!payload) {
      setStatus('贴图产物检查失败：请确认本地 API 仍可读取任务记录和 GLB 缓存。');
      return;
    }
    if (payload.checked <= 0) {
      setStatus('贴图产物检查完成：还没有可检查的 selfhost 贴图产物。');
      return;
    }
    setStatus(payload.ok
      ? `贴图产物检查完成：最近 ${payload.checked} 个产物均通过 active material 检查。`
      : `贴图产物检查完成：${payload.failed}/${payload.checked} 个产物存在白模风险，请优先复查最新任务。`);
  };

  const handleRunTextureStability = async () => {
    if (textureStabilityRunning) return;
    setTextureStabilityRunning(true);
    setTextureStabilityRunMode('dry-run');
    setTextureStabilityFeedback('正在只读预检：读取来源 raw GLB、参考图和资源闸门，不提交贴图任务。');
    setStatus('正在只读预检“白模 raw GLB → 原参考图贴图”链路；本次不会提交 3D 或混元贴图重任务。');
    trackEvent('workflow_texture_stability_run', {
      runs: 0,
      textureMode: 'fallback-color',
      dryRun: true,
      source: 'generation-panel',
    });
    try {
      const payload = await runTextureStabilityCheck({ runs: 1, textureMode: 'fallback-color', dryRun: true });
      applyTextureStabilityStatus(payload);
      await loadTextureArtifactStatus();
      setStatus(payload.summary?.dryRun && payload.summary.ok
        ? '贴图链路只读预检通过：raw GLB、参考图和资源闸门可用；需要长测时再运行连续贴图任务。'
        : payload.summary?.ok
        ? `连续贴图验证通过：${payload.summary.coloredRuns}/${payload.summary.requestedRuns} 次均产出非白模彩色 GLB。`
        : payload.message || '连续贴图验证未完全通过，请查看报告摘要。');
    } catch (error) {
      setTextureStabilityFeedback(error instanceof Error ? error.message : '连续验证启动失败。');
      setStatus(error instanceof Error ? error.message : '连续贴图验证启动失败。');
    } finally {
      const latest = await fetchTextureStabilityStatus().catch(() => null);
      if (latest) applyTextureStabilityStatus(latest);
      else setTextureStabilityRunning(false);
      setTextureStabilityRunMode(null);
    }
  };

  const handleRunTextureFallbackLongCheck = async () => {
    if (textureStabilityRunning) return;
    setTextureStabilityRunning(true);
    setTextureStabilityRunMode('fallback-long-check');
    setTextureStabilityFeedback('正在运行轻量长测：串行复用 raw GLB 生成 3 次参考图贴图 fallback，不调用远端 Hunyuan3D-Paint。');
    setStatus('正在连续验证“白模 raw GLB → 原参考图轻量贴图”链路；本次只走 fallback-color，保持串行和低内存保护。');
    trackEvent('workflow_texture_stability_run', {
      runs: 3,
      textureMode: 'fallback-color',
      dryRun: false,
      allowHunyuan: false,
      source: 'generation-panel-long-check',
    });
    try {
      const payload = await runTextureStabilityCheck({
        runs: 3,
        textureMode: 'fallback-color',
        dryRun: false,
        allowHunyuan: false,
        timeoutMinutes: 5,
        cooldownMs: 1000,
      });
      applyTextureStabilityStatus(payload);
      await loadTextureArtifactStatus();
      setStatus(payload.summary?.ok
        ? `轻量贴图长测通过：${payload.summary.coloredRuns}/${payload.summary.requestedRuns} 次均产出非白模 fallback GLB，未调用混元重任务。`
        : payload.message || '轻量贴图长测未完全通过，请查看报告摘要和失败轮次。');
    } catch (error) {
      setTextureStabilityFeedback(error instanceof Error ? error.message : '轻量贴图长测启动失败。');
      setStatus(error instanceof Error ? error.message : '轻量贴图长测启动失败。');
    } finally {
      const latest = await fetchTextureStabilityStatus().catch(() => null);
      if (latest) applyTextureStabilityStatus(latest);
      else setTextureStabilityRunning(false);
      setTextureStabilityRunMode(null);
    }
  };

  const handleTextureModeChange = async (mode: 'stable' | 'hunyuan') => {
    setTextureMode(mode);

    if (mode === 'stable') {
      setStatus('已切回稳定几何优先：优先产出可查看 GLB，可在资源充足时再做贴图增强。');
      return;
    }

    if (modelProvider !== 'selfhost-triposg') {
      setStatus('混元贴图增强只在自部署 TripoSG 链路中启用；当前 3D provider 会继续使用稳定几何。');
      return;
    }

    if (providerStatusLoading) {
      setStatus('正在同步 ComfyUI 资源状态；未确认前不会提交 Hunyuan3D-Paint。');
      return;
    }

    const selfhost = providerStatus?.model3d.selfhostTriposg;
    const needsDeepStatus = !selfhost?.status || !selfhost?.texture;
    if (!needsDeepStatus) {
      setStatus(buildHy3dTextureRunMessage(providerStatus));
      return;
    }

    setProviderStatusLoading(true);
    setStatus('正在检查混元贴图资源与 ComfyUI 队列；未通过资源保护前不会提交 Hunyuan3D-Paint。');
    try {
      const statusPayload = await fetchProviderStatus(true);
      setProviderStatus(statusPayload);
      setStatus(buildHy3dTextureRunMessage(statusPayload));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '混元贴图资源检查失败，当前仍可使用稳定几何链路。');
    } finally {
      setProviderStatusLoading(false);
    }
  };

  const handleLoadDemo = async () => {
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setStatus('正在读取 3DCellForge 缓存模型...');
    try {
      const models = await fetchDemoGeneratedModels();
      onModelsLoaded(models);
      setStatus(models.length ? `已加载 ${models.length} 个缓存生成模型。` : '没有找到可用的缓存模型。');
      if (models[0]) onSelect(models[0].id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '读取缓存模型失败。');
    } finally {
      setBusy(false);
      setOperationStartedAt(null);
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setStatus(`正在导入 ${file.name}...`);
    trackEvent('local_model_upload_start', {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'model/gltf-binary',
    });
    try {
      const model = await uploadLocalModel(file);
      onModelCreated(model);
      onSelect(model.id);
      setStatus(`${model.name} 已导入并加入模型列表。`);
      trackEvent('local_model_upload_completed', {
        modelId: model.id,
        fileName: file.name,
        fileSize: file.size,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '本地模型导入失败。');
      trackEvent('local_model_upload_failed', {
        fileName: file.name,
        message: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      setBusy(false);
      setOperationStartedAt(null);
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  };

  const handleReferenceUpload = async (file: File) => {
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setStatus('正在写入参考图缓存...');
    trackEvent('workflow_reference_upload_start', {
      fileName: file.name,
      fileSize: file.size,
      template,
    });
    try {
      const reference = await uploadReferenceImage(file, {
        prompt: prompt.trim() || `${file.name} 生物 3D 教学参考图`,
        template,
      });
      setReferenceImage(toReferenceImage(reference, true));
      setReferenceAccepted(false);
      setStatus('已接收上传图片，请确认结构方向后进入图生 3D。');
      setActiveJob(null);
      trackEvent('workflow_reference_upload', {
        fileName: file.name,
        fileSize: file.size,
        template,
        referenceId: reference.id,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '参考图上传失败。');
      trackEvent('workflow_reference_upload_failed', {
        fileName: file.name,
        message: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      setBusy(false);
      setOperationStartedAt(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const handleCreateReference = async () => {
    await runCreateReference();
  };

  const runCreateReference = async (options: {
    promptValue?: string;
    templateValue?: string;
    imageProviderValue?: string;
    imageProfileValue?: string;
    statusPrefix?: string;
    eventSource?: string;
  } = {}) => {
    const nextPrompt = (options.promptValue ?? prompt).trim();
    const nextTemplate = options.templateValue || template;
    const nextImageProvider = normalizeUiImageProvider(options.imageProviderValue || imageProvider);
    const nextImageProfile = normalizeUiImageProfile(options.imageProfileValue || imageProfile);

    if (!nextPrompt) {
      setStatus('请先输入生物结构描述，或上传一张参考图。');
      return;
    }
    const forceImageRetry = canForceRetryImageProvider(providerStatus, nextImageProvider);
    if (!isImageProviderReady(providerStatus, nextImageProvider) && !forceImageRetry) {
      setStatus(buildImageProviderBlockedMessage(providerStatus, nextImageProvider));
      trackEvent('workflow_reference_generate_failed', {
        template: nextTemplate,
        imageProvider: nextImageProvider,
        reason: 'image-provider-not-ready',
        source: options.eventSource || 'panel',
      });
      return;
    }

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setImageProfile(nextImageProfile);
    setStatus(options.statusPrefix || (forceImageRetry
      ? '正在绕过最近一次失败缓存重试 48760 文生图；如果标准规格仍失败，后端会自动尝试轻量规格。'
      : `${getImageProviderName(nextImageProvider)} 正在生成 3D-ready 单图参考图...`));
    const shouldUseConfirmedPrompt =
      Boolean(confirmedPrompt?.imagePrompt) &&
      confirmedPrompt?.sourcePrompt.trim() === nextPrompt &&
      confirmedPrompt?.template === nextTemplate &&
      normalizeUiImageProvider(confirmedPrompt?.provider || nextImageProvider) === nextImageProvider;
    if (!shouldUseConfirmedPrompt) {
      setPromptPreview(null);
      setConfirmedPrompt(null);
    }
    trackEvent('workflow_reference_generate_start', {
      template: nextTemplate,
      imageProvider: nextImageProvider,
      imageProfile: nextImageProfile,
      imageProfileLabel: getImageProfileLabel(nextImageProfile),
      promptLength: nextPrompt.length,
      promptConfirmed: shouldUseConfirmedPrompt,
      source: options.eventSource || 'panel',
    });
    try {
      const reference = await createReferenceImage({
        prompt: nextPrompt,
        provider: nextImageProvider,
        template: nextTemplate,
        ...(shouldUseConfirmedPrompt ? { imagePromptOverride: confirmedPrompt?.imagePrompt } : {}),
        forceImageRetry,
        ...getImageProfileRequest(nextImageProfile),
      });
      setImageProfile(normalizeUiImageProfile(reference.imageProfile || nextImageProfile));
      setReferenceImage(toReferenceImage(reference, false));
      setReferenceAccepted(false);
      setPromptPreview({
        template: reference.template,
        sourcePrompt: reference.prompt,
        model: reference.promptModel || 'local-template',
        imagePrompt: reference.imagePrompt || '',
        negativePrompt: reference.negativePrompt || '',
        qualityChecklist: [],
      });
      setActiveJob(null);
      setDetailsOpen(true);
      setStatus(`${getImageProviderName(nextImageProvider)} 已产出 ${buildImageSpecLabel(reference.imageProfile, reference.imageSize, reference.imageQuality)} 参考图，请检查后点击“接收图片”，再确认建模。`);
      trackEvent('workflow_reference_generate', {
        template: nextTemplate,
        imageProvider: nextImageProvider,
        imageProfile: reference.imageProfile || nextImageProfile,
        imageProfileLabel: getImageProfileLabel(reference.imageProfile || nextImageProfile),
        promptLength: nextPrompt.length,
        referenceId: reference.id,
        model: reference.model,
        promptConfirmed: shouldUseConfirmedPrompt,
        source: options.eventSource || 'panel',
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '参考图生成失败。');
      trackEvent('workflow_reference_generate_failed', {
        template: nextTemplate,
        imageProvider: nextImageProvider,
        message: error instanceof Error ? error.message : 'unknown',
        source: options.eventSource || 'panel',
      });
    } finally {
      setBusy(false);
      setOperationStartedAt(null);
    }
  };

  const handlePreviewPrompt = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构术语或课堂描述。');
      return;
    }

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setConfirmedPrompt(null);
    setStatus('正在打磨 3D-ready 单图 prompt...');
    try {
      const nextPreview = await previewReferencePrompt({
        prompt: prompt.trim(),
        template,
        provider: imageProvider,
      });
      setPromptPreview(nextPreview);
      setStatus('Prompt 已生成，可检查后继续生成参考图。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Prompt 预览失败。');
    } finally {
      setBusy(false);
      setOperationStartedAt(null);
    }
  };

  const handleRegeneratePrompt = async () => {
    setConfirmedPrompt(null);
    trackEvent('workflow_prompt_regenerate', {
      template,
      imageProvider,
      promptLength: prompt.trim().length,
    });
    await handlePreviewPrompt();
  };

  const handleConfirmPrompt = () => {
    if (!promptPreview?.imagePrompt) {
      setStatus('请先生成一版 3D-ready prompt，再确认使用。');
      return;
    }
    if (!promptPreviewMatchesCurrent) {
      setConfirmedPrompt(null);
      setStatus('当前提示词预览已过期，请点击“重新生成提示词”后再确认。');
      return;
    }
    setConfirmedPrompt(promptPreview);
    setStatus('已确认提示词，生成参考图时将直接使用这版 3D-ready prompt。');
    trackEvent('workflow_prompt_confirm', {
      template: promptPreview.template,
      provider: promptPreview.provider || imageProvider,
      model: promptPreview.model,
      promptLength: promptPreview.imagePrompt.length,
    });
  };

  const handleRunFullWorkflow = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构术语或课堂描述。');
      return;
    }
    const forceImageRetry = canForceRetryImageProvider(providerStatus, imageProvider);
    if (!isImageProviderReady(providerStatus, imageProvider) && !forceImageRetry) {
      setStatus(buildImageProviderBlockedMessage(providerStatus, imageProvider));
      trackEvent('workflow_model_confirm_blocked', {
        reason: 'image-provider-not-ready',
        source: 'full-workflow',
        template,
        imageProvider,
        provider: modelProvider,
      });
      return;
    }
    if (modelProvider === 'selfhost-triposg' && !isModel3dReady(providerStatus)) {
      const message = buildModel3dBlockedMessage(providerStatus);
      setStatus(message);
      trackEvent('workflow_model_confirm_blocked', {
        reason: 'model-resource-guard',
        source: 'full-workflow',
        template,
        provider: modelProvider,
      });
      return;
    }
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setReferenceImage(null);
    setReferenceAccepted(false);
    if (!confirmedPromptMatchesCurrent) {
      setPromptPreview(null);
      setConfirmedPrompt(null);
    }
    setActiveJob(null);
    const nextTextureMode = modelProvider === 'selfhost-triposg' ? textureMode : 'stable';
    setStatus(forceImageRetry
      ? '正在绕过 48760 最近失败缓存启动完整链路；标准生图失败后会自动降级到轻量图片规格，再接续图生 3D。'
      : nextTextureMode === 'hunyuan'
      ? `${buildHy3dTextureRunMessage(providerStatus)} 正在按贴图增强链路执行：术语 → GPT prompt → 单图 → TripoSG → Hunyuan3D-Paint/Bio3D fallback → final GLB。`
      : '正在按稳定链路执行：术语 → GPT prompt → 单图 → TripoSG → Bio3D final GLB。');
    trackEvent('workflow_full_run_start', {
      template,
      imageProvider,
      imageProfile,
      imageProfileLabel: getImageProfileLabel(imageProfile),
      imageSize: getImageProfileOption(imageProfile).size,
      imageQuality: getImageProfileOption(imageProfile).quality,
      provider: modelProvider,
      textureMode: nextTextureMode,
      promptLength: prompt.trim().length,
      promptConfirmed: confirmedPromptMatchesCurrent,
    });

    try {
      const { reference, job } = await createFullTextTo3dJob({
        prompt: prompt.trim(),
        provider: modelProvider,
        textureMode: nextTextureMode,
        imageProvider,
        forceImageRetry,
        ...getImageProfileRequest(imageProfile),
        template,
        ...(confirmedPromptMatchesCurrent ? { imagePromptOverride: confirmedPrompt?.imagePrompt } : {}),
      });
      if (reference) {
        setReferenceImage(toReferenceImage(reference, false));
        setReferenceAccepted(true);
        setPromptPreview({
          template: reference.template,
          sourcePrompt: reference.prompt,
          model: reference.promptModel || 'local-template',
          imagePrompt: reference.imagePrompt || '',
          negativePrompt: reference.negativePrompt || '',
          qualityChecklist: [],
        });
      }
      setActiveJob(job);
      setDetailsOpen(true);
      setJobHistory((current) => mergeJobs(job, current));
      setStatus(job.stage);
      trackEvent('workflow_job_created', {
        jobId: job.id,
        template: job.template,
        provider: job.provider,
        costEstimateCny: job.costEstimateCny,
        referenceId: reference?.id ?? job.referenceId,
        workflowMode: job.workflowMode,
        textureMode: job.textureMode,
        imageProvider: job.imageProvider,
        imageProfile: job.imageProfile || imageProfile,
        imageSize: job.imageSize || getImageProfileOption(imageProfile).size,
        imageQuality: job.imageQuality || getImageProfileOption(imageProfile).quality,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '完整生成链路启动失败。');
      setBusy(false);
      setOperationStartedAt(null);
      trackEvent('workflow_job_failed', {
        template,
        provider: modelProvider,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  const handleAcceptReference = () => {
    if (!referenceImage) {
      setStatus('还没有可接收的参考图，请先生成或上传一张图片。');
      return;
    }
    setReferenceAccepted(true);
    setStatus('参考图已接收，可点击“确认图生建模”提交 3D 任务。');
    trackEvent('workflow_reference_accept', {
      template,
      source: referenceImage.source,
      uploaded: referenceImage.uploaded,
    });
  };

  const handleRejectReference = () => {
    setReferenceImage(null);
    setReferenceAccepted(false);
    setActiveJob(null);
    setDetailsOpen(false);
    setOperationStartedAt(null);
    setStatus('已退回参考图，请修改描述后重新生成，或上传一张图片。');
    trackEvent('workflow_reference_reject', { template });
  };

  const handleConfirmModeling = async () => {
    await runConfirmModeling();
  };

  const runConfirmModeling = async (options: {
    promptValue?: string;
    templateValue?: string;
    imageProviderValue?: string;
    modelProviderValue?: string;
    reference?: ReferenceImage;
    eventSource?: string;
  } = {}) => {
    const nextReference = options.reference || referenceImage;
    const nextPrompt = (options.promptValue ?? prompt).trim();
    const nextTemplate = options.templateValue || template;
    const nextImageProvider = normalizeUiImageProvider(options.imageProviderValue || imageProvider);
    const nextImageProfile = normalizeUiImageProfile(nextReference?.imageProfile || imageProfile);
    const nextModelProvider = options.modelProviderValue || modelProvider;

    if (!nextReference) {
      setStatus('需要先生成或上传参考图，再确认图生建模。');
      trackEvent('workflow_model_confirm_blocked', {
        reason: 'missing-reference',
        template: nextTemplate,
        provider: nextModelProvider,
      });
      return;
    }
    if (!options.reference && !referenceAccepted) {
      setStatus('请先检查参考图并点击“接收图片”，再提交图生 3D 建模。');
      trackEvent('workflow_model_confirm_blocked', {
        reason: 'reference-not-accepted',
        template: nextTemplate,
        provider: nextModelProvider,
        referenceId: nextReference.id,
      });
      return;
    }
    if (nextModelProvider === 'selfhost-triposg' && !isModel3dReady(providerStatus)) {
      const message = buildModel3dBlockedMessage(providerStatus);
      setStatus(message);
      trackEvent('workflow_model_confirm_blocked', {
        reason: 'model-resource-guard',
        source: options.eventSource || 'panel',
        template: nextTemplate,
        provider: nextModelProvider,
        referenceId: nextReference.id,
      });
      return;
    }
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setImageProfile(nextImageProfile);
    setModelProvider(nextModelProvider);
    setReferenceImage(nextReference);
    setReferenceAccepted(true);
    const nextTextureMode = nextModelProvider === 'selfhost-triposg' ? textureMode : 'stable';
    setStatus(nextTextureMode === 'hunyuan'
      ? `${buildHy3dTextureRunMessage(providerStatus)} 已确认参考图，正在创建图生 3D 建模任务...`
      : '已确认参考图，正在创建图生 3D 建模任务...');
    trackEvent('workflow_model_confirm', {
      template: nextTemplate,
      provider: nextModelProvider,
      imageProvider: nextImageProvider,
      imageProfile: nextImageProfile,
      textureMode: nextModelProvider === 'selfhost-triposg' ? textureMode : 'stable',
      imageSize: getImageProfileOption(nextImageProfile).size,
      imageQuality: getImageProfileOption(nextImageProfile).quality,
      referenceId: nextReference.id,
      uploaded: nextReference.uploaded,
      source: options.eventSource || 'panel',
    });
    try {
      const fallbackPrompt = nextReference.uploaded
        ? `${nextReference.title} 生物 3D 教学模型`
        : nextPrompt;
      const job = await createTextToCellJob({
        prompt: fallbackPrompt,
        provider: nextModelProvider,
        template: nextTemplate,
        imageProvider: nextImageProvider,
        ...getImageProfileRequest(nextImageProfile),
        referenceId: nextReference.id,
        textureMode: nextTextureMode,
      });
      setActiveJob(job);
      setDetailsOpen(true);
      setJobHistory((current) => mergeJobs(job, current));
      setStatus(job.stage);
      trackEvent('workflow_job_created', {
        jobId: job.id,
        template: job.template,
        provider: job.provider,
        costEstimateCny: job.costEstimateCny,
        workflowMode: job.workflowMode,
        textureMode: job.textureMode,
        imageProvider: job.imageProvider,
        imageProfile: job.imageProfile || nextImageProfile,
        imageSize: job.imageSize || getImageProfileOption(nextImageProfile).size,
        imageQuality: job.imageQuality || getImageProfileOption(nextImageProfile).quality,
        source: options.eventSource || 'panel',
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '文本生成任务创建失败。');
      trackEvent('workflow_job_failed', {
        template: nextTemplate,
        provider: nextModelProvider,
        message: error instanceof Error ? error.message : 'unknown',
        source: options.eventSource || 'panel',
      });
      setBusy(false);
      setOperationStartedAt(null);
    }
  };

  const handleSelectJob = (job: WorkflowJob) => {
    hydrateJobIntoWorkspace(job, {
      acceptReference: Boolean(job.referenceId),
      keepPrompt: true,
    });
    setActiveJob(job);
    setJobHistory((current) => mergeJobs(job, current));
    setDetailsOpen(true);

    if (job.status === 'failed') {
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(
        isSelfhostJobResumable(job)
          ? '远端三维输出暂未完成；已保留 ComfyUI prompt_id，请先诊断远端，恢复后再续接输出。'
          : job.error || job.stage || '生成任务失败。'
      );
      return;
    }

    applyWorkflowJobUpdate(job, {
      selectModel: true,
      statusOverride: job.error || job.stage,
      trackCompletion: false,
    });
  };

  const handleSyncActiveJob = async () => {
    if (!activeJob || syncingJobId) return;
    setSyncingJobId(activeJob.id);
    setStatus('正在同步生成任务状态...');
    trackEvent('workflow_job_manual_sync', {
      jobId: activeJob.id,
      provider: activeJob.provider,
      status: activeJob.status,
    });
    try {
      const job = await fetchWorkflowJob(activeJob.id);
      applyWorkflowJobUpdate(job, {
        statusOverride: job.status === 'completed'
          ? '同步完成：模型已写入缓存并加入标本索引。'
          : job.stage,
      });
      setDetailsOpen(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '任务状态同步失败。');
    } finally {
      setSyncingJobId(null);
    }
  };

  const handleResumeActiveJob = async () => {
    if (!activeJob || syncingJobId) return;
    const activeDiagnostics = getDiagnosticsForJob(activeJob, diagnostics);
    const shouldDiagnoseFirst = shouldDiagnoseBeforeResume(activeJob, providerStatus, activeDiagnostics);
    if (shouldDiagnoseFirst) {
      setDetailsOpen(true);
      setStatus(buildResumeBlockedReason(activeJob, providerStatus, activeDiagnostics));
      return;
    }
    setSyncingJobId(activeJob.id);
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setStatus('正在续接本地三维输出，不会重新生成参考图...');
    trackEvent('workflow_job_manual_sync', {
      jobId: activeJob.id,
      provider: activeJob.provider,
      status: activeJob.status,
      action: 'resume-selfhost-output',
    });
    try {
      const job = await resumeWorkflowJob(activeJob.id);
      applyWorkflowJobUpdate(job, {
        statusOverride: job.stage || '已开始续接本地三维输出。',
        trackCompletion: false,
      });
      setDetailsOpen(true);
    } catch (error) {
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(error instanceof Error ? error.message : '三维任务续接失败。');
    } finally {
      setSyncingJobId(null);
    }
  };

  const handleDiagnoseActiveJob = async () => {
    if (!activeJob || diagnosingJobId) return;
    setDiagnosingJobId(activeJob.id);
    setStatus('正在诊断远端三维任务...');
    trackEvent('workflow_job_manual_sync', {
      jobId: activeJob.id,
      provider: activeJob.provider,
      status: activeJob.status,
      action: 'diagnose-selfhost-output',
    });
    try {
      const nextDiagnostics = await fetchWorkflowDiagnostics(activeJob.id);
      setDiagnostics(nextDiagnostics);
      setStatus(nextDiagnostics.recommendation);
      setDetailsOpen(true);
      trackEvent('workflow_job_manual_sync', {
        jobId: activeJob.id,
        provider: activeJob.provider,
        status: activeJob.status,
        action: 'diagnose-selfhost-output-completed',
        glbCount: nextDiagnostics.outputs.glbCount,
        queueRunning: nextDiagnostics.queue.running,
        queuePending: nextDiagnostics.queue.pending,
        historyFound: nextDiagnostics.history.found,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '远端诊断失败。');
      trackEvent('workflow_job_failed', {
        jobId: activeJob.id,
        template: activeJob.template,
        provider: activeJob.provider,
        message: error instanceof Error ? error.message : 'diagnostics failed',
        action: 'diagnose-selfhost-output',
      });
    } finally {
      setDiagnosingJobId(null);
    }
  };

  const handleOpenActiveJobModel = () => {
    if (!activeJob) return;
    const model = workflowJobToCellModel(activeJob);
    if (!model) {
      setStatus('当前任务还没有可查看的 3D 模型，请等待建模完成。');
      return;
    }
    onModelCreated(model);
    onSelect(model.id);
    setDetailsOpen(true);
    setStatus('已切换到该任务生成的 3D 模型。');
  };

  const handleTextureEnhanceActiveJob = async () => {
    if (!activeJob?.referenceId && !activeJob?.reference?.id) {
      setStatus('当前任务缺少可复用参考图，无法提交混元贴图增强。');
      return;
    }
    if (activeJob.provider !== 'selfhost-triposg') {
      setStatus('只有自部署 TripoSG 任务可以继续做混元贴图增强。');
      return;
    }
    setTextureMode('hunyuan');
    setSyncingJobId(activeJob.id);
    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setStatus(`${buildHy3dTextureRunMessage(providerStatus)} 正在提交贴图后处理：复用当前 raw GLB，不重跑 TripoSG。`);
    trackEvent('workflow_job_manual_sync', {
      jobId: activeJob.id,
      provider: activeJob.provider,
      status: activeJob.status,
      action: 'hy3dpaint-enhance-existing-raw',
    });

    try {
      const job = await createTextureEnhancementJob(activeJob.id);
      applyWorkflowJobUpdate(job, {
        statusOverride: job.stage || '已开始混元贴图后处理：复用 raw GLB，不重跑 TripoSG。',
        trackCompletion: false,
      });
      setDetailsOpen(true);
    } catch (error) {
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(error instanceof Error ? error.message : '混元贴图增强任务创建失败。');
    } finally {
      setSyncingJobId(null);
    }
  };

  const handleResultReviewAction = async (action: 'view-model' | 'open-reference' | 'download-model' | 'copy-prompt') => {
    if (!activeJob) return;
    trackEvent('workflow_result_review_action', {
      action,
      jobId: activeJob.id,
      template: activeJob.template,
      provider: activeJob.provider,
      imageProvider: activeJob.imageProvider,
    });

    if (action === 'view-model') {
      handleOpenActiveJobModel();
      return;
    }

    if (action === 'copy-prompt') {
      const promptText = activeJob.reference?.imagePrompt || promptPreview?.imagePrompt || activeJob.prompt;
      try {
        await window.navigator.clipboard.writeText(promptText);
        setStatus('已复制 3D-ready prompt，可用于复现实验或交付记录。');
      } catch {
        setStatus('浏览器暂不允许复制，请展开任务详情手动查看 Prompt。');
      }
    }
  };

  const handleRecommendedNextAction = (actionId: ReturnType<typeof buildWorkflowNextAction>['id']) => {
    if (actionId === 'generate-reference') {
      void handleCreateReference();
      return;
    }
    if (actionId === 'upload-reference') {
      imageInputRef.current?.click();
      setStatus(selectedImageProviderShortMessage
        ? `${selectedImageProviderShortMessage} 请选择一张清晰白底参考图，上传后可继续图生 3D。`
        : '请选择一张清晰白底参考图，上传后可继续图生 3D。');
      return;
    }
    if (actionId === 'accept-reference') {
      handleAcceptReference();
      return;
    }
    if (actionId === 'confirm-modeling') {
      void handleConfirmModeling();
      return;
    }
    if (actionId === 'refresh-preflight') {
      void handleRefreshProviderStatus();
      return;
    }
    if (actionId === 'sync-job') {
      void handleSyncActiveJob();
      return;
    }
    if (actionId === 'diagnose-job') {
      void handleDiagnoseActiveJob();
      return;
    }
    if (actionId === 'resume-job') {
      void handleResumeActiveJob();
      return;
    }
    if (actionId === 'view-model') {
      handleOpenActiveJobModel();
      return;
    }
    if (actionId === 'review-error') {
      setDetailsOpen(true);
      setStatus(activeJob?.error || activeJob?.stage || '请展开任务详情复查链路状态。');
      return;
    }
    document.querySelector<HTMLTextAreaElement>('.generation-prompt-field textarea')?.focus();
    setStatus('请先输入生物结构描述，或上传一张参考图。');
  };

  const isRecommendedNextActionEnabled = (actionId: ReturnType<typeof buildWorkflowNextAction>['id']) => {
    if (actionId === 'write-prompt') return true;
    if (actionId === 'upload-reference') return !busy;
    if (actionId === 'generate-reference') return canCreateReference;
    if (actionId === 'accept-reference') return Boolean(referenceImage && !busy);
    if (actionId === 'confirm-modeling') return canConfirmModeling;
    if (actionId === 'refresh-preflight') return !providerStatusLoading;
    if (actionId === 'sync-job') return Boolean(activeJob && !syncingJobId);
    if (actionId === 'diagnose-job') return Boolean(canDiagnoseActiveJob && !diagnosingJobId);
    if (actionId === 'resume-job') return Boolean(canResumeActiveJob && !syncingJobId);
    if (actionId === 'view-model') return Boolean(activeJob?.result);
    return Boolean(activeJob);
  };

  const hydrateJobIntoWorkspace = (
    job: WorkflowJob,
    options: { acceptReference?: boolean; keepPrompt?: boolean } = {}
  ) => {
    if (!options.keepPrompt) setPrompt(job.prompt);
    setTemplate(job.template || 'auto');
    setImageProvider(normalizeUiImageProvider(job.imageProvider || imageProvider));
    setImageProfile(normalizeUiImageProfile(job.imageProfile || imageProfile));
    setModelProvider(job.provider || modelProvider);
    setTextureMode(job.textureMode === 'hunyuan' ? 'hunyuan' : 'stable');
    if (job.reference) {
      setReferenceImage(toReferenceImage(job.reference, false));
      setReferenceAccepted(Boolean(options.acceptReference));
      setPromptPreview({
        template: job.reference.template,
        sourcePrompt: job.reference.prompt,
        model: job.reference.promptModel || 'local-template',
        imagePrompt: job.reference.imagePrompt || '',
        negativePrompt: job.reference.negativePrompt || '',
        qualityChecklist: [],
      });
    }
  };

  const handleReuseJobPrompt = (job: WorkflowJob) => {
    hydrateJobIntoWorkspace(job, {
      acceptReference: Boolean(job.referenceId),
      keepPrompt: false,
    });
    setActiveJob(job);
    setDetailsOpen(true);
    setStatus('已复用该任务描述，可直接重试参考图或重新完整生成。');
    trackEvent('workflow_job_prompt_reuse', {
      jobId: job.id,
      template: job.template,
      provider: job.provider,
    });
  };

  const handleRetryJobReference = async (job: WorkflowJob) => {
    hydrateJobIntoWorkspace(job, { keepPrompt: false });
    setActiveJob(null);
    setReferenceAccepted(false);
    setDetailsOpen(true);
    await runCreateReference({
      promptValue: job.prompt,
      templateValue: job.template,
      imageProviderValue: normalizeUiImageProvider(job.imageProvider || imageProvider),
      statusPrefix: '正在基于历史任务重新生成参考图...',
      eventSource: 'job-detail',
    });
  };

  const handleRemodelJobReference = async (job: WorkflowJob) => {
    if (!job.reference) {
      setStatus('该任务没有可复用的参考图，请先重试参考图。');
      return;
    }
    hydrateJobIntoWorkspace(job, {
      acceptReference: true,
      keepPrompt: false,
    });
    setDetailsOpen(true);
    await runConfirmModeling({
      promptValue: job.prompt,
      templateValue: job.template,
      imageProviderValue: normalizeUiImageProvider(job.imageProvider || imageProvider),
      modelProviderValue: job.provider || modelProvider,
      reference: toReferenceImage(job.reference, false),
      eventSource: 'job-detail',
    });
  };

  const progress = activeJob?.progress ?? 0;
  const diagnosticsForActiveJob = getDiagnosticsForJob(activeJob, diagnostics);
  const resumeShouldDiagnoseFirst = shouldDiagnoseBeforeResume(activeJob, providerStatus, diagnosticsForActiveJob);
  const resumeBlockedReason = resumeShouldDiagnoseFirst
    ? buildResumeBlockedReason(activeJob, providerStatus, diagnosticsForActiveJob)
    : null;
  const model3dReady = isModel3dReady(providerStatus);
  const canSubmitModeling = modelProvider !== 'selfhost-triposg' || model3dReady;
  const canConfirmModeling = !busy && canSubmitModeling && !!referenceImage && referenceAccepted && activeJob?.status !== 'completed' && activeJob?.status !== 'processing' && activeJob?.status !== 'queued';
  const selectedProviderOnline = isImageProviderReady(providerStatus, imageProvider);
  const selectedProviderForceRetry = canForceRetryImageProvider(providerStatus, imageProvider);
  const selectedImageProviderBlockedMessage = !providerStatusLoading && !selectedProviderOnline
    ? buildImageProviderBlockedMessage(providerStatus, imageProvider)
    : null;
  const selectedImageProviderShortMessage = selectedImageProviderBlockedMessage
    ? buildImageProviderFallbackMessage(providerStatus, imageProvider)
    : null;
  const canPreviewPrompt = !busy && prompt.trim().length >= 6;
  const canCreateReference = canPreviewPrompt && (selectedProviderOnline || selectedProviderForceRetry);
  const selectedProviderLabel = getImageProviderName(imageProvider);
  const gatewayRouteHint = buildGatewayRouteHint(providerStatus, imageProvider);
  const model3dBlockKind = modelProvider === 'selfhost-triposg' && providerStatus && !model3dReady
    ? getModel3dBlockKind(providerStatus)
    : null;
  const model3dBlockedMessage = model3dBlockKind
    ? buildModel3dBlockedMessage(providerStatus)
    : null;
  const activeChainSummary = buildActiveChainSummary(providerStatus, imageProvider, modelProvider, textureMode);
  const selectedModelProviderLabel = getModelProviderName(modelProvider);
  const stageMonitor = buildStageMonitor({
    activeJob,
    busy,
    clockNow,
    imageProviderLabel: selectedProviderLabel,
    modelProvider,
    operationStartedAt,
    phase,
    referenceAccepted,
    referenceImage,
  });
  const latestCompletedJob = newestJob(
    [activeJob, ...jobHistory].filter((job): job is WorkflowJob => Boolean(job?.result?.modelUrl && job.status === 'completed'))
  );
  const latestCompletedJobModel = latestCompletedJob ? workflowJobToCellModel(latestCompletedJob) : null;
  const latestGeneratedModel = latestCompletedJobModel || selectNewestGeneratedModel(generatedModels);
  const taskWatch = activeJob ? buildTaskWatch(activeJob, clockNow) : null;
  const latestGeneratedName = latestGeneratedModel ? formatGeneratedModelName(latestGeneratedModel.name) : '';
  const latestResultLabel = latestGeneratedModel
    ? [latestGeneratedModel.source || latestGeneratedModel.generationStatus, latestGeneratedModel.subtitle]
        .filter(Boolean)
        .join(' / ')
    : '';
  const detailReference = activeJob?.reference || (referenceImage ? referenceImageToPayload(referenceImage, prompt, template) : null);
  const detailsRows = activeJob ? buildJobDetailRows(activeJob) : [];
  const selectedImageProfileOption = getImageProfileOption(imageProfile);
  const selectedImageSpecLabel = `${selectedImageProfileOption.label} ${selectedImageProfileOption.size}`;
  const generationTimeline = buildGenerationTimeline({
    prompt,
    promptPreviewReady: Boolean(promptPreview),
    referenceReady: Boolean(referenceImage),
    referenceAccepted,
    activeJob,
    busy,
    imageProviderLabel: selectedProviderLabel,
    imageSpecLabel: selectedImageSpecLabel,
    modelProviderLabel: selectedModelProviderLabel,
  });
  const phaseBoard = buildWorkflowPhaseBoard({
    prompt,
    activeJob,
    referenceImage,
    referenceAccepted,
    busy,
    now: clockNow,
    operationStartedAt,
    imageProviderLabel: selectedProviderLabel,
    imageSpecLabel: selectedImageSpecLabel,
    modelProviderLabel: selectedModelProviderLabel,
  });
  const referenceSpecLabel = detailReference
    ? buildImageSpecLabel(detailReference.imageProfile, detailReference.imageSize, detailReference.imageQuality)
    : '';
  const resultModelUrl = activeJob?.result?.modelUrl;
  const rawModelUrl = activeJob?.result?.rawModelUrl;
  const texturedModelUrl = activeJob?.result?.texturedModelUrl;
  const modelOutputChain = activeJob?.result ? buildModelOutputChain(activeJob) : null;
  const canResumeActiveJob = isSelfhostJobResumable(activeJob);
  const canDiagnoseActiveJob = isSelfhostJobDiagnosable(activeJob);
  const canTextureEnhanceActiveJob = canEnhanceWithHy3dTexture(activeJob);
  const hy3dTextureReady = isHy3dTextureReady(providerStatus);
  const hy3dTextureMessage = buildHy3dTextureStatusMessage(providerStatus);
  const workflowPreflight = buildWorkflowPreflight({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
    imageSpecLabel: selectedImageSpecLabel,
  });
  const nextAction = buildWorkflowNextAction({
    prompt,
    busy,
    referenceImage,
    referenceAccepted,
    activeJob,
    canResumeActiveJob,
    canDiagnoseActiveJob,
    resumeShouldDiagnoseFirst,
    resumeBlockedReason,
    imageProviderReady: selectedProviderOnline,
    imageProviderChecking: providerStatusLoading,
    imageProviderBlockedReason: selectedImageProviderShortMessage,
    canUploadReference: !busy,
    model3dReady,
    model3dBlockedKind: model3dBlockKind,
    model3dBlockedReason: model3dBlockedMessage,
    syncing: Boolean(syncingJobId),
  });
  const resultReview = activeJob?.status === 'completed' && activeJob.result
    ? buildResultReview(activeJob)
    : null;
  const textureResultStatus = resultReview ? buildTextureResultStatus(activeJob) : null;
  const jobHistorySummary = buildJobHistorySummary(jobHistory, activeJob);
  const visibleJobHistory = jobHistorySummary.visible;
  const hiddenJobCount = jobHistorySummary.hiddenCount;
  const quickStatusItems = [
    {
      label: '图片',
      value: providerStatusLoading ? '检查中' : selectedProviderOnline ? '正常' : selectedProviderForceRetry ? '可重试' : '需检查',
      state: providerStatusLoading ? 'pending' : selectedProviderOnline ? 'ok' : 'warn',
    },
    {
      label: '3D',
      value: providerStatusLoading ? '同步中' : getModel3dStatusLabel(providerStatus),
      state: providerStatusLoading ? 'pending' : getModel3dStatusClass(providerStatus),
    },
    {
      label: '阶段',
      value: getPhaseLabel(phase),
      state: phase === 'failed' ? 'warn' : phase === 'done' ? 'ok' : busy ? 'pending' : 'idle',
    },
  ];
  const recommendedActionTestId = nextAction.targetTestId;
  const actionStatusItems = buildActionStatusItems({
    phase,
    busy,
    promptReady: prompt.trim().length >= 6,
    promptPreviewReady: promptPreviewMatchesCurrent,
    promptConfirmed: confirmedPromptMatchesCurrent,
    referenceImage,
    referenceAccepted,
    activeJob,
    selectedProviderOnline,
    model3dReady,
    model3dBlockKind,
    resumeShouldDiagnoseFirst,
    providerStatusLoading,
  });
  const runtimeRailItems = buildRuntimeRail({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
  });
  const modelRoleItems = buildModelRoleRail({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
  });
  const textureResourcePlan = buildTextureResourcePlan({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
    textureMode,
  });
  const workflowGuardSummary = buildWorkflowGuardSummary({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
  });
  const chainReadiness = buildChainReadiness({
    status: providerStatus,
    loading: providerStatusLoading,
    imageProvider,
    modelProvider,
    textureMode,
  });
  const textureArtifactHealth = buildTextureArtifactHealth(textureArtifactStatus, textureArtifactLoading);
  const textureStabilityHealth = buildTextureStabilityHealth(
    textureStabilityStatus,
    textureStabilityLoading,
    textureStabilityRunning || Boolean(textureStabilityStatus?.running),
  );
  const textureStabilityBusy = textureStabilityRunning || Boolean(textureStabilityStatus?.running);
  const textureArtifactCheckedAt = textureArtifactStatus?.generatedAt
    ? formatRelativeTime(textureArtifactStatus.generatedAt, clockNow)
    : textureArtifactLoading
      ? '同步中'
      : '未检查';
  const textureStabilityCheckedAt = textureStabilityStatus?.generatedAt
    ? formatRelativeTime(textureStabilityStatus.generatedAt, clockNow)
    : textureStabilityLoading
      ? '同步中'
      : '未运行';
  const referenceQualityGate = referenceImage ? buildReferenceQualityGate(referenceImage) : null;
  const imageFallbackNotice = selectedImageProviderShortMessage
    ? `${selectedImageProviderShortMessage} 上传图片后仍可走图生 3D，队列与内存保护会继续生效。`
    : null;

  return (
    <section className={`generation-panel${captureMode ? ' generation-panel--capture' : ''}`} id={id} data-testid="generation-panel">
      <div>
        <span className="generation-eyebrow">§ 01 — WORKFLOW DESK</span>
        <h2>生成工坊</h2>
        <p>文本或图片先形成参考图，确认后再交给图生 3D 服务，适合课堂里逐步讲解。</p>
      </div>

      <label className="generation-field generation-prompt-field">
        <span>01 TEXT PROMPT / 生物结构描述</span>
        <textarea
          value={prompt}
          maxLength={600}
          onFocus={() => trackEvent('workflow_prompt_focus', { template })}
          onChange={(event) => {
            setPrompt(event.target.value);
            setPromptPreview(null);
            setConfirmedPrompt(null);
          }}
          placeholder="例如：动物细胞 3D 教学模型，突出线粒体、细胞核和细胞膜"
        />
      </label>

      <section className={`prompt-approval-card${confirmedPromptMatchesCurrent ? ' confirmed' : ''}`} aria-label="提示词确认" data-testid="prompt-approval-card">
        <div className="prompt-approval-copy">
          <span>提示词工序</span>
          <strong>{confirmedPromptMatchesCurrent ? '已锁定 3D-ready prompt' : promptPreviewMatchesCurrent ? '检查后确认提示词' : '先生成可复现提示词'}</strong>
          <p>{confirmedPromptMatchesCurrent ? '参考图会使用已确认版本，降低构图漂移。' : '先让 GPT-5.5 打磨单图 prompt，再生成参考图或完整生成。'}</p>
        </div>
        <div className="prompt-approval-actions">
          <button type="button" onClick={handlePreviewPrompt} disabled={!canPreviewPrompt} data-testid="preview-prompt">
            预览提示词
          </button>
          <button type="button" onClick={handleRegeneratePrompt} disabled={!canPreviewPrompt} data-testid="regenerate-prompt">
            重新生成提示词
          </button>
          <button type="button" onClick={handleConfirmPrompt} disabled={!promptPreviewMatchesCurrent || busy || confirmedPromptMatchesCurrent} data-testid="confirm-prompt">
            {confirmedPromptMatchesCurrent ? '已确认' : '确认提示词'}
          </button>
        </div>
      </section>

      <div className="generation-actions" id="workflow-actions" aria-label="生成操作">
        <section className={`workflow-next-action ${nextAction.state}`} aria-label="推荐下一步" data-testid="workflow-next-action">
          <small>当前建议</small>
          <span>{nextAction.title}</span>
          <p>{nextAction.hint}</p>
          <button
            type="button"
            className={isRecommendedNextActionEnabled(nextAction.id) ? 'is-recommended' : ''}
            onClick={() => handleRecommendedNextAction(nextAction.id)}
            disabled={!isRecommendedNextActionEnabled(nextAction.id)}
            data-testid="workflow-next-action-button"
          >
            {nextAction.label}
          </button>
        </section>
        <div className="generation-action-main" aria-label="主流程操作">
          <button type="button" className={`generation-primary${recommendedActionTestId === 'generate-reference' ? ' is-recommended' : ''}`} onClick={handleCreateReference} disabled={!canCreateReference} data-testid="generate-reference">
            生成参考图
          </button>
          <button type="button" className="generation-primary full-action" onClick={handleRunFullWorkflow} disabled={!canCreateReference || busy || !canSubmitModeling} title={textureResourcePlan.strategy.detail} data-testid="run-full-workflow">
            完整生成
          </button>
          <button type="button" className={`generation-primary confirm-action${recommendedActionTestId === 'confirm-modeling' ? ' is-recommended' : ''}`} onClick={handleConfirmModeling} disabled={!canConfirmModeling} title={textureResourcePlan.strategy.detail} data-testid="confirm-modeling">
            确认建模
          </button>
        </div>
        <div className={`generation-path-strategy ${textureResourcePlan.strategy.state}`} aria-label="本次 3D 路径" data-testid="generation-path-strategy" title={textureResourcePlan.strategy.detail}>
          <span>本次 3D 路径</span>
          <strong>{textureResourcePlan.strategy.value}</strong>
          <small>{textureResourcePlan.strategy.detail}</small>
        </div>
        {model3dBlockedMessage && (
          <div className={`generation-resource-guard ${model3dBlockKind || 'sync'}`} role="status" data-testid="generation-resource-guard">
            <span>{getModel3dBlockLabel(model3dBlockKind)}</span>
            <strong>{model3dBlockedMessage}</strong>
          </div>
        )}
        {imageFallbackNotice && (
          <div className="image-fallback-notice" role="status" data-testid="image-fallback-notice">
            <span>图片上游</span>
            <strong>{imageFallbackNotice}</strong>
          </div>
        )}
        <div className="generation-action-status" aria-label="当前链路节点" data-testid="generation-action-status">
          {actionStatusItems.map((item) => (
            <span className={item.state} key={item.label}>
              <small>{item.label}</small>
              <strong>{item.value}</strong>
            </span>
          ))}
        </div>
        <div className="generation-action-secondary" aria-label="辅助操作">
          <button type="button" className={`generation-secondary${recommendedActionTestId === 'upload-reference-image' ? ' is-recommended' : ''}`} onClick={() => imageInputRef.current?.click()} disabled={busy} data-testid="upload-reference-image">
            上传图片
          </button>
          <button type="button" className="generation-secondary" onClick={handleCreateReference} disabled={!canCreateReference} title={selectedImageProviderBlockedMessage || undefined} data-testid="retry-reference-image">
            重试图片
          </button>
          <button type="button" className={`generation-secondary${recommendedActionTestId === 'accept-reference-image' ? ' is-recommended' : ''}`} onClick={handleAcceptReference} disabled={!referenceImage || busy} data-testid="accept-reference-image">
            {referenceAccepted ? '已接收' : '接收图片'}
          </button>
          <button type="button" className="generation-secondary" onClick={handleRejectReference} disabled={!referenceImage || busy} data-testid="reject-reference-image">
            退回图片
          </button>
          <button type="button" className="generation-secondary" onClick={handleLoadDemo} disabled={busy}>
            加载缓存
          </button>
          <button type="button" className="generation-secondary" onClick={() => modelInputRef.current?.click()} disabled={busy}>
            导入 GLB
          </button>
        </div>
      </div>

      <section className={`workflow-guard-summary ${workflowGuardSummary.state}`} aria-label="链路守护摘要" data-testid="workflow-guard-summary">
        <div>
          <span>链路守护摘要</span>
          <strong>{workflowGuardSummary.title}</strong>
          <p>{workflowGuardSummary.detail}</p>
        </div>
        <div className="workflow-guard-chips">
          {workflowGuardSummary.chips.map((chip) => (
            <span className={chip.state} key={chip.id}>
              <small>{chip.label}</small>
              <strong>{chip.value}</strong>
            </span>
          ))}
        </div>
      </section>

      <section className={`chain-readiness ${chainReadiness.state}`} aria-label="文生图到图生3D链路就绪" data-testid="chain-readiness">
        <div className="chain-readiness-copy">
          <span>链路就绪</span>
          <div className={`chain-readiness-title ${chainReadiness.badge.state}`}>
            <strong>{chainReadiness.title}</strong>
            <em data-testid="chain-readiness-badge">
              <small>{chainReadiness.badge.label}</small>
              {chainReadiness.badge.value}
            </em>
          </div>
          <p>{chainReadiness.detail}</p>
        </div>
        <div className="chain-readiness-steps" aria-label="链路分步状态">
          {chainReadiness.steps.map((step) => (
            <span className={step.state} key={step.id} title={step.note}>
              <small>{step.label}</small>
              <strong>{step.value}</strong>
              <em>{step.note}</em>
            </span>
          ))}
        </div>
      </section>

      <section className={`texture-mode-card ${textureMode === 'hunyuan' ? 'enhanced' : 'stable'}`} aria-label="3D 贴图模式" data-testid="texture-mode-card">
        <div>
          <span>3D 贴图模式</span>
          <strong>{textureMode === 'hunyuan' ? '混元贴图增强' : '稳定几何优先'}</strong>
          <p>{textureMode === 'hunyuan'
            ? hy3dTextureReady
              ? '会复用 raw GLB 调用 Hunyuan3D-Paint；失败时自动嵌入参考图做轻量贴图 fallback。'
              : '资源保护时先完成稳定 GLB；资源不过线会嵌入参考图写入轻量贴图 fallback。'
            : '默认优先产出可用几何模型；白模不是失败，需要贴图时再做增强。'}</p>
          <div className={`texture-submit-strategy ${textureResourcePlan.strategy.state}`} aria-label="贴图提交策略" data-testid="texture-submit-strategy" title={textureResourcePlan.strategy.detail}>
            <span>{textureResourcePlan.strategy.label}</span>
            <strong>{textureResourcePlan.strategy.value}</strong>
            <small>{textureResourcePlan.strategy.detail}</small>
          </div>
        </div>
        <div className="texture-mode-actions" role="group" aria-label="选择贴图模式">
          <button
            type="button"
            className={textureMode === 'stable' ? 'active' : ''}
            onClick={() => void handleTextureModeChange('stable')}
            disabled={busy}
            data-testid="texture-mode-stable"
          >
            稳定几何
          </button>
          <button
            type="button"
            className={textureMode === 'hunyuan' ? 'active' : ''}
            onClick={() => void handleTextureModeChange('hunyuan')}
            disabled={busy}
            title={hy3dTextureMessage}
            data-testid="texture-mode-hunyuan"
          >
            混元贴图
          </button>
        </div>
        <div className="texture-mode-safety" aria-label="贴图资源安全边界" data-testid="texture-mode-safety">
          {textureResourcePlan.items
            .filter((item) => item.id === 'memory' || item.id === 'vram' || item.id === 'time')
            .map((item) => (
              <span className={item.state} key={item.id} title={item.note}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            ))}
        </div>
        <em>{hy3dTextureMessage}</em>
      </section>

      <section className={`texture-preflight-card ${textureStabilityHealth.state}`} aria-label="贴图只读预检" aria-live="polite" data-testid="texture-stability-preflight-card">
        <div className="texture-preflight-copy">
          <span>连续白模换原贴图</span>
          <strong>{textureStabilityHealth.title}</strong>
          <p>{textureStabilityHealth.detail}</p>
          <div className="texture-path-strip" aria-label="贴图路径状态" data-testid="texture-stability-path-strip">
            {textureStabilityHealth.paths.map((path) => (
              <span className={path.state} key={path.id} title={path.note}>
                <small>{path.label}</small>
                <strong>{path.value}</strong>
              </span>
            ))}
          </div>
          <em data-testid="texture-stability-feedback">{textureStabilityFeedback}</em>
        </div>
        <div className="texture-preflight-action" data-testid="texture-stability-latest">
          <button
            type="button"
            onClick={() => void handleRunTextureStability()}
            disabled={textureStabilityBusy}
            title="只读预检 raw GLB、参考图与资源闸门，不提交远端混元重任务"
            data-testid="run-texture-stability"
          >
            {textureStabilityRunMode === 'dry-run' ? '预检中' : '只读预检'}
          </button>
          <button
            type="button"
            onClick={() => void handleRunTextureFallbackLongCheck()}
            disabled={textureStabilityBusy}
            title="串行运行 3 次轻量 fallback 贴图验证，不调用远端 Hunyuan3D-Paint"
            data-testid="run-texture-fallback-long-check"
          >
            {textureStabilityRunMode === 'fallback-long-check' ? '长测中' : '轻量长测'}
          </button>
          <small data-testid="texture-stability-checked-at">最近验证：{textureStabilityCheckedAt}</small>
          {textureStabilityHealth.latest?.modelUrl ? (
            <a href={textureStabilityHealth.latest.modelUrl} target="_blank" rel="noreferrer" data-testid="texture-stability-open-model">
              最后一轮 GLB
            </a>
          ) : (
            <em>不提交重任务</em>
          )}
        </div>
      </section>

      <details className="generation-inspector" data-testid="generation-inspector">
        <summary>
          <span>链路巡检</span>
          <strong>{workflowPreflight.title}</strong>
          <em>{textureArtifactHealth.title}</em>
        </summary>
        <div className="generation-inspector-body">
          <section className={`model-role-card ${textureResourcePlan.state}`} aria-label="模型角色与贴图资源计划" data-testid="model-role-card">
            <div className="model-role-copy">
              <span>模型角色</span>
              <strong>{textureResourcePlan.title}</strong>
              <p>{textureResourcePlan.detail}</p>
            </div>
            <div className="model-role-rail" aria-label="当前模型分工">
              {modelRoleItems.map((item) => (
                <span className={item.state} key={item.id} title={item.note}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                  <em>{item.note}</em>
                </span>
              ))}
            </div>
            <div className="texture-resource-rail" aria-label="贴图资源与耗时预估">
              {textureResourcePlan.items.map((item) => (
                <span className={item.state} key={item.id} title={item.note}>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                  <em>{item.note}</em>
                </span>
              ))}
            </div>
          </section>

          <section className={`texture-artifact-health ${textureArtifactHealth.state}`} aria-label="贴图产物健康检查" aria-live="polite" data-testid="texture-artifact-health">
            <div className="texture-artifact-copy">
              <div className="texture-artifact-title-row">
                <span>贴图产物健康</span>
                <div className="texture-artifact-actions">
                  <button
                    type="button"
                    onClick={() => void handleRefreshTextureArtifacts()}
                    disabled={textureArtifactLoading}
                    title="只读取现有 GLB 缓存，不提交 Hunyuan3D-Paint 任务"
                    data-testid="refresh-texture-artifacts"
                  >
                    {textureArtifactLoading ? '检查中' : '只读刷新'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRunTextureStability()}
                    disabled={textureStabilityBusy}
                    title="只读预检 raw GLB、参考图与资源闸门，不提交远端混元重任务"
                  >
                    {textureStabilityRunMode === 'dry-run' ? '预检中' : '只读预检'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRunTextureFallbackLongCheck()}
                    disabled={textureStabilityBusy}
                    title="串行运行 3 次轻量 fallback 贴图验证，不调用远端 Hunyuan3D-Paint"
                  >
                    {textureStabilityRunMode === 'fallback-long-check' ? '长测中' : '轻量长测'}
                  </button>
                </div>
              </div>
              <strong>{textureArtifactHealth.title}</strong>
              <p>{textureArtifactHealth.detail}</p>
              <em data-testid="texture-artifact-checked-at">最近检查：{textureArtifactCheckedAt} · 不提交重任务</em>
              <em data-testid="texture-artifact-feedback">{textureArtifactFeedback}</em>
              {textureArtifactHealth.latest && (
                <div className={`texture-artifact-latest ${textureArtifactHealth.latest.state}`} data-testid="texture-artifact-latest">
                  <span>最新产物</span>
                  <strong>{textureArtifactHealth.latest.mode} · {textureArtifactHealth.latest.fileSize}</strong>
                  <small>{textureArtifactHealth.latest.verdict}</small>
                  {textureArtifactHealth.latest.modelUrl ? (
                    <a href={textureArtifactHealth.latest.modelUrl} target="_blank" rel="noreferrer" data-testid="texture-artifact-open-model">
                      打开 GLB
                    </a>
                  ) : (
                    <em>本地链接缺失</em>
                  )}
                </div>
              )}
              <div className="texture-path-strip compact" aria-label="贴图路径状态" data-testid="texture-artifact-path-strip">
                {textureArtifactHealth.paths.map((path) => (
                  <span className={path.state} key={path.id} title={path.note}>
                    <small>{path.label}</small>
                    <strong>{path.value}</strong>
                  </span>
                ))}
              </div>
              <div className={`texture-stability-latest ${textureStabilityHealth.state}`} data-testid="texture-stability-latest-detail">
                <span>连续白模换原贴图</span>
                <strong>{textureStabilityHealth.title}</strong>
                <small>{textureStabilityHealth.detail}</small>
                <em data-testid="texture-stability-feedback-detail">{textureStabilityFeedback}</em>
                <em data-testid="texture-stability-checked-at-detail">最近验证：{textureStabilityCheckedAt}</em>
                {textureStabilityHealth.latest?.modelUrl ? (
                  <a href={textureStabilityHealth.latest.modelUrl} target="_blank" rel="noreferrer" data-testid="texture-stability-open-model-detail">
                    最后一轮 GLB
                  </a>
                ) : null}
              </div>
            </div>
            <div className="texture-artifact-chips" aria-label="最近贴图产物检查摘要">
              {textureArtifactHealth.chips.map((chip) => (
                <span className={chip.state} key={chip.id}>
                  <small>{chip.label}</small>
                  <strong>{chip.value}</strong>
                </span>
              ))}
              {textureStabilityHealth.chips.map((chip) => (
                <span className={chip.state} key={`stability-${chip.id}`}>
                  <small>{chip.label}</small>
                  <strong>{chip.value}</strong>
                </span>
              ))}
            </div>
          </section>

          <div className="runtime-rail" aria-label="生成链路运行仪表" data-testid="runtime-rail">
            {runtimeRailItems.map((item) => (
              <span className={item.state} key={item.id} title={item.note}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
                <em>{item.note}</em>
              </span>
            ))}
          </div>

          {visibleJobHistory.length > 0 && (
            <div className="job-history" data-testid="job-history-compact">
              <div className="job-history-title">
                <span>队列摘要</span>
                <strong>{jobHistorySummary.liveCount > 0 ? `${jobHistorySummary.liveCount} 个运行中` : '最近 2 条'}</strong>
                <em>{hiddenJobCount > 0 ? `已收纳 ${hiddenJobCount} 条` : `共 ${jobHistorySummary.totalCount} 条`}</em>
              </div>
              {visibleJobHistory.map((job, index) => (
                <button
                  type="button"
                  className={`job-row history-slot-${index + 1} ${job.status}${activeJob?.id === job.id ? ' active' : ''}`}
                  key={job.id}
                  onClick={() => handleSelectJob(job)}
                >
                  <span>
                    <small>{getWorkflowModeLabel(job.workflowMode || 'image-to-3d')} · {getShortJobId(job.id)}</small>
                    <em>{job.prompt}</em>
                  </span>
                  <strong data-testid="job-history-status">{getJobHistoryStatusLabel(job)}</strong>
                </button>
              ))}
              <p className="job-history-note">固定摘要，不向下增长；完整记录保留在本地任务接口。</p>
            </div>
          )}
        </div>
      </details>

      {taskWatch && (
        <TaskWatchCard
          taskWatch={taskWatch}
          activeJob={activeJob}
          diagnostics={diagnostics}
          syncingJobId={syncingJobId}
          diagnosingJobId={diagnosingJobId}
          canResumeActiveJob={canResumeActiveJob}
          canDiagnoseActiveJob={canDiagnoseActiveJob}
          resumeShouldDiagnoseFirst={resumeShouldDiagnoseFirst}
          resumeBlockedReason={resumeBlockedReason}
          onSync={handleSyncActiveJob}
          onResume={handleResumeActiveJob}
          onDiagnose={handleDiagnoseActiveJob}
          onOpenModel={handleOpenActiveJobModel}
          onToggleDetails={() => setDetailsOpen((current) => !current)}
        />
      )}

      {promptPreview?.imagePrompt && (
        <div className={`prompt-preview-card inline${confirmedPromptMatchesCurrent ? ' confirmed' : ''}`} aria-label="3D-ready prompt 预览" data-testid="prompt-preview-card">
          <div>
            <span>3D-READY PROMPT</span>
            <strong>{confirmedPromptMatchesCurrent ? '已确认' : promptPreview.model}</strong>
          </div>
          <p>{promptPreview.imagePrompt}</p>
          <em>{confirmedPromptMatchesCurrent ? '下一步可以生成参考图或直接完整生成。' : '检查构图、剖面和白底单图要求后，点击“确认提示词”。'}</em>
        </div>
      )}

      {referenceImage && (
        <section className={`reference-gate-card${referenceAccepted ? ' accepted' : ''}`} aria-label="参考图验收" data-testid="reference-gate-card">
          <header>
            <span>参考图验收</span>
            <strong>{referenceAccepted ? '已接收，可建模' : '待接收图片'}</strong>
          </header>
          <div className="reference-gate-grid" aria-label="参考图生成信息">
            <span>
              <small>来源</small>
              <strong>{referenceImage.source || selectedProviderLabel}</strong>
            </span>
            <span>
              <small>规格</small>
              <strong>{buildImageSpecLabel(referenceImage.imageProfile, referenceImage.imageSize, referenceImage.imageQuality)}</strong>
            </span>
            <span>
              <small>模型</small>
              <strong>{referenceImage.model || referenceImage.promptModel || '本地缓存'}</strong>
            </span>
          </div>
          {referenceQualityGate && (
            <div className={`reference-quality-strip ${referenceQualityGate.state}`} aria-label="参考图质量门槛" data-testid="reference-quality-gate">
              <div>
                <small>质量门槛</small>
                <strong>{referenceQualityGate.title}</strong>
                <p>{referenceQualityGate.summary}</p>
              </div>
              <div className="reference-quality-checks">
                {referenceQualityGate.checks.map((check) => (
                  <span key={check.id} className={check.state}>
                    <small>{check.label}</small>
                    <strong>{check.value}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
          <p>{referenceAccepted ? '参考图已锁定，下一步提交图生 3D；不满意仍可重试图片。' : '确认单主体、剖面清晰、白底留白充足后，再接收图片进入建模。'}</p>
          <div className="reference-gate-actions" aria-label="参考图验收操作">
            <button type="button" onClick={handleAcceptReference} disabled={busy || referenceAccepted} data-testid="accept-reference-gate">
              {referenceAccepted ? '已接收' : '接收图片'}
            </button>
            <button type="button" onClick={handleCreateReference} disabled={!canCreateReference} data-testid="retry-reference-gate">
              重试图片
            </button>
            <button type="button" onClick={handleConfirmModeling} disabled={!canConfirmModeling} data-testid="confirm-modeling-gate">
              确认建模
            </button>
          </div>
        </section>
      )}

      <section className={`generation-timeline ${generationTimeline.state}`} aria-label="完整生成路线" data-testid="generation-timeline">
        <header>
          <span>生成路线</span>
          <strong>{generationTimeline.currentLabel}</strong>
        </header>
        <ol>
          {generationTimeline.steps.map((step) => (
            <li className={step.state} key={step.id}>
              <i>{step.no}</i>
              <span>
                <strong>{step.title}</strong>
                <small>{step.caption}</small>
              </span>
            </li>
          ))}
        </ol>
        <p>{generationTimeline.nextAction}</p>
      </section>

      <section className={`workflow-phase-board ${phaseBoard.state}`} aria-label="生成阶段看板" data-testid="workflow-phase-board">
        <header>
          <span>阶段看板</span>
          <strong>{phaseBoard.title}</strong>
        </header>
        <div className="workflow-phase-grid">
          {phaseBoard.phases.map((item) => (
            <article className={item.state} key={item.id}>
              <i>{item.no}</i>
              <span>
                <strong>{item.title}</strong>
                <small>{item.meta}</small>
              </span>
              <p>{item.hint}</p>
            </article>
          ))}
        </div>
        <footer>
          <strong>{phaseBoard.summary}</strong>
          <em>{phaseBoard.queueNote}</em>
        </footer>
      </section>

      <section className={`workflow-preflight-card ${workflowPreflight.state}`} aria-label="链路预检" data-testid="workflow-preflight-card">
        <header>
          <span>链路预检</span>
          <strong>{workflowPreflight.title}</strong>
          <button type="button" onClick={handleRefreshProviderStatus} disabled={providerStatusLoading} data-testid="refresh-provider-status">
            {providerStatusLoading ? '同步中' : '刷新'}
          </button>
        </header>
        <p>{workflowPreflight.summary}</p>
        <div className="workflow-preflight-grid">
          {workflowPreflight.checks.map((check) => (
            <span className={check.state} title={check.hint} key={check.id}>
              <small>{check.label}</small>
              <strong>{check.value}</strong>
            </span>
          ))}
        </div>
        <em>{workflowPreflight.recommendation}</em>
      </section>

      {generatedModels.length > 0 && (
        <button
          type="button"
          className="latest-result-card"
          data-testid="latest-result-card"
          onClick={() => {
            if (latestGeneratedModel) onSelect(latestGeneratedModel.id);
          }}
        >
          <span>最新生成</span>
          <strong>{latestGeneratedName || `${generatedModels.length} 个模型`}</strong>
          <em>{latestResultLabel || '已进入底部标本索引'}</em>
        </button>
      )}

      {resultReview && (
        <section className="job-result-review" data-testid="job-result-review" aria-label="生成结果复盘">
          <header>
            <span>生成复盘</span>
            <strong>{resultReview.title}</strong>
          </header>
          <div className="result-review-actions" aria-label="生成结果快捷操作">
            <button type="button" onClick={() => void handleResultReviewAction('view-model')} data-testid="review-view-model">
              查看模型
            </button>
            {detailReference?.imageUrl && (
              <a
                href={detailReference.imageUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => void handleResultReviewAction('open-reference')}
                data-testid="review-open-reference"
              >
                参考图
              </a>
            )}
            {resultModelUrl && (
              <a
                href={resultModelUrl}
                download
                onClick={() => void handleResultReviewAction('download-model')}
                data-testid="review-download-model"
              >
                下载 GLB
              </a>
            )}
            {canTextureEnhanceActiveJob && (
              <button
                type="button"
                onClick={() => void handleTextureEnhanceActiveJob()}
                disabled={Boolean(busy || syncingJobId)}
                title={hy3dTextureMessage}
                data-testid="review-texture-enhance"
              >
                混元贴图增强
              </button>
            )}
            <button type="button" onClick={() => void handleResultReviewAction('copy-prompt')} data-testid="review-copy-prompt">
              复制 Prompt
            </button>
          </div>
          {modelOutputChain && (
            <section className={`model-output-chain ${modelOutputChain.mode}`} aria-label="3D 输出链路" data-testid="model-output-chain">
              <header>
                <span>{modelOutputChain.title}</span>
                <strong>{modelOutputChain.returnedLabel}</strong>
              </header>
              <div className="model-output-grid">
                {modelOutputChain.items.map((item) => (
                  <article className={item.state} key={item.id}>
                    <i>{item.no}</i>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.detail}</small>
                    </span>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" data-testid={item.testId}>
                        {item.action}
                      </a>
                    ) : (
                      <em>未返回</em>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
          {textureResultStatus && (
            <section className={`texture-result-status ${textureResultStatus.state}`} aria-label="贴图结果状态" data-testid="texture-result-status">
              <span>{textureResultStatus.label}</span>
              <strong>{textureResultStatus.detail}</strong>
            </section>
          )}
          <div className="result-review-grid">
            <article>
              <small>参考图</small>
              <strong>{resultReview.referenceLabel}</strong>
              <p>{resultReview.referenceHint}</p>
            </article>
            <article>
              <small>3D 结果</small>
              <strong>{resultReview.modelLabel}</strong>
              <p>{resultReview.modelHint}</p>
            </article>
            <article>
              <small>教学概念</small>
              <strong>{resultReview.conceptLabel}</strong>
              <p>{resultReview.conceptHint}</p>
            </article>
          </div>
          <p className="result-review-next">{resultReview.nextStep}</p>
        </section>
      )}

      <div className="workflow-quick-status" aria-label="生成链路实时状态">
        {quickStatusItems.map((item) => (
          <span className={item.state} key={item.label}>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </span>
        ))}
      </div>

      {referenceImage && (
        <button
          type="button"
          className="reference-mini-card"
          onClick={() => {
            document.getElementById('reference-step')?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
              inline: 'nearest',
            });
          }}
        >
          <span className="reference-mini-thumb">
            <img src={referenceImage.url} alt={referenceImage.title} />
          </span>
          <span className="reference-mini-copy">
            <small>{referenceAccepted ? '参考图已确认' : '参考图待确认'}</small>
            <strong>{referenceImage.title}</strong>
            <em>{[referenceImage.source, buildImageSpecLabel(referenceImage.imageProfile, referenceImage.imageSize, referenceImage.imageQuality), referenceImage.promptModel || referenceImage.model].filter(Boolean).join(' · ')}</em>
          </span>
        </button>
      )}

      {stageMonitor && (
        <button
          type="button"
          className={`workflow-stage-monitor ${stageMonitor.state}`}
          aria-label="生成阶段反馈，点击查看任务详情"
          onClick={() => setDetailsOpen((current) => !current)}
        >
          <div className="stage-monitor-head">
            <span>{stageMonitor.label}</span>
            <strong>{stageMonitor.primary}</strong>
          </div>
          <div className="stage-monitor-grid">
            <span>
              <small>耗时</small>
              <em>{stageMonitor.elapsed}</em>
            </span>
            <span>
              <small>链路</small>
              <em>{stageMonitor.chain}</em>
            </span>
            <span>
              <small>预计</small>
              <em>{stageMonitor.estimate}</em>
            </span>
          </div>
          <p>{stageMonitor.nextAction}</p>
        </button>
      )}

      {(activeJob || referenceImage) && (
        <section className={`job-detail-drawer${detailsOpen ? ' open' : ''}`} aria-label="任务详情">
          <button
            type="button"
            className="job-detail-toggle"
            onClick={() => setDetailsOpen((current) => !current)}
            aria-expanded={detailsOpen}
          >
            <span>{activeJob ? '任务详情' : '参考图详情'}</span>
            <strong>{activeJob ? getShortJobId(activeJob.id) : getShortJobId(referenceImage?.id || '')}</strong>
            <em>{detailsOpen ? '收起' : '展开'}</em>
          </button>

          {detailsOpen && (
            <div className="job-detail-body">
              {activeJob && (
                <div className="job-detail-actions" aria-label="任务快捷操作">
                  <button type="button" onClick={() => handleReuseJobPrompt(activeJob)} disabled={busy}>
                    复用描述
                  </button>
                  <button type="button" onClick={() => void handleRetryJobReference(activeJob)} disabled={busy}>
                    重试参考图
                  </button>
                  <button type="button" onClick={() => void handleRemodelJobReference(activeJob)} disabled={busy || !activeJob.reference}>
                    重新建模
                  </button>
                  {canResumeActiveJob && (
                    <button type="button" onClick={handleResumeActiveJob} disabled={Boolean(syncingJobId || resumeShouldDiagnoseFirst)}>
                      续接输出
                    </button>
                  )}
                  {canDiagnoseActiveJob && (
                    <button type="button" onClick={handleDiagnoseActiveJob} disabled={Boolean(diagnosingJobId)}>
                      诊断远端
                    </button>
                  )}
                  {activeJob.result && (
                    <button
                      type="button"
                      onClick={() => {
                        const model = workflowJobToCellModel(activeJob);
                        if (model) {
                          onModelCreated(model);
                          onSelect(model.id);
                          setStatus('已切换到该任务生成的 3D 模型。');
                        }
                      }}
                    >
                      查看模型
                    </button>
                  )}
                  {canTextureEnhanceActiveJob && (
                    <button
                      type="button"
                      onClick={() => void handleTextureEnhanceActiveJob()}
                      disabled={Boolean(busy || syncingJobId)}
                      title={hy3dTextureMessage}
                      data-testid="detail-texture-enhance"
                    >
                      混元贴图增强
                    </button>
                  )}
                </div>
              )}

              {detailReference?.imageUrl && (
                <a className="job-detail-reference" href={detailReference.imageUrl} target="_blank" rel="noreferrer">
                  <img src={detailReference.imageUrl} alt={detailReference.title || '参考图'} />
                  <span>
                    <small>REFERENCE</small>
                    <strong>{detailReference.title || '参考图'}</strong>
                    <em>{[detailReference.provider, referenceSpecLabel, detailReference.model].filter(Boolean).join(' · ')}</em>
                  </span>
                </a>
              )}

              {activeJob && (
                <div className="job-detail-grid">
                  {detailsRows.map((row) => (
                    <span key={row.label}>
                      <small>{row.label}</small>
                      <strong>{row.value}</strong>
                    </span>
                  ))}
                </div>
              )}

              {activeJob?.error && (
                <p className="job-detail-error">{formatJobErrorForDisplay(activeJob)}</p>
              )}

              {activeJob?.result && (
                <div className="job-detail-result">
                  <span>
                    <small>RESULT</small>
                    <strong>{activeJob.result.name}</strong>
                    <em>{formatFileSize(activeJob.result.fileSize)} · {activeJob.result.provider}</em>
                  </span>
                  <div>
                    {resultModelUrl && (
                      <a href={resultModelUrl} target="_blank" rel="noreferrer" data-testid="detail-final-output-link">当前展示</a>
                    )}
                    {rawModelUrl && (
                      <a href={rawModelUrl} target="_blank" rel="noreferrer" data-testid="detail-raw-output-link">Raw GLB</a>
                    )}
                    {texturedModelUrl && (
                      <a href={texturedModelUrl} target="_blank" rel="noreferrer" data-testid="detail-textured-output-link">Textured GLB</a>
                    )}
                  </div>
                </div>
              )}

              {(activeJob?.reference?.imagePrompt || referenceImage?.imagePrompt || promptPreview?.imagePrompt) && (
                <details className="job-detail-prompt">
                  <summary>查看 3D-ready prompt</summary>
                  <p>{activeJob?.reference?.imagePrompt || referenceImage?.imagePrompt || promptPreview?.imagePrompt}</p>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      <ol className="workflow-ladder" aria-label="生成流程">
        {WORKFLOW_STEPS.map((step) => (
          <li className={getStepClass(step.id, phase, failedPhase)} key={step.id}>
            <span>{step.no}</span>
            <div>
              <strong>{step.title}</strong>
              <small>{step.caption}</small>
            </div>
          </li>
        ))}
      </ol>

      <div className="generation-controls">
        <label className="generation-field compact">
          <span>TEMPLATE</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value)}>
            <option value="auto">自动判断</option>
            <option value="plant-cell">植物细胞</option>
            <option value="animal-cell">动物细胞</option>
            <option value="mitochondrion">线粒体</option>
            <option value="chloroplast">叶绿体</option>
            <option value="bacterium">细菌</option>
            <option value="white-blood-cell">白细胞</option>
            <option value="neuron">神经元</option>
            <option value="dna">DNA</option>
          </select>
        </label>
        <label className="generation-field compact">
          <span>IMAGE MODEL</span>
          <select value={imageProvider} onChange={(event) => setImageProvider(event.target.value)}>
            <option value="local-gateway">本地图片网关 · GPT Image 2</option>
            <option value="openai">OpenAI GPT Image</option>
          </select>
        </label>
        <label className="generation-field compact image-profile-field">
          <span>生成规格</span>
          <select value={imageProfile} onChange={(event) => setImageProfile(normalizeUiImageProfile(event.target.value))}>
            {IMAGE_PROFILE_OPTIONS.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label} · {option.size}
              </option>
            ))}
          </select>
          <em>{selectedImageProfileOption.quality.toUpperCase()} · {selectedImageProfileOption.note} · 非4K</em>
        </label>
        <label className="generation-field compact">
          <span>3D PROVIDER</span>
          <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value)}>
            <option value="selfhost-triposg">本地 TripoSG + Bio3D</option>
            <option value="local-demo">本地缓存链路</option>
            <option value="tencent-hunyuan">腾讯混元</option>
          </select>
        </label>
        <label className="generation-field compact">
          <span>TEXTURE</span>
          <select
            value={textureMode}
            onChange={(event) => void handleTextureModeChange(event.target.value === 'hunyuan' ? 'hunyuan' : 'stable')}
            disabled={modelProvider !== 'selfhost-triposg' || busy}
          >
            <option value="stable">稳定几何优先</option>
            <option value="hunyuan">混元贴图增强</option>
          </select>
        </label>
      </div>

      <div className="provider-hint" aria-label="当前生成链路">
        <span>{selectedProviderLabel}</span>
        <strong>{activeChainSummary} · {selectedImageProfileOption.label} {selectedImageProfileOption.size}</strong>
      </div>

      <div className="local-chain-proof" aria-label="本地链路说明" data-testid="local-chain-proof">
        <span>本地链路</span>
        <strong>{buildLocalChainProofText(providerStatus, imageProvider, modelProvider, textureMode)}</strong>
      </div>

      <div className="provider-status-strip" aria-label="本地生成服务状态">
        <span className={getProviderStatusClass(providerStatusLoading, selectedProviderOnline)}>
          {providerStatusLoading ? '检查中' : selectedProviderOnline ? '图片服务正常' : '图片服务需检查'}
        </span>
        <span className={providerStatusLoading ? 'pending' : getModel3dStatusClass(providerStatus)}>
          {providerStatusLoading ? '同步中' : `3D 服务${getModel3dStatusLabel(providerStatus)}`}
        </span>
        <em>{buildProviderStatusText(providerStatus, imageProvider)}</em>
      </div>

      {gatewayRouteHint && (
        <div className={`gateway-route-hint ${gatewayRouteHint.state}`} aria-label="图片生成链路建议">
          <span>{gatewayRouteHint.label}</span>
          <strong>{gatewayRouteHint.text}</strong>
        </div>
      )}

      <div id="reference-step" className={`reference-card${referenceImage ? ' has-image' : ''}`}>
        <div className="reference-preview">
          {referenceImage ? (
            <img src={referenceImage.url} alt={referenceImage.title} />
          ) : (
            <div className="reference-empty">
              <span>IMAGE</span>
              <strong>等待参考图</strong>
            </div>
          )}
        </div>
        <div className="reference-meta">
          <span>02 REFERENCE IMAGE</span>
          <strong>{referenceImage?.title ?? '先生成或上传初版图片'}</strong>
          {referenceImage && <em>{[referenceAccepted ? '已确认' : '待确认', referenceImage.source, buildImageSpecLabel(referenceImage.imageProfile, referenceImage.imageSize, referenceImage.imageQuality), referenceImage.promptModel, referenceImage.model].filter(Boolean).join(' · ')}</em>}
          <p>{referenceImage?.note ?? '图片确认通过后，才会进入本地图生 3D 建模与结果缓存。'}</p>
        </div>
      </div>

      <div className="generation-file-inputs">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleReferenceUpload(file);
          }}
        />
        <input
          ref={modelInputRef}
          type="file"
          accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
      </div>

      <div className="generation-status">
        <span>{busy ? 'PROCESSING' : 'STATUS'}</span>
        <p>{status}</p>
        {activeJob && (
          <div className="job-progress" aria-label={`生成进度 ${progress}%`}>
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

    </section>
  );
}

function mergeJobs(job: WorkflowJob, jobs: WorkflowJob[]) {
  return [job, ...jobs.filter((item) => item.id !== job.id)].slice(0, 12);
}

function selectLatestInspectableJob(jobs: WorkflowJob[]) {
  return (
    newestJob(jobs.filter(isLiveWorkflowJob)) ||
    newestJob(jobs.filter((job) => job.status === 'completed' && Boolean(job.reference || job.result))) ||
    newestJob(jobs.filter(isSelfhostJobResumable)) ||
    newestJob(jobs.filter((job) => job.status === 'failed')) ||
    newestJob(jobs)
  );
}

function newestJob(jobs: WorkflowJob[]) {
  return [...jobs].sort((a, b) => getJobTime(b) - getJobTime(a))[0] || null;
}

function getJobTime(job: WorkflowJob) {
  const time = Date.parse(job.updatedAt || job.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

function getJobWaitStage(job: WorkflowJob, hasReference: boolean) {
  if (job.status === 'queued') return 'queue';
  if (job.workflowMode === 'full-text-to-3d' && !hasReference) return 'image';
  if (hasReference || job.referenceId) return 'modeling';
  return 'generic';
}

function referenceImageToPayload(reference: ReferenceImage, prompt: string, template: string): ReferenceImagePayload {
  return {
    id: reference.id,
    prompt: reference.prompt || prompt,
    template,
    provider: reference.source || 'local',
    source: reference.source || 'local',
    title: reference.title,
    note: reference.note,
    fileName: `${reference.id}.png`,
    fileSize: 0,
    model: reference.model || '',
    promptModel: reference.promptModel,
    generationMode: reference.generationMode,
    imageProfile: reference.imageProfile,
    imageSize: reference.imageSize,
    imageQuality: reference.imageQuality,
    imagePrompt: reference.imagePrompt,
    negativePrompt: '',
    imageUrl: reference.url,
    createdAt: '',
  };
}

function buildJobDetailRows(job: WorkflowJob) {
  const rows = [
    { label: '状态', value: getWorkflowStatusLabel(job.status) },
    { label: '进度', value: `${Math.max(0, Math.min(100, job.progress || 0))}%` },
    { label: '图片', value: getImageProviderName(job.imageProvider || 'local-gateway') },
    { label: '规格', value: buildImageSpecLabel(job.imageProfile, job.imageSize, job.imageQuality) },
    { label: '三维', value: getModelProviderName(job.provider) },
    { label: '贴图', value: getTextureModeName(job.result?.textureMode || job.effectiveTextureMode || job.textureMode) },
    { label: '模式', value: getWorkflowModeLabel(job.workflowMode || 'image-to-3d') },
    { label: '模板', value: job.template || 'auto' },
    { label: '成本', value: job.costEstimateCny ? `约 ${job.costEstimateCny} 元` : '本地链路' },
    { label: '更新', value: formatRelativeTime(job.updatedAt) },
  ];

  if (job.provider === 'selfhost-triposg' && job.providerJobId) {
    rows.splice(7, 0, { label: '续接ID', value: getShortJobId(job.providerJobId) });
  }

  return rows;
}

function buildResultReview(job: WorkflowJob) {
  const template = getModelTemplate(job.template || job.result?.template || job.result?.imageHint);
  const concepts = template.concepts || [];
  const concept = concepts[0];
  const reference = job.reference;
  const resultName = job.result?.name || template.name || job.template || '生成模型';
  const resultProvider = job.result?.provider || getModelProviderName(job.provider);

  return {
    title: formatGeneratedModelName(resultName),
    referenceLabel: reference?.model || getImageProviderName(job.imageProvider || 'local-gateway'),
    referenceHint: reference
      ? `${reference.source || '参考图'} · ${formatFileSize(reference.fileSize)} · ${reference.template || job.template}`
      : '可从任务详情继续查看参考图缓存。',
    modelLabel: resultProvider,
    modelHint: `${formatFileSize(job.result?.fileSize)} · ${getWorkflowModeLabel(job.workflowMode || 'image-to-3d')} · ${getWorkflowStatusLabel(job.status)}`,
    conceptLabel: concept ? `${concept.term} · ${concept.level}` : template.category,
    conceptHint: concept
      ? concept.explanation
      : '可结合观察顺序讲解结构、位置和模型上的可见特征。',
    nextStep: '建议先点击“查看模型”切到 3D 舞台，再用底部“概念速读”和右侧观察顺序完成课堂讲解。',
  };
}

function buildModelOutputChain(job: WorkflowJob) {
  const result = job.result;
  if (!result) return null;

  if (job.provider !== 'selfhost-triposg') {
    const referenceUrl = job.reference?.imageUrl || job.referenceImageUrl;
    const items = [
      {
        id: 'reference',
        no: '01',
        label: '参考图缓存',
        detail: referenceUrl ? `${job.reference?.source || getImageProviderName(job.imageProvider || 'local-gateway')} · ${buildImageSpecLabel(job.imageProfile, job.imageSize, job.imageQuality)}` : '等待参考图缓存',
        url: referenceUrl,
        action: '打开',
        state: referenceUrl ? 'ok' : 'pending',
        testId: 'reference-output-link',
      },
      {
        id: 'final',
        no: '02',
        label: '缓存 GLB',
        detail: result.modelUrl ? `${formatFileSize(result.fileSize)} · ${result.provider}` : '等待本地 GLB 入库',
        url: result.modelUrl,
        action: '查看',
        state: result.modelUrl ? 'current' : 'pending',
        testId: 'final-output-link',
      },
    ];
    return {
      mode: 'demo',
      title: '本地演示链路',
      returnedLabel: `${items.filter((item) => item.url).length}/${items.length} 已返回`,
      items,
    };
  }

  const includesTexturedStage = Boolean(result.texturedModelUrl);
  const actualTextured = job.effectiveTextureMode === 'hunyuan' || result.effectiveTextureMode === 'hunyuan' || Boolean(result.texturedModelUrl);
  const hasFallbackColor = job.effectiveTextureMode === 'fallback-color' || result.effectiveTextureMode === 'fallback-color' || result.textureMode === 'fallback-color';
  const requestedTexture = actualTextured || job.requestedTextureMode === 'hunyuan' || result.requestedTextureMode === 'hunyuan';
  const items = [
    {
      id: 'raw',
      no: '01',
      label: 'Raw GLB',
      detail: result.rawModelUrl ? 'TripoSG 几何初稿已缓存' : '等待 raw.glb 输出',
      url: result.rawModelUrl,
      action: '下载',
      state: result.rawModelUrl ? 'ok' : 'pending',
      testId: 'raw-output-link',
    },
    ...(includesTexturedStage || requestedTexture
      ? [{
          id: 'textured',
          no: '02',
          label: hasFallbackColor ? '轻量贴图 fallback' : 'Textured GLB',
          detail: result.texturedModelUrl
            ? '混元贴图版已写入缓存'
            : hasFallbackColor
              ? result.textureFallbackReason?.includes('默认不提交远端贴图') || result.textureFallbackReason?.includes('低内存模式')
                ? '20G 保护已跳过远端混元，已生成本地轻量贴图版'
                : '混元未返回，已生成本地轻量贴图版'
            : result.textureFallbackReason
              ? '贴图未完成，当前展示可用轻量贴图 fallback'
              : '混元贴图未返回，当前展示稳定几何版',
          url: result.texturedModelUrl || (hasFallbackColor ? result.modelUrl : undefined),
          action: result.texturedModelUrl || hasFallbackColor ? '下载' : '等待',
          state: result.texturedModelUrl || hasFallbackColor ? 'ok' : 'pending',
          testId: 'textured-output-link',
        }]
      : []),
    {
      id: 'final',
      no: includesTexturedStage || requestedTexture ? '03' : '02',
      label: '当前展示',
      detail: result.modelUrl ? `${formatFileSize(result.fileSize)} · ${result.provider}` : '等待前端入库',
      url: result.modelUrl,
      action: '打开',
      state: result.modelUrl ? 'current' : 'pending',
      testId: 'final-output-link',
    },
  ];
  return {
    mode: 'selfhost',
    title: '3D 输出链路',
    returnedLabel: `${items.filter((item) => item.url).length}/${items.length} 已返回`,
    items,
  };
}

function getWorkflowStatusLabel(status: WorkflowJob['status']) {
  if (status === 'queued') return '排队中';
  if (status === 'processing') return '生成中';
  if (status === 'completed') return '已完成';
  return '失败';
}

function getJobHistoryStatusLabel(job: WorkflowJob) {
  if (job.status === 'completed') return '完成';
  if (isSelfhostJobResumable(job)) return '待诊断';
  if (job.status === 'failed') return '复查';
  return `${Math.max(0, Math.min(100, job.progress || 0))}%`;
}

function formatJobErrorForDisplay(job: WorkflowJob) {
  if (isSelfhostJobResumable(job)) {
    return '远端三维输出暂未完成，本地已保留 ComfyUI prompt_id；请先点击“诊断远端”查看队列/history，恢复后再续接 GLB。';
  }
  return job.error || job.stage || '请检查本地网关、参考图缓存与 3D 服务状态。';
}

function getWorkflowModeLabel(mode: string) {
  if (mode === 'full-text-to-3d') return '完整生成';
  if (mode === 'image-to-3d') return '图生 3D';
  if (mode === 'texture-enhance') return '贴图增强';
  return mode;
}

function getShortJobId(id: string) {
  if (!id) return 'LOCAL';
  return id.slice(-8).toUpperCase();
}

function formatFileSize(bytes?: number) {
  if (!bytes) return '缓存文件';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelativeTime(value?: string, now = getTimestamp()) {
  if (!value) return '刚刚';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '刚刚';
  const diffSeconds = Math.max(0, Math.floor((now - time) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s 前`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

function buildTextureArtifactFeedback(payload: TextureArtifactStatusPayload | null) {
  if (!payload) return '贴图产物检查失败：请确认任务记录和 GLB 缓存仍可读取。';
  if (payload.checked <= 0) return '还没有可检查的 selfhost 贴图产物。';
  if (payload.ok) return `只读检查完成：${payload.checked} 个产物通过，未提交重任务。`;
  return `只读检查完成：${payload.failed}/${payload.checked} 个产物存在白模风险。`;
}

function buildTextureStabilityFeedback(payload: TextureStabilityStatusPayload | null) {
  const summary = payload?.summary;
  if (!summary) return '还没有贴图预检报告；可先做只读预检，确认 raw GLB、参考图和资源闸门。';
  if (summary.dryRun) {
    if (summary.ok) return '只读预检通过：来源 raw GLB、参考图和资源闸门可用，未提交贴图任务。';
    return payload?.message || summary.resourceMessage || '只读预检未通过：请复查来源任务或资源闸门。';
  }
  if (summary.ok) {
    if (summary.textureMode === 'fallback-color') {
      return `轻量长测通过：${summary.coloredRuns}/${summary.requestedRuns} 次产出非白模 fallback GLB，未调用混元重任务。`;
    }
    return `连续 ${summary.requestedRuns} 次通过，${summary.coloredRuns} 次生成非白模彩色 GLB。`;
  }
  return payload?.message || `${summary.failedRuns}/${summary.requestedRuns} 次未通过，请复查资源闸门或失败轮次。`;
}

type WorkflowPhase = 'input' | 'prompt' | 'image' | 'modeling' | 'done' | 'failed';

function isLiveWorkflowJob(job: WorkflowJob) {
  return job.status === 'queued' || job.status === 'processing';
}

interface ReferenceImage {
  id: string;
  url: string;
  title: string;
  source: string;
  note: string;
  uploaded: boolean;
  prompt?: string;
  imagePrompt?: string;
  model?: string;
  promptModel?: string;
  generationMode?: string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
}

interface StageMonitor {
  state: 'idle' | 'pending' | 'ok' | 'warn';
  label: string;
  primary: string;
  elapsed: string;
  chain: string;
  estimate: string;
  nextAction: string;
}

function toReferenceImage(reference: ReferenceImagePayload, uploaded: boolean): ReferenceImage {
  return {
    id: reference.id,
    url: reference.imageUrl,
    title: reference.title,
    source: reference.source,
    note: reference.note,
    uploaded,
    prompt: reference.prompt,
    imagePrompt: reference.imagePrompt,
    model: reference.model,
    promptModel: reference.promptModel,
    generationMode: reference.generationMode,
    imageProfile: reference.imageProfile,
    imageSize: reference.imageSize,
    imageQuality: reference.imageQuality,
  };
}

function getTimestamp() {
  return Date.now();
}

function buildTaskWatch(job: WorkflowJob, now: number): TaskWatchViewModel {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const isLive = isLiveWorkflowJob(job);
  const hasReference = Boolean(job.referenceId || job.reference);
  const hasResult = Boolean(job.result?.modelUrl);
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
  const secondsSinceUpdate = Number.isFinite(updatedAt) ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : 0;
  const createdAt = Date.parse(job.createdAt || job.updatedAt || '');
  const secondsSinceCreated = Number.isFinite(createdAt) ? Math.max(secondsSinceUpdate, Math.floor((now - createdAt) / 1000)) : secondsSinceUpdate;
  const state: TaskWatchViewModel['state'] = job.status === 'failed' ? 'warn' : job.status === 'completed' ? 'ok' : 'pending';
  const providerName = getModelProviderName(job.provider);
  const imageName = getImageProviderName(job.imageProvider || 'local-gateway');
  const waitStage = getJobWaitStage(job, hasReference);
  const isSelfhost = job.provider === 'selfhost-triposg';
  const isImageStage = job.workflowMode === 'full-text-to-3d' && !hasReference;
  const waitHint = isLive
    ? getWorkflowWaitHint(secondsSinceCreated, waitStage, {
        imageProfile: buildImageSpecLabel(job.imageProfile, job.imageSize, job.imageQuality),
        modelProfile: providerName,
      })
    : null;

  let title = '任务正在运行';
  let hint = job.stage || '系统正在同步生成任务。';
  let recoveryLabel: string | undefined;
  let recoveryHint: string | undefined;
  if (job.status === 'completed') {
    title = '模型已缓存';
    hint = '结果已写入标本索引，可点击查看模型或复用参考图继续迭代。';
  } else if (job.status === 'failed') {
    if (job.provider === 'selfhost-triposg' && job.providerJobId) {
      title = '远端输出待诊断';
      hint = '该任务已经拿到 ComfyUI prompt_id；先诊断 queue/history，确认远端恢复后再续接 GLB。';
      recoveryLabel = '待诊断';
      recoveryHint = `${getShortJobId(job.providerJobId)} · 先诊断远端，恢复后再拉取 history / GLB。`;
    } else {
      title = '任务需要复查';
      hint = job.error || job.stage || '请检查图片网关、3D 服务和参考图缓存。';
    }
  } else if (job.provider === 'selfhost-triposg' && progress >= 80) {
    title = progress >= 98 ? '正在续接三维输出' : '正在等待 GLB 输出';
    hint = job.stage || '82% 附近通常是远端 TripoSG / Bio3D 写入 raw 或 final GLB；可保持页面开启，或稍后点击同步状态。';
    if (job.providerJobId) {
      recoveryLabel = '远端任务';
      recoveryHint = `${getShortJobId(job.providerJobId)} · 队列仍在运行时请等待；history 清理后可自动复用参考图重提一次。`;
    }
  } else if (job.provider === 'selfhost-triposg' && /冷启动|恢复|OOM|不可达|自动重试/i.test(job.stage || job.error || '')) {
    title = '3D 服务正在恢复';
    hint = job.stage || '自部署 3D 服务正在冷启动或从 OOM 重启恢复，任务会保留并自动重试。';
    if (job.providerJobId) {
      recoveryLabel = '可恢复';
      recoveryHint = `${getShortJobId(job.providerJobId)} · 稍后可续接 history / GLB。`;
    }
  } else if (job.workflowMode === 'full-text-to-3d' && !hasReference) {
    title = '正在等待参考图';
    hint = secondsSinceUpdate > 120
      ? `${buildImageSpecLabel(job.imageProfile, job.imageSize, job.imageQuality)} 单图生成有时会超过 3 分钟；任务仍在后台，可稍后点击同步状态。`
      : job.stage || '系统正在生成单张 3D-ready 参考图，完成后会自动接续图生 3D。';
  } else if (hasReference) {
    title = '参考图已就绪，正在建模';
    hint = job.stage || '图生 3D 队列已接收参考图，完成后会自动加入标本索引。';
  }

  return {
    state,
    eyebrow: `${getWorkflowModeLabel(job.workflowMode || 'image-to-3d')} · ${getShortJobId(job.id)}`,
    title,
    progress,
    hint,
    recoveryLabel,
    recoveryHint,
    waitLabel: waitHint?.label,
    waitHint: waitHint?.hint,
    waitState: waitHint?.state,
    strategy: [
      {
        label: '预计',
        value: buildTaskEstimateLabel({
          completed: job.status === 'completed',
          failed: job.status === 'failed',
          isImageStage,
          isSelfhost,
          progress,
          providerJobId: job.providerJobId,
        }),
        state: job.status === 'failed' ? 'warn' : job.status === 'completed' ? 'ok' : 'pending',
      },
      {
        label: '同步',
        value: isLive ? '自动轮询' : job.status === 'completed' ? '已入库' : '手动复查',
        state: isLive ? 'pending' : job.status === 'completed' ? 'ok' : 'warn',
      },
      {
        label: '恢复',
        value: job.providerJobId ? '远端ID已保存' : isLive ? '刷新后可恢复' : hasResult ? '标本索引' : '任务详情',
        state: job.providerJobId || hasResult ? 'ok' : isLive ? 'pending' : 'idle',
      },
    ],
    items: [
      {
        label: '参考图',
        value: hasReference ? '已就绪' : '生成中',
        state: hasReference ? 'ok' : 'pending',
      },
      {
        label: '三维服务',
        value: providerName,
        state: job.status === 'failed' ? 'warn' : isLive ? 'pending' : 'ok',
      },
      {
        label: '图片模型',
        value: imageName,
        state: hasReference ? 'ok' : 'pending',
      },
      {
        label: '生成规格',
        value: buildImageSpecLabel(job.imageProfile, job.imageSize, job.imageQuality),
        state: hasReference ? 'ok' : isLive ? 'pending' : 'idle',
      },
      {
        label: '最近更新',
        value: job.status === 'completed' ? formatRelativeTime(job.updatedAt, now) : formatElapsedMs(secondsSinceUpdate * 1000),
        state: secondsSinceUpdate > 180 && isLive ? 'warn' : isLive ? 'pending' : 'ok',
      },
      {
        label: '结果',
        value: hasResult ? formatFileSize(job.result?.fileSize) : `${progress}%`,
        state: hasResult ? 'ok' : isLive ? 'pending' : 'idle',
      },
    ],
  };
}

function buildTaskEstimateLabel(input: {
  completed: boolean;
  failed: boolean;
  isImageStage: boolean;
  isSelfhost: boolean;
  progress: number;
  providerJobId?: string;
}) {
  if (input.completed) return '已完成';
  if (input.failed && input.providerJobId) return '待诊断';
  if (input.failed) return '需复查';
  if (input.isImageStage) return '1-7 分钟';
  if (input.isSelfhost && input.progress >= 80) return '贴图/GLB';
  if (input.isSelfhost) return '3-8 分钟';
  return '约 10 秒';
}

function buildStageMonitor({
  activeJob,
  busy,
  clockNow,
  imageProviderLabel,
  modelProvider,
  operationStartedAt,
  phase,
  referenceAccepted,
  referenceImage,
}: {
  activeJob: WorkflowJob | null;
  busy: boolean;
  clockNow: number;
  imageProviderLabel: string;
  modelProvider: string;
  operationStartedAt: number | null;
  phase: WorkflowPhase;
  referenceAccepted: boolean;
  referenceImage: ReferenceImage | null;
}): StageMonitor | null {
  const hasLiveJob = activeJob?.status === 'queued' || activeJob?.status === 'processing';
  const shouldShow = busy || hasLiveJob || Boolean(activeJob) || Boolean(referenceImage);
  if (!shouldShow) return null;

  const startedAt = activeJob?.createdAt ? Date.parse(activeJob.createdAt) : operationStartedAt;
  const elapsed = startedAt && Number.isFinite(startedAt)
    ? formatElapsedMs(Math.max(0, clockNow - startedAt))
    : '刚刚';
  const jobShortId = activeJob ? activeJob.id.slice(-6).toUpperCase() : referenceImage ? referenceImage.id.slice(-6).toUpperCase() : 'LOCAL';
  const modelProviderLabel = getModelProviderName(modelProvider);

  if (activeJob?.status === 'failed' || phase === 'failed') {
    const resumable = isSelfhostJobResumable(activeJob);
    return {
      state: 'warn',
      label: `任务 ${jobShortId}`,
      primary: resumable ? '远端输出待诊断' : '链路需要复查',
      elapsed,
      chain: `${imageProviderLabel} / ${modelProviderLabel}`,
      estimate: resumable ? '先诊断远端' : '需人工复查',
      nextAction: resumable
        ? '已保留 ComfyUI prompt_id；先诊断远端队列和 history，恢复后再续接输出。'
        : activeJob?.error || activeJob?.stage || '请检查本地网关、参考图缓存与 3D 服务状态。',
    };
  }

  if (activeJob?.status === 'completed' || phase === 'done') {
    return {
      state: 'ok',
      label: `任务 ${jobShortId}`,
      primary: '已缓存入库',
      elapsed,
      chain: `${imageProviderLabel} / ${modelProviderLabel}`,
      estimate: '可立即展示',
      nextAction: '模型已进入标本索引，可在 3D 舞台继续观察、复位或全局放大。',
    };
  }

  if (hasLiveJob) {
    return {
      state: 'pending',
      label: `任务 ${jobShortId}`,
      primary: activeJob.stage || '正在执行生成任务',
      elapsed,
      chain: `${imageProviderLabel} / ${modelProviderLabel}`,
      estimate: activeJob.referenceId ? '3D 建模通常数分钟' : '参考图约 1-7 分钟',
      nextAction: activeJob.referenceId
        ? '保持页面开启；远端完成 raw.glb/textured.glb/final.glb 后会自动下载缓存并加入标本列表。'
        : '正在等待本地图片网关返回 3D-ready 单图；生成后会自动进入建模队列。',
    };
  }

  if (busy) {
    return {
      state: 'pending',
      label: '本地操作',
      primary: phase === 'prompt' ? '正在准备参考图' : '正在同步文件',
      elapsed,
      chain: `${imageProviderLabel} / ${modelProviderLabel}`,
      estimate: phase === 'prompt' ? '约 1-3 分钟' : '少于 1 分钟',
      nextAction: '请等待当前步骤完成，完成后按钮会恢复可操作状态。',
    };
  }

  if (referenceImage) {
    return {
      state: referenceAccepted ? 'ok' : 'idle',
      label: `参考图 ${jobShortId}`,
      primary: referenceAccepted ? '已接收图片' : '等待图片确认',
      elapsed: '待提交',
      chain: `${referenceImage.source || imageProviderLabel} / ${modelProviderLabel}`,
      estimate: referenceAccepted ? '可进入 3D 建模' : '确认后再建模',
      nextAction: referenceAccepted
        ? '点击“确认建模”进入图生 3D，或点击“完整生成”重新跑默认链路。'
        : '检查主体、剖面和构图后点击“接收图片”，不满意可重试或上传图片。',
    };
  }

  return null;
}

const WORKFLOW_STEPS: Array<{
  id: Exclude<WorkflowPhase, 'failed'>;
  no: string;
  title: string;
  caption: string;
}> = [
  { id: 'input', no: '01', title: '术语 / 图片输入', caption: '写描述或上传初图' },
  { id: 'prompt', no: '02', title: 'GPT prompt 打磨', caption: 'gpt-5.5 生成 3D-ready' },
  { id: 'image', no: '03', title: '单图生成与确认', caption: 'image tool 输出参考图' },
  { id: 'modeling', no: '04', title: '图生 3D 建模', caption: 'TripoSG / Bio3D' },
  { id: 'done', no: '05', title: '下载缓存展示', caption: '加载 final GLB' },
];

function getWorkflowPhase({
  referenceImage,
  activeJob,
  busy,
}: {
  referenceImage: ReferenceImage | null;
  activeJob: WorkflowJob | null;
  busy: boolean;
}): WorkflowPhase {
  if (activeJob?.status === 'failed') return 'failed';
  if (activeJob?.status === 'completed') return 'done';
  if (activeJob?.workflowMode === 'full-text-to-3d' && !activeJob.referenceId && !referenceImage) return 'prompt';
  if (activeJob?.workflowMode === 'full-text-to-3d' && activeJob.referenceId && !activeJob.result) return 'modeling';
  if (activeJob || busy) return referenceImage ? 'modeling' : 'prompt';
  if (referenceImage) return 'image';
  return 'input';
}

function getStepClass(
  step: Exclude<WorkflowPhase, 'failed'>,
  phase: WorkflowPhase,
  failedPhase: Exclude<WorkflowPhase, 'failed'> | null
) {
  const order: WorkflowPhase[] = ['input', 'prompt', 'image', 'modeling', 'done'];
  const stepIndex = order.indexOf(step);
  const phaseIndex = phase === 'failed' ? order.indexOf(failedPhase || 'modeling') : order.indexOf(phase);
  if (stepIndex < phaseIndex) return 'done';
  if (stepIndex === phaseIndex) return phase === 'failed' ? 'failed' : 'active';
  return '';
}

function isSelfhostJobResumable(job: WorkflowJob | null) {
  if (!job) return false;
  return job.provider === 'selfhost-triposg'
    && Boolean(job.providerJobId)
    && job.status === 'failed'
    && !job.result;
}

function isSelfhostJobDiagnosable(job: WorkflowJob | null) {
  if (!job) return false;
  return job.provider === 'selfhost-triposg'
    && Boolean(job.providerJobId)
    && job.status !== 'completed'
    && !job.result;
}

function getDiagnosticsForJob(job: WorkflowJob | null, diagnostics: WorkflowDiagnosticsPayload | null) {
  if (!job?.providerJobId || !diagnostics) return null;
  return diagnostics.promptId === job.providerJobId ? diagnostics : null;
}

function shouldDiagnoseBeforeResume(
  job: WorkflowJob | null,
  status: ProviderStatusPayload | null,
  diagnostics: WorkflowDiagnosticsPayload | null
) {
  if (!isSelfhostJobResumable(job)) return false;
  if (diagnostics?.outputs.glbCount && diagnostics.outputs.glbCount > 0) return false;
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status) return true;
  if (selfhost.status.recoverable) return true;
  if (selfhost.status.ok !== true) return true;
  if (diagnostics && !diagnostics.history.found && !diagnostics.queue.ok) return true;
  return false;
}

function buildResumeBlockedReason(
  job: WorkflowJob | null,
  status: ProviderStatusPayload | null,
  diagnostics: WorkflowDiagnosticsPayload | null
) {
  const promptId = getShortJobId(job?.providerJobId || '');
  if (diagnostics && diagnostics.outputs.glbCount <= 0) {
    if (!diagnostics.queue.ok || !diagnostics.history.found) {
      return `${promptId} 已保留，但远端 queue/history 暂不可观测；先诊断远端，等服务恢复后再续接 GLB。`;
    }
    return `${promptId} 的 history 已返回但还没有 GLB 输出；先等待远端写入 raw/textured/final GLB。`;
  }
  const selfhostStatus = status?.model3d.selfhostTriposg?.status;
  if (!selfhostStatus) {
    return `${promptId} 已保留；先刷新或诊断远端，确认 ComfyUI queue/history 可访问后再续接。`;
  }
  return selfhostStatus.message || selfhostStatus.error || `${promptId} 已保留；远端 3D 服务暂不可观测，先诊断后续接。`;
}

function getWorkflowFailedPhase(activeJob: WorkflowJob | null): Exclude<WorkflowPhase, 'failed'> | null {
  if (activeJob?.status !== 'failed') return null;
  if (activeJob.workflowMode === 'full-text-to-3d' && !activeJob.referenceId) return 'image';
  if (activeJob.referenceId) return 'modeling';
  return 'modeling';
}

function getImageProviderName(provider: string) {
  if (provider === 'local-gateway') return '本地图片网关';
  if (provider === 'openai') return 'OpenAI GPT Image';
  if (provider === 'upload') return '上传图片';
  return '图片生成服务';
}

function normalizeUiImageProvider(provider: string) {
  if (provider === 'openai') return 'openai';
  return 'local-gateway';
}

const IMAGE_PROFILE_OPTIONS = [
  {
    id: 'fast',
    label: '快速预览',
    size: '1024x1024',
    quality: 'medium',
    note: '快速验证构图',
  },
  {
    id: 'standard',
    label: '标准教学',
    size: '1536x1536',
    quality: 'high',
    note: '默认课堂质量',
  },
  {
    id: 'detailed',
    label: '精细单图',
    size: '2048x2048',
    quality: 'high',
    note: '更适合定稿',
  },
] as const;

type ImageProfileId = typeof IMAGE_PROFILE_OPTIONS[number]['id'];

function normalizeUiImageProfile(value?: string): ImageProfileId {
  const profile = String(value || 'standard').trim();
  return IMAGE_PROFILE_OPTIONS.some((option) => option.id === profile) ? profile as ImageProfileId : 'standard';
}

function getImageProfileOption(value?: string) {
  const profile = normalizeUiImageProfile(value);
  return IMAGE_PROFILE_OPTIONS.find((option) => option.id === profile) || IMAGE_PROFILE_OPTIONS[1];
}

function getImageProfileLabel(value?: string) {
  return getImageProfileOption(value).label;
}

function getImageProfileRequest(value?: string) {
  const option = getImageProfileOption(value);
  return {
    imageProfile: option.id,
    imageSize: option.size,
    imageQuality: option.quality,
  };
}

function buildImageSpecLabel(profile?: string, size?: string, quality?: string) {
  const option = getImageProfileOption(profile);
  const resolvedSize = size || option.size;
  const resolvedQuality = quality || option.quality;
  return `${option.label} · ${resolvedSize} · ${resolvedQuality}`;
}

function getModelProviderName(provider: string) {
  if (provider === 'selfhost-triposg') return 'TripoSG + Bio3D';
  if (provider === 'local-demo') return '本地缓存链路';
  if (provider === 'tencent-hunyuan') return '腾讯混元';
  return '3D 生成服务';
}

function getTextureModeName(mode?: string) {
  if (mode === 'fallback-color') return 'Bio3D 轻量贴图 fallback';
  return mode === 'hunyuan' ? '混元贴图增强' : '稳定几何优先';
}

function formatElapsedMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function formatGeneratedModelName(name: string) {
  return name.replace(/^(AI\s*)?生成[:：]\s*/i, '').trim();
}

function getPhaseLabel(phase: WorkflowPhase) {
  if (phase === 'input') return '待输入';
  if (phase === 'prompt') return '打磨中';
  if (phase === 'image') return '待确认';
  if (phase === 'modeling') return '建模中';
  if (phase === 'done') return '已入库';
  return '失败';
}

function buildActionStatusItems(input: {
  phase: WorkflowPhase;
  busy: boolean;
  promptReady: boolean;
  promptPreviewReady: boolean;
  promptConfirmed: boolean;
  referenceImage: ReferenceImage | null;
  referenceAccepted: boolean;
  activeJob: WorkflowJob | null;
  selectedProviderOnline: boolean;
  model3dReady: boolean;
  model3dBlockKind: Model3dBlockKind | null;
  resumeShouldDiagnoseFirst: boolean;
  providerStatusLoading: boolean;
}) {
  const hasReference = Boolean(input.referenceImage || input.activeJob?.reference || input.activeJob?.referenceId);
  const hasResult = Boolean(input.activeJob?.status === 'completed' && input.activeJob.result?.modelUrl);
  const live = input.activeJob?.status === 'queued' || input.activeJob?.status === 'processing';
  const failed = input.activeJob?.status === 'failed';
  const resumable = isSelfhostJobResumable(input.activeJob);

  return [
    {
      label: 'Prompt',
      value: input.promptConfirmed
        ? '已确认'
        : input.promptPreviewReady
          ? '待确认'
          : input.busy && input.phase === 'prompt'
            ? '打磨中'
            : input.promptReady
              ? '可预览'
              : '待输入',
      state: input.promptConfirmed ? 'ok' : input.promptPreviewReady || input.promptReady ? 'ready' : input.busy && input.phase === 'prompt' ? 'pending' : 'idle',
    },
    {
      label: '参考图',
      value: hasReference ? (input.referenceAccepted || input.activeJob?.referenceId ? '已确认' : '待接收') : input.providerStatusLoading ? '同步中' : input.selectedProviderOnline ? '可生成' : '需检查',
      state: hasReference ? (input.referenceAccepted || input.activeJob?.referenceId ? 'ok' : 'ready') : input.providerStatusLoading ? 'pending' : input.selectedProviderOnline ? 'ready' : 'warn',
    },
    {
      label: '图生 3D',
      value: hasResult
        ? '已完成'
        : resumable
          ? input.resumeShouldDiagnoseFirst ? '待诊断' : '可续接'
          : live
            ? '进行中'
            : input.model3dReady
              ? '可提交'
              : input.model3dBlockKind === 'resource'
                ? '资源保护'
                : input.model3dBlockKind === 'queue'
                  ? '队列保护'
                  : input.model3dBlockKind === 'sync'
                    ? '同步中'
                    : '需检查',
      state: hasResult ? 'ok' : failed ? 'warn' : live ? 'pending' : input.model3dReady ? 'ready' : input.model3dBlockKind === 'service' ? 'warn' : 'pending',
    },
    {
      label: '结果入库',
      value: hasResult ? '可查看' : failed ? '未完成' : live ? `${input.activeJob?.progress ?? 0}%` : '等待',
      state: hasResult ? 'ok' : failed ? 'warn' : live ? 'pending' : 'idle',
    },
  ];
}

type Model3dBlockKind = 'resource' | 'queue' | 'sync' | 'service';

function getModel3dBlockKind(status: ProviderStatusPayload | null): Model3dBlockKind {
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status) return 'sync';
  if (selfhost.status.recoverable) return 'sync';
  if (selfhost.status.ok !== true) return 'service';

  const guard = selfhost.resourceGuard;
  const ramFreeGiB = bytesToGiB(selfhost.status.ram?.available ?? selfhost.status.ram?.free);
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < (guard?.minRamFreeGb ?? 10)) return 'resource';
  const gpu = selfhost.status.gpu?.[0];
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < (guard?.minVramFreeGb ?? 6)) return 'resource';
  if (isModel3dQueueProtected(status)) return 'queue';

  return 'service';
}

function getModel3dBlockLabel(kind: Model3dBlockKind | null) {
  if (kind === 'resource') return '3D 资源保护';
  if (kind === 'queue') return '3D 队列保护';
  if (kind === 'sync') return '3D 状态同步';
  return '3D 链路复查';
}

function isImageProviderReady(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return false;
  if (provider === 'local-gateway') {
    return isLocalGatewayReady(status);
  }
  if (provider === 'openai') {
    const openai = status.image.openai;
    const authReady = openai?.auth ? openai.auth.ok : true;
    return Boolean(openai?.configured && authReady);
  }
  return false;
}

function canForceRetryImageProvider(status: ProviderStatusPayload | null, provider: string) {
  if (!status || provider !== 'local-gateway') return false;
  const gateway = status.image.localGateway;
  if (!gateway?.configured) return false;
  const healthReady = gateway.health ? gateway.health.ok : true;
  const modelsReady = gateway.models ? gateway.models.ok : true;
  const modelsRecoverable = gateway.models?.status === 504 || /超时|timeout/i.test(gateway.models?.message || '');
  if (!healthReady || (!modelsReady && !modelsRecoverable)) return false;
  const imageRoute = gateway.imageRoute;
  if (!imageRoute || imageRoute.ok !== false) return false;
  return Boolean(
    imageRoute.recoverable ||
      isRecoverableHttpStatus(imageRoute.status) ||
      isRecoverableHttpStatus(imageRoute.lastImageError?.status)
  );
}

function isLocalGatewayReady(status: ProviderStatusPayload | null) {
  const gateway = status?.image.localGateway;
  const healthReady = gateway?.health ? gateway.health.ok : true;
  const modelsReady = gateway?.models ? gateway.models.ok : true;
  const modelsRecoverable = gateway?.models?.status === 504 || /超时|timeout/i.test(gateway?.models?.message || '');
  const imageRouteReady = !gateway?.imageRoute || gateway.imageRoute.ok === null || gateway.imageRoute.ok !== false;
  return Boolean(gateway?.configured && healthReady && (modelsReady || modelsRecoverable) && imageRouteReady);
}

function buildImageProviderBlockedMessage(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return '图片链路状态仍在同步，请先点击“刷新”确认 48760 网关与图片上游。';
  if (provider === 'local-gateway') {
    const gateway = status.image.localGateway;
    if (!gateway?.configured) return '本地图片网关未配置，暂不能生成参考图；仍可上传图片后继续图生 3D。';
    if (gateway.health && !gateway.health.ok) return `48760 本地图片网关 health 异常：${gateway.health.message}`;
    if (gateway.imageRoute?.ok === false) return gateway.imageRoute.message;
    if (gateway.models && !gateway.models.ok) return `48760 本地图片网关 models 异常：${gateway.models.message}`;
    return '48760 网关在线，但图片上游尚未确认；请刷新预检或上传图片继续图生 3D。';
  }
  const openai = status.image.openai;
  if (openai?.auth && !openai.auth.ok) {
    return `OpenAI 直连图片服务不可用：${openai.auth.message}；建议切回 48760 本地图片网关或上传图片继续图生 3D。`;
  }
  return '图片服务暂不可用；请刷新预检，或上传图片继续图生 3D。';
}

function buildImageProviderFallbackMessage(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return '图片链路仍在同步。';
  if (provider === 'local-gateway') {
    const imageRoute = status.image.localGateway?.imageRoute;
    if (imageRoute?.ok === false) {
      const errorSummary = imageRoute.lastImageError?.message || (imageRoute.status ? `HTTP ${imageRoute.status}` : imageRoute.state);
      return `48760 文生图上游暂不可用：${errorSummary}`;
    }
    return '48760 文生图链路暂不可用。';
  }
  const openai = status.image.openai;
  if (openai?.auth && !openai.auth.ok) return `OpenAI 直连不可用：${openai.auth.message}`;
  return '图片服务暂不可用。';
}

function isRecoverableHttpStatus(status?: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isModel3dReady(status: ProviderStatusPayload | null) {
  if (!status) return false;
  const selfhost = status.model3d.selfhostTriposg;
  if (!selfhost?.configured || selfhost.status?.ok !== true) return false;
  const guard = selfhost.resourceGuard;
  const ramFreeGiB = bytesToGiB(selfhost.status.ram?.available ?? selfhost.status.ram?.free);
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < (guard?.minRamFreeGb ?? 10)) return false;
  const gpu = selfhost.status.gpu?.[0];
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < (guard?.minVramFreeGb ?? 6)) return false;
  if (isModel3dQueueProtected(status)) return false;
  return true;
}

function isHy3dTextureReady(status: ProviderStatusPayload | null) {
  if (!isModel3dReady(status)) return false;
  const selfhost = status?.model3d.selfhostTriposg;
  const texture = selfhost?.texture;
  if (!texture?.enabled) return false;
  const ramTotalGiB = bytesToGiB(selfhost?.status?.ram?.total);
  const lowMemoryRemoteDisabled = texture.lowMemoryRemoteEnabled === false
    && Number.isFinite(ramTotalGiB)
    && ramTotalGiB < (texture.lowMemoryTotalRamGb ?? 24);
  if (lowMemoryRemoteDisabled) return false;
  if (Number.isFinite(ramTotalGiB) && ramTotalGiB < (texture.minTotalRamGb ?? 24)) return false;
  const ramFreeGiB = bytesToGiB(selfhost?.status?.ram?.available ?? selfhost?.status?.ram?.free);
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < (texture.minRamFreeGb ?? 18)) return false;
  const gpu = selfhost?.status?.gpu?.[0];
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < (texture.minVramFreeGb ?? 14)) return false;
  return true;
}

function buildHy3dTextureStatusMessage(status: ProviderStatusPayload | null) {
  const selfhost = status?.model3d.selfhostTriposg;
  const texture = selfhost?.texture;
  if (!selfhost) return '正在同步 ComfyUI 资源状态；未确认前不会提交 Hunyuan3D-Paint。';
  if (!texture?.enabled) return '混元贴图增强未启用，当前默认生成稳定几何版。';
  if (!selfhost?.status) return '正在同步 ComfyUI 资源状态；未确认前不会提交 Hunyuan3D-Paint。';
  if (!isModel3dReady(status)) return buildModel3dBlockedMessage(status);
  const ramTotalGiB = bytesToGiB(selfhost.status.ram?.total);
  const lowMemoryCutoff = texture.lowMemoryTotalRamGb ?? 24;
  if (
    texture.lowMemoryRemoteEnabled === false &&
    Number.isFinite(ramTotalGiB) &&
    ramTotalGiB < lowMemoryCutoff
  ) {
    return `20G 低内存保护中：服务器总内存 ${formatGiB(ramTotalGiB)}/${lowMemoryCutoff}GB；当前已禁止远端 Hunyuan3D-Paint，稳定 TripoSG/Bio3D 完成后会嵌入参考图写入轻量贴图 fallback，避免 OOM。`;
  }
  if (Number.isFinite(ramTotalGiB) && ramTotalGiB < (texture.minTotalRamGb ?? 24)) {
    return `混元贴图资源保护中：服务器总内存 ${formatGiB(ramTotalGiB)}/${texture.minTotalRamGb ?? 24}GB；当前会使用稳定 GLB + 参考图轻量贴图 fallback。`;
  }
  const ramFreeGiB = bytesToGiB(selfhost.status.ram?.available ?? selfhost.status.ram?.free);
  const gpu = selfhost.status.gpu?.[0];
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  const runtimeRamFloor = texture.runtimeMinRamFreeGb ?? 5.5;
  const runtimeVramFloor = texture.runtimeMinVramFreeGb ?? 8;
  const ramLabel = Number.isFinite(ramFreeGiB) ? `RAM ${formatGiB(ramFreeGiB)}/${texture.minRamFreeGb ?? 18}GB` : 'RAM 待同步';
  const vramLabel = Number.isFinite(vramFreeGiB) ? `VRAM ${formatGiB(vramFreeGiB)}/${texture.minVramFreeGb ?? 14}GB` : 'VRAM 待同步';
  return isHy3dTextureReady(status)
    ? `混元贴图可用：${ramLabel}，${vramLabel}，${texture.steps ?? 12} steps / ${texture.faces ?? 10000} faces；运行硬熔断 ${runtimeRamFloor}GB RAM / ${runtimeVramFloor}GB VRAM。`
    : `混元贴图资源保护中：${ramLabel}，${vramLabel}；先用稳定几何版或等待资源释放。`;
}

function buildHy3dTextureRunMessage(status: ProviderStatusPayload | null) {
  const message = buildHy3dTextureStatusMessage(status);
  return isHy3dTextureReady(status)
    ? message
    : `${message} 本次仍会继续生成：后端会先完成稳定 TripoSG + Bio3D；资源不过线时不会提交 Hunyuan3D-Paint，会嵌入参考图写入轻量贴图 fallback。`;
}

function canEnhanceWithHy3dTexture(job: WorkflowJob | null) {
  if (!job || job.status !== 'completed' || !job.result?.modelUrl) return false;
  if (job.provider !== 'selfhost-triposg') return false;
  const actualTextured =
    job.effectiveTextureMode === 'hunyuan' ||
    job.result.effectiveTextureMode === 'hunyuan' ||
    Boolean(job.result.texturedModelUrl);
  if (actualTextured) return false;
  return Boolean(job.referenceId || job.reference?.id);
}

function getModel3dStatusLabel(status: ProviderStatusPayload | null) {
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status) return '待同步';
  const state = status?.model3d.selfhostTriposg?.status?.state;
  if (state === 'cold_starting') return '冷启动';
  if (state === 'unreachable') return '可恢复';
  if (state === 'error') return '需检查';
  if (selfhost.status?.ok === true && !isModel3dReady(status)) {
    return getModel3dBlockKind(status) === 'queue' ? '队列保护' : '资源保护';
  }
  return isModel3dReady(status) ? '就绪' : '需检查';
}

function getModel3dStatusClass(status: ProviderStatusPayload | null) {
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status) return 'pending';
  if (selfhost?.status?.recoverable) return 'pending';
  if (selfhost.status?.ok === true && !isModel3dReady(status)) return 'pending';
  return isModel3dReady(status) ? 'ok' : 'warn';
}

function buildModel3dBlockedMessage(status: ProviderStatusPayload | null) {
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status) return '3D 服务状态仍在同步，请先点击“刷新”完成 ComfyUI 队列和资源检查。';
  if (selfhost.status.recoverable) return selfhost.status.message || '自部署 3D 服务正在恢复，暂不提交新的重任务。';
  if (selfhost.status.ok !== true) return selfhost.status.message || selfhost.status.error || '自部署 3D 服务暂不可用，请复查公网端口与 ComfyUI 进程。';
  const guard = selfhost.resourceGuard;
  const ramFreeGiB = bytesToGiB(selfhost.status.ram?.available ?? selfhost.status.ram?.free);
  if (Number.isFinite(ramFreeGiB) && ramFreeGiB < (guard?.minRamFreeGb ?? 10)) {
    return `资源保护已生效：服务器可用内存约 ${formatGiB(ramFreeGiB)}，低于 ${guard?.minRamFreeGb ?? 10}GB 安全线，暂不提交 TripoSG/Bio3D 重任务。`;
  }
  const gpu = selfhost.status.gpu?.[0];
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  if (Number.isFinite(vramFreeGiB) && vramFreeGiB < (guard?.minVramFreeGb ?? 6)) {
    return `资源保护已生效：GPU 可用显存约 ${formatGiB(vramFreeGiB)}，低于 ${guard?.minVramFreeGb ?? 6}GB 安全线，暂不提交图生 3D。`;
  }
  if (isModel3dQueueProtected(status)) {
    const runtime = selfhost.runtime;
    const queue = selfhost.status.queue;
    const localLimit = runtime?.maxPending ?? guard?.maxLocalPending ?? 1;
    return `3D 队列保护中：本地保护队列 ${runtime?.running ?? 0}/${runtime?.pending ?? 0}（最多等待 ${localLimit} 个），远端 ComfyUI 队列 ${queue?.running ?? 0}/${queue?.pending ?? 0}；请等待当前建模完成或刷新预检，避免并发触发 OOM。`;
  }
  return '3D 服务仍需复查，请刷新链路预检后再提交建模。';
}

function isModel3dQueueProtected(status: ProviderStatusPayload | null) {
  const selfhost = status?.model3d.selfhostTriposg;
  if (!selfhost?.status || selfhost.status.ok !== true) return false;
  const runtime = selfhost.runtime;
  const queue = selfhost.status.queue;
  const localBusy = (runtime?.running ?? 0) + (runtime?.pending ?? 0) > 0;
  const shouldBlockRemoteBusy = runtime?.blockWhenRemoteBusy ?? selfhost.resourceGuard?.blockWhenRemoteBusy ?? true;
  const remoteBusy = shouldBlockRemoteBusy && ((queue?.running ?? 0) + (queue?.pending ?? 0) > 0);
  return localBusy || remoteBusy;
}

function bytesToGiB(bytes?: number) {
  if (!bytes || bytes <= 0) return Number.NaN;
  return bytes / 1024 / 1024 / 1024;
}

function formatGiB(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) return '--';
  return `${value.toFixed(value >= 10 ? 0 : 1)}GB`;
}

function getProviderStatusClass(loading: boolean, ready: boolean) {
  if (loading) return 'pending';
  return ready ? 'ok' : 'warn';
}

function buildProviderStatusText(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return '等待状态同步';
  if (provider === 'local-gateway') {
    const route = status.image.localGateway?.imageRoute;
    if (route?.ok === false) return route.message;
    return getImageQualityProfile(status, provider);
  }
  const openai = status.image.openai;
  if (openai?.auth?.message && !openai.auth.ok) return openai.auth.message;
  return getImageQualityProfile(status, provider);
}

function buildLocalChainProofText(status: ProviderStatusPayload | null, imageProvider: string, modelProvider: string, textureMode = 'stable') {
  const gateway = status?.image.localGateway;
  const selfhost = status?.model3d.selfhostTriposg;
  const textureReady = isHy3dTextureReady(status);
  const imagePath = imageProvider === 'local-gateway'
    ? `${gateway?.baseUrl || 'http://127.0.0.1:48760'} / ${gateway?.imageModel || 'gpt-image-2'}`
    : 'OpenAI 直连图片服务';
  const modelPath = modelProvider === 'selfhost-triposg'
    ? textureMode === 'hunyuan'
      ? textureReady
        ? `${selfhost?.baseUrl || 'ComfyUI'} / TripoSG raw -> Hunyuan3D-Paint textured -> Bio3D final`
        : `${selfhost?.baseUrl || 'ComfyUI'} / TripoSG raw -> Bio3D final -> local lightweight texture fallback`
      : `${selfhost?.baseUrl || 'ComfyUI'} / TripoSG raw -> Bio3D final`
    : getModelProviderName(modelProvider);
  const queue = selfhost?.status?.queue;
  const runtime = selfhost?.runtime;
  const hasLocalProtectedQueue = Boolean((runtime?.running ?? 0) || (runtime?.pending ?? 0));
  const queueText = selfhost?.status?.recoverable
    ? (selfhost.status.message || '3D 服务恢复中')
    : hasLocalProtectedQueue
      ? `本地保护队列 ${runtime?.running ?? 0}/${runtime?.pending ?? 0}`
      : queue ? `远端队列 ${queue.running ?? 0}/${queue.pending ?? 0}` : '队列待同步';
  return `${imagePath} -> ${modelPath} · ${queueText}`;
}

function buildGatewayRouteHint(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return null;
  const gatewayReady = isImageProviderReady(status, 'local-gateway');
  const openaiAuth = status.image.openai?.auth;
  const imageRoute = status.image.localGateway?.imageRoute;

  if (provider === 'local-gateway' && imageRoute?.ok === false) {
    return {
      state: 'warn',
      label: '图片上游',
      text: imageRoute.message,
    };
  }

  if (provider === 'local-gateway' && gatewayReady) {
    return {
      state: 'ok',
      label: '默认链路',
      text: '完整生成将优先使用 48760 本地图片网关，再接续图生 3D。',
    };
  }

  if (provider === 'openai' && openaiAuth && !openaiAuth.ok && gatewayReady) {
    return {
      state: 'warn',
      label: '建议切换',
      text: `OpenAI 直连不可用：${openaiAuth.message}；当前可切回本地图片网关。`,
    };
  }

  if (!gatewayReady) {
    return {
      state: 'warn',
      label: '网关检查',
      text: imageRoute?.message || '本地图片网关暂未就绪，生成参考图前请检查 48760 服务与 API Key。',
    };
  }

  return null;
}

function getImageQualityProfile(status: ProviderStatusPayload | null, provider: string) {
  if (provider === 'local-gateway') {
    const gateway = status?.image.localGateway;
    const imageModel = gateway?.imageModel || 'gpt-image-2';
    const size = gateway?.imageSize || '1536x1536';
    const quality = gateway?.imageQuality || 'high';
    const timeout = gateway?.timeoutMs ? `timeout ${Math.round(gateway.timeoutMs / 1000)}s` : 'timeout 420s';
    return `${imageModel} / ${size} / ${quality} / ${timeout}`;
  }
  const openai = status?.image.openai;
  return `${openai?.imageModel || 'OpenAI'} / ${openai?.imageToolModel || 'image tool'} / ${openai?.imageSize || '1536x1536'} / ${openai?.imageQuality || 'high'}`;
}

function buildActiveChainSummary(status: ProviderStatusPayload | null, imageProvider: string, modelProvider: string, textureMode = 'stable') {
  const imageLabel = imageProvider === 'local-gateway'
    ? status?.image.localGateway?.imageModel || 'gpt-image-2'
    : status?.image.openai?.imageToolModel || status?.image.openai?.imageModel || 'OpenAI';
  const modelLabel = modelProvider === 'selfhost-triposg' && textureMode === 'hunyuan'
    ? isHy3dTextureReady(status)
      ? 'TripoSG + 混元贴图'
      : 'TripoSG + 轻量贴图 fallback'
    : getModelProviderName(modelProvider);
  return `${imageLabel} 单图 -> ${modelLabel}`;
}
