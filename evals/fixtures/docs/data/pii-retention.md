# Personal data retention

Customer records must be deleted when the retention window closes. The window
is defined per data class, not per table.

Backups age out on their own schedule, so a purge job must also cover restores:
a record deleted from the live store can reappear from an old backup. Track
those exceptions explicitly.

Do not delete rows that a legal hold covers. Report each purge run, including
the count of records deleted and any that were skipped.
