import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Stream } from 'stream';
import request from 'supertest';
import { inflateSync } from 'zlib';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// ───────────────────────────────────────────────────────────
//  Story ID 07 – verify exported CSV / PDF data accuracy and formatting
//  against the filtered database records (real Postgres, DATABASE_URL).
//
//  Seeds a throwaway kiosk (plus a second "other" kiosk) with readings on
//  and around the October 2026 period boundaries, downloads
//  GET /api/kiosk/reports/export?format=csv|pdf, and checks that every total
//  in the file equals the SUM the database itself computes (Prisma
//  `aggregate`) for exactly the same filter, and that every detail row is
//  the stored record.
//
//  Manual check: set REPORT_EXPORT_DIR=<folder> before running and the
//  downloaded October CSV/PDF are written there to open by hand.
//
//  Everything created here is removed in afterAll.
// ───────────────────────────────────────────────────────────

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const KIOSK_ID = `KIOSK-REPORT-E2E-${RUN_ID}`;
const OTHER_KIOSK_ID = `KIOSK-REPORT-E2E-OTHER-${RUN_ID}`;
const EXPORT_URL = '/api/kiosk/reports/export';

interface SeedLog {
  key: string;
  kioskId: string;
  operatorId: string | null;
  waterType: 'COMMERCIAL' | 'SUBSIDIZED';
  meterVolume: number;
  reportedCash: number;
  expectedRevenue: number;
  variance: number;
  isAnomaly: boolean;
  recordedAt: string;
  /** Part of KIOSK_ID's October 2026 report. */
  inOctober: boolean;
}

const seed: SeedLog[] = [
  // Last millisecond of September – must be excluded from October.
  { key: 'sep-edge', kioskId: KIOSK_ID, operatorId: 'OP-001', waterType: 'COMMERCIAL', meterVolume: 11.11, reportedCash: 22.22, expectedRevenue: 22.22, variance: 0, isAnomaly: false, recordedAt: '2026-09-30T23:59:59.999Z', inOctober: false },
  // First millisecond of October – startDate is inclusive.
  { key: 'oct-start', kioskId: KIOSK_ID, operatorId: 'OP-001', waterType: 'COMMERCIAL', meterVolume: 100.25, reportedCash: 190.5, expectedRevenue: 200.5, variance: -10, isAnomaly: false, recordedAt: '2026-10-01T00:00:00.000Z', inOctober: true },
  { key: 'oct-05', kioskId: KIOSK_ID, operatorId: null, waterType: 'SUBSIDIZED', meterVolume: 45.75, reportedCash: 91.5, expectedRevenue: 91.5, variance: 0, isAnomaly: false, recordedAt: '2026-10-05T08:30:00.000Z', inOctober: true },
  { key: 'oct-15-noon', kioskId: KIOSK_ID, operatorId: 'OP-002', waterType: 'COMMERCIAL', meterVolume: 300, reportedCash: 640.4, expectedRevenue: 600, variance: 40.4, isAnomaly: true, recordedAt: '2026-10-15T12:00:00.000Z', inOctober: true },
  // Last millisecond of a single day – a date-only endDate covers the whole day.
  { key: 'oct-15-end', kioskId: KIOSK_ID, operatorId: 'OP-002', waterType: 'COMMERCIAL', meterVolume: 0.01, reportedCash: 0, expectedRevenue: 0.02, variance: -0.02, isAnomaly: false, recordedAt: '2026-10-15T23:59:59.999Z', inOctober: true },
  // Comma and quote in the transaction id – CSV escaping must keep the cell intact.
  { key: 'oct-20-"q",comma', kioskId: KIOSK_ID, operatorId: 'OP-003', waterType: 'SUBSIDIZED', meterVolume: 1234.56, reportedCash: 2400, expectedRevenue: 2469.12, variance: -69.12, isAnomaly: false, recordedAt: '2026-10-20T09:15:00.000Z', inOctober: true },
  // Last millisecond of October – a date-only endDate is inclusive.
  { key: 'oct-end', kioskId: KIOSK_ID, operatorId: 'OP-001', waterType: 'COMMERCIAL', meterVolume: 77.7, reportedCash: 155.4, expectedRevenue: 155.4, variance: 0, isAnomaly: false, recordedAt: '2026-10-31T23:59:59.999Z', inOctober: true },
  // First millisecond of November – must be excluded.
  { key: 'nov-edge', kioskId: KIOSK_ID, operatorId: 'OP-001', waterType: 'COMMERCIAL', meterVolume: 22.22, reportedCash: 44.44, expectedRevenue: 44.44, variance: 0, isAnomaly: false, recordedAt: '2026-11-01T00:00:00.000Z', inOctober: false },
  // Another kiosk inside October – excluded by the kioskId filter.
  { key: 'other-oct', kioskId: OTHER_KIOSK_ID, operatorId: 'OP-009', waterType: 'COMMERCIAL', meterVolume: 999.99, reportedCash: 1000, expectedRevenue: 1999.98, variance: -999.98, isAnomaly: true, recordedAt: '2026-10-10T10:00:00.000Z', inOctober: false },
];

const txnOf = (key: string) => `TXN-REPORT-${RUN_ID}-${key}`;
const idOf = (key: string) => `report-e2e-${RUN_ID}-${key.replace(/[^a-z0-9-]/gi, '')}`;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

interface DbTotals {
  count: number;
  volume: number;
  revenue: number;
  expected: number;
  variance: number;
  ratio: number;
}

interface ParsedCsv {
  meta: Record<string, string>;
  summary: Record<string, string>;
  header: string[];
  rows: Record<string, string>[];
}

/** Minimal RFC 4180 line splitter (the report never puts newlines in a cell). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function parseReportCsv(text: string): ParsedCsv {
  const lines = text.split('\r\n');
  const summaryAt = lines.indexOf('SUMMARY METRICS');
  const detailAt = lines.indexOf('DETAILED RECORDS');
  expect(summaryAt).toBeGreaterThan(0);
  expect(detailAt).toBeGreaterThan(summaryAt);

  const meta: Record<string, string> = {};
  for (const line of lines.slice(1, summaryAt)) {
    if (!line) continue;
    const [key, value] = splitCsvLine(line);
    meta[key] = value;
  }

  expect(lines[summaryAt + 1]).toBe('Metric,Value');
  const summary: Record<string, string> = {};
  for (const line of lines.slice(summaryAt + 2, detailAt)) {
    if (!line) continue;
    const [key, value] = splitCsvLine(line);
    summary[key] = value;
  }

  const header = splitCsvLine(lines[detailAt + 1]);
  const rows = lines
    .slice(detailAt + 2)
    .filter((line) => line !== '')
    .map((line) => {
      const cells = splitCsvLine(line);
      expect(cells).toHaveLength(header.length);
      return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    });

  return { meta, summary, header, rows };
}

/**
 * Extracts the visible text lines of a pdfkit document: each FlateDecode
 * content stream is inflated and every `[<hex> kern <hex> …] TJ` array is
 * decoded (WinAnsi ≈ latin1) into one line.
 */
function extractPdfLines(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  const streamStart = /stream\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = streamStart.exec(raw))) {
    const begin = match.index + match[0].length;
    const end = raw.indexOf('endstream', begin);
    if (end < 0) break;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(begin, end)).toString('latin1');
    } catch {
      continue; // not a compressed content stream (e.g. font data)
    }
    for (const tj of content.matchAll(/\[((?:<[0-9a-fA-F]*>|[\s\d.-])*)\]\s*TJ/g)) {
      const text = [...tj[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map((hex) => Buffer.from(hex[1], 'hex').toString('latin1'))
        .join('');
      lines.push(text);
    }
  }
  return lines;
}

/**
 * Joins wrapped PDF lines into one whitespace-normalised string. pdfkit wraps
 * at spaces and also after a hyphen (long ids like `TXN-…-oct-|start`); a
 * hyphen wrap is re-joined without a space.
 */
const pdfText = (lines: string[]) =>
  lines
    .reduce((text, line) => (text === '' ? line : text.endsWith('-') ? text + line : `${text} ${line}`), '')
    .replace(/\s+/g, ' ');

/**
 * Collects the raw response bytes. `res` is typed as `Stream` – the base
 * class of superagent's Response – so it fits supertest's `.parse()` signature.
 */
const binaryParser = (
  res: Stream,
  callback: (err: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const messageOf = (body: { message?: string | string[] }) =>
  ([] as string[]).concat(body.message ?? []).join(' | ');

describe('E-report export accuracy vs database (Story ID 07, e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get<PrismaService>(PrismaService);

    await prisma.dailyLog.deleteMany({
      where: { kioskId: { in: [KIOSK_ID, OTHER_KIOSK_ID] } },
    });
    await prisma.kiosk.deleteMany({ where: { id: { in: [KIOSK_ID, OTHER_KIOSK_ID] } } });
    await prisma.kiosk.createMany({
      data: [
        { id: KIOSK_ID, status: 'ONLINE', lastHeartbeat: new Date() },
        { id: OTHER_KIOSK_ID, status: 'ONLINE', lastHeartbeat: new Date() },
      ],
    });
    await prisma.dailyLog.createMany({
      data: seed.map((log) => ({
        id: idOf(log.key),
        transactionId: txnOf(log.key),
        kioskId: log.kioskId,
        operatorId: log.operatorId,
        waterType: log.waterType,
        meterVolume: log.meterVolume,
        reportedCash: log.reportedCash,
        expectedRevenue: log.expectedRevenue,
        variance: log.variance,
        isAnomaly: log.isAnomaly,
        // Synced so the Google Sheets scheduler never picks these rows up.
        isSynced: true,
        recordedAt: new Date(log.recordedAt),
      })),
    });
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.dailyLog.deleteMany({
        where: { kioskId: { in: [KIOSK_ID, OTHER_KIOSK_ID] } },
      });
      await prisma.kiosk.deleteMany({ where: { id: { in: [KIOSK_ID, OTHER_KIOSK_ID] } } });
      await prisma.$disconnect();
    } catch {
      // ignore cleanup errors
    }
    await app?.close();
  }, 60000);

  // ── helpers ────────────────────────────────────────────────

  const exportCsv = (query: Record<string, string>) =>
    request(app.getHttpServer()).get(EXPORT_URL).query({ format: 'csv', ...query });

  const exportPdf = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get(EXPORT_URL)
      .query({ format: 'pdf', ...query })
      .buffer(true)
      .parse(binaryParser);

  /** The database's own totals for a filter (SQL SUM / COUNT). */
  const dbTotals = async (where: object): Promise<DbTotals> => {
    const agg = await prisma.dailyLog.aggregate({
      where,
      _count: { _all: true },
      _sum: { meterVolume: true, reportedCash: true, expectedRevenue: true, variance: true },
    });
    const expected = round2(agg._sum.expectedRevenue ?? 0);
    const variance = round2(agg._sum.variance ?? 0);
    return {
      count: agg._count._all,
      volume: round2(agg._sum.meterVolume ?? 0),
      revenue: round2(agg._sum.reportedCash ?? 0),
      expected,
      variance,
      ratio: expected === 0 ? 0 : round2((variance / expected) * 100),
    };
  };

  const dbRows = (where: object) =>
    prisma.dailyLog.findMany({ where, orderBy: { recordedAt: 'asc' } });

  const octoberWhere = {
    kioskId: KIOSK_ID,
    recordedAt: {
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lte: new Date('2026-10-31T23:59:59.999Z'),
    },
  };

  const expectCsvSummary = (summary: Record<string, string>, db: DbTotals) => {
    expect(summary['Total Volume Dispensed (L)']).toBe(db.volume.toFixed(2));
    expect(summary['Total Revenue Collected']).toBe(db.revenue.toFixed(2));
    expect(summary['Total Expected Revenue']).toBe(db.expected.toFixed(2));
    expect(summary['Total Variance']).toBe(db.variance.toFixed(2));
    expect(summary['Discrepancy Ratio (%)']).toBe(`${db.ratio.toFixed(2)}%`);
    expect(summary['Total Records']).toBe(String(db.count));
  };

  const expectPdfSummary = (text: string, db: DbTotals) => {
    expect(text).toContain(`Total Volume Dispensed: ${db.volume.toFixed(2)} Liters`);
    expect(text).toContain(`Total Revenue Collected: ${db.revenue.toFixed(2)}`);
    expect(text).toContain(`Total Expected Revenue: ${db.expected.toFixed(2)}`);
    expect(text).toContain(`Total Variance: ${db.variance.toFixed(2)}`);
    expect(text).toContain(`Discrepancy Ratio: ${db.ratio.toFixed(2)}%`);
    expect(text).toContain(`Total Records: ${db.count}`);
  };

  const saveForManualCheck = (name: string, body: Buffer | string) => {
    const dir = process.env.REPORT_EXPORT_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  };

  // ── 1. fixtures ────────────────────────────────────────────

  it('the database holds the seeded October records (test oracle sanity check)', async () => {
    const inOctober = seed.filter((log) => log.inOctober);
    const db = await dbTotals(octoberWhere);

    expect(db.count).toBe(inOctober.length);
    expect(db.volume).toBe(round2(inOctober.reduce((s, l) => s + l.meterVolume, 0)));
    expect(db.revenue).toBe(round2(inOctober.reduce((s, l) => s + l.reportedCash, 0)));
    expect(db.expected).toBe(round2(inOctober.reduce((s, l) => s + l.expectedRevenue, 0)));
    expect(db.variance).toBe(round2(inOctober.reduce((s, l) => s + l.variance, 0)));
    // 1758.27 L, 3477.80 collected, 3516.54 expected, −38.74 variance, −1.10 %
    expect(db).toEqual({
      count: 6,
      volume: 1758.27,
      revenue: 3477.8,
      expected: 3516.54,
      variance: -38.74,
      ratio: -1.1,
    });
  });

  // ── 2. CSV ─────────────────────────────────────────────────

  describe('CSV export', () => {
    it('downloads as an attachment with the CSV MIME type, period filename and exact length', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);

      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-10.csv"',
      );
      expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.text, 'utf-8'));
      saveForManualCheck('kiosk-report-2026-10.csv', res.text);
    });

    it('has the documented layout: title, period, generated-at, summary block, detail header', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const lines = res.text.split('\r\n');
      const csv = parseReportCsv(res.text);

      expect(lines[0]).toBe('AZERTY Water Kiosk - Operational Metrics Report');
      expect(csv.meta['Report Period']).toBe('2026-10-01 to 2026-10-31');
      expect(Number.isNaN(Date.parse(csv.meta['Generated At']))).toBe(false);
      expect(Object.keys(csv.summary)).toEqual([
        'Total Volume Dispensed (L)',
        'Total Revenue Collected',
        'Total Expected Revenue',
        'Total Variance',
        'Discrepancy Ratio (%)',
        'Total Records',
      ]);
      expect(csv.header).toEqual([
        'Log ID',
        'Transaction ID',
        'Kiosk ID',
        'Operator ID',
        'Water Type',
        'Meter Volume (L)',
        'Reported Cash',
        'Expected Revenue',
        'Variance',
        'Discrepancy (%)',
        'Anomaly',
        'Recorded At',
      ]);
      // Every money/volume figure is printed with exactly two decimals.
      for (const key of Object.keys(csv.summary).filter((k) => k !== 'Total Records')) {
        expect(csv.summary[key]).toMatch(/^-?\d+\.\d{2}%?$/);
      }
    });

    it('summary totals equal the database SUM for the selected period', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      expectCsvSummary(parseReportCsv(res.text).summary, await dbTotals(octoberWhere));
    });

    it('lists exactly the period records, oldest first, each matching its database row', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const { rows } = parseReportCsv(res.text);
      const db = await dbRows(octoberWhere);

      expect(rows.map((r) => r['Transaction ID'])).toEqual(db.map((d) => d.transactionId));
      rows.forEach((row, i) => {
        const d = db[i];
        expect(row).toEqual({
          'Log ID': d.id,
          'Transaction ID': d.transactionId,
          'Kiosk ID': d.kioskId,
          'Operator ID': d.operatorId ?? '',
          'Water Type': d.waterType,
          'Meter Volume (L)': d.meterVolume.toFixed(2),
          'Reported Cash': d.reportedCash.toFixed(2),
          'Expected Revenue': d.expectedRevenue.toFixed(2),
          Variance: d.variance.toFixed(2),
          'Discrepancy (%)':
            d.expectedRevenue === 0
              ? '0.00%'
              : `${((d.variance / d.expectedRevenue) * 100).toFixed(2)}%`,
          Anomaly: String(d.isAnomaly),
          'Recorded At': d.recordedAt.toISOString(),
        });
      });
    });

    it('detail rows add up to the summary totals (the file is internally consistent)', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const { summary, rows } = parseReportCsv(res.text);
      const sum = (col: string) => round2(rows.reduce((s, r) => s + Number(r[col]), 0)).toFixed(2);

      expect(sum('Meter Volume (L)')).toBe(summary['Total Volume Dispensed (L)']);
      expect(sum('Reported Cash')).toBe(summary['Total Revenue Collected']);
      expect(sum('Expected Revenue')).toBe(summary['Total Expected Revenue']);
      expect(sum('Variance')).toBe(summary['Total Variance']);
      expect(String(rows.length)).toBe(summary['Total Records']);
    });

    it('includes both inclusive boundaries and excludes the neighbouring months and the other kiosk', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const txns = parseReportCsv(res.text).rows.map((r) => r['Transaction ID']);

      expect(txns).toContain(txnOf('oct-start'));
      expect(txns).toContain(txnOf('oct-end'));
      expect(txns).not.toContain(txnOf('sep-edge'));
      expect(txns).not.toContain(txnOf('nov-edge'));
      expect(res.text).not.toContain(OTHER_KIOSK_ID);
    });

    it('escapes a transaction id containing a comma and quotes so the cell survives a round trip', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-20', endDate: '2026-10-20' }).expect(200);
      const { rows } = parseReportCsv(res.text);

      expect(res.text).toContain(`"${txnOf('oct-20-"q",comma').replace(/"/g, '""')}"`);
      expect(rows).toHaveLength(1);
      expect(rows[0]['Transaction ID']).toBe(txnOf('oct-20-"q",comma'));
      expect(rows[0]['Meter Volume (L)']).toBe('1234.56');
    });

    it('a single-day date-only range covers that whole UTC day', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-15', endDate: '2026-10-15' }).expect(200);
      const csv = parseReportCsv(res.text);
      const where = {
        kioskId: KIOSK_ID,
        recordedAt: {
          gte: new Date('2026-10-15T00:00:00.000Z'),
          lte: new Date('2026-10-15T23:59:59.999Z'),
        },
      };

      expect(csv.rows.map((r) => r['Transaction ID'])).toEqual([
        txnOf('oct-15-noon'),
        txnOf('oct-15-end'),
      ]);
      expectCsvSummary(csv.summary, await dbTotals(where));
    });

    it('full ISO timestamps give the same report as the date-only range, and a 1 ms earlier end drops the last record', async () => {
      const dateOnly = parseReportCsv(
        (await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200)).text,
      );
      const iso = parseReportCsv(
        (
          await exportCsv({
            kioskId: KIOSK_ID,
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-31T23:59:59.999Z',
          }).expect(200)
        ).text,
      );
      expect(iso.summary).toEqual(dateOnly.summary);
      expect(iso.rows).toEqual(dateOnly.rows);

      const shorter = parseReportCsv(
        (
          await exportCsv({
            kioskId: KIOSK_ID,
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-31T23:59:59.998Z',
          }).expect(200)
        ).text,
      );
      expect(shorter.rows.map((r) => r['Transaction ID'])).not.toContain(txnOf('oct-end'));
      expectCsvSummary(
        shorter.summary,
        await dbTotals({
          kioskId: KIOSK_ID,
          recordedAt: {
            gte: new Date('2026-10-01T00:00:00.000Z'),
            lte: new Date('2026-10-31T23:59:59.998Z'),
          },
        }),
      );
    });

    it('a multi-month range sums every month in it and names the file by both months', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2026-09-01', endDate: '2026-11-30' }).expect(200);
      const csv = parseReportCsv(res.text);

      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-09-to-2026-11.csv"',
      );
      expect(csv.rows).toHaveLength(seed.filter((l) => l.kioskId === KIOSK_ID).length);
      expectCsvSummary(
        csv.summary,
        await dbTotals({
          kioskId: KIOSK_ID,
          recordedAt: {
            gte: new Date('2026-09-01T00:00:00.000Z'),
            lte: new Date('2026-11-30T23:59:59.999Z'),
          },
        }),
      );
    });

    it('an all-kiosks export of the period matches the database SUM over every kiosk', async () => {
      const res = await exportCsv({ startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const csv = parseReportCsv(res.text);
      const db = await dbTotals({ recordedAt: octoberWhere.recordedAt });
      const txns = csv.rows.map((r) => r['Transaction ID']);

      expect(txns).toContain(txnOf('oct-start'));
      expect(txns).toContain(txnOf('other-oct'));
      expect(csv.summary['Total Records']).toBe(String(db.count));
      // Shared DB: other teams' rows are summed too, in a different order than
      // SQL does, so allow one cent of floating-point rounding difference.
      const near = (key: string, expected: number) =>
        expect(Math.abs(Number(csv.summary[key].replace('%', '')) - expected)).toBeLessThanOrEqual(0.011);
      near('Total Volume Dispensed (L)', db.volume);
      near('Total Revenue Collected', db.revenue);
      near('Total Expected Revenue', db.expected);
      near('Total Variance', db.variance);
      near('Discrepancy Ratio (%)', db.ratio);
    });

    it('an empty period exports zero totals and no detail rows', async () => {
      const res = await exportCsv({ kioskId: KIOSK_ID, startDate: '2027-01-01', endDate: '2027-01-31' }).expect(200);
      const csv = parseReportCsv(res.text);

      expect(csv.rows).toHaveLength(0);
      expect(csv.summary).toEqual({
        'Total Volume Dispensed (L)': '0.00',
        'Total Revenue Collected': '0.00',
        'Total Expected Revenue': '0.00',
        'Total Variance': '0.00',
        'Discrepancy Ratio (%)': '0.00%',
        'Total Records': '0',
      });
    });
  });

  // ── 3. PDF ─────────────────────────────────────────────────

  describe('PDF export', () => {
    it('downloads a well-formed PDF attachment with the PDF MIME type and exact length', async () => {
      const res = await exportPdf({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const pdf = res.body as Buffer;

      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kiosk-report-2026-10.pdf"',
      );
      expect(Number(res.headers['content-length'])).toBe(pdf.length);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
      saveForManualCheck('kiosk-report-2026-10.pdf', pdf);
    });

    it('shows the title, period and kiosk in the header', async () => {
      const res = await exportPdf({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const text = pdfText(extractPdfLines(res.body as Buffer));

      expect(text).toContain('AZERTY Water Kiosk - Operational Metrics Report');
      expect(text).toContain('Period: 2026-10-01 to 2026-10-31');
      expect(text).toContain(`Kiosk: ${KIOSK_ID}`);
      expect(text).toContain('Summary Totals');
      expect(text).toContain('Transaction Records');
    });

    it('summary totals equal the database SUM for the selected period', async () => {
      const res = await exportPdf({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      expectPdfSummary(pdfText(extractPdfLines(res.body as Buffer)), await dbTotals(octoberWhere));
    });

    it('lists every period record with its database values, and nothing outside the period', async () => {
      const res = await exportPdf({ kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' }).expect(200);
      const text = pdfText(extractPdfLines(res.body as Buffer));
      const db = await dbRows(octoberWhere);

      const recordLines = text.match(/\d+\. \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Kiosk:/g) ?? [];
      expect(recordLines).toHaveLength(db.length);

      db.forEach((d, i) => {
        const stamp = d.recordedAt.toISOString().slice(0, 19).replace('T', ' ');
        expect(text).toContain(
          `${i + 1}. [${stamp}] Kiosk: ${d.kioskId} | Txn: ${d.transactionId} | ` +
            `Vol: ${d.meterVolume.toFixed(2)}L | Cash: ${d.reportedCash.toFixed(2)} | ` +
            `Var: ${d.variance.toFixed(2)} | Anomaly: ${d.isAnomaly}`,
        );
      });
      expect(text).not.toContain(txnOf('sep-edge'));
      expect(text).not.toContain(txnOf('nov-edge'));
      expect(text).not.toContain(txnOf('other-oct'));
    });

    it('PDF and CSV of the same period report identical totals', async () => {
      const query = { kioskId: KIOSK_ID, startDate: '2026-10-01', endDate: '2026-10-31' };
      const csv = parseReportCsv((await exportCsv(query).expect(200)).text).summary;
      const text = pdfText(extractPdfLines((await exportPdf(query).expect(200)).body as Buffer));

      expect(text).toContain(`Total Volume Dispensed: ${csv['Total Volume Dispensed (L)']} Liters`);
      expect(text).toContain(`Total Revenue Collected: ${csv['Total Revenue Collected']}`);
      expect(text).toContain(`Total Expected Revenue: ${csv['Total Expected Revenue']}`);
      expect(text).toContain(`Total Variance: ${csv['Total Variance']}`);
      expect(text).toContain(`Discrepancy Ratio: ${csv['Discrepancy Ratio (%)']}`);
      expect(text).toContain(`Total Records: ${csv['Total Records']}`);
    });

    it('an empty period exports zero totals and the "no records" notice', async () => {
      const res = await exportPdf({ kioskId: KIOSK_ID, startDate: '2027-01-01', endDate: '2027-01-31' }).expect(200);
      const text = pdfText(extractPdfLines(res.body as Buffer));

      expectPdfSummary(text, { count: 0, volume: 0, revenue: 0, expected: 0, variance: 0, ratio: 0 });
      expect(text).toContain('No transaction records found for the selected period.');
    });
  });

  // ── 4. invalid range guard ────────────────────────────────

  describe('startDate > endDate is blocked', () => {
    it.each(['csv', 'pdf'])('returns 400 and no %s file', async (format) => {
      const res = await request(app.getHttpServer())
        .get(EXPORT_URL)
        .query({ format, kioskId: KIOSK_ID, startDate: '2026-10-31', endDate: '2026-10-01' })
        .expect(400);

      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(messageOf(res.body)).toContain('startDate must not be after endDate');
    });
  });
});
