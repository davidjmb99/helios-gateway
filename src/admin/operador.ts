/**
 * Quién puede cambiar de clínica en el panel, y por qué.
 *
 * ESTA DECISIÓN VIVE APARTE Y ES PURA, igual que `decidirSesion` o `queHacerCon`. Y aquí
 * el motivo es más fuerte que en aquellas: es el primer permiso del sistema que deja a una
 * sesión ver dos clínicas, así que es el primer sitio donde se puede romper el aislamiento
 * que David ha pedido desde el principio -«que no se mezclen entre clientes de clínicas ni
 * pacientes»-.
 *
 * LO INTENTÉ PROBAR MIRANDO EL TEXTO DEL SERVIDOR Y NO SERVÍA. Las comprobaciones pasaban
 * con el código bueno y con uno que devolvía acceso a cualquiera: el `if` seguía escrito
 * en el archivo, solo que inalcanzable. Una prueba que no distingue eso no protege nada,
 * y menos esto.
 *
 * LA PROPIEDAD QUE HACE SEGURO EL SELECTOR, y es de diseño y no de vigilancia: el token
 * apunta SIEMPRE a UNA sola clínica y todos los endpoints sacan el tenant DEL TOKEN. No
 * existe ningún endpoint al que se le pueda pasar un `tenant_id` y que lo obedezca.
 * Cambiar de cuenta es pedir un token nuevo, y los tokens los emite el servidor.
 */

export type MotivoDeCambio =
  /** Puede. */
  | 'permitido'
  /** No hay sesión, o el token no vale. */
  | 'sin_sesion'
  /** Es una sesión de clínica: nunca ha podido cambiarse. */
  | 'no_es_operador'
  /** Lo era al iniciar sesión y ya no lo es. Se le quitó el permiso mientras tanto. */
  | 'ya_no_es_operador';

export interface SesionParaCambio {
  tenant_id: string;
  /** El tenant_id de la cuenta de operador que abrió la sesión, o null. */
  operador: string | null;
}

/**
 * @param sesion  Lo que dice el token, ya verificada su firma.
 * @param filaDelOperador  La fila de esa cuenta de operador AHORA MISMO, o null si no
 *   existe. Se pasa como dato para que esta decisión no toque la base de datos.
 */
export function puedeCambiarDeCuenta(
  sesion: SesionParaCambio | null,
  filaDelOperador: { es_operador?: unknown } | null
): MotivoDeCambio {
  if (!sesion || !sesion.tenant_id) return 'sin_sesion';

  // UNA SESIÓN DE CLÍNICA NO SE CAMBIA A NADA. Es el fallo que expondría los datos de un
  // paciente a otra clínica, así que va primero y no depende de nada más.
  if (!sesion.operador) return 'no_es_operador';

  // Y SE VUELVE A MIRAR LA FILA. El token va firmado y su `operador` es de fiar, pero
  // quitarle el permiso a alguien tiene que surtir efecto EN EL MOMENTO: para algo que
  // abre todas las clínicas, esperar a que caduque una sesión no es aceptable.
  //
  // Se exige `true` exacto y no un valor que se le parezca: un `"false"` de texto, un 1 o
  // un null son todos «no».
  if (!filaDelOperador || filaDelOperador.es_operador !== true) return 'ya_no_es_operador';

  return 'permitido';
}

/** El código HTTP de cada motivo. 401 es «no sé quién eres»; 403, «sé quién eres y no». */
export function estadoHttpDe(motivo: MotivoDeCambio): number {
  return motivo === 'sin_sesion' ? 401 : motivo === 'permitido' ? 200 : 403;
}
