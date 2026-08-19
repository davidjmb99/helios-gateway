/**
 * Vigilar que los pacientes están llegando de verdad al CRM.
 *
 * EL RIESGO, señalado en la auditoría de variables del 18-ago-2026: el acceso a
 * HubSpot se renueva por OAuth y NADIE vigila esa renovación. El día que falle,
 * HubSpot deja de guardar contactos y el sistema sigue contestando con normalidad.
 * El paciente recibe su respuesta, la conversación parece perfecta, y la clínica se
 * queda sin la ficha. Nadie se enteraría hasta que alguien buscara un contacto que
 * no está — probablemente semanas después.
 *
 * Es el mismo patrón que este sistema lleva una semana pagando: no el fallo, sino
 * el silencio alrededor del fallo.
 *
 * POR QUÉ SE MIRA EL RESULTADO Y NO LO QUE DICE HERMES: si el token caduca, no se
 * puede confiar en que el modelo lo reporte bien —de hecho el 18 de agosto vimos a
 * Hermes declarar herramientas con nombres que no coincidían con los ejecutados—.
 * Lo que no engaña es el dato: si la identidad del paciente está completa y aun así
 * no hay identificador de CRM, ese paciente no está en HubSpot. Eso es cierto
 * independientemente de lo que cuente cualquiera.
 *
 * NO ES UNA ALARMA POR CADA FALLO. Un turno sin CRM puede ser normal: el paciente
 * acaba de dar su nombre y el alta va en el turno siguiente. Lo que no es normal es
 * una RACHA. Se avisa a la tercera seguida, y se calla en cuanto uno funciona.
 */

import { recordComponentError, recordComponentSuccess } from './component-health.js';

/**
 * Cuántos turnos seguidos sin llegar al CRM hacen falta para avisar.
 *
 * Con uno habría ruido constante -el alta legítimamente ocurre un turno después de
 * la identidad-. Con diez, un token caducado pasaría una tarde entera sin avisar.
 * Tres es el punto donde una racha ya no puede explicarse por el flujo normal.
 */
export const RACHA_PARA_AVISAR = 3;

export interface TurnoDeCrm {
  /** ¿Tenemos ya nombre, apellidos y correo válidos? Sin eso no toca dar de alta. */
  identidadCompleta: boolean;
  /** El identificador de CRM que hay guardado DESPUÉS de aplicar el patch del turno. */
  crmContactId: unknown;
  /** operation.type del contrato, para distinguir un intento de HubSpot de un turno cualquiera. */
  tipoDeOperacion?: unknown;
}

export type VeredictoDeCrm = 'sincronizado' | 'sin_sincronizar' | 'no_aplica';

/**
 * ¿Este turno cuenta como paciente que llegó al CRM, como paciente que no llegó, o
 * como turno que no dice nada?
 */
export function evaluarTurnoDeCrm(turno: TurnoDeCrm): VeredictoDeCrm {
  const tieneCrm = typeof turno.crmContactId === 'string' && turno.crmContactId.trim() !== '';
  if (tieneCrm) return 'sincronizado';

  // Sin identidad completa no hay nada que dar de alta: este turno no informa.
  if (!turno.identidadCompleta) return 'no_aplica';

  const tipo = String(turno.tipoDeOperacion ?? '').trim().toLowerCase();
  // Una operación de HubSpot que dice haber ido bien y NO deja identificador es la
  // señal más clara que existe: se creyó dar de alta a alguien que no está.
  if (tipo.startsWith('hubspot')) return 'sin_sincronizar';

  // Identidad completa y sin CRM, sin que se haya intentado HubSpot en este turno.
  // También cuenta: el paciente está listo para el alta y sigue sin ficha.
  return 'sin_sincronizar';
}

const rachaPorClinica = new Map<string, number>();

export const crmMetrics = {
  sincronizados: 0,
  sin_sincronizar: 0,
  rachas_avisadas: 0,
  ultima_racha: null as { tenant_id: string; seguidos: number; en: string } | null
};

/**
 * Registra el turno y avisa si la racha llega al límite.
 *
 * La racha es POR CLÍNICA: en multiclínica, un token caducado afecta a una y no a
 * las demás, y sumarlas todas en un contador global escondería a la afectada
 * detrás de las que funcionan.
 *
 * Devuelve el veredicto para que quien llama pueda registrarlo si quiere. No
 * lanza: vigilar no puede romper el turno de un paciente.
 */
export function registrarTurnoDeCrm(tenantId: string, turno: TurnoDeCrm): VeredictoDeCrm {
  let veredicto: VeredictoDeCrm = 'no_aplica';
  try {
    veredicto = evaluarTurnoDeCrm(turno);
    if (veredicto === 'no_aplica') return veredicto;

    if (veredicto === 'sincronizado') {
      crmMetrics.sincronizados += 1;
      rachaPorClinica.set(tenantId, 0);
      recordComponentSuccess('crm');
      return veredicto;
    }

    crmMetrics.sin_sincronizar += 1;
    const seguidos = (rachaPorClinica.get(tenantId) ?? 0) + 1;
    rachaPorClinica.set(tenantId, seguidos);

    if (seguidos >= RACHA_PARA_AVISAR) {
      crmMetrics.rachas_avisadas += 1;
      crmMetrics.ultima_racha = {
        tenant_id: tenantId,
        seguidos,
        en: new Date().toISOString()
      };
      recordComponentError('crm', 'CRM_SIN_SINCRONIZAR', 'DEGRADED');
      console.error(JSON.stringify({
        event: 'crm_no_esta_recibiendo_pacientes',
        tenant_id: tenantId,
        turnos_seguidos: seguidos,
        sospecha_principal: 'El acceso a HubSpot se renueva por OAuth y nada vigila '
          + 'esa renovacion. Un token caducado da exactamente este patron.',
        como_comprobarlo: 'Mirar si helios_patient_profiles tiene crm_contact_id en '
          + 'null para los pacientes de hoy con identidad completa.'
      }));
    }
    return veredicto;
  } catch {
    // Vigilar nunca puede tumbar un turno.
    return veredicto;
  }
}

/** Para los tests: dejar los contadores como estaban. */
export function limpiarVigilanciaDeCrm(): void {
  rachaPorClinica.clear();
  crmMetrics.sincronizados = 0;
  crmMetrics.sin_sincronizar = 0;
  crmMetrics.rachas_avisadas = 0;
  crmMetrics.ultima_racha = null;
}
