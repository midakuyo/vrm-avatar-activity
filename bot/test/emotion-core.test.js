// 감정 코어 (묶음2: ②③⑧⑨) — 마커 파서와 무드 레이어.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// 이 테스트들은 기질점 0(중립 회귀)을 가정한다 — .env의 PERSONA_* 오염을 막는다.
for (const k of ['PERSONA_O', 'PERSONA_C', 'PERSONA_E', 'PERSONA_A', 'PERSONA_N']) process.env[k] = '0';
process.env.PERSONA_FILE = '/nonexistent-persona.md'; // persona.md(캐릭터 카드) 오염도 차단

const { takeEmotion } = await import('../src/emotions.js');
const { createMood, POINTS } = await import('../src/mood.js');

// ---- ⑨ 마커 파서: 3형식 + 이유 ----

test('기본 마커 (하위 호환)', () => {
  const r = takeEmotion('[happy] 안녕!');
  assert.deepEqual([r.emotion, r.intensity, r.reason, r.text], ['happy', 1, null, '안녕!']);
});

test('느낌표 강도', () => {
  assert.equal(takeEmotion('[happy!] 좋다').intensity, 1.4);
  assert.equal(takeEmotion('[happy!!] 대박!').intensity, 1.8);
});

test('숫자 강도 (0~1 클램프)', () => {
  assert.equal(takeEmotion('[sad:0.3] 음').intensity, 0.3);
  assert.equal(takeEmotion('[sad:7] 음').intensity, 1);
});

test('이유 구절 — 자막에서 제거되고 별도 반환', () => {
  const r = takeEmotion('[happy!|오랜만에 와줘서] 반가워!');
  assert.equal(r.emotion, 'happy');
  assert.equal(r.intensity, 1.4);
  assert.equal(r.reason, '오랜만에 와줘서');
  assert.equal(r.text, '반가워!');
});

test('화이트리스트 밖 라벨 — 마커는 제거, 직전 감정 유지', () => {
  const r = takeEmotion('[excited|이유] 오!', 'sad');
  assert.equal(r.emotion, 'sad');
  assert.equal(r.text, '오!');
});

test('문장 중간의 강도·이유 딸린 마커도 제거', () => {
  const r = takeEmotion('그래서 [happy!|웃겨서] 말이야.');
  assert.equal(r.text, '그래서 말이야.');
});

test('깨진 형식 — 라벨만 건진다', () => {
  const r = takeEmotion('[happy:abc] 어');
  assert.equal(r.emotion, 'happy');
  assert.equal(r.intensity, 1);
});

// ---- ② 게인·사분면 감쇠 ----

test('surprised 게인 0.3 — 무드를 거의 안 민다', () => {
  const m = createMood();
  m.push('surprised');
  const afterSurprise = Math.hypot(m.vector.v, m.vector.a);
  const m2 = createMood();
  m2.push('happy');
  const afterHappy = Math.hypot(m2.vector.v, m2.vector.a);
  assert.ok(afterSurprise < afterHappy * 0.45, `놀람 ${afterSurprise} vs 기쁨 ${afterHappy}`);
});

test('사분면별 감쇠 — 슬픔권이 이완권보다 훨씬 느리게 식는다', () => {
  const sad = createMood();
  sad.restore({ v: -0.5, a: -0.3, label: 'sad' });
  const relaxed = createMood();
  relaxed.restore({ v: 0.5, a: -0.5, label: 'relaxed' });

  for (let i = 0; i < 5; i++) {
    sad.decay();
    relaxed.decay();
  }
  const sadKeep = Math.hypot(sad.vector.v, sad.vector.a) / Math.hypot(0.5, 0.3);
  const relaxedKeep = Math.hypot(relaxed.vector.v, relaxed.vector.a) / Math.hypot(0.5, 0.5);
  assert.ok(sadKeep > 0.7, `슬픔 잔존율 ${sadKeep}`);
  assert.ok(relaxedKeep < 0.25, `이완 잔존율 ${relaxedKeep}`);
});

test('⑨ 강도가 push 세기를 바꾼다', () => {
  const weak = createMood();
  weak.push('happy', 0.3);
  const strong = createMood();
  strong.push('happy', 1.8);
  assert.ok(Math.abs(strong.vector.v) > Math.abs(weak.vector.v) * 2);
  // 과충전 방지: 실효 계수가 0.95를 넘지 않으므로 앵커를 넘어가지 않는다
  assert.ok(Math.abs(strong.vector.v) <= Math.abs(POINTS.happy.v));
});

// ---- ⑧ 표정 블렌드 ----

test('앵커 위 좌표는 단일 표정, 사이 좌표는 인접 2개 블렌드', () => {
  const onAnchor = createMood();
  onAnchor.restore({ v: POINTS.happy.v, a: POINTS.happy.a, label: 'happy' });
  const single = onAnchor.expression;
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'happy');

  const between = createMood();
  between.restore({ v: 0.35, a: 0.55, label: 'happy' }); // happy와 surprised 사이
  const mix = between.expression;
  assert.equal(mix.length, 2);
  assert.deepEqual(mix.map((e) => e.name).sort(), ['happy', 'surprised']);
  const total = mix.reduce((s, e) => s + e.weight, 0);
  assert.ok(total > 0.5 && total <= 1.01, `합 ${total}`);
});

test('무드가 옅으면 중립', () => {
  const m = createMood();
  m.restore({ v: 0.01, a: 0.005, label: 'neutral' });
  assert.deepEqual(m.expression, [{ name: 'neutral', weight: 0 }]);
});

// ---- ⑧ voice: 운율은 arousal만 ----

test('speed·pitch는 arousal 함수, valence에 불변', () => {
  const excited = createMood();
  excited.restore({ v: 0.5, a: 0.6, label: 'happy' });
  const angryHigh = createMood();
  angryHigh.restore({ v: -0.5, a: 0.6, label: 'angry' });
  assert.equal(excited.voice.speed, angryHigh.voice.speed); // valence 무관
  assert.equal(excited.voice.pitch, angryHigh.voice.pitch);
  assert.ok(excited.voice.speed > 1);
  assert.ok(excited.voice.pitch > 0);
  // 스타일 라벨(valence의 운반자)은 다르다
  assert.notEqual(excited.voice.emotion, angryHigh.voice.emotion);
});

// ---- ③ promptWord ----

test('promptWord: 옅으면 null, 사분면+짙기 단어', () => {
  const calm = createMood();
  assert.equal(calm.promptWord, null);
  const sad = createMood();
  sad.restore({ v: -0.5, a: -0.3, label: 'sad' });
  assert.match(sad.promptWord, /시무룩함/);
  const mild = createMood();
  mild.restore({ v: 0.2, a: 0.15, label: 'happy' });
  assert.match(mild.promptWord, /^옅은 들뜸$/);
});

// ---- 리뷰 확정 결함들의 회귀 테스트 ----

test('(high) 분리기가 마커를 잘라내도 강도가 다음 실문장에 이월된다', async () => {
  const { toUnits } = await import('../src/sentences.js');
  async function* deltas() {
    // SENTENCE_END가 "!] " 를 종결로 오인해 "[happy!!]"가 단독 조각이 되는 실제 시나리오
    yield '[happy!!] ';
    yield '대박이야 진짜';
  }
  const units = [];
  for await (const u of toUnits(deltas())) units.push(u);
  assert.equal(units.length, 1);
  assert.equal(units[0].emotion, 'happy');
  assert.equal(units[0].intensity, 1.8);
});

test('이유 속 ]로 마커가 반쪽 잘려도 잔여 꼬리를 정리한다', () => {
  const r = takeEmotion('[happy|그[웃음]탓] 반가워!');
  assert.equal(r.emotion, 'happy');
  assert.equal(r.text.includes(']'), false);
  assert.match(r.text, /반가워/);
});

test('변칙 조합 [happy!:0.8]도 자막에 유출되지 않는다', () => {
  const r = takeEmotion('앞말 [happy!:0.8] 뒷말');
  assert.equal(r.text, '앞말 뒷말');
});

test('긴 이유(60자 초과)도 마커로 인식된다', () => {
  const long = '이유'.repeat(40); // 80자
  const r = takeEmotion(`[sad|${long}] 그랬구나`);
  assert.equal(r.emotion, 'sad');
  assert.equal(r.text, '그랬구나');
});

test('미지 라벨 마커의 이유는 오귀속되지 않는다', () => {
  const r = takeEmotion('[excited|이상한 잡문] 오!');
  assert.equal(r.reason, null);
});

test('짙은 시무룩함이 도달 가능하다 (방향 상대 정규화)', () => {
  const m = createMood();
  for (let i = 0; i < 6; i++) m.push('sad', 1.4);
  assert.match(m.promptWord, /^짙은 시무룩함$/);
});

test('표정 상한이 감정마다 같다 — 앵커 위에서 rel=1', () => {
  for (const name of ['happy', 'sad', 'angry', 'surprised']) {
    const m = createMood();
    m.restore({ v: POINTS[name].v, a: POINTS[name].a, label: name });
    const total = m.expression.reduce((s, e) => s + e.weight, 0);
    assert.ok(total > 0.95, `${name} 상한 ${total}`);
  }
});

test('손상된 저장값(NaN·범위 밖)은 restore가 소독한다', () => {
  const m = createMood();
  m.restore({ v: NaN, a: 9, label: 'weird' });
  assert.equal(m.vector.v, 0);
  assert.equal(m.vector.a, 1);
  assert.ok(Math.abs(m.voice.pitch) <= 0.15);
  assert.equal(m.state.label, 'neutral');
});

// ---- ⑪ 성격 기질점 ----
test('기질점: env 없으면 0, 감쇠는 0으로 회귀 (기본 동작 불변)', () => {
  const m = createMood();
  assert.equal(m.vector.v, 0);
  m.restore({ v: 0.5, a: 0.5, label: 'happy' });
  for (let i = 0; i < 30; i++) m.decay();
  assert.ok(Math.hypot(m.vector.v, m.vector.a) < 0.05, '기질 없으면 중립 회귀');
});
