import { chatwootClient } from '../chatwoot/client.js';
import { 
  stateRepository, 
  patientRepository, 
  handoffRepository, 
  financingRepository 
} from '../repositories/database.js';

export async function runTools(
  toolCalls: Array<{ name: string; arguments: any }>,
  context: {
    tenant_id: string;
    conversation_id: string;
    contact_id: string;
    phone: string;
    trace_id: string;
  }
): Promise<any[]> {
  const results: any[] = [];

  for (const call of toolCalls) {
    const { name, arguments: args } = call;
    console.log(`[Tool Runner] Ejecutando: ${name} con argumentos:`, args);

    try {
      let result: any = null;

      switch (name) {
        // --- CHATWOOT TOOLS ---
        case 'chatwoot.send_message':
          await chatwootClient.sendMessage(context.conversation_id, args.content);
          result = { success: true };
          break;

        case 'chatwoot.add_labels':
          await chatwootClient.addLabels(context.conversation_id, args.labels);
          result = { success: true };
          break;

        case 'chatwoot.create_private_note':
          await chatwootClient.createPrivateNote(context.conversation_id, args.content);
          result = { success: true };
          break;

        case 'chatwoot.assign_human':
          await chatwootClient.assignHuman(context.conversation_id);
          result = { success: true };
          break;

        // --- STATE TOOLS ---
        case 'state.update':
          await stateRepository.upsert({
            tenant_id: context.tenant_id,
            conversation_id: context.conversation_id,
            contact_id: context.contact_id,
            inbox_id: args.inbox_id || '',
            ...args
          });
          result = { success: true };
          break;

        // --- PATIENT TOOLS ---
        case 'patient.upsert_profile':
          await patientRepository.upsert({
            tenant_id: context.tenant_id,
            contact_id: context.contact_id,
            phone: context.phone,
            ...args
          });
          result = { success: true };
          break;

        // --- HANDOFF TOOLS ---
        case 'handoff.create':
          await handoffRepository.create({
            tenant_id: context.tenant_id,
            conversation_id: context.conversation_id,
            contact_id: context.contact_id,
            reason: args.reason || 'Solicitud de derivación',
            message: args.message || ''
          });
          result = { success: true };
          break;

        // --- FINANCING TOOLS ---
        case 'financing.create_case':
          await financingRepository.createCase({
            tenant_id: context.tenant_id,
            conversation_id: context.conversation_id,
            contact_id: context.contact_id,
            phone: context.phone,
            ...args
          });
          result = { success: true };
          break;

        case 'financing.update_case':
          if (args.id) {
            await financingRepository.updateCase(args.id, args.updates);
            result = { success: true };
          } else {
            result = { success: false, error: 'Falta id del caso de financiamiento' };
          }
          break;

        case 'financing.get_case':
          result = await financingRepository.getActive(context.tenant_id, context.contact_id);
          break;

        // --- CALENDAR MOCKS ---
        case 'calendar.check_availability':
        case 'calendar.create_booking':
        case 'calendar.reschedule_booking':
        case 'calendar.cancel_booking':
        case 'calendar.get_active_booking':
          console.log(`[Calendar Mock] Ejecutando mock de ${name}`);
          result = { success: true, message: `Herramienta de calendario '${name}' mockeada con éxito.` };
          break;

        // --- KNOWLEDGE MOCKS ---
        case 'knowledge.search':
          console.log(`[Knowledge Mock] Ejecutando consulta RAG para: "${args.query}"`);
          result = { found: false, results: [] };
          break;

        default:
          console.warn(`[Tool Runner] Herramienta desconocida: ${name}`);
          result = { success: false, error: `Herramienta no implementada: ${name}` };
      }

      results.push({ name, result });
    } catch (error: any) {
      console.error(`[Tool Runner Error] Error ejecutando ${name}:`, error.message);
      results.push({ name, error: error.message });
    }
  }

  return results;
}
