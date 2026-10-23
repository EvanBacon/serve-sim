// WebGL renderer for the experimental 3D view hierarchy: one textured plane
// per view, exploded along z by layout level, drawn back-to-front (painter's
// algorithm — every plane is parallel, so no depth buffer is needed).
import { subRectUv, type Layout } from "../../hierarchy-3d/layout";
import type { HierarchyCapture, HierarchyRect } from "../../hierarchy-3d/model";
import { cameraEye, pickPlane, viewProjection, type OrbitCamera, type PickPlane } from "./projection";

export interface SceneOptions {
  spacing: number;
  textures: boolean;
  outlines: boolean;
  /** Inclusive level range to draw. */
  minLevel: number;
  maxLevel: number;
  selected: number;
  hovered: number;
  theme: "light" | "dark";
}

interface ItemGeometry {
  /** First vertex of the textured quad (6 verts), or -1. */
  tex: number;
  texUrl: string | null;
  /** First vertex of the fill quad (6 verts) over the visible rect, or -1. */
  fill: number;
  /** First vertex of the outline loop (4 verts), or -1. */
  outline: number;
  pick: Omit<PickPlane, "z"> | null;
}

const VS = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat4 u_mvp;
uniform float u_z;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_mvp * vec4(a_pos, u_z, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_useTex;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  vec4 c = u_useTex > 0.5 ? texture2D(u_tex, v_uv) : vec4(u_color.rgb * u_color.a, u_color.a);
  gl_FragColor = c * u_opacity;
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

const ACCENT: [number, number, number] = [0.04, 0.52, 1];

export class HierarchyScene {
  private gl: WebGLRenderingContext;
  private isWebGL2: boolean;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private loc: {
    pos: number; uv: number; mvp: WebGLUniformLocation; z: WebGLUniformLocation;
    color: WebGLUniformLocation; useTex: WebGLUniformLocation; opacity: WebGLUniformLocation; tex: WebGLUniformLocation;
  };
  private textures = new Map<string, { texture: WebGLTexture | null; image: HTMLImageElement; failed: boolean }>();
  private geometry: ItemGeometry[] = [];
  private layout: Layout | null = null;
  private screen = { width: 1, height: 1 };
  private lastMvp: Float32Array | null = null;
  private lastOptions: SceneOptions | null = null;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement, private onTextureLoaded: () => void) {
    const attrs: WebGLContextAttributes = { antialias: true, premultipliedAlpha: true, alpha: false, preserveDrawingBuffer: true };
    const gl2 = canvas.getContext("webgl2", attrs) as WebGL2RenderingContext | null;
    const gl = gl2 ?? (canvas.getContext("webgl", attrs) as WebGLRenderingContext | null);
    if (!gl) throw new Error("WebGL is not available in this browser.");
    this.gl = gl;
    this.isWebGL2 = gl2 !== null;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    this.program = program;
    this.buffer = gl.createBuffer()!;
    this.loc = {
      pos: gl.getAttribLocation(program, "a_pos"),
      uv: gl.getAttribLocation(program, "a_uv"),
      mvp: gl.getUniformLocation(program, "u_mvp")!,
      z: gl.getUniformLocation(program, "u_z")!,
      color: gl.getUniformLocation(program, "u_color")!,
      useTex: gl.getUniformLocation(program, "u_useTex")!,
      opacity: gl.getUniformLocation(program, "u_opacity")!,
      tex: gl.getUniformLocation(program, "u_tex")!,
    };
  }

  /** Rebuild vertex data for a new capture/layout. Textures are reused by URL. */
  setLayout(capture: HierarchyCapture, layout: Layout): void {
    this.layout = layout;
    this.screen = capture.screen;
    const W = capture.screen.width;
    const H = capture.screen.height;
    const verts: number[] = [];
    const quad = (r: HierarchyRect, uv: [number, number, number, number]) => {
      const start = verts.length / 4;
      const x0 = r.x - W / 2, x1 = r.x + r.width - W / 2;
      const y0 = H / 2 - r.y, y1 = H / 2 - (r.y + r.height);
      const [u0, v0, u1, v1] = uv;
      verts.push(x0, y0, u0, v0, x1, y0, u1, v0, x1, y1, u1, v1, x0, y0, u0, v0, x1, y1, u1, v1, x0, y1, u0, v1);
      return start;
    };
    const loop = (r: HierarchyRect) => {
      const start = verts.length / 4;
      const x0 = r.x - W / 2, x1 = r.x + r.width - W / 2;
      const y0 = H / 2 - r.y, y1 = H / 2 - (r.y + r.height);
      verts.push(x0, y0, 0, 0, x1, y0, 0, 0, x1, y1, 0, 0, x0, y1, 0, 0);
      return start;
    };
    const screenRect = { x: 0, y: 0, width: W, height: H };
    const usedUrls = new Set<string>();
    this.geometry = layout.items.map((item) => {
      const visible = item.visibleRect;
      let tex = -1;
      let texUrl: string | null = null;
      if (item.node.snapshot && item.snapshotRect && item.snapshotUv) {
        tex = quad(item.snapshotRect, item.snapshotUv);
        texUrl = item.node.snapshot.url;
      } else if (capture.screenshotUrl && visible) {
        tex = quad(visible, subRectUv(screenRect, visible));
        texUrl = capture.screenshotUrl;
      }
      if (texUrl) usedUrls.add(texUrl);
      const fill = visible ? quad(visible, [0, 0, 1, 1]) : -1;
      const outline = visible ? loop(visible) : -1;
      const pick = visible
        ? { x0: visible.x - W / 2, x1: visible.x + visible.width - W / 2, y0: H / 2 - visible.y, y1: H / 2 - (visible.y + visible.height) }
        : null;
      return { tex, texUrl, fill, outline, pick };
    });
    // Drop textures the new capture no longer references.
    for (const [url, entry] of this.textures) {
      if (!usedUrls.has(url)) {
        if (entry.texture) this.gl.deleteTexture(entry.texture);
        entry.image.onload = entry.image.onerror = null;
        this.textures.delete(url);
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  }

  private textureFor(url: string): WebGLTexture | null {
    let entry = this.textures.get(url);
    if (!entry) {
      const image = new Image();
      entry = { texture: null, image, failed: false };
      const e = entry;
      image.onload = () => {
        if (this.disposed || this.textures.get(url) !== e) return;
        const gl = this.gl;
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        if (this.isWebGL2) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        e.texture = texture;
        this.onTextureLoaded();
      };
      image.onerror = () => {
        e.failed = true;
      };
      image.src = url;
      this.textures.set(url, entry);
    }
    return entry.texture;
  }

  /** Fraction of referenced textures that have loaded (for a progress hint). */
  textureProgress(): { loaded: number; total: number } {
    let loaded = 0;
    for (const e of this.textures.values()) if (e.texture || e.failed) loaded++;
    return { loaded, total: this.textures.size };
  }

  private zFor(level: number, options: SceneOptions): number {
    const mid = (options.minLevel + options.maxLevel) / 2;
    return (level - mid) * options.spacing;
  }

  render(camera: OrbitCamera, options: SceneOptions): void {
    if (this.disposed) return;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const bg = options.theme === "dark" ? [0.09, 0.09, 0.1] : [0.95, 0.95, 0.96];
    gl.clearColor(bg[0]!, bg[1]!, bg[2]!, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.lastOptions = options;
    const layout = this.layout;
    if (!layout) return;

    const mvp = viewProjection(camera, w / h);
    this.lastMvp = mvp;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    gl.uniform1i(this.loc.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Back-to-front along the view direction.
    const eyeZ = cameraEye(camera)[2] - camera.target[2];
    const order: number[] = [];
    layout.items.forEach((item, i) => {
      if (item.level >= options.minLevel && item.level <= options.maxLevel) order.push(i);
    });
    order.sort((a, b) => {
      const d = layout.items[a]!.level - layout.items[b]!.level;
      return (eyeZ >= 0 ? d : -d) || (eyeZ >= 0 ? a - b : b - a);
    });

    const dark = options.theme === "dark";
    for (const i of order) {
      const item = layout.items[i]!;
      const geo = this.geometry[i]!;
      gl.uniform1f(this.loc.z, this.zFor(item.level, options));
      const dim = item.hiddenInApp ? 0.35 : 1;

      if (options.textures && geo.tex >= 0 && geo.texUrl) {
        const texture = this.textureFor(geo.texUrl);
        if (texture) {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.uniform1f(this.loc.useTex, 1);
          gl.uniform1f(this.loc.opacity, dim);
          gl.drawArrays(gl.TRIANGLES, geo.tex, 6);
        }
      } else if (!options.textures && geo.fill >= 0 && item.node.backgroundColor && item.node.backgroundColor[3] > 0) {
        const [r, g, b, a] = item.node.backgroundColor;
        gl.uniform1f(this.loc.useTex, 0);
        gl.uniform4f(this.loc.color, r, g, b, a);
        gl.uniform1f(this.loc.opacity, 0.85 * dim);
        gl.drawArrays(gl.TRIANGLES, geo.fill, 6);
      }

      if (options.outlines && geo.outline >= 0) {
        gl.uniform1f(this.loc.useTex, 0);
        if (dark) gl.uniform4f(this.loc.color, 0.75, 0.75, 0.8, 0.45);
        else gl.uniform4f(this.loc.color, 0.3, 0.3, 0.35, 0.45);
        gl.uniform1f(this.loc.opacity, 1);
        gl.drawArrays(gl.LINE_LOOP, geo.outline, 4);
      }
    }

    // Hover / selection go last so they stay visible through the planes in
    // front of them (like Xcode), still positioned on their own layer.
    for (const [i, alpha] of [[options.hovered, 0.12], [options.selected, 0.28]] as const) {
      const item = layout.items[i];
      const geo = this.geometry[i];
      if (!item || !geo || geo.fill < 0 || item.level < options.minLevel || item.level > options.maxLevel) continue;
      gl.uniform1f(this.loc.z, this.zFor(item.level, options));
      gl.uniform1f(this.loc.useTex, 0);
      gl.uniform1f(this.loc.opacity, 1);
      gl.uniform4f(this.loc.color, ACCENT[0], ACCENT[1], ACCENT[2], alpha);
      gl.drawArrays(gl.TRIANGLES, geo.fill, 6);
      gl.uniform4f(this.loc.color, ACCENT[0], ACCENT[1], ACCENT[2], 1);
      gl.drawArrays(gl.LINE_LOOP, geo.outline, 4);
    }
  }

  /** Item index under a canvas-relative CSS pixel, or -1. Uses the last rendered camera. */
  pick(x: number, y: number): number {
    const layout = this.layout;
    const mvp = this.lastMvp;
    const options = this.lastOptions;
    if (!layout || !mvp || !options) return -1;
    const planes = layout.items.map((item, i) => {
      const p = this.geometry[i]?.pick;
      if (!p || item.level < options.minLevel || item.level > options.maxLevel) return null;
      return { ...p, z: this.zFor(item.level, options) };
    });
    return pickPlane(mvp, planes, x, y, this.canvas.clientWidth, this.canvas.clientHeight);
  }

  screenSize(): { width: number; height: number } {
    return this.screen;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.textures.values()) {
      entry.image.onload = entry.image.onerror = null;
      if (entry.texture) this.gl.deleteTexture(entry.texture);
    }
    this.textures.clear();
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteProgram(this.program);
  }
}
