#!/usr/bin/env bash
# Symlink fiber-snatcher into ~/.local/bin.
# Requires bun at ~/.bun/bin/bun — installs it transparently if missing (via curl).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
BIN_SRC="$REPO_ROOT/bin/fiber-snatcher.ts"
BIN_DST="$HOME/.local/bin/fiber-snatcher"

if [ ! -x "$BUN" ]; then
  echo "✖ bun not found at $BUN. Install: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

mkdir -p "$HOME/.local/bin"

# Create a tiny launcher rather than a raw symlink — so the shebang finds bun
cat > "$BIN_DST" <<EOF
#!/usr/bin/env bash
exec "$BUN" run "$BIN_SRC" "\$@"
EOF
chmod +x "$BIN_DST"

echo "✓ fiber-snatcher installed at $BIN_DST"

# Install deps
cd "$REPO_ROOT"
"$BUN" install

if ! echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
  echo ""
  echo "⚠ $HOME/.local/bin is not on your PATH."
  echo "  Add this to ~/.zshrc:   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "Try:  fiber-snatcher help"
