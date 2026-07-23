import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// 프레이밍 기본값은 모델마다 다시 잡아야 한다.
// (관리자 모드에서 조정 → 내보내기 → 여기 반영)
// 모델은 원점에 둔다 — x를 옮기면 창 크기에 따라 치우침이 달라져
// "항상 중앙"이 깨진다. 구도는 카메라 파라미터로만 잡는다.
export const DEFAULT_FRAMING = {
  camera: { fov: 30, offsetY: 0, distance: 1.33, lookY: 0 },
  position: { x: 0, y: 0, z: 0 },
  rotationY: 0,
};

// 이 종횡비보다 좁은 창(세로형)에서는 수평 시야가 부족해 어깨가 잘린다.
// 부족한 만큼 카메라를 뒤로 물려 캐릭터 전체 폭이 항상 화면 안에 들게 한다.
const REF_ASPECT = 0.8;

export const EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];

// 립싱크 채널. 감정 채널과 별도로 써서 additive하게 겹친다.
export const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

// 프리셋 포즈는 정규화된 humanoid 본의 회전값(라디안)으로만 기술한다.
// 본 이름은 VRM 규격 이름이라 모델이 바뀌어도 그대로 쓸 수 있다.
// 회전 규약(실측): 왼팔은 -z가 내림, 오른팔은 +z가 내림.
export const POSES = {
  // VRM 기본은 T/A 포즈. 팔을 내려 자연스럽게 세운다.
  idle: {
    leftUpperArm: { z: -1.2 },
    rightUpperArm: { z: 1.2 },
    leftLowerArm: { z: -0.15 },
    rightLowerArm: { z: 0.15 },
  },
  wave: {
    leftUpperArm: { z: -1.2 },
    rightUpperArm: { z: -0.5, x: -0.2 },
    rightLowerArm: { z: -0.9 },
    head: { z: -0.12 },
  },
  think: {
    leftUpperArm: { z: -1.2 },
    rightUpperArm: { z: -0.75 },
    rightLowerArm: { z: -1.5 },
    head: { x: 0.12, z: 0.2 },
    spine: { y: 0.1 },
  },
  bow: {
    leftUpperArm: { z: -1.35 },
    rightUpperArm: { z: 1.35 },
    spine: { x: 0.45 },
    head: { x: 0.2 },
  },
};

const damp = (current, target, lambda, dt) =>
  THREE.MathUtils.damp(current, target, lambda, dt);

export async function createAvatarStage(container, modelUrl, { onProgress } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);

  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(1, 2, 2);
  scene.add(key);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(modelUrl, (e) => {
    if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
  });

  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('VRM 데이터가 없습니다. .vrm 파일이 맞는지 확인하세요.');

  // VRM0는 +Z를 등지고 있어 180도 돌려야 정면이 된다.
  if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);

  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);

  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });
  scene.add(vrm.scene);

  const head = vrm.humanoid.getNormalizedBoneNode('head');

  // 정면(카메라 쪽)을 보게 한다.
  // 모델을 회전시킨 상태를 확인할 때는 꺼야 시선이 정면에 붙지 않는다.
  const lookAtTarget = new THREE.Object3D();
  camera.add(lookAtTarget);
  scene.add(camera);
  if (vrm.lookAt) vrm.lookAt.target = lookAtTarget;

  // ---- 채널별 목표값. update()에서 실제 가중치로 수렴시킨다. ----
  // 표정은 믹스(이름→목표 가중치)다 — 무드 좌표가 인접 프리셋 2개를 블렌드해 보낸다.
  let emotionTargets = { neutral: 1 };
  const visemeWeights = Object.fromEntries(VISEMES.map((v) => [v, 0]));
  const emotionWeights = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));
  emotionWeights.neutral = 1;

  // 프리셋을 직접 참조하지 않고 복사해서 쓴다.
  // 관리자 모드가 실시간으로 수정해도 원본 프리셋이 오염되지 않게.
  let poseName = 'idle';
  let poseTargets = structuredClone(POSES.idle);
  const poseState = new Map();
  const poseListeners = new Set();

  const applyPose = (dt) => {
    const bones = new Set([
      ...Object.keys(poseTargets),
      ...[...poseState.keys()].map((k) => k.split('.')[0]),
    ]);
    for (const boneName of bones) {
      const node = vrm.humanoid.getNormalizedBoneNode(boneName);
      if (!node) continue;
      const target = poseTargets[boneName] ?? {};
      for (const axis of ['x', 'y', 'z']) {
        const key = `${boneName}.${axis}`;
        const want = target[axis] ?? 0;
        const now = poseState.get(key) ?? node.rotation[axis];
        const next = damp(now, want, 4, dt);
        poseState.set(key, next);
        node.rotation[axis] = next;
      }
    }
  };

  // 정규화 본의 트랜스폼은 프레임마다 초기화되지 않는다.
  // 호흡은 += 로 누적시키면 안 되고 항상 기준값에서 다시 계산해야 한다.
  const headRestY = head ? head.position.y : 0;

  // ---- 자동 눈깜빡임 ----
  let nextBlink = 1 + Math.random() * 4;
  let blinkPhase = -1;

  const clock = new THREE.Clock();

  // 카메라 프레이밍 파라미터. 관리자 모드에서 실시간 조정 가능.
  const camParams = { ...DEFAULT_FRAMING.camera };

  // 머리 높이는 모델을 옮기기 전, 원점 상태에서 한 번만 재서 고정한다.
  // 옮긴 뒤에 재면 카메라가 같이 따라가 position.y 조정이 상쇄되어 사라진다.
  vrm.scene.updateWorldMatrix(true, true);
  const headBaseY = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.35;

  vrm.scene.position.set(
    DEFAULT_FRAMING.position.x,
    DEFAULT_FRAMING.position.y,
    DEFAULT_FRAMING.position.z,
  );

  // VRM0는 위에서 rotateVRM0로 이미 y에 180도가 걸려 있다.
  // 회전 조정은 그 값을 덮어쓰지 않도록 기준값에서의 차이로만 다룬다.
  const baseRotationY = vrm.scene.rotation.y;
  vrm.scene.rotation.y = baseRotationY + DEFAULT_FRAMING.rotationY;

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    // updateStyle을 끄면 안 된다 — CSS 크기 지정이 없으면 캔버스가 내부 픽셀
    // 크기(w×dpr)로 표시되어 창을 넘치고, 렌더링 중심이 오른쪽·아래로 밀린다.
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = camParams.fov;
    camera.updateProjectionMatrix();

    // 머리 높이에 맞춰 상반신을 잡는다. 카메라와 시선이 모두 x=0이라
    // 원점의 캐릭터는 어떤 창 크기에서도 수평 중앙이다.
    // 좁은 창에서는 수평 시야가 줄어든 만큼 뒤로 물러난다 (세로 구도는 유지).
    const zoomOut = Math.max(1, REF_ASPECT / camera.aspect);
    camera.position.set(0, headBaseY + camParams.offsetY, camParams.distance * zoomOut);
    camera.lookAt(0, headBaseY + camParams.lookY, 0);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const em = vrm.expressionManager;

  // 외부 애니메이션(모션 컨트롤러)이 붙으면 프리셋 포즈·호흡을 끈다 —
  // 둘 다 본 트랜스폼을 매 프레임 쓰므로 공존하면 서로 싸운다.
  let beforeUpdate = null;
  let posesEnabled = true;

  const update = () => {
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    beforeUpdate?.(dt);

    // 감정 채널: 믹스의 목표 가중치로 수렴 (목표에 없는 감정은 0으로)
    let nonNeutral = 0;
    for (const name of EMOTIONS) {
      const want = emotionTargets[name] ?? 0;
      emotionWeights[name] = damp(emotionWeights[name], want, 6, dt);
      if (name !== 'neutral') {
        em?.setValue(name, emotionWeights[name]);
        nonNeutral += emotionWeights[name];
      }
    }

    // 립싱크 채널: 감정과 독립적으로 얹되, 표정이 짙을수록 입을 양보한다 —
    // 감정 표정 대부분이 입 모양을 포함해 풀 립싱크와 싸운다 (ChatVRM의 0.5→0.25 감쇠).
    const lipShare = 1 - 0.5 * Math.min(1, nonNeutral);
    for (const v of VISEMES) em?.setValue(v, visemeWeights[v] * lipShare);

    // 눈깜빡임
    if (blinkPhase < 0) {
      nextBlink -= dt;
      if (nextBlink <= 0) {
        blinkPhase = 0;
        nextBlink = 2 + Math.random() * 5;
      }
    } else {
      blinkPhase += dt / 0.12;
      const w = blinkPhase < 1 ? Math.sin(blinkPhase * Math.PI) : 0;
      em?.setValue('blink', w);
      if (blinkPhase >= 1) blinkPhase = -1;
    }

    if (posesEnabled) {
      applyPose(dt);
      // 호흡: 포즈 위에 얹는 미세한 상하 움직임 (애니메이션 클립에는 이미 포함됨)
      if (head) head.position.y = headRestY + Math.sin(t * 1.1) * 0.004;
    }

    vrm.update(dt);
    renderer.render(scene, camera);
  };

  renderer.setAnimationLoop(update);

  return {
    vrm,
    // 단일 감정 (관리자 버튼용) — 내부적으로 믹스 하나짜리.
    setEmotion(name, weight = 1) {
      if (!EMOTIONS.includes(name)) throw new Error(`알 수 없는 감정: ${name}`);
      emotionTargets = { [name]: weight };
    },
    // 표정 믹스 (⑧): [{name, weight}, ...] — 백엔드 무드가 보낸 인접 프리셋 블렌드.
    setEmotionMix(list) {
      const targets = {};
      for (const { name, weight } of list ?? []) {
        if (EMOTIONS.includes(name)) targets[name] = Math.min(1, Math.max(0, weight ?? 0));
      }
      emotionTargets = Object.keys(targets).length ? targets : { neutral: 1 };
    },
    setPose(name) {
      const pose = POSES[name];
      if (!pose) throw new Error(`알 수 없는 포즈: ${name}`);
      poseName = name;
      poseTargets = structuredClone(pose);
      for (const fn of poseListeners) fn(name);
    },
    // ---- 이하 관리자 모드용 조정 API ----
    getCamera() {
      return { ...camParams };
    },
    setCamera(partial) {
      Object.assign(camParams, partial);
      resize();
    },
    // 모델 자체의 절대 위치. 카메라는 따라가지 않는다.
    getPosition() {
      const { x, y, z } = vrm.scene.position;
      return { x, y, z };
    },
    setPosition(partial) {
      Object.assign(vrm.scene.position, partial);
    },
    // Y축 회전(라디안). 모델이 원래 향한 방향을 0으로 본다.
    getRotationY() {
      return vrm.scene.rotation.y - baseRotationY;
    },
    setRotationY(radians) {
      vrm.scene.rotation.y = baseRotationY + radians;
    },
    getLookAt() {
      return Boolean(vrm.lookAt?.target);
    },
    setLookAt(enabled) {
      if (vrm.lookAt) vrm.lookAt.target = enabled ? lookAtTarget : null;
    },
    getPoseTargets() {
      return { name: poseName, targets: structuredClone(poseTargets) };
    },
    setBoneTarget(bone, axis, value) {
      (poseTargets[bone] ??= {})[axis] = value;
    },
    onPoseChange(fn) {
      poseListeners.add(fn);
      return () => poseListeners.delete(fn);
    },
    // 립싱크가 붙기 전까지는 수동 확인용. 나중에 오디오 envelope가 이 자리에 들어온다.
    setViseme(name, weight) {
      if (name in visemeWeights) visemeWeights[name] = weight;
    },
    availableExpressions() {
      return em ? Object.keys(em.expressionMap ?? {}) : [];
    },
    // 모션 컨트롤러 연결: 매 프레임 mixer.update를 돌리고 프리셋 포즈를 끈다.
    attachMotion(motion) {
      beforeUpdate = (dt) => motion.update(dt);
      posesEnabled = false;
    },

    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
