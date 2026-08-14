/**
 * Contraseñas de acceso al panel.
 *
 * ESTADO DEL QUE SE VIENE. La columna se llama `password_hash` pero se comparaba
 * en claro: `tenant.password_hash !== password`. Es decir, las contraseñas de las
 * clínicas estaban guardadas sin cifrar en Supabase. Con una clínica de demo es
 * feo; con varios clientes de pago es un incidente esperando a ocurrir.
 *
 * MIGRACIÓN SIN RIESGO DE DEJAR A NADIE FUERA. No hace falta que nadie cambie su
 * contraseña ni ejecutar un script sobre la tabla:
 *
 *   - Si el valor guardado ya tiene formato cifrado, se verifica cifrado.
 *   - Si todavía está en claro, se acepta la comparación directa Y SE REESCRIBE
 *     cifrado en ese mismo momento.
 *
 * Así la tabla se migra sola a medida que la gente entra, y no hay ni un instante
 * en que alguien no pueda acceder. Cuando no quede ningún valor en claro, se
 * puede retirar esa rama.
 *
 * scrypt viene en Node: no añade dependencias. Está pensado para contraseñas y es
 * deliberadamente lento, que es lo que se quiere aquí.
 */

import crypto from 'crypto';

const ETIQUETA = 'scrypt';
const LONGITUD_CLAVE = 64;
const BYTES_SAL = 16;

/** ¿El valor guardado ya está cifrado, o es texto en claro heredado? */
export function esHashSeguro(almacenado: unknown): boolean {
  return String(almacenado ?? '').startsWith(`${ETIQUETA}$`);
}

export function cifrarContrasena(contrasena: string): string {
  const sal = crypto.randomBytes(BYTES_SAL).toString('hex');
  const derivada = crypto.scryptSync(contrasena, sal, LONGITUD_CLAVE).toString('hex');
  return `${ETIQUETA}$${sal}$${derivada}`;
}

/**
 * Comprueba una contraseña contra el valor guardado.
 *
 * La comparación es en tiempo constante: comparar cadenas con === filtra
 * información por cuánto tarda en fallar, y eso permite adivinar carácter a
 * carácter. Con scrypt el riesgo es menor, pero no cuesta nada hacerlo bien.
 */
export function verificarContrasena(contrasena: string, almacenado: unknown): boolean {
  const guardado = String(almacenado ?? '');
  if (!guardado || !contrasena) return false;

  if (!esHashSeguro(guardado)) {
    // Herencia: valor en claro. Se acepta para no dejar fuera a nadie, y quien
    // llama debe reescribirlo cifrado.
    const a = Buffer.from(contrasena);
    const b = Buffer.from(guardado);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const [, sal, esperado] = guardado.split('$');
  if (!sal || !esperado) return false;
  try {
    const derivada = crypto.scryptSync(contrasena, sal, LONGITUD_CLAVE);
    const esperadoBuf = Buffer.from(esperado, 'hex');
    return derivada.length === esperadoBuf.length && crypto.timingSafeEqual(derivada, esperadoBuf);
  } catch {
    return false;
  }
}
