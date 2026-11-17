# Committing secrets and rotating them

A credential committed to git is compromised the moment it is pushed. Assume
anyone with repository access has copied it.

Rotate the key immediately. Purging history is secondary and never sufficient:
old clones, caches and forks keep their copy. Revoke the old value so the leaked
key stops working.

Prefer short-lived credentials injected at deploy time. A secret scanner
catches repeats; it does not repair the first leak.
