import type { WorkflowJob } from '../services/fusionApi';

export const JOB_HISTORY_VISIBLE_LIMIT = 3;

export interface JobHistorySummary {
  visible: WorkflowJob[];
  hiddenCount: number;
  totalCount: number;
  liveCount: number;
}

export function buildJobHistorySummary(
  jobs: WorkflowJob[],
  activeJob: WorkflowJob | null,
  limit = JOB_HISTORY_VISIBLE_LIMIT
): JobHistorySummary {
  const maxVisible = Math.max(1, Math.floor(limit || JOB_HISTORY_VISIBLE_LIMIT));
  const uniqueJobs = dedupeJobs([activeJob, ...jobs].filter((job): job is WorkflowJob => Boolean(job)));
  const visible: WorkflowJob[] = [];
  const seenPrompts = new Set<string>();

  const addJob = (job?: WorkflowJob | null) => {
    if (!job || visible.some((item) => item.id === job.id) || visible.length >= maxVisible) return;
    const promptKey = normalizeJobHistoryPrompt(job.prompt);
    if (promptKey && seenPrompts.has(promptKey) && visible.length > 0) return;
    if (promptKey) seenPrompts.add(promptKey);
    visible.push(job);
  };

  addJob(activeJob);
  addJob(jobs.find(isLiveHistoryJob));
  addJob(jobs.find(isResumableSelfhostHistoryJob));
  addJob(jobs.find((job) => job.status === 'completed'));
  addJob(jobs.find((job) => job.status === 'failed'));

  for (const job of jobs) {
    addJob(job);
  }

  return {
    visible,
    hiddenCount: Math.max(0, uniqueJobs.length - visible.length),
    totalCount: uniqueJobs.length,
    liveCount: uniqueJobs.filter(isLiveHistoryJob).length,
  };
}

export function isLiveHistoryJob(job: WorkflowJob) {
  return job.status === 'queued' || job.status === 'processing';
}

export function isResumableSelfhostHistoryJob(job: WorkflowJob) {
  return job.status === 'failed' && job.provider === 'selfhost-triposg' && Boolean(job.providerJobId);
}

function dedupeJobs(jobs: WorkflowJob[]) {
  const seen = new Set<string>();
  const unique: WorkflowJob[] = [];
  for (const job of jobs) {
    if (!job.id || seen.has(job.id)) continue;
    seen.add(job.id);
    unique.push(job);
  }
  return unique;
}

function normalizeJobHistoryPrompt(prompt: string) {
  return String(prompt || '')
    .replace(/\s+/g, '')
    .replace(/[，。,.!！?？:：；;]/g, '')
    .slice(0, 36);
}
