// 비용 가드. 허용목록이 "누가"를 거른다면, 여기는 "얼마나"를 거른다.
// 허용된 사용자라도 연타·다중 세션으로 LLM 호출과 TTS CPU를 태울 수 있다.

// 같은 사용자의 연속 입력 최소 간격
const COOLDOWN_MS = Number(process.env.PROMPT_COOLDOWN_MS ?? 3000);
// 채널 큐에 쌓일 수 있는 대기 입력 수 (응답 중에 온 것들)
export const QUEUE_MAX = Number(process.env.QUEUE_MAX ?? 3);
// 동시에 진행할 수 있는 응답(LLM+TTS 파이프라인) 수.
// TTS가 4코어를 다 쓰므로 기본 2도 이미 경합이다.
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE_RESPONSES ?? 2);

const lastPromptAt = new Map(); // uid -> timestamp

export function checkCooldown(uid) {
  if (!uid || COOLDOWN_MS <= 0) return { ok: true };
  const now = Date.now();
  const last = lastPromptAt.get(uid) ?? 0;
  const waitMs = last + COOLDOWN_MS - now;
  if (waitMs > 0) return { ok: false, waitMs };
  lastPromptAt.set(uid, now);
  // 무한히 자라지 않게 가끔 청소
  if (lastPromptAt.size > 1000) {
    for (const [k, t] of lastPromptAt) if (now - t > 60_000) lastPromptAt.delete(k);
  }
  return { ok: true };
}

// 전역 응답 동시성. 초과분은 자리가 날 때까지 기다린다(거부가 아니라 backpressure).
let active = 0;
const waiters = [];

export async function acquireResponseSlot() {
  if (active < MAX_ACTIVE) {
    active++;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active++;
}

export function releaseResponseSlot() {
  active = Math.max(0, active - 1);
  waiters.shift()?.();
}
