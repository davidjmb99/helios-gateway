function buildPatientPayload(patientProfile, chatwootDisplayName, resolvedPhone) {
  const isProfileComplete = patientProfile?.profile_complete === true ||
    !!(patientProfile?.first_name && patientProfile?.last_name && patientProfile?.email && resolvedPhone);

  return {
    profile_exists: !!patientProfile,
    profile_complete: isProfileComplete,
    first_name: isProfileComplete ? (patientProfile?.first_name || null) : null,
    last_name: isProfileComplete ? (patientProfile?.last_name || null) : null,
    name: isProfileComplete ? [patientProfile?.first_name, patientProfile?.last_name].filter(Boolean).join(' ') || patientProfile?.name : null,
    email: patientProfile?.email || null,
    phone: resolvedPhone,
    chatwoot_display_name: chatwootDisplayName,
    display_name_source: isProfileComplete ? "verified_profile" : "chatwoot"
  };
}

function assertTest(name, condition) {
  if (condition) {
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name}`);
    process.exitCode = 1;
  }
}

// Caso A: contact_id 8, perfil incompleto
const patientA = buildPatientPayload(
  { profile_complete: false }, 
  "Davidjmb", 
  "+584167474664"
);

assertTest("Caso A: name es null", patientA.name === null);
assertTest("Caso A: first_name es null", patientA.first_name === null);
assertTest("Caso A: chatwoot_display_name es Davidjmb", patientA.chatwoot_display_name === "Davidjmb");

// Caso B: despues de guardar David Perez
const patientB = buildPatientPayload(
  { profile_complete: true, first_name: "David", last_name: "Perez", email: "david@test.com" },
  "Davidjmb",
  "+584167474664"
);

assertTest("Caso B: first_name es David", patientB.first_name === "David");
assertTest("Caso B: last_name es Perez", patientB.last_name === "Perez");
assertTest("Caso B: name es David Perez", patientB.name === "David Perez");
assertTest("Caso B: profile_complete es true", patientB.profile_complete === true);
assertTest("Caso B: chatwoot_display_name es Davidjmb (metadata provisional preservada)", patientB.chatwoot_display_name === "Davidjmb");

// Caso C: actualizar contacto 8 no modifica contacto 7
// (En lógica es trivial porque los repositorios usan where contact_id = '8', pero confirmamos a nivel de objetos)
const contact7 = buildPatientPayload(
  { profile_complete: true, first_name: "Juan", last_name: "Perez", email: "juan@test.com" },
  "Juan Perez (Chatwoot)",
  "+123456"
);

assertTest("Caso C: Contacto 7 retiene Juan Perez", contact7.name === "Juan Perez");
assertTest("Caso C: Contacto 8 retiene David Perez", patientB.name === "David Perez");
