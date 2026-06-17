# Releasing `@asciidev/eve-box`

This package is intended to ship on npm as the public scoped package `@asciidev/eve-box`.

Do **not** publish from an Ascii task agent or CI unless release automation is added later. For the first release, publish from the user's local computer after PR #26 is merged and the merged base branch is pulled locally.

## First public npm release

From the user's local checkout, after the PR is merged:

```bash
# 1. Update the local checkout to the merged branch.
# Use whichever branch received PR #26.
git checkout main
git pull --ff-only origin main

# 2. Verify npm auth. If this fails, run `npm login` and then retry `npm whoami`.
npm whoami
npm ping

# 3. Install exactly from the lockfile.
npm ci

# 4. Run the real Box-backed Eve adapter tests.
# Use a real key from the Box dashboard/API keys tab.
# These are the Eve correctness tests; they require BOX_API_KEY and use one shared Box with ttlSeconds=300.
export BOX_API_KEY=box_your_real_key_here
npm run test:eve-box

# 5. Build the package artifacts.
npm run build

# 6. Packaging safety check only: inspect package contents without publishing.
# This is not an Eve correctness test.
npm pack --dry-run

# 7. Packaging safety check only: exercise npm publish validation without publishing.
# This is not an Eve correctness test.
npm publish --dry-run --access public

# 8. Publish the first public scoped version.
npm publish --access public

# 9. Confirm npm now serves the released version.
npm view @asciidev/eve-box version
```

Notes:

- Keep the package name exactly `@asciidev/eve-box` (all lowercase), matching npm scoped-package rules and the `package.json` name.
- The first publish of a scoped package must include `--access public`; `publishConfig.access` is also set to `public` as a safeguard.
- The Eve correctness step is only `npm run test:eve-box` with a real `BOX_API_KEY`. Do not present `npm pack --dry-run`, `npm publish --dry-run`, or any generic test command as Eve correctness evidence.
- The Eve adapter tests are `test/eve-box-backend.test.ts`; they require `BOX_API_KEY`, create one shared Box with `ttlSeconds: 300`, and use no fake Box client, mocks, stubs, or dry-run path.
- Do not rotate secrets, publish from this agent, deploy infrastructure, or run production migrations as part of the release.
- If `npm view @asciidev/eve-box version` returns a version before the first publish, choose a new unpublished semver version in `package.json` before publishing.
