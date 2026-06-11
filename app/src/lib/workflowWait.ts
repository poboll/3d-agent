export type WorkflowWaitStage = 'image' | 'modeling' | 'queue' | 'generic';

export interface WorkflowWaitHint {
  state: 'pending' | 'warn';
  label: string;
  hint: string;
}

interface WorkflowWaitOptions {
  imageProfile?: string;
  modelProfile?: string;
}

const DEFAULT_IMAGE_PROFILE = 'gpt-image-2 / 1536x1536 / high / timeout 420s';
const DEFAULT_MODEL_PROFILE = 'TripoSG + Bio3D';

export function getWorkflowWaitHint(
  elapsedSeconds: number,
  stage: WorkflowWaitStage,
  options: WorkflowWaitOptions = {}
): WorkflowWaitHint | null {
  const seconds = Math.max(0, Math.floor(elapsedSeconds || 0));
  if (seconds < 60) return null;

  const imageProfile = options.imageProfile || DEFAULT_IMAGE_PROFILE;
  const modelProfile = options.modelProfile || DEFAULT_MODEL_PROFILE;

  if (seconds >= 300) {
    return {
      state: 'warn',
      label: '建议同步状态',
      hint: buildLongWaitHint(stage, imageProfile, modelProfile),
    };
  }

  if (seconds >= 180) {
    return {
      state: 'pending',
      label: '可稍后恢复',
      hint: buildRecoverableHint(stage, imageProfile, modelProfile),
    };
  }

  return {
    state: 'pending',
    label: '后台仍在生成',
    hint: buildNormalWaitHint(stage, imageProfile, modelProfile),
  };
}

function buildNormalWaitHint(stage: WorkflowWaitStage, imageProfile: string, modelProfile: string) {
  if (stage === 'image') {
    return `${imageProfile} 单图生成常见耗时 1-7 分钟；页面不会追加长队列，只同步当前任务。`;
  }
  if (stage === 'modeling') {
    return `${modelProfile} 正在排队、冷启动恢复或 GLB 打包；82% 附近通常是在远端写 raw/final GLB，完成后会自动进入标本列表。`;
  }
  if (stage === 'queue') {
    return '队列只展示关键任务摘要，后台继续轮询当前任务，避免面板一直向下增长。';
  }
  return '任务仍在后台执行，可保持页面开启等待同步。';
}

function buildRecoverableHint(stage: WorkflowWaitStage, imageProfile: string, modelProfile: string) {
  if (stage === 'image') {
    return `${imageProfile} 仍在处理；可保持页面开启，也可稍后回到页面恢复最近任务。`;
  }
  if (stage === 'modeling') {
    return `${modelProfile} 可能正在生成 raw.glb 或 final.glb；若队列仍包含任务请等待，若远端刚 OOM 重启，稍后同步或续接输出即可恢复。`;
  }
  if (stage === 'queue') {
    return '历史队列已折叠为关键任务，稍后可通过任务详情继续查看或复用描述。';
  }
  return '任务可恢复；稍后同步状态即可继续查看结果。';
}

function buildLongWaitHint(stage: WorkflowWaitStage, imageProfile: string, modelProfile: string) {
  if (stage === 'image') {
    return `${imageProfile} 已超过 5 分钟；建议同步状态，并检查本地图片网关是否仍在返回。`;
  }
  if (stage === 'modeling') {
    return `${modelProfile} 已等待较久；建议同步状态或诊断远端。若 history 丢失，系统会复用缓存参考图重新提交一次 3D。`;
  }
  if (stage === 'queue') {
    return '队列等待较久；建议同步状态或检查 3D 服务运行队列。';
  }
  return '任务等待较久；建议同步状态并检查本地服务。';
}
