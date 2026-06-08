import type { WorkflowDiagnosticsPayload, WorkflowJob } from '../services/fusionApi';

export interface TaskWatchViewModel {
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
  strategy: Array<{
    label: string;
    value: string;
    state: 'idle' | 'pending' | 'ok' | 'warn';
  }>;
  items: Array<{
    label: string;
    value: string;
    state: 'idle' | 'pending' | 'ok' | 'warn';
  }>;
}

interface Props {
  taskWatch: TaskWatchViewModel;
  activeJob: WorkflowJob | null;
  diagnostics: WorkflowDiagnosticsPayload | null;
  syncingJobId: string | null;
  diagnosingJobId: string | null;
  canResumeActiveJob: boolean;
  canDiagnoseActiveJob: boolean;
  onSync: () => void;
  onResume: () => void;
  onDiagnose: () => void;
  onOpenModel: () => void;
  onToggleDetails: () => void;
}

export function TaskWatchCard({
  taskWatch,
  activeJob,
  diagnostics,
  syncingJobId,
  diagnosingJobId,
  canResumeActiveJob,
  canDiagnoseActiveJob,
  onSync,
  onResume,
  onDiagnose,
  onOpenModel,
  onToggleDetails,
}: Props) {
  const diagnosticsForActiveJob = diagnostics && activeJob?.providerJobId === diagnostics.promptId
    ? diagnostics
    : null;
  const isCompleted = activeJob?.status === 'completed' && Boolean(activeJob.result);
  const resultItem = taskWatch.items.find((item) => item.label === '结果');
  const specItem = taskWatch.items.find((item) => item.label === '生成规格');
  const serviceItem = taskWatch.items.find((item) => item.label === '三维服务');
  const updatedItem = taskWatch.items.find((item) => item.label === '最近更新');

  if (isCompleted) {
    return (
      <section className="task-watch-card compact ok" aria-label="长任务观察" data-testid="task-watch-card">
        <div className="task-watch-compact-main">
          <div className="task-watch-compact-line">
            <span>{taskWatch.eyebrow}</span>
            <strong>结果已入库</strong>
            <em>{updatedItem?.value || '刚刚'}</em>
          </div>
          <div className="task-watch-compact-meta" aria-label="完成任务摘要">
            <span>
              <small>模型</small>
              <strong>{resultItem?.value || '已缓存'}</strong>
            </span>
            <span>
              <small>规格</small>
              <strong>{specItem?.value || '参考图'}</strong>
            </span>
            <span>
              <small>链路</small>
              <strong>{serviceItem?.value || '本地 3D'}</strong>
            </span>
          </div>
        </div>
        <div className="task-watch-compact-actions">
          <button type="button" onClick={onOpenModel} data-testid="open-active-job-model">
            查看模型
          </button>
          <button type="button" onClick={onSync} disabled={Boolean(syncingJobId)} data-testid="sync-active-job">
            {syncingJobId ? '同步中' : '同步'}
          </button>
          <button type="button" onClick={onToggleDetails} data-testid="toggle-active-job-detail">
            详情
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`task-watch-card ${taskWatch.state}`} aria-label="长任务观察" data-testid="task-watch-card">
      <div className="task-watch-head">
        <span>{taskWatch.eyebrow}</span>
        <strong>{taskWatch.title}</strong>
        <div className="task-watch-actions">
          <button type="button" onClick={onSync} disabled={Boolean(syncingJobId)} data-testid="sync-active-job">
            {syncingJobId ? '同步中' : '同步状态'}
          </button>
          {canResumeActiveJob && (
            <button type="button" onClick={onResume} disabled={Boolean(syncingJobId)} data-testid="resume-active-job">
              续接输出
            </button>
          )}
          {canDiagnoseActiveJob && (
            <button type="button" onClick={onDiagnose} disabled={Boolean(diagnosingJobId)} data-testid="diagnose-active-job">
              {diagnosingJobId ? '诊断中' : '诊断远端'}
            </button>
          )}
          {activeJob?.result && (
            <button type="button" onClick={onOpenModel} data-testid="open-active-job-model">
              查看模型
            </button>
          )}
        </div>
      </div>
      <div className="task-watch-rail" aria-label={`任务进度 ${taskWatch.progress}%`}>
        <span style={{ width: `${taskWatch.progress}%` }} />
      </div>
      <div className="task-watch-strategy" aria-label="任务等待策略" data-testid="task-watch-strategy">
        {taskWatch.strategy.map((item) => (
          <span className={item.state} key={item.label}>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </span>
        ))}
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
      {diagnosticsForActiveJob && (
        <div className={`task-watch-diagnostics ${diagnosticsForActiveJob.outputs.glbCount > 0 ? 'ok' : diagnosticsForActiveJob.history.found ? 'warn' : 'pending'}`} data-testid="task-watch-diagnostics">
          <span>远端诊断</span>
          <strong>
            队列 {diagnosticsForActiveJob.queue.running}/{diagnosticsForActiveJob.queue.pending} · history {diagnosticsForActiveJob.history.found ? diagnosticsForActiveJob.history.status : '未返回'} · GLB {diagnosticsForActiveJob.outputs.glbCount}
          </strong>
          <em>{diagnosticsForActiveJob.recommendation}</em>
        </div>
      )}
      {taskWatch.waitLabel && taskWatch.waitHint && (
        <div className={`task-watch-wait ${taskWatch.waitState}`} data-testid="task-watch-wait">
          <span>{taskWatch.waitLabel}</span>
          <strong>{taskWatch.waitHint}</strong>
        </div>
      )}
    </section>
  );
}
