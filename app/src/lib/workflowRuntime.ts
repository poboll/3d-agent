import type { ProviderStatusPayload, TextureArtifactStatusPayload, TextureStabilityStatusPayload, WorkflowJob } from '../services/fusionApi';

export type RuntimeRailState = 'ok' | 'pending' | 'warn' | 'idle';

export interface RuntimeRailItem {
  id: string;
  label: string;
  value: string;
  note: string;
  state: RuntimeRailState;
}

export interface WorkflowGuardSummary {
  state: RuntimeRailState;
  title: string;
  detail: string;
  chips: Array<{
    id: string;
    label: string;
    value: string;
    state: RuntimeRailState;
  }>;
}

export interface RuntimeRailInput {
  status: ProviderStatusPayload | null;
  loading: boolean;
  imageProvider: string;
  modelProvider: string;
}

export interface TextureResourcePlan {
  state: RuntimeRailState;
  title: string;
  detail: string;
  strategy: {
    label: string;
    value: string;
    detail: string;
    state: RuntimeRailState;
  };
  items: RuntimeRailItem[];
}

export interface TextureResultStatus {
  state: RuntimeRailState;
  label: string;
  detail: string;
  mode: string;
}

export interface TexturePathSignal {
  id: 'fallback-color' | 'hunyuan';
  label: string;
  value: string;
  note: string;
  state: RuntimeRailState;
}

export interface TextureArtifactHealth {
  state: RuntimeRailState;
  title: string;
  detail: string;
  latest: {
    jobId: string;
    mode: string;
    verdict: string;
    fileSize: string;
    modelUrl: string;
    state: RuntimeRailState;
  } | null;
  chips: Array<{
    id: string;
    label: string;
    value: string;
    state: RuntimeRailState;
  }>;
  paths: TexturePathSignal[];
}

export interface TextureStabilityHealth {
  state: RuntimeRailState;
  title: string;
  detail: string;
  latest: {
    label: string;
    value: string;
    verdict: string;
    modelUrl: string;
    state: RuntimeRailState;
  } | null;
  chips: Array<{
    id: string;
    label: string;
    value: string;
    state: RuntimeRailState;
  }>;
  paths: TexturePathSignal[];
}

export interface ChainReadinessSummary {
  state: RuntimeRailState;
  title: string;
  detail: string;
  badge: {
    label: string;
    value: string;
    state: RuntimeRailState;
  };
  steps: RuntimeRailItem[];
}

interface TextureResourcePlanInput extends RuntimeRailInput {
  textureMode: string;
}

export function buildModelRoleRail(input: RuntimeRailInput): RuntimeRailItem[] {
  const gateway = input.status?.image.localGateway;
  const openai = input.status?.image.openai;
  const route = gateway?.imageRoute;
  const promptModel = input.imageProvider === 'local-gateway'
    ? gateway?.promptModel || 'gpt-5.5'
    : openai?.imageModel || 'gpt-5.5';
  const imageModel = input.imageProvider === 'local-gateway'
    ? gateway?.imageModel || 'gpt-image-2'
    : openai?.imageToolModel || openai?.imageModel || 'GPT Image';
  const matchedModels = route?.matchedModels?.length ? route.matchedModels.join(' / ') : '';
  const routeLabel = route?.cached ? `${matchedModels || '按配置模型'}（近期缓存）` : matchedModels || '按配置模型';
  const routeReady = input.imageProvider !== 'local-gateway'
    ? Boolean(openai?.configured)
    : !route || route.ok === null || route.ok !== false;

  return [
    {
      id: 'prompt-model',
      label: '提示词模型',
      value: input.loading ? '同步中' : promptModel,
      note: '只负责术语理解与 3D-ready prompt 打磨',
      state: input.loading ? 'pending' : 'ok',
    },
    {
      id: 'image-model',
      label: '文生图模型',
      value: input.loading ? '同步中' : imageModel,
      note: '实际生成参考图；当前不是文本模型代替出图',
      state: input.loading ? 'pending' : routeReady ? 'ok' : 'warn',
    },
    {
      id: 'image-route',
      label: '网关路由',
      value: input.loading
        ? '同步中'
        : route?.ok === false
          ? '需检查'
          : routeLabel,
      note: route?.cached
        ? 'models 本次检查超时，暂用近期成功匹配，不代表新提交重任务。'
        : '可用模型列表只用于匹配，不能代表当前选用模型',
      state: input.loading ? 'pending' : routeReady ? 'ok' : 'warn',
    },
  ];
}

export function buildTextureResourcePlan(input: TextureResourcePlanInput): TextureResourcePlan {
  const selfhost = input.status?.model3d.selfhostTriposg;
  const texture = selfhost?.texture;
  const guard = selfhost?.resourceGuard;
  const ram = selfhost?.status?.ram;
  const gpu = selfhost?.status?.gpu?.[0];
  const queue = selfhost?.status?.queue;
  const runtime = selfhost?.runtime;
  const ramTotalGiB = bytesToGiB(ram?.total);
  const ramFreeGiB = bytesToGiB(ram?.available ?? ram?.free);
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  const vramTotalGiB = bytesToGiB(gpu?.vramTotal);
  const textureEnabled = Boolean(texture?.enabled);
  const isSelfhost = input.modelProvider === 'selfhost-triposg';
  const isHunyuan = input.textureMode === 'hunyuan';
  const lowMemoryLimit = texture?.lowMemoryTotalRamGb ?? 24;
  const minTotal = texture?.minTotalRamGb ?? 24;
  const minRam = texture?.minRamFreeGb ?? 18;
  const minVram = texture?.minVramFreeGb ?? 14;
  const backoffCount = texture?.runtimeBackoffCount ?? 2;
  const backoffHours = Math.max(1, Math.round((texture?.runtimeBackoffMs ?? 3 * 60 * 60 * 1000) / 60 / 60 / 1000));
  const lowMemoryMode = isSelfhost
    && textureEnabled
    && Number.isFinite(ramTotalGiB)
    && ramTotalGiB < lowMemoryLimit;
  const lowMemoryRemoteDisabled = texture?.lowMemoryRemoteEnabled === false && lowMemoryMode;
  const queueBusy = ((runtime?.running ?? 0) + (runtime?.pending ?? 0) > 0)
    || ((runtime?.blockWhenRemoteBusy ?? guard?.blockWhenRemoteBusy ?? true) && ((queue?.running ?? 0) + (queue?.pending ?? 0) > 0));
  const totalReady = !Number.isFinite(ramTotalGiB) || ramTotalGiB >= minTotal || (lowMemoryMode && texture?.lowMemoryRemoteEnabled !== false);
  const ramReady = !Number.isFinite(ramFreeGiB) || ramFreeGiB >= minRam;
  const vramReady = !Number.isFinite(vramFreeGiB) || vramFreeGiB >= minVram;
  const textureReady = isSelfhost
    && textureEnabled
    && selfhost?.status?.ok === true
    && !lowMemoryRemoteDisabled
    && totalReady
    && ramReady
    && vramReady
    && !queueBusy;
  const state: RuntimeRailState = input.loading || (isSelfhost && !selfhost?.status)
    ? 'pending'
    : !isSelfhost
      ? 'idle'
      : isHunyuan && textureReady
        ? 'ok'
        : isHunyuan && textureEnabled
          ? 'pending'
          : 'ok';
  const steps = isHunyuan ? texture?.steps ?? 10 : guard?.steps ?? 16;
  const faces = isHunyuan ? texture?.faces ?? 3000 : guard?.faces ?? 12000;
  const timeLabel = isHunyuan
    ? lowMemoryMode
      ? '15-45 分钟'
      : '10-30 分钟'
    : '5-15 分钟';
  const title = input.loading
    ? '正在同步贴图资源'
    : !isSelfhost
      ? '当前不是自部署贴图链路'
      : isHunyuan && textureReady
        ? lowMemoryMode
          ? '20GB 低内存贴图试跑可用'
          : '混元贴图可提交'
      : isHunyuan && textureEnabled
        ? '贴图会受资源守护控制'
        : '稳定几何优先';
  const detail = !isSelfhost
    ? '缓存或云端 provider 不读取本地 ComfyUI RAM/VRAM，正式贴图请切回自部署 TripoSG + Bio3D。'
    : isHunyuan
      ? `当前会先拿到稳定 raw GLB，再复用已有 mesh 做 Hunyuan3D-Paint；20GB 可以低内存串行试跑，但理想是 32GB+，24GB 是更稳的实际下限。资源不过线或运行中低于 ${texture?.runtimeMinRamFreeGb ?? 5.5}GB RAM 会主动熔断并写入轻量贴图 fallback；同一白模连续 ${backoffCount} 次熔断后，会退避约 ${backoffHours} 小时直接走彩色 fallback。`
      : `当前优先完成稳定 TripoSG/Bio3D 几何；如需避免白模，切到混元贴图增强会在资源过线时叠加贴图，失败时保留稳定 GLB 并写入轻量贴图 fallback。`;
  const strategy = input.loading || (isSelfhost && !selfhost?.status)
    ? {
        label: '提交策略',
        value: '等资源同步',
        detail: '先只读刷新 RAM、VRAM 与队列，再决定是否提交贴图任务。',
        state: 'pending' as RuntimeRailState,
      }
    : !isSelfhost
      ? {
          label: '提交策略',
          value: '切回自部署',
          detail: '当前 provider 不读取 ComfyUI 资源，无法判断远端贴图安全线。',
          state: 'idle' as RuntimeRailState,
        }
      : !isHunyuan
        ? {
            label: '提交策略',
            value: '稳定几何优先',
            detail: '先产出 raw GLB；需要彩色结果时再切混元贴图或走轻量 fallback。',
            state: 'ok' as RuntimeRailState,
          }
        : !textureEnabled
          ? {
              label: '提交策略',
              value: '贴图未启用',
              detail: '远端没有开放 Hunyuan3D-Paint，继续生成稳定 GLB。',
              state: 'warn' as RuntimeRailState,
            }
          : queueBusy
            ? {
                label: '提交策略',
                value: '等待队列清空',
                detail: '保持单任务串行，避免多个 3D/贴图任务叠加触发 OOM。',
                state: 'pending' as RuntimeRailState,
              }
            : lowMemoryRemoteDisabled
              ? {
                  label: '提交策略',
                  value: 'fallback 优先',
                  detail: '20GB 主机当前禁用远端低内存贴图，直接使用稳定 GLB 的轻量彩色 fallback。',
                  state: 'warn' as RuntimeRailState,
                }
              : !totalReady || !ramReady || !vramReady
                ? {
                    label: '提交策略',
                    value: 'fallback 优先',
                    detail: '资源低于贴图提交线，先保留白模并写入轻量彩色 fallback。',
                    state: 'pending' as RuntimeRailState,
                  }
                : lowMemoryMode
                  ? {
                      label: '提交策略',
                      value: '可试跑混元',
                      detail: '按 20GB 低内存档单任务串行试跑，运行中低于安全线会自动熔断到 fallback。',
                      state: 'ok' as RuntimeRailState,
                    }
                  : {
                      label: '提交策略',
                      value: '可提交混元',
                      detail: 'RAM/VRAM/队列均过线，可以提交 Hunyuan3D-Paint 贴图增强。',
                      state: 'ok' as RuntimeRailState,
                    };

  return {
    state,
    title,
    detail,
    strategy,
    items: [
      {
        id: 'memory',
        label: '系统内存',
        value: Number.isFinite(ramFreeGiB) && Number.isFinite(ramTotalGiB)
          ? `${formatGiB(ramFreeGiB)} / ${formatGiB(ramTotalGiB)}`
          : '待同步',
        note: isHunyuan ? `提交线 ${minRam}GB，理想 32GB+` : `稳定线 ${guard?.minRamFreeGb ?? 10}GB`,
        state: !isSelfhost || !Number.isFinite(ramFreeGiB)
          ? 'pending'
          : isHunyuan
            ? ramReady && totalReady ? 'ok' : 'pending'
            : ramFreeGiB >= (guard?.minRamFreeGb ?? 10) ? 'ok' : 'warn',
      },
      {
        id: 'vram',
        label: 'GPU 显存',
        value: Number.isFinite(vramFreeGiB) && Number.isFinite(vramTotalGiB)
          ? `${formatGiB(vramFreeGiB)} / ${formatGiB(vramTotalGiB)}`
          : '待同步',
        note: isHunyuan ? `提交线 ${minVram}GB，运行线 ${texture?.runtimeMinVramFreeGb ?? 8}GB` : `稳定线 ${guard?.minVramFreeGb ?? 6}GB`,
        state: !isSelfhost || !Number.isFinite(vramFreeGiB)
          ? 'pending'
          : isHunyuan
            ? vramReady ? 'ok' : 'pending'
            : vramFreeGiB >= (guard?.minVramFreeGb ?? 6) ? 'ok' : 'warn',
      },
      {
        id: 'profile',
        label: '低内存档',
        value: isHunyuan ? `${steps} steps / ${faces} faces` : `${steps} steps / ${faces} faces`,
        note: lowMemoryMode ? '20GB 串行低 faces/steps' : '常规资源档',
        state: lowMemoryRemoteDisabled ? 'warn' : lowMemoryMode ? 'pending' : 'ok',
      },
      {
        id: 'time',
        label: '单次预计',
        value: timeLabel,
        note: isHunyuan ? '完整文生图到彩色 3D 常见 30-60+ 分钟' : '只生成几何会更快',
        state: isHunyuan ? 'pending' : 'ok',
      },
    ],
  };
}

export function buildRuntimeRail(input: RuntimeRailInput): RuntimeRailItem[] {
  const gateway = input.status?.image.localGateway;
  const selfhost = input.status?.model3d.selfhostTriposg;
  const runtime = selfhost?.runtime;
  const queue = selfhost?.status?.queue;
  const gpu = selfhost?.status?.gpu?.[0];
  const ram = selfhost?.status?.ram;
  const guard = selfhost?.resourceGuard;
  const imageReady = isImageReady(input.status, input.imageProvider);
  const statusChecked = Boolean(selfhost?.status);
  const modelReady = input.modelProvider !== 'selfhost-triposg'
    ? true
    : Boolean(selfhost?.configured && selfhost.status?.ok === true);
  const recoverable = Boolean(selfhost?.status?.recoverable);
  const vramPercent = percent(gpu?.vramFree, gpu?.vramTotal);
  const ramFreeGiB = bytesToGiB(ram?.available ?? ram?.free);
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  const localQueueRunning = runtime?.running ?? 0;
  const localQueuePending = runtime?.pending ?? 0;
  const remoteQueueRunning = queue?.running ?? 0;
  const remoteQueuePending = queue?.pending ?? 0;
  const blockWhenRemoteBusy = runtime?.blockWhenRemoteBusy ?? guard?.blockWhenRemoteBusy ?? true;
  const localQueueBusy = localQueueRunning + localQueuePending > 0;
  const remoteQueueBusy = blockWhenRemoteBusy && remoteQueueRunning + remoteQueuePending > 0;
  const queueBusy = localQueueBusy || remoteQueueBusy;
  const ramState = !Number.isFinite(ramFreeGiB) || input.modelProvider !== 'selfhost-triposg'
    ? 'idle'
    : ramFreeGiB >= (guard?.minRamFreeGb ?? 10)
      ? 'ok'
      : 'warn';
  const vramState = gpu
    ? vramFreeGiB >= (guard?.minVramFreeGb ?? 6)
      ? 'ok'
      : vramFreeGiB >= Math.max(2, (guard?.minVramFreeGb ?? 6) / 2)
        ? 'pending'
        : 'warn'
    : input.modelProvider === 'selfhost-triposg'
      ? 'pending'
      : 'idle';

  return [
    {
      id: 'gateway',
      label: '图片网关',
      value: input.loading ? '同步中' : imageReady ? '可生成' : '需检查',
      note: gateway?.imageModel
        ? `${gateway.imageModel} · ${gateway.imageSize || '1536x1536'}`
        : input.imageProvider === 'openai'
          ? 'OpenAI 直连'
          : '48760 health/models',
      state: input.loading ? 'pending' : imageReady ? 'ok' : 'warn',
    },
    {
      id: 'prompt',
      label: 'Prompt',
      value: input.loading ? '同步中' : gateway?.promptModel || 'gpt-5.5',
      note: '3D-ready 单图打磨',
      state: input.loading ? 'pending' : 'ok',
    },
    {
      id: 'queue',
      label: '保护队列',
      value: input.modelProvider === 'selfhost-triposg'
        ? `${localQueueRunning}/${localQueuePending}`
        : '未启用',
      note: input.modelProvider === 'selfhost-triposg'
        ? `本地串行提交，最多等待 ${runtime?.maxPending ?? guard?.maxLocalPending ?? 1} 个`
        : '缓存/云端 provider',
      state: input.modelProvider !== 'selfhost-triposg'
        ? 'idle'
        : localQueueBusy
          ? 'pending'
          : 'ok',
    },
    {
      id: 'remote',
      label: '远端 3D',
      value: input.modelProvider === 'selfhost-triposg'
        ? !statusChecked
          ? '待同步'
          : recoverable
          ? '恢复中'
          : queueBusy
            ? '队列保护'
            : modelReady
              ? '在线'
              : '需检查'
        : modelProviderLabel(input.modelProvider),
      note: input.modelProvider === 'selfhost-triposg'
        ? recoverable
          ? selfhost?.status?.message || 'OOM/冷启动恢复中'
          : !statusChecked
            ? '点击刷新链路预检后读取 ComfyUI system_stats / queue'
            : queueBusy
              ? `本地保护 ${localQueueRunning}/${localQueuePending}，远端队列 ${remoteQueueRunning}/${remoteQueuePending}`
              : `ComfyUI 队列 ${remoteQueueRunning}/${remoteQueuePending}`
        : '非自部署链路',
      state: input.loading
        ? 'pending'
        : input.modelProvider !== 'selfhost-triposg'
          ? 'idle'
          : !statusChecked
            ? 'pending'
          : recoverable
            ? 'pending'
            : queueBusy
              ? 'pending'
            : modelReady
              ? 'ok'
              : 'warn',
    },
    {
      id: 'ram',
      label: 'RAM 余量',
      value: Number.isFinite(ramFreeGiB) ? formatGiB(ramFreeGiB) : input.modelProvider === 'selfhost-triposg' ? '待同步' : '不适用',
      note: guard?.enabled
        ? `安全线 ${guard.minRamFreeGb ?? 10}GB`
        : '资源保护关闭',
      state: ramState,
    },
    {
      id: 'gpu',
      label: 'GPU 余量',
      value: gpu ? `${vramPercent}%` : input.modelProvider === 'selfhost-triposg' ? '待同步' : '不适用',
      note: gpu ? `${formatGiB(vramFreeGiB)} / ${formatGiB(bytesToGiB(gpu.vramTotal))} VRAM` : '刷新预检后显示',
      state: vramState,
    },
  ];
}

export function buildTextureResultStatus(job: WorkflowJob | null): TextureResultStatus {
  const result = job?.result;
  const effectiveMode = result?.effectiveTextureMode || job?.effectiveTextureMode || result?.textureMode || job?.textureMode || 'stable';
  const requestedMode = result?.requestedTextureMode || job?.requestedTextureMode || job?.textureMode || 'stable';
  const fallbackReason = result?.textureFallbackReason || job?.textureFallbackReason || '';
  const hasModel = Boolean(result?.modelUrl);
  const hasNativeTexturedGlb = Boolean(result?.texturedModelUrl) || effectiveMode === 'hunyuan';

  if (!job || !hasModel) {
    return {
      state: 'pending',
      label: '等待贴图结果',
      detail: '完成图生 3D 后会在这里明确区分原生混元 textured.glb、fallback 彩色版与稳定几何版。',
      mode: 'pending',
    };
  }

  if (hasNativeTexturedGlb) {
    return {
      state: 'ok',
      label: '原生混元贴图已返回',
      detail: result?.texturedModelUrl
        ? 'Hunyuan3D-Paint 已返回 textured.glb，final.glb 会优先展示这份原生全彩版本。'
        : '任务标记为 Hunyuan3D-Paint 完成，final.glb 已按原生贴图增强结果入库。',
      mode: 'hunyuan',
    };
  }

  if (effectiveMode === 'fallback-color') {
    return {
      state: 'ok',
      label: '稳定 fallback 彩色版',
      detail: `${describeTextureFallbackReason(fallbackReason)} 这不是原生混元 textured.glb，但已避免白模并适合低内存连续使用。`,
      mode: 'fallback-color',
    };
  }

  if (requestedMode === 'hunyuan' || fallbackReason) {
    return {
      state: 'warn',
      label: '贴图增强未完整返回',
      detail: fallbackReason
        ? `${fallbackReason} 当前仍保留可用 final.glb；如画面偏白，可稍后在资源空闲时重新提交原生混元贴图。`
        : '已请求混元贴图但未拿到 textured.glb；当前 final.glb 可能仍是稳定几何版。',
      mode: effectiveMode,
    };
  }

  return {
    state: 'idle',
    label: '稳定几何版',
    detail: '本次未请求混元贴图，final.glb 优先保证几何可用；需要彩色结果时可切换混元贴图增强。',
    mode: 'stable',
  };
}

export function buildTextureArtifactHealth(status: TextureArtifactStatusPayload | null, loading = false): TextureArtifactHealth {
  if (loading) {
    return {
      state: 'pending',
      title: '正在检查贴图产物',
      detail: '只读取本地已缓存 GLB，不会提交新的 Hunyuan3D-Paint 任务。',
      latest: null,
      chips: [
        { id: 'checked', label: '检查', value: '同步中', state: 'pending' },
        { id: 'failed', label: '白模风险', value: '待定', state: 'pending' },
        { id: 'mode', label: '检查方式', value: '只读', state: 'pending' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: '同步中',
        fallbackNote: '读取本地缓存中的 fallback/final GLB。',
        fallbackState: 'pending',
        hunyuanValue: '同步中',
        hunyuanNote: '只检查是否已有原生 textured.glb。',
        hunyuanState: 'pending',
      }),
    };
  }
  if (!status || status.checked <= 0) {
    return {
      state: 'idle',
      title: '暂无贴图产物',
      detail: '完成一次 selfhost 贴图增强后，这里会显示 active material 级别的非白模检查结果。',
      latest: null,
      chips: [
        { id: 'checked', label: '检查', value: '0 个', state: 'idle' },
        { id: 'failed', label: '白模风险', value: '无数据', state: 'idle' },
        { id: 'mode', label: '检查方式', value: '只读', state: 'idle' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: '待产物',
        fallbackNote: '还没有可检查的 fallback 彩色 GLB。',
        fallbackState: 'idle',
        hunyuanValue: '待返回',
        hunyuanNote: '还没有原生混元 textured.glb 证据。',
        hunyuanState: 'idle',
      }),
    };
  }
  const artifacts = Array.isArray(status.artifacts) ? status.artifacts : [];
  const native = artifacts.filter((item) => item.effectiveTextureMode === 'hunyuan' && item.ok).length;
  const fallback = artifacts.filter((item) => item.effectiveTextureMode === 'fallback-color' && item.ok).length;
  const latest = artifacts[0];
  const state: RuntimeRailState = status.ok ? 'ok' : 'warn';
  const title = status.ok
    ? native > 0
      ? fallback > 0
        ? '混元与 fallback 产物通过检查'
        : '原生混元贴图产物通过检查'
      : fallback > 0
        ? 'fallback 彩色产物通过检查'
        : '贴图产物通过检查'
    : '贴图产物需复查';
  const detail = status.ok
    ? native > 0
      ? '最近原生混元 textured.glb 已通过 active material 检查；fallback 仅作为资源保护备选。'
      : fallback > 0
        ? '最近产物为轻量参考图贴图 fallback，active material 已非白模；它不是原生混元 textured.glb。'
        : status.summary || '最近贴图产物已经通过 active material 检查。'
    : status.summary || '存在贴图产物未通过 active material 检查，请优先复查最新任务。';
  return {
    state,
    title,
    detail,
    latest: latest ? {
      jobId: latest.jobId || 'unknown',
      mode: getTextureArtifactModeLabel(latest.effectiveTextureMode || latest.textureMode || ''),
      verdict: latest.ok
        ? getTextureArtifactReasonLabel(latest.reason)
        : latest.error || latest.message || '未通过 active material 检查',
      fileSize: formatBytes(latest.model?.bytes),
      modelUrl: latest.modelUrl || latest.model?.url || '',
      state: latest.ok ? 'ok' : 'warn',
    } : null,
    chips: [
      { id: 'checked', label: '已检查', value: `${status.checked} 个`, state },
      { id: 'failed', label: '白模风险', value: `${status.failed} 个`, state: status.failed > 0 ? 'warn' : 'ok' },
      { id: 'native', label: '原生混元', value: `${native} 个`, state: native > 0 ? 'ok' : 'idle' },
      { id: 'fallback', label: 'fallback 彩色', value: `${fallback} 个`, state: fallback > 0 ? 'ok' : 'idle' },
      { id: 'mode', label: '检查方式', value: '只读', state: 'ok' },
    ],
    paths: buildTexturePathSignals({
      fallbackValue: fallback > 0 ? `${fallback} 个通过` : '无证据',
      fallbackNote: fallback > 0
        ? '低内存可用彩色版已通过 active material 检查。'
        : '没有 fallback 彩色产物通过检查。',
      fallbackState: fallback > 0 ? 'ok' : 'idle',
      hunyuanValue: native > 0 ? `${native} 个通过` : '未返回',
      hunyuanNote: native > 0
        ? '已有原生混元 textured.glb 通过检查。'
        : '当前没有原生混元 textured.glb 通过证据。',
      hunyuanState: native > 0 ? 'ok' : 'idle',
    }),
  };
}

export function buildTextureStabilityHealth(
  status: TextureStabilityStatusPayload | null,
  loading = false,
  running = false,
): TextureStabilityHealth {
  if (running || status?.running) {
    return {
      state: 'pending',
      title: '贴图预检运行中',
      detail: '正在只读读取 raw GLB、参考图与资源闸门；不会提交远端 Hunyuan3D-Paint 重任务。',
      latest: null,
      chips: [
        { id: 'runs', label: '轮次', value: '只读', state: 'pending' },
        { id: 'mode', label: '模式', value: '预检', state: 'pending' },
        { id: 'queue', label: '队列', value: '不提交', state: 'pending' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: '检查中',
        fallbackNote: '只读确认 fallback 来源，不提交重任务。',
        fallbackState: 'pending',
        hunyuanValue: '未提交',
        hunyuanNote: '预检阶段不会调用 Hunyuan3D-Paint。',
        hunyuanState: 'idle',
      }),
    };
  }
  if (loading) {
    return {
      state: 'pending',
      title: '读取连续验证报告',
      detail: '正在读取最近一次白模换原参考图贴图的连续验证结果。',
      latest: null,
      chips: [
        { id: 'runs', label: '轮次', value: '同步中', state: 'pending' },
        { id: 'mode', label: '模式', value: '同步中', state: 'pending' },
        { id: 'queue', label: '队列', value: '同步中', state: 'pending' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: '同步中',
        fallbackNote: '读取最近一次 fallback 长测报告。',
        fallbackState: 'pending',
        hunyuanValue: '同步中',
        hunyuanNote: '读取是否存在原生混元返回证据。',
        hunyuanState: 'pending',
      }),
    };
  }
  const summary = status?.summary;
  if (!summary) {
    return {
      state: 'idle',
      title: '未做贴图预检',
      detail: '可以先只读预检 raw GLB、参考图与资源闸门；需要长测时再运行连续轻量贴图验证。',
      latest: null,
      chips: [
        { id: 'runs', label: '轮次', value: '0 次', state: 'idle' },
        { id: 'colored', label: '彩色', value: '无数据', state: 'idle' },
        { id: 'mode', label: '模式', value: '待运行', state: 'idle' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: '待长测',
        fallbackNote: '运行轻量长测后确认低内存彩色版是否稳定。',
        fallbackState: 'idle',
        hunyuanValue: '未确认',
        hunyuanNote: '需要资源过线并返回 textured.glb 才算原生混元成功。',
        hunyuanState: 'idle',
      }),
    };
  }
  const requested = Number(summary.requestedRuns || 0);
  const completed = Number(summary.completedRuns || 0);
  const colored = Number(summary.coloredRuns || 0);
  const failed = Number(summary.failedRuns || 0);
  const state: RuntimeRailState = summary.ok ? 'ok' : 'warn';
  const modeLabel = getTextureArtifactModeLabel(summary.textureMode || status.report?.options?.textureMode || '');
  if (summary.dryRun) {
    const consecutive = status?.latestConsecutive?.summary;
    const consecutiveOk = Boolean(consecutive?.ok && !consecutive.dryRun && Number(consecutive.requestedRuns || 0) > 0);
    const consecutiveRequested = Number(consecutive?.requestedRuns || 0);
    const consecutiveColored = Number(consecutive?.coloredRuns || 0);
    return {
      state,
      title: consecutiveOk
        ? `预检通过 · fallback 长测 ${consecutiveColored}/${consecutiveRequested}`
        : summary.ok ? '只读预检通过' : '只读预检需复查',
      detail: summary.ok
        ? consecutiveOk
          ? `只读预检没有提交贴图任务；最近连续长测仍保留 ${consecutiveColored}/${consecutiveRequested} 次非白模 fallback GLB。原生混元本轮未调用，不能标记为 textured.glb 成功。`
          : '来源 raw GLB、参考图和资源闸门可用；本次没有提交贴图任务，也未调用混元贴图重任务，适合 20GB 服务器日常点检。'
        : summary.resourceMessage || status.message || status.report?.error || '只读预检没有通过，请先处理资源闸门或来源任务。',
      latest: {
        label: consecutiveOk ? '保留长测' : '来源任务',
        value: consecutiveOk && consecutive?.lastJobId ? shortId(consecutive.lastJobId) : summary.lastJobId ? shortId(summary.lastJobId) : '无任务',
        verdict: consecutiveOk ? '最近连续长测非白模' : summary.ok ? '可进入轻量贴图长测' : summary.resourceGate || '预检失败',
        modelUrl: consecutiveOk ? consecutive?.lastModelUrl || '' : summary.lastModelUrl || '',
        state,
      },
      chips: [
        { id: 'runs', label: '运行', value: '0 重任务', state: 'ok' },
        { id: 'colored', label: '彩色', value: consecutiveOk ? `${consecutiveColored} 次` : '只读未生成', state: consecutiveOk ? 'ok' : 'idle' },
        { id: 'gate', label: '闸门', value: summary.resourceGate || 'unknown', state },
        { id: 'mode', label: '模式', value: '只读预检', state: 'ok' },
        { id: 'fallback', label: '轻量', value: consecutiveOk ? `${consecutiveRequested} 连续` : '待长测', state: consecutiveOk ? 'ok' : 'idle' },
      ],
      paths: buildTexturePathSignals({
        fallbackValue: consecutiveOk ? `稳定 ${consecutiveColored}/${consecutiveRequested}` : '待长测',
        fallbackNote: consecutiveOk
          ? '最近连续 fallback 彩色 GLB 保留为低内存可用证据。'
          : '只读预检不会生成新彩色 GLB。',
        fallbackState: consecutiveOk ? 'ok' : 'idle',
        hunyuanValue: '本轮未调用',
        hunyuanNote: '没有新的原生混元 textured.glb 返回证据。',
        hunyuanState: 'idle',
      }),
    };
  }
  const hunyuanRuns = Number(summary.hunyuanRuns || 0);
  const fallbackRuns = Number(summary.fallbackColorRuns || 0);
  const nativeOk = summary.textureMode === 'hunyuan' && hunyuanRuns > 0 && failed === 0;
  return {
    state,
    title: summary.ok
      ? summary.textureMode === 'fallback-color'
        ? `fallback 长测 ${completed}/${requested}`
        : `${completed}/${requested} 连续通过`
      : `${completed}/${requested} 连续验证需复查`,
    detail: summary.ok
      ? summary.textureMode === 'fallback-color'
        ? `最近连续 ${requested} 次都生成了可用彩色 fallback GLB；未调用原生混元贴图重任务，用于保护 20GB 服务器。`
        : `最近连续 ${requested} 次都生成了可用彩色 GLB；当前默认走 ${modeLabel}，用于保护 20GB 服务器。`
      : status.message || status.report?.error || '连续验证没有完全通过，请检查失败轮次或资源闸门。',
    latest: {
      label: '最后一轮',
      value: summary.lastJobId ? shortId(summary.lastJobId) : '无任务',
      verdict: summary.ok ? 'final GLB 非白模' : status.report?.error || '未完全通过',
      modelUrl: summary.lastModelUrl || '',
      state,
    },
    chips: [
      { id: 'runs', label: '完成', value: `${completed}/${requested}`, state },
      { id: 'colored', label: '彩色', value: `${colored} 次`, state: colored === requested && requested > 0 ? 'ok' : 'warn' },
      { id: 'failed', label: '失败', value: `${failed} 次`, state: failed > 0 ? 'warn' : 'ok' },
      { id: 'mode', label: '模式', value: modeLabel, state: summary.textureMode === 'hunyuan' ? 'warn' : 'ok' },
      { id: 'fallback', label: '轻量', value: `${summary.fallbackColorRuns || 0} 次`, state: (summary.fallbackColorRuns || 0) > 0 ? 'ok' : 'idle' },
    ],
    paths: buildTexturePathSignals({
      fallbackValue: fallbackRuns > 0 ? `${fallbackRuns}/${requested} 可用` : '未使用',
      fallbackNote: fallbackRuns > 0
        ? '低内存彩色 fallback 已完成连续验证。'
        : '本次没有 fallback 彩色产物。',
      fallbackState: fallbackRuns > 0 ? 'ok' : 'idle',
      hunyuanValue: nativeOk ? `${hunyuanRuns}/${requested} 返回` : hunyuanRuns > 0 ? `${hunyuanRuns}/${requested} 不稳` : '未调用',
      hunyuanNote: nativeOk
        ? '原生混元 textured.glb 在本轮返回。'
        : '没有完整原生混元 textured.glb 成功证据。',
      hunyuanState: nativeOk ? 'ok' : hunyuanRuns > 0 ? 'warn' : 'idle',
    }),
  };
}

function buildTexturePathSignals(input: {
  fallbackValue: string;
  fallbackNote: string;
  fallbackState: RuntimeRailState;
  hunyuanValue: string;
  hunyuanNote: string;
  hunyuanState: RuntimeRailState;
}): TexturePathSignal[] {
  return [
    {
      id: 'fallback-color',
      label: '当前可用彩色版',
      value: input.fallbackValue,
      note: input.fallbackNote,
      state: input.fallbackState,
    },
    {
      id: 'hunyuan',
      label: '原生混元状态',
      value: input.hunyuanValue,
      note: input.hunyuanNote,
      state: input.hunyuanState,
    },
  ];
}

function getTextureArtifactModeLabel(mode?: string) {
  if (mode === 'hunyuan') return '原生混元贴图';
  if (mode === 'fallback-color') return '轻量彩色贴图';
  if (mode === 'stable') return '稳定几何';
  return mode || '未知模式';
}

function getTextureArtifactReasonLabel(reason?: string) {
  if (reason === 'embedded-texture-on-active-material') return 'active material 已嵌入贴图';
  if (reason === 'non-white-active-material') return 'active material 非白材质';
  return reason || 'active material 检查通过';
}

function shortId(value: string) {
  const text = String(value || '');
  if (!text) return 'unknown';
  const match = text.match(/^job-(\d+)-([a-z0-9]+)/i);
  if (match) return `${match[1].slice(-5)}-${match[2].slice(0, 4)}`;
  return text.length > 12 ? `${text.slice(0, 12)}...` : text;
}

export function buildWorkflowGuardSummary(input: RuntimeRailInput): WorkflowGuardSummary {
  const selfhost = input.status?.model3d.selfhostTriposg;
  const runtime = selfhost?.runtime;
  const queue = selfhost?.status?.queue;
  const gpu = selfhost?.status?.gpu?.[0];
  const ram = selfhost?.status?.ram;
  const guard = selfhost?.resourceGuard;
  const imageReady = isImageReady(input.status, input.imageProvider);
  const statusChecked = Boolean(selfhost?.status);
  const waitingSelfhostStatus = input.modelProvider === 'selfhost-triposg' && !statusChecked;
  const modelReady = input.modelProvider !== 'selfhost-triposg'
    ? true
    : Boolean(selfhost?.configured && selfhost.status?.ok === true);
  const recoverable = Boolean(selfhost?.status?.recoverable);
  const localRunning = runtime?.running ?? 0;
  const localPending = runtime?.pending ?? 0;
  const remoteRunning = queue?.running ?? 0;
  const remotePending = queue?.pending ?? 0;
  const blockWhenRemoteBusy = runtime?.blockWhenRemoteBusy ?? guard?.blockWhenRemoteBusy ?? true;
  const ramFreeGiB = bytesToGiB(ram?.available ?? ram?.free);
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  const vramPercent = percent(gpu?.vramFree, gpu?.vramTotal);
  const ramWarn = input.modelProvider === 'selfhost-triposg'
    && Number.isFinite(ramFreeGiB)
    && ramFreeGiB < (guard?.minRamFreeGb ?? 10);
  const vramWarn = input.modelProvider === 'selfhost-triposg'
    && gpu
    && vramFreeGiB < (guard?.minVramFreeGb ?? 6);
  const localQueueBusy = localRunning + localPending > 0;
  const remoteQueueBusy = blockWhenRemoteBusy && remoteRunning + remotePending > 0;
  const queueBusy = localQueueBusy || remoteQueueBusy;
  const resourcePressure = ramWarn || vramWarn;
  const state: RuntimeRailState = input.loading || waitingSelfhostStatus
    ? 'pending'
    : !imageReady || !modelReady
      ? 'warn'
      : resourcePressure || recoverable || queueBusy
        ? 'pending'
        : 'ok';
  const resourceLabel = input.modelProvider === 'selfhost-triposg'
    ? [
        Number.isFinite(ramFreeGiB) ? `RAM ${formatGiB(ramFreeGiB)}` : 'RAM 待同步',
        gpu ? `GPU ${vramPercent}%` : 'GPU 待同步',
      ].join(' / ')
    : '轻量 provider';
  const remoteRecoveryMessage = selfhost?.status?.message || selfhost?.status?.error || '远端 3D 服务暂不可观测，已暂停新重任务。';

  return {
    state,
    title: input.loading
      ? '正在同步链路守护'
      : resourcePressure
        ? '资源保护中'
      : recoverable
        ? '远端恢复中'
      : queueBusy
        ? '队列保护中'
      : state === 'ok'
        ? '链路守护正常'
        : state === 'pending'
          ? '链路守护排队中'
          : '链路守护需复查',
    detail: input.modelProvider === 'selfhost-triposg'
      ? !statusChecked
        ? `已连接自部署 3D 配置，等待刷新 ComfyUI system_stats / queue；本地保护 ${localRunning}/${localPending}，不会展开长队列。`
        : recoverable
          ? `${remoteRecoveryMessage} 已暂停新的 3D 重任务；已有 prompt_id 会保留，等待 queue/history 恢复后续接。`
        : queueBusy
          ? `已暂停新 3D 重任务：本地保护 ${localRunning}/${localPending}，远端 ${remoteRunning}/${remotePending}；当前只展示摘要，不展开成长队列。`
          : `队列无长列表：本地保护 ${localRunning}/${localPending}，远端 ${remoteRunning}/${remotePending}；资源安全线 ${guard?.enabled === false ? '未启用' : `${guard?.minRamFreeGb ?? 10}GB RAM / ${guard?.minVramFreeGb ?? 6}GB VRAM`}。`
      : '当前使用轻量 3D provider，生成记录会保持为固定摘要，不展开成长队列。',
    chips: [
      {
        id: 'image',
        label: '图片',
        value: input.loading ? '同步中' : imageReady ? '可生成' : '需检查',
        state: input.loading ? 'pending' : imageReady ? 'ok' : 'warn',
      },
      {
        id: 'model',
        label: '3D',
        value: input.modelProvider === 'selfhost-triposg'
          ? ramWarn || vramWarn
            ? '受保护'
            : !statusChecked
            ? '待同步'
            : recoverable
            ? '恢复中'
            : queueBusy
              ? '队列保护'
              : modelReady
                ? '在线'
                : '需检查'
          : modelProviderLabel(input.modelProvider),
        state: input.loading
          ? 'pending'
          : input.modelProvider !== 'selfhost-triposg'
            ? 'idle'
            : ramWarn || vramWarn
              ? 'warn'
            : !statusChecked
              ? 'pending'
            : recoverable
              ? 'pending'
              : queueBusy
                ? 'pending'
              : modelReady
                ? 'ok'
                : 'warn',
      },
      {
        id: 'queue',
        label: '队列',
        value: input.modelProvider === 'selfhost-triposg'
          ? remoteQueueBusy
            ? `远端 ${remoteRunning}/${remotePending}`
            : `本地 ${localRunning}/${localPending}`
          : '摘要',
        state: input.modelProvider !== 'selfhost-triposg' ? 'idle' : queueBusy ? 'pending' : 'ok',
      },
      {
        id: 'resource',
        label: '资源',
        value: resourcePressure ? '资源保护' : resourceLabel,
        state: resourcePressure ? 'warn' : input.loading || (input.modelProvider === 'selfhost-triposg' && !statusChecked) ? 'pending' : input.modelProvider === 'selfhost-triposg' ? 'ok' : 'idle',
      },
    ],
  };
}

export function buildChainReadiness(input: TextureResourcePlanInput): ChainReadinessSummary {
  const gateway = input.status?.image.localGateway;
  const openai = input.status?.image.openai;
  const selfhost = input.status?.model3d.selfhostTriposg;
  const texture = selfhost?.texture;
  const guard = selfhost?.resourceGuard;
  const runtime = selfhost?.runtime;
  const queue = selfhost?.status?.queue;
  const ram = selfhost?.status?.ram;
  const gpu = selfhost?.status?.gpu?.[0];
  const route = gateway?.imageRoute;
  const modelIds = gateway?.models?.modelIds || route?.availableModelIds || [];
  const promptModel = input.imageProvider === 'local-gateway'
    ? gateway?.promptModel || 'gpt-5.5'
    : openai?.imageToolModel || openai?.imageModel || 'gpt-5.5';
  const imageModel = input.imageProvider === 'local-gateway'
    ? gateway?.imageModel || 'gpt-image-2'
    : openai?.imageToolModel || openai?.imageModel || 'GPT Image';
  const imageRouteLabel = route?.cached
    ? `${route.matchedModels?.length ? route.matchedModels.join(' / ') : imageModel}（近期缓存）`
    : route?.matchedModels?.length
      ? route.matchedModels.join(' / ')
      : '';
  const promptModelReady = input.imageProvider !== 'local-gateway'
    ? Boolean(openai?.configured)
    : Boolean(gateway?.configured && (!modelIds.length || hasModelId(modelIds, promptModel)));
  const imageReady = isImageReady(input.status, input.imageProvider);
  const statusChecked = Boolean(selfhost?.status);
  const waitingSelfhostStatus = input.modelProvider === 'selfhost-triposg' && !statusChecked;
  const modelReady = input.modelProvider !== 'selfhost-triposg'
    ? true
    : Boolean(selfhost?.configured && selfhost.status?.ok === true);
  const localQueueRunning = runtime?.running ?? 0;
  const localQueuePending = runtime?.pending ?? 0;
  const remoteQueueRunning = queue?.running ?? 0;
  const remoteQueuePending = queue?.pending ?? 0;
  const blockWhenRemoteBusy = runtime?.blockWhenRemoteBusy ?? guard?.blockWhenRemoteBusy ?? true;
  const queueBusy = localQueueRunning + localQueuePending > 0 || (blockWhenRemoteBusy && remoteQueueRunning + remoteQueuePending > 0);
  const ramTotalGiB = bytesToGiB(ram?.total);
  const ramFreeGiB = bytesToGiB(ram?.available ?? ram?.free);
  const vramFreeGiB = bytesToGiB(gpu?.vramFree);
  const lowMemoryTotal = texture?.lowMemoryTotalRamGb ?? 24;
  const lowMemoryHost = input.modelProvider === 'selfhost-triposg'
    && Number.isFinite(ramTotalGiB)
    && ramTotalGiB < lowMemoryTotal;
  const textureMode = input.textureMode === 'hunyuan' ? 'hunyuan' : 'stable';
  const textureEnabled = Boolean(texture?.enabled);
  const lowMemoryRemoteEnabled = texture?.lowMemoryRemoteEnabled !== false;
  const textureSubmitReady = textureMode === 'hunyuan'
    && input.modelProvider === 'selfhost-triposg'
    && textureEnabled
    && modelReady
    && !queueBusy
    && (lowMemoryRemoteEnabled || !lowMemoryHost)
    && (!Number.isFinite(ramFreeGiB) || ramFreeGiB >= (texture?.minRamFreeGb ?? 16.5))
    && (!Number.isFinite(vramFreeGiB) || vramFreeGiB >= (texture?.minVramFreeGb ?? 14));
  const fallbackReady = texture?.autoFallback !== false;
  const badge = input.loading || waitingSelfhostStatus
    ? {
        label: '同步方式',
        value: '只读刷新',
        state: 'pending' as RuntimeRailState,
      }
    : !promptModelReady || !imageReady
      ? {
          label: '链路状态',
          value: '需复查',
          state: 'warn' as RuntimeRailState,
        }
      : queueBusy
        ? {
            label: '提交方式',
            value: '单任务串行',
            state: 'pending' as RuntimeRailState,
          }
        : textureMode === 'hunyuan' && lowMemoryHost
          ? {
              label: '贴图策略',
              value: '低内存 fallback',
              state: 'pending' as RuntimeRailState,
            }
          : {
              label: '运行方式',
              value: '可直接生成',
              state: 'ok' as RuntimeRailState,
            };
  const state: RuntimeRailState = input.loading || waitingSelfhostStatus
    ? 'pending'
    : !promptModelReady || !imageReady || !modelReady
      ? 'warn'
      : queueBusy || (textureMode === 'hunyuan' && lowMemoryHost)
        ? 'pending'
        : 'ok';

  return {
    state,
    title: input.loading
      ? '正在同步完整链路'
      : waitingSelfhostStatus
        ? '等待远端资源读数'
      : !promptModelReady || !imageReady
        ? '文生图链路需复查'
      : !modelReady
        ? '图生 3D 服务需复查'
      : queueBusy
        ? '图生 3D 队列保护中'
      : textureMode === 'hunyuan' && lowMemoryHost
        ? '链路可运行，贴图低内存保护'
      : textureMode === 'hunyuan'
        ? '文生图到彩色 3D 可试跑'
      : '文生图到图生 3D 可运行',
    detail: input.loading
      ? '正在读取本地图片网关、模型路由和自部署 3D 队列。'
      : waitingSelfhostStatus
        ? `正在只读同步本地图片网关与 3D 队列，不会提交重任务；同步完成后再进入 ${textureMode === 'hunyuan' ? '贴图保护' : '稳定几何'}。`
      : `${promptModel} -> ${imageModel} -> ${input.modelProvider === 'selfhost-triposg' ? 'TripoSG/Bio3D' : modelProviderLabel(input.modelProvider)} -> ${
          textureMode === 'hunyuan'
            ? lowMemoryHost
              ? '混元低内存试跑 + 彩色 fallback'
              : '混元贴图'
            : '稳定几何'
        }。`,
    steps: [
      {
        id: 'prompt',
        label: '提示词',
        value: input.loading ? '同步中' : promptModel,
        note: promptModelReady ? '模型可用' : '模型列表未匹配',
        state: input.loading ? 'pending' : promptModelReady ? 'ok' : 'warn',
      },
      {
        id: 'image',
        label: '参考图',
        value: input.loading ? '同步中' : imageModel,
        note: route?.cached
          ? `近期成功缓存：${imageRouteLabel}；本次 models 检查超时，但不会阻断参考图生成。`
          : route?.matchedModels?.length ? `已匹配 ${route.matchedModels.length} 个图片模型` : route?.message || '等待路由同步',
        state: input.loading ? 'pending' : imageReady ? 'ok' : 'warn',
      },
      {
        id: 'model',
        label: '图生3D',
        value: input.modelProvider === 'selfhost-triposg'
          ? queueBusy
            ? `队列 ${localQueueRunning + remoteQueueRunning}/${localQueuePending + remoteQueuePending}`
            : modelReady
              ? '在线'
              : statusChecked
                ? '需检查'
                : '待同步'
          : modelProviderLabel(input.modelProvider),
        note: input.modelProvider === 'selfhost-triposg'
          ? `保护上限 ${runtime?.maxPending ?? guard?.maxLocalPending ?? 1} 个重任务`
          : '轻量 provider',
        state: input.loading
          ? 'pending'
          : input.modelProvider !== 'selfhost-triposg'
            ? 'idle'
            : !statusChecked
              ? 'pending'
            : queueBusy
              ? 'pending'
            : modelReady
              ? 'ok'
              : 'warn',
      },
      {
        id: 'texture',
        label: '贴图兜底',
        value: textureMode === 'hunyuan'
          ? textureSubmitReady
            ? lowMemoryHost ? '低内存试跑' : '混元可试跑'
            : fallbackReady ? '彩色 fallback' : '稳定几何'
          : fallbackReady ? '按需增强' : '几何优先',
        note: lowMemoryHost
          ? `总内存 ${formatGiB(ramTotalGiB)}，不足则不压测`
          : textureMode === 'hunyuan'
            ? `RAM ${formatGiB(ramFreeGiB)} / VRAM ${formatGiB(vramFreeGiB)}`
            : '不强制贴图，先稳住几何',
        state: input.loading
          ? 'pending'
          : textureMode === 'hunyuan'
            ? textureSubmitReady && !lowMemoryHost
              ? 'ok'
              : fallbackReady
                ? 'pending'
              : 'warn'
            : 'ok',
      },
    ],
    badge,
  };
}

function isImageReady(status: ProviderStatusPayload | null, provider: string) {
  if (!status) return false;
  if (provider === 'openai') {
    const openai = status.image.openai;
    const gatewayReady = isLocalGatewayReady(status);
    const authReady = openai?.auth ? openai.auth.ok : true;
    return Boolean(openai?.configured && authReady) || gatewayReady;
  }

  return isLocalGatewayReady(status);
}

function hasModelId(modelIds: string[], model: string) {
  const normalized = model.trim().toLowerCase();
  return modelIds.some((id) => id.trim().toLowerCase() === normalized);
}

function describeTextureFallbackReason(reason: string) {
  if (/运行硬熔断|运行熔断|runtime guard|低于\s*\d|OOM/i.test(reason)) {
    return 'Hunyuan3D-Paint 运行中触发 RAM/VRAM 硬熔断，后端已中断远端贴图并把参考图嵌入轻量彩色 fallback，避免 OOM。';
  }
  if (/20G|20GB|低内存|总内存|默认不提交|资源保护|ram-low|vram-low/i.test(reason)) {
    return '20GB 低内存资源保护已生效：不强压远端混元贴图，改为稳定 GLB + 参考图轻量彩色 fallback。';
  }
  if (/timeout|超时|未返回|history|unobservable/i.test(reason)) {
    return '混元贴图在本轮没有稳定返回 textured.glb，系统已保留稳定 GLB 并写入轻量彩色 fallback。';
  }
  return '混元贴图未产出可靠 textured.glb，系统已用稳定 GLB 和参考图生成轻量彩色 fallback，避免回到白模。';
}

function isLocalGatewayReady(status: ProviderStatusPayload | null) {
  const gateway = status?.image.localGateway;
  const healthReady = gateway?.health ? gateway.health.ok : true;
  const modelsReady = gateway?.models ? gateway.models.ok : true;
  const modelsRecoverable = gateway?.models?.status === 504 || /超时|timeout/i.test(gateway?.models?.message || '');
  const imageRouteReady = !gateway?.imageRoute || gateway.imageRoute.ok === null || gateway.imageRoute.ok !== false;
  return Boolean(gateway?.configured && healthReady && (modelsReady || modelsRecoverable) && imageRouteReady);
}

function modelProviderLabel(provider: string) {
  if (provider === 'local-demo') return '缓存';
  if (provider === 'tencent-hunyuan') return '腾讯混元';
  return '3D 服务';
}

function percent(free?: number, total?: number) {
  if (!free || !total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((free / total) * 100)));
}

function bytesToGiB(bytes?: number) {
  if (!bytes || bytes <= 0) return Number.NaN;
  return bytes / 1024 / 1024 / 1024;
}

function formatGiB(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) return '--';
  return `${value.toFixed(value >= 10 ? 0 : 1)}GB`;
}

function formatBytes(value?: number) {
  if (!value || !Number.isFinite(value) || value <= 0) return '缓存 GLB';
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
