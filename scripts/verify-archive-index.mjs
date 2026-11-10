#!/usr/bin/env node
/**
 * Story ID08 — read-only verification of the `daily_logs` archive composite index.
 *
 * Proves three things against whatever database `DATABASE_URL` points at:
 *
 *   (a) the index `daily_logs_kiosk_id_recorded_at_idx` exists on
 *       `public.daily_logs` with key columns `kiosk_id` then `recorded_at`,
 *       the latter in DESC order (plus the companion sync/read index);
 *   (b) `prisma/schema.prisma` declares exactly that index on the `DailyLog`
 *       model (`@@index([kioskId, recordedAt(sort: Desc)])`), so the live DB and
 *       the schema cannot drift apart silently;
 *   (c) the archive keyset query shape actually plans onto that index —
 *       `SELECT id, kiosk_id, recorded_at FROM daily_logs
 *          WHERE kiosk_id = $1 AND recorded_at <= $2
 *          ORDER BY recorded_at DESC, id DESC LIMIT 21`
 *       and the deeper cursor-shaped variant that also constrains
 *       `(recorded_at, id) < ($2, $3)`.
 *
 * READ-ONLY GUARANTEE: this script only issues SELECT and EXPLAIN. It never
 * creates, drops, alters or writes a row, so it is safe to point at the shared
 * live database. The only mutation it performs is the *session-local* planner
 * setting `SET LOCAL enable_seqscan = off` (inside a transaction that is rolled
 * back / never committed) — used because the live table is tiny (~10 rows) and a
 * default plan would otherwise be a Seq Scan.
 *
 * Usage (the URL comes from the environment, so one command covers every target):
 *   node scripts/verify-archive-index.mjs                       # DATABASE_URL from .env
 *   DATABASE_URL="postgresql://…" node scripts/verify-archive-index.mjs
 *   DATABASE_URL="…" node scripts/verify-archive-index.mjs --label=local-docker
 *
 * Exit code 0 = every check PASSed, 1 = at least one FAIL (or the run aborted).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * Bootstrap (same style as .work/lead/reconciliation-db-smoke.cjs):
 * run from the repo, use the repo's own dotenv + @prisma/client.
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

process.chdir(REPO);

const require = createRequire(import.meta.url);
// dotenv does not override an already-set variable, so an explicit
// `DATABASE_URL=… node …` invocation wins over the one in .env.
require(path.join(REPO, 'node_modules/dotenv')).config({ path: path.join(REPO, '.env') });

const { PrismaClient } = require(path.join(REPO, 'node_modules/@prisma/client'));

/* ------------------------------------------------------------------ *
 * Constants under test
 * ------------------------------------------------------------------ */

const SCHEMA_NAME = 'public';
const TABLE_NAME = 'daily_logs';
const INDEX_NAME = 'daily_logs_kiosk_id_recorded_at_idx';
const SYNC_INDEX_NAME = 'daily_logs_is_synced_is_read_by_manager_recorded_at_idx';

/** Key columns of `INDEX_NAME`, in order; `recorded_at` must be DESC. */
const EXPECTED_KEYS = [
  { name: 'kiosk_id', desc: false },
  { name: 'recorded_at', desc: true },
];
const EXPECTED_SYNC_KEYS = ['is_synced', 'is_read_by_manager', 'recorded_at'];

/** Normalised `@@index(...)` declarations expected inside `model DailyLog`. */
const EXPECTED_DECLARATIONS = [
  '@@index([kioskId,recordedAt(sort:Desc)])',
  '@@index([isSynced,isReadByManager,recordedAt])',
];

/** The archive query shape under test (spec §2 ID08 / archive-pagination.ts). */
const ARCHIVE_SQL =
  'SELECT id, kiosk_id, recorded_at FROM daily_logs ' +
  'WHERE kiosk_id = $1 AND recorded_at <= $2 ' +
  'ORDER BY recorded_at DESC, id DESC LIMIT 21';

/** Same query plus the keyset row-value predicate Prisma emits for `cursor: {id}`. */
const CURSOR_SQL =
  'SELECT id, kiosk_id, recorded_at FROM daily_logs ' +
  'WHERE kiosk_id = $1 AND recorded_at <= $2 AND (recorded_at, id) < ($2, $3) ' +
  'ORDER BY recorded_at DESC, id DESC LIMIT 21';

const SEQSCAN_OFF = 'SET LOCAL enable_seqscan = off';

/* ------------------------------------------------------------------ *
 * Tiny PASS/FAIL reporter
 * ------------------------------------------------------------------ */

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function info(message) {
  console.log(`INFO ${message}`);
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Human-readable target identity, credentials stripped. */
function describeTarget(url) {
  try {
    const parsed = new URL(url);
    const db = parsed.pathname.replace(/^\//, '') || '?';
    return `${parsed.hostname}:${parsed.port || '5432'}/${db}`;
  } catch {
    return '<unparsable DATABASE_URL>';
  }
}

function literal(value) {
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Runs EXPLAIN inside a transaction with session-local planner settings. */
async function explain(prisma, sql, params, settings = [SEQSCAN_OFF]) {
  return prisma.$transaction(
    async (tx) => {
      for (const statement of settings) await tx.$executeRawUnsafe(statement);
      const rows = await tx.$queryRawUnsafe(`EXPLAIN ${sql}`, ...params);
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    },
    { timeout: 20_000 },
  );
}

function printPlan(planText) {
  for (const line of planText.split('\n')) console.log(`     ${line}`);
}

/** All indexes on the probed table, name -> definition. */
async function listIndexes(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.relname AS index_name, pg_get_indexdef(i.indexrelid) AS indexdef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY c.relname`,
    SCHEMA_NAME,
    TABLE_NAME,
  );
  return new Map(rows.map((r) => [r.index_name, r.indexdef]));
}

/** Key columns of one index, in order, with their per-column definition text. */
async function indexKeyColumns(prisma, indexName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.n::int AS position,
            pg_get_indexdef(i.indexrelid, s.n::int, true) AS coldef
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       CROSS JOIN generate_series(1, i.indnkeyatts) AS s(n)
      WHERE n.nspname = $1 AND t.relname = $2 AND c.relname = $3
      ORDER BY s.n`,
    SCHEMA_NAME,
    TABLE_NAME,
    indexName,
  );
  return rows.map((r) => String(r.coldef).trim());
}

/**
 * `indoption` bit 1 = DESC (bit 2 = NULLS FIRST). Returned as one flag per key.
 * int2vector is 0-based and renders as space-separated values.
 */
async function indexKeyDirections(prisma, indexName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT i.indoption::text AS indoption
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.relname = $3`,
    SCHEMA_NAME,
    TABLE_NAME,
    indexName,
  );
  if (rows.length === 0) return [];
  return String(rows[0].indoption)
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => (Number(part) & 1) === 1);
}

/** The `model DailyLog { … }` block from schema.prisma, or null. */
function dailyLogModelBlock(source) {
  const match = /model\s+DailyLog\s*\{([\s\S]*?)\n\}/.exec(source);
  return match ? match[1] : null;
}

/**
 * Picks the kiosk to plan against: the one with the most logs. Realistic, and it
 * makes the plan exercise the `kiosk_id` equality prefix.
 */
async function pickKiosk(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT kiosk_id, count(*)::int AS n
       FROM daily_logs GROUP BY kiosk_id ORDER BY n DESC, kiosk_id ASC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Cursor rows at three depths of one kiosk's history, newest-first. */
async function pickCursors(prisma, kioskId, total) {
  const one = async (order, offset = 0, params = []) => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, recorded_at FROM daily_logs WHERE kiosk_id = $1
        ORDER BY recorded_at ${order}, id ${order} OFFSET ${offset} LIMIT 1`,
      ...params,
    );
    return rows[0];
  };
  const newest = await one('DESC', 0, [kioskId]);
  const oldest = await one('ASC', 0, [kioskId]);
  const medianOffset = Math.max(0, Math.floor((total - 1) / 2));
  const median = medianOffset === 0 ? newest : await one('DESC', medianOffset, [kioskId]);
  return { newest, median, oldest };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const labelArg = process.argv.find((a) => a.startsWith('--label='));
const LABEL = labelArg ? labelArg.slice('--label='.length) : '';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    check('DATABASE_URL is set', false, 'no DATABASE_URL in env and none found in .env');
    return;
  }
  const target = describeTarget(url);
  const label = LABEL ? `${LABEL} (${target})` : target;

  console.log('='.repeat(78));
  console.log(`verify-archive-index — target: ${label}`);
  console.log(`repo: ${REPO}`);
  console.log('='.repeat(78));

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$connect();

    /* ---- 0. target identity ------------------------------------- */
    section('target');
    const versionRows = await prisma.$queryRawUnsafe('SELECT version() AS v');
    info(`postgres: ${versionRows[0].v}`);
    const countRows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM ${SCHEMA_NAME}.${TABLE_NAME}`,
    );
    const rowCount = countRows[0].n;
    info(`${TABLE_NAME}: ${rowCount} row(s)`);
    check('target is reachable and daily_logs is queryable', true, `${label}, ${rowCount} rows`);

    /* ---- (a) index shape ---------------------------------------- */
    section('(a) live index definition');
    const indexes = await listIndexes(prisma);
    info(`indexes on ${SCHEMA_NAME}.${TABLE_NAME}: ${[...indexes.keys()].join(', ')}`);

    const indexDef = indexes.get(INDEX_NAME);
    check(
      `index ${INDEX_NAME} exists`,
      Boolean(indexDef),
      indexDef ?? 'not found in pg_indexes',
    );

    if (!indexDef) {
      console.log('\nCannot continue without the index — aborting.');
      return;
    }

    const keyDefs = await indexKeyColumns(prisma, INDEX_NAME);
    const directions = await indexKeyDirections(prisma, INDEX_NAME);
    info(`key columns: ${JSON.stringify(keyDefs)}`);
    info(`key directions (bit1 = DESC): ${JSON.stringify(directions)}`);

    const keyNames = keyDefs.map((d) => d.replace(/\s+(DESC|ASC)(\s+NULLS\s+(FIRST|LAST))?$/i, '').trim());
    check(
      `key columns are exactly [${EXPECTED_KEYS.map((k) => k.name).join(', ')}] in order`,
      keyNames.length === EXPECTED_KEYS.length &&
        keyNames.every((n, i) => n === EXPECTED_KEYS[i].name),
      `got ${JSON.stringify(keyNames)}`,
    );
    // `pg_get_indexdef(oid, colno, pretty)` returns the key *expression* only
    // (it omits DESC / opclass), so the ordering is asserted from `indoption`
    // and from the full index definition text instead.
    check(
      'recorded_at key column is DESC',
      directions[1] === true && /(^|[\s(,"])recorded_at"?\s+DESC\b/i.test(indexDef),
      `indoption DESC bit=${directions[1]}, indexdef=${JSON.stringify(indexDef)}`,
    );
    check(
      'kiosk_id key column is ASC (equality prefix, order irrelevant)',
      directions[0] === false,
      `indoption DESC bit=${directions[0]}`,
    );

    const syncDef = indexes.get(SYNC_INDEX_NAME);
    check(
      `companion index ${SYNC_INDEX_NAME} exists`,
      Boolean(syncDef),
      syncDef ?? 'not found in pg_indexes',
    );
    if (syncDef) {
      const syncKeys = (await indexKeyColumns(prisma, SYNC_INDEX_NAME)).map((d) =>
        d.replace(/\s+(DESC|ASC)(\s+NULLS\s+(FIRST|LAST))?$/i, '').trim(),
      );
      check(
        `companion index columns are [${EXPECTED_SYNC_KEYS.join(', ')}]`,
        JSON.stringify(syncKeys) === JSON.stringify(EXPECTED_SYNC_KEYS),
        `got ${JSON.stringify(syncKeys)}`,
      );
    }

    /* ---- (b) schema.prisma declaration -------------------------- */
    section('(b) prisma/schema.prisma declares it');
    const schemaPath = path.join(REPO, 'prisma', 'schema.prisma');
    let block = null;
    try {
      const source = fs.readFileSync(schemaPath, 'utf8');
      block = dailyLogModelBlock(source);
      check('prisma/schema.prisma readable', true, schemaPath);
    } catch (error) {
      check('prisma/schema.prisma readable', false, error.message);
    }
    check('model DailyLog block found', Boolean(block), block ? 'parsed' : 'not found');
    if (block) {
      const normalized = block.replace(/\s+/g, '');
      for (const declaration of EXPECTED_DECLARATIONS) {
        check(
          `DailyLog declares ${declaration}`,
          normalized.includes(declaration),
          normalized.includes(declaration) ? 'declared' : 'declaration missing',
        );
      }
      check(
        'DailyLog maps to table daily_logs',
        normalized.includes('@@map("daily_logs")'),
        '@@map("daily_logs")',
      );
    }

    /* ---- (c)/(d) EXPLAIN ---------------------------------------- */
    section('(c)/(d) EXPLAIN — planner must use the index');

    const busiest = await pickKiosk(prisma);
    check('daily_logs has at least one row to plan against', Boolean(busiest), busiest ? `kiosk ${busiest.kiosk_id} with ${busiest.n} row(s)` : 'table is empty');
    if (!busiest) return;

    const { newest, median, oldest } = await pickCursors(prisma, busiest.kiosk_id, busiest.n);
    info(`planning kiosk: ${busiest.kiosk_id} (${busiest.n} rows)`);
    info(`cursor depths — newest: ${newest.recorded_at.toISOString()} / median: ${median.recorded_at.toISOString()} / oldest: ${oldest.recorded_at.toISOString()}`);

    const shapes = [
      { key: 'archive', sql: ARCHIVE_SQL, name: 'archive query (kiosk_id + recorded_at <= cursor)' },
      { key: 'cursor', sql: CURSOR_SQL, name: 'keyset cursor query (+ (recorded_at, id) < cursor row)' },
    ];

    const planCache = new Map();
    const runPlan = async (shape, cursor, settings = [SEQSCAN_OFF]) => {
      const cacheKey = `${shape.key}|${cursor.recorded_at.toISOString()}|${cursor.id}|${settings.join(';')}`;
      if (!planCache.has(cacheKey)) {
        const params = [busiest.kiosk_id, cursor.recorded_at];
        if (shape.key === 'cursor') params.push(cursor.id);
        planCache.set(cacheKey, await explain(prisma, shape.sql, params, settings));
      }
      return planCache.get(cacheKey);
    };

    // Deep pages are what this index exists for ("pagination pull to old data"),
    // so both are required checks.
    for (const shape of shapes) {
      for (const [depth, cursor] of [
        ['median history row', median],
        ['oldest history row', oldest],
      ]) {
        const plan = await runPlan(shape, cursor);
        console.log(`\n  [${shape.key} @ ${depth}] cursor recorded_at=${cursor.recorded_at.toISOString()} id=${cursor.id}`);
        console.log(`  ${SEQSCAN_OFF}; EXPLAIN ${shape.sql}`);
        printPlan(plan);
        check(
          `${shape.name} uses ${INDEX_NAME} @ ${depth}`,
          plan.toLowerCase().includes(INDEX_NAME.toLowerCase()),
          plan.toLowerCase().includes(INDEX_NAME.toLowerCase())
            ? 'index named in plan'
            : 'index NOT named in plan — see plan above',
        );
      }
    }

    // Corroboration: the same plan with values inlined instead of bound, so a
    // prepared-statement generic plan cannot be blamed for the result.
    section('corroboration — inlined literals (no bind parameters)');
    for (const shape of shapes) {
      const cursor = median;
      const inlined = shape.sql
        .replace(/\$1/g, literal(busiest.kiosk_id))
        .replace(/\$2/g, literal(cursor.recorded_at))
        .replace(/\$3/g, literal(cursor.id));
      const plan = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(SEQSCAN_OFF);
          const rows = await tx.$queryRawUnsafe(`EXPLAIN ${inlined}`);
          return rows.map((r) => r['QUERY PLAN']).join('\n');
        },
        { timeout: 20_000 },
      );
      console.log(`\n  [${shape.key} inlined @ median]`);
      printPlan(plan);
      check(
        `${shape.name} uses ${INDEX_NAME} with inlined literals`,
        plan.toLowerCase().includes(INDEX_NAME.toLowerCase()),
        plan.toLowerCase().includes(INDEX_NAME.toLowerCase()) ? 'index named in plan' : 'index NOT named in plan',
      );
    }

    // Disclosure, not an assertion: the newest-row upper bound (an `endDate` of
    // "now" on a first page) is a non-selective range. On a tiny table the
    // planner may legitimately prefer another index — reported raw so the
    // evidence is complete, and never silently swallowed.
    section('disclosure — newest-row upper bound (non-selective range)');
    for (const shape of shapes) {
      const plan = await runPlan(shape, newest, [SEQSCAN_OFF]);
      console.log(`\n  [${shape.key} @ newest row] cursor recorded_at=${newest.recorded_at.toISOString()}`);
      printPlan(plan);
      const mentioned = plan.toLowerCase().includes(INDEX_NAME.toLowerCase());
      const otherIndex = /on\s+(daily_logs_[a-z_]+)/i.exec(plan);
      info(
        `${shape.key} @ newest row ${mentioned ? `uses ${INDEX_NAME}` : `does NOT use ${INDEX_NAME}`}` +
          (mentioned ? '' : ` (plan's index: ${otherIndex ? otherIndex[1] : 'n/a'})`),
      );
    }

    // Native plan + real server-side cost, informational. The planner is left at
    // its defaults here (no enable_seqscan override), and because the shared DB
    // is reached over a high-latency tunnel the *client* wall time is meaningless
    // — reporting Postgres' own `Execution Time` instead.
    section('informational — default planner settings, server-side timing (EXPLAIN ANALYZE)');
    for (const shape of shapes) {
      const params = [busiest.kiosk_id, median.recorded_at];
      if (shape.key === 'cursor') params.push(median.id);
      const plan = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${shape.sql}`, ...params);
      const text = plan.map((r) => r['QUERY PLAN']).join('\n');
      console.log(`\n  [${shape.key} @ median, default settings]`);
      printPlan(text);
      const execution = /Execution Time: ([\d.]+) ms/.exec(text);
      const planning = /Planning Time: ([\d.]+) ms/.exec(text);
      info(
        `${shape.key} @ median — index=${text.includes(INDEX_NAME) ? 'yes' : 'no'}, ` +
          `planning=${planning ? planning[1] : '?'} ms, execution=${execution ? execution[1] : '?'} ms ` +
          '(server-side; wall time over the tunnel is not meaningful)',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error('\nVERIFY ABORTED', error);
    results.push({ name: 'verification completed', ok: false });
  })
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${'='.repeat(78)}`);
    console.log(
      `RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} checks passed`,
    );
    if (failed.length > 0) console.log(`FAILED: ${failed.map((r) => r.name).join('; ')}`);
    console.log('='.repeat(78));
    process.exitCode = failed.length === 0 ? 0 : 1;
  });
