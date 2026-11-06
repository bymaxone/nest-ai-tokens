-- Hash-chained usage records that share a predecessor. A chain is a line, so two records with the same prevHash mean
-- it forked. LedgerService.verifyChain recomputes each hash and checks that each predecessor exists, so it accepts a
-- fork; this query finds it. "ids" lists the records that name the same predecessor, oldest first.
SELECT r."tenantId", r."prevHash", count(*) AS "records", array_agg(r."id" ORDER BY r."createdAt", r."id") AS "ids"
FROM "ai_usage_records" r
WHERE r."prevHash" IS NOT NULL
GROUP BY r."tenantId", r."prevHash"
HAVING count(*) > 1;
