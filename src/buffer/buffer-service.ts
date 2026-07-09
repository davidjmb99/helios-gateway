import { config } from '../config.js';
import { bufferRepository } from '../repositories/database.js';
import { NormalizedMessage } from '../chatwoot/normalizer.js';

type BufferCallback = (tenantId: string, conversationId: string, traceId: string) => Promise<void>;

class BufferService {
  // Almacena los timers de ejecución por cada conversación
  private activeTimers: Map<string, NodeJS.Timeout> = new Map();
  // Almacena el trace_id grupal activo por cada conversación para consolidar la ráfaga
  private activeGroupTraces: Map<string, string> = new Map();
  private callback: BufferCallback | null = null;

  public setCallback(cb: BufferCallback) {
    this.callback = cb;
  }

  /**
   * Encola un mensaje entrante en el buffer.
   * Si ya hay un temporizador activo para esa conversación, lo reinicia para esperar otros 5 segundos.
   */
  public async addMessage(msg: NormalizedMessage): Promise<void> {
    const key = `${msg.tenant_id}:${msg.conversation_id}`;
    
    // Si no hay un grupo de ráfaga activo, asignamos el trace_id del mensaje actual como el ID del grupo
    if (!this.activeGroupTraces.has(key)) {
      this.activeGroupTraces.set(key, msg.trace_id);
    }
    
    // Sobrescribimos el trace_id del mensaje actual con el del grupo activo para enlazarlos
    const activeGroupTrace = this.activeGroupTraces.get(key)!;
    msg.trace_id = activeGroupTrace;

    // 1. Persistimos el mensaje en la base de datos de respaldo
    await bufferRepository.save(msg);

    // 2. Limpiamos el timer existente si el cliente sigue escribiendo
    if (this.activeTimers.has(key)) {
      clearTimeout(this.activeTimers.get(key));
      this.activeTimers.delete(key);
    }

    // 3. Agendamos un nuevo timer de 5 segundos
    const timer = setTimeout(async () => {
      this.activeTimers.delete(key);
      this.activeGroupTraces.delete(key); // Limpiamos el trace de grupo al hacer el flush
      if (this.callback) {
        try {
          await this.callback(msg.tenant_id, msg.conversation_id, activeGroupTrace);
        } catch (error) {
          console.error(`[Buffer Error] Error procesando callback para la clave ${key}:`, error);
        }
      }
    }, config.BUFFER_MS);

    this.activeTimers.set(key, timer);
  }
}

export const bufferService = new BufferService();
