#!/usr/bin/env bash
# Two boundaries that cannot be enforced by types, checked as text instead.
#
# CI/pre-deploy yoxlaması: npm run check:access
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1. systemScope() icazə yoxlamasını atlayır — sessiyası olmayan cron/MCP üçün.
#    Onun səhifə və route kodunda görünməsi icazənin unudulduğu deməkdir.
ALLOWED='^(scripts/|mcp/|src/lib/supervisor/|src/lib/access\.ts)'
hits=$(grep -rn "systemScope" --include="*.ts" --include="*.tsx" src scripts mcp 2>/dev/null \
       | grep -vE "$ALLOWED" || true)

if [ -n "$hits" ]; then
  echo "systemScope() icazəsiz yerdə işlədilib — icazə yoxlaması atlanıb:"
  echo "$hits"
  fail=1
else
  echo "ok: systemScope yalnız icazəli yerlərdədir"
fi

# 2. Katibe mesajları "oxundu" etmir.
#
# The panel now keeps its own read markers (katibe.read_marker), and that makes
# this check worth more than it was: the words "read" and "unread" are all over
# the UI code, so the day someone reaches for the WhatsApp side of it the
# reasoning will sound entirely natural. It is not. A customer must never see a
# blue tick because somebody here opened the conversation to look at it.
#
# Baileys is configured with readMessages:false (src/lib/evolution.ts); this
# catches the other two ways in — flipping that flag, or calling the endpoint
# directly.
read_hits=$(grep -rni "markMessageAsRead\|chat/markMessage\|sendReadReceipt\|readMessages: *true\|readStatus: *true" \
            --include="*.ts" --include="*.tsx" src scripts mcp 2>/dev/null || true)

if [ -n "$read_hits" ]; then
  echo "WhatsApp-a oxundu siqnalı göndərilir — Katibe bunu etməməlidir:"
  echo "$read_hits"
  fail=1
else
  echo "ok: heç bir yerdən oxundu siqnalı göndərilmir"
fi

# 3. computeSalesStatsWithoutAccessCheck() requireAdmin-i atlayır.
#
# Satıcı statistikası bütün satıcıları yan-yana göstərir və birinci qaydadakı
# marka onu tuta bilmir: funksiya ScopedInstanceId almır, çünki bir instansa
# yox, hamısına baxır. Ona görə icazə funksiyanın öz içindədir (getSalesStats),
# atlanan variant isə yalnız sessiyası olmayan skriptlər üçündür. Onun src/app/
# altında görünməsi admin ekranının hamıya açıldığı deməkdir.
# sales-history.ts də icazəlidir: şəkil yazan cron-un sessiyası yoxdur, yəni
# o, supervisor/ ilə eyni sinifdəndir. Səhifənin oxuduğu funksiyalar
# (readInsights, ensureTranslations) isə öz requireAdmin-ini çağırır.
SALES_ALLOWED='^(scripts/|src/lib/sales-stats\.ts|src/lib/sales-history\.ts)'
sales_hits=$(grep -rn "computeSalesStatsWithoutAccessCheck" --include="*.ts" --include="*.tsx" src scripts mcp 2>/dev/null \
             | grep -vE "$SALES_ALLOWED" || true)

if [ -n "$sales_hits" ]; then
  echo "computeSalesStatsWithoutAccessCheck() icazəsiz yerdə işlədilib:"
  echo "$sales_hits"
  fail=1
else
  echo "ok: satıcı statistikası yalnız requireAdmin-dən keçir"
fi

exit $fail
