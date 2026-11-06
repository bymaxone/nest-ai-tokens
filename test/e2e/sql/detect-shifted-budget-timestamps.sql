-- Budgets whose window start comes from createdAt: a 'total' window, or a custom window, with no anchorAt. A budget
-- stamped by the database in its session zone has createdAt shifted by that zone's offset. hoursFromNow is createdAt
-- less the current UTC instant, so it is conclusive for a budget created in the last day: about +9 for Asia/Tokyo and
-- about -3 for America/Sao_Paulo. For an older budget, compare createdAt with the time you know it was created.
-- sessionZone is the zone of the session running this query.
SELECT current_setting('TimeZone') AS "sessionZone", b."id", b."tenantId", b."scopeType", b."scopeId", b."window",
       b."createdAt",
       round((extract(epoch FROM (b."createdAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))) / 3600.0)::numeric, 1) AS "hoursFromNow"
FROM "ai_budgets" b
WHERE b."anchorAt" IS NULL AND (b."window" = 'total' OR b."window" LIKE 'custom:%')
ORDER BY b."createdAt";
