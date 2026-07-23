// 방송 오버레이 스타일 채팅 리스트.
// 아래쪽이 최신이고, 각 줄은 일정 시간 뒤 스스로 사라진다.

const VISIBLE_MS = 15_000;
const FADE_MS = 400;
const MAX_LINES = 14; // 넘치면 오래된 것부터 밀어낸다

const css = `
#chat {
  position: fixed;
  left: 12px;
  bottom: 56px;
  width: min(300px, 34vw);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 5px;
  pointer-events: none;
  z-index: 5;
}
#chat .line {
  opacity: 0;
  transform: translateX(-8px);
  transition: opacity ${FADE_MS}ms, transform ${FADE_MS}ms;
  font-size: 0.82rem;
  line-height: 1.45;
  /* 3D 씬 위에 얹히므로 배경 없이도 읽히게 그림자를 준다 */
  text-shadow: 0 1px 3px #000, 0 0 8px #000;
  word-break: break-word;
}
#chat .line.show { opacity: 1; transform: none; }
#chat .who { color: #8fa9ff; font-weight: 600; margin-right: 5px; }
`;

export function mountChat() {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'chat';
  document.body.appendChild(root);

  const remove = (line) => {
    if (!line.isConnected) return;
    line.classList.remove('show');
    setTimeout(() => line.remove(), FADE_MS);
  };

  return {
    // ageMs: 스냅샷으로 받은 지난 메시지는 이미 흐른 시간만큼 빨리 사라진다.
    push(author, text, ageMs = 0) {
      const line = document.createElement('div');
      line.className = 'line';

      // 표시 이름과 본문 모두 사용자 입력이다. 반드시 textContent로 넣는다.
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = author;
      line.append(who, document.createTextNode(text));

      root.appendChild(line);
      requestAnimationFrame(() => line.classList.add('show'));

      setTimeout(() => remove(line), Math.max(1000, VISIBLE_MS - ageMs));
      while (root.children.length > MAX_LINES) remove(root.firstElementChild);
    },
  };
}
