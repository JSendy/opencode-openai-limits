#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE_DIR="$ROOT_DIR/plugins"
TARGET_DIR="$HOME/.config/opencode/plugins"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "Missing source plugin folder: $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

for file in \
  openai-limits.tsx \
  openai-limits-writer.ts \
  openai-limits-shared.ts \
  openai-limits.README.md
do
  cp "$SOURCE_DIR/$file" "$TARGET_DIR/$file"
done

echo "Installed OpenAI limits plugin files to: $TARGET_DIR"
echo ""
echo "Next steps:"
echo "1. Add ./plugins/openai-limits-writer.ts to opencode.jsonc plugin array."
echo "2. Add ./plugins/openai-limits.tsx to tui.jsonc plugin array."
echo "3. Restart OpenCode."
echo "4. Run /limits-add or open /limits and login through the browser."
