# Release Process

This document describes the automated release pipeline for DOMAgent.

---

## What Gets Released

Every push to the `main` branch (that isn't a continuous integration skip) triggers a fully automated release. Each release produces:

| Artifact | Description |
|----------|-------------|
| `domagent-chrome-<version>.zip` | Chrome extension archive: load via `chrome://extensions` |
| `domagent-firefox-<version>.xpi` | Firefox extension archive: load via `about:debugging` |
| `domagent-mcp-<version>.tgz` | MCP server Node.js package |
| `domagent` (npm) | The package published to the **[npm registry](https://www.npmjs.com/package/domagent)** |
| `multiple.intoto.jsonl` | Signed **SLSA Level 3 provenance** verifying all files |

---

## Automated Pipeline (`auto-release.yml`)

The entire release process is handled in a single GitHub Actions workflow:

```
Developer merges PR to 'main'
           │
           ▼
  auto-release.yml workflow runs
  1. Bump version (patch) in domagent-mcp/package.json
  2. Commit and push bump back to 'main' [skip ci]
  3. Build artifacts (ZIP, XPI, TGZ)
  4. Create GitHub Release + Git Tag
  5. Sign artifacts (SLSA Level 3) using GitHub OIDC token
  6. Publish to npm (with OIDC Trusted Publisher provenance)
  7. Attach all artifacts + SLSA provenance to the GitHub release
```

---

## SLSA Level 3 Provenance

DOMAgent uses the **[OSSF SLSA GitHub Generator](https://github.com/slsa-framework/slsa-github-generator)** to provide non-falsifiable provenance for every release.

This proves that:
1. The artifacts were built in a trusted, ephemeral GitHub Actions environment.
2. They reflect the exact source code in the `vaishnavucv/domagent` repository.
3. No human (including the maintainers) touched the artifacts between the build and the release.

---

## Verifying a Release (for Users)

You can verify any artifact using the [slsa-verifier](https://github.com/slsa-framework/slsa-verifier) tool:

```bash
# Example: Verify the Chrome extension artifact
slsa-verifier verify-artifact domagent-chrome-1.0.11.zip \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/vaishnavucv/domagent
```

---

## Manual Re-publish Fallback

In the rare event that the automatic publish to npm fails (e.g., due to a registry timeout), a manual fallback workflow is available:

1. Go to the **Actions** tab in GitHub.
2. Select the **"Publish to npm"** workflow on the left.
3. Click **"Run workflow"**.
4. Enter the **tag name** (example: `v1.0.11`) and run.

This manual workflow also generates SLSA provenance and uses OIDC Trusted Publishing.

---

## Pre-Push Checklist (for Contributors)

Since releases happen on every push to `main`, ensure the following before merging/pushing:

- [ ] Extension loads without errors in Chrome and Firefox.
- [ ] MCP server starts: `cd domagent-mcp && npm install && node index.js`.
- [ ] Basic tools (`navigate`, `click`, `get_screenshot`) are verified working locally.
- [ ] Documentation (`README.md`, etc.) is up to date with code changes.

---

## Major/Minor Version Bumps

By default, the automated pipeline performs **patch** bumps (`1.0.x`). For **major** or **minor** bumps:

1. Manually update the version in `domagent-mcp/package.json`.
2. Commit with `[skip ci]` in the message to prevent the auto-release from triggering again.
3. Push to `main`.
4. Then push a tag (e.g., `v1.1.0`) manually if you want to trigger the release immediately, or just let the next push to `main` handle it.

---

## Permissions and Security

- **GitHub Release:** Uses `GITHUB_TOKEN` with `contents: write`.
- **npm Publish:** Uses **OIDC Trusted Publishing**. No long-lived npm secrets are needed; GitHub and npm exchange short-lived tokens.
- **Provenance:** Uses `id-token: write` to sign the SLSA statement.
