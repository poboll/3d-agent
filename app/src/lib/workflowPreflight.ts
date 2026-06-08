import type { ProviderStatusPayload } from '../services/fusionApi';

export type WorkflowPreflightState = 'ok' | 'pending' | 'warn';

export interface WorkflowPreflightCheck {
  id: string;
  label: string;
  value: string;
  state: WorkflowPreflightState;
  hint: string;
}

export interface WorkflowPreflight {
  state: WorkflowPreflightState;
  title: string;
  summary: string;
  recommendation: string;
  checks: WorkflowPreflightCheck[];
}

interface WorkflowPreflightInput {
  status: ProviderStatusPayload | null;
  loading: boolean;
  imageProvider: string;
  modelProvider: string;
  imageSpecLabel: string;
}

export function buildWorkflowPreflight(input: WorkflowPreflightInput): WorkflowPreflight {
  if (input.loading) {
    return {
      state: 'pending',
      title: '正在同步链路状态',
      summary: '正在检查 48760 图片网关、图片模型与 3D 队列。',
      recommendation: '状态同步期间可以继续编辑描述；正式生成前建议等待预检完成。',
      checks: [
        createCheck('image', '图片网关', '检查中', 'pending', '正在请求本地图片网关 health/models。'),
        createCheck('model', '3D 队列', '同步中', 'pending', '正在读取 TripoSG + Hunyuan3D-Paint 服务状态。'),
      ],
    };
  }

  const status = input.status;
  const imageCheck = buildImageCheck(status, input.imageProvider);
  const promptCheck = buildPromptCheck(status, input.imageProvider);
  const specCheck = createCheck('spec', '图片规格', input.imageSpecLabel, 'ok', '该规格会随生成请求传入参考图服务。');
  const modelCheck = buildModelCheck(status, input.modelProvider);
  const routeCheck = buildRouteCheck(input.imageProvider, input.modelProvider, imageCheck.state, modelCheck.state);
  const checks = [imageCheck, promptCheck, specCheck, modelCheck, routeCheck];
  const state = checks.some((check) => check.state === 'warn')
    ? 'warn'
    : checks.some((check) => check.state === 'pending')
      ? 'pending'
      : 'ok';

  return {
    state,
    title: state === 'ok' ? '链路预检通过' : state === 'pending' ? '链路仍在同步' : '链路需要复查',
    summary: buildPreflightSummary(checks),
    recommendation: buildPreflightRecommendation(state, input.imageProvider, input.modelProvider),
    checks,
  };
}

function buildImageCheck(status: ProviderStatusPayload | null, provider: string): WorkflowPreflightCheck {
  if (!status) return createCheck('image', '图片网关', '未同步', 'pending', '等待后端返回 provider 状态。');

  const gateway = status.image.localGateway;
  const gatewayReady = isLocalGatewayReady(status);

  if (provider === 'openai') {
    const openai = status.image.openai;
    const ready = Boolean(openai?.configured && (openai.auth ? openai.auth.ok : true));
    return createCheck(
      'image',
      '图片服务',
      ready
        ? openai?.imageToolModel || openai?.imageModel || 'OpenAI'
        : gatewayReady
          ? '备用异常'
          : `直连异常 ${openai?.auth?.status || ''}`.trim(),
      ready || gatewayReady ? 'ok' : 'warn',
      ready
        ? 'OpenAI 图片服务可用。'
        : gatewayReady
          ? 'OpenAI 直连不可用，但 48760 本地图片网关可作为主链路继续生成。'
          : openai?.auth?.message || 'OpenAI 直连不可用，建议切回本地图片网关。'
    );
  }

  return createCheck(
    'image',
    '图片网关',
    gatewayReady ? `${gateway?.imageModel || 'gpt-image-2'} · 48760` : '需检查',
    gatewayReady ? 'ok' : 'warn',
    gatewayReady
      ? buildLocalGatewayHint(gateway)
      : '请检查 48760 服务、API Key 或模型列表。'
  );
}

function buildPromptCheck(status: ProviderStatusPayload | null, provider: string): WorkflowPreflightCheck {
  if (!status) return createCheck('prompt', 'Prompt 模型', '未同步', 'pending', '等待 provider 状态。');
  const promptModel = provider === 'local-gateway'
    ? status.image.localGateway?.promptModel || 'gpt-5.5'
    : status.image.openai?.imageModel || 'gpt-5.5';
  return createCheck('prompt', 'Prompt 模型', promptModel, 'ok', '用于将术语打磨成 3D-ready 单图提示词。');
}

function buildModelCheck(status: ProviderStatusPayload | null, provider: string): WorkflowPreflightCheck {
  if (provider === 'local-demo') {
    return createCheck('model', '3D 队列', '本地缓存', 'ok', '本地缓存链路适合快速验证 UI、任务记录和 GLB 展示。');
  }
  if (provider === 'tencent-hunyuan') {
    const configured = Boolean(status?.model3d.tencentHunyuan?.configured);
    return createCheck('model', '3D 队列', configured ? '腾讯混元' : '未配置', configured ? 'ok' : 'warn', configured ? '腾讯混元 provider 已配置。' : '当前未配置腾讯混元密钥，建议使用自部署链路。');
  }

  const selfhost = status?.model3d.selfhostTriposg;
  const queue = selfhost?.status?.queue;
  const ready = Boolean(selfhost?.configured && selfhost.status?.ok !== false);
  const queueLabel = queue ? `${queue.running ?? 0}/${queue.pending ?? 0}` : '待同步';
  return createCheck(
    'model',
    '3D 队列',
    ready ? queueLabel : '需检查',
    ready ? 'ok' : 'warn',
    ready ? `${selfhost?.baseUrl || 'ComfyUI'} 队列 running/pending = ${queueLabel}。` : '请检查自部署 TripoSG + Hunyuan3D-Paint 服务。'
  );
}

function buildRouteCheck(imageProvider: string, modelProvider: string, imageState: WorkflowPreflightState, modelState: WorkflowPreflightState) {
  const ready = imageState === 'ok' && modelState === 'ok';
  const image = imageProvider === 'local-gateway' ? '本地网关' : 'OpenAI';
  const model = modelProvider === 'selfhost-triposg' ? '自部署 3D' : modelProvider === 'local-demo' ? '缓存验证' : '腾讯混元';
  return createCheck('route', '默认路线', `${image} -> ${model}`, ready ? 'ok' : 'warn', ready ? '可执行术语 -> 单图 -> 3D 展示。' : '路线中仍有节点需要复查。');
}

function buildPreflightSummary(checks: WorkflowPreflightCheck[]) {
  const ok = checks.filter((check) => check.state === 'ok').length;
  const warn = checks.filter((check) => check.state === 'warn').length;
  const pending = checks.filter((check) => check.state === 'pending').length;
  if (warn) return `${ok} 项可用，${warn} 项需检查，${pending} 项同步中。`;
  if (pending) return `${ok} 项可用，${pending} 项同步中。`;
  return '图片网关、Prompt、规格与 3D 队列均可用。';
}

function buildPreflightRecommendation(state: WorkflowPreflightState, imageProvider: string, modelProvider: string) {
  if (state === 'ok') {
    if (modelProvider === 'local-demo') return '可以先用缓存链路快速验证，再切回自部署 3D 跑正式模型。';
    if (imageProvider === 'openai') return '当前可生成；若直连 OpenAI 不稳定，建议切回 48760 本地图片网关作为主链路。';
    return '可以点击“生成参考图”走可控确认，也可以点击“完整生成”直接跑默认链路。';
  }
  if (state === 'pending') return '等待预检完成后再提交正式任务，避免长任务中途失败。';
  if (imageProvider === 'openai') return 'OpenAI 直连异常时，建议切回 48760 本地图片网关。';
  return '优先检查图片网关 API Key、48760 服务以及自部署 3D 队列状态。';
}

function createCheck(id: string, label: string, value: string, state: WorkflowPreflightState, hint: string): WorkflowPreflightCheck {
  return { id, label, value, state, hint };
}

function isLocalGatewayReady(status: ProviderStatusPayload | null) {
  const gateway = status?.image.localGateway;
  const healthReady = gateway?.health ? gateway.health.ok : true;
  return Boolean(gateway?.configured && healthReady);
}

function buildLocalGatewayHint(gateway: ProviderStatusPayload['image']['localGateway']) {
  const baseUrl = gateway?.baseUrl || 'http://127.0.0.1:48760';
  if (!gateway?.models) return `${baseUrl} 已通过 health，模型列表等待同步。`;
  if (gateway.models.ok) return `${baseUrl} 已通过 health/models。`;
  return `${baseUrl} health 可用，models 暂未返回；生成接口仍按配置模型发起。`;
}
