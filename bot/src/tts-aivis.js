// AivisSpeech(= 패키징된 Style-Bert-VITS2) 어댑터.
//
// VOICEVOX 호환 2단계 API: audio_query → synthesis.
// 스타일 ID로 감정 종류를, query 파라미터로 강도·속도를 조절한다.
// 이게 Supertonic으로는 막혀 있던 "같은 목소리의 감정 표현"이다.

const URL = process.env.AIVIS_URL ?? 'http://aivis:10101';
const TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30000);

// まお의 스타일. 무드 레이어의 라벨을 여기에 매핑한다.
// (env로 재정의 가능 — 다른 캐릭터로 바꿀 때)
const STYLE = {
  neutral: Number(process.env.AIVIS_STYLE_NEUTRAL ?? 888753760), // ノーマル
  happy: Number(process.env.AIVIS_STYLE_HAPPY ?? 888753762), //   あまあま
  relaxed: Number(process.env.AIVIS_STYLE_RELAXED ?? 888753763), // おちつき
  surprised: Number(process.env.AIVIS_STYLE_SURPRISED ?? 888753764), // からかい
  sad: Number(process.env.AIVIS_STYLE_SAD ?? 888753765), //       せつなめ
  angry: Number(process.env.AIVIS_STYLE_ANGRY ?? 888753764), //   からかい (대용)
};
const DEFAULT_STYLE = STYLE.neutral;

function wavDurationMs(buf) {
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const frame = channels * (bits / 8);
  return frame && sampleRate ? Math.round(((buf.length - 44) / frame / sampleRate) * 1000) : null;
}

// opts: { emotion, speed, intensity } — sessions.js의 mood.voice에서 온다.
export async function synthesize(text, opts = {}) {
  const speaker = STYLE[opts.emotion] ?? DEFAULT_STYLE;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  const qRes = await fetch(
    `${URL}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`,
    { method: 'POST', signal },
  );
  if (!qRes.ok) throw new Error(`aivis audio_query ${qRes.status}`);
  const query = await qRes.json();

  // 무드 강도 → 억양 세기, arousal → 속도·피치.
  // intensity(0~1)를 1.0 기준으로 얹는다. 과하면 부자연스러워 상한을 둔다.
  const intensity = Math.min(1.6, Math.max(0.6, 1 + (opts.intensity ?? 0) * 0.6));
  query.intonationScale = intensity;
  if (opts.speed) query.speedScale = Math.min(1.3, Math.max(0.8, opts.speed));
  // 피치는 arousal의 미세 신호 (⑧: 운율에는 arousal만). ±0.15 밖은 부자연.
  if (opts.pitch) query.pitchScale = Math.min(0.15, Math.max(-0.15, opts.pitch));

  const sRes = await fetch(`${URL}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
    signal,
  });
  if (!sRes.ok) throw new Error(`aivis synthesis ${sRes.status}`);

  const audio = Buffer.from(await sRes.arrayBuffer());
  if (audio.length < 45 || audio.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('aivis 응답이 WAV가 아닙니다.');
  }
  return { audio, mime: 'audio/wav', durationMs: wavDurationMs(audio) ?? text.length * 90 };
}
