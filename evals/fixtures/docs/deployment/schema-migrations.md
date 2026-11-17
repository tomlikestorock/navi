# Deploying schema migrations

Change the database schema in two phases: expand, then contract. The expand
release adds the new column or table while old code still runs. The contract
release removes the old shape once no deploy reads it.

Never drop a column in the same deploy that stops writing to it. A rollback
plan must cover a half-applied migration, so keep every step idempotent.

Run migrations as an explicit deploy step, ahead of the application release.
Test the migration against a production-sized copy before it reaches real
production data.
