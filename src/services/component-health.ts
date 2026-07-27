export type ComponentState =
  | 'UNKNOWN'
  | 'OK'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'DELIVERY_UNKNOWN';

interface ComponentHealth {
  state: ComponentState;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  latency_ms: number | null;
}

function initial(): ComponentHealth {
  return {
    state: 'UNKNOWN',
    last_success_at: null,
    last_error_at: null,
    last_error_code: null,
    latency_ms: null
  };
}

export const componentHealth = {
  hermes: initial(),
  adapter: initial(),
  supabase: initial(),
  chatwoot: initial()
};

export function recordComponentSuccess(
  component: keyof typeof componentHealth,
  latencyMs?: number
) {
  const target = componentHealth[component];
  target.state = 'OK';
  target.last_success_at = new Date().toISOString();
  target.last_error_code = null;
  target.latency_ms = Number.isFinite(latencyMs) ? Number(latencyMs) : target.latency_ms;
}

export function recordComponentError(
  component: keyof typeof componentHealth,
  errorCode: string,
  state: ComponentState = 'DEGRADED'
) {
  const target = componentHealth[component];
  target.state = state;
  target.last_error_at = new Date().toISOString();
  target.last_error_code = errorCode;
}

