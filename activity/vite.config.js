import { defineConfig } from 'vite';

export default defineConfig({
  // main.js는 최상위 await를 쓴다(ES2022). 기본 빌드 타깃(es2020)은 이를 거부하므로
  // 명시적으로 올린다 — Discord 클라이언트(모던 Chromium)·최신 브라우저 모두 지원한다.
  build: { target: 'es2022' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // cloudflared 터널 호스트명은 실행할 때마다 바뀌므로 전부 허용 (개발 전용)
    allowedHosts: true,
    // 터널은 443/wss로 들어오므로 HMR 클라이언트도 거기에 맞춘다
    hmr: { clientPort: 443, protocol: 'wss' },
    // 봇의 WebSocket 허브를 같은 오리진으로 노출한다.
    // Activity 프록시가 매핑 안 된 도메인을 막으므로 출입구를 하나로 유지해야 한다.
    proxy: {
      // xfwd로 X-Forwarded-For를 붙인다 — 봇이 내부망/외부망을 구분하는 근거.
      '/ws': { target: 'ws://bot:8080', ws: true, xfwd: true },
      // OAuth 토큰 교환 — client secret이 브라우저에 노출되면 안 되므로 서버가 대신 한다
      '/api': { target: 'http://bot:8081', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
