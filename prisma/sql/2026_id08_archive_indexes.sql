-- =============================================================================
-- Story ID08 — composite indexes for the daily_logs archive / pagination path
-- =============================================================================
--
-- WHY
-- ---
-- The manager archive endpoint pages backwards through one kiosk's history
-- (`GET /api/kiosk/logs/archive?kioskId=…&cursor=<id>&limit=20`, see
-- `src/kiosk/log-inspection.service.ts` + `src/kiosk/archive-pagination.ts`).
-- It reads newest-first with a total order — `recorded_at DESC, id DESC` — and
-- uses keyset pagination to pull ever-older rows without OFFSET. That is the
-- "pagination pull to old data" that must not degrade into a full table scan and
-- block real-time ingest. The unread/notification path additionally filters on
-- the sync + read flags plus `recorded_at`.
--
-- These two indexes mirror exactly what Prisma derives from `prisma/schema.prisma`
-- (`DailyLog`):
--
--   @@index([kioskId, recordedAt(sort: Desc)])        -> daily_logs_kiosk_id_recorded_at_idx
--   @@index([isSynced, isReadByManager, recordedAt])  -> daily_logs_is_synced_is_read_by_manager_recorded_at_idx
--
-- Prisma builds index names from the *mapped* table/column names, so the
-- camelCase fields above become the snake_case names below. The `DESC` on
-- `recorded_at` lets the archive's newest-first keyset scan walk the index
-- forward with no sort; `kiosk_id` is the equality prefix that keeps the scan
-- scoped to a single kiosk.
--
-- IDEMPOTENCE
-- -----------
-- `CREATE INDEX IF NOT EXISTS` is a strict no-op when an index of that name
-- already exists (Postgres emits a NOTICE and skips it), so this file is safe to
-- run on every deploy and repeatedly against the same database. Note that the
-- guard matches on the *name* only — it will not detect an index that exists
-- under this name with a different definition, so after changing a definition
-- here you must drop the old index first.
--
-- No `CONCURRENTLY`: it cannot run inside a transaction block. On a large live
-- table, run each statement separately, outside any transaction, with
-- `CONCURRENTLY` inserted after `INDEX` to avoid holding a write lock.
--
-- VERIFICATION
-- ------------
--   node scripts/verify-archive-index.mjs
-- (read-only: it only issues SELECT / EXPLAIN and never mutates a shared table).
-- =============================================================================

-- Archive keyset pagination: one kiosk, newest-first, deep pages.
CREATE INDEX IF NOT EXISTS "daily_logs_kiosk_id_recorded_at_idx"
  ON "public"."daily_logs" ("kiosk_id", "recorded_at" DESC);

-- Unread / pending-sync lookups scoped to a time window.
CREATE INDEX IF NOT EXISTS "daily_logs_is_synced_is_read_by_manager_recorded_at_idx"
  ON "public"."daily_logs" ("is_synced", "is_read_by_manager", "recorded_at");
