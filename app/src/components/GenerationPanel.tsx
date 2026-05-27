import { useEffect, useRef, useState } from 'react';
import type { CellModel } from '../data/models';
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
  const [providerStatusLoading, setProviderStatusLoading] = useState(false);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [jobHistory, setJobHistory] = useState<WorkflowJob[]>([]);

  const phase = getWorkflowPhase({ referenceImage, activeJob, busy });
  const failedPhase = getWorkflowFailedPhase(activeJob);

  useEffect(() => {
    let cancelled = false;
    setProviderStatusLoading(true);
    fetchProviderStatus(true)
      .then((statusPayload) => {
        if (cancelled) return;
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
          setActiveJob(job);
          const jobReference = job.reference;
          if (jobReference) {
            setReferenceImage((current) => {
              if (current?.id === jobReference.id) return current;
              return toReferenceImage(jobReference, false);
            });
            setReferenceAccepted(true);
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
          setStatus(job.stage);
          setJobHistory((current) => mergeJobs(job, current));

          const model = workflowJobToCellModel(job);
          if (model) {
            onModelCreated(model);
            onSelect(model.id);
            setBusy(false);
            setStatus('建模完成：结果已缓存并加入模型索引。');
            trackEvent('workflow_job_completed', {
              jobId: job.id,
              template: job.template,
              provider: job.provider,
              modelId: model.id,
            });
          }

          if (job.status === 'failed') {
            setBusy(false);
            setStatus(job.error || job.stage || '生成任务失败。');
            trackEvent('workflow_job_failed', {
              jobId: job.id,
              template: job.template,
              provider: job.provider,
              message: job.error || job.stage,
            });
          }
        })
        .catch((error) => {
          if (cancelled) return;
          setBusy(false);
          setStatus(error instanceof Error ? error.message : '任务状态查询失败。');
        });
    }, 900);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeJob, onModelCreated, onSelect]);

  const handleLoadDemo = async () => {
    setBusy(true);
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
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(true);
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
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  };

  const handleReferenceUpload = async (file: File) => {
    setBusy(true);
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
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const handleCreateReference = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构描述，或上传一张参考图。');
      return;
    }

    setBusy(true);
    setStatus(`${getImageProviderName(imageProvider)} 正在生成 3D-ready 单图参考图...`);
    setPromptPreview(null);
    trackEvent('workflow_reference_generate_start', {
      template,
      imageProvider,
      promptLength: prompt.trim().length,
    });
    try {
      const reference = await createReferenceImage({
        prompt: prompt.trim(),
        provider: imageProvider,
        template,
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
      setStatus(`${getImageProviderName(imageProvider)} 已产出参考图，请检查后点击“接收图片”，再确认建模。`);
      trackEvent('workflow_reference_generate', {
        template,
        imageProvider,
        promptLength: prompt.trim().length,
        referenceId: reference.id,
        model: reference.model,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '参考图生成失败。');
      trackEvent('workflow_reference_generate_failed', {
        template,
        imageProvider,
        message: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewPrompt = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构术语或课堂描述。');
      return;
    }

    setBusy(true);
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
    }
  };

  const handleRunFullWorkflow = async () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构术语或课堂描述。');
      return;
    }

    setBusy(true);
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
    setStatus('已退回参考图，请修改描述后重新生成，或上传一张图片。');
    trackEvent('workflow_reference_reject', { template });
  };

  const handleConfirmModeling = async () => {
    if (!referenceImage) {
      setStatus('需要先生成或上传参考图，再确认图生建模。');
      return;
    }
    if (!referenceAccepted) {
      setStatus('请先检查参考图并点击“接收图片”，再提交图生 3D 建模。');
      return;
    }

    setBusy(true);
    setStatus('已确认参考图，正在创建图生 3D 建模任务...');
    trackEvent('workflow_model_confirm', {
      template,
      provider: modelProvider,
      uploaded: referenceImage.uploaded,
    });
    try {
      const fallbackPrompt = referenceImage.uploaded
        ? `${referenceImage.title} 生物 3D 教学模型`
        : prompt;
      const job = await createTextToCellJob({
        prompt: fallbackPrompt,
        provider: modelProvider,
        template,
        imageProvider,
        referenceId: referenceImage.id,
      });
      setActiveJob(job);
      setJobHistory((current) => mergeJobs(job, current));
      setStatus(job.stage);
      trackEvent('workflow_job_created', {
        jobId: job.id,
        template: job.template,
        provider: job.provider,
        costEstimateCny: job.costEstimateCny,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '文本生成任务创建失败。');
      trackEvent('workflow_job_failed', {
        template,
        provider: modelProvider,
        message: error instanceof Error ? error.message : 'unknown',
      });
      setBusy(false);
    }
  };

  const handleSelectJob = (job: WorkflowJob) => {
    setActiveJob(job);
    setStatus(job.error || job.stage);

    const model = workflowJobToCellModel(job);
    if (model) {
      onModelCreated(model);
      onSelect(model.id);
    }
  };

  const progress = activeJob?.progress ?? 0;
  const canCreateReference = !busy && prompt.trim().length >= 6;
  const canConfirmModeling = !busy && !!referenceImage && referenceAccepted && activeJob?.status !== 'completed' && activeJob?.status !== 'processing' && activeJob?.status !== 'queued';
  const selectedProviderOnline = isImageProviderReady(providerStatus, imageProvider);
  const selectedProviderLabel = getImageProviderName(imageProvider);
  const model3dReady = isModel3dReady(providerStatus);

  return (
    <section className="generation-panel" id={id}>
      <div>
        <span className="generation-eyebrow">§ 01 — WORKFLOW DESK</span>
        <h2>生成工坊</h2>
        <p>文本或图片先形成参考图，确认后再交给图生 3D 服务，适合课堂里逐步讲解。</p>
      </div>

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
        <button type="button" className="generation-primary" onClick={handleCreateReference} disabled={!canCreateReference}>
          生成参考图
        </button>
        <button type="button" className="generation-secondary" onClick={handlePreviewPrompt} disabled={!canCreateReference}>
          预览 Prompt
        </button>
        <button type="button" className="generation-primary full-action" onClick={handleRunFullWorkflow} disabled={!canCreateReference || busy}>
          完整生成
        </button>
        <button type="button" className="generation-primary confirm-action" onClick={handleConfirmModeling} disabled={!canConfirmModeling}>
          确认建模
        </button>
        <button type="button" className="generation-secondary" onClick={() => imageInputRef.current?.click()} disabled={busy}>
          上传图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleCreateReference} disabled={!canCreateReference}>
          重试图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleAcceptReference} disabled={!referenceImage || busy}>
          {referenceAccepted ? '已接收' : '接收图片'}
        </button>
        <button type="button" className="generation-secondary" onClick={handleRejectReference} disabled={!referenceImage || busy}>
          退回图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleLoadDemo} disabled={busy}>
          加载缓存
        </button>
        <button type="button" className="generation-secondary" onClick={() => modelInputRef.current?.click()} disabled={busy}>
          导入 GLB
        </button>
      </div>

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
        <strong>文生图 → 接收图片 → 图生 3D</strong>
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

      {generatedModels.length > 0 && (
        <div className="generated-count">
          <strong>{generatedModels.length}</strong>
          <span>个生成/导入模型进入标本索引</span>
        </div>
      )}

      {jobHistory.length > 0 && (
        <div className="job-history">
          <div className="job-history-title">最近任务</div>
          {jobHistory.slice(0, 4).map((job) => (
            <button
              type="button"
              className={`job-row ${job.status}`}
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

type WorkflowPhase = 'input' | 'prompt' | 'image' | 'modeling' | 'done' | 'failed';

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
  return '图片生成服务';
}

function isImageProviderReady(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return false;
  if (provider === 'local-gateway') {
    return Boolean(status.image.localGateway?.configured && status.image.localGateway?.health?.ok && status.image.localGateway?.models?.ok);
  }
  if (provider === 'openai') {
    return Boolean(status.image.openai?.configured && status.image.openai?.auth?.ok);
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
    const promptModel = gateway?.promptModel || 'gpt-5.5';
    return `${promptModel} / ${imageModel}`;
  }
  const openai = status.image.openai;
  if (openai?.auth?.message && !openai.auth.ok) return openai.auth.message;
  return `${openai?.imageModel || 'OpenAI'} / ${openai?.imageToolModel || 'image tool'}`;
}
