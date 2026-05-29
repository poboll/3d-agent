export type AnalyticsEventName =
  | 'workflow_prompt_focus'
  | 'workflow_reference_generate_start'
  | 'workflow_reference_generate'
  | 'workflow_reference_generate_failed'
  | 'workflow_reference_upload_start'
  | 'workflow_reference_upload'
  | 'workflow_reference_upload_failed'
  | 'workflow_reference_accept'
  | 'workflow_reference_reject'
  | 'workflow_model_confirm'
  | 'workflow_full_run_start'
  | 'workflow_full_reference_ready'
  | 'workflow_job_prompt_reuse'
  | 'workflow_job_created'
  | 'workflow_job_completed'
  | 'workflow_job_failed'
  | 'local_model_upload_start'
  | 'local_model_upload_completed'
  | 'local_model_upload_failed'
  | 'specimen_select'
  | 'guide_open'
  | 'guide_step';

interface AnalyticsEvent {
  name: AnalyticsEventName;
  payload: Record<string, unknown>;
  createdAt: string;
}

const EVENT_BUFFER_KEY = 'ma-cell-analytics-events';
const MAX_BUFFERED_EVENTS = 80;

export function trackEvent(name: AnalyticsEventName, payload: Record<string, unknown> = {}) {
  const event: AnalyticsEvent = {
    name,
    payload: {
      route: window.location.hash || '#workbench',
      ...payload,
    },
    createdAt: new Date().toISOString(),
  };

  try {
    const current = readBufferedEvents();
    const next = [event, ...current].slice(0, MAX_BUFFERED_EVENTS);
    window.localStorage.setItem(EVENT_BUFFER_KEY, JSON.stringify(next));
  } catch {
    // Analytics must never block classroom interaction.
  }

  if (import.meta.env.DEV) {
    console.info('[ma-analytics]', event);
  }

  void sendEvent(event);
}

export function readBufferedEvents(): AnalyticsEvent[] {
  try {
    const raw = window.localStorage.getItem(EVENT_BUFFER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AnalyticsEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sendEvent(event: AnalyticsEvent) {
  const endpoint = `${(import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8791').replace(/\/$/, '')}/api/analytics/events`;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    });
  } catch {
    // Local buffering above keeps events available when the API is offline.
  }
}
