# Canary promotion thresholds

A canary receives a small share of traffic, then grows. Each promotion step
compares the canary's error rate against the service error budget.

- Start at 1% traffic and hold for fifteen minutes.
- Move to 10%, then 50%, only while errors stay inside the budget.
- Stop the rollout when the error rate exceeds the budget for two windows.

Promotion is a decision, not a timer: a healthy canary may wait longer, and an
unhealthy one never reaches full traffic. Page the on-call engineer when the
rollout halts.
