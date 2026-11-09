import { BadRequestException, Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { PrismaService } from '../prisma.service';
import { ExportReportQueryDto } from './dto/export-report.dto';

const PRICE_PER_UNIT = 1;

export interface ReportSummary {
  totalRecords: number;
  totalVolume: number;
  totalRevenue: number;
  totalExpectedRevenue: number;
  totalVariance: number;
  discrepancyRatio: number;
  discrepancyRatioPercent: string;
}

export interface GeneratedReport {
  buffer: Buffer;
  contentType: string;
  filename: string;
  summary: ReportSummary;
}

function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str: string;
  if (typeof value === 'string') {
    str = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    str = value.toString();
  } else if (value instanceof Date) {
    str = value.toISOString();
  } else {
    str = JSON.stringify(value) ?? '';
  }

  if (
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatCsvRow(cells: unknown[]): string {
  return cells.map(formatCsvCell).join(',');
}

export function calculateReportSummary(logs: any[]): ReportSummary {
  let totalVolume = 0;
  let totalRevenue = 0;
  let totalExpectedRevenue = 0;
  let totalVariance = 0;

  for (const log of logs) {
    const volume = Number(log.meterVolume) || 0;
    const reportedCash = Number(log.reportedCash) || 0;
    const expected =
      log.expectedRevenue !== null && log.expectedRevenue !== undefined
        ? Number(log.expectedRevenue)
        : volume * PRICE_PER_UNIT;
    const variance =
      log.variance !== null && log.variance !== undefined
        ? Number(log.variance)
        : reportedCash - expected;

    totalVolume += volume;
    totalRevenue += reportedCash;
    totalExpectedRevenue += expected;
    totalVariance += variance;
  }

  totalVolume = Math.round((totalVolume + Number.EPSILON) * 100) / 100;
  totalRevenue = Math.round((totalRevenue + Number.EPSILON) * 100) / 100;
  totalExpectedRevenue =
    Math.round((totalExpectedRevenue + Number.EPSILON) * 100) / 100;
  totalVariance = Math.round((totalVariance + Number.EPSILON) * 100) / 100;

  const discrepancyRatio =
    totalExpectedRevenue === 0
      ? 0
      : Math.round(
          ((totalVariance / totalExpectedRevenue) * 100 + Number.EPSILON) * 100,
        ) / 100;

  return {
    totalRecords: logs.length,
    totalVolume,
    totalRevenue,
    totalExpectedRevenue,
    totalVariance,
    discrepancyRatio,
    discrepancyRatioPercent: `${discrepancyRatio.toFixed(2)}%`,
  };
}

export function getReportFilename(
  format: 'csv' | 'pdf',
  startDate?: string,
  endDate?: string,
): string {
  const ext = format.toLowerCase();
  if (startDate) {
    const startMatch = /^(\d{4}-\d{2})/.exec(startDate);
    const endMatch = endDate ? /^(\d{4}-\d{2})/.exec(endDate) : null;
    if (startMatch && (!endMatch || startMatch[1] === endMatch[1])) {
      return `kiosk-report-${startMatch[1]}.${ext}`;
    }
    if (startMatch && endMatch) {
      return `kiosk-report-${startMatch[1]}-to-${endMatch[1]}.${ext}`;
    }
    const cleanStart = startDate.slice(0, 10);
    return `kiosk-report-${cleanStart}.${ext}`;
  }
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `kiosk-report-${yyyy}-${mm}.${ext}`;
}

export function generateCsvReport(
  summary: ReportSummary,
  logs: any[],
  periodStr: string,
): Buffer {
  const lines: string[] = [];

  // Header / Title
  lines.push('AZERTY Water Kiosk - Operational Metrics Report');
  lines.push(`Report Period,${formatCsvCell(periodStr)}`);
  lines.push(`Generated At,${formatCsvCell(new Date().toISOString())}`);
  lines.push('');

  // Summary Metrics Section
  lines.push('SUMMARY METRICS');
  lines.push('Metric,Value');
  lines.push(`Total Volume Dispensed (L),${summary.totalVolume.toFixed(2)}`);
  lines.push(`Total Revenue Collected,${summary.totalRevenue.toFixed(2)}`);
  lines.push(
    `Total Expected Revenue,${summary.totalExpectedRevenue.toFixed(2)}`,
  );
  lines.push(`Total Variance,${summary.totalVariance.toFixed(2)}`);
  lines.push(`Discrepancy Ratio (%),${summary.discrepancyRatio.toFixed(2)}%`);
  lines.push(`Total Records,${summary.totalRecords}`);
  lines.push('');

  // Detailed Records Section
  lines.push('DETAILED RECORDS');
  lines.push(
    [
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
    ].join(','),
  );

  for (const log of logs) {
    const volume = Number(log.meterVolume) || 0;
    const reported = Number(log.reportedCash) || 0;
    const expected =
      log.expectedRevenue !== null && log.expectedRevenue !== undefined
        ? Number(log.expectedRevenue)
        : volume * PRICE_PER_UNIT;
    const variance =
      log.variance !== null && log.variance !== undefined
        ? Number(log.variance)
        : reported - expected;
    const disc =
      expected === 0
        ? '0.00%'
        : `${((variance / expected) * 100).toFixed(2)}%`;
    const recordedAt =
      log.recordedAt instanceof Date
        ? log.recordedAt.toISOString()
        : String(log.recordedAt);

    lines.push(
      formatCsvRow([
        log.id,
        log.transactionId,
        log.kioskId,
        log.operatorId ?? '',
        log.waterType ?? 'COMMERCIAL',
        volume.toFixed(2),
        reported.toFixed(2),
        expected.toFixed(2),
        variance.toFixed(2),
        disc,
        Boolean(log.isAnomaly),
        recordedAt,
      ]),
    );
  }

  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

export async function generatePdfReport(
  summary: ReportSummary,
  logs: any[],
  periodStr: string,
  kioskId?: string,
): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks: Buffer[] = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  const bufferPromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Title
  doc
    .fontSize(18)
    .font('Helvetica-Bold')
    .text('AZERTY Water Kiosk - Operational Metrics Report', {
      align: 'center',
    });
  doc.moveDown(0.3);

  // Subtitle
  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#555555')
    .text(
      `Period: ${periodStr}  |  Kiosk: ${kioskId || 'All Kiosks'}  |  Generated: ${new Date().toISOString()}`,
      { align: 'center' },
    );
  doc.moveDown(0.8);

  // Horizontal separator
  doc
    .strokeColor('#cccccc')
    .lineWidth(1)
    .moveTo(40, doc.y)
    .lineTo(555, doc.y)
    .stroke();
  doc.moveDown(0.8);

  // Summary Totals Card / Section
  doc
    .fillColor('#000000')
    .fontSize(14)
    .font('Helvetica-Bold')
    .text('Summary Totals');
  doc.moveDown(0.4);

  doc.fontSize(10).font('Helvetica');
  const summaryLines = [
    `Total Volume Dispensed: ${summary.totalVolume.toFixed(2)} Liters`,
    `Total Revenue Collected: ${summary.totalRevenue.toFixed(2)}`,
    `Total Expected Revenue: ${summary.totalExpectedRevenue.toFixed(2)}`,
    `Total Variance: ${summary.totalVariance.toFixed(2)}`,
    `Discrepancy Ratio: ${summary.discrepancyRatio.toFixed(2)}%`,
    `Total Records: ${summary.totalRecords}`,
  ];

  for (const line of summaryLines) {
    doc.text(`•  ${line}`);
  }
  doc.moveDown(1);

  // Horizontal separator
  doc
    .strokeColor('#cccccc')
    .lineWidth(1)
    .moveTo(40, doc.y)
    .lineTo(555, doc.y)
    .stroke();
  doc.moveDown(0.8);

  // Detailed Records Section
  doc.fontSize(14).font('Helvetica-Bold').text('Transaction Records');
  doc.moveDown(0.4);

  if (logs.length === 0) {
    doc
      .fontSize(10)
      .font('Helvetica-Oblique')
      .fillColor('#777777')
      .text('No transaction records found for the selected period.');
  } else {
    doc.fontSize(9).font('Helvetica');
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (doc.y > 720) {
        doc.addPage();
      }

      const volume = Number(log.meterVolume) || 0;
      const reported = Number(log.reportedCash) || 0;
      const variance = Number(log.variance) || 0;
      const recordedAt =
        log.recordedAt instanceof Date
          ? log.recordedAt.toISOString().slice(0, 19).replace('T', ' ')
          : String(log.recordedAt).slice(0, 19).replace('T', ' ');

      const recordText = `${i + 1}. [${recordedAt}] Kiosk: ${log.kioskId} | Txn: ${log.transactionId} | Vol: ${volume.toFixed(2)}L | Cash: ${reported.toFixed(2)} | Var: ${variance.toFixed(2)} | Anomaly: ${Boolean(log.isAnomaly)}`;
      doc.fillColor('#333333').text(recordText);
    }
  }

  doc.end();
  return bufferPromise;
}

@Injectable()
export class ReportExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fetches records and compiles operational metrics report as CSV or PDF buffer.
   */
  async generateReport(query: ExportReportQueryDto): Promise<GeneratedReport> {
    const format = (query.format || 'csv').toLowerCase() as 'csv' | 'pdf';
    if (format !== 'csv' && format !== 'pdf') {
      throw new BadRequestException('format must be "csv" or "pdf"');
    }

    let start: Date | undefined;
    let end: Date | undefined;

    if (query.startDate !== undefined && query.startDate !== '') {
      start = new Date(query.startDate);
      if (Number.isNaN(start.getTime())) {
        throw new BadRequestException(
          'startDate must be a valid ISO-8601 date string',
        );
      }
    }

    if (query.endDate !== undefined && query.endDate !== '') {
      end = new Date(query.endDate);
      if (Number.isNaN(end.getTime())) {
        throw new BadRequestException(
          'endDate must be a valid ISO-8601 date string',
        );
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(query.endDate)) {
        end.setUTCHours(23, 59, 59, 999);
      }
    }

    if (start && end && start > end) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    const where: any = {};
    if (query.kioskId) {
      where.kioskId = query.kioskId.trim();
    }
    if (start || end) {
      where.recordedAt = {
        ...(start && { gte: start }),
        ...(end && { lte: end }),
      };
    }

    const logs =
      typeof this.prisma?.dailyLog?.findMany === 'function'
        ? await this.prisma.dailyLog.findMany({
            where: Object.keys(where).length > 0 ? where : undefined,
            orderBy: { recordedAt: 'asc' },
          })
        : [];

    const summary = calculateReportSummary(logs);
    const periodStr =
      query.startDate && query.endDate
        ? `${query.startDate} to ${query.endDate}`
        : query.startDate
          ? `From ${query.startDate}`
          : query.endDate
            ? `Up to ${query.endDate}`
            : 'All Time';

    const filename = getReportFilename(format, query.startDate, query.endDate);

    if (format === 'csv') {
      const buffer = generateCsvReport(summary, logs, periodStr);
      return {
        buffer,
        contentType: 'text/csv; charset=utf-8',
        filename,
        summary,
      };
    } else {
      const buffer = await generatePdfReport(
        summary,
        logs,
        periodStr,
        query.kioskId,
      );
      return {
        buffer,
        contentType: 'application/pdf',
        filename,
        summary,
      };
    }
  }
}
