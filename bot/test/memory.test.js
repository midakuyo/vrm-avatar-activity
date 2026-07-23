// 기억 저장소 단위 테스트 — frontmatter, 원문 로그, 보존기간.
// 실행: docker compose run --rm bot npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DATA_DIR은 모듈 로드 시점에 읽히므로 import 전에 심는다.
const DIR = await mkdtemp(path.join(tmpdir(), 'memtest-'));
process.env.DATA_DIR = DIR;
process.env.LOG_RETENTION_DAYS = '180';
process.env.PROFILE_RETENTION_MONTHS = '12';

const mem = await import('../src/memory.js');

after(() => rm(DIR, { recursive: true, force: true }));

const SCOPE = 'd-900000000000000010';
const UID = '900000000000000099';

test('splitUserMd: frontmatter 없는 레거시 파일은 본문 그대로', () => {
  const { meta, body } = mem.splitUserMd('# 유저\n- 취향\n');
  assert.deepEqual(meta, {});
  assert.equal(body, '# 유저\n- 취향\n');
});

test('joinUserMd ↔ splitUserMd 왕복: 숫자는 숫자로, 날짜는 문자열로', () => {
  const raw = mem.joinUserMd({ affinity: 0.6, interactions: 12, lastSeen: '2026-07-22' }, '# 본문\n');
  const { meta, body } = mem.splitUserMd(raw);
  assert.equal(meta.affinity, 0.6);
  assert.equal(meta.interactions, 12);
  assert.equal(meta.lastSeen, '2026-07-22'); // Number()에 NaN → 문자열 유지
  assert.equal(body, '# 본문\n');
});

test('touchUser: 없던 파일에 메타 생성, 반복 호출에 interactions 증가', async () => {
  await mem.touchUser(SCOPE, UID);
  await mem.touchUser(SCOPE, UID);
  const meta = await mem.loadUserMeta(SCOPE, UID);
  assert.equal(meta.interactions, 2);
  assert.equal(meta.affinity, 0);
  assert.match(String(meta.lastSeen), /^\d{4}-\d{2}-\d{2}$/);
});

test('saveUserMd: LLM 본문 저장이 기존 메타를 보존한다', async () => {
  await mem.saveUserMd(SCOPE, UID, '# 유저\n- 매운 음식을 좋아함\n');
  const meta = await mem.loadUserMeta(SCOPE, UID);
  const body = await mem.loadUserMd(SCOPE, UID);
  assert.equal(meta.interactions, 2); // touchUser가 만든 메타 유지
  assert.equal(body.includes('매운 음식'), true);
  assert.equal(body.includes('---'), false); // LLM에 보이는 본문에 frontmatter 없음
});

test('appendLog + purgeLog: 보존기간 지난 줄만 제거', async () => {
  const oldDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
  await mem.appendLog(SCOPE, [
    { role: 'user', uid: UID, author: '테스터', content: '오래된 말', at: oldDate },
    { role: 'user', uid: UID, author: '테스터', content: '최근 말', at: new Date().toISOString() },
  ]);
  await mem.purgeLog(SCOPE);
  const raw = await readFile(path.join(DIR, SCOPE, 'log.jsonl'), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].content, '최근 말');
});

test('stripUserFromLog: 해당 uid 줄만 제거, 아바타 응답 줄은 유지', async () => {
  await mem.appendLog(SCOPE, [
    { role: 'user', uid: UID, author: '테스터', content: '내 발화', at: new Date().toISOString() },
    { role: 'assistant', content: '아바타 응답', at: new Date().toISOString() },
  ]);
  await mem.stripUserFromLog(SCOPE, UID);
  const raw = await readFile(path.join(DIR, SCOPE, 'log.jsonl'), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.some((l) => l.uid === UID), false);
  assert.equal(lines.some((l) => l.content === '아바타 응답'), true);
});

test('clearLog: 로그 파일 삭제', async () => {
  await mem.clearLog(SCOPE);
  await assert.rejects(access(path.join(DIR, SCOPE, 'log.jsonl')));
});

test('retentionSweep: 오래 안 본 프로필은 파기, 최근 프로필은 유지, 레거시는 오늘부터 시계', async () => {
  const scope2 = 'g-900000000000000001/public';
  const usersDir = path.join(DIR, scope2, 'users');
  await mkdir(usersDir, { recursive: true });
  const expired = mem.joinUserMd(
    { affinity: 0, interactions: 5, lastSeen: '2025-01-01' }, '# 옛 유저\n');
  await writeFile(path.join(usersDir, '900000000000000001.md'), expired);
  const fresh = mem.joinUserMd(
    { affinity: 0, interactions: 5, lastSeen: new Date().toISOString().slice(0, 10) }, '# 최근 유저\n');
  await writeFile(path.join(usersDir, '900000000000000002.md'), fresh);
  await writeFile(path.join(usersDir, '900000000000000003.md'), '# 레거시 유저\n');

  await mem.retentionSweep();

  await assert.rejects(access(path.join(usersDir, '900000000000000001.md')));
  await access(path.join(usersDir, '900000000000000002.md'));
  const legacy = mem.splitUserMd(await readFile(path.join(usersDir, '900000000000000003.md'), 'utf8'));
  assert.match(String(legacy.meta.lastSeen), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(legacy.meta.interactions, 0); // 스탬프는 대화가 아니다
  assert.equal(legacy.body.includes('레거시 유저'), true);
});

test('비스노우플레이크 uid는 어떤 쓰기도 만들지 않는다', async () => {
  await mem.touchUser(SCOPE, '../../etc/passwd');
  await mem.saveUserMd(SCOPE, 'not-a-uid', '# x');
  const users = path.join(DIR, SCOPE, 'users');
  const files = await readFile(path.join(users, '../../etc/passwd.md'), 'utf8').catch(() => null);
  assert.equal(files, null);
});

test('guide.md(관리자 지식)는 loadContext에 포함되고 자동 쓰기 경로가 없다', async () => {
  const scope = 'g-900000000000000001/public';
  await writeFile(path.join(DIR, scope, 'guide.md'), '## 이 서버의 봇들\n- 뮤직봇: /play\n');
  const ctx = await mem.loadContext([scope], []);
  assert.match(ctx.guide, /뮤직봇/); // 안내는 guide로 분리
  assert.equal(ctx.memory.includes('뮤직봇'), false);
});

test('경로순회 차단: 비정상 스코프는 읽기·쓰기·삭제 전부 거부 (보안감사 #2)', async () => {
  // 정상 스코프는 동작
  await mem.saveScopeMd('d-900000000000000010', '정상');
  assert.equal((await mem.loadScopeMd('d-900000000000000010')).trim(), '정상');
  // 경로순회·비정상 형식은 예외 (DATA_DIR 밖·타 스코프 접근 차단)
  for (const evil of ['mem-x/../d-777', 'd-999/../../etc', '../secret', 'g-1/p-2/../public', 'mem-abc']) {
    await assert.rejects(mem.saveScopeMd(evil, 'HACK'), /잘못된 스코프/, `쓰기 차단: ${evil}`);
    await assert.rejects(mem.loadScopeMd(evil), /잘못된 스코프/, `읽기 차단: ${evil}`);
  }
  // 정상 3형식은 통과
  for (const ok of ['d-1', 'g-1/public', 'g-1/p-2']) {
    assert.doesNotThrow(() => mem.loadUserMeta(ok, '900000000000000099'));
  }
})
