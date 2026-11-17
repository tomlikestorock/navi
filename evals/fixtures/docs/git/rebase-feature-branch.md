# Rebase a local feature branch

Rebasing rewrites unpublished history so the commit log stays linear. Do it on
a local feature branch, before review, while nobody else has your commits.

Once a branch is pushed and reviewed, prefer merge commits. Rewriting shared
history forces every reviewer to re-read the diff and invalidates their local
clone.

Before a rebase, confirm the branch has no upstream or that nobody tracks it.
After a conflict, finish the rebase rather than switching to a merge halfway
through.
