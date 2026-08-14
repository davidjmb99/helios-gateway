/**
 * Worker del seguimiento de leads.
 *
 * Barre cada diez minutos buscando conversaciones que se quedaron a medias y ya
 * están maduras. El grueso de la decisión vive en src/leads, que es puro; aquí
 * solo está el reloj y la captura de errores.
 *
 * Un fallo de este worker no puede afectar a nada más: el seguimiento comercial
 * es lo menos importante que hace Helios, muy por detrás de contestarle a quien
 * está escribiendo ahora mismo.
 */

import { config } from '../config.js';
import { runLeadFollowupSweep, leadMetrics } from '../leads/service.js';

let interval: NodeJS.Timeout | null = null;

export function startLeadFollowupWorker() {
  if (process.env.NODE_ENV === 'test') return async () => {};
  const tick = () => {
    void runLeadFollowupSweep().catch(error => {
      leadMetrics.last_error_code = error?.code || 'LEAD_SWEEP_FAILED';
      console.error(JSON.stringify({
        event: 'lead_followup_sweep_failed',
        error_code: leadMetrics.last_error_code
      }));
    });
  };
  tick();
  interval = setInterval(tick, Math.max(60_000, config.HELIOS_LEADS_SWEEP_MS));
  return async () => {
    if (interval) clearInterval(interval);
    interval = null;
  };
}
