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
  resumeShouldDiagnoseFirst: boolean;
  resumeBlockedReason?: string | null;
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
  resumeShouldDiagnoseFirst,
  resumeBlockedReason,
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
  const isResumable = activeJob?.status === 'failed' && canResumeActiveJob;
  const resumeDisabled = Boolean(syncingJobId || (isResumable && resumeShouldDiagnoseFirst));
  const resultItem = taskWatch.items.find((item) => item.label === '结果');
  const specItem = taskWatch.items.find((item) => item.label === '生成规格');
  const serviceItem = taskWatch.items.find((item) => item.label === '三维服务');
  const updatedItem = taskWatch.items.find((item) => item.label === '最近更新');
  const liveItems = taskWatch.items.filter((item) => ['参考图', '三维服务', '结果'].includes(item.label));
  const visibleItems = activeJob?.status === 'queued' || activeJob?.status === 'processing'
    ? liveItems.length ? liveItems : taskWatch.items.slice(0, 3)
    : taskWatch.items;

  if (isCompleted || isResumable) {
    return (
      <section className={`task-watch-card compact ${isCompleted ? 'ok' : 'warn resumable'}`} aria-label="长任务观察" data-testid="task-watch-card">
        <div className="task-watch-compact-main">
          <div className="task-watch-compact-line">
            <span>{taskWatch.eyebrow}</span>
            <strong>{isCompleted ? '结果已入库' : taskWatch.title}</strong>
            <em>{updatedItem?.value || '刚刚'}</em>
          </div>
          <div className="task-watch-compact-meta" aria-label="完成任务摘要">
            <span>
              <small>{isCompleted ? '模型' : '远端'}</small>
              <strong>{isCompleted ? resultItem?.value || '已缓存' : taskWatch.recoveryLabel || '可续接'}</strong>
            </span>
            <span>
              <small>{isCompleted ? '规格' : '参考图'}</small>
              <strong>{isCompleted ? specItem?.value || '参考图' : '已保留'}</strong>
            </span>
            <span>
              <small>{isCompleted ? '链路' : '三维'}</small>
              <strong>{serviceItem?.value || '本地 3D'}</strong>
            </span>
          </div>
        </div>
        <div className="task-watch-compact-actions">
          {isCompleted ? (
            <>
              <button type="button" onClick={onOpenModel} data-testid="open-active-job-model">
                查看模型
              </button>
              <button type="button" onClick={onSync} disabled={Boolean(syncingJobId)} data-testid="sync-active-job">
                {syncingJobId ? '同步中' : '同步'}
              </button>
              <button type="button" onClick={onToggleDetails} data-testid="toggle-active-job-detail">
                详情
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onDiagnose} disabled={Boolean(diagnosingJobId) || !canDiagnoseActiveJob} data-testid="diagnose-active-job">
                {diagnosingJobId ? '诊断中' : '诊断远端'}
              </button>
              <button
                type="button"
                onClick={onResume}
                disabled={resumeDisabled}
                title={resumeShouldDiagnoseFirst ? resumeBlockedReason || '远端暂不可观测，先诊断 queue / history。' : undefined}
                data-testid="resume-active-job"
              >
                续接输出
              </button>
              <button type="button" onClick={onToggleDetails} data-testid="toggle-active-job-detail">
                详情
              </button>
            </>
          )}
        </div>
        {!isCompleted && resumeShouldDiagnoseFirst && (
          <div className="task-watch-diagnostics compact pending" data-testid="task-watch-resume-guard">
            <span>续接保护</span>
            <strong>先诊断远端</strong>
            <em>{resumeBlockedReason || '远端暂不可观测，已保留 prompt_id；恢复后再拉取 GLB。'}</em>
          </div>
        )}
        {diagnosticsForActiveJob && (
          <div className={`task-watch-diagnostics compact ${diagnosticsForActiveJob.outputs.glbCount > 0 ? 'ok' : diagnosticsForActiveJob.history.found ? 'warn' : 'pending'}`} data-testid="task-watch-diagnostics">
            <span>远端诊断</span>
            <strong>
              队列 {diagnosticsForActiveJob.queue.ok ? `${diagnosticsForActiveJob.queue.running}/${diagnosticsForActiveJob.queue.pending}` : '不可达'} · history {diagnosticsForActiveJob.history.found ? diagnosticsForActiveJob.history.status : '未返回'} · GLB {diagnosticsForActiveJob.outputs.glbCount}
            </strong>
            <em>{diagnosticsForActiveJob.recommendation}</em>
          </div>
        )}
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
            <button
              type="button"
              onClick={onResume}
              disabled={Boolean(syncingJobId || resumeShouldDiagnoseFirst)}
              title={resumeShouldDiagnoseFirst ? resumeBlockedReason || '远端暂不可观测，先诊断 queue / history。' : undefined}
              data-testid="resume-active-job"
            >
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
      <div className="task-watch-live-summary" aria-label="后台任务摘要" data-testid="task-watch-live-summary">
        <span>队列摘要</span>
        <strong>固定显示当前关键任务；旧记录收纳，远端异常可诊断或续接。</strong>
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
        {visibleItems.map((item) => (
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
          <strong>{taskWatch.recoveryHint}；若 history 已清理，会复用缓存参考图重新提交 3D。</strong>
        </div>
      )}
      {canResumeActiveJob && resumeShouldDiagnoseFirst && (
        <div className="task-watch-diagnostics pending" data-testid="task-watch-resume-guard">
          <span>续接保护</span>
          <strong>先诊断远端</strong>
          <em>{resumeBlockedReason || '远端暂不可观测，已保留 prompt_id；恢复后再拉取 GLB。'}</em>
        </div>
      )}
      {diagnosticsForActiveJob && (
        <div className={`task-watch-diagnostics ${diagnosticsForActiveJob.outputs.glbCount > 0 ? 'ok' : diagnosticsForActiveJob.history.found ? 'warn' : 'pending'}`} data-testid="task-watch-diagnostics">
          <span>远端诊断</span>
          <strong>
            队列 {diagnosticsForActiveJob.queue.ok ? `${diagnosticsForActiveJob.queue.running}/${diagnosticsForActiveJob.queue.pending}` : '不可达'} · history {diagnosticsForActiveJob.history.found ? diagnosticsForActiveJob.history.status : '未返回'} · GLB {diagnosticsForActiveJob.outputs.glbCount}
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
