/**
 * Doble en memoria del cliente de Supabase, suficientemente fiel para ejecutar el
 * orquestador completo sin base de datos.
 *
 * Reproduce a propósito tres comportamientos de PostgREST de los que el código de
 * producción depende:
 *
 *  1. un upsert solo actualiza las columnas presentes en el payload; las ausentes
 *     conservan su valor. De eso vive stateRepository.upsert, que hace parches
 *     parciales del estado.
 *  2. upsert con ignoreDuplicates devuelve data null cuando la fila ya existía.
 *     De eso viven los createOrGet idempotentes.
 *  3. un update devuelve exactamente las filas que ha tocado, que es lo que
 *     comprueba markClaimedBufferMessagesProcessed.
 *
 * Además registra todas las operaciones en orden, para poder afirmar que el estado
 * del handoff se persiste ANTES de encolar el mensaje al paciente.
 */

type Row = Record<string, any>;

export interface RecordedOp {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'rpc';
  detail?: Record<string, any>;
}

type Filter =
  | { kind: 'eq'; column: string; value: any }
  | { kind: 'in'; column: string; values: any[] }
  | { kind: 'gte'; column: string; value: any }
  | { kind: 'lte'; column: string; value: any }
  | { kind: 'is_null'; column: string; negated: boolean };

/**
 * supabase-js serializa el cuerpo con JSON.stringify, que ELIMINA las claves con
 * valor undefined, así que PostgREST nunca las ve y la columna queda intacta. Sin
 * reproducir esa frontera, el doble sobrescribiría columnas que en producción no se
 * tocan. null sí viaja y sí escribe: la diferencia importa.
 */
function throughJsonBoundary(payload: any): any {
  if (payload === undefined) return undefined;
  return JSON.parse(JSON.stringify(payload));
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(filter => {
    const current = row[filter.column];
    switch (filter.kind) {
      case 'eq':
        return String(current ?? '') === String(filter.value ?? '');
      case 'in':
        return filter.values.some(value => String(current ?? '') === String(value ?? ''));
      case 'gte':
        return new Date(current).getTime() >= new Date(filter.value).getTime();
      case 'lte':
        return new Date(current).getTime() <= new Date(filter.value).getTime();
      case 'is_null':
        return filter.negated
          ? current !== null && current !== undefined
          : current === null || current === undefined;
    }
  });
}

class FakeQuery implements PromiseLike<any> {
  private filters: Filter[] = [];
  private selected = false;
  private singleMode: 'none' | 'maybe' | 'single' = 'none';
  private orderColumn: string | null = null;
  private orderAscending = true;
  private rowLimit: number | null = null;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'upsert',
    private readonly payload: any = null,
    private readonly options: any = {}
  ) {}

  eq(column: string, value: any) {
    this.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, values: any[]) {
    this.filters.push({ kind: 'in', column, values });
    return this;
  }

  gte(column: string, value: any) {
    this.filters.push({ kind: 'gte', column, value });
    return this;
  }

  lte(column: string, value: any) {
    this.filters.push({ kind: 'lte', column, value });
    return this;
  }

  is(column: string, value: any) {
    if (value !== null) throw new Error(`FakeSupabase: is() solo soporta null, recibido ${value}`);
    this.filters.push({ kind: 'is_null', column, negated: false });
    return this;
  }

  not(column: string, operator: string, value: any) {
    if (operator !== 'is' || value !== null) {
      throw new Error(`FakeSupabase: not() solo soporta ('col', 'is', null)`);
    }
    this.filters.push({ kind: 'is_null', column, negated: true });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}) {
    this.orderColumn = column;
    this.orderAscending = options.ascending !== false;
    return this;
  }

  limit(count: number) {
    this.rowLimit = count;
    return this;
  }

  select(_columns?: string) {
    this.selected = true;
    return this;
  }

  maybeSingle() {
    this.singleMode = 'maybe';
    return this;
  }

  single() {
    this.singleMode = 'single';
    return this;
  }

  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private conflictColumns(): string[] {
    const onConflict = String(this.options?.onConflict ?? '').trim();
    if (onConflict) return onConflict.split(',').map(part => part.trim()).filter(Boolean);
    return this.db.primaryKeyFor(this.table);
  }

  private findConflicting(candidate: Row): Row | undefined {
    const columns = this.conflictColumns();
    if (columns.length === 0) return undefined;
    return this.db.table(this.table).find(row =>
      columns.every(column => String(row[column] ?? '') === String(candidate[column] ?? ''))
    );
  }

  private shape(rows: Row[]) {
    const ordered = this.orderColumn
      ? rows.slice().sort((a, b) => {
          const left = a[this.orderColumn!];
          const right = b[this.orderColumn!];
          const comparison = String(left ?? '') < String(right ?? '') ? -1 : String(left ?? '') > String(right ?? '') ? 1 : 0;
          return this.orderAscending ? comparison : -comparison;
        })
      : rows;
    const limited = this.rowLimit === null ? ordered : ordered.slice(0, this.rowLimit);

    if (this.singleMode === 'maybe') {
      return { data: limited.length ? { ...limited[0] } : null, error: null };
    }
    if (this.singleMode === 'single') {
      if (limited.length !== 1) {
        return { data: null, error: { code: 'PGRST116', message: 'exactly one row expected' } };
      }
      return { data: { ...limited[0] }, error: null };
    }
    return { data: limited.map(row => ({ ...row })), error: null };
  }

  private execute() {
    const rows = this.db.table(this.table);
    const payload = throughJsonBoundary(this.payload);

    if (this.op === 'select') {
      this.db.record({ table: this.table, op: 'select' });
      return this.shape(rows.filter(row => matches(row, this.filters)));
    }

    if (this.op === 'insert') {
      const incoming = Array.isArray(payload) ? payload : [payload];
      // Postgres rechaza un INSERT que choca con la clave primaria. Reproducirlo
      // es lo que permite probar los claims atómicos, que dependen del 23505.
      for (const candidate of incoming) {
        if (this.findConflicting(candidate)) {
          return {
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint',
              details: null,
              hint: null
            }
          };
        }
      }
      const inserted = incoming.map(row => {
        const stored = { ...row };
        rows.push(stored);
        return stored;
      });
      this.db.record({
        table: this.table,
        op: 'insert',
        detail: { count: inserted.length, payload: incoming[0] }
      });
      return this.selected ? this.shape(inserted) : { data: null, error: null };
    }

    if (this.op === 'update') {
      const affected = rows.filter(row => matches(row, this.filters));
      // PostgREST solo escribe las columnas presentes en el payload.
      affected.forEach(row => Object.assign(row, payload));
      this.db.record({
        table: this.table,
        op: 'update',
        detail: { count: affected.length, payload }
      });
      return this.selected ? this.shape(affected) : { data: null, error: null };
    }

    // upsert
    const incoming = Array.isArray(payload) ? payload : [payload];
    const results: Row[] = [];
    let duplicates = 0;
    for (const candidate of incoming) {
      const existing = this.findConflicting(candidate);
      if (existing) {
        if (this.options?.ignoreDuplicates) {
          duplicates += 1;
          continue;
        }
        Object.assign(existing, candidate);
        results.push(existing);
        continue;
      }
      const stored = { ...candidate };
      rows.push(stored);
      results.push(stored);
    }
    this.db.record({
      table: this.table,
      op: 'upsert',
      detail: {
        inserted_or_updated: results.length,
        ignored_duplicates: duplicates,
        payload: incoming[0]
      }
    });
    return this.selected ? this.shape(results) : { data: null, error: null };
  }
}

export class FakeSupabase {
  private tables = new Map<string, Row[]>();
  private primaryKeys = new Map<string, string[]>();
  private rpcHandlers = new Map<string, (params: any) => any>();
  readonly ops: RecordedOp[] = [];

  constructor(primaryKeys: Record<string, string[]> = {}) {
    for (const [table, columns] of Object.entries(primaryKeys)) {
      this.primaryKeys.set(table, columns);
    }
  }

  primaryKeyFor(table: string): string[] {
    return this.primaryKeys.get(table) ?? [];
  }

  table(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  seed(name: string, rows: Row[]): void {
    this.tables.set(name, rows.map(row => ({ ...row })));
  }

  record(op: RecordedOp): void {
    this.ops.push(op);
  }

  registerRpc(name: string, handler: (params: any) => any): void {
    this.rpcHandlers.set(name, handler);
  }

  from(table: string) {
    return {
      select: (columns?: string) => new FakeQuery(this, table, 'select').select(columns),
      insert: (payload: any) => new FakeQuery(this, table, 'insert', payload),
      update: (payload: any) => new FakeQuery(this, table, 'update', payload),
      upsert: (payload: any, options: any = {}) => new FakeQuery(this, table, 'upsert', payload, options)
    };
  }

  async rpc(name: string, params: any) {
    this.record({ table: `rpc:${name}`, op: 'rpc' });
    const handler = this.rpcHandlers.get(name);
    if (!handler) throw new Error(`FakeSupabase: RPC no registrada: ${name}`);
    return { data: handler(params), error: null };
  }

  /** Índice de la primera operación que cumple el predicado, o -1. */
  indexOfOp(predicate: (op: RecordedOp) => boolean): number {
    return this.ops.findIndex(predicate);
  }

  countOps(predicate: (op: RecordedOp) => boolean): number {
    return this.ops.filter(predicate).length;
  }

  logEvents(): string[] {
    return this.table('helios_gateway_logs').map(row => String(row.event_type));
  }
}

/** Claves de conflicto reales de las tablas de Helios. */
export const HELIOS_PRIMARY_KEYS: Record<string, string[]> = {
  helios_conversation_state: ['tenant_id', 'conversation_id'],
  helios_patient_profiles: ['tenant_id', 'contact_id'],
  helios_processing_batches: ['batch_key'],
  helios_chatwoot_outbox: ['outbox_key'],
  helios_handoff_events: ['handoff_id'],
  helios_notification_outbox: ['notification_key'],
  helios_message_idempotency: ['tenant_id', 'provider', 'message_id']
};
