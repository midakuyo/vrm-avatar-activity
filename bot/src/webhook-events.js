// Discord Webhook Events 수신 (개발자 포털 → Webhooks 탭에 등록하는 아웃바운드 웹훅).
//
// 경로: Discord → 리버스 프록시 → vite /api 프록시 → 여기(:8081 /webhook-events).
// 다루는 이벤트 둘:
//   APPLICATION_AUTHORIZED   — 설치 감시선. 본인/팀 외 설치가 보이면 포털 설정 사고다.
//   APPLICATION_DEAUTHORIZED — 유저가 설정→인증된 앱에서 접근권한을 철회.
//                              전 스코프에서 프로필 즉시 파기 (개보법 "동의 철회 시
//                              지체 없는 파기" — docs/privacy-plan.md의 삭제 연동).
//
// 규정(문서): 모든 요청의 Ed25519 서명을 검증해야 하고(실패 시 401 — 디스코드가
// 주기 점검으로 검증 안 하는 엔드포인트를 제거한다), 3초 안에 204를 돌려줘야 한다.
// 그래서 응답을 먼저 보내고 파기는 그 뒤에 한다.

import { createPublicKey, verify } from 'node:crypto';
import { purgeUserEverywhere } from './memory.js';

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY ?? '';

// Node crypto는 원시 32바이트 ed25519 키를 바로 못 받는다 — SPKI DER 헤더를 붙여 감싼다.
let KEY = null;
try {
  if (/^[0-9a-f]{64}$/i.test(PUBLIC_KEY)) {
    KEY = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'), // SPKI(ed25519) 고정 프리픽스
        Buffer.from(PUBLIC_KEY, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
  }
} catch {
  KEY = null; // 키가 불량이면 모든 요청이 401 — 등록 자체가 실패해서 바로 드러난다
}

export const isConfigured = Boolean(KEY);

export function verifySignature(signature, timestamp, rawBody) {
  if (!KEY || typeof signature !== 'string' || typeof timestamp !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(timestamp + rawBody, 'utf8'),
      KEY,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false; // 서명이 hex가 아니거나 길이 불량
  }
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('본문이 너무 큽니다');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleWebhookEvent(req, res) {
  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    res.writeHead(413).end();
    return;
  }

  const ok = verifySignature(
    req.headers['x-signature-ed25519'],
    req.headers['x-signature-timestamp'],
    raw,
  );
  if (!ok) {
    res.writeHead(401).end();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400).end();
    return;
  }

  // 3초 규정 — 처리보다 응답이 먼저다. PING(type 0)도 이 204로 충족된다.
  res.writeHead(204).end();

  if (payload.type !== 1 || !payload.event) return;
  const ev = payload.event;
  try {
    if (ev.type === 'APPLICATION_AUTHORIZED') {
      const d = ev.data ?? {};
      const where = d.guild
        ? `길드 ${d.guild.id}(${d.guild.name ?? '?'})`
        : d.integration_type === 1
          ? '유저 계정(user install!)' // User Install은 꺼둔 정책 — 보이면 포털 확인
          : 'OAuth 승인';
      console.warn(
        `[webhook] 앱 설치/승인: ${d.user?.username ?? '?'}(${d.user?.id ?? '?'}) → ${where}` +
          ` scopes=${(d.scopes ?? []).join(',')}`,
      );
    } else if (ev.type === 'APPLICATION_DEAUTHORIZED') {
      const uid = ev.data?.user?.id;
      const n = await purgeUserEverywhere(uid);
      console.warn(
        `[webhook] 접근권한 철회: ${ev.data?.user?.username ?? '?'}(${uid}) — 프로필 ${n}개 파기`,
      );
    } else {
      console.log(`[webhook] 미구독 이벤트 수신: ${ev.type}`);
    }
  } catch (err) {
    console.error('[webhook] 처리 오류:', err.message);
  }
}
