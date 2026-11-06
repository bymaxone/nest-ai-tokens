-- Usage records whose createdAt is far from their occurredAt. Versions before 1.1.8 let the database fill
-- createdAt and updatedAt in its session zone, so on a database whose zone is not UTC (see "sessionZone") those
-- two values are shifted by the zone's offset: hoursApart is about -3 for America/Sao_Paulo and +9 for Asia/Tokyo.
-- A record backfilled with an old occurredAt is also listed; compare hoursApart with the zone's offset.
SELECT current_setting('TimeZone') AS "sessionZone", r."id", r."tenantId", r."idempotencyKey", r."status",
       r."occurredAt", r."createdAt",
       round((extract(epoch FROM (r."createdAt" - r."occurredAt")) / 3600.0)::numeric, 1) AS "hoursApart"
FROM "ai_usage_records" r
WHERE abs(extract(epoch FROM (r."createdAt" - r."occurredAt"))) > 60
ORDER BY r."createdAt";
