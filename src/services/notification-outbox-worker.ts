/**
 * Worker del outbox de notificaciones (ítem 23).
 *
 * Es independiente del outbox de Chatwoot a propósito: una caída de Telegram no
 * puede repetir Hermes, ni el handoff, ni la nota privada, ni el mensaje al
 * paciente. Solo queda reintentable esta fila.
 */

import axios from 'axios';
import { config } from '../config.js';
import { logsRepository } from '../repositories/database.js';
import { notificationOutboxRepository } from '../repositories/handoff.js';
import { resolveHandoffRouting } from '../handoff/routing.js';
import { shortFingerprint } from '../durable/identity.js';

let running = false;
let interval: NodeJS.Timeout | null = null;

export const notificationMetrics = {
  sent: 0,
  failed: 0,
  blocked_unconfigured: 0,
  last_send_at: null as string | null,
  last_error_code: null as string | null
};

export class NotificationDeliveryError extends Error {
  constructor(
    readonly code: string,
    /** El canal no está configurado: no es un fallo de entrega y no gasta intentos. */
    readonly unconfigured = false,
    /** Un rechazo definitivo no se reintenta. */
    readonly permanent = false
  ) {
    super(code);
    this.name = 'NotificationDeliveryError';
  }
}

const PRIORITY_MARK: Record<string, string> = {
  urgent: '🔴 URGENTE',
  high: '🟠 Alta',
  normal: '🟡 Normal',
  low: '⚪ Baja'
};

/** Mensaje del aviso. Sin secretos y con la PII mínima: nombre de pila si está verificado. */
export function renderTelegramMessage(payload: Record<string, any>): string {
  const priority = PRIORITY_MARK[String(payload.priority)] || String(payload.priority ?? '');
  const who = payload.patient_first_name
    ? String(payload.patient_first_name)
    : (payload.identity_complete ? 'paciente sin nombre legible' : 'paciente sin identificar');

  return [
    payload.origin === 'technical_failure'
      ? '⚠️ Helios no pudo atender un mensaje'
      : '🔻 Helios ha derivado una conversación',
    '',
    `Clínica: ${payload.clinic_id ?? payload.tenant_id ?? '—'}`,
    `Paciente: ${who}`,
    `Motivo: ${payload.reason_label ?? payload.reason_code ?? '—'}`,
    `Prioridad: ${priority}`,
    `Va a: ${payload.destination_label ?? payload.destination ?? '—'}`,
    payload.summary ? `Contexto: ${payload.summary}` : null,
    payload.treatment_interest ? `Interés: ${payload.treatment_interest}` : null,
    '',
    `Abrir conversación: ${payload.conversation_url ?? '—'}`,
    `Caso: ${payload.handoff_id ?? '—'}`
  ].filter(line => line !== null).join('\n');
}

async function sendTelegram(row: any): Promise<string | null> {
  const token = config.TELEGRAM_BOT_TOKEN;
  if (!token) throw new NotificationDeliveryError('TELEGRAM_BOT_TOKEN_MISSING', true);

  // El destino se resuelve AQUÍ, no solo al crear la fila. Un aviso creado antes
  // de configurar el chat de Telegram tenía destino nulo de forma permanente, y
  // configurar la variable después no lo arreglaba nunca.
  let chatId = String(row.destination ?? '').trim();
  if (!chatId) {
    chatId = String(resolveHandoffRouting(String(row.tenant_id)).telegram_chat_id ?? '').trim();
    if (chatId) {
      await notificationOutboxRepository
        .setDestination(row.notification_key, chatId)
        .catch(() => undefined);
    }
  }
  if (!chatId) throw new NotificationDeliveryError('TELEGRAM_CHAT_ID_MISSING', true);

  try {
    const response = await axios.post(
      `${config.TELEGRAM_API_BASE_URL}/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: renderTelegramMessage(row.payload || {}),
        disable_web_page_preview: true
      },
      { timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    const messageId = response.data?.result?.message_id;
    return messageId === undefined || messageId === null ? null : String(messageId);
  } catch (error: any) {
    const status = Number(error?.response?.status || 0);
    // 400/403 son configuración incorrecta (chat inexistente, bot expulsado):
    // reintentarlos no sirve, pero deben quedar visibles.
    if (status === 400 || status === 403 || status === 404) {
      throw new NotificationDeliveryError(`TELEGRAM_REJECTED_${status}`, false, true);
    }
    if (status === 401) throw new NotificationDeliveryError('TELEGRAM_UNAUTHORIZED', true);
    throw new NotificationDeliveryError('TELEGRAM_UNAVAILABLE');
  }
}

async function deliver(row: any): Promise<void> {
  try {
    const providerMessageId = row.channel === 'telegram'
      ? await sendTelegram(row)
      : (() => { throw new NotificationDeliveryError('NOTIFICATION_CHANNEL_UNSUPPORTED', false, true); })();

    await notificationOutboxRepository.markSent(row, providerMessageId);
    notificationMetrics.sent += 1;
    notificationMetrics.last_send_at = new Date().toISOString();
    notificationMetrics.last_error_code = null;

    await logsRepository.save({
      trace_id: `notification-${shortFingerprint(row.notification_key)}`,
      tenant_id: row.tenant_id,
      conversation_id: row.conversation_id,
      contact_id: row.contact_id,
      event_type: 'HANDOFF_TEAM_ALERT_SENT',
      metadata: {
        handoff_id: row.handoff_id,
        channel: row.channel,
        attempt_count: row.attempt_count,
        provider_message_id: providerMessageId
      }
    });
  } catch (error: any) {
    const failure = error instanceof NotificationDeliveryError
      ? error
      : new NotificationDeliveryError('NOTIFICATION_WORKER_ERROR');
    notificationMetrics.last_error_code = failure.code;

    if (failure.unconfigured) {
      await notificationOutboxRepository.markBlocked(row, failure.code);
      notificationMetrics.blocked_unconfigured += 1;
      console.warn(JSON.stringify({
        event: 'notification_blocked_unconfigured',
        notification_fingerprint: shortFingerprint(row.notification_key),
        error_code: failure.code
      }));
      return;
    }

    const final = failure.permanent || row.attempt_count >= config.HELIOS_NOTIFICATION_MAX_ATTEMPTS;
    await notificationOutboxRepository.markRetry(row, failure.code, final);
    notificationMetrics.failed += 1;
    console.warn(JSON.stringify({
      event: 'notification_delivery_failed',
      notification_fingerprint: shortFingerprint(row.notification_key),
      error_code: failure.code,
      permanent: failure.permanent,
      final,
      attempt_count: row.attempt_count
    }));

    if (final) {
      // Un aviso que no llegará nunca tiene que ser visible: la nota privada en
      // Chatwoot sigue siendo el registro durable del handoff.
      await logsRepository.save({
        trace_id: `notification-${shortFingerprint(row.notification_key)}`,
        tenant_id: row.tenant_id,
        conversation_id: row.conversation_id,
        contact_id: row.contact_id,
        event_type: 'HANDOFF_TEAM_ALERT_FAILED_FINAL',
        metadata: {
          handoff_id: row.handoff_id,
          channel: row.channel,
          error_code: failure.code,
          attempt_count: row.attempt_count
        }
      }).catch(() => undefined);
    }
  }
}

export async function runNotificationTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Si el canal ya está configurado, se devuelven a la cola los avisos que
    // quedaron bloqueados por falta de configuración.
    if (config.TELEGRAM_BOT_TOKEN) {
      const released = await notificationOutboxRepository.releaseBlocked().catch(() => 0);
      if (released > 0) {
        notificationMetrics.blocked_unconfigured = Math.max(
          0,
          notificationMetrics.blocked_unconfigured - released
        );
        console.log(JSON.stringify({ event: 'notification_blocked_released', released }));
      }
    }

    const claimed = await notificationOutboxRepository.claim(10);
    for (const row of claimed) await deliver(row);
  } finally {
    running = false;
  }
}

export function startNotificationWorker() {
  if (process.env.NODE_ENV === 'test') return async () => {};
  const tick = () => {
    void runNotificationTick().catch(error => {
      notificationMetrics.last_error_code = error?.code || 'NOTIFICATION_WORKER_FAILED';
      console.error(JSON.stringify({
        event: 'notification_worker_failed',
        error_code: notificationMetrics.last_error_code
      }));
    });
  };
  tick();
  interval = setInterval(tick, Math.max(5000, config.HELIOS_NOTIFICATION_POLL_MS));
  return async () => {
    if (interval) clearInterval(interval);
    interval = null;
  };
}
