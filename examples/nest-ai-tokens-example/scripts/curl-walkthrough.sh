#!/usr/bin/env bash
# curl-walkthrough.sh — demonstrates all nest-ai-tokens-example endpoints.
#
# Prerequisites:
#   1. docker compose up -d                  (postgres + redis)
#   2. pnpm prisma:migrate && pnpm prisma:seed
#   3. pnpm start:dev                        (runs on :3000)

set -euo pipefail

BASE="http://localhost:3000"
TENANT="tenant-demo"
USER="user-demo"
ADMIN_HEADERS=(-H "x-tenant-id: $TENANT" -H "x-user-id: $USER" -H "x-role: admin")
USER_HEADERS=(-H "x-tenant-id: $TENANT" -H "x-user-id: $USER")

echo "=== 1. POST /ai/chat — post-hoc metering ==="
curl -s -X POST "$BASE/ai/chat" \
  "${USER_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain token metering in NestJS.","requestId":"req-demo-1"}' | jq .

echo ""
echo "=== 2. POST /ai/summarize — guard + interceptor (check headers) ==="
curl -sv -X POST "$BASE/ai/summarize" \
  "${USER_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d '{"text":"The nest-ai-tokens library provides AI token metering and billing primitives for NestJS applications, with support for multiple providers, wallets, budgets, and markup.","requestId":"req-demo-2"}' 2>&1 | grep -E "< X-AI-Tokens|^\{" | head -10

echo ""
echo "=== 3. GET /ai/me/usage — current status ==="
curl -s "$BASE/ai/me/usage" "${USER_HEADERS[@]}" | jq .

echo ""
echo "=== 4. POST /admin/grant — wallet credit grant ==="
curl -s -X POST "$BASE/admin/grant" \
  "${ADMIN_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER\",\"tenantId\":\"$TENANT\",\"amountNanoUsd\":\"10000000000\",\"reason\":\"demo grant\",\"idempotencyKey\":\"grant:$USER:demo\"}" | jq .

echo ""
echo "=== 5. POST /admin/budget — upsert plan budget ==="
curl -s -X POST "$BASE/admin/budget" \
  "${ADMIN_HEADERS[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":\"$USER\",\"tenantId\":\"$TENANT\",\"features\":[\"chat.reply\",\"doc.summarize\"],\"window\":\"month\",\"limitTokens\":\"1000000\"}" | jq .

echo ""
echo "=== 6. GET /ai/me/summary — usage report (last 30 days) ==="
FROM=$(date -v-30d +%Y-%m-%d 2>/dev/null || date -d '30 days ago' +%Y-%m-%d)
TO=$(date +%Y-%m-%d)
curl -s "$BASE/ai/me/summary?from=${FROM}&to=${TO}" "${USER_HEADERS[@]}" | jq .

echo ""
echo "=== 7. GET /admin/export — CSV download ==="
curl -s "$BASE/admin/export?tenantId=$TENANT&from=${FROM}&to=${TO}" \
  "${ADMIN_HEADERS[@]}" \
  -o /tmp/usage-export.csv
echo "Saved to /tmp/usage-export.csv ($(wc -l < /tmp/usage-export.csv) lines)"

echo ""
echo "=== Done. All endpoints demonstrated. ==="
