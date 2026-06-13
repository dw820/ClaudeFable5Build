#!/usr/bin/env bash
# Generate tiny 9:16 test videos for integration tests (needs ffmpeg).
#   bash src/__fixtures__/generate.sh
# Produces: sample.mp4 (neutral), good-cut.mp4 (big bright caption, punchy),
#           weak-cut.mp4 (tiny dim caption, slow). The verify/ eval expects
#           good-cut to grade pass-ish and weak-cut to fail.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found — run: brew install ffmpeg"; exit 1; }

# Neutral 3s sample clip (used by edit/overlay/preprocess integration tests).
ffmpeg -y -f lavfi -i "testsrc=size=1080x1920:rate=30:duration=3" \
  -pix_fmt yuv420p "$DIR/sample.mp4"

# GOOD cut: bright, large high-contrast caption that lands immediately.
ffmpeg -y -f lavfi -i "color=c=0x1b6ef5:size=1080x1920:rate=30:duration=4" \
  -vf "drawtext=text='WAIT FOR THE DROP':fontcolor=white:fontsize=120:box=1:boxcolor=black@0.5:boxborderw=20:x=(w-text_w)/2:y=h-360" \
  -pix_fmt yuv420p "$DIR/good-cut.mp4"

# WEAK cut: dim, tiny low-contrast caption, slow empty lead-in.
ffmpeg -y -f lavfi -i "color=c=0x222222:size=1080x1920:rate=30:duration=4" \
  -vf "drawtext=text='so anyway':fontcolor=0x555555:fontsize=28:x=20:y=20:enable='gte(t,2)'" \
  -pix_fmt yuv420p "$DIR/weak-cut.mp4"

echo "Generated sample.mp4, good-cut.mp4, weak-cut.mp4 in $DIR"
