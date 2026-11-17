# Responding to a vulnerable dependency

Run the dependency audit, then identify which version of the affected package
you actually ship. A vulnerable dependency that is never loaded still deserves
a fix, but its urgency follows exploitability.

Pin a patched release when one exists. If it does not, document a compensating
control and the CVE it covers, then set a review date.

Upgrade one dependency at a time so a regressed test points at the real cause.
Never silence the audit without a recorded reason.
