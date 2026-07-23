// TTS에 넘기기 전에 소리로 읽히면 안 되는 것을 걷어낸다.
// 자막에는 원문을 그대로 쓰므로, 이 변환은 합성 직전에만 적용한다.
//
// 모델에게 "이모지 쓰지 마"라고 해도 지키지 않을 때가 있다. 지시에 기대지 않고
// 여기서 막는다.

// 이모지 전부. 코드포인트 범위를 손으로 나열하면 ‼️ ☺️ 같은 것이 샌다 —
// 유니코드 속성(Extended_Pictographic)이 표준적이고 빠짐이 없다.
// 변형 선택자(FE0F)·ZWJ(200D)·키캡 조합도 함께 지운다.
const EMOJI = /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

// 마크다운 강조·코드·링크 표기
const MARKDOWN = /(\*\*|__|\*|_|~~|`{1,3})/g;

// 꺾쇠 태그. Supertonic은 표현 태그를 구현하지 않아 그대로 **글자로 읽어버린다**
// (실측: `<laugh>`가 "laugh"로 발음됨). LLM이 흉내내서 뱉으면 소리로 새므로 지운다.
// 공백을 허용하지 않아 "a<b 그리고 c>d" 같은 비교 표현을 잘못 지우지 않는다.
const ANGLE_TAG = /<\/?[a-zA-Z가-힣_][a-zA-Z0-9가-힣_-]{0,19}>/g;

export function toSpeakable(text) {
  return text
    .replace(EMOJI, '')
    .replace(ANGLE_TAG, '')
    .replace(MARKDOWN, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [보이는 글자](링크) → 보이는 글자
    .replace(/https?:\/\/\S+/g, '링크')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 이모지만 걷어낸다 (자막용 — 마크다운·URL은 자막에선 보여도 된다).
// 프롬프트로 금지해도 모델이 계속 쓰므로, 표시 단계에서 확정적으로 지운다.
export function stripEmoji(text) {
  return text.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}
