#!/usr/bin/env sh
#
# QuickFlo CLI installer.
#
# Detects OS + arch, downloads the matching pre-built binary from GCS, and
# drops it on PATH. Default install location is ~/.local/bin (no sudo needed).
#
#   curl -fsSL https://cdn.quickflo.app/cli/install.sh | sh                       # latest
#   curl -fsSL https://cdn.quickflo.app/cli/install.sh | sh -s v1.0.2              # pin a version
#   curl -fsSL https://cdn.quickflo.app/cli/install.sh | INSTALL_DIR=/usr/local/bin sh
#
# Env vars:
#   INSTALL_DIR        — destination directory (default: ~/.local/bin)
#   QF_DOWNLOAD_BASE   — override the download root

set -eu

DEFAULT_BASE="https://cdn.quickflo.app/cli"

BIN="quickflo"
INSTALL_DIR="${INSTALL_DIR:-${HOME}/.local/bin}"
DOWNLOAD_BASE="${QF_DOWNLOAD_BASE:-${DEFAULT_BASE}}"
VERSION="${1:-latest}"

# Detect OS + arch.
os="$(uname -s)"
arch="$(uname -m)"

case "${os}" in
  Darwin)
    case "${arch}" in
      arm64|aarch64) target="aarch64-apple-darwin" ;;
      x86_64)        target="x86_64-apple-darwin" ;;
      *) echo "Unsupported macOS arch: ${arch}" >&2; exit 1 ;;
    esac
    archive_ext="tar.gz"
    ;;
  Linux)
    case "${arch}" in
      x86_64)         target="x86_64-unknown-linux-gnu" ;;
      aarch64|arm64)  target="aarch64-unknown-linux-gnu" ;;
      *) echo "Unsupported Linux arch: ${arch}" >&2; exit 1 ;;
    esac
    archive_ext="tar.gz"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    target="x86_64-pc-windows-msvc"
    archive_ext="zip"
    BIN="quickflo.exe"
    ;;
  *)
    echo "Unsupported OS: ${os}. Use 'deno install jsr:@quickflo/cli' instead." >&2
    exit 1
    ;;
esac

# Resolve URL prefix.
if [ "${VERSION}" = "latest" ]; then
  prefix="${DOWNLOAD_BASE}/latest"
else
  prefix="${DOWNLOAD_BASE}/${VERSION}"
fi

archive="quickflo-${VERSION}-${target}.${archive_ext}"
if [ "${VERSION}" = "latest" ]; then
  # Versioned-name lookup inside the /latest/ directory: read VERSION file
  # first so we know the exact archive name to download.
  resolved_version="$(curl -fsSL "${prefix}/VERSION")"
  archive="quickflo-v${resolved_version}-${target}.${archive_ext}"
fi

url="${prefix}/${archive}"

echo "Installing QuickFlo CLI"
echo "  Target: ${target}"
echo "  From:   ${url}"
echo "  To:     ${INSTALL_DIR}/${BIN}"

# Download + extract to a temp dir.
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

curl -fsSL "${url}" -o "${tmp}/${archive}"

case "${archive_ext}" in
  tar.gz) tar -xzf "${tmp}/${archive}" -C "${tmp}" ;;
  zip)    unzip -q "${tmp}/${archive}" -d "${tmp}" ;;
esac

mkdir -p "${INSTALL_DIR}"
mv "${tmp}/${BIN}" "${INSTALL_DIR}/${BIN}"
chmod +x "${INSTALL_DIR}/${BIN}"

echo
echo "✓ Installed quickflo to ${INSTALL_DIR}/${BIN}"

# PATH check.
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo
    echo "Note: ${INSTALL_DIR} is not on your PATH."
    echo "  Add this to your shell rc file:"
    echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo
echo "Run:"
echo "  quickflo auth login"
