import type { WorkflowJob } from '../services/fusionApi';

export type TimelineStepState = 'idle' | 'active' | 'done' | 'warn';

export interface GenerationTimelineStep {
  id: 'input' | 'prompt' | 'reference' | 'modeling' | 'library';
  no: string;
  title: string;
  caption: string;
  state: TimelineStepState;
}

export interface GenerationTimeline {
  state: 'idle' | 'active' | 'done' | 'warn';
  currentLabel: string;
  nextAction: string;
  steps: GenerationTimelineStep[];
}

interface GenerationTimelineInput {
  prompt: string;
  promptPreviewReady: boolean;
  referenceReady: boolean;
  referenceAccepted: boolean;
  activeJob: WorkflowJob | null;
  busy: boolean;
  imageProviderLabel: string;
  imageSpecLabel: string;
  modelProviderLabel: string;
}

const TIMELINE_DEFINITIONS = [
  { id: 'input', no: '01', title: '描述', caption: '术语或图片' },
  { id: 'prompt', no: '02', title: 'Prompt', caption: '3D-ready 单图' },
  { id: 'reference', no: '03', title: '单图', caption: '确认参考图' },
  { id: 'modeling', no: '04', title: '图生3D', caption: '建模与贴图' },
  { id: 'library', no: '05', title: '入库', caption: '标本列表展示' },
] as const;

export function buildGenerationTimeline(input: GenerationTimelineInput): GenerationTimeline {
  const promptReady = input.prompt.trim().length >= 6;
  const job = input.activeJob;
  const jobLive = job?.status === 'queued' || job?.status === 'processing';
  const jobFailed = job?.status === 'failed';
  const hasReference = input.referenceReady || Boolean(job?.reference || job?.referenceId);
  const hasResult = job?.status === 'completed' || Boolean(job?.result?.modelUrl);
  const promptPrepared = input.promptPreviewReady || hasReference || Boolean(job);

  const states: Record<GenerationTimelineStep['id'], TimelineStepState> = {
    input: promptReady ? 'done' : 'active',
    prompt: getPromptState({ promptReady, promptPrepared, hasReference, jobLive, jobFailed, busy: input.busy }),
    reference: getReferenceState({ hasReference, referenceAccepted: input.referenceAccepted, hasResult, jobLive, jobFailed }),
    modeling: getModelingState({ hasReference, referenceAccepted: input.referenceAccepted, hasResult, jobLive, jobFailed }),
    library: jobFailed && !hasResult ? 'warn' : hasResult ? 'done' : 'idle',
  };

  const steps = TIMELINE_DEFINITIONS.map((step) => ({
    ...step,
    state: states[step.id],
  }));

  return {
    state: jobFailed ? 'warn' : hasResult ? 'done' : steps.some((step) => step.state === 'active') ? 'active' : 'idle',
    currentLabel: buildCurrentLabel({ promptReady, promptPrepared, hasReference, hasResult, jobLive, jobFailed, referenceAccepted: input.referenceAccepted }),
    nextAction: buildNextAction({ ...input, promptReady, promptPrepared, hasReference, hasResult, jobLive, jobFailed }),
    steps,
  };
}

function getPromptState({
  promptReady,
  promptPrepared,
  hasReference,
  jobLive,
  jobFailed,
  busy,
}: {
  promptReady: boolean;
  promptPrepared: boolean;
  hasReference: boolean;
  jobLive: boolean;
  jobFailed: boolean;
  busy: boolean;
}): TimelineStepState {
  if (jobFailed && !hasReference) return 'warn';
  if (promptPrepared) return 'done';
  if (promptReady && (busy || jobLive)) return 'active';
  return 'idle';
}

function getReferenceState({
  hasReference,
  referenceAccepted,
  hasResult,
  jobLive,
  jobFailed,
}: {
  hasReference: boolean;
  referenceAccepted: boolean;
  hasResult: boolean;
  jobLive: boolean;
  jobFailed: boolean;
}): TimelineStepState {
  if (jobFailed && !hasResult) return hasReference ? (referenceAccepted ? 'done' : 'active') : 'warn';
  if (hasResult || referenceAccepted) return 'done';
  if (hasReference || jobLive) return 'active';
  return 'idle';
}

function getModelingState({
  hasReference,
  referenceAccepted,
  hasResult,
  jobLive,
  jobFailed,
}: {
  hasReference: boolean;
  referenceAccepted: boolean;
  hasResult: boolean;
  jobLive: boolean;
  jobFailed: boolean;
}): TimelineStepState {
  if (jobFailed && hasReference && !hasResult) return 'warn';
  if (hasResult) return 'done';
  if (jobLive && hasReference) return 'active';
  if (referenceAccepted) return 'active';
  return 'idle';
}

function buildCurrentLabel({
  promptReady,
  promptPrepared,
  hasReference,
  hasResult,
  jobLive,
  jobFailed,
  referenceAccepted,
}: {
  promptReady: boolean;
  promptPrepared: boolean;
  hasReference: boolean;
  hasResult: boolean;
  jobLive: boolean;
  jobFailed: boolean;
  referenceAccepted: boolean;
}) {
  if (jobFailed) return '链路需复查';
  if (hasResult) return '模型已入库';
  if (jobLive && hasReference) return '正在图生3D';
  if (jobLive) return '正在生成单图';
  if (referenceAccepted) return '等待确认建模';
  if (hasReference) return '等待接收图片';
  if (promptPrepared) return 'Prompt 已准备';
  if (promptReady) return '可生成参考图';
  return '等待输入描述';
}

function buildNextAction({
  promptReady,
  promptPrepared,
  hasReference,
  hasResult,
  jobLive,
  jobFailed,
  referenceAccepted,
  imageProviderLabel,
  imageSpecLabel,
  modelProviderLabel,
}: GenerationTimelineInput & {
  promptReady: boolean;
  promptPrepared: boolean;
  hasReference: boolean;
  hasResult: boolean;
  jobLive: boolean;
  jobFailed: boolean;
}) {
  if (jobFailed) return '查看任务详情并检查图片网关、参考图缓存或 3D 服务。';
  if (hasResult) return '结果已加入标本列表，可在 3D 舞台查看或复用描述继续迭代。';
  if (jobLive && hasReference) return `${modelProviderLabel} 正在建模与贴图，完成后会自动入库。`;
  if (jobLive) return `${imageProviderLabel} 正在生成 ${imageSpecLabel} 参考图。`;
  if (referenceAccepted) return `点击“确认建模”，将参考图交给 ${modelProviderLabel}。`;
  if (hasReference) return '检查构图和剖面后点击“接收图片”，不满意可重试。';
  if (promptPrepared) return `点击“生成参考图”，使用 ${imageProviderLabel} 输出单张参考图。`;
  if (promptReady) return '可直接生成参考图，也可以先预览 Prompt。';
  return '输入至少 6 个字的生物结构描述。';
}
