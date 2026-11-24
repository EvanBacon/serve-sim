/**
 * serve-sim 3D device view — the lazily loaded chunk.
 *
 * Built as its own browser entry (`dist/client/device-3d.js`) and served next
 * to the preview page; the main client only `import()`s it when the user turns
 * 3D on, so nobody else pays for it. Framework-free on purpose: the chunk
 * shares no Preact instance with the page.
 *
 * One WebGL2 canvas, a procedural low-poly device (see model.ts), studio
 * lighting from an analytic environment (no HDR / image assets), a soft contact
 * shadow, and the live stream the 2D viewer is already decoding uploaded as the
 * screen texture. It renders on demand — a new stream frame, an orbit, a
 * resize — and is idle otherwise.
 */
import { screenUvToRawMatrix } from "../utils/device-3d-mapping";
import { STREAM_FRAME_EVENT } from "../simulator/stream-frame-event";
import type { StreamConfig } from "../types";
import {
  buildDeviceMesh,
  device3DModel,
  deviceKindFor,
  type Device3DModel,
  type DeviceKitChromeMetrics,
} from "./model";
import {
  clampPitch,
  defaultView,
  nearestAngle,
  pickScreen,
  rollForDeviceDegrees,
  sceneMatrices,
  type SceneMatrices,
  type ScreenHit,
  type ViewState,
} from "./scene";

export type { ScreenHit } from "./scene";

export interface Device3DOptions {
  chrome: DeviceKitChromeMetrics | null;
  deviceType?: string | null;
  /** Sim rotation in CSS degrees (clockwise positive), as the 2D rotor uses. */
  deviceDegrees: number;
  streamConfig: Pick<StreamConfig, "width" | "height" | "orientation"> | null;
  /** Subtree holding the live stream surface (`[data-stream-surface]`). */
  sourceRoot: HTMLElement;
  dark: boolean;
  reducedMotion: boolean;
}

export interface Device3DHandle {
  readonly canvas: HTMLCanvasElement;
  update(options: Partial<Device3DOptions>): void;
  /** Hit-test client (page) coordinates against the device's screen. */
  pick(clientX: number, clientY: number): ScreenHit | null;
  /** Orbit by a pointer delta in CSS pixels. */
  orbitBy(dx: number, dy: number): void;
  /** Continue an orbit with a release velocity (CSS px / ms). */
  fling(vx: number, vy: number): void;
  resetView(): void;
  dispose(): void;
}

const ORBIT_RADIANS_PER_PX = 0.0065;

const DEVICE_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aMat;
uniform mat4 uModel, uView, uProj;
out vec3 vWorld; out vec3 vNormal; out vec3 vLocal; out float vMat;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  vLocal = aPos;
  vMat = aMat;
  gl_Position = uProj * uView * w;
}`;

const ENV_GLSL = `
uniform float uLight;
float softbox(vec3 d, vec3 c, vec3 ref, vec2 h, float soft) {
  float k = dot(d, c);
  if (k <= 0.0) return 0.0;
  vec3 u = normalize(cross(ref, c));
  vec3 v = cross(c, u);
  vec2 q = abs(vec2(dot(d, u), dot(d, v)) / k) - h;
  return (1.0 - smoothstep(-soft, soft, q.x)) * (1.0 - smoothstep(-soft, soft, q.y));
}
// Studio environment: dark cyclorama, a big key softbox up-left, two
// vertical strip lights for edge highlights, and a faint overhead panel.
vec3 env(vec3 d, float rough) {
  float s = 0.015 + rough * 0.55;
  vec3 col = mix(vec3(0.012), vec3(0.045), smoothstep(-0.5, 0.15, d.y));
  col = mix(col, vec3(0.09), smoothstep(0.15, 1.0, d.y));
  col *= 0.8 + 0.6 * uLight;
  vec3 up = vec3(0.0, 1.0, 0.0);
  col += vec3(2.6, 2.55, 2.5) * softbox(d, normalize(vec3(-0.6, 0.5, 0.62)), up, vec2(0.55, 0.32), s);
  col += vec3(1.7) * softbox(d, normalize(vec3(0.92, 0.08, 0.2)), up, vec2(0.07, 0.9), s);
  col += vec3(0.9, 0.95, 1.0) * softbox(d, normalize(vec3(-0.85, 0.0, -0.5)), up, vec2(0.05, 0.85), s);
  col += vec3(0.55) * softbox(d, vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0), vec2(0.7, 0.45), s);
  // Rim strips just behind the device on both sides: catch the metal edge.
  col += vec3(2.2, 2.25, 2.3) * softbox(d, normalize(vec3(0.75, 0.25, -0.62)), up, vec2(0.05, 0.8), s);
  col += vec3(1.5, 1.55, 1.65) * softbox(d, normalize(vec3(-0.7, 0.3, -0.65)), up, vec2(0.05, 0.8), s);
  return col;
}`;

const DEVICE_FS = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec3 vLocal; in float vMat;
uniform vec3 uEye;
uniform sampler2D uScreen;
uniform float uHasFrame;
uniform vec4 uScreenRect;
uniform float uScreenRadius;
uniform vec3 uUvToRawX;
uniform vec3 uUvToRawY;
uniform vec3 uFrameColor;
uniform vec3 uBackColor;
out vec4 outColor;
${ENV_GLSL}
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
float rrect(vec2 p, vec2 h, float r) {
  vec2 q = abs(p) - h + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float fresnel(float f0, float cosT) { return f0 + (1.0 - f0) * pow(1.0 - cosT, 5.0); }
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  float nv = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);
  vec3 color;
  if (vMat < 0.5 || vMat > 2.5) {
    // Brushed titanium band (and the side buttons, polished a bit brighter).
    float button = step(2.5, vMat);
    vec3 base = mix(uFrameColor, min(uFrameColor * 1.3 + 0.06, vec3(1.0)), button);
    vec3 F = base + (1.0 - base) * pow(1.0 - nv, 5.0);
    color = env(R, mix(0.32, 0.22, button)) * F + base * env(N, 1.0) * 0.08;
    // Grazing rim so the edge silhouette reads on the dark backdrop.
    color += base * pow(1.0 - nv, 3.0) * 0.18 * (0.8 + 0.6 * uLight);
  } else if (vMat < 1.5) {
    // Front glass: black display border with the live screen under it.
    vec2 p = vLocal.xy - uScreenRect.xy;
    float sdf = rrect(p, uScreenRect.zw, uScreenRadius);
    float aa = max(fwidth(sdf), 1e-5);
    float inside = 1.0 - smoothstep(-aa, aa, sdf);
    vec2 uv = vec2((p.x + uScreenRect.z) / (2.0 * uScreenRect.z), (uScreenRect.w - p.y) / (2.0 * uScreenRect.w));
    vec2 raw = vec2(dot(uUvToRawX, vec3(uv, 1.0)), dot(uUvToRawY, vec3(uv, 1.0)));
    vec3 screen = toLinear(texture(uScreen, raw).rgb) * uHasFrame;
    color = mix(vec3(0.003), screen, inside);
    color += env(R, 0.02) * fresnel(0.04, nv) * 0.85;
  } else {
    // Matte back glass.
    color = uBackColor * env(N, 1.0) * 0.9 + env(R, 0.5) * fresnel(0.04, nv) * 0.7;
  }
  outColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

const SHADOW_VS = `#version 300 es
layout(location=0) in vec2 aPos;
uniform mat4 uView, uProj;
uniform vec2 uCenter;
uniform float uGround;
uniform float uExtent;
out vec2 vXZ;
void main() {
  vXZ = uCenter + aPos * uExtent;
  gl_Position = uProj * uView * vec4(vXZ.x, uGround, vXZ.y, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vXZ;
uniform vec2 uCenter;
uniform mat2 uInvCovCore;
uniform mat2 uInvCovSoft;
uniform float uCore;
uniform float uSoft;
out vec4 outColor;
void main() {
  vec2 p = vXZ - uCenter;
  // d = 1 on the (blurred) footprint's edge.
  float dc = sqrt(dot(p, uInvCovCore * p));
  float ds = sqrt(dot(p, uInvCovSoft * p));
  float a = uCore * (1.0 - smoothstep(0.2, 1.0, dc)) + uSoft * (1.0 - smoothstep(0.0, 1.0, ds));
  outColor = vec4(0.0, 0.0, 0.0, clamp(a, 0.0, 1.0));
}`;

type SourceElement = HTMLCanvasElement | HTMLImageElement;

export function findStreamSurface(root: ParentNode): SourceElement | null {
  return root.querySelector<SourceElement>("canvas[data-stream-surface], img[data-stream-surface]");
}

export function mountDevice3D(host: HTMLElement, initial: Device3DOptions): Device3DHandle {
  let options = { ...initial };
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.device3dCanvas = "";
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
    powerPreference: "default",
  });
  if (!gl) throw new Error("WebGL2 is unavailable in this browser.");
  host.appendChild(canvas);

  const deviceProgram = program(gl, DEVICE_VS, DEVICE_FS);
  const shadowProgram = program(gl, SHADOW_VS, SHADOW_FS);
  const du = uniforms(gl, deviceProgram, [
    "uModel", "uView", "uProj", "uEye", "uScreen", "uHasFrame", "uScreenRect", "uScreenRadius",
    "uUvToRawX", "uUvToRawY", "uFrameColor", "uBackColor", "uLight",
  ]);
  const su = uniforms(gl, shadowProgram, [
    "uView", "uProj", "uCenter", "uGround", "uExtent", "uInvCovCore", "uInvCovSoft", "uCore", "uSoft",
  ]);

  // Device mesh.
  const deviceVao = gl.createVertexArray()!;
  const deviceVbo = gl.createBuffer()!;
  const deviceIbo = gl.createBuffer()!;
  let indexCount = 0;
  let model: Device3DModel = currentModel();
  uploadMesh();

  // Shadow quad.
  const shadowVao = gl.createVertexArray()!;
  const shadowVbo = gl.createBuffer()!;
  gl.bindVertexArray(shadowVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, shadowVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Screen texture (the live stream).
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  let texSize = { width: 0, height: 0 };
  let hasFrame = false;
  let frameDirty = true;

  // View state + animation.
  const view: ViewState = defaultView(rollForDeviceDegrees(options.deviceDegrees));
  let rollTarget = view.roll;
  let yawTarget: number | null = null;
  let pitchTarget: number | null = null;
  let velocity = { yaw: 0, pitch: 0 };
  let scene: SceneMatrices | null = null;
  let raf = 0;
  let lastTick = 0;
  let disposed = false;
  let contextLost = false;

  // Stream surface tracking: re-bind when the viewer swaps <canvas>/<img>.
  let source: SourceElement | null = null;
  const onFrame = () => {
    frameDirty = true;
    invalidate();
  };
  const bindSource = () => {
    const next = findStreamSurface(options.sourceRoot);
    if (next === source) return;
    source?.removeEventListener("load", onFrame);
    source?.removeEventListener(STREAM_FRAME_EVENT, onFrame);
    source = next;
    source?.addEventListener("load", onFrame);
    source?.addEventListener(STREAM_FRAME_EVENT, onFrame);
    onFrame();
  };
  let observer = new MutationObserver(bindSource);
  observer.observe(options.sourceRoot, { childList: true, subtree: true });
  bindSource();

  const resizeObserver = new ResizeObserver(() => invalidate());
  resizeObserver.observe(host);

  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  function currentModel(): Device3DModel {
    const size = options.streamConfig ?? { width: 1, height: 2 };
    const kind = deviceKindFor(options.deviceType, options.chrome?.body ?? size, options.chrome?.identifier);
    return device3DModel(options.chrome, size, kind);
  }

  function uploadMesh() {
    const mesh = buildDeviceMesh(model);
    gl!.bindVertexArray(deviceVao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, deviceVbo);
    gl!.bufferData(gl!.ARRAY_BUFFER, mesh.vertices, gl!.STATIC_DRAW);
    gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, deviceIbo);
    gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, mesh.indices, gl!.STATIC_DRAW);
    const stride = 7 * 4;
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, stride, 0);
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 3, gl!.FLOAT, false, stride, 12);
    gl!.enableVertexAttribArray(2);
    gl!.vertexAttribPointer(2, 1, gl!.FLOAT, false, stride, 24);
    gl!.bindVertexArray(null);
    indexCount = mesh.indices.length;
  }

  function uploadFrame() {
    frameDirty = false;
    const el = source;
    if (!el) return;
    const width = el instanceof HTMLCanvasElement ? el.width : el.naturalWidth;
    const height = el instanceof HTMLCanvasElement ? el.height : el.naturalHeight;
    if (!width || !height) return;
    if (el instanceof HTMLImageElement && !el.complete) return;
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
    gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      if (width !== texSize.width || height !== texSize.height) {
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, el);
        texSize = { width, height };
      } else {
        gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, el);
      }
      gl!.generateMipmap(gl!.TEXTURE_2D);
      hasFrame = true;
    } catch {
      // A not-yet-decoded / torn-down frame: keep the previous one.
    }
  }

  function invalidate() {
    if (disposed || raf) return;
    raf = requestAnimationFrame(tick);
  }

  function tick(now: number) {
    raf = 0;
    if (disposed || contextLost) return;
    const dt = lastTick ? Math.min(64, now - lastTick) : 16;
    lastTick = now;
    const animating = step(dt);
    if (frameDirty) uploadFrame();
    draw();
    if (animating) invalidate();
    else lastTick = 0;
  }

  /** Advance tweens / inertia. Returns whether anything is still moving. */
  function step(dt: number): boolean {
    let moving = false;
    const ease = options.reducedMotion ? 1 : 1 - Math.exp(-dt / 90);
    const approach = (from: number, to: number) => {
      const next = from + (to - from) * ease;
      if (Math.abs(to - next) < 1e-4) return to;
      moving = true;
      return next;
    };
    view.roll = approach(view.roll, rollTarget);
    if (yawTarget !== null) {
      view.yaw = approach(view.yaw, yawTarget);
      if (view.yaw === yawTarget) yawTarget = null;
    }
    if (pitchTarget !== null) {
      view.pitch = approach(view.pitch, pitchTarget);
      if (view.pitch === pitchTarget) pitchTarget = null;
    }
    if (velocity.yaw || velocity.pitch) {
      view.yaw += velocity.yaw * dt;
      view.pitch = clampPitch(view.pitch + velocity.pitch * dt);
      const decay = Math.exp(-dt / 260);
      velocity = { yaw: velocity.yaw * decay, pitch: velocity.pitch * decay };
      if (Math.abs(velocity.yaw) < 2e-5 && Math.abs(velocity.pitch) < 2e-5) velocity = { yaw: 0, pitch: 0 };
      else moving = true;
    }
    return moving;
  }

  function resize(): { width: number; height: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height };
  }

  function draw() {
    const g = gl!;
    const { width, height } = resize();
    g.viewport(0, 0, width, height);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    scene = sceneMatrices(model, view, width / height);
    const light = options.dark ? 0 : 1;

    // Contact shadow on the ground under the device.
    const gap = Math.max(0, scene.bottomY - scene.groundY);
    const visible = scene.eye[1]! > scene.groundY + 0.02 ? 1 : 0;
    const axes = [
      [model.width / 2, 0, 0],
      [0, model.height / 2, 0],
      [0, 0, model.depth / 2],
    ].map((a) => {
      const m = scene!.model;
      return [m[0]! * a[0]! + m[4]! * a[1]! + m[8]! * a[2]!, m[2]! * a[0]! + m[6]! * a[1]! + m[10]! * a[2]!];
    });
    // Footprint of the posed body on the ground: the covariance of its half
    // axes projected onto xz, widened by a blur that grows with the gap.
    const cov = (blur: number) => {
      let xx = blur * blur, xz = 0, zz = blur * blur;
      for (const [x, z] of axes) {
        xx += x! * x!;
        xz += x! * z!;
        zz += z! * z!;
      }
      return inverse2(xx, xz, zz);
    };
    g.useProgram(shadowProgram);
    g.uniformMatrix4fv(su.uView, false, scene.view);
    g.uniformMatrix4fv(su.uProj, false, scene.projection);
    g.uniform2f(su.uCenter, 0, 0);
    g.uniform1f(su.uGround, scene.groundY);
    g.uniform1f(su.uExtent, Math.max(model.width, model.height) * 0.9);
    g.uniformMatrix2fv(su.uInvCovCore, false, cov(0.018 + gap * 0.35));
    g.uniformMatrix2fv(su.uInvCovSoft, false, cov(0.07 + gap * 0.6));
    g.uniform1f(su.uCore, visible * (light ? 0.38 : 0.7) * Math.exp(-gap * 14));
    g.uniform1f(su.uSoft, visible * (light ? 0.1 : 0.3) * Math.exp(-gap * 2.5));
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    g.bindVertexArray(shadowVao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);

    // Device.
    g.disable(g.BLEND);
    g.enable(g.DEPTH_TEST);
    g.useProgram(deviceProgram);
    g.uniformMatrix4fv(du.uModel, false, scene.model);
    g.uniformMatrix4fv(du.uView, false, scene.view);
    g.uniformMatrix4fv(du.uProj, false, scene.projection);
    g.uniform3fv(du.uEye, scene.eye);
    const sc = model.screen;
    g.uniform4f(du.uScreenRect, sc.x, sc.y, sc.halfWidth, sc.halfHeight);
    g.uniform1f(du.uScreenRadius, sc.radius);
    const [a, b, c, d, tx, ty] = screenUvToRawMatrix(options.deviceDegrees, options.streamConfig);
    g.uniform3f(du.uUvToRawX, a, c, tx);
    g.uniform3f(du.uUvToRawY, b, d, ty);
    g.uniform1f(du.uHasFrame, hasFrame ? 1 : 0);
    g.uniform3f(du.uFrameColor, 0.3, 0.3, 0.31);
    g.uniform3f(du.uBackColor, 0.05, 0.05, 0.055);
    g.uniform1f(du.uLight, light);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, texture);
    g.uniform1i(du.uScreen, 0);
    g.bindVertexArray(deviceVao);
    g.drawElements(g.TRIANGLES, indexCount, g.UNSIGNED_SHORT, 0);
    g.bindVertexArray(null);
  }

  invalidate();

  return {
    canvas,
    update(next) {
      if (disposed) return;
      const prev = options;
      options = { ...options, ...next };
      if (next.sourceRoot && next.sourceRoot !== prev.sourceRoot) {
        observer.disconnect();
        observer = new MutationObserver(bindSource);
        observer.observe(options.sourceRoot, { childList: true, subtree: true });
        bindSource();
      }
      if (next.chrome !== undefined || next.deviceType !== undefined || next.streamConfig !== undefined) {
        const nextModel = currentModel();
        if (JSON.stringify(nextModel) !== JSON.stringify(model)) {
          model = nextModel;
          uploadMesh();
        }
      }
      if (next.deviceDegrees !== undefined) {
        rollTarget = nearestAngle(view.roll, rollForDeviceDegrees(options.deviceDegrees));
      }
      invalidate();
    },
    pick(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const s = scene ?? sceneMatrices(model, view, rect.width / rect.height);
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      return pickScreen(model, s, ndcX, ndcY);
    },
    orbitBy(dx, dy) {
      yawTarget = null;
      pitchTarget = null;
      velocity = { yaw: 0, pitch: 0 };
      view.yaw += dx * ORBIT_RADIANS_PER_PX;
      view.pitch = clampPitch(view.pitch + dy * ORBIT_RADIANS_PER_PX);
      invalidate();
    },
    fling(vx, vy) {
      if (options.reducedMotion) return;
      velocity = { yaw: vx * ORBIT_RADIANS_PER_PX, pitch: vy * ORBIT_RADIANS_PER_PX };
      invalidate();
    },
    resetView() {
      const home = defaultView();
      velocity = { yaw: 0, pitch: 0 };
      // Unwind whole turns so the reset takes the short way home.
      yawTarget = nearestAngle(view.yaw, home.yaw);
      pitchTarget = home.pitch;
      invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      observer.disconnect();
      resizeObserver.disconnect();
      source?.removeEventListener("load", onFrame);
      source?.removeEventListener(STREAM_FRAME_EVENT, onFrame);
      source = null;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      gl.deleteTexture(texture);
      gl.deleteBuffer(deviceVbo);
      gl.deleteBuffer(deviceIbo);
      gl.deleteBuffer(shadowVbo);
      gl.deleteVertexArray(deviceVao);
      gl.deleteVertexArray(shadowVao);
      gl.deleteProgram(deviceProgram);
      gl.deleteProgram(shadowProgram);
      // Hand the GPU context back now rather than whenever GC gets to it.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    },
  };
}

function inverse2(xx: number, xz: number, zz: number): Float32Array {
  const det = xx * zz - xz * xz || 1e-9;
  return new Float32Array([zz / det, -xz / det, -xz / det, xx / det]);
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`3D shader failed to compile: ${log}`);
    }
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`3D shader failed to link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function uniforms<K extends string>(
  gl: WebGL2RenderingContext,
  p: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>;
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}
