# Release Process

This document describes how to cut a versioned release of DOMAgent and what happens automatically as a result.

---

## What Gets Released

Each release produces three artifacts:

| Artifact | Description |
|----------|-------------|
| `domagent-chrome-<version>.zip` | Chrome extension archive — load via `chrome://extensions` |
| `domagent-firefox-<version>.xpi` | Firefox extension archive — load via `about:debugging` |
| `domagent-mcp-<version>.tgz` | MCP server Node.js package |

A signed **SLSA Level 3 provenance file** (`multiple.intoto.jsonl`) is also attached to every release. It cryptographically links each artifact to the exact source commit and build workflow that produced it.

---

## Automated Pipeline

```
Developer pushes a git tag  (v0.2.0)
           │
           ▼
  release.yml workflow runs
  - Validates tag matches package.json version
  - Creates GitHub release  ──────────────────────────────────┐
                                                              │  "release created" event
                                                              ▼
                                          generator-generic-ossf-slsa3-publish.yml runs
                                          - Packages Chrome ZIP
                                          - Packages Firefox XPI
                                          - Packages MCP server tgz
                                          - SHA-256 hashes all three
                                          - SLSA generator signs provenance
                                            using GitHub OIDC token (non-falsifiable)
                                          - Uploads artifacts + provenance to release
```

---

## Pre-Release Checklist

Before tagging a release, go through this checklist:

- [ ] All tests pass (manual test checklist in [CONTRIBUTING.md](CONTRIBUTING.md))
- [ ] Extension loads without errors in Chrome (latest stable)
- [ ] Extension loads without errors in Firefox 109+
- [ ] MCP server starts without errors: `cd domagent-mcp && npm start`
- [ ] End-to-end: at least `navigate`, `click`, `get_screenshot` work correctly
- [ ] **`domagent-mcp/package.json` version is updated** to match the new tag
- [ ] `CHANGELOG.md` is updated (if you maintain one)

---

## How to Cut a Release

### Step 1 — Update the version in package.json

```bash
# Edit domagent-mcp/package.json and set "version" to the new version
# Example: "version": "0.2.0"
```

Commit the version bump:

```bash
git add domagent-mcp/package.json
git commit -m "update version to 0.2.0"
git push origin main
```

### Step 2 — Tag the release

The tag must match the format `v<major>.<minor>.<patch>` exactly.

```bash
git tag v0.2.0
git push origin v0.2.0
```

> Pushing the tag triggers the `release.yml` workflow automatically.

### Step 3 — Monitor the workflows

Go to the **Actions** tab on GitHub and watch:

1. **Release** workflow — validates version and creates the GitHub release
2. **SLSA generic generator** workflow — builds artifacts, signs provenance, uploads to release

Both must complete with a green checkmark. If either fails, see [Troubleshooting](#troubleshooting) below.

### Step 4 — Verify the release

On the **Releases** page, confirm the release has:

- `domagent-chrome-<version>.zip`
- `domagent-firefox-<version>.xpi`
- `domagent-mcp-<version>.tgz`
- `multiple.intoto.jsonl` (the SLSA provenance file)

---

## Verifying Provenance (for Users)

Users who want to verify that a release artifact was produced from the official source and build pipeline can use the [slsa-verifier](https://github.com/slsa-framework/slsa-verifier) tool.

### Install the verifier

```bash
go install github.com/slsa-framework/slsa-verifier/v2/cli/slsa-verifier@latest
```

Or download a pre-built binary from the [slsa-verifier releases page](https://github.com/slsa-framework/slsa-verifier/releases).

### Verify an artifact

```bash
# Download the artifact and provenance from the GitHub release, then:
slsa-verifier verify-artifact domagent-chrome-0.2.0.zip \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/vaishnavucv/domagent

slsa-verifier verify-artifact domagent-firefox-0.2.0.xpi \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/vaishnavucv/domagent

slsa-verifier verify-artifact domagent-mcp-0.2.0.tgz \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/vaishnavucv/domagent
```

A successful verification prints:

```
Verified build using builder "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v1.4.0" at commit <SHA>
PASSED: SLSA verification passed
```

This confirms:
- The artifact was built from the `vaishnavucv/domagent` repository
- The build ran on GitHub Actions (not a developer's local machine)
- The exact source commit is recorded and tamper-evident
- The provenance was signed with GitHub's OIDC token (not a long-lived secret)

---

## Pre-Release / Beta Tags

To cut a pre-release, append a hyphen suffix to the tag:

```bash
git tag v0.2.0-beta.1
git push origin v0.2.0-beta.1
```

The `release.yml` workflow automatically marks releases with a hyphen in the tag name as **pre-release** on GitHub. The SLSA workflow still runs and attaches provenance.

---

## Troubleshooting

### "version mismatch" error in Release workflow

The git tag version does not match `domagent-mcp/package.json`. Update `package.json` first, push to `main`, then re-create the tag:

```bash
git tag -d v0.2.0          # delete local tag
git push --delete origin v0.2.0  # delete remote tag
# fix package.json, commit, push
git tag v0.2.0
git push origin v0.2.0
```

### SLSA workflow fails at provenance step

This is most often a permissions issue. Confirm the repository has:

- **Settings → Actions → General → Workflow permissions** set to **"Read and write permissions"**
- **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests** — not required but good practice

### Artifact upload fails

If the Release workflow created the release but the artifact upload in the SLSA workflow fails, you can re-run just the SLSA workflow from the **Actions** tab without re-tagging.

---

## SLSA Level 3 Compliance Notes

This project meets SLSA Level 3 via the `slsa-framework/slsa-github-generator`:

| SLSA requirement | How it is met |
|-----------------|---------------|
| Hosted build platform | GitHub Actions (ubuntu-latest ephemeral runner) |
| Isolated build | Fresh runner per workflow run, no persistent state |
| Scripted build | All build steps defined in version-controlled `.github/workflows/` |
| Non-falsifiable provenance | Signed with GitHub OIDC token (short-lived, bound to workflow run) |
| Authenticated provenance | `id-token: write` permission used only in the provenance job |
| Complete provenance | Source URI, commit SHA, workflow ref, build trigger all recorded |

For full SLSA L3 compliance, also ensure:

- Branch protection on `main` is enabled (require PR reviews, no direct push)
- All workflow action references are pinned to commit SHAs (not floating version tags) in production
