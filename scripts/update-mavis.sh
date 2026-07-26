#!/usr/bin/env bash
# update-mavis: baixea e instala a versão mais recente do Mavis VSCode
# extension direto do GitHub Releases. Suprime o warning DEP0169 do
# `url.parse` que o code CLI emite em Node 22+.
set -euo pipefail

REPO="${MAVIS_REPO:-yuri-schmaltz/vscode-minimax-agent}"
VSIX_NAME="vscode-agent-${1:-latest}.vsix"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Mavis: procurando a versão mais recente em $REPO..."
TAG="$(
  curl -fsSL \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -m1 '"tag_name":' \
  | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/'
)"

if [ -z "$TAG" ]; then
  echo "Mavis: não consegui descobrir a tag. Cheque sua internet." >&2
  exit 1
fi
echo "Mavis: tag mais recente: $TAG"

# If the user pinned a specific version, use it; otherwise derive from tag.
VERSION="${TAG#v}"
VSIX_NAME="vscode-agent-${VERSION}.vsix"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${VSIX_NAME}"

VSIX_PATH="${TMP_DIR}/${VSIX_NAME}"
echo "Mavis: baixando ${DOWNLOAD_URL}..."
curl -fL --retry 3 -o "$VSIX_PATH" "$DOWNLOAD_URL"

echo "Mavis: instalando..."
# Suppress DEP0169 url.parse deprecation warning from the code CLI itself
# (it's emitted by VSCode's install-extension code path on Node 22+).
NODE_OPTIONS="${NODE_OPTIONS:-} --no-deprecation" code --install-extension --force "$VSIX_PATH"

echo "Mavis: $TAG instalado. Reinicia o VSCode pra carregar."
