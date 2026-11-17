# Never force-push a shared branch

`git push --force` rewrites commits that other people have built on. On `main`
or any shared branch, a force-push erases their work and breaks their history.

Use `--force-with-lease` only on your own feature branch, and only before it is
reviewed. Once a shared branch is published, add commits instead of rewriting
it.

If a shared branch was force-pushed, everyone must reset to the remote and
re-apply local work. That is an incident, not a routine cleanup.
