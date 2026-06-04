import type { CellModel } from '../data/models';
import { getModelTemplate } from '../data/models';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8791';

interface DemoModelPayload {
  id: string;
  name: string;
  subtitle: string;
  category: string;
  accent: string;
  description: string;
  fileSize: number;
  imageHint?: string;
  modelUrl: string;
  provider: string;
  missing?: boolean;
  template?: string;
  referenceImageUrl?: string;
  rawModelUrl?: string;
  texturedModelUrl?: string;
}

interface LocalModelPayload {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  provider: string;
  modelUrl: string;
}

export interface ReferenceImagePayload {
  id: string;
  prompt: string;
  template: string;
  provider: string;
  source: string;
  title: string;
  note: string;
  fileName: string;
  fileSize: number;
  model: string;
  promptModel?: string;
  generationMode?: string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
  imagePrompt?: string;
  negativePrompt?: string;
  imageUrl: string;
  createdAt: string;
}

export type WorkflowStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface WorkflowJob {
  id: string;
  prompt: string;
  provider: string;
  template: string;
  imageProvider?: string;
  referenceId?: string;
  referenceImageUrl?: string;
  reference?: ReferenceImagePayload | null;
  workflowMode?: 'image-to-3d' | 'full-text-to-3d' | string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
  providerJobId?: string;
  status: WorkflowStatus;
  stage: string;
  progress: number;
  costEstimateCny: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: DemoModelPayload;
}

export interface WorkflowDiagnosticsPayload {
  promptId: string;
  shortPromptId: string;
  baseUrl: string;
  queue: {
    ok: boolean;
    running: number;
    pending: number;
    containsPrompt: boolean;
    message: string;
  };
  history: {
    ok: boolean;
    found: boolean;
    status: string;
    message: string;
  };
  outputs: {
    glbCount: number;
    final?: boolean;
    textured: boolean;
    raw: boolean;
    candidates: Array<{
      fileName?: string;
      label?: string;
      type?: string;
      subfolder?: string;
    }>;
  };
  recommendation: string;
  checkedAt: string;
}

export interface PromptPreviewPayload {
  template: string;
  sourcePrompt: string;
  provider?: string;
  model: string;
  imagePrompt: string;
  negativePrompt: string;
  qualityChecklist: string[];
}

export interface ProviderStatusPayload {
  image: {
    localGateway?: {
      configured: boolean;
      baseUrl: string;
      promptModel?: string;
      imageModel?: string;
      imageSize?: string;
      imageQuality?: string;
      timeoutMs?: number;
      health?: {
        ok: boolean;
        status: number;
        message: string;
      };
      models?: {
        ok: boolean;
        status: number;
        message: string;
        modelIds?: string[];
      };
    };
    openai?: {
      configured: boolean;
      baseUrl: string;
      imageModel?: string;
      imageToolModel?: string;
      imageSize?: string;
      imageQuality?: string;
      auth?: {
        ok: boolean;
        status: number;
        message: string;
      };
    };
  };
  model3d: {
    selfhostTriposg?: {
      configured: boolean;
      baseUrl: string;
      status?: {
        ok?: boolean;
        queue?: {
          running?: number;
          pending?: number;
        };
      };
    };
    localCache?: {
      configured: boolean;
    };
    tencentHunyuan?: {
      configured: boolean;
    };
  };
}

export function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function fetchDemoGeneratedModels(): Promise<CellModel[]> {
  const response = await fetch(apiUrl('/api/3d/demo-models'));
  const payload = await readApiResponse<{ models: DemoModelPayload[] }>(response);
  return payload.models.filter((item) => !item.missing && item.modelUrl).map(toCellModel);
}

export async function uploadLocalModel(file: File): Promise<CellModel> {
  const response = await fetch(apiUrl(`/api/3d/local-model?fileName=${encodeURIComponent(file.name)}`), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'model/gltf-binary',
    },
    body: file,
  });
  const payload = await readApiResponse<LocalModelPayload>(response);
  return toCellModel({
    id: payload.id,
    name: payload.name,
    subtitle: '本地导入模型',
    category: '用户导入 3D 模型',
    accent: '#5b8db8',
    description: `从本地文件 ${payload.fileName} 导入的 GLB/GLTF 模型，用于验证生成模型进入 LearningCell 交互展示流程。`,
    fileSize: payload.fileSize,
    modelUrl: payload.modelUrl,
    provider: payload.provider,
    imageHint: 'dna',
    template: 'dna',
  });
}

export async function createReferenceImage(input: {
  prompt: string;
  provider?: string;
  template?: string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
}): Promise<ReferenceImagePayload> {
  const response = await fetch(apiUrl('/api/references/text-to-image'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await readApiResponse<{ reference: ReferenceImagePayload }>(response);
  return {
    ...payload.reference,
    imageUrl: apiUrl(payload.reference.imageUrl),
  };
}

export async function previewReferencePrompt(input: {
  prompt: string;
  template?: string;
  provider?: string;
}): Promise<PromptPreviewPayload> {
  const response = await fetch(apiUrl('/api/references/prompt-preview'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await readApiResponse<{ prompt: PromptPreviewPayload }>(response);
  return payload.prompt;
}

export async function uploadReferenceImage(file: File, input: {
  prompt: string;
  template?: string;
}): Promise<ReferenceImagePayload> {
  const query = new URLSearchParams({
    fileName: file.name,
    prompt: input.prompt,
    template: input.template || 'auto',
  });
  const response = await fetch(apiUrl(`/api/references/upload?${query.toString()}`), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'image/png',
    },
    body: file,
  });
  const payload = await readApiResponse<{ reference: ReferenceImagePayload }>(response);
  return {
    ...payload.reference,
    imageUrl: apiUrl(payload.reference.imageUrl),
  };
}

export async function createTextToCellJob(input: {
  prompt: string;
  provider?: string;
  template?: string;
  imageProvider?: string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
  referenceId?: string;
}): Promise<WorkflowJob> {
  const response = await fetch(apiUrl('/api/workflows/text-to-cell'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await readApiResponse<{ job: WorkflowJob }>(response);
  return normalizeWorkflowJob(payload.job);
}

export async function createFullTextTo3dJob(input: {
  prompt: string;
  provider?: string;
  template?: string;
  imageProvider?: string;
  imageProfile?: string;
  imageSize?: string;
  imageQuality?: string;
}): Promise<{ reference: ReferenceImagePayload | null; job: WorkflowJob }> {
  const response = await fetch(apiUrl('/api/workflows/full-text-to-3d'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const payload = await readApiResponse<{ reference: ReferenceImagePayload | null; job: WorkflowJob }>(response);
  return {
    ...payload,
    reference: payload.reference ? {
      ...payload.reference,
      imageUrl: apiUrl(payload.reference.imageUrl),
    } : null,
    job: normalizeWorkflowJob(payload.job),
  };
}

export async function fetchWorkflowJob(jobId: string): Promise<WorkflowJob> {
  const response = await fetch(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}`));
  const payload = await readApiResponse<{ job: WorkflowJob }>(response);
  return normalizeWorkflowJob(payload.job);
}

export async function resumeWorkflowJob(jobId: string): Promise<WorkflowJob> {
  const response = await fetch(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}/resume`), {
    method: 'POST',
  });
  const payload = await readApiResponse<{ job: WorkflowJob }>(response);
  return normalizeWorkflowJob(payload.job);
}

export async function fetchWorkflowDiagnostics(jobId: string): Promise<WorkflowDiagnosticsPayload> {
  const response = await fetch(apiUrl(`/api/jobs/${encodeURIComponent(jobId)}/diagnostics`));
  const payload = await readApiResponse<{ diagnostics: WorkflowDiagnosticsPayload }>(response);
  return payload.diagnostics;
}

export async function fetchWorkflowJobs(limit = 12): Promise<WorkflowJob[]> {
  const response = await fetch(apiUrl(`/api/jobs?limit=${limit}`));
  const payload = await readApiResponse<{ jobs: WorkflowJob[] }>(response);
  return payload.jobs.map(normalizeWorkflowJob);
}

export async function fetchProviderStatus(check = false): Promise<ProviderStatusPayload> {
  const response = await fetch(apiUrl(`/api/providers/status${check ? '?check=1' : ''}`));
  return readApiResponse<ProviderStatusPayload>(response);
}

export function workflowJobToCellModel(job: WorkflowJob): CellModel | null {
  if (job.status !== 'completed' || !job.result?.modelUrl) return null;
  return toCellModel(job.result);
}

async function readApiResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload as T;
}

function toCellModel(item: DemoModelPayload): CellModel {
  const template = getModelTemplate(item.template || item.imageHint);
  const source = item.provider || 'Generated';
  const imageUrl = item.referenceImageUrl ? apiUrl(item.referenceImageUrl) : template.imageUrl;

  return {
    ...template,
    id: item.id,
    name: item.name,
    subtitle: item.subtitle,
    category: item.category,
    accent: item.accent || template.accent,
    description: item.description || template.description,
    modelUrl: apiUrl(item.modelUrl),
    imageUrl,
    fileSize: item.fileSize || template.fileSize,
    defaultRotationY: template.defaultRotationY,
    displayScale: template.displayScale,
    templateId: item.template || item.imageHint || template.id,
    custom: true,
    source,
    generationStatus: `${source} · 已缓存`,
    funFact: template.funFact,
    whereItOccurs: template.whereItOccurs,
    concepts: template.concepts,
  };
}

function normalizeWorkflowJob(job: WorkflowJob): WorkflowJob {
  return {
    ...job,
    reference: job.reference
      ? {
          ...job.reference,
          imageUrl: apiUrl(job.reference.imageUrl),
        }
      : job.reference,
    referenceImageUrl: job.referenceImageUrl ? apiUrl(job.referenceImageUrl) : job.referenceImageUrl,
    result: job.result
      ? {
          ...job.result,
          modelUrl: apiUrl(job.result.modelUrl),
          referenceImageUrl: job.result.referenceImageUrl ? apiUrl(job.result.referenceImageUrl) : job.result.referenceImageUrl,
          rawModelUrl: job.result.rawModelUrl ? apiUrl(job.result.rawModelUrl) : job.result.rawModelUrl,
          texturedModelUrl: job.result.texturedModelUrl ? apiUrl(job.result.texturedModelUrl) : job.result.texturedModelUrl,
        }
      : job.result,
  };
}
