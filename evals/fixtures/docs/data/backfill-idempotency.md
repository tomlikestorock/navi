# Writing a safe backfill

Backfills run against production data while the application keeps writing.
Make the job idempotent so a retry never double-applies a change.

Batch writes and checkpoint progress after each batch. A failed run resumes
from its last checkpoint instead of scanning everything again.

Throttle the job against read replicas, and verify row counts before and after.
A backfill is not a migration: schema changes still belong to the deploy
pipeline.
