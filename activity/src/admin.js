// 임시 관리자 모드.
// 렌더 결과를 직접 볼 수 없는 환경에서 카메라 프레이밍·포즈 각도를 화면 안에서
// 조정하고, 확정된 값을 JSON으로 내보내 코드(avatar.js의 camParams/POSES)에
// 반영하기 위한 도구다. 값이 확정되면 통째로 제거한다.

// 포즈에서 만질 수 있는 humanoid 본 목록 (VRM 규격 이름)
const BONES = [
  'head', 'neck', 'chest', 'spine',
  'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand',
];

const CAMERA_FIELDS = [
  ['fov', 10, 60, 0.5],
  ['offsetY', -1.5, 1.5, 0.005],
  ['distance', 0.4, 6, 0.01],
  ['lookY', -1.5, 1.5, 0.005],
];

// 모델 자체의 절대 위치 (카메라는 고정)
const POSITION_FIELDS = [
  ['x', -1.5, 1.5, 0.005],
  ['y', -1.5, 1.5, 0.005],
  ['z', -1.5, 1.5, 0.005],
];

const css = `
#admin-toggle {
  position: fixed; top: 8px; right: 8px; z-index: 20;
  width: 30px; height: 30px; padding: 0;
  font-size: 1rem; line-height: 1;
}
#admin-panel {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 19;
  width: 265px; overflow-y: auto;
  background: #111214ee; border-left: 1px solid #3f4147;
  padding: 44px 10px 10px; font-size: 0.72rem;
}
#admin-panel.hidden { display: none; }
#admin-panel details { margin-bottom: 6px; }
#admin-panel summary { cursor: pointer; color: #949ba4; padding: 3px 0; }
#admin-panel .row {
  display: grid; grid-template-columns: 58px 1fr 44px;
  gap: 6px; align-items: center; margin: 2px 0;
}
#admin-panel .row label { color: #949ba4; text-align: right; }
#admin-panel .row output { font-family: ui-monospace, monospace; }
#admin-panel input[type=range] { width: 100%; margin: 0; }
#admin-panel textarea {
  width: 100%; height: 130px; margin-top: 6px;
  background: #1e1f22; color: #dbdee1; border: 1px solid #3f4147;
  font-family: ui-monospace, monospace; font-size: 0.68rem;
}
#admin-panel .actions { display: flex; gap: 6px; margin-top: 6px; }
`;

const fixed2 = (v) => v.toFixed(2);
const asDegrees = (v) => `${Math.round((v * 180) / Math.PI)}°`;

function sliderRow(label, min, max, step, value, onInput, format = fixed2) {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, value });
  const out = document.createElement('output');
  out.textContent = format(Number(value));
  input.addEventListener('input', () => {
    out.textContent = format(Number(input.value));
    onInput(Number(input.value));
  });
  row.append(lab, input, out);
  return { row, input, out };
}

export function mountAdminPanel(avatar) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const toggle = document.createElement('button');
  toggle.id = 'admin-toggle';
  toggle.textContent = '⚙';
  toggle.title = '관리자 모드 (임시)';

  const panel = document.createElement('div');
  panel.id = 'admin-panel';
  panel.classList.add('hidden');
  toggle.addEventListener('click', () => panel.classList.toggle('hidden'));

  // ---- 카메라 ----
  const camDetails = document.createElement('details');
  camDetails.open = true;
  camDetails.innerHTML = '<summary>카메라</summary>';
  const cam = avatar.getCamera();
  for (const [key, min, max, step] of CAMERA_FIELDS) {
    const { row } = sliderRow(key, min, max, step, cam[key], (v) =>
      avatar.setCamera({ [key]: v }),
    );
    camDetails.appendChild(row);
  }
  panel.appendChild(camDetails);

  // ---- 모델 위치·회전 ----
  const posDetails = document.createElement('details');
  posDetails.open = true;
  posDetails.innerHTML = '<summary>위치·회전 (모델)</summary>';
  const pos = avatar.getPosition();
  for (const [key, min, max, step] of POSITION_FIELDS) {
    const { row } = sliderRow(key, min, max, step, pos[key], (v) =>
      avatar.setPosition({ [key]: v }),
    );
    posDetails.appendChild(row);
  }
  const rotRow = sliderRow(
    'rotY',
    -Math.PI,
    Math.PI,
    0.01,
    avatar.getRotationY(),
    (v) => avatar.setRotationY(v),
    asDegrees,
  );
  posDetails.appendChild(rotRow.row);

  const lookRow = document.createElement('div');
  lookRow.className = 'row';
  const lookLabel = document.createElement('label');
  lookLabel.textContent = 'lookAt';
  const lookInput = document.createElement('input');
  lookInput.type = 'checkbox';
  lookInput.checked = avatar.getLookAt();
  lookInput.addEventListener('change', () => avatar.setLookAt(lookInput.checked));
  lookRow.append(lookLabel, lookInput);
  posDetails.appendChild(lookRow);

  panel.appendChild(posDetails);

  // ---- 포즈 본 ----
  const boneInputs = new Map(); // "bone.axis" -> {input, out}

  const syncFromPose = () => {
    const { targets } = avatar.getPoseTargets();
    for (const [key, { input, out }] of boneInputs) {
      const [bone, axis] = key.split('.');
      const v = targets[bone]?.[axis] ?? 0;
      input.value = v;
      out.textContent = v.toFixed(2);
    }
  };

  for (const bone of BONES) {
    const details = document.createElement('details');
    details.innerHTML = `<summary>${bone}</summary>`;
    for (const axis of ['x', 'y', 'z']) {
      const { row, input, out } = sliderRow(axis, -Math.PI, Math.PI, 0.01, 0, (v) =>
        avatar.setBoneTarget(bone, axis, v),
      );
      boneInputs.set(`${bone}.${axis}`, { input, out });
      details.appendChild(row);
    }
    panel.appendChild(details);
  }
  syncFromPose();
  avatar.onPoseChange(syncFromPose);

  // ---- 내보내기 ----
  const exportBox = document.createElement('textarea');
  exportBox.readOnly = true;
  exportBox.placeholder = '내보내기를 누르면 현재 값이 여기 나온다';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const exportBtn = document.createElement('button');
  exportBtn.textContent = '내보내기';
  exportBtn.addEventListener('click', async () => {
    const data = {
      camera: avatar.getCamera(),
      position: avatar.getPosition(),
      rotationY: avatar.getRotationY(),
      pose: avatar.getPoseTargets(),
    };
    const json = JSON.stringify(data, null, 2);
    exportBox.value = json;
    console.log('[admin] 현재 설정:\n' + json);
    try {
      await navigator.clipboard.writeText(json);
      exportBtn.textContent = '복사됨!';
    } catch {
      exportBtn.textContent = '(수동 복사)';
    }
    setTimeout(() => (exportBtn.textContent = '내보내기'), 1500);
  });

  actions.appendChild(exportBtn);
  panel.append(actions, exportBox);

  document.body.append(toggle, panel);
}
