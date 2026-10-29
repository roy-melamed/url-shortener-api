import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * DB-free schema recorder — URL-8.
 *
 * Runs each migration's `up(pgm)` against a mock `MigrationBuilder` that records
 * `createTable`/`createIndex`/`createExtension` calls. This lets unit tests
 * assert the REAL schema the migrations produce (columns, checks, cascades,
 * indexes, PKs) without needing a live Postgres — so the CI privacy gate and
 * schema-contract checks run everywhere. The live-DB acceptance tests in
 * `tests/integration/db-schema.test.ts` then verify the same shape against a
 * real Postgres when one is available.
 */

export interface RecordedColumn {
  name: string;
  type?: string;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  default?: unknown;
  check?: string;
  references?: unknown;
  onDelete?: unknown;
}

export interface RecordedTable {
  name: string;
  columns: RecordedColumn[];
  constraints?: Record<string, unknown>;
}

export interface RecordedIndex {
  table: string | string[];
  columns: unknown;
  options?: Record<string, unknown>;
}

export interface RecordedSchema {
  tables: Map<string, RecordedTable>;
  indexes: RecordedIndex[];
  extensions: string[];
  tableOrder: string[];
}

type ColumnDefs = Record<string, unknown>;

/** Run a migration's `up` and capture everything it declares. */
export function recordMigration(up: (pgm: MigrationBuilder) => void): RecordedSchema {
  const schema: RecordedSchema = {
    tables: new Map(),
    indexes: [],
    extensions: [],
    tableOrder: [],
  };

  const pgm = {
    createTable(name: string, columns: ColumnDefs, options?: { constraints?: Record<string, unknown> }) {
      const cols: RecordedColumn[] = Object.entries(columns).map(([colName, def]) => {
        const d = (typeof def === 'string' ? { type: def } : def) as Record<string, unknown>;
        return { name: colName, ...d } as RecordedColumn;
      });
      schema.tables.set(name, { name, columns: cols, constraints: options?.constraints });
      schema.tableOrder.push(name);
    },
    createIndex(table: string | string[], columns: unknown, options?: Record<string, unknown>) {
      schema.indexes.push({ table, columns, options });
    },
    createExtension(ext: unknown) {
      schema.extensions.push(String(ext));
    },
    func(value: string) {
      return { __func: value };
    },
    now() {
      return { __func: 'now()' };
    },
    // Operations the URL-8 migrations do not use — accepted for completeness.
    dropTable() {},
    dropExtension() {},
    addConstraint() {},
    sql() {},
  };

  up(pgm as unknown as MigrationBuilder);
  return schema;
}

/** Combine several recorded migrations into one schema view. */
export function recordAll(migrations: Array<(pgm: MigrationBuilder) => void>): RecordedSchema {
  const combined: RecordedSchema = {
    tables: new Map(),
    indexes: [],
    extensions: [],
    tableOrder: [],
  };
  for (const up of migrations) {
    const part = recordMigration(up);
    for (const [name, table] of part.tables) combined.tables.set(name, table);
    combined.indexes.push(...part.indexes);
    combined.extensions.push(...part.extensions);
    combined.tableOrder.push(...part.tableOrder);
  }
  return combined;
}
