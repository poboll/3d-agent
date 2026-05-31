import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellModel } from '../data/models';
import { getModelTemplate } from '../data/models';
import {
  createFullTextTo3dJob,
  createReferenceImage,
  fetchProviderStatus,
  createTextToCellJob,
  fetchDemoGeneratedModels,
  fetchWorkflowJob,
  fetchWorkflowJobs,
  previewReferencePrompt,
  uploadLocalModel,
  uploadReferenceImage,
  workflowJobToCellModel,
} from '../services/fusionApi';
import type { PromptPreviewPayload, ProviderStatusPayload, ReferenceImagePayload, WorkflowJob } from '../services/fusionApi';
import { trackEvent } from '../lib/analytics';

interface Props {
  id?: string;
  generatedModels: CellModel[];
  onModelsLoaded: (models: CellModel[]) => void;
  onModelCreated: (model: CellModel) => void;
  onSelect: (id: string) => void;
}

export function GenerationPanel({
  id,
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
  const [status, setStatus] = useState('先得到一张可确认的参考图，再进入图生 3D 建模。');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('植物细胞 3D 教学模型，突出叶绿体、细胞壁和大型液泡');
  const [imageProvider, setImageProvider] = useState('local-gateway');
  const [modelProvider, setModelProvider] = useState('selfhost-triposg');
  const [template, setTemplate] = useState('plant-cell');
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [referenceAccepted, setReferenceAccepted] = useState(false);
  const [promptPreview, setPromptPreview] = useState<PromptPreviewPayload | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatusPayload | null>(null);
  const [providerStatusLoading, setProviderStatusLoading] = useState(true);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [jobHistory, setJobHistory] = useState<WorkflowJob[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [operationStartedAt, setOperationStartedAt] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(getTimestamp);
  const [syncingJobId, setSyncingJobId] = useState<string | null>(null);

  const phase = getWorkflowPhase({ referenceImage, activeJob, busy });
  const failedPhase = getWorkflowFailedPhase(activeJob);

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
    }

    if (job.status === 'failed') {
      setBusy(false);
      setOperationStartedAt(null);
      setStatus(job.error || job.stage || '生成任务失败。');
      trackEvent('workflow_job_failed', {
        jobId: job.id,
        template: job.template,
        provider: job.provider,
        message: job.error || job.stage,
      });
    }
  }, [onModelCreated, onSelect]);

  useEffect(() => {
    const shouldTick = busy || activeJob?.status === 'queued' || activeJob?.status === 'processing';
    if (!shouldTick) return undefined;
    const timer = window.setInterval(() => setClockNow(getTimestamp()), 1000);
    return () => window.clearInterval(timer);
  }, [activeJob?.status, busy]);

  useEffect(() => {
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
          const latestInspectableJob =
            jobs.find((job) => isLiveWorkflowJob(job)) ||
            jobs.find((job) => job.status === 'completed' && job.reference);
          if (latestInspectableJob?.reference) {
            restoredLatestJobRef.current = true;
            setActiveJob(latestInspectableJob);
            setDetailsOpen(true);
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
    return () => {
      cancelled = true;
    };
  }, [onModelsLoaded]);

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
    statusPrefix?: string;
    eventSource?: string;
  } = {}) => {
    const nextPrompt = (options.promptValue ?? prompt).trim();
    const nextTemplate = options.templateValue || template;
    const nextImageProvider = normalizeUiImageProvider(options.imageProviderValue || imageProvider);

    if (!nextPrompt) {
      setStatus('请先输入生物结构描述，或上传一张参考图。');
      return;
    }

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setStatus(options.statusPrefix || `${getImageProviderName(nextImageProvider)} 正在生成 3D-ready 单图参考图...`);
    setPromptPreview(null);
    trackEvent('workflow_reference_generate_start', {
      template: nextTemplate,
      imageProvider: nextImageProvider,
      promptLength: nextPrompt.length,
      source: options.eventSource || 'panel',
    });
    try {
      const reference = await createReferenceImage({
        prompt: nextPrompt,
        provider: nextImageProvider,
        template: nextTemplate,
      });
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
      setStatus(`${getImageProviderName(nextImageProvider)} 已产出参考图，请检查后点击“接收图片”，再确认建模。`);
      trackEvent('workflow_reference_generate', {
        template: nextTemplate,
        imageProvider: nextImageProvider,
        promptLength: nextPrompt.length,
        referenceId: reference.id,
        model: reference.model,
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

  const handleRunFullWorkflow = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构术语或课堂描述。');
      return;
    }

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setReferenceImage(null);
    setReferenceAccepted(false);
    setPromptPreview(null);
    setActiveJob(null);
    setStatus('正在按默认链路执行：术语 → GPT prompt → 单图 → TripoSG → textured GLB。');
    trackEvent('workflow_full_run_start', {
      template,
      imageProvider,
      provider: modelProvider,
      promptLength: prompt.trim().length,
    });

    try {
      const { reference, job } = await createFullTextTo3dJob({
        prompt: prompt.trim(),
        provider: modelProvider,
        imageProvider,
        template,
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
    const nextModelProvider = options.modelProviderValue || modelProvider;

    if (!nextReference) {
      setStatus('需要先生成或上传参考图，再确认图生建模。');
      return;
    }
    if (!options.reference && !referenceAccepted) {
      setStatus('请先检查参考图并点击“接收图片”，再提交图生 3D 建模。');
      return;
    }

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setModelProvider(nextModelProvider);
    setReferenceImage(nextReference);
    setReferenceAccepted(true);
    setStatus('已确认参考图，正在创建图生 3D 建模任务...');
    trackEvent('workflow_model_confirm', {
      template: nextTemplate,
      provider: nextModelProvider,
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
        referenceId: nextReference.id,
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
    applyWorkflowJobUpdate(job, {
      selectModel: true,
      statusOverride: job.error || job.stage,
      trackCompletion: false,
    });
    setDetailsOpen(true);
    hydrateJobIntoWorkspace(job, {
      acceptReference: Boolean(job.referenceId),
      keepPrompt: true,
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

  const hydrateJobIntoWorkspace = (
    job: WorkflowJob,
    options: { acceptReference?: boolean; keepPrompt?: boolean } = {}
  ) => {
    if (!options.keepPrompt) setPrompt(job.prompt);
    setTemplate(job.template || 'auto');
    setImageProvider(normalizeUiImageProvider(job.imageProvider || imageProvider));
    setModelProvider(job.provider || modelProvider);
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
  const canCreateReference = !busy && prompt.trim().length >= 6;
  const canConfirmModeling = !busy && !!referenceImage && referenceAccepted && activeJob?.status !== 'completed' && activeJob?.status !== 'processing' && activeJob?.status !== 'queued';
  const selectedProviderOnline = isImageProviderReady(providerStatus, imageProvider);
  const selectedProviderLabel = getImageProviderName(imageProvider);
  const model3dReady = isModel3dReady(providerStatus);
  const activeChainSummary = buildActiveChainSummary(providerStatus, imageProvider, modelProvider);
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
  const latestGeneratedModel = generatedModels[0];
  const taskWatch = activeJob ? buildTaskWatch(activeJob, clockNow) : null;
  const latestGeneratedName = latestGeneratedModel ? formatGeneratedModelName(latestGeneratedModel.name) : '';
  const latestResultLabel = latestGeneratedModel
    ? [latestGeneratedModel.source || latestGeneratedModel.generationStatus, latestGeneratedModel.subtitle]
        .filter(Boolean)
        .join(' / ')
    : '';
  const detailReference = activeJob?.reference || (referenceImage ? referenceImageToPayload(referenceImage, prompt, template) : null);
  const detailsRows = activeJob ? buildJobDetailRows(activeJob) : [];
  const resultModelUrl = activeJob?.result?.modelUrl;
  const rawModelUrl = activeJob?.result?.rawModelUrl;
  const resultReview = activeJob?.status === 'completed' && activeJob.result
    ? buildResultReview(activeJob)
    : null;
  const visibleJobHistory = buildVisibleJobHistory(jobHistory, activeJob);
  const hiddenJobCount = Math.max(0, jobHistory.length - visibleJobHistory.length);
  const quickStatusItems = [
    {
      label: '图片',
      value: providerStatusLoading ? '检查中' : selectedProviderOnline ? '正常' : '需检查',
      state: providerStatusLoading ? 'pending' : selectedProviderOnline ? 'ok' : 'warn',
    },
    {
      label: '3D',
      value: providerStatusLoading ? '同步中' : model3dReady ? '就绪' : '需检查',
      state: providerStatusLoading ? 'pending' : model3dReady ? 'ok' : 'warn',
    },
    {
      label: '阶段',
      value: getPhaseLabel(phase),
      state: phase === 'failed' ? 'warn' : phase === 'done' ? 'ok' : busy ? 'pending' : 'idle',
    },
  ];

  return (
    <section className="generation-panel" id={id} data-testid="generation-panel">
      <div>
        <span className="generation-eyebrow">§ 01 — WORKFLOW DESK</span>
        <h2>生成工坊</h2>
        <p>文本或图片先形成参考图，确认后再交给图生 3D 服务，适合课堂里逐步讲解。</p>
      </div>

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
            <button type="button" onClick={() => void handleResultReviewAction('copy-prompt')} data-testid="review-copy-prompt">
              复制 Prompt
            </button>
          </div>
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

      {taskWatch && (
        <section className={`task-watch-card ${taskWatch.state}`} aria-label="长任务观察" data-testid="task-watch-card">
          <div className="task-watch-head">
            <span>{taskWatch.eyebrow}</span>
            <strong>{taskWatch.title}</strong>
            <div className="task-watch-actions">
              <button type="button" onClick={handleSyncActiveJob} disabled={Boolean(syncingJobId)} data-testid="sync-active-job">
                {syncingJobId ? '同步中' : '同步状态'}
              </button>
              {activeJob?.result && (
                <button type="button" onClick={handleOpenActiveJobModel} data-testid="open-active-job-model">
                  查看模型
                </button>
              )}
            </div>
          </div>
          <div className="task-watch-rail" aria-label={`任务进度 ${taskWatch.progress}%`}>
            <span style={{ width: `${taskWatch.progress}%` }} />
          </div>
          <div className="task-watch-grid">
            {taskWatch.items.map((item) => (
              <span className={item.state} key={item.label}>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            ))}
          </div>
          <p>{taskWatch.hint}</p>
        </section>
      )}

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
            <em>{[referenceImage.source, referenceImage.promptModel || referenceImage.model].filter(Boolean).join(' · ')}</em>
          </span>
        </button>
      )}

      <label className="generation-field">
        <span>01 TEXT PROMPT / 生物结构描述</span>
        <textarea
          value={prompt}
          maxLength={600}
          onFocus={() => trackEvent('workflow_prompt_focus', { template })}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：动物细胞 3D 教学模型，突出线粒体、细胞核和细胞膜"
        />
      </label>

      <div className="generation-actions" id="workflow-actions">
        <button type="button" className="generation-primary" onClick={handleCreateReference} disabled={!canCreateReference} data-testid="generate-reference">
          生成参考图
        </button>
        <button type="button" className="generation-secondary" onClick={handlePreviewPrompt} disabled={!canCreateReference} data-testid="preview-prompt">
          预览 Prompt
        </button>
        <button type="button" className="generation-primary full-action" onClick={handleRunFullWorkflow} disabled={!canCreateReference || busy} data-testid="run-full-workflow">
          完整生成
        </button>
        <button type="button" className="generation-primary confirm-action" onClick={handleConfirmModeling} disabled={!canConfirmModeling} data-testid="confirm-modeling">
          确认建模
        </button>
        <button type="button" className="generation-secondary" onClick={() => imageInputRef.current?.click()} disabled={busy} data-testid="upload-reference-image">
          上传图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleCreateReference} disabled={!canCreateReference} data-testid="retry-reference-image">
          重试图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleAcceptReference} disabled={!referenceImage || busy} data-testid="accept-reference-image">
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
                </div>
              )}

              {detailReference?.imageUrl && (
                <a className="job-detail-reference" href={detailReference.imageUrl} target="_blank" rel="noreferrer">
                  <img src={detailReference.imageUrl} alt={detailReference.title || '参考图'} />
                  <span>
                    <small>REFERENCE</small>
                    <strong>{detailReference.title || '参考图'}</strong>
                    <em>{[detailReference.provider, detailReference.model].filter(Boolean).join(' · ')}</em>
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
                <p className="job-detail-error">{activeJob.error}</p>
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
                      <a href={resultModelUrl} target="_blank" rel="noreferrer">贴图 GLB</a>
                    )}
                    {rawModelUrl && (
                      <a href={rawModelUrl} target="_blank" rel="noreferrer">Raw GLB</a>
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
        <label className="generation-field compact">
          <span>3D PROVIDER</span>
          <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value)}>
            <option value="selfhost-triposg">本地 TripoSG + 混元贴图</option>
            <option value="local-demo">本地缓存链路</option>
            <option value="tencent-hunyuan">腾讯混元</option>
          </select>
        </label>
      </div>

      {promptPreview && (
        <div className="prompt-preview-card" aria-label="3D-ready prompt 预览">
          <div>
            <span>3D-READY PROMPT</span>
            <strong>{promptPreview.model}</strong>
          </div>
          <p>{promptPreview.imagePrompt}</p>
        </div>
      )}

      <div className="provider-hint" aria-label="当前生成链路">
        <span>{selectedProviderLabel}</span>
        <strong>{activeChainSummary}</strong>
      </div>

      <div className="provider-status-strip" aria-label="本地生成服务状态">
        <span className={getProviderStatusClass(providerStatusLoading, selectedProviderOnline)}>
          {providerStatusLoading ? '检查中' : selectedProviderOnline ? '图片服务正常' : '图片服务需检查'}
        </span>
        <span className={getProviderStatusClass(providerStatusLoading, model3dReady)}>
          {providerStatusLoading ? '同步中' : model3dReady ? '3D 服务就绪' : '3D 服务需检查'}
        </span>
        <em>{buildProviderStatusText(providerStatus, imageProvider)}</em>
      </div>

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
          {referenceImage && <em>{[referenceAccepted ? '已确认' : '待确认', referenceImage.source, referenceImage.promptModel, referenceImage.model].filter(Boolean).join(' · ')}</em>}
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

      {visibleJobHistory.length > 0 && (
        <div className="job-history">
          <div className="job-history-title">
            <span>最近任务</span>
            <strong>关键 3 条</strong>
            <em>{hiddenJobCount > 0 ? `已收起 ${hiddenJobCount} 条历史` : '没有更多历史'}</em>
          </div>
          {visibleJobHistory.map((job) => (
            <button
              type="button"
              className={`job-row ${job.status}${activeJob?.id === job.id ? ' active' : ''}`}
              key={job.id}
              onClick={() => handleSelectJob(job)}
            >
              <span>{job.prompt}</span>
              <strong>{job.status === 'completed' ? '完成' : job.status === 'failed' ? '失败' : `${job.progress}%`}</strong>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function mergeJobs(job: WorkflowJob, jobs: WorkflowJob[]) {
  return [job, ...jobs.filter((item) => item.id !== job.id)].slice(0, 12);
}

function buildVisibleJobHistory(jobs: WorkflowJob[], activeJob: WorkflowJob | null) {
  const visible: WorkflowJob[] = [];
  const seenPrompts = new Set<string>();
  const addJob = (job?: WorkflowJob | null) => {
    if (!job || visible.some((item) => item.id === job.id)) return;
    const promptKey = normalizeJobHistoryPrompt(job.prompt);
    if (promptKey && seenPrompts.has(promptKey) && visible.length > 0) return;
    if (promptKey) seenPrompts.add(promptKey);
    visible.push(job);
  };

  addJob(activeJob);
  addJob(jobs.find((job) => isLiveWorkflowJob(job)));
  addJob(jobs.find((job) => job.status === 'completed'));
  addJob(jobs.find((job) => job.status === 'failed'));

  for (const job of jobs) {
    if (visible.length >= 3) break;
    addJob(job);
  }

  return visible.slice(0, 3);
}

function normalizeJobHistoryPrompt(prompt: string) {
  return String(prompt || '')
    .replace(/\s+/g, '')
    .replace(/[，。,.!！?？:：；;]/g, '')
    .slice(0, 36);
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
    imagePrompt: reference.imagePrompt,
    negativePrompt: '',
    imageUrl: reference.url,
    createdAt: '',
  };
}

function buildJobDetailRows(job: WorkflowJob) {
  return [
    { label: '状态', value: getWorkflowStatusLabel(job.status) },
    { label: '进度', value: `${Math.max(0, Math.min(100, job.progress || 0))}%` },
    { label: '图片', value: getImageProviderName(job.imageProvider || 'local-gateway') },
    { label: '三维', value: getModelProviderName(job.provider) },
    { label: '模式', value: getWorkflowModeLabel(job.workflowMode || 'image-to-3d') },
    { label: '模板', value: job.template || 'auto' },
    { label: '成本', value: job.costEstimateCny ? `约 ${job.costEstimateCny} 元` : '本地链路' },
    { label: '更新', value: formatRelativeTime(job.updatedAt) },
  ];
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

function getWorkflowStatusLabel(status: WorkflowJob['status']) {
  if (status === 'queued') return '排队中';
  if (status === 'processing') return '生成中';
  if (status === 'completed') return '已完成';
  return '失败';
}

function getWorkflowModeLabel(mode: string) {
  if (mode === 'full-text-to-3d') return '完整生成';
  if (mode === 'image-to-3d') return '图生 3D';
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

interface TaskWatch {
  state: 'pending' | 'ok' | 'warn';
  eyebrow: string;
  title: string;
  progress: number;
  hint: string;
  items: Array<{
    label: string;
    value: string;
    state: 'idle' | 'pending' | 'ok' | 'warn';
  }>;
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
  };
}

function getTimestamp() {
  return Date.now();
}

function buildTaskWatch(job: WorkflowJob, now: number): TaskWatch {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const isLive = isLiveWorkflowJob(job);
  const hasReference = Boolean(job.referenceId || job.reference);
  const hasResult = Boolean(job.result?.modelUrl);
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
  const secondsSinceUpdate = Number.isFinite(updatedAt) ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : 0;
  const state: TaskWatch['state'] = job.status === 'failed' ? 'warn' : job.status === 'completed' ? 'ok' : 'pending';
  const providerName = getModelProviderName(job.provider);
  const imageName = getImageProviderName(job.imageProvider || 'local-gateway');

  let title = '任务正在运行';
  let hint = job.stage || '系统正在同步生成任务。';
  if (job.status === 'completed') {
    title = '模型已缓存';
    hint = '结果已写入标本索引，可点击查看模型或复用参考图继续迭代。';
  } else if (job.status === 'failed') {
    title = '任务需要复查';
    hint = job.error || job.stage || '请检查图片网关、3D 服务和参考图缓存。';
  } else if (job.provider === 'selfhost-triposg' && progress >= 80) {
    title = '正在等待贴图与 GLB 输出';
    hint = '80% 后通常是远端三维服务的打包、贴图或文件写入阶段；可保持页面开启，或稍后点击同步状态。';
  } else if (job.workflowMode === 'full-text-to-3d' && !hasReference) {
    title = '正在等待参考图';
    hint = secondsSinceUpdate > 120
      ? '1536x1536 / high 单图生成有时会超过 3 分钟；任务仍在后台，可稍后点击同步状态。'
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
    return {
      state: 'warn',
      label: `任务 ${jobShortId}`,
      primary: '链路中断',
      elapsed,
      chain: `${imageProviderLabel} / ${modelProviderLabel}`,
      estimate: '需人工复查',
      nextAction: activeJob?.error || activeJob?.stage || '请检查本地网关、参考图缓存与 3D 服务状态。',
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
        ? '保持页面开启，完成后会自动加入标本列表并切换到新模型。'
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
  { id: 'modeling', no: '04', title: '图生 3D 建模', caption: 'TripoSG / 混元贴图' },
  { id: 'done', no: '05', title: '下载缓存展示', caption: '加载 textured GLB' },
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

function getModelProviderName(provider: string) {
  if (provider === 'selfhost-triposg') return 'TripoSG + 混元贴图';
  if (provider === 'local-demo') return '本地缓存链路';
  if (provider === 'tencent-hunyuan') return '腾讯混元';
  return '3D 生成服务';
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

function isImageProviderReady(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return false;
  if (provider === 'local-gateway') {
    const gateway = status.image.localGateway;
    const healthReady = gateway?.health ? gateway.health.ok : true;
    const modelsReady = gateway?.models ? gateway.models.ok : true;
    return Boolean(gateway?.configured && healthReady && modelsReady);
  }
  if (provider === 'openai') {
    const openai = status.image.openai;
    const authReady = openai?.auth ? openai.auth.ok : true;
    return Boolean(openai?.configured && authReady);
  }
  return false;
}

function isModel3dReady(status: ProviderStatusPayload | null) {
  if (!status) return false;
  const selfhost = status.model3d.selfhostTriposg;
  return Boolean(selfhost?.configured && selfhost.status?.ok !== false);
}

function getProviderStatusClass(loading: boolean, ready: boolean) {
  if (loading) return 'pending';
  return ready ? 'ok' : 'warn';
}

function buildProviderStatusText(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return '等待状态同步';
  if (provider === 'local-gateway') {
    const gateway = status.image.localGateway;
    const imageModel = gateway?.imageModel || 'gpt-image-2';
    const size = gateway?.imageSize || '1536x1536';
    const quality = gateway?.imageQuality || 'high';
    const timeout = gateway?.timeoutMs ? `timeout ${Math.round(gateway.timeoutMs / 1000)}s` : 'timeout 420s';
    return `${imageModel} / ${size} / ${quality} / ${timeout}`;
  }
  const openai = status.image.openai;
  if (openai?.auth?.message && !openai.auth.ok) return openai.auth.message;
  return `${openai?.imageModel || 'OpenAI'} / ${openai?.imageToolModel || 'image tool'} / ${openai?.imageSize || '1536x1536'} / ${openai?.imageQuality || 'high'}`;
}

function buildActiveChainSummary(status: ProviderStatusPayload | null, imageProvider: string, modelProvider: string) {
  const imageLabel = imageProvider === 'local-gateway'
    ? status?.image.localGateway?.imageModel || 'gpt-image-2'
    : status?.image.openai?.imageToolModel || status?.image.openai?.imageModel || 'OpenAI';
  const modelLabel = getModelProviderName(modelProvider);
  return `${imageLabel} 单图 -> ${modelLabel}`;
}
