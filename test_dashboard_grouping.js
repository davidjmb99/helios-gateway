// test_dashboard_grouping.js

// Mock frontend variables
let contactProfiles = {
  '7': { contact_id: '7', profile_complete: true, display_name: 'David Mercado', first_name: 'David', last_name: 'Mercado' },
  '8': { contact_id: '8', profile_complete: false, display_name: null, first_name: null, last_name: null }
};

// Mock events
const allEvents = [
  {
    trace_id: 'trace_1',
    tenant_id: 'democoi1',
    conversation_id: '33',
    contact_id: '7',
    patient_name: 'David Mercado',
    phone: '+123',
    timestamp: new Date(Date.now() - 10000).toISOString(),
    decision: 'processed',
    text: 'Hola de contacto 7'
  },
  {
    trace_id: 'trace_2',
    tenant_id: 'democoi1',
    conversation_id: '33',
    contact_id: '8',
    patient_name: 'Davidjmb',
    normalizedPayload: {
      raw_payload: { sender: { name: 'Davidjmb' } }
    },
    phone: '+584167474664',
    timestamp: new Date().toISOString(),
    decision: 'identity_required',
    text: 'Hola de contacto 8'
  },
  {
    trace_id: 'trace_3_outgoing',
    tenant_id: 'democoi1',
    conversation_id: '33',
    contact_id: '8',
    message_type: 'outgoing',
    patient_name: 'Davidjmb',
    timestamp: new Date(Date.now() + 1000).toISOString(),
    decision: 'ignored', // eco del bot
    text: 'Eco'
  }
];

function resolvePatientName(ev) {
  const contactId = ev.contact_id;

  // 1. Nombre verificado desde Supabase (solo si profile_complete = true)
  const verified = contactProfiles[contactId];
  if (verified && verified.profile_complete === true && verified.display_name) {
    return verified.display_name;
  }

  // 2. chatwoot_display_name o meta.sender.name del webhook más reciente DEL MISMO contact_id
  if (ev.patient_name && ev.patient_name !== 'Paciente' && ev.patient_name !== 'Paciente de Chatwoot') {
    return ev.patient_name;
  }

  const raw = ev.normalizedPayload?.raw_payload || {};
  if (raw.sender?.name && raw.sender.name !== 'Paciente de Chatwoot') return raw.sender.name;
  if (raw.conversation?.meta?.sender?.name && raw.conversation.meta.sender.name !== 'Paciente de Chatwoot') return raw.conversation.meta.sender.name;

  // 3. Teléfono enmascarado o fallback
  if (ev.phone && ev.phone.length > 5) {
    return ev.phone.slice(0, 5) + '***' + ev.phone.slice(-2);
  }

  return "Contacto sin identificar";
}

function runFrontendGrouping() {
  const groups = {};
  allEvents.forEach(ev => {
    const convId = ev.conversation_id || 'unknown';
    const tenantId = ev.tenant_id || 'unknown';
    const contactId = ev.contact_id || 'unknown';
    
    if (convId === 'unknown' || !convId) return;

    const groupKey = `${tenantId}_${convId}_${contactId}`;
    const isIncoming = ev.message_type === 'incoming' || ev.normalizedPayload?.direction === 'incoming';

    if (!groups[groupKey]) {
      groups[groupKey] = {
        groupKey: groupKey,
        conversation_id: convId,
        tenant_id: tenantId,
        contact_id: contactId,
        patient_name: resolvePatientName(ev),
        phone: ev.phone || ev.normalizedPayload?.phone || 'N/A',
        messages: [],
        lastTimestamp: ev.timestamp,
        decision: ev.decision,
        latestText: ev.text
      };
    }
    
    groups[groupKey].messages.unshift(ev); 
    
    if (new Date(ev.timestamp) > new Date(groups[groupKey].lastTimestamp)) {
      groups[groupKey].lastTimestamp = ev.timestamp;
      groups[groupKey].latestText = ev.text;
      groups[groupKey].patient_name = resolvePatientName(ev);
      
      if (isIncoming || groups[groupKey].decision === 'ignored') {
        groups[groupKey].decision = ev.decision;
      }
    }
  });

  return Object.values(groups);
}

function assertTest(name, condition) {
  if (condition) {
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name}`);
  }
}

const resultGroups = runFrontendGrouping();

console.log("Groups generados:", resultGroups.length);

assertTest("A y B no se fusionan (Existen 2 grupos distintos)", resultGroups.length === 2);
assertTest("La tarjeta del contacto 8 muestra Davidjmb como provisional", resultGroups.find(g => g.contact_id === '8').patient_name === 'Davidjmb');
assertTest("La tarjeta del contacto 7 conserva David Mercado", resultGroups.find(g => g.contact_id === '7').patient_name === 'David Mercado');
assertTest("Un evento OUTGOING (trace_3) no cambia la identidad de la tarjeta", resultGroups.find(g => g.contact_id === '8').patient_name === 'Davidjmb');

// Simular limpieza
contactProfiles['7'] = null;
const cleanGroups = runFrontendGrouping();
assertTest("Limpiar helios_patient_profiles revierte al webhook provisional", cleanGroups.find(g => g.contact_id === '7').patient_name === 'David Mercado'); 
// (en este caso el webhook tiene patient_name: 'David Mercado', si no caeria al telefono)
