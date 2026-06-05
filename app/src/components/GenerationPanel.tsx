import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellModel } from '../data/models';
import { getModelTemplate } from '../data/models';
import {
  createFullTextTo3dJob,
  createReferenceImage,
  fetchProviderStatus,
  createTextToCellJob,
  fetchDemoGeneratedModels,
  fetchWorkflowDiagnostics,
  fetchWorkflowJob,
  fetchWorkflowJobs,
  previewReferencePrompt,
  resumeWorkflowJob,
  uploadLocalModel,
  uploadReferenceImage,
  workflowJobToCellModel,
} from '../services/fusionApi';
import type { PromptPreviewPayload, ProviderStatusPayload, ReferenceImagePayload, WorkflowDiagnosticsPayload, WorkflowJob } from '../services/fusionApi';
import { trackEvent } from '../lib/analytics';
import { buildJobHistorySummary } from '../lib/jobHistory';
import { buildGenerationTimeline } from '../lib/workflowTimeline';
import { getWorkflowWaitHint } from '../lib/workflowWait';
import { buildWorkflowPhaseBoard } from '../lib/workflowPhaseBoard';
import { buildWorkflowNextAction } from '../lib/workflowNextAction';

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
  const [imageProfile, setImageProfile] = useState('standard');
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
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnosticsPayload | null>(null);
  const [diagnosingJobId, setDiagnosingJobId] = useState<string | null>(null);

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

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setImageProfile(nextImageProfile);
    setStatus(options.statusPrefix || `${getImageProviderName(nextImageProvider)} 正在生成 3D-ready 单图参考图...`);
    setPromptPreview(null);
    trackEvent('workflow_reference_generate_start', {
      template: nextTemplate,
      imageProvider: nextImageProvider,
      imageProfile: nextImageProfile,
      imageProfileLabel: getImageProfileLabel(nextImageProfile),
      promptLength: nextPrompt.length,
      source: options.eventSource || 'panel',
    });
    try {
      const reference = await createReferenceImage({
        prompt: nextPrompt,
        provider: nextImageProvider,
        template: nextTemplate,
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
      setStatus(`${getImageProviderName(nextImageProvider)} 已产出参考图，请检查后点击“接收图片”，再确认建模。`);
      trackEvent('workflow_reference_generate', {
        template: nextTemplate,
        imageProvider: nextImageProvider,
        imageProfile: reference.imageProfile || nextImageProfile,
        imageProfileLabel: getImageProfileLabel(reference.imageProfile || nextImageProfile),
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
    setStatus('正在按默认链路执行：术语 → GPT prompt → 单图 → TripoSG → Hunyuan3D-Paint → Bio3D final GLB。');
    trackEvent('workflow_full_run_start', {
      template,
      imageProvider,
      imageProfile,
      imageProfileLabel: getImageProfileLabel(imageProfile),
      imageSize: getImageProfileOption(imageProfile).size,
      imageQuality: getImageProfileOption(imageProfile).quality,
      provider: modelProvider,
      promptLength: prompt.trim().length,
    });

    try {
      const { reference, job } = await createFullTextTo3dJob({
        prompt: prompt.trim(),
        provider: modelProvider,
        imageProvider,
        ...getImageProfileRequest(imageProfile),
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
        workflowMode: job.workflowMode,
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

    setBusy(true);
    setOperationStartedAt(getTimestamp());
    setPrompt(nextPrompt);
    setTemplate(nextTemplate);
    setImageProvider(nextImageProvider);
    setImageProfile(nextImageProfile);
    setModelProvider(nextModelProvider);
    setReferenceImage(nextReference);
    setReferenceAccepted(true);
    setStatus('已确认参考图，正在创建图生 3D 建模任务...');
    trackEvent('workflow_model_confirm', {
      template: nextTemplate,
      provider: nextModelProvider,
      imageProvider: nextImageProvider,
      imageProfile: nextImageProfile,
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

  const handleResumeActiveJob = async () => {
    if (!activeJob || syncingJobId) return;
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
    if (actionId === 'accept-reference') {
      handleAcceptReference();
      return;
    }
    if (actionId === 'confirm-modeling') {
      void handleConfirmModeling();
      return;
    }
    if (actionId === 'sync-job') {
      void handleSyncActiveJob();
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
    if (actionId === 'generate-reference') return canCreateReference;
    if (actionId === 'accept-reference') return Boolean(referenceImage && !busy);
    if (actionId === 'confirm-modeling') return canConfirmModeling;
    if (actionId === 'sync-job') return Boolean(activeJob && !syncingJobId);
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
  const gatewayRouteHint = buildGatewayRouteHint(providerStatus, imageProvider);
  const model3dReady = isModel3dReady(providerStatus);
  const activeChainSummary = buildActiveChainSummary(providerStatus, imageProvider, modelProvider);
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
  const canResumeActiveJob = isSelfhostJobResumable(activeJob);
  const canDiagnoseActiveJob = isSelfhostJobDiagnosable(activeJob);
  const nextAction = buildWorkflowNextAction({
    prompt,
    busy,
    referenceImage,
    referenceAccepted,
    activeJob,
    canResumeActiveJob,
    syncing: Boolean(syncingJobId),
  });
  const resultReview = activeJob?.status === 'completed' && activeJob.result
    ? buildResultReview(activeJob)
    : null;
  const jobHistorySummary = buildJobHistorySummary(jobHistory, activeJob);
  const visibleJobHistory = jobHistorySummary.visible;
  const hiddenJobCount = jobHistorySummary.hiddenCount;
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

      <section className={`workflow-next-action ${nextAction.state}`} aria-label="推荐下一步" data-testid="workflow-next-action">
        <small>推荐下一步</small>
        <span>{nextAction.title}</span>
        <p>{nextAction.hint}</p>
        <button
          type="button"
          onClick={() => handleRecommendedNextAction(nextAction.id)}
          disabled={!isRecommendedNextActionEnabled(nextAction.id)}
          data-testid="workflow-next-action-button"
        >
          {nextAction.label}
        </button>
      </section>

      <label className="generation-field generation-prompt-field">
        <span>01 TEXT PROMPT / 生物结构描述</span>
        <textarea
          value={prompt}
          maxLength={600}
          onFocus={() => trackEvent('workflow_prompt_focus', { template })}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：动物细胞 3D 教学模型，突出线粒体、细胞核和细胞膜"
        />
      </label>

      <div className="generation-actions" id="workflow-actions" aria-label="生成操作">
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

      {visibleJobHistory.length > 0 && (
        <div className="job-history" data-testid="job-history-compact">
          <div className="job-history-title">
            <span>任务摘要</span>
            <strong>{jobHistorySummary.liveCount > 0 ? `${jobHistorySummary.liveCount} 个运行中` : '固定 3 条'}</strong>
            <em>{hiddenJobCount > 0 ? `已折叠 ${hiddenJobCount} 条` : `共 ${jobHistorySummary.totalCount} 条`}</em>
          </div>
          {visibleJobHistory.map((job) => (
            <button
              type="button"
              className={`job-row ${job.status}${activeJob?.id === job.id ? ' active' : ''}`}
              key={job.id}
              onClick={() => handleSelectJob(job)}
            >
              <span>
                <small>{getWorkflowModeLabel(job.workflowMode || 'image-to-3d')} · {getShortJobId(job.id)}</small>
                <em>{job.prompt}</em>
              </span>
              <strong>{job.status === 'completed' ? '完成' : job.status === 'failed' ? '失败' : `${job.progress}%`}</strong>
            </button>
          ))}
          <p className="job-history-note">后台队列持续同步，面板只保留当前、运行中和最近结果。</p>
        </div>
      )}

      {taskWatch && (
        <section className={`task-watch-card ${taskWatch.state}`} aria-label="长任务观察" data-testid="task-watch-card">
          <div className="task-watch-head">
            <span>{taskWatch.eyebrow}</span>
            <strong>{taskWatch.title}</strong>
            <div className="task-watch-actions">
              <button type="button" onClick={handleSyncActiveJob} disabled={Boolean(syncingJobId)} data-testid="sync-active-job">
                {syncingJobId ? '同步中' : '同步状态'}
              </button>
              {canResumeActiveJob && (
                <button type="button" onClick={handleResumeActiveJob} disabled={Boolean(syncingJobId)} data-testid="resume-active-job">
                  续接输出
                </button>
              )}
              {canDiagnoseActiveJob && (
                <button type="button" onClick={handleDiagnoseActiveJob} disabled={Boolean(diagnosingJobId)} data-testid="diagnose-active-job">
                  {diagnosingJobId ? '诊断中' : '诊断远端'}
                </button>
              )}
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
          {taskWatch.recoveryLabel && taskWatch.recoveryHint && (
            <div className="task-watch-recovery" data-testid="task-watch-recovery">
              <span>{taskWatch.recoveryLabel}</span>
              <strong>{taskWatch.recoveryHint}</strong>
            </div>
          )}
          {diagnostics && activeJob?.providerJobId === diagnostics.promptId && (
            <div className={`task-watch-diagnostics ${diagnostics.outputs.glbCount > 0 ? 'ok' : diagnostics.history.found ? 'warn' : 'pending'}`} data-testid="task-watch-diagnostics">
              <span>远端诊断</span>
              <strong>
                队列 {diagnostics.queue.running}/{diagnostics.queue.pending} · history {diagnostics.history.found ? diagnostics.history.status : '未返回'} · GLB {diagnostics.outputs.glbCount}
              </strong>
              <em>{diagnostics.recommendation}</em>
            </div>
          )}
          {taskWatch.waitLabel && taskWatch.waitHint && (
            <div className={`task-watch-wait ${taskWatch.waitState}`} data-testid="task-watch-wait">
              <span>{taskWatch.waitLabel}</span>
              <strong>{taskWatch.waitHint}</strong>
            </div>
          )}
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
                    <button type="button" onClick={handleResumeActiveJob} disabled={Boolean(syncingJobId)}>
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
                    {texturedModelUrl && (
                      <a href={texturedModelUrl} target="_blank" rel="noreferrer">Textured GLB</a>
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
        <strong>{activeChainSummary} · {selectedImageProfileOption.label} {selectedImageProfileOption.size}</strong>
      </div>

      <div className="local-chain-proof" aria-label="本地链路说明" data-testid="local-chain-proof">
        <span>本地链路</span>
        <strong>{buildLocalChainProofText(providerStatus, imageProvider, modelProvider)}</strong>
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
    { label: '模式', value: getWorkflowModeLabel(job.workflowMode || 'image-to-3d') },
    { label: '模板', value: job.template || 'auto' },
    { label: '成本', value: job.costEstimateCny ? `约 ${job.costEstimateCny} 元` : '本地链路' },
    { label: '更新', value: formatRelativeTime(job.updatedAt) },
  ];

  if (job.provider === 'selfhost-triposg' && job.providerJobId) {
    rows.splice(6, 0, { label: '续接ID', value: getShortJobId(job.providerJobId) });
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

interface TaskWatch {
  state: 'pending' | 'ok' | 'warn';
  eyebrow: string;
  title: string;
  progress: number;
  hint: string;
  recoveryLabel?: string;
  recoveryHint?: string;
  waitLabel?: string;
  waitHint?: string;
  waitState?: 'pending' | 'warn';
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
    imageProfile: reference.imageProfile,
    imageSize: reference.imageSize,
    imageQuality: reference.imageQuality,
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
  const createdAt = Date.parse(job.createdAt || job.updatedAt || '');
  const secondsSinceCreated = Number.isFinite(createdAt) ? Math.max(secondsSinceUpdate, Math.floor((now - createdAt) / 1000)) : secondsSinceUpdate;
  const state: TaskWatch['state'] = job.status === 'failed' ? 'warn' : job.status === 'completed' ? 'ok' : 'pending';
  const providerName = getModelProviderName(job.provider);
  const imageName = getImageProviderName(job.imageProvider || 'local-gateway');
  const waitStage = getJobWaitStage(job, hasReference);
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
      title = '远端输出可续接';
      hint = '该任务已经拿到 ComfyUI prompt_id，可直接续接三维输出，不需要重新生成参考图。';
      recoveryLabel = '可续接';
      recoveryHint = `点击“续接输出”按 ${getShortJobId(job.providerJobId)} 拉取 history / GLB。`;
    } else {
      title = '任务需要复查';
      hint = job.error || job.stage || '请检查图片网关、3D 服务和参考图缓存。';
    }
  } else if (job.provider === 'selfhost-triposg' && progress >= 80) {
    title = progress >= 98 ? '正在续接三维输出' : '正在等待贴图与 GLB 输出';
    hint = job.stage || '80% 后通常是远端三维服务的打包、贴图或文件写入阶段；可保持页面开启，或稍后点击同步状态。';
    if (job.providerJobId) {
      recoveryLabel = '远端任务';
      recoveryHint = `${getShortJobId(job.providerJobId)} · 已提交到 ComfyUI，正在拉取 final.glb。`;
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
  { id: 'modeling', no: '04', title: '图生 3D 建模', caption: 'TripoSG / 混元贴图 / Bio3D' },
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
  if (provider === 'local-gateway') return getImageQualityProfile(status, provider);
  const openai = status.image.openai;
  if (openai?.auth?.message && !openai.auth.ok) return openai.auth.message;
  return getImageQualityProfile(status, provider);
}

function buildLocalChainProofText(status: ProviderStatusPayload | null, imageProvider: string, modelProvider: string) {
  const gateway = status?.image.localGateway;
  const selfhost = status?.model3d.selfhostTriposg;
  const imagePath = imageProvider === 'local-gateway'
    ? `${gateway?.baseUrl || 'http://127.0.0.1:48760'} / ${gateway?.imageModel || 'gpt-image-2'}`
    : 'OpenAI 直连图片服务';
  const modelPath = modelProvider === 'selfhost-triposg'
    ? `${selfhost?.baseUrl || 'ComfyUI'} / TripoSG raw -> Hunyuan3D-Paint textured -> Bio3D final`
    : getModelProviderName(modelProvider);
  const queue = selfhost?.status?.queue;
  const queueText = queue ? `队列 ${queue.running ?? 0}/${queue.pending ?? 0}` : '队列待同步';
  return `${imagePath} -> ${modelPath} · ${queueText}`;
}

function buildGatewayRouteHint(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return null;
  const gatewayReady = isImageProviderReady(status, 'local-gateway');
  const openaiAuth = status.image.openai?.auth;

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
      text: '本地图片网关暂未就绪，生成参考图前请检查 48760 服务与 API Key。',
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

function buildActiveChainSummary(status: ProviderStatusPayload | null, imageProvider: string, modelProvider: string) {
  const imageLabel = imageProvider === 'local-gateway'
    ? status?.image.localGateway?.imageModel || 'gpt-image-2'
    : status?.image.openai?.imageToolModel || status?.image.openai?.imageModel || 'OpenAI';
  const modelLabel = getModelProviderName(modelProvider);
  return `${imageLabel} 单图 -> ${modelLabel}`;
}
