import { ListLogsQueryDto } from './list-logs.dto';

/**
 * Query for `GET /api/kiosk/logs/archive` (Story ID 08) – the historical
 * archive, newest first, paged with an opaque `cursor` (the `id` of the last
 * row of the previous page) and `limit` (1…100, default 20).
 *
 * Inherits `kioskId`, `cursor`, `limit`, `unseenOnly`, `startDate` and
 * `endDate` from {@link ListLogsQueryDto}: both read-only history endpoints
 * intentionally share one validated contract. A distinct type keeps the
 * archive route independently evolvable.
 */
export class ArchiveLogsQueryDto extends ListLogsQueryDto {}
