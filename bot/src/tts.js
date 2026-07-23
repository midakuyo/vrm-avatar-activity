// TTS 진입점 — AivisSpeech(Style-Bert-VITS2). 합성은 tts-aivis.js가 전담한다.
// 엔진이 죽어 있으면 합성음 스텁(텍스트 길이 비례 파형)으로 폴백해 대화는 계속된다.
import { synthesize as synthesizeAivis } from './tts-aivis.js';

const SAMPLE_RATE = 22050; // 스텁 전용
const MS_PER_CHAR = 85;

// ---- 폴백 스텁: 텍스트 길이에 비례하는 말소리 비슷한 파형 ----

function writeWav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-1, Math.min(1, samples[i])) * 32767, 44 + i * 2);
  }
  return buf;
}

function synthesizeStub(text) {
  const durationMs = Math.min(Math.max(text.length * MS_PER_CHAR, 600), 12000);
  const total = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Float32Array(total);
  const syllables = Math.max(1, Math.round(durationMs / 170));

  for (let s = 0; s < syllables; s++) {
    const ch = text[Math.floor((s / syllables) * text.length)] ?? 'a';
    if (ch === ' ' || ch === '\n') continue;
    const start = Math.floor((s * total) / syllables);
    const len = Math.floor(total / syllables);
    const f0 = 110 + (ch.charCodeAt(0) % 40);
    for (let i = 0; i < len && start + i < total; i++) {
      const t = i / SAMPLE_RATE;
      const env = Math.sin(Math.PI * (i / len)) ** 1.5;
      const wave =
        Math.sin(2 * Math.PI * f0 * t) * 0.5 +
        Math.sin(2 * Math.PI * f0 * 2 * t) * 0.3 +
        Math.sin(2 * Math.PI * f0 * 3 * t) * 0.2;
      samples[start + i] += wave * env * 0.32;
    }
  }

  return { audio: writeWav(samples), mime: 'audio/wav', durationMs };
}

let warnedOffline = false;

// opts: { speed, emotion, intensity } — 무드 레이어에서 온다.
export async function synthesize(text, opts = {}) {
  try {
    const result = await synthesizeAivis(text, opts);
    warnedOffline = false;
    return result;
  } catch (err) {
    if (!warnedOffline) {
      console.error(`[tts] AivisSpeech 호출 실패 (${err.message}) — 스텁으로 대체합니다.`);
      warnedOffline = true;
    }
    return synthesizeStub(text);
  }
}
