// /forget과 진행 중인 응답·압축의 경합 — 지운 데이터가 부활하면 안 된다.
// (리뷰 워크플로에서 재현된 high 결함의 회귀 테스트)
// LLM은 스텁 경로(자격증명 비움), TTS는 폴백 스텁을 탄다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DIR = await mkdtemp(path.join(tmpdir(), 'forgettest-'));
process.env.DATA_DIR = DIR;
for (const k of ['PERSONA_O', 'PERSONA_C', 'PERSONA_E', 'PERSONA_A', 'PERSONA_N']) process.env[k] = '0';
process.env.PERSONA_FILE = '/nonexistent-persona.md'; // persona.md(캐릭터 카드) 오염도 차단
process.env.CF_ACCOUNT_ID = '';
process.env.CF_API_TOKEN = '';
process.env.LLM_BILINGUAL = '0';
process.env.AIVIS_URL = 'http://127.0.0.1:9'; // 즉시 실패 → 스텁 폴백
process.env.LOG_RETENTION_DAYS = '180';

const { createSessions } = await import('../src/sessions.js');

after(() => rm(DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 고정 sleep은 병렬 테스트의 CPU 경합에서 모자랄 수 있다 — 조건 폴링으로 기다린다.
async function waitFor(cond, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error('waitFor 시간 초과');
}
const CH = '900000000000000031';
const UID = '900000000000000099';
const ctx = { channelId: CH, guildId: null, isPublic: false }; // DM 스코프 d-<CH>
const scopeDir = path.join(DIR, `d-${CH}`);

test('/forget all이 진행 중인 응답과 겹쳐도 스코프가 부활하지 않는다', async () => {
  const sessions = createSessions({ toChannel() {} });

  const r = sessions.submit(ctx, '테스터', '비밀 이야기', null, UID);
  assert.equal(r.ok, true);

  await sleep(250); // drain이 스텁 LLM(120ms×3)+스텁 TTS를 도는 중
  const msg = await sessions.forget(ctx, UID, 'all');
  assert.match(msg, /전부 잊었어/);

  await sleep(4000); // 진행 중이던 응답이 완전히 끝나기를 기다린다
  // 핵심 검증: persist·compact가 삭제된 스코프를 재생성하지 않았어야 한다
  await assert.rejects(access(scopeDir), undefined, 'forget 후 스코프 디렉터리가 부활했다');
});

test('/forget here가 무드를 리셋한다 (data-inventory 삭제 범위)', async () => {
  const sessions = createSessions({ toChannel() {} });
  const ch2 = '900000000000000032';
  const ctx2 = { channelId: ch2, guildId: null, isPublic: false };

  const sessionFile = path.join(DIR, `d-${ch2}`, 'session.json');
  const readSaved = () => readFile(sessionFile, 'utf8').then(JSON.parse);

  sessions.submit(ctx2, '테스터', '기분 좋은 얘기', null, UID);
  // 응답이 완전히 끝나(세션 저장) 뒤에 forget해야 —
  // "진행 중 턴은 forget 후 저장된다(설계 동작)"와 섞이지 않는다.
  await waitFor(async () => (await readSaved()).recent.length >= 2);

  await sessions.forget(ctx2, UID, 'here');

  // 쿨다운(3초) 뒤 새 발화, 저장 완료까지 폴링
  await sleep(3100);
  sessions.submit(ctx2, '테스터', '다음 얘기', null, UID);
  await waitFor(async () =>
    (await readSaved()).recent.some((t) => t.content === '다음 얘기'),
  );

  const saved = await readSaved();
  // 스텁 LLM은 감정 마커를 내지 않으므로, forget이 무드를 리셋했다면 중립(0,0) 그대로여야 한다
  assert.equal(saved.mood.v, 0);
  assert.equal(saved.mood.a, 0);
  // history는 forget 이후 턴만
  assert.equal(saved.recent.some((t) => t.content === '기분 좋은 얘기'), false);
});
