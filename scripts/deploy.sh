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

# Warm the module cache once so parallel `deno compile` runs don't race on
# the same dependency downloads. Cheap no-op when the cache is already warm.
( cd "${REPO_ROOT}" && deno cache --quiet mod.ts )

# Build + archive one target. Each target writes to its own staging dir so
# parallel invocations can't clobber each other's `quickflo` output, then
# the final archive lands directly in DIST_DIR with a target-tagged name.
build_and_package() {
  local target="$1"
  local out_name="quickflo"
  [[ "${target}" == *windows* ]] && out_name="quickflo.exe"

  local stage_dir="${DIST_DIR}/.stage-${target}"
  mkdir -p "${stage_dir}"

  ( cd "${REPO_ROOT}" && deno compile \
      --quiet \
      --allow-net --allow-read --allow-env --allow-write \
      --target "${target}" \
      --output "${stage_dir}/${out_name}" \
      mod.ts )

  local archive_name="quickflo-v${VERSION}-${target}"
  if [[ "${target}" == *windows* ]]; then
    ( cd "${stage_dir}" && zip -q "${DIST_DIR}/${archive_name}.zip" "${out_name}" )
  else
    ( cd "${stage_dir}" && tar -czf "${DIST_DIR}/${archive_name}.tar.gz" "${out_name}" )
  fi

  rm -rf "${stage_dir}"
}

echo "▶ building ${#TARGETS[@]} targets in parallel"

declare -a build_pids=()
declare -a build_logs=()
for target in "${TARGETS[@]}"; do
  log="${DIST_DIR}/.build-${target}.log"
  build_logs+=("${log}")
  ( build_and_package "${target}" ) >"${log}" 2>&1 &
  build_pids+=($!)
done

# Wait on each PID and surface failures. We don't `set +e` because `wait`
# returns the child's exit code without tripping the shell's errexit —
# this loop is the explicit error boundary.
build_failed=0
for i in "${!build_pids[@]}"; do
  target="${TARGETS[$i]}"
  if wait "${build_pids[$i]}"; then
    echo "  ✓ ${target}"
  else
    echo "  ✗ ${target} — log follows:"
    sed 's/^/    /' "${build_logs[$i]}"
    build_failed=1
  fi
done
rm -f "${DIST_DIR}"/.build-*.log

if [[ "${build_failed}" == "1" ]]; then
  echo "ERROR: one or more builds failed" >&2
  exit 1
fi

# Checksums for the version's archives.
( cd "${DIST_DIR}" && shasum -a 256 quickflo-v"${VERSION}"-* > SHA256SUMS )

echo
echo "▶ built artifacts:"
ls -lh "${DIST_DIR}" | tail -n +2

# ---- upload -----------------------------------------------------------------

VERSIONED_PREFIX="gs://${BUCKET}/${BUCKET_PREFIX}/v${VERSION}"
LATEST_PREFIX="gs://${BUCKET}/${BUCKET_PREFIX}/latest"

# Precompute the VERSION pointer up-front so the latest-upload subshell
# doesn't have to (and so a `--skip-latest` run doesn't write the file).
if [[ "${UPDATE_LATEST}" == "1" ]]; then
  echo -n "${VERSION}" > "${DIST_DIR}/VERSION"
fi

# Dispatch each independent `gcloud storage cp` in the background. They
# target different prefixes/files so there's no ordering constraint —
# gcloud already parallelizes within one cp; this overlaps the three cps.
declare -a upload_pids=()
declare -a upload_logs=()
declare -a upload_labels=()

start_upload() {
  local label="$1"; shift
  local log="${DIST_DIR}/.upload-${label}.log"
  upload_labels+=("${label}")
  upload_logs+=("${log}")
  ( "$@" ) >"${log}" 2>&1 &
  upload_pids+=($!)
}

echo
echo "▶ uploading in parallel"

# Versioned: long cache (immutable artifacts).
start_upload "versioned" \
  gcloud storage cp \
    --cache-control="public, max-age=31536000, immutable" \
    "${DIST_DIR}"/*.tar.gz "${DIST_DIR}"/*.zip "${DIST_DIR}/SHA256SUMS" \
    "${VERSIONED_PREFIX}/"

if [[ "${UPDATE_LATEST}" == "1" ]]; then
  # Latest: short cache, rolls forward on every deploy.
  start_upload "latest" \
    gcloud storage cp \
      --cache-control="public, max-age=300" \
      "${DIST_DIR}"/*.tar.gz "${DIST_DIR}"/*.zip "${DIST_DIR}/SHA256SUMS" "${DIST_DIR}/VERSION" \
      "${LATEST_PREFIX}/"

  # Always re-upload the installer so it stays in sync with the URL layout.
  start_upload "installer" \
    gcloud storage cp \
      --cache-control="public, max-age=300" \
      "${REPO_ROOT}/install.sh" \
      "gs://${BUCKET}/${BUCKET_PREFIX}/install.sh"
fi

upload_failed=0
for i in "${!upload_pids[@]}"; do
  label="${upload_labels[$i]}"
  if wait "${upload_pids[$i]}"; then
    echo "  ✓ ${label}"
  else
    echo "  ✗ ${label} — log follows:"
    sed 's/^/    /' "${upload_logs[$i]}"
    upload_failed=1
  fi
done
rm -f "${DIST_DIR}"/.upload-*.log

if [[ "${upload_failed}" == "1" ]]; then
  echo "ERROR: one or more uploads failed" >&2
  exit 1
fi

PUBLIC_BASE="https://cdn.quickflo.app/packages/cli"

echo
echo "✓ deployed v${VERSION} to gs://${BUCKET}/${BUCKET_PREFIX}/"
echo
echo "  install (latest):  curl -fsSL ${PUBLIC_BASE}/install.sh | sh"
echo "  install (pinned):  curl -fsSL ${PUBLIC_BASE}/install.sh | sh -s v${VERSION}"
