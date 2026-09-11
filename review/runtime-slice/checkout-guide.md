# Runtime slice — owner checkout guide

Proven path to review the runtime slice on top of the authentication-only
PR #1 head, without touching the mixed review-branch tip. Verified
2026-09-11 against the exact SHAs below (both patches apply with zero
conflicts; `tsc` and all three slice suites pass in the resulting tree).

## Inputs

- Auth base (PR #1 base): `5640a8475bded2dd785d5839b0f9a4773668435c`
- Auth head (PR #1 head): `0d851e96718593732d5c2cd06e72657a09220211`
- Patch 1 (authorization draft): `patches/01-authorization-draft.patch`
  (`6ba588e1096ed6696276894c91fd79a323e52ffb`)
- Patch 2 (runtime implementation): `patches/02-runtime-slice-impl.patch`
  (`e0df60b6bedfba33fd0677b5b75d7486d8adaa46`)

## Commands (owner-authorized checkout only)

```sh
git fetch origin
git checkout -b review/runtime-slice 0d851e96718593732d5c2cd06e72657a09220211
git apply --check patches/01-authorization-draft.patch
git apply patches/01-authorization-draft.patch
git apply --check patches/02-runtime-slice-impl.patch
git apply patches/02-runtime-slice-impl.patch
npm ci --ignore-scripts
npx tsc --noEmit
npx tsx scripts/test-action-authorization.ts
npx tsx scripts/test-sanitizer-bytes.ts
npx tsx scripts/test-agent-runtime-authz.ts
```

Expected: both `--check` runs exit 0 with no output; `tsc` exits 0;
all three suites print their `=== ALL ... PASSED ===` trailers.

## Live smoke (separate, needs Linux + userns/netns/prlimit)

```sh
npm rebuild node-pty --nodedir=/usr/local   # only if no linux prebuild; needs local headers
npx tsx scripts/smoke-agent-runtime-live.ts
```

Expected: `LIVE SMOKE END — pass=32 fail=0`. This is iteration
evidence on the local Node version, not supported-runtime evidence.

## Notes

- No merge, force-push, or PR retarget is authorized by this guide.
- PR #1 stays scoped to its 9 authentication-only files; the slice adds
  its own files plus narrowly-scoped edits, all inside the new slice.
- `npm run build` is blocked in-sandbox by Google Fonts fetch on the
  pristine base too (pre-existing environmental limitation, proven
  identical with and without the slice). Route-graph coverage comes from
  `tsc` plus the esbuild bundle probe documented in slice-verification.md.
