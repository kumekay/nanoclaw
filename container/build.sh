#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Restore skills from lockfile into container/skills/
LOCKFILE="$PROJECT_DIR/skills-lock.json"
if [ -f "$LOCKFILE" ]; then
  echo "Restoring skills from skills-lock.json..."
  cd "$PROJECT_DIR"
  npx skills experimental_install -y 2>&1 | tail -5
  # Copy installed skills into container/skills/ for runtime sync
  # experimental_install puts skills in .agents/skills/ (universal dir)
  for dir in .agents/skills/gws-*; do
    [ -d "$dir" ] || continue
    skill_name="$(basename "$dir")"
    cp -r "$dir" "$SCRIPT_DIR/skills/$skill_name"
    echo "  Copied $skill_name → container/skills/"
  done
fi

cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
