#!/usr/bin/env bash
#
# Build cross-platform binaries with `deno compile`, archive them, and upload
# to a public GCS bucket. The matching install.sh script (also uploaded) lets
# users install via:
#
#   curl -fsSL https://cdn.quickflo.app/packages/cli/install.sh | sh
#
# Requirements:
#   - deno on PATH
#   - gcloud CLI authenticated (`gcloud auth login` if first time)
#   - The bucket must be publicly readable (allUsers: objectViewer)
#
# Bucket layout:
#   gs://qkflo-hosted-content/packages/cli/
#     v<version>/quickflo-v<version>-<target>.tar.gz   ← versioned, immutable
#     v<version>/SHA256SUMS                              ← checksums
#     latest/quickflo-v<version>-<target>.tar.gz         ← rolls forward
#     latest/VERSION                                      ← plain text version
#     install.sh                                          ← installer
#
# Run:
#   ./scripts/deploy.sh                # publish version (from deno.json) + roll latest
#   ./scripts/deploy.sh --skip-latest  # versioned only, leave /latest/ pointing at the
#                                      # previous release

set -euo pipefail

# ---- config -----------------------------------------------------------------

BUCKET="qkflo-hosted-content"
BUCKET_PREFIX="packages/cli"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${REPO_ROOT}/dist"

# Version from deno.json — single source of truth, same value JSR publishes.
VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("'"${REPO_ROOT}"'/deno.json","utf8")).version)' 2>/dev/null \
  || deno eval 'console.log(JSON.parse(Deno.readTextFileSync("'"${REPO_ROOT}"'/deno.json")).version)')"

if [[ -z "${VERSION}" ]]; then
  echo "ERROR: could not read version from deno.json" >&2
  exit 1
fi

UPDATE_LATEST=1
if [[ "${1:-}" == "--skip-latest" ]]; then
  UPDATE_LATEST=0
fi

# Targets: keep aligned with what `deno compile --target` supports.
TARGETS=(
  "x86_64-unknown-linux-gnu"
  "aarch64-unknown-linux-gnu"
  "x86_64-apple-darwin"
  "aarch64-apple-darwin"
  "x86_64-pc-windows-msvc"
)

echo "QuickFlo CLI — deploy"
echo "  Version: v${VERSION}"
echo "  Bucket:  gs://${BUCKET}/${BUCKET_PREFIX}"
echo "  Latest:  $([[ "${UPDATE_LATEST}" == "1" ]] && echo "yes" || echo "skipped")"
echo

# ---- build ------------------------------------------------------------------

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"

for target in "${TARGETS[@]}"; do
  echo "▶ build ${target}"
  out_name="quickflo"
  if [[ "${target}" == *windows* ]]; then
    out_name="quickflo.exe"
  fi

  ( cd "${REPO_ROOT}" && deno compile \
      --quiet \
      --allow-net --allow-read --allow-env --allow-write \
      --target "${target}" \
      --output "${DIST_DIR}/${out_name}" \
      mod.ts )

  # Archive: tar.gz for everything except Windows (zip)
  archive_name="quickflo-v${VERSION}-${target}"
  if [[ "${target}" == *windows* ]]; then
    ( cd "${DIST_DIR}" && zip -q "${archive_name}.zip" "${out_name}" )
    rm "${DIST_DIR}/${out_name}"
  else
    ( cd "${DIST_DIR}" && tar -czf "${archive_name}.tar.gz" "${out_name}" )
    rm "${DIST_DIR}/${out_name}"
  fi
done

# Checksums for the version's archives.
( cd "${DIST_DIR}" && shasum -a 256 quickflo-v"${VERSION}"-* > SHA256SUMS )

echo
echo "▶ built artifacts:"
ls -lh "${DIST_DIR}" | tail -n +2

# ---- upload -----------------------------------------------------------------

VERSIONED_PREFIX="gs://${BUCKET}/${BUCKET_PREFIX}/v${VERSION}"
LATEST_PREFIX="gs://${BUCKET}/${BUCKET_PREFIX}/latest"

# Versioned: long cache (immutable artifacts).
echo
echo "▶ upload versioned to ${VERSIONED_PREFIX}/"
gcloud storage cp \
  --cache-control="public, max-age=31536000, immutable" \
  "${DIST_DIR}"/*.tar.gz "${DIST_DIR}"/*.zip "${DIST_DIR}/SHA256SUMS" \
  "${VERSIONED_PREFIX}/"

if [[ "${UPDATE_LATEST}" == "1" ]]; then
  # Latest: short cache, rolls forward on every deploy.
  echo
  echo "▶ update ${LATEST_PREFIX}/ (rolling pointer)"
  echo -n "${VERSION}" > "${DIST_DIR}/VERSION"
  gcloud storage cp \
    --cache-control="public, max-age=300" \
    "${DIST_DIR}"/*.tar.gz "${DIST_DIR}"/*.zip "${DIST_DIR}/SHA256SUMS" "${DIST_DIR}/VERSION" \
    "${LATEST_PREFIX}/"

  # Always re-upload the installer so it stays in sync with the URL layout.
  gcloud storage cp \
    --cache-control="public, max-age=300" \
    "${REPO_ROOT}/install.sh" \
    "gs://${BUCKET}/${BUCKET_PREFIX}/install.sh"
fi

PUBLIC_BASE="https://cdn.quickflo.app/packages/cli"

echo
echo "✓ deployed v${VERSION} to gs://${BUCKET}/${BUCKET_PREFIX}/"
echo
echo "  install (latest):  curl -fsSL ${PUBLIC_BASE}/install.sh | sh"
echo "  install (pinned):  curl -fsSL ${PUBLIC_BASE}/install.sh | sh -s v${VERSION}"
