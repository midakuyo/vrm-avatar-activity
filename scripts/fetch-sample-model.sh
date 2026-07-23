#!/usr/bin/env sh
# 개발용 샘플 VRM을 받아온다. 저장소에는 커밋하지 않는다(용량 + 라이선스).
# 자기 캐릭터를 쓰려면 activity/public/models/sample.vrm 를 그냥 덮어쓰면 된다.
set -eu

DEST="$(dirname "$0")/../activity/public/models/sample.vrm"
URL="https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm"

mkdir -p "$(dirname "$DEST")"
curl -fsSL -o "$DEST" "$URL"

# glTF 바이너리인지 매직 넘버로 확인
if [ "$(head -c 4 "$DEST")" != "glTF" ]; then
  echo "받은 파일이 VRM(glTF)이 아닙니다: $DEST" >&2
  exit 1
fi

echo "완료: $DEST ($(du -h "$DEST" | cut -f1))"
