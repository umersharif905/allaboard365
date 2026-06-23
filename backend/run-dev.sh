#!/usr/bin/env zsh
# Run backend dev even when the parent shell has a broken cwd.
set -e
BACKEND_DIR="${0:A:h}"
builtin cd "$BACKEND_DIR"
exec npm run dev
