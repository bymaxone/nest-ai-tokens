-- Usage records whose createdAt is far from their occurredAt. A record stamped by the database in its session zone
-- has createdAt and updatedAt shifted by that zone's offset (see "sessionZone"): hoursApart is about -3 for
-- America/Sao_Paulo and +9 for Asia/Tokyo. A record backfilled with an old occurredAt is also listed, so compare
-- hoursApart with the zone's offset; on a database whose zone is UTC nothing is shifted.
SELECT current_setting('TimeZone') AS "sessionZone", r."id", r."tenantId", r."idempotencyKey", r."status",
       r."occurredAt", r."createdAt",
       round((extract(epoch FROM (r."createdAt" - r."occurredAt")) / 3600.0)::numeric, 1) AS "hoursApart"
FROM "ai_usage_records" r
WHERE abs(extract(epoch FROM (r."createdAt" - r."occurredAt"))) > 60
ORDER BY r."createdAt";
