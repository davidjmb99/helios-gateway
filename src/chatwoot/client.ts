import axios from 'axios';
import { config } from '../config.js';

export class ChatwootClient {
  private get baseUrl() {
    return `${config.CHATWOOT_BASE_URL}/api/v1/accounts/${config.CHATWOOT_ACCOUNT_ID}`;
  }

  private get headers() {
    return {
      'api_access_token': config.CHATWOOT_API_TOKEN,
      'Content-Type': 'application/json'
    };
  }

  private isConfigured(): boolean {
    return !!(config.CHATWOOT_ACCOUNT_ID && config.CHATWOOT_API_TOKEN);
  }

  public async sendMessage(conversationId: string, content: string): Promise<any> {
    if (!this.isConfigured()) {
      console.log(`[Chatwoot Client MOCK] Enviando mensaje a conv #${conversationId}: "${content}"`);
      return { id: `mock-${Date.now()}` };
    }

    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          `${this.baseUrl}/conversations/${conversationId}/messages`,
          { content, message_type: 'outgoing' },
          { headers: this.headers }
        );
        return response.data; // Éxito
      } catch (error: any) {
        console.error(`[Chatwoot Client Error] sendMessage (intento ${attempt}/${maxRetries}):`, error.message);
        if (attempt === maxRetries) {
          throw error; // Re-throw en el último intento para que el orquestador lo sepa
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1s antes de reintentar
      }
    }
  }

  public async addLabels(conversationId: string, labels: string[]): Promise<void> {
    if (!this.isConfigured()) {
      console.log(`[Chatwoot Client MOCK] Añadiendo etiquetas a conv #${conversationId}:`, labels);
      return;
    }

    try {
      await axios.post(
        `${this.baseUrl}/conversations/${conversationId}/labels`,
        { labels },
        { headers: this.headers }
      );
    } catch (error: any) {
      console.error(`[Chatwoot Client Error] addLabels:`, error.message);
    }
  }

  public async createPrivateNote(conversationId: string, content: string): Promise<void> {
    if (!this.isConfigured()) {
      console.log(`[Chatwoot Client MOCK] Creando nota privada en conv #${conversationId}: "${content}"`);
      return;
    }

    try {
      await axios.post(
        `${this.baseUrl}/conversations/${conversationId}/messages`,
        { content, message_type: 'template', private: true },
        { headers: this.headers }
      );
    } catch (error: any) {
      console.error(`[Chatwoot Client Error] createPrivateNote:`, error.message);
    }
  }

  public async assignHuman(conversationId: string): Promise<void> {
    if (!this.isConfigured()) {
      console.log(`[Chatwoot Client MOCK] Asignando conversación #${conversationId} a equipo humano/agente.`);
      return;
    }

    try {
      const teamId = config.CHATWOOT_HUMAN_TEAM_ID;
      const assigneeId = config.CHATWOOT_HUMAN_ASSIGNEE_ID;

      if (assigneeId) {
        await axios.post(
          `${this.baseUrl}/conversations/${conversationId}/assignments`,
          { assignee_id: Number(assigneeId) },
          { headers: this.headers }
        );
      }
      
      // Asignación de equipo (si aplica)
      if (teamId) {
        // En algunas versiones de chatwoot es otro endpoint, pero guardamos intención
        console.log(`Asignando al equipo humano #${teamId}`);
      }
    } catch (error: any) {
      console.error(`[Chatwoot Client Error] assignHuman:`, error.message);
    }
  }
}

export const chatwootClient = new ChatwootClient();
