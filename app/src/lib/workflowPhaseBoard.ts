import type { WorkflowJob } from '../services/fusionApi';

export type WorkflowPhaseBoardState = 'done' | 'active' | 'pending' | 'warn';

export interface WorkflowPhaseBoardItem {
  id: 'input' | 'prompt' | 'reference' | 'modeling' | 'final';
  no: string;
  title: string;
  state: WorkflowPhaseBoardState;
  meta: string;
  hint: string;
}

export interface WorkflowPhaseBoard {
  state: WorkflowPhaseBoardState;
  title: string;
  summary: string;
  queueNote: string;
  phases: WorkflowPhaseBoardItem[];
}

interface ReferenceLike {
  id?: string;
  imageSize?: string;
  imageQuality?: string;
}

interface WorkflowPhaseBoardInput {
  prompt: string;
  activeJob: WorkflowJob | null;
  referenceImage: ReferenceLike | null;
  referenceAccepted: boolean;
  busy: boolean;
  now: number;
  operationStartedAt: number | null;
  imageProviderLabel: string;
  imageSpecLabel: string;
  modelProviderLabel: string;
}

const PHASE_DEFINITIONS: Array<Pick<WorkflowPhaseBoardItem, 'id' | 'no' | 'title'>> = [
  { id: 'input', no: '01', title: '术语输入' },
  { id: 'prompt', no: '02', title: 'Prompt 打磨' },
  { id: 'reference', no: '03', title: '单图参考' },
  { id: 'modeling', no: '04', title: '图生 3D' },
  { id: 'final', no: '05', title: 'Final GLB' },
];

export function buildWorkflowPhaseBoard(input: WorkflowPhaseBoardInput): WorkflowPhaseBoard {
  const job = input.activeJob;
  const promptReady = String(input.prompt || job?.prompt || '').trim().length >= 6;
  const jobLive = job?.status === 'queued' || job?.status === 'processing';
  const jobFailed = job?.status === 'failed';
  const hasReference = Boolean(input.referenceImage || job?.reference || job?.referenceId);
  const referenceAccepted = Boolean(input.referenceAccepted || job?.referenceId || job?.result);
  const hasResult = Boolean(job?.status === 'completed' || job?.result?.modelUrl);
  const elapsed = getElapsedLabel(input, job);
  const imageSpec = job?.imageSize || job?.imageQuality
    ? [job.imageSize, job.imageQuality].filter(Boolean).join(' / ')
    : input.imageSpecLabel;

  const states = buildPhaseStates({
    promptReady,
    jobLive,
    jobFailed,
    hasReference,
    referenceAccepted,
    hasResult,
    busy: input.busy,
  });

  const phases = PHASE_DEFINITIONS.map((phase) => ({
    ...phase,
    state: states[phase.id],
    ...buildPhaseCopy(phase.id, {
      elapsed,
      imageProviderLabel: input.imageProviderLabel,
      imageSpec,
      modelProviderLabel: input.modelProviderLabel,
      promptReady,
      job,
      hasReference,
      referenceAccepted,
      hasResult,
    }),
  }));

  const state: WorkflowPhaseBoardState = jobFailed
    ? 'warn'
    : hasResult
      ? 'done'
      : phases.some((phase) => phase.state === 'active')
        ? 'active'
        : 'pending';

  return {
    state,
    title: buildBoardTitle({ job, hasResult, hasReference, jobLive, jobFailed, referenceAccepted, promptReady }),
    summary: buildBoardSummary({ job, elapsed, hasResult, hasReference, jobLive, jobFailed, imageSpec, imageProviderLabel: input.imageProviderLabel, modelProviderLabel: input.modelProviderLabel }),
    queueNote: '队列面板固定为最多 2 条摘要；旧任务自动收纳，避免队列面板一直向下增长。',
    phases,
  };
}

function buildPhaseStates({
  promptReady,
  jobLive,
  jobFailed,
  hasReference,
  referenceAccepted,
  hasResult,
  busy,
}: {
  promptReady: boolean;
  jobLive: boolean;
  jobFailed: boolean;
  hasReference: boolean;
  referenceAccepted: boolean;
  hasResult: boolean;
  busy: boolean;
}): Record<WorkflowPhaseBoardItem['id'], WorkflowPhaseBoardState> {
  if (jobFailed) {
    return {
      input: promptReady ? 'done' : 'warn',
      prompt: hasReference ? 'done' : 'warn',
      reference: hasReference ? 'done' : 'warn',
      modeling: hasReference ? 'warn' : 'pending',
      final: 'warn',
    };
  }

  return {
    input: promptReady ? 'done' : 'active',
    prompt: hasReference || jobLive || busy ? 'done' : promptReady ? 'pending' : 'pending',
    reference: hasResult || referenceAccepted ? 'done' : hasReference || (jobLive && !hasReference) || busy ? 'active' : 'pending',
    modeling: hasResult ? 'done' : jobLive && hasReference ? 'active' : referenceAccepted ? 'active' : 'pending',
    final: hasResult ? 'done' : 'pending',
  };
}

function buildPhaseCopy(
  id: WorkflowPhaseBoardItem['id'],
  context: {
    elapsed: string;
    imageProviderLabel: string;
    imageSpec: string;
    modelProviderLabel: string;
    promptReady: boolean;
    job: WorkflowJob | null;
    hasReference: boolean;
    referenceAccepted: boolean;
    hasResult: boolean;
  }
): Pick<WorkflowPhaseBoardItem, 'meta' | 'hint'> {
  if (id === 'input') {
    return {
      meta: context.promptReady ? '已具备生成条件' : '等待描述',
      hint: context.promptReady ? '可生成参考图或直接完整生成。' : '输入至少 6 个字的生物结构描述。',
    };
  }
  if (id === 'prompt') {
    return {
      meta: context.hasReference || context.job ? '已打磨' : '待打磨',
      hint: context.hasReference || context.job
        ? '已转为适合 3D-ready 单图的结构提示。'
        : '将使用 gpt-5.5 高推理模式压实剖面、材质和负空间。',
    };
  }
  if (id === 'reference') {
    return {
      meta: context.hasReference ? context.imageSpec : context.imageProviderLabel,
      hint: context.hasReference
        ? '参考图已写入本地缓存，可确认后建模。'
        : `${context.imageProviderLabel} 输出单张参考图，默认不是 4K；精细模式为 2048x2048。`,
    };
  }
  if (id === 'modeling') {
    return {
      meta: context.hasResult ? '已完成' : context.referenceAccepted ? context.modelProviderLabel : '等待确认',
      hint: context.hasResult
        ? '三维结果已下载入库。'
        : context.referenceAccepted
          ? '正在等待 raw.glb、textured.glb 与 final.glb。'
          : '接收图片后再提交图生 3D，避免错误参考图消耗建模时间。',
    };
  }
  return {
    meta: context.hasResult ? '可展示' : context.elapsed,
    hint: context.hasResult
      ? '前端优先加载 final.glb，同时保留 raw/textured 诊断链接。'
      : '完成后会自动加入标本列表并切换到 3D 舞台。',
  };
}

function buildBoardTitle({
  job,
  hasResult,
  hasReference,
  jobLive,
  jobFailed,
  referenceAccepted,
  promptReady,
}: {
  job: WorkflowJob | null;
  hasResult: boolean;
  hasReference: boolean;
  jobLive: boolean;
  jobFailed: boolean;
  referenceAccepted: boolean;
  promptReady: boolean;
}) {
  if (jobFailed) return '链路需要复查';
  if (hasResult) return '模型已入库';
  if (jobLive && hasReference) return '正在图生 3D';
  if (jobLive) return '正在生成参考图';
  if (referenceAccepted) return '等待确认建模';
  if (hasReference) return '等待接收参考图';
  if (job || promptReady) return '准备生成单图';
  return '等待输入';
}

function buildBoardSummary({
  job,
  elapsed,
  hasResult,
  hasReference,
  jobLive,
  jobFailed,
  imageSpec,
  imageProviderLabel,
  modelProviderLabel,
}: {
  job: WorkflowJob | null;
  elapsed: string;
  hasResult: boolean;
  hasReference: boolean;
  jobLive: boolean;
  jobFailed: boolean;
  imageSpec: string;
  imageProviderLabel: string;
  modelProviderLabel: string;
}) {
  if (jobFailed) return job?.error || job?.stage || '请检查图片网关、参考图缓存与 3D 服务。';
  if (hasResult) return 'final.glb 已缓存，标本索引会同步出现该模型。';
  if (jobLive && hasReference) return `${modelProviderLabel} 处理中，已等待 ${elapsed}。`;
  if (jobLive) return `${imageProviderLabel} 正在生成 ${imageSpec} 参考图，已等待 ${elapsed}。`;
  return `当前规格：${imageSpec}，确认参考图后再进入 ${modelProviderLabel}。`;
}

function getElapsedLabel(input: WorkflowPhaseBoardInput, job: WorkflowJob | null) {
  const startedAt = job?.createdAt ? Date.parse(job.createdAt) : input.operationStartedAt;
  if (!startedAt || !Number.isFinite(startedAt)) return '待开始';
  const totalSeconds = Math.max(0, Math.floor((input.now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
