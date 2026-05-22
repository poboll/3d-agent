import { useEffect, useRef, useState } from 'react';
import { getModelTemplate } from '../data/models';
import type { CellModel } from '../data/models';
import {
  createTextToCellJob,
  fetchDemoGeneratedModels,
  fetchWorkflowJob,
  fetchWorkflowJobs,
  uploadLocalModel,
  workflowJobToCellModel,
} from '../services/fusionApi';
import type { WorkflowJob } from '../services/fusionApi';

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
  const objectUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState('先得到一张可确认的参考图，再进入图生 3D 建模。');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('植物细胞 3D 教学模型，突出叶绿体、细胞壁和大型液泡');
  const [imageProvider, setImageProvider] = useState('gpt-image');
  const [modelProvider, setModelProvider] = useState('local-demo');
  const [template, setTemplate] = useState('plant-cell');
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [referenceVersion, setReferenceVersion] = useState(0);
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [jobHistory, setJobHistory] = useState<WorkflowJob[]>([]);

  const phase = getWorkflowPhase({ referenceImage, activeJob, busy });

  useEffect(() => {
    let cancelled = false;
    fetchWorkflowJobs()
      .then((jobs) => {
        if (!cancelled) setJobHistory(jobs);
      })
      .catch(() => {
        if (!cancelled) setJobHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!activeJob || activeJob.status === 'completed' || activeJob.status === 'failed') return;

    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchWorkflowJob(activeJob.id)
        .then((job) => {
          if (cancelled) return;
          setActiveJob(job);
          setStatus(job.stage);
          setJobHistory((current) => mergeJobs(job, current));

          const model = workflowJobToCellModel(job);
          if (model) {
            onModelCreated(model);
            onSelect(model.id);
            setBusy(false);
            setStatus('建模完成：结果已缓存并加入模型索引。');
          }

          if (job.status === 'failed') {
            setBusy(false);
            setStatus(job.error || job.stage || '生成任务失败。');
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
      setStatus(error instanceof Error ? error.message : '读取示例模型失败。');
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File) => {
    setBusy(true);
    setStatus(`正在导入 ${file.name}...`);
    try {
      const model = await uploadLocalModel(file);
      onModelCreated(model);
      onSelect(model.id);
      setStatus(`${model.name} 已导入并加入模型列表。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '本地模型导入失败。');
    } finally {
      setBusy(false);
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  };

  const handleReferenceUpload = (file: File) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setReferenceImage({
      url,
      title: file.name,
      source: '上传参考图',
      note: '用户已上传初版图片，可直接确认进入图生 3D。',
      uploaded: true,
    });
    setStatus('已接收上传图片，请确认结构方向后进入图生 3D。');
    setActiveJob(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const handleCreateReference = () => {
    if (!prompt.trim()) {
      setStatus('请先输入生物结构描述，或上传一张参考图。');
      return;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const templateModel = getModelTemplate(template === 'auto' ? 'plant-cell' : template);
    const nextVersion = referenceVersion + 1;
    setReferenceVersion(nextVersion);
    setReferenceImage({
      url: templateModel.imageUrl,
      title: `${templateModel.name} · 参考图 v${nextVersion}`,
      source: getImageProviderName(imageProvider),
      note: prompt.trim(),
      uploaded: false,
    });
    setActiveJob(null);
    setStatus(`${getImageProviderName(imageProvider)} 已产出参考图 v${nextVersion}，请检查后选择重试或确认建模。`);
  };

  const handleAcceptReference = () => {
    if (!referenceImage) {
      setStatus('还没有可接收的参考图，请先生成或上传一张图片。');
      return;
    }
    setStatus('参考图已接收，可点击“确认图生建模”提交 3D 任务。');
  };

  const handleRejectReference = () => {
    setReferenceImage(null);
    setActiveJob(null);
    setStatus('已退回参考图，请修改描述后重新生成，或上传一张图片。');
  };

  const handleConfirmModeling = async () => {
    if (!referenceImage) {
      setStatus('需要先生成或上传参考图，再确认图生建模。');
      return;
    }

    setBusy(true);
    setStatus('已确认参考图，正在创建图生 3D 建模任务...');
    try {
      const fallbackPrompt = referenceImage.uploaded
        ? `${referenceImage.title} 生物 3D 教学模型`
        : prompt;
      const job = await createTextToCellJob({
        prompt: fallbackPrompt,
        provider: modelProvider,
        template,
      });
      setActiveJob(job);
      setJobHistory((current) => mergeJobs(job, current));
      setStatus(job.stage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '文本生成任务创建失败。');
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
  const canConfirmModeling = !busy && !!referenceImage;

  return (
    <section className="generation-panel" id={id}>
      <div>
        <span className="generation-eyebrow">§ 01 — WORKFLOW DESK</span>
        <h2>生成工坊</h2>
        <p>文本或图片先形成参考图，确认后再交给图生 3D 服务，适合课堂里逐步演示。</p>
      </div>

      <ol className="workflow-ladder" aria-label="生成流程">
        {WORKFLOW_STEPS.map((step) => (
          <li className={getStepClass(step.id, phase)} key={step.id}>
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
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：动物细胞 3D 教学模型，突出线粒体、细胞核和细胞膜"
        />
      </label>

      <div className="generation-controls">
        <label className="generation-field compact">
          <span>TEMPLATE</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value)}>
            <option value="auto">自动判断</option>
            <option value="plant-cell">植物细胞</option>
            <option value="animal-cell">动物细胞</option>
            <option value="white-blood-cell">白细胞</option>
            <option value="neuron">神经元</option>
            <option value="dna">DNA</option>
          </select>
        </label>
        <label className="generation-field compact">
          <span>IMAGE MODEL</span>
          <select value={imageProvider} onChange={(event) => setImageProvider(event.target.value)}>
            <option value="gpt-image">GPT Image</option>
            <option value="gemini">Gemini Image</option>
            <option value="nano-banana-2">NanoBanana2</option>
          </select>
        </label>
        <label className="generation-field compact">
          <span>3D PROVIDER</span>
          <select value={modelProvider} onChange={(event) => setModelProvider(event.target.value)}>
            <option value="local-demo">本地演示</option>
            <option value="tencent-hunyuan">腾讯混元</option>
          </select>
        </label>
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
          {referenceImage && <em>{referenceImage.source}</em>}
          <p>{referenceImage?.note ?? '图片确认通过后，才会进入混元 3D 图生建模与结果缓存。'}</p>
        </div>
      </div>

      <div className="generation-actions" id="workflow-actions">
        <button type="button" className="generation-primary" onClick={handleCreateReference} disabled={!canCreateReference}>
          生成参考图
        </button>
        <button type="button" className="generation-secondary" onClick={() => imageInputRef.current?.click()} disabled={busy}>
          上传图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleCreateReference} disabled={!canCreateReference}>
          重试图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleAcceptReference} disabled={!referenceImage || busy}>
          接收图片
        </button>
        <button type="button" className="generation-secondary" onClick={handleRejectReference} disabled={!referenceImage || busy}>
          退回图片
        </button>
        <button type="button" className="generation-primary confirm-action" onClick={handleConfirmModeling} disabled={!canConfirmModeling}>
          确认图生建模
        </button>
        <button type="button" className="generation-secondary" onClick={handleLoadDemo} disabled={busy}>
          加载样例
        </button>
        <button type="button" className="generation-secondary" onClick={() => modelInputRef.current?.click()} disabled={busy}>
          导入本地 GLB
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleReferenceUpload(file);
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

type WorkflowPhase = 'input' | 'image' | 'modeling' | 'done' | 'failed';

interface ReferenceImage {
  url: string;
  title: string;
  source: string;
  note: string;
  uploaded: boolean;
}

const WORKFLOW_STEPS: Array<{
  id: Exclude<WorkflowPhase, 'failed'>;
  no: string;
  title: string;
  caption: string;
}> = [
  { id: 'input', no: '01', title: '文本 / 图片输入', caption: '写描述或上传初图' },
  { id: 'image', no: '02', title: '文生图与确认', caption: '重试或接收参考图' },
  { id: 'modeling', no: '03', title: '图生 3D 建模', caption: '混元服务 / 本地演示' },
  { id: 'done', no: '04', title: '下载缓存展示', caption: '进入 3D 舞台' },
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
  if (activeJob || busy) return 'modeling';
  if (referenceImage) return 'image';
  return 'input';
}

function getStepClass(step: Exclude<WorkflowPhase, 'failed'>, phase: WorkflowPhase) {
  const order: WorkflowPhase[] = ['input', 'image', 'modeling', 'done'];
  const stepIndex = order.indexOf(step);
  const phaseIndex = phase === 'failed' ? order.indexOf('modeling') : order.indexOf(phase);
  if (stepIndex < phaseIndex) return 'done';
  if (stepIndex === phaseIndex) return phase === 'failed' ? 'failed' : 'active';
  return '';
}

function getImageProviderName(provider: string) {
  if (provider === 'gemini') return 'Gemini Image';
  if (provider === 'nano-banana-2') return 'NanoBanana2';
  return 'GPT Image';
}
