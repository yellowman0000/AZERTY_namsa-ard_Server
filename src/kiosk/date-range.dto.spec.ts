import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DATE_RANGE_ORDER_MESSAGE,
  INVALID_END_DATE,
  INVALID_START_DATE,
  datesAreOrdered,
} from './dto/date-range.dto';
import { ExportReportQueryDto } from './dto/export-report.dto';
import { ListLogsQueryDto } from './dto/list-logs.dto';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';

async function constraintMessages(
  dto: new () => object,
  values: Record<string, unknown>,
): Promise<string[]> {
  const instance = plainToInstance(dto, values);
  const errors = await validate(instance);
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('DateRangeQueryDto (Story 06)', () => {
  it('accepts a date-only range', async () => {
    await expect(
      constraintMessages(ListLogsQueryDto, {
        startDate: '2026-11-01',
        endDate: '2026-11-30',
      }),
    ).resolves.toEqual([]);
  });

  it('accepts full ISO-8601 timestamps', async () => {
    await expect(
      constraintMessages(ListLogsQueryDto, {
        startDate: '2026-11-01T00:00:00.000Z',
        endDate: '2026-11-30T23:59:59.999Z',
      }),
    ).resolves.toEqual([]);
  });

  it('accepts a single bound', async () => {
    await expect(
      constraintMessages(ReconciliationQueryDto, { startDate: '2026-11-01' }),
    ).resolves.toEqual([]);
    await expect(
      constraintMessages(ReconciliationQueryDto, { endDate: '2026-11-30' }),
    ).resolves.toEqual([]);
  });

  it('rejects a reversed range on every metrics endpoint', async () => {
    const reversed = { startDate: '2026-11-30', endDate: '2026-11-01' };

    for (const dto of [ListLogsQueryDto, ExportReportQueryDto, ReconciliationQueryDto]) {
      await expect(constraintMessages(dto, reversed)).resolves.toContain(
        DATE_RANGE_ORDER_MESSAGE,
      );
    }
  });

  it('rejects a malformed start or end date', async () => {
    await expect(
      constraintMessages(ListLogsQueryDto, { startDate: '01/11/2026' }),
    ).resolves.toContain(INVALID_START_DATE);
    await expect(
      constraintMessages(ListLogsQueryDto, { endDate: 'yesterday' }),
    ).resolves.toContain(INVALID_END_DATE);
  });

  it('rejects a date that does not exist on the calendar', async () => {
    await expect(
      constraintMessages(ListLogsQueryDto, {
        startDate: '2026-02-31',
        endDate: '2026-03-01',
      }),
    ).resolves.toContain(INVALID_START_DATE);
  });

  it('treats an empty parameter as absent', async () => {
    await expect(
      constraintMessages(ListLogsQueryDto, { startDate: '', endDate: '' }),
    ).resolves.toEqual([]);
  });

  it('allows the exact same day for both bounds', async () => {
    await expect(
      constraintMessages(ExportReportQueryDto, {
        startDate: '2026-11-07',
        endDate: '2026-11-07',
      }),
    ).resolves.toEqual([]);
  });
});

describe('datesAreOrdered', () => {
  it('is true when a bound is missing or unparsable', () => {
    expect(datesAreOrdered(undefined, '2026-11-01')).toBe(true);
    expect(datesAreOrdered('2026-11-01', undefined)).toBe(true);
    expect(datesAreOrdered('not-a-date', '2026-11-01')).toBe(true);
  });

  it('compares actual instants, not just the date text', () => {
    expect(datesAreOrdered('2026-11-01', '2026-11-01')).toBe(true);
    expect(
      datesAreOrdered('2026-11-01T10:00:00.000Z', '2026-11-01T09:00:00.000Z'),
    ).toBe(false);
  });
});
