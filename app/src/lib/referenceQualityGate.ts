export type ReferenceQualityState = 'ok' | 'ready' | 'warn';

export interface ReferenceQualityInput {
  uploaded?: boolean;
  source?: string;
  imageSize?: string;
  imageQuality?: string;
  imagePrompt?: string;
  model?: string;
  promptModel?: string;
}

export interface ReferenceQualityCheck {
  id: string;
  label: string;
  value: string;
  state: ReferenceQualityState;
}

export interface ReferenceQualityGate {
  state: ReferenceQualityState;
  title: string;
  summary: string;
  checks: ReferenceQualityCheck[];
}

const MIN_STABLE_REFERENCE_SIZE = 1536;

export function buildReferenceQualityGate(reference: ReferenceQualityInput): ReferenceQualityGate {
  const checks = [
    buildSourceCheck(reference),
    buildSpecCheck(reference),
    buildCompositionCheck(reference),
    buildNegativePromptCheck(reference),
  ];
  const state = checks.some((check) => check.state === 'warn')
    ? 'warn'
    : checks.some((check) => check.state === 'ready')
      ? 'ready'
      : 'ok';

  return {
    state,
    title: state === 'ok'
      ? '3D-ready 通过'
      : state === 'ready'
        ? '人工复核'
        : '建议重试',
    summary: buildSummary(state, checks),
    checks,
  };
}

function buildSourceCheck(reference: ReferenceQualityInput): ReferenceQualityCheck {
  if (reference.uploaded) {
    return createCheck('source', '来源', '上传图', 'ready');
  }

  const text = `${reference.source || ''} ${reference.model || ''} ${reference.promptModel || ''}`.toLowerCase();
  const localGateway = /本地|local|gateway|gpt-image/.test(text);
  return createCheck(
    'source',
    '来源',
    reference.model || reference.source || '参考图',
    localGateway ? 'ok' : 'ready'
  );
}

function buildSpecCheck(reference: ReferenceQualityInput): ReferenceQualityCheck {
  const size = parseImageSize(reference.imageSize);
  const quality = String(reference.imageQuality || '').toLowerCase();
  if (!size) return createCheck('spec', '规格', '待确认', 'ready');

  const minSide = Math.min(size.width, size.height);
  const label = `${size.width}x${size.height}${quality ? ` ${quality}` : ''}`;
  if (minSide >= MIN_STABLE_REFERENCE_SIZE && quality !== 'low') {
    return createCheck('spec', '规格', label, 'ok');
  }
  if (minSide >= 1024) return createCheck('spec', '规格', label, 'ready');
  return createCheck('spec', '规格', label, 'warn');
}

function buildCompositionCheck(reference: ReferenceQualityInput): ReferenceQualityCheck {
  const prompt = normalize(reference.imagePrompt);
  if (!prompt) return createCheck('composition', '构图', reference.uploaded ? '人工检查' : '待确认', 'ready');

  const hasSingleSubject = /(single|centered|one|单主体|居中)/.test(prompt);
  const hasCleanBackground = /(white|light gray|clean background|plain background|白底|浅灰)/.test(prompt);
  const hasCutaway = /(cutaway|open|three-quarter|剖面|开放|开窗)/.test(prompt);
  if (hasSingleSubject && hasCleanBackground && hasCutaway) {
    return createCheck('composition', '构图', '单主体剖面', 'ok');
  }
  if ((hasSingleSubject && hasCleanBackground) || hasCutaway) {
    return createCheck('composition', '构图', '可复核', 'ready');
  }
  return createCheck('composition', '构图', '需重试', 'warn');
}

function buildNegativePromptCheck(reference: ReferenceQualityInput): ReferenceQualityCheck {
  const prompt = normalize(reference.imagePrompt);
  if (!prompt) return createCheck('negative', '约束', reference.uploaded ? '人工检查' : '待确认', 'ready');

  const hasNoText = /(avoid|no|without|不要|避免).{0,80}(label|text|arrow|ui|文字|标签|箭头)/.test(prompt);
  const hasNoTransparency = /(avoid|no|without|不要|避免).{0,100}(transparent|glass|jelly|glossy|透明|玻璃|果冻|高光)/.test(prompt);
  const hasNoMultiView = /(avoid|no|without|不要|避免).{0,100}(multi-view|collage|grid|panel|多视图|拼贴|网格)/.test(prompt);
  if (hasNoText && hasNoTransparency && hasNoMultiView) {
    return createCheck('negative', '约束', '避开干扰', 'ok');
  }
  if (hasNoText || hasNoTransparency || hasNoMultiView) {
    return createCheck('negative', '约束', '部分约束', 'ready');
  }
  return createCheck('negative', '约束', '需补充', 'warn');
}

function buildSummary(state: ReferenceQualityState, checks: ReferenceQualityCheck[]) {
  if (state === 'ok') return '单主体、白底、剖面与负向约束齐全，可稳定进入图生 3D。';
  const warn = checks.find((check) => check.state === 'warn');
  if (warn) return `${warn.label}需要复查；建议重试图片或确认提示词后再建模。`;
  return '参考图可继续使用，但上传图或缺少提示词证据时建议人工确认主体、白底与剖面。';
}

function createCheck(id: string, label: string, value: string, state: ReferenceQualityState): ReferenceQualityCheck {
  return { id, label, value, state };
}

function normalize(value?: string) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseImageSize(value?: string) {
  const match = String(value || '').match(/(\d{3,5})\s*x\s*(\d{3,5})/i);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}
