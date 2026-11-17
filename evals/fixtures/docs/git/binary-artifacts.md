# Keep binaries out of git

Build artifacts and large binaries bloat the object store forever. Even after
deletion they stay in history, so every clone pays for them.

Use git-lfs for assets that must live beside the code, or publish outputs to a
package registry. Add build directories to `.gitignore` before the first
commit.

A repository that already contains large artifacts needs a history rewrite, not
just a new ignore rule. Coordinate that rewrite like any other history change.
