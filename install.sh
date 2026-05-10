#!/usr/bin/env sh
#
# QuickFlo CLI installer — downloads the latest release binary from GitHub
# and drops it on your PATH. Override with env vars:
#
#   INSTALL_DIR=/usr/local/bin sh install.sh
#   QF_VERSION=v0.3.0          sh install.sh
#
set -eu

REPO="QuickFlo/cli"
BIN="quickflo"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${QF_VERSION:-latest}"

err() { printf 'install: %s\n' "$1" >&2; exit 1; }

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Darwin) os=apple-darwin ;;
  Linux)  os=unknown-linux-gnu ;;
  *) err "unsupported OS: $uname_s (use the Deno install path or download manually)" ;;
esac

case "$uname_m" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=aarch64 ;;
  *) err "unsupported arch: $uname_m" ;;
esac

target="${arch}-${os}"
asset="${BIN}-${VERSION}-${target}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
  # GitHub returns the asset filename with the actual version baked in;
  # the redirect handles it.
  url="https://github.com/${REPO}/releases/latest/download/$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n "s/.*\"name\": *\"\\(${BIN}-v[^\"]*-${target}.tar.gz\\)\".*/\\1/p" | head -n1)"
  if [ -z "${url##*/}" ]; then
    err "could not resolve latest release asset for ${target}"
  fi
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

mkdir -p "$INSTALL_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

printf 'Downloading %s\n' "$url"
curl -fsSL "$url" -o "$tmp/asset.tar.gz"

tar -xzf "$tmp/asset.tar.gz" -C "$tmp"
mv "$tmp/$BIN" "$INSTALL_DIR/$BIN"
chmod +x "$INSTALL_DIR/$BIN"

printf '\nInstalled %s to %s/%s\n' "$BIN" "$INSTALL_DIR" "$BIN"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\nNote: %s is not on your PATH. Add this to your shell rc:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac
