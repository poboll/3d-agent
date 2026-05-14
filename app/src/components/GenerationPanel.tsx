import { useEffect, useRef, useState } from 'react';
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
  generatedModels: CellModel[];
  onModelsLoaded: (models: CellModel[]) => void;
  onModelCreated: (model: CellModel) => void;
  onSelect: (id: string) => void;
}

export function GenerationPanel({
  generatedModels,
  onModelsLoaded,
  onModelCreated,
  onSelect,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState('已接入本地后端，可先加载 3DCellForge 示例模型。');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('植物细胞 3D 教学模型，突出叶绿体、细胞壁和大型液泡');
  const [provider, setProvider] = useState('local-demo');
  const [template, setTemplate] = useState('auto');
  const [activeJob, setActiveJob] = useState<WorkflowJob | null>(null);
  const [jobHistory, setJobHistory] = useState<WorkflowJob[]>([]);

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
            setStatus('生成任务已完成，模型已加入左侧列表。');
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
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleCreateJob = async () => {
    setBusy(true);
    setStatus('正在创建文本生成任务...');
    try {
      const job = await createTextToCellJob({ prompt, provider, template });
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
  const canSubmit = !busy && prompt.trim().length >= 6;

  return (
    <section className="generation-panel">
      <div>
        <span className="generation-eyebrow">生成工作流</span>
        <h2>生成模型接入</h2>
        <p>先用本地演示 provider 跑通文本到 3D 的完整链路；腾讯混元生 3D 已预留 provider 入口。</p>
      </div>

      <label className="generation-field">
        <span>生物结构描述</span>
        <textarea
          value={prompt}
          maxLength={600}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：动物细胞 3D 教学模型，突出线粒体、细胞核和细胞膜"
        />
      </label>

      <div className="generation-controls">
        <label className="generation-field compact">
          <span>模型模板</span>
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
          <span>Provider</span>
          <select value={provider} onChange={(event) => setProvider(event.target.value)}>
            <option value="local-demo">本地演示</option>
            <option value="tencent-hunyuan">腾讯混元</option>
          </select>
        </label>
      </div>

      <div className="generation-actions">
        <button type="button" className="generation-primary" onClick={handleCreateJob} disabled={!canSubmit}>
          生成 3D 模型
        </button>
        <button type="button" className="generation-primary" onClick={handleLoadDemo} disabled={busy}>
          加载 3DCellForge 样例
        </button>
        <button type="button" className="generation-secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
          导入本地 GLB
        </button>
        <input
          ref={inputRef}
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
        <span>{busy ? '处理中' : '状态'}</span>
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
          <span>个生成/导入模型已加入侧栏</span>
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
