import axios from 'axios';
import { config } from '../config.js';
import { supabase } from '../supabase/client.js';
import {
  componentHealth,
  recordComponentError,
  recordComponentSuccess
} from './component-health.js';

export async function refreshDependencyHealth(): Promise<void> {
  const checks: Promise<void>[] = [];

  checks.push((async () => {
    const startedAt = Date.now();
    const result = await supabase.from('helios_tenants').select('tenant_id').limit(1);
    if (result.error) {
      recordComponentError('supabase', result.error.code || 'SUPABASE_READ_FAILED');
      return;
    }
    recordComponentSuccess('supabase', Date.now() - startedAt);
  })());

  if (config.HERMES_ENABLED && config.HERMES_BASE_URL) {
    checks.push((async () => {
      const startedAt = Date.now();
      try {
        const baseUrl = config.HERMES_BASE_URL.replace(/\/+$/, '');
        const response = await axios.get(`${baseUrl}/health`, {
          timeout: Math.min(config.HERMES_TIMEOUT_MS, 3000),
          validateStatus: () => true
        });
        if (response.status < 200 || response.status >= 300 || response.data?.ok !== true) {
          recordComponentError('adapter', `ADAPTER_HEALTH_HTTP_${response.status}`, 'UNAVAILABLE');
          return;
        }
        recordComponentSuccess('adapter', Date.now() - startedAt);
        const hermesState = response.data?.hermes_agent_api?.state;
        if (hermesState === 'HERMES_OK') {
          recordComponentSuccess(
            'hermes',
            response.data?.hermes_agent_api?.latency_ms
          );
        } else if (hermesState) {
          recordComponentError(
            'hermes',
            response.data?.hermes_agent_api?.error_code || hermesState,
            'UNAVAILABLE'
          );
        }
      } catch (error: any) {
        recordComponentError(
          'adapter',
          error?.code === 'ECONNABORTED' ? 'ADAPTER_HEALTH_TIMEOUT' : 'ADAPTER_HEALTH_NETWORK',
          'UNAVAILABLE'
        );
      }
    })());
  }

  await Promise.allSettled(checks);
}

export function healthSnapshot() {
  return componentHealth;
}
