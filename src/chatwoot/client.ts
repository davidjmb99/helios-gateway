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
