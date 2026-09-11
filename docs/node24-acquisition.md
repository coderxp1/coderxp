# Node 24 acquisition proposal (owner decision required)

Status: **PROPOSAL ONLY — no network-policy exception is assumed or used.**
Nothing in this file has been downloaded, installed, or executed in the
development sandbox. This exists so the owner can make the acquisition
decision with an exact artifact and an authenticated verification method.

## Why it is needed

`package.json` declares `"engines": { "node": "24.x" }`. Every result in this
repository's evidence files produced on `node v22.22.3` is labelled
**iteration evidence only** and does not satisfy the supported-runtime
requirement for PR #1 or for the agent-runtime slice.

## Recommended pin

| Field | Value |
|---|---|
| Version | **v24.21.0** (latest v24 LTS, "Krypton", released 2026-09-07) |
| Platform | linux-x64 (glibc), matching the deployment target |
| Artifact | `node-v24.21.0-linux-x64.tar.xz` |
| Source URL | `https://nodejs.org/download/release/v24.21.0/node-v24.21.0-linux-x64.tar.xz` |
| Canonical dist URL | `https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz` |
| Published SHA-256 | `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6` |

Rationale for v24.21.0 over the alternatives: it is the current v24 LTS
(maintenance start 2026-10-20, end of security fixes 2028-04-30), it satisfies
`engines: 24.x` exactly, and pinning the full patch version makes the native
`node-pty` rebuild reproducible. Node 26 is the Current line and is not LTS
until October 2026, so it is not recommended.

### Provenance of the checksum above — read this

The SHA-256 was **transcribed from the official
`https://nodejs.org/dist/v24.21.0/SHASUMS256.txt` listing**. It was **not
computed in the development sandbox**, because `nodejs.org` is unreachable
there (TLS handshake fails; `curl` exits 35, HTTP 000). Treat the value as
unverified input and re-derive it yourself as below. Do not skip the
signature check: a transcribed hash on its own proves nothing.

## Authenticated verification method

```sh
# 1. Fetch the release signing keys (Node.js release team).
gpg --keyserver hkps://keys.openpgp.org --recv-keys \
  DD8F2338BAE7501E3DD5AC78C273792F7D83545D   # Node.js Release Signing Key ring
# Verify against the published key list: https://github.com/nodejs/node#release-keys

# 2. Download the artifact, the checksum file, and its detached signature.
BASE=https://nodejs.org/dist/v24.21.0
curl -fsSLO "$BASE/node-v24.21.0-linux-x64.tar.xz"
curl -fsSLO "$BASE/SHASUMS256.txt"
curl -fsSLO "$BASE/SHASUMS256.txt.asc"

# 3. Verify the signature FIRST — this is what authenticates the checksums.
gpg --verify SHASUMS256.txt.asc SHASUMS256.txt
# Expect: "Good signature" from a key you confirmed in step 1.

# 4. Only then verify the artifact against the signed checksum list.
grep " node-v24.21.0-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
# Expect: node-v24.21.0-linux-x64.tar.xz: OK

# 5. Confirm the value matches the pin recorded above.
sha256sum node-v24.21.0-linux-x64.tar.xz
# Expect: fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
```

Stop and do not install if step 3 reports a bad or unknown-key signature, or
if step 4 or 5 disagrees.

## Install and post-install steps (after the owner authorises)

```sh
tar -xf node-v24.21.0-linux-x64.tar.xz -C /opt
export PATH=/opt/node-v24.21.0-linux-x64/bin:$PATH
node -p 'process.version'      # expect v24.21.0
```

Then, at the exact candidate SHA:

1. `rm -rf node_modules` and `npm ci` — forces a native rebuild of `node-pty`
   against the v24 ABI (`npm ci` runs its `prebuild.js || node-gyp rebuild`).
2. `npx tsc --noEmit` — type-check.
3. `npm test` — full aggregate suite.
4. `npm run build` — **unmodified** production build. Do not switch
   `app/layout.tsx` to `next/font/local` to make the build pass; that changes
   the artifact under test.
5. `npx tsx scripts/smoke-agent-runtime-live.ts` — live PTY smoke.

Record the SHA under test and all five exit codes.

## Two independent prerequisites — do not conflate them

1. **Node 24** (this document) is required for supported-runtime evidence.
2. **A real PTY isolation provider** is a separate requirement and is *not*
   supplied by a Node 24 binary. The agent-runtime slice needs: `node-pty`
   (native PTY), `unshare -U -n -r` (user + network namespace), `prlimit`
   (resource caps), and a non-root uid. A Node 24 binary provides none of
   these. In the current sandbox all four are present and were verified
   directly (`unshare -U -n -r true` exits 0, uid 1001, node-pty allocates
   `/dev/pts/*`); on the owner's target host they must be confirmed
   independently before the live smoke can run there.

If either prerequisite is missing, the correct action is to mark the affected
check **blocked/unrun** with the missing prerequisite named — not to
substitute a host shell, a command stub, or a fake-success runtime.
