import axios from 'axios';
import { config } from '../config.js';

export class ChatwootDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly ambiguous: boolean,
    readonly httpStatus = 0
  ) {
    super(code);
    this.name = 'ChatwootDeliveryError';
  }
}

export class ChatwootClient {
  private baseUrl(accountId?: string) {
    const resolved = String(accountId || config.CHATWOOT_ACCOUNT_ID || '').trim();
    if (!resolved) throw new ChatwootDeliveryError('CHATWOOT_ACCOUNT_MISSING', false);
    return `${config.CHATWOOT_BASE_URL}/api/v1/accounts/${resolved}`;
  }

  private get headers() {
    return {
      api_access_token: config.CHATWOOT_API_TOKEN,
      'Content-Type': 'application/json'
    };
  }

  private isConfigured(accountId?: string): boolean {
    return Boolean((accountId || config.CHATWOOT_ACCOUNT_ID) && config.CHATWOOT_API_TOKEN);
  }

  public async sendMessage(
    accountId: string,
    conversationId: string,
    content: string,
    contentAttributes: Record<string, string> = {}
  ): Promise<{ data: any; status: number }> {
    if (!this.isConfigured(accountId)) {
      console.log('[Chatwoot Client MOCK] Outbox delivery simulated.');
      return { data: { id: `mock-${Date.now()}` }, status: 200 };
    }

    try {
      const response = await axios.post(
        `${this.baseUrl(accountId)}/conversations/${conversationId}/messages`,
        { content, message_type: 'outgoing', content_attributes: contentAttributes },
        {
          headers: this.headers,
          timeout: config.CHATWOOT_TIMEOUT_MS,
          validateStatus: status => status >= 200 && status < 300
        }
      );
      return { data: response.data, status: response.status };
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      const code = String(error?.code || '');
      const ambiguous = !error?.response && (
        code === 'ECONNABORTED' ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        String(error?.message || '').toLowerCase().includes('timeout')
      );
      if (ambiguous) throw new ChatwootDeliveryError('CHATWOOT_DELIVERY_UNKNOWN', true, status);
      if (status === 429) throw new ChatwootDeliveryError('CHATWOOT_RATE_LIMIT', false, status);
      if (status >= 500 || !status) throw new ChatwootDeliveryError('CHATWOOT_UNAVAILABLE', false, status);
      throw new ChatwootDeliveryError('CHATWOOT_REJECTED', false, status);
    }
  }

  public async findMessageByOutboxKey(
    accountId: string,
    conversationId: string,
    outboxKey: string
  ): Promise<any | null> {
    if (!this.isConfigured(accountId)) return null;
    const response = await axios.get(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/messages`,
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    const messages = response.data?.payload || response.data || [];
    return (Array.isArray(messages) ? messages : []).find(
      message => message?.content_attributes?.helios_outbox_key === outboxKey
    ) || null;
  }

  public async addLabels(accountId: string, conversationId: string, labels: string[]): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    try {
      await axios.post(
        `${this.baseUrl(accountId)}/conversations/${conversationId}/labels`,
        { labels },
        { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
      );
    } catch (error: any) {
      console.error('[Chatwoot Client Error] addLabels:', error.code || 'CHATWOOT_ERROR');
    }
  }

  // ------------------------------------------------------------------
  // Operaciones del handoff humano
  //
  // Estos métodos SÍ propagan el error: el servicio de handoff necesita
  // saber qué paso falló para registrarlo y poder reintentarlo.
  // ------------------------------------------------------------------

  public async listLabels(accountId: string, conversationId: string): Promise<string[]> {
    if (!this.isConfigured(accountId)) return [];
    const response = await axios.get(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/labels`,
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    const payload = response.data?.payload ?? response.data ?? [];
    return (Array.isArray(payload) ? payload : []).map((label: unknown) => String(label));
  }

  /**
   * POST /labels llama a update_labels en Chatwoot, que REEMPLAZA la lista
   * completa. Por eso hay que leer las etiquetas actuales y publicar la unión:
   * de lo contrario el handoff borraría las etiquetas que puso el equipo.
   */
  public async replaceLabels(
    accountId: string,
    conversationId: string,
    labels: string[]
  ): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/labels`,
      { labels },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
  }

  public async addLabelsPreserving(
    accountId: string,
    conversationId: string,
    labelsToAdd: string[]
  ): Promise<string[]> {
    const wanted = labelsToAdd.map(label => String(label).trim()).filter(Boolean);
    if (wanted.length === 0) return [];
    const current = await this.listLabels(accountId, conversationId);
    const merged = [...new Set([...current, ...wanted])];
    if (merged.length !== current.length) {
      await this.replaceLabels(accountId, conversationId, merged);
    }
    return merged;
  }

  public async removeLabelsPreserving(
    accountId: string,
    conversationId: string,
    labelsToRemove: string[]
  ): Promise<string[]> {
    const unwanted = new Set(labelsToRemove.map(label => String(label).trim()).filter(Boolean));
    if (unwanted.size === 0) return [];
    const current = await this.listLabels(accountId, conversationId);
    const kept = current.filter(label => !unwanted.has(label));
    if (kept.length !== current.length) {
      await this.replaceLabels(accountId, conversationId, kept);
    }
    return kept;
  }

  /** Atributos personalizados actuales de la conversación. */
  public async getCustomAttributes(
    accountId: string,
    conversationId: string
  ): Promise<Record<string, any>> {
    if (!this.isConfigured(accountId)) return {};
    const response = await axios.get(
      `${this.baseUrl(accountId)}/conversations/${conversationId}`,
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    const current = response.data?.custom_attributes ?? response.data?.payload?.custom_attributes;
    return current && typeof current === 'object' ? current : {};
  }

  /**
   * Las macros de esta instalación no pueden escribir atributos personalizados,
   * así que los escribe el Gateway por API.
   *
   * POST /custom_attributes REEMPLAZA el hash completo salvo que se envíe
   * merge=true, y esa opción no existe en todas las versiones de Chatwoot. Para no
   * depender de la versión se leen los atributos actuales, se fusionan los nuestros
   * y se publica la unión. Sin esto, un handoff borraría cualquier otro atributo
   * personalizado que la clínica tenga en la conversación.
   */
  public async mergeCustomAttributes(
    accountId: string,
    conversationId: string,
    attributes: Record<string, string | number | null>
  ): Promise<Record<string, any>> {
    if (!this.isConfigured(accountId)) return {};
    const current = await this.getCustomAttributes(accountId, conversationId);
    const merged = { ...current, ...attributes };
    await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/custom_attributes`,
      { custom_attributes: merged, merge: true },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    return merged;
  }

  public async setStatus(
    accountId: string,
    conversationId: string,
    status: 'open' | 'pending' | 'resolved' | 'snoozed'
  ): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/toggle_status`,
      { status },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
  }

  public async setPriority(
    accountId: string,
    conversationId: string,
    priority: 'low' | 'medium' | 'high' | 'urgent' | null
  ): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/toggle_priority`,
      { priority },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
  }

  public async assignTeam(accountId: string, conversationId: string, teamId: string): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/assignments`,
      { team_id: Number(teamId) },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
  }

  /**
   * Nota privada del handoff. message_type outgoing + private es la nota
   * interna canónica de Chatwoot: la ve el equipo, no el paciente.
   */
  public async createHandoffPrivateNote(
    accountId: string,
    conversationId: string,
    content: string
  ): Promise<string | null> {
    if (!this.isConfigured(accountId)) {
      console.log('[Chatwoot Client MOCK] Nota privada de handoff simulada.');
      return null;
    }
    const response = await axios.post(
      `${this.baseUrl(accountId)}/conversations/${conversationId}/messages`,
      { content, message_type: 'outgoing', private: true },
      { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
    );
    const id = response.data?.id;
    return id === undefined || id === null ? null : String(id);
  }

  public async createPrivateNote(accountId: string, conversationId: string, content: string): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    try {
      await axios.post(
        `${this.baseUrl(accountId)}/conversations/${conversationId}/messages`,
        { content, message_type: 'template', private: true },
        { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
      );
    } catch (error: any) {
      console.error('[Chatwoot Client Error] createPrivateNote:', error.code || 'CHATWOOT_ERROR');
    }
  }

  public async assignHuman(accountId: string, conversationId: string): Promise<void> {
    if (!this.isConfigured(accountId)) return;
    try {
      const assigneeId = config.CHATWOOT_HUMAN_ASSIGNEE_ID;
      if (assigneeId) {
        await axios.post(
          `${this.baseUrl(accountId)}/conversations/${conversationId}/assignments`,
          { assignee_id: Number(assigneeId) },
          { headers: this.headers, timeout: config.CHATWOOT_TIMEOUT_MS }
        );
      }
    } catch (error: any) {
      console.error('[Chatwoot Client Error] assignHuman:', error.code || 'CHATWOOT_ERROR');
    }
  }
}

export const chatwootClient = new ChatwootClient();
