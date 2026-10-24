---
paths:
  - 'apps/magical/src/**/*.ts'
skills:
  - calendar-wire-format
---

The calendar wire format is not Calendar API v3. It is Closure-compiled protobuf in positional
arrays and `IDX` is the source of truth. Read
[`calendar-sync.md`'s wire format](../../docs/magical/calendar-wire-format.md#what-the-endpoint-returns)
before changing the decoder, plus its
[range payload](../../docs/magical/calendar-wire-format.md#range-payload) and
[Google Tasks](../../docs/magical/google-tasks.md)
sections. The `calendar-wire-format` skill loads with this rule and
carries the decoder and recurrence guardrails.
