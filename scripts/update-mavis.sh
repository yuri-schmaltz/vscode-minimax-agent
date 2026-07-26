#!/usr/bin/env bash
# update-mavis: baixa e instala a versão mais recente do Mavis VSCode
# extension direto do GitHub Releases. Suprime o warning DEP0169 do
# `url.parse` que o code CLI emite em Node 22+ (passando
# NODE_OPTIONS=--no-deprecation pro subshell do `code`).
set -euo pipefail

REPO="${MAVIS_REPO:-yuri-schmaltz/vscode-minimax-agent}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# --- 1. Find the latest tag (or honour the argument as a version) ---
if [ "$#" -ge 1 ] && [ "$1" != "latest" ]; then
  # Caller pinned a specific version, e.g. `update-mavis 0.3.11`
  VERSION="$1"
  TAG="v${VERSION}"
else
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
  VERSION="${TAG#v}"
fi
echo "Mavis: tag alvo: $TAG"

# --- 2. Download the .vsix into TMP_DIR (path survives the install call) ---
VSIX_NAME="vscode-agent-${VERSION}.vsix"
VSIX_PATH="${TMP_DIR}/${VSIX_NAME}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${VSIX_NAME}"

echo "Mavis: baixando ${DOWNLOAD_URL}..."
curl -fL --retry 3 --connect-timeout 15 -o "$VSIX_PATH" "$DOWNLOAD_URL"

if [ ! -s "$VSIX_PATH" ]; then
  echo "Mavis: download falhou (arquivo vazio em $VSIX_PATH)." >&2
  exit 1
fi
VSIX_SIZE=$(stat -c %s "$VSIX_PATH" 2>/dev/null || stat -f %z "$VSIX_PATH" 2>/dev/null || echo "?")
echo "Mavis: baixado ${VSIX_SIZE} bytes."

# --- 3. Pick the `code` binary (user may have insiders/stable/code-exploration) ---
CODE_BIN="$(command -v code || true)"
if [ -z "$CODE_BIN" ]; then
  echo "Mavis: 'code' não está no PATH. Instale o VSCode e rode 'Shell Command: Install code command in PATH' pelo Command Palette." >&2
  exit 1
fi
echo "Mavis: usando binário: $CODE_BIN"

# --- 4. Install with the .vsix as a positional arg (no --force before it, --
# some wrappers reject --force with an empty following arg). We DO want
# --force so the install overwrites the previous version.
echo "Mavis: instalando ${VSIX_PATH}..."

# Run `code` in a subshell so the trap doesn't delete the .vsix while
# code is still reading it. The `--` tells code to treat the rest as
# positional, and we pass the .vsix as the LAST arg so a wrapper that
# stops on first empty value still gets the path.
(cd "$TMP_DIR" && NODE_OPTIONS=--no-deprecation "$CODE_BIN" --install-extension --force "$VSIX_NAME")
INSTALL_RC=$?

if [ $INSTALL_RC -ne 0 ]; then
  echo "Mavis: instalação falhou (código de saída $INSTALL_RC)." >&2
  exit $INSTALL_RC
fi
echo "Mavis: $TAG instalado. Reinicia o VSCode pra carregar."
