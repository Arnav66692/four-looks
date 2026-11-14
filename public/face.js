// Face engine: camera -> MediaPipe face landmarks -> head vector + face scores, every frame.
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const NOSE = 1, EYE_L = 33, EYE_R = 263;

export async function startFace(video, onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = stream;
  await video.play();
  const files = await FilesetResolver.forVisionTasks(WASM);
  const landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  let last = -1;
  const loop = () => {
    const t = performance.now();
    if (video.currentTime !== last) {
      last = video.currentTime;
      const r = landmarker.detectForVideo(video, t);
      const lm = r.faceLandmarks?.[0];
      if (lm) {
        const mid = { x: (lm[EYE_L].x + lm[EYE_R].x) / 2, y: (lm[EYE_L].y + lm[EYE_R].y) / 2 };
        const eye = Math.hypot(lm[EYE_L].x - lm[EYE_R].x, lm[EYE_L].y - lm[EYE_R].y) || 1;
        const head = [(lm[NOSE].x - mid.x) / eye, (lm[NOSE].y - mid.y) / eye];
        const scores = {};
        for (const c of r.faceBlendshapes?.[0]?.categories || []) scores[c.categoryName] = c.score;
        onFrame({ t, head, scores, face: true });
      } else {
        onFrame({ t, head: null, scores: {}, face: false });
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
