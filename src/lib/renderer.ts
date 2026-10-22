import { FX, fxById, fxIdOf, fxSource, fxTargetSize, fxUniformNames, type FxDef } from './fx';
import { flipQuad, invert3, squareToQuad, toColumnMajor, type Flip } from './homography';
import { meshKey, tessellate } from './mesh';
import { hueToRgb, type PostValues } from './post';
import { MESH_VS, PANEL_FS, PANEL_MESH_FS, POST_FS, SCENE_FS, VS } from './shaders';
import type { Levels } from './audio';
import { pictureBounds } from './trace';
import { drawMask, MASK_SCALE, maskKey } from './mask';
import { drawLabel, labelKey, panelAspect } from './text';
import type { BlendMode, Mask, Panel, Pt, TransitionMode } from './types';

const SW = 1920;
const SH = 1080;
const GRID_COLORS = [[1, 0.69, 0], [0.2, 0.85, 1], [1, 0.3, 0.7], [0.6, 1, 0.4]];

/** The outgoing look during a crossfade. */
export interface FadeInput {
  scene: number;
  c1: number[];
  c2: number[];
  /** Panel id to its previous source; panels not listed keep their current one. */
  sources: Record<string, string>;
  /** Weight of the incoming look, 0..1. */
  mix: number;
  /** How the change looks; a plain crossfade when missing. */
  mode?: TransitionMode;
}

/** Transition modes as the panel shader numbers them. */
export const TRANSITION_INDEX: Record<TransitionMode, number> = { fade: 0, ripple: 1, sparkle: 2, black: 3 };

export interface FrameInput {
  panels: Panel[];
  scene: number;
  c1: number[];
  c2: number[];
  L: Levels;
  t: number;
  phaseA: number;
  phaseB: number;
  span: boolean;
  testGrid: boolean;
  blackout: boolean;
  flash: number;
  master: number;
  /** Signed RGB split offset as a fraction of the panel width (0 = none). */
  split: number;
  /** Mirroring for this output's projector (rear or ceiling mount). Corners stay as the audience sees them. */
  flip: Flip;
  /** This projector's post effects, or null when they're all at rest (the pass is then skipped). */
  post?: PostValues | null;
  /** Audio reactivity setting, 0..1, passed to panel shaders as uReact. */
  react: number;
  levelFor: (p: Panel) => number;
  getVideo: (id: string) => HTMLVideoElement | null;
  /** Current (eased) value of a panel shader parameter, and of a speed parameter's clock uniform. */
  fxParam: (fxId: string, name: string) => number;
  fxClock: (fxId: string, name: string) => number;
  /** Value of a uniform the engine's automation drives this frame, such as a blink. */
  fxLive: (fxId: string, name: string) => number;
  /** Decoded library image (such as a height map) by id, or null while it loads or if it's gone. */
  getImage: (id: string) => ImageBitmap | null;
  fade?: FadeInput | null;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Prog { p: WebGLProgram; u: Uniforms; }
interface FxJob { def: FxDef; prog: Prog; size: [number, number]; inputs?: Record<string, string>; }
interface Target { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number; }
type Quad = [Pt, Pt, Pt, Pt];

/** A panel's corners in output pixels, mirrored if the output is flipped. */
const toPx = (pn: Panel, W: number, H: number, flip: Flip) =>
  flipQuad(pn.corners, flip).map(([x, y]) => [x * W, y * H] as Pt) as Quad;
/** Key of a panel shader's buffer: one per panel and shader, so a fade between two shaders has both. */
const fxKey = (panelId: string, fxId: string) => `${panelId}|${fxId}`;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Uniforms of both panel programs; the flat one also has uInvH. */
const PANEL_UNIFORMS = ['uCanvas', 'uTex', 'uSrc', 'uFlipY', 'uLevel', 'uFlash',
  'uFeather', 'uGrid', 'uHasTex', 'uMaster', 'uFlashColor', 'uGridColor', 'uTexB', 'uFlipYB', 'uHasTexB', 'uMix', 'uSplit',
  'uText', 'uHasText', 'uTextPulse', 'uOpacity', 'uMask', 'uHasMask', 'uMaskUv', 'uTrans'];

/** A mesh panel's triangles on the GPU, rebuilt when its grid or the output's flip changes. */
interface MeshGeo { key: string; vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer; count: number; bbox: [number, number, number, number]; }

type BlendFactor = 'ONE' | 'ONE_MINUS_SRC_ALPHA' | 'ONE_MINUS_SRC_COLOR' | 'DST_COLOR';

/**
 * GL blend factors per mode, for the panel shader's premultiplied output (rgb = colour × alpha):
 * normal is d(1 − a) + s; add is d + s; screen is d(1 − s) + s; multiply is d(1 − a) + d·s,
 * so opacity and softened edges fade every mode out towards the panels beneath.
 */
export const BLEND_FUNCS: Record<BlendMode, [BlendFactor, BlendFactor]> = {
  over: ['ONE', 'ONE_MINUS_SRC_ALPHA'],
  add: ['ONE', 'ONE'],
  screen: ['ONE', 'ONE_MINUS_SRC_COLOR'],
  multiply: ['DST_COLOR', 'ONE_MINUS_SRC_ALPHA'],
};

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`The graphics driver rejected a shader: ${log}`);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, fs: string, names: string[], vs = VS): Prog {
  const p = gl.createProgram()!;
  const shaders: WebGLShader[] = [];
  try {
    shaders.push(compile(gl, gl.VERTEX_SHADER, vs));
    shaders.push(compile(gl, gl.FRAGMENT_SHADER, fs));
    shaders.forEach((sh) => gl.attachShader(p, sh));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Shader link failed: ${gl.getProgramInfoLog(p)}`);
  } catch (e) {
    shaders.forEach((sh) => gl.deleteShader(sh));
    gl.deleteProgram(p);
    throw e;
  }
  const u: Uniforms = {};
  names.forEach((n) => { u[n] = gl.getUniformLocation(p, n); });
  return { p, u };
}

/**
 * Links a program the output can do without. On failure it returns null and reports why,
 * so one bad shader blanks only what it draws instead of taking down the whole output.
 */
export function tryLink(gl: WebGL2RenderingContext, fs: string, names: string[], onError: (msg: string) => void, vs = VS): Prog | null {
  try {
    return link(gl, fs, names, vs);
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return null;
  }
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  /** Null when the scene shader failed: generated panels show black, videos and text still play. */
  private scene: Prog | null = null;
  private panel!: Prog;
  /** Program for mesh-warped panels; null when the driver rejected it. */
  private meshProg: Prog | null = null;
  private meshes = new Map<string, MeshGeo>();
  /** Post-effect pass, and the frame the panels draw into when it's on. Null if the driver rejected it. */
  private postProg: Prog | null = null;
  private postTarget: Target | null = null;
  private fbo!: WebGLFramebuffer;
  private fboTex!: WebGLTexture;
  /** Second scene buffer for the outgoing scene during a crossfade. */
  private fboB!: WebGLFramebuffer;
  private fboTexB!: WebGLTexture;
  private specTex!: WebGLTexture;
  /** 1×1 mid-grey, read by image samplers that have no image. */
  private greyTex!: WebGLTexture;
  /** Library images on the GPU by id, uploaded once per decoded bitmap, with mipmaps. */
  private imageTex = new Map<string, { tex: WebGLTexture; bmp: ImageBitmap }>();
  /** Library pictures shown as panel content: premultiplied, so transparent areas are black, with the shape's bounds. */
  private pictures = new Map<string, { tex: WebGLTexture; bmp: ImageBitmap; crop: [number, number, number, number] }>();
  private vao!: WebGLVertexArrayObject;
  private videoTex = new Map<string, WebGLTexture>();
  private uploaded = new Set<string>();
  /** Rendered panel text by panel id, redrawn only when its key changes. */
  private labels = new Map<string, { key: string; tex: WebGLTexture; canvas: HTMLCanvasElement }>();
  /** Rasterised panel masks by panel id, redrawn only when the outline, feather or output size changes. */
  private masks = new Map<string, { key: string; tex: WebGLTexture; canvas: HTMLCanvasElement; src?: string; img?: HTMLImageElement }>();
  /** Whether the mask bound last is a picture mask, sampled on the panel's surface. */
  private maskUv = false;
  /** Working canvas for mask rasterising, shared by all masks. */
  private maskScratch: HTMLCanvasElement | null = null;
  /** Compiled panel shaders by id; null when the driver rejected one, and its panels show black. */
  private fxProgs = new Map<string, Prog | null>();
  /** Buffers for the panel shaders drawn this frame, sized to their panels. */
  private fxTargets = new Map<string, Target>();
  private lost = false;
  /** Why a shader couldn't be used, for the control window. Empty when everything compiled. */
  problems: string[] = [];

  constructor(public readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, premultipliedAlpha: true,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('This browser has no WebGL2. Use a recent Chrome, Edge, Firefox or Safari.');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.videoTex.clear(); this.imageTex.clear(); this.pictures.clear(); this.labels.clear(); this.postTarget = null; this.masks.clear(); this.meshes.clear(); this.fxTargets.clear(); this.init(); this.lost = false; });
    this.init();
  }

  private init() {
    const gl = this.gl;
    this.problems = [];
    this.scene = tryLink(gl, SCENE_FS, ['uRes', 'uTime', 'uBass', 'uMid', 'uHigh', 'uKick', 'uBeat', 'uSince',
      'uPhaseA', 'uPhaseB', 'uScene', 'uC1', 'uC2', 'uSpec', 'uKicks'],
      (msg) => this.problems.push(`Generated scenes are off: ${msg}`));
    // Without the panel program nothing can be drawn at all, so that one stays fatal.
    this.panel = link(gl, PANEL_FS, ['uInvH', ...PANEL_UNIFORMS]);
    // Mesh panels have their own program; if it fails they show black and flat panels carry on.
    this.postProg = tryLink(gl, POST_FS, ['uTex', 'uRes', 'uBloom', 'uRipple', 'uRippleT', 'uTint', 'uSaturation', 'uVignette', 'uTintColor'],
      (msg) => this.problems.push(`Post effects are off: ${msg}`));
    this.postTarget = null;
    this.meshProg = tryLink(gl, PANEL_MESH_FS, PANEL_UNIFORMS, (msg) => this.problems.push(`Mesh warp is off: ${msg}`), MESH_VS);
    // Compiled up front, so picking a panel shader mid-show never stalls a frame, and a broken one shows at load.
    this.fxProgs.clear();
    for (const def of FX) {
      this.fxProgs.set(def.id, tryLink(gl, fxSource(def), fxUniformNames(def),
        (msg) => this.problems.push(`${def.name} is off: ${msg}`)));
    }
    this.vao = gl.createVertexArray()!;

    [this.fbo, this.fboTex] = this.makeTarget();
    [this.fboB, this.fboTexB] = this.makeTarget();

    this.greyTex = this.makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));

    this.specTex = this.makeTex();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 64, 1, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  }

  private makeTarget(w = SW, h = SH): [WebGLFramebuffer, WebGLTexture] {
    const gl = this.gl;
    const tex = this.makeTex();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return [fbo, tex];
  }

  private makeTex() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private resize() {
    const win = this.canvas.ownerDocument.defaultView ?? window;
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** Binds the video's texture, uploading the current frame once per rendered frame. */
  private bindVideo(id: string, v: HTMLVideoElement) {
    const gl = this.gl;
    let t = this.videoTex.get(id);
    if (!t) { t = this.makeTex(); this.videoTex.set(id, t); } else gl.bindTexture(gl.TEXTURE_2D, t);
    if (!this.uploaded.has(id)) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      this.uploaded.add(id);
    }
  }

  /** Binds the panel's text texture to unit 2, redrawing it if the text or panel shape changed. False when there's no text. */
  private bindLabel(pn: Panel, q: [Pt, Pt, Pt, Pt]): boolean {
    const gl = this.gl;
    const label = pn.label;
    if (!label || !label.text.trim()) return false;
    const aspect = panelAspect(q);
    const key = labelKey(label, aspect);
    let e = this.labels.get(pn.id);
    if (!e) {
      e = { key: '', tex: this.makeTex(), canvas: this.canvas.ownerDocument.createElement('canvas') };
      this.labels.set(pn.id, e);
    } else gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (e.key !== key) {
      drawLabel(e.canvas, label, aspect);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, e.canvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      e.key = key;
    }
    return true;
  }

  /**
   * Binds the panel's mask to unit 3, rasterising it at a fraction of the output size if it changed.
   * False when the panel has no mask.
   */
  private bindMask(pn: Panel, W: number, H: number, flip: Flip): boolean {
    const gl = this.gl;
    const mask = pn.mask;
    if (!mask) return false;
    this.maskUv = !!mask.image;
    if (mask.image) return this.bindImageMask(pn.id, mask);
    const w = Math.max(16, Math.round(W * MASK_SCALE)), h = Math.max(16, Math.round(H * MASK_SCALE));
    const key = maskKey(mask, w, h, flip);
    let e = this.masks.get(pn.id);
    if (!e) {
      e = { key: '', tex: this.makeTex(), canvas: this.canvas.ownerDocument.createElement('canvas') };
      this.masks.set(pn.id, e);
    } else gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (e.key !== key) {
      this.maskScratch ??= this.canvas.ownerDocument.createElement('canvas');
      drawMask(e.canvas, this.maskScratch, mask, w, h, flip);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, e.canvas);
      e.key = key;
    }
    return true;
  }

  /**
   * Binds a picture mask to unit 3. The picture decodes in the background, and until it has the
   * panel stays hidden (a transparent pixel) rather than flashing unmasked.
   */
  private bindImageMask(id: string, mask: Mask): boolean {
    const gl = this.gl;
    let e = this.masks.get(id);
    if (!e) {
      e = { key: '', tex: this.makeTex(), canvas: this.canvas.ownerDocument.createElement('canvas') };
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      this.masks.set(id, e);
    } else gl.bindTexture(gl.TEXTURE_2D, e.tex);
    if (e.src !== mask.image) {
      const entry = e;
      const img = new Image();
      entry.src = mask.image; entry.img = undefined; entry.key = '';
      img.onload = () => { if (entry.src === mask.image) { entry.img = img; entry.key = ''; } };
      img.src = mask.image!;
    }
    const key = `img|${mask.feather}|${mask.invert ? 1 : 0}`;
    if (e.img && e.key !== key) {
      const { naturalWidth: w, naturalHeight: h } = e.img;
      e.canvas.width = w; e.canvas.height = h;
      const g = e.canvas.getContext('2d');
      if (g) {
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, w, h);
        if (mask.invert) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'destination-out'; }
        // Feather is a blur here; the picture's size, not the output's, sets how many pixels that is.
        const blur = (mask.feather * h) / 2;
        if (blur >= 0.5 && 'filter' in g) g.filter = `blur(${blur.toFixed(2)}px)`;
        g.drawImage(e.img, 0, 0);
        g.filter = 'none';
        g.globalCompositeOperation = 'source-over';
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, e.canvas);
      }
      e.key = key;
    }
    return true;
  }

  private dropMesh(id: string, g: MeshGeo) {
    const gl = this.gl;
    gl.deleteVertexArray(g.vao);
    gl.deleteBuffer(g.vbo);
    gl.deleteBuffer(g.ibo);
    this.meshes.delete(id);
  }

  /** The panel's mesh triangles in clip space (mirrored for a flipped output), tessellated only when the grid changes. */
  private meshGeo(pn: Panel, flip: Flip): MeshGeo | null {
    const m = pn.mesh;
    if (!m) return null;
    const gl = this.gl;
    const key = `${flip.h ? 1 : 0}${flip.v ? 1 : 0}|${meshKey(m)}`;
    const cur = this.meshes.get(pn.id);
    if (cur && cur.key === key) return cur;
    if (cur) this.dropMesh(pn.id, cur);
    const t = tessellate(m);
    const v = t.verts;
    // Stage fractions to clip space; panel uv stays as it is.
    for (let k = 0; k < v.length; k += 4) {
      const x = flip.h ? 1 - v[k] : v[k], y = flip.v ? 1 - v[k + 1] : v[k + 1];
      v[k] = x * 2 - 1;
      v[k + 1] = 1 - y * 2;
    }
    const [bx0, by0, bx1, by1] = t.bbox;
    const fx = (x: number) => (flip.h ? 1 - x : x), fy = (y: number) => (flip.v ? 1 - y : y);
    const bbox: [number, number, number, number] = [
      Math.min(fx(bx0), fx(bx1)), Math.min(fy(by0), fy(by1)), Math.max(fx(bx0), fx(bx1)), Math.max(fy(by0), fy(by1)),
    ];
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, t.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(this.vao);
    const g: MeshGeo = { key, vao, vbo, ibo, count: t.indices.length, bbox };
    this.meshes.set(pn.id, g);
    return g;
  }

  /** Frees text, mask and mesh data of panels that no longer exist or no longer have them. */
  private pruneLabels(panels: Panel[]) {
    if (this.labels.size === 0 && this.masks.size === 0 && this.meshes.size === 0) return;
    const ids = new Set(panels.map((p) => p.id));
    for (const [id, e] of this.labels) {
      if (!ids.has(id)) { this.gl.deleteTexture(e.tex); this.labels.delete(id); }
    }
    for (const [id, e] of this.masks) {
      const p = panels.find((x) => x.id === id);
      if (!p || !p.mask) { this.gl.deleteTexture(e.tex); this.masks.delete(id); }
    }
    for (const [id, g] of this.meshes) {
      const p = panels.find((x) => x.id === id);
      if (!p || !p.mesh) this.dropMesh(id, g);
    }
  }

  /**
   * Binds a library picture for use as panel content (flat, top row first). Transparent areas become
   * black, so a cutout shows only its shape; `crop` is the bounds of what isn't transparent, so the
   * shape fills the panel however much empty margin the file has.
   */
  private bindPicture(id: string, bmp: ImageBitmap): [number, number, number, number] {
    const gl = this.gl;
    let e = this.pictures.get(id);
    if (e && e.bmp === bmp) { gl.bindTexture(gl.TEXTURE_2D, e.tex); return e.crop; }
    const tex = e?.tex ?? this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    e = { tex, bmp, crop: this.shapeBounds(bmp) };
    this.pictures.set(id, e);
    return e.crop;
  }

  /** The bounds of a picture's non-transparent pixels as fractions of its size; the whole picture if it has no transparency. */
  private shapeBounds(bmp: ImageBitmap): [number, number, number, number] {
    const k = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = this.canvas.ownerDocument.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return [0, 0, 1, 1];
    g.drawImage(bmp, 0, 0, w, h);
    const crop = pictureBounds({ width: w, height: h, data: g.getImageData(0, 0, w, h).data });
    return crop;
  }

  /** The texture for a library image, uploaded with mipmaps the first time (or when the bitmap changes). */
  private imageTexture(id: string, bmp: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const cur = this.imageTex.get(id);
    if (cur && cur.bmp === bmp) return cur.tex;
    const tex = cur?.tex ?? this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.imageTex.set(id, { tex, bmp });
    return tex;
  }

  dropImage(id: string) {
    const t = this.imageTex.get(id);
    if (t) { this.gl.deleteTexture(t.tex); this.imageTex.delete(id); }
    const pic = this.pictures.get(id);
    if (pic) { this.gl.deleteTexture(pic.tex); this.pictures.delete(id); }
  }

  dropVideo(id: string) {
    const t = this.videoTex.get(id);
    if (t) { this.gl.deleteTexture(t); this.videoTex.delete(id); }
  }

  render(f: FrameInput) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return;
    this.resize();
    const W = this.canvas.width, H = this.canvas.height;
    this.uploaded.clear();
    gl.bindVertexArray(this.vao);

    const fade = f.fade && !f.blackout ? f.fade : null;
    const fromSource = (pn: Panel) => (fade ? fade.sources[pn.id] ?? pn.source : pn.source);
    const needGen = !!this.scene && !f.blackout && f.panels.some((p) => p.source === 'gen');
    const needGenB = !!this.scene && !!fade && f.panels.some((p) => fromSource(p) === 'gen');
    const fxJobs = f.blackout ? new Map<string, FxJob>() : this.fxJobs(f.panels, W, H, f.flip, fade ? fromSource : null);
    this.pruneFx(fxJobs);
    if (needGen || needGenB || fxJobs.size) {
      gl.disable(gl.BLEND);
      gl.disable(gl.SCISSOR_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.specTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 64, 1, gl.RED, gl.UNSIGNED_BYTE, f.L.spec);
      if (needGen) this.renderScene(this.fbo, f, f.scene, f.c1, f.c2);
      if (fade && needGenB) this.renderScene(this.fboB, f, fade.scene, fade.c1, fade.c2);
      fxJobs.forEach((job, key) => this.renderFx(this.fxTarget(key, job.size), f, job));
    }

    // With post effects on, panels draw into a frame of their own, finished onto the canvas afterwards.
    const post = f.post && this.postProg && !f.blackout && !f.testGrid ? f.post : null;
    const target = post ? this.framebufferFor(W, H) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.pruneLabels(f.panels);
    if (f.blackout && !f.testGrid) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.SCISSOR_TEST);
    // Per-frame uniforms for both panel programs.
    for (const prog of [this.panel, this.meshProg]) {
      if (!prog) continue;
      const u = prog.u;
      gl.useProgram(prog.p);
      gl.uniform2f(u.uCanvas, W, H);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1i(u.uTexB, 1);
      gl.uniform1i(u.uText, 2);
      gl.uniform1i(u.uMask, 3);
      gl.uniform1f(u.uMaster, f.master);
      gl.uniform1f(u.uSplit, f.split);
      gl.uniform3fv(u.uFlashColor, f.c1);
      gl.uniform1f(u.uGrid, f.testGrid ? 1 : 0);
      gl.uniform1f(u.uTrans, TRANSITION_INDEX[fade?.mode ?? 'fade'] ?? 0);
    }

    f.panels.forEach((pn, i) => {
      const q = toPx(pn, W, H, f.flip);
      // A mesh panel draws its own triangles; a flat one a fullscreen triangle through the inverse homography.
      const geo = pn.mesh ? (this.meshProg ? this.meshGeo(pn, f.flip) : null) : null;
      if (pn.mesh && !geo) return;
      const inv = geo ? null : invert3(squareToQuad(q));
      if (!geo && !inv) return;
      const { p, u } = geo ? this.meshProg! : this.panel;
      gl.useProgram(p);
      let x0: number, x1: number, y0: number, y1: number;
      if (geo) {
        x0 = Math.max(0, Math.floor(geo.bbox[0] * W)); x1 = Math.min(W, Math.ceil(geo.bbox[2] * W));
        y0 = Math.max(0, Math.floor(geo.bbox[1] * H)); y1 = Math.min(H, Math.ceil(geo.bbox[3] * H));
      } else {
        const xs = q.map((v) => v[0]), ys = q.map((v) => v[1]);
        x0 = Math.max(0, Math.floor(Math.min(...xs))); x1 = Math.min(W, Math.ceil(Math.max(...xs)));
        y0 = Math.max(0, Math.floor(Math.min(...ys))); y1 = Math.min(H, Math.ceil(Math.max(...ys)));
      }
      if (x1 <= x0 || y1 <= y0) return;
      gl.scissor(x0, H - y1, x1 - x0, y1 - y0);

      gl.activeTexture(gl.TEXTURE0);
      let hasTex = 0, flip = 0;
      let pictureCrop: [number, number, number, number] | null = null;
      if (!f.blackout) {
        const fxId = fxIdOf(pn.source);
        const fxTex = fxId ? this.fxTargets.get(fxKey(pn.id, fxId)) : undefined;
        if (pn.source === 'gen' && needGen) {
          gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
          hasTex = 1; flip = 1;
        } else if (fxTex) {
          gl.bindTexture(gl.TEXTURE_2D, fxTex.tex);
          hasTex = 1; flip = 1;
        } else if (pn.source.startsWith('vid:')) {
          const id = pn.source.slice(4);
          const v = f.getVideo(id);
          if (v && v.readyState >= 2 && v.videoWidth) {
            try { this.bindVideo(id, v); hasTex = 1; } catch { /* frame not decodable yet */ }
          }
        } else if (pn.source.startsWith('img:')) {
          const bmp = f.getImage(pn.source.slice(4));
          if (bmp) { pictureCrop = this.bindPicture(pn.source.slice(4), bmp); hasTex = 1; }
        }
      }
      if (!hasTex) gl.bindTexture(gl.TEXTURE_2D, this.specTex);

      // The outgoing look, only while fading and only when this panel's content actually changes.
      const from = fromSource(pn);
      const blend = !!fade && (from !== pn.source || (from === 'gen' && needGenB));
      let hasTexB = 0, flipB = 0;
      gl.activeTexture(gl.TEXTURE1);
      if (blend) {
        const fromFx = fxIdOf(from);
        const fromTex = fromFx ? this.fxTargets.get(fxKey(pn.id, fromFx)) : undefined;
        if (from === 'gen' && needGenB) { gl.bindTexture(gl.TEXTURE_2D, this.fboTexB); hasTexB = 1; flipB = 1; }
        else if (fromTex) { gl.bindTexture(gl.TEXTURE_2D, fromTex.tex); hasTexB = 1; flipB = 1; }
        else if (from.startsWith('vid:')) {
          const id = from.slice(4);
          const v = f.getVideo(id);
          if (v && v.readyState >= 2 && v.videoWidth) {
            try { this.bindVideo(id, v); hasTexB = 1; } catch { /* frame not decodable yet */ }
          }
        } else if (from.startsWith('img:')) {
          const bmp = f.getImage(from.slice(4));
          if (bmp) { this.bindPicture(from.slice(4), bmp); hasTexB = 1; }
        }
      }
      if (!hasTexB) gl.bindTexture(gl.TEXTURE_2D, this.specTex);

      gl.activeTexture(gl.TEXTURE2);
      const hasText = !f.blackout && this.bindLabel(pn, q);
      if (!hasText) gl.bindTexture(gl.TEXTURE_2D, this.specTex);

      // The test grid shows the whole panel, so its corners can be lined up whatever the mask.
      gl.activeTexture(gl.TEXTURE3);
      const hasMask = !f.testGrid && this.bindMask(pn, W, H, f.flip);
      if (!hasMask) gl.bindTexture(gl.TEXTURE_2D, this.specTex);

      let src = [0, 0, 1, 1];
      // Span spreads the wall scene and videos; a panel shader already fills its own panel.
      if (f.span && !fxIdOf(pn.source)) {
        const nx = pn.corners.map((c) => c[0]), ny = pn.corners.map((c) => c[1]);
        const a = clamp01(Math.min(...nx)), b = clamp01(Math.max(...nx));
        const c = clamp01(Math.min(...ny)), d = clamp01(Math.max(...ny));
        if (b - a > 0.01 && d - c > 0.01) src = [a, c, b - a, d - c];
      }

      // A picture fills the panel with its shape, whatever margin the file has.
      if (pictureCrop) src = pictureCrop;

      if (inv) gl.uniformMatrix3fv(u.uInvH, false, toColumnMajor(inv));
      gl.uniform4fv(u.uSrc, src);
      gl.uniform1f(u.uFlipY, flip);
      gl.uniform1f(u.uLevel, f.levelFor(pn));
      gl.uniform1f(u.uFlash, f.blackout ? 0 : f.flash);
      gl.uniform1f(u.uFeather, pn.feather);
      // The test grid draws every panel normally and fully, so each one's outline shows while mapping.
      const [sf, df] = BLEND_FUNCS[f.testGrid ? 'over' : pn.blend] ?? BLEND_FUNCS.over;
      gl.blendFunc(gl[sf], gl[df]);
      gl.uniform1f(u.uOpacity, f.testGrid ? 1 : clamp01(pn.opacity));
      gl.uniform1f(u.uHasMask, hasMask ? 1 : 0);
      gl.uniform1f(u.uMaskUv, hasMask && this.maskUv ? 1 : 0);
      gl.uniform1f(u.uHasTex, hasTex);
      gl.uniform1f(u.uHasTexB, hasTexB);
      gl.uniform1f(u.uFlipYB, flipB);
      gl.uniform1f(u.uMix, blend && fade ? fade.mix : 1);
      gl.uniform1f(u.uHasText, hasText ? 1 : 0);
      gl.uniform1f(u.uTextPulse, pn.label?.pulse ? 1 : 0);
      gl.uniform3fv(u.uGridColor, GRID_COLORS[i % GRID_COLORS.length]);
      if (geo) {
        gl.bindVertexArray(geo.vao);
        gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(this.vao);
      } else gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    if (post && target) this.postPass(target, post, W, H);
  }

  /** The panels' frame for the post pass, sized to the canvas, with mip levels for the bloom. */
  private framebufferFor(W: number, H: number): Target {
    const gl = this.gl;
    let t = this.postTarget;
    if (!t) {
      const [fbo, tex] = this.makeTarget(W, H);
      t = { fbo, tex, w: W, h: H };
      this.postTarget = t;
    } else if (t.w !== W || t.h !== H) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.w = W; t.h = H;
    }
    return t;
  }

  /** Finishes the panels' frame onto the canvas with this projector's post effects. */
  private postPass(t: Target, v: PostValues, W: number, H: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    const { p, u } = this.postProg!;
    gl.useProgram(p);
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uBloom, v.bloom);
    gl.uniform1f(u.uRipple, v.ripple);
    gl.uniform1f(u.uRippleT, v.rippleT);
    gl.uniform1f(u.uTint, v.tint);
    gl.uniform1f(u.uSaturation, v.saturation);
    gl.uniform1f(u.uVignette, v.vignette);
    gl.uniform3fv(u.uTintColor, hueToRgb(v.tintHue));
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draws one generated scene into a 1080p buffer. The spectrum texture must already be current. */
  private renderScene(fbo: WebGLFramebuffer, f: FrameInput, scene: number, c1: number[], c2: number[]) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, SW, SH);
    if (!this.scene) return;
    const { p, u } = this.scene;
    gl.useProgram(p);
    this.setCommon(u, f, SW, SH, c1, c2);
    gl.uniform1i(u.uScene, scene);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Uniforms the wall scenes and panel shaders share, so both move with the same clock and audio. */
  private setCommon(u: Uniforms, f: FrameInput, w: number, h: number, c1: number[], c2: number[]) {
    const gl = this.gl;
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, f.t);
    gl.uniform1f(u.uBass, f.L.bass);
    gl.uniform1f(u.uMid, f.L.mid);
    gl.uniform1f(u.uHigh, f.L.high);
    gl.uniform1f(u.uKick, f.L.kickEnv);
    gl.uniform1f(u.uBeat, f.L.beat);
    gl.uniform1f(u.uSince, Math.min(f.L.since, 99));
    gl.uniform1f(u.uPhaseA, f.phaseA);
    gl.uniform1f(u.uPhaseB, f.phaseB);
    gl.uniform3fv(u.uC1, c1);
    gl.uniform3fv(u.uC2, c2);
    gl.uniform1i(u.uSpec, 0);
    gl.uniform1fv(u.uKicks, f.L.kicks);
  }

  /**
   * The panel shader buffers this frame needs: each panel's shader, plus the one it's fading
   * from. Shaders that failed to compile are left out, so their panels show black.
   */
  private fxJobs(panels: Panel[], W: number, H: number, flip: Flip, fromSource: ((p: Panel) => string) | null) {
    const jobs = new Map<string, FxJob>();
    for (const pn of panels) {
      const ids = [fxIdOf(pn.source), fromSource ? fxIdOf(fromSource(pn)) : null];
      let q: Quad | null = null;
      for (const id of ids) {
        const def = id ? fxById(id) : undefined;
        const prog = id ? this.fxProgs.get(id) : null;
        if (!id || !def || !prog) continue;
        q ??= toPx(pn, W, H, flip);
        jobs.set(fxKey(pn.id, id), { def, prog, size: fxTargetSize(q, def.scale), inputs: pn.inputs });
      }
    }
    return jobs;
  }

  /** Frees buffers no panel needs this frame: a removed panel, a changed source, a finished fade. */
  private pruneFx(jobs: Map<string, FxJob>) {
    for (const [key, t] of this.fxTargets) {
      if (jobs.has(key)) continue;
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.tex);
      this.fxTargets.delete(key);
    }
  }

  /** The buffer for a panel shader, created or resized to match its panel. */
  private fxTarget(key: string, [w, h]: [number, number]): Target {
    const gl = this.gl;
    let t = this.fxTargets.get(key);
    if (!t) {
      const [fbo, tex] = this.makeTarget(w, h);
      t = { fbo, tex, w, h };
      this.fxTargets.set(key, t);
    } else if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.w = w; t.h = h;
    }
    return t;
  }

  /** Draws one panel shader into its buffer. The spectrum texture must already be current. */
  private renderFx(t: Target, f: FrameInput, { def, prog, inputs }: FxJob) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.specTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    const { p, u } = prog;
    gl.useProgram(p);
    this.setCommon(u, f, t.w, t.h, f.c1, f.c2);
    gl.uniform1f(u.uReact, f.react);
    for (const pr of def.params) {
      if (!pr.engine) gl.uniform1f(u[pr.name], f.fxParam(def.id, pr.name));
      if (pr.clock) gl.uniform1f(u[pr.clock], f.fxClock(def.id, pr.clock));
    }
    for (const name of def.live ?? []) gl.uniform1f(u[name], f.fxLive(def.id, name));
    // Images on units 1 and up; a sampler with no image (or one still loading) reads flat grey.
    (def.textures ?? []).forEach((tx, k) => {
      gl.activeTexture(gl.TEXTURE1 + k);
      const id = inputs?.[tx.name];
      const bmp = id ? f.getImage(id) : null;
      gl.bindTexture(gl.TEXTURE_2D, id && bmp ? this.imageTexture(id, bmp) : this.greyTex);
      gl.uniform1i(u[tx.name], 1 + k);
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
