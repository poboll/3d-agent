import type { WorkflowJob } from '../services/fusionApi';

export type WorkflowNextActionId =
  | 'write-prompt'
  | 'upload-reference'
  | 'generate-reference'
  | 'accept-reference'
  | 'confirm-modeling'
  | 'refresh-preflight'
  | 'sync-job'
  | 'diagnose-job'
  | 'resume-job'
  | 'view-model'
  | 'review-error';

export interface WorkflowNextAction {
  id: WorkflowNextActionId;
  label: string;
  title: string;
  hint: string;
  state: 'idle' | 'ready' | 'pending' | 'done' | 'warn';
  targetTestId?: string;
}

interface ReferenceLike {
  id?: string;
}

interface WorkflowNextActionInput {
  prompt: string;
  busy: boolean;
  referenceImage: ReferenceLike | null;
  referenceAccepted: boolean;
  activeJob: WorkflowJob | null;
  canResumeActiveJob: boolean;
  canDiagnoseActiveJob?: boolean;
  resumeShouldDiagnoseFirst?: boolean;
  resumeBlockedReason?: string | null;
  imageProviderReady?: boolean;
  imageProviderChecking?: boolean;
  imageProviderBlockedReason?: string | null;
  canUploadReference?: boolean;
  model3dReady: boolean;
  model3dBlockedKind?: 'resource' | 'queue' | 'sync' | 'service' | null;
  model3dBlockedReason?: string | null;
  syncing: boolean;
}

export function buildWorkflowNextAction(input: WorkflowNextActionInput): WorkflowNextAction {
  const promptReady = input.prompt.trim().length >= 6;
  const job = input.activeJob;
  const live = job?.status === 'queued' || job?.status === 'processing';
  const completed = job?.status === 'completed' && Boolean(job.result?.modelUrl);
  const failed = job?.status === 'failed';

  if (input.busy || live) {
    return {
      id: 'sync-job',
      label: input.syncing ? '同步中' : '同步状态',
      title: job?.referenceId ? '建模正在进行' : '参考图正在生成',
      hint: job?.stage || '后台任务正在执行，可保持页面开启；等待较久时点击同步状态。',
      state: 'pending',
      targetTestId: 'sync-active-job',
    };
  }

  if (completed) {
    return {
      id: 'view-model',
      label: '查看模型',
      title: '模型已入库',
      hint: '结果已经进入标本索引，点击后切到 3D 舞台继续观察。',
      state: 'done',
      targetTestId: 'open-active-job-model',
    };
  }

  if (failed) {
    if (input.canResumeActiveJob) {
      if (input.resumeShouldDiagnoseFirst && input.canDiagnoseActiveJob) {
        return {
          id: 'diagnose-job',
          label: '诊断远端',
          title: '远端暂不可观测',
          hint: input.resumeBlockedReason || '已保留 ComfyUI prompt_id；先诊断 queue / history，确认远端恢复后再续接 GLB，避免重复提交重任务。',
          state: 'warn',
          targetTestId: 'diagnose-active-job',
        };
      }
      return {
        id: 'resume-job',
        label: '续接输出',
        title: '远端输出可续接',
        hint: '该任务已有 ComfyUI prompt_id，可直接拉取 history / GLB，不必重新生成参考图。',
        state: 'warn',
        targetTestId: 'resume-active-job',
      };
    }
    return {
      id: 'review-error',
      label: '查看详情',
      title: '链路需要复查',
      hint: job?.error || job?.stage || '请检查图片网关、参考图缓存和 3D 服务状态。',
      state: 'warn',
    };
  }

  if (input.referenceImage && !input.referenceAccepted) {
    return {
      id: 'accept-reference',
      label: '接收图片',
      title: '先确认参考图',
      hint: '检查主体、剖面、留白和结构方向，满意后再进入图生 3D。',
      state: 'ready',
      targetTestId: 'accept-reference-image',
    };
  }

  if (input.referenceImage && input.referenceAccepted) {
    if (!input.model3dReady) {
      return {
        id: 'refresh-preflight',
        label: '刷新预检',
        title: input.model3dBlockedKind === 'resource'
          ? '3D 资源保护中'
          : input.model3dBlockedKind === 'queue'
            ? '3D 队列保护中'
            : '先确认 3D 资源',
        hint: input.model3dBlockedReason || '参考图已接收，但自部署 3D 仍在同步或资源保护中；先刷新链路预检，避免再次触发 OOM。',
        state: 'pending',
        targetTestId: 'refresh-provider-status',
      };
    }
    return {
      id: 'confirm-modeling',
      label: '确认建模',
      title: '可以提交图生 3D',
      hint: '将已确认参考图交给 TripoSG + Bio3D final 链路。',
      state: 'ready',
      targetTestId: 'confirm-modeling',
    };
  }

  if (promptReady) {
    if (input.imageProviderChecking) {
      return {
        id: 'refresh-preflight',
        label: '刷新预检',
        title: '图片链路同步中',
        hint: '正在确认 48760 图片网关与上游路由；也可以先上传已有图片继续图生 3D。',
        state: 'pending',
        targetTestId: 'refresh-provider-status',
      };
    }
    if (input.imageProviderReady === false) {
      const hint = input.imageProviderBlockedReason
        ? `${input.imageProviderBlockedReason} 可先上传已有图片继续图生 3D。`
        : '图片上游暂不可用，可先上传已有图片继续图生 3D。';
      return {
        id: input.canUploadReference === false ? 'refresh-preflight' : 'upload-reference',
        label: input.canUploadReference === false ? '刷新预检' : '上传图片',
        title: '文生图上游暂不可用',
        hint,
        state: 'warn',
        targetTestId: input.canUploadReference === false ? 'refresh-provider-status' : 'upload-reference-image',
      };
    }
    return {
      id: 'generate-reference',
      label: '生成参考图',
      title: '先生成单图',
      hint: '推荐先得到一张 3D-ready 单图；也可以直接完整生成。',
      state: 'ready',
      targetTestId: 'generate-reference',
    };
  }

  return {
    id: 'write-prompt',
    label: '输入描述',
    title: '等待生物结构描述',
    hint: '输入术语、教学目标或上传图片后，系统才会开始生成参考图。',
    state: 'idle',
  };
}
