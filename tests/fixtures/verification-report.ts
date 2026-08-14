/**
 * Genera un informe HTML legible de lo que hizo Helios en cada escenario de prueba.
 *
 * Existe para que la verificación no sea un "PASS" en una consola, sino una página
 * que se pueda abrir y leer: qué mensaje entró, qué hizo Helios, cómo quedó la base
 * de datos y si eso es lo correcto.
 *
 * Se escribe al terminar el proceso, pase o falle, para que un fallo también deje
 * constancia visual de hasta dónde llegó.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ReportTable {
  caption: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  emptyMessage?: string;
}

export interface ReportSection {
  id: string;
  title: string;
  question: string;
  inputs: string[];
  facts: Array<{ label: string; value: string; good: boolean }>;
  tables: ReportTable[];
  conclusion: string;
}

const sections: ReportSection[] = [];
let reportTitle = 'Verificación';
let reportSubtitle = '';
let outputPath = 'verificacion.html';
let expectedSections = 0;

export function startReport(options: {
  title: string;
  subtitle: string;
  outputPath: string;
  expectedSections: number;
}): void {
  reportTitle = options.title;
  reportSubtitle = options.subtitle;
  outputPath = options.outputPath;
  expectedSections = options.expectedSections;
  process.on('exit', () => writeReport());
}

export function addSection(section: ReportSection): void {
  sections.push(section);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTable(table: ReportTable): string {
  if (table.rows.length === 0) {
    return `
      <div class="tabla-vacia">
        <strong>${escapeHtml(table.caption)}</strong>
        <span>${escapeHtml(table.emptyMessage || 'Sin filas — y eso es lo correcto aquí.')}</span>
      </div>`;
  }
  return `
    <figure class="tabla">
      <figcaption>${escapeHtml(table.caption)}</figcaption>
      <div class="scroll">
        <table>
          <thead><tr>${table.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
          <tbody>
            ${table.rows.map(row => `<tr>${row.map(cell =>
              `<td>${cell === null || cell === undefined || cell === '' ? '<span class="nulo">vacío</span>' : escapeHtml(cell)}</td>`
            ).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
    </figure>`;
}

function renderSection(section: ReportSection, index: number): string {
  return `
    <section class="escenario">
      <header>
        <span class="numero">${index + 1}</span>
        <div>
          <h2>${escapeHtml(section.title)}</h2>
          <p class="pregunta">${escapeHtml(section.question)}</p>
        </div>
        <span class="sello ok">Correcto</span>
      </header>

      <div class="bloque">
        <h3>Lo que llegó</h3>
        ${section.inputs.length
          ? `<ul class="mensajes">${section.inputs.map(input => `<li>${escapeHtml(input)}</li>`).join('')}</ul>`
          : '<p class="nota">Nada: este escenario no parte de un mensaje del paciente.</p>'}
      </div>

      <div class="bloque">
        <h3>Lo que hizo Helios</h3>
        <ul class="hechos">
          ${section.facts.map(fact => `
            <li class="${fact.good ? 'bien' : 'aviso'}">
              <span class="etiqueta">${escapeHtml(fact.label)}</span>
              <span class="valor">${escapeHtml(fact.value)}</span>
            </li>`).join('')}
        </ul>
      </div>

      ${section.tables?.length ? `<div class="bloque"><h3>Cómo quedaron los datos</h3>${section.tables.map(renderTable).join('')}</div>` : ''}

      <p class="conclusion">${escapeHtml(section.conclusion)}</p>
    </section>`;
}

function writeReport(): void {
  const completed = sections.length;
  const allDone = completed === expectedSections;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(reportTitle)}</title>
<style>
  :root {
    color-scheme: light dark;
    --fondo: #f6f7f9;
    --tarjeta: #ffffff;
    --texto: #1a1d21;
    --suave: #5c6570;
    --linea: #e2e5ea;
    --ok: #0f7b3d;
    --ok-fondo: #e7f6ec;
    --aviso: #8a5300;
    --aviso-fondo: #fdf3e2;
    --acento: #1f4fd8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fondo: #14161a;
      --tarjeta: #1c1f25;
      --texto: #e8eaed;
      --suave: #9aa3ae;
      --linea: #2c3138;
      --ok: #63d68f;
      --ok-fondo: #14301f;
      --aviso: #f0b559;
      --aviso-fondo: #33260f;
      --acento: #7da2ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1rem 4rem;
    background: var(--fondo); color: var(--texto);
    font: 16px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .contenedor { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .3rem; }
  .subtitulo { color: var(--suave); margin: 0 0 .4rem; }
  .sello-general {
    display: inline-block; margin-top: 1rem; padding: .55rem 1rem; border-radius: 999px;
    font-weight: 600; background: ${allDone ? 'var(--ok-fondo)' : 'var(--aviso-fondo)'};
    color: ${allDone ? 'var(--ok)' : 'var(--aviso)'};
  }
  .leyenda {
    margin: 1.75rem 0; padding: 1rem 1.25rem; border-left: 3px solid var(--acento);
    background: var(--tarjeta); border-radius: 0 8px 8px 0; color: var(--suave);
  }
  .escenario {
    background: var(--tarjeta); border: 1px solid var(--linea); border-radius: 12px;
    padding: 1.25rem 1.5rem 1.5rem; margin-bottom: 1.5rem;
  }
  .escenario > header { display: flex; gap: .9rem; align-items: flex-start; margin-bottom: 1.1rem; }
  .numero {
    flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 50%;
    background: var(--acento); color: #fff; font-weight: 700;
    display: grid; place-items: center;
  }
  .escenario h2 { font-size: 1.1rem; margin: .15rem 0 .2rem; }
  .pregunta { margin: 0; color: var(--suave); font-size: .95rem; }
  .sello { margin-left: auto; flex: 0 0 auto; padding: .3rem .7rem; border-radius: 999px; font-size: .8rem; font-weight: 700; }
  .sello.ok { background: var(--ok-fondo); color: var(--ok); }
  .bloque { margin-bottom: 1.1rem; }
  .bloque h3 { font-size: .82rem; text-transform: uppercase; letter-spacing: .06em; color: var(--suave); margin: 0 0 .5rem; }
  .mensajes { list-style: none; margin: 0; padding: 0; }
  .mensajes li {
    background: var(--fondo); border-radius: 10px 10px 10px 2px;
    padding: .5rem .8rem; margin-bottom: .35rem; display: inline-block; max-width: 100%;
  }
  .hechos { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
  .hechos li { display: flex; gap: .6rem; align-items: baseline; padding: .45rem .7rem; border-radius: 8px; background: var(--fondo); }
  .hechos li.bien { border-left: 3px solid var(--ok); }
  .hechos li.aviso { border-left: 3px solid var(--aviso); }
  .etiqueta { color: var(--suave); flex: 1 1 auto; }
  .valor { font-weight: 650; text-align: right; }
  .tabla { margin: 0 0 .9rem; }
  .tabla figcaption { font-size: .85rem; color: var(--suave); margin-bottom: .35rem; }
  .scroll { overflow-x: auto; border: 1px solid var(--linea); border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { padding: .45rem .6rem; text-align: left; border-bottom: 1px solid var(--linea); white-space: nowrap; }
  th { background: var(--fondo); font-weight: 650; }
  tbody tr:last-child td { border-bottom: 0; }
  .nulo { color: var(--suave); font-style: italic; }
  .tabla-vacia {
    display: flex; flex-direction: column; gap: .15rem;
    padding: .7rem .9rem; margin-bottom: .9rem;
    border: 1px dashed var(--linea); border-radius: 8px; color: var(--suave);
  }
  .conclusion {
    margin: 1.2rem 0 0; padding: .8rem 1rem; border-radius: 8px;
    background: var(--ok-fondo); color: var(--ok); font-weight: 600;
  }
  .nota { color: var(--suave); margin: 0; }
  footer { color: var(--suave); font-size: .85rem; margin-top: 2rem; }
</style>
</head>
<body>
<div class="contenedor">
  <h1>${escapeHtml(reportTitle)}</h1>
  <p class="subtitulo">${escapeHtml(reportSubtitle)}</p>
  <p class="subtitulo">Ejecutado el ${escapeHtml(timestamp)} UTC</p>
  <div class="sello-general">
    ${allDone
      ? `${completed} de ${expectedSections} escenarios correctos`
      : `Se detuvo en el escenario ${completed + 1} de ${expectedSections}: algo no cuadró`}
  </div>

  <div class="leyenda">
    Esto no ha tocado nada real. Se ha ejecutado el Helios de verdad, pero contra una
    base de datos de mentira que vive en la memoria del ordenador y contra un Adapter
    de mentira. Las claves de Chatwoot y de Telegram están vacías a propósito, así
    que esta comprobación no puede escribir en la clínica.
  </div>

  ${sections.map(renderSection).join('')}

  ${allDone ? '' : `
  <section class="escenario">
    <header>
      <span class="numero">!</span>
      <div>
        <h2>Aquí se paró</h2>
        <p class="pregunta">El escenario ${completed + 1} no llegó a completarse. El motivo exacto está en la consola donde lanzaste la comprobación.</p>
      </div>
    </header>
  </section>`}

  <footer>
    Generado por <code>npm run verificar</code> en helios-gateway.
    Para volver a generarlo, vuelve a lanzar ese comando.
  </footer>
</div>
</body>
</html>`;

  const target = path.resolve(outputPath);
  fs.writeFileSync(target, html, 'utf8');
  console.log(`\nInforme visual escrito en: ${target}`);
}
