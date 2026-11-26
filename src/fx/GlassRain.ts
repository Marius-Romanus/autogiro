// Gotas de lluvia en los parabrisas y las cúpulas. Cada vidrio del modelo (AircraftView.glass) se
// vuelve a dibujar en el pase de la precipitación (después de la atmósfera, en unidades de luz ya
// conocidas) con un dibujo de gotas calculado en el sombreador, en coordenadas del aparato:
//  - gotas quietas que crecen y desaparecen (celdas 3D de 5 mm cortadas por la superficie);
//  - gotas que corren con su reguero: hacia abajo por la gravedad con el aparato parado y hacia
//    atrás, empujadas por el aire, al coger velocidad (a partir de ~80 km/h casi todas corren).
// Cada gota hace de lente: clara por abajo (el cielo, invertido) y oscura por arriba.
// También dice si la cabina es cerrada (vidrio alrededor de la cabeza del piloto): para el sonido y
// para no dibujar lluvia dentro.

import { DoubleSide, Group, Matrix4, Mesh, Quaternion, Raycaster, ShaderMaterial, Vector2, Vector3, type Object3D, type Texture } from 'three'

const HASH = /* glsl */ `
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}`

export class GlassRain {
  /** se añade a la escena del pase de precipitación */
  readonly group = new Group()
  /** vidrio alrededor de la cabeza del piloto */
  enclosed = false
  private readonly items: Array<{ src: Mesh; mesh: Mesh }> = []
  private key = ''
  private amount = 0
  private time = 0
  private readonly mat: ShaderMaterial

  constructor() {
    this.mat = new ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        depthBuffer: { value: null as Texture | null },
        resolution: { value: new Vector2(1, 1) },
        cameraFar: { value: 4e6 },
        uBody: { value: new Matrix4() },
        uFlow: { value: new Vector3(0, -1, 0) },
        uUp: { value: new Vector3(0, 1, 0) },
        uAmount: { value: 0 },
        uRun: { value: 0 },
        uTime: { value: 0 },
        uColor: { value: new Vector3(1, 1, 1) },
      },
      vertexShader: /* glsl */ `
        uniform mat4 uBody;
        varying vec3 vBody;
        varying float vDepth;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vBody = (uBody * w).xyz;
          vec4 mv = viewMatrix * w;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D depthBuffer;
        uniform vec2 resolution;
        uniform float cameraFar, uAmount, uRun, uTime;
        uniform vec3 uFlow, uUp, uColor;
        varying vec3 vBody;
        varying float vDepth;
        ${HASH}
        void main() {
          float d = texture2D(depthBuffer, gl_FragCoord.xy / resolution).r;
          if (vDepth > pow(cameraFar + 1.0, d) - 1.0 + 0.02) discard;
          // de lejos las gotas son menores que un píxel: se apagan
          float fade = 1.0 - smoothstep(3.0, 9.0, vDepth);
          if (fade <= 0.0) discard;
          vec3 col = vec3(0.0);
          float alpha = 0.0;
          // --- gotas quietas ---
          vec3 g = vBody * 210.0;
          vec3 id = floor(g);
          vec3 h = hash33(id);
          vec3 h2 = hash33(id + 17.0);
          float life = fract(h.z + uTime * (0.04 + 0.1 * h2.x) * (1.0 + 3.0 * uRun));
          float r = (0.16 + 0.3 * h.x) * smoothstep(0.0, 0.15, life) * (1.0 - smoothstep(0.8, 1.0, life));
          float on = step(h.y, uAmount * (0.6 - 0.4 * uRun));
          vec3 o = fract(g) - mix(vec3(0.46), vec3(0.54), h2);
          float dd = length(o) / max(r, 1e-3);
          float m = on * (1.0 - smoothstep(0.7, 1.0, dd));
          if (m > 0.0) {
            // lente: el cielo invertido abajo (claro), el suelo arriba (oscuro) y el borde marcado
            float s = dot(o, uUp) / max(length(o), 1e-4);
            col = uColor * mix(1.25, 0.2, smoothstep(-0.6, 0.5, s));
            alpha = m * (0.3 + 0.45 * smoothstep(0.35, 0.9, dd));
          }
          // --- gotas que corren, con su reguero ---
          vec3 a = uFlow;
          vec3 u = normalize(cross(a, abs(a.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 v = cross(a, u);
          vec2 q = vec2(dot(vBody, u), dot(vBody, v)) * 95.0;
          vec3 hc = hash33(vec3(floor(q), 3.0));
          float onR = step(hc.z, uAmount * (0.12 + 0.5 * uRun));
          float speed = (0.25 + 1.6 * uRun) * (0.5 + hc.x);
          float t = fract(dot(vBody, a) * 3.0 - uTime * speed + hc.y * 7.0);
          float x = (fract(q.x) - 0.3 - 0.4 * hc.x) * 2.4;
          // cabeza en t ≈ 0,9; el reguero se alarga detrás (t menor) y se estrecha
          float head = 1.0 - smoothstep(0.6, 1.0, length(vec2(x * 1.6, (t - 0.9) * 22.0)));
          float trail = (1.0 - smoothstep(0.0, 0.07 * t, abs(x))) * smoothstep(0.3, 0.9, t) * step(t, 0.9);
          float mr = onR * max(head, trail * 0.22);
          if (mr > alpha) {
            col = uColor * mix(0.6, 0.95, head);
            alpha = mr * 0.42;
          }
          if (alpha * fade < 0.01) discard;
          gl_FragColor = vec4(col, alpha * fade);
        }`,
    })
  }

  /** Engancha los vidrios del modelo actual (se llama cada fotograma; solo rehace si cambian). */
  attach(glass: readonly Mesh[], root: Object3D, eyeWorld: Vector3): void {
    const key = `${glass.length}:${glass[0]?.uuid ?? ''}`
    if (key === this.key) return
    this.key = key
    for (const it of this.items) this.group.remove(it.mesh)
    this.items.length = 0
    for (const src of glass) {
      const mesh = new Mesh(src.geometry, this.mat)
      mesh.matrixAutoUpdate = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.items.push({ src, mesh })
    }
    // cabina cerrada: hay vidrio a los dos lados de la cabeza y delante (el techo puede ser opaco)
    root.updateMatrixWorld(true)
    const rc = new Raycaster()
    rc.far = 2.5
    // (los vidrios van en la capa de superposiciones)
    rc.layers.enableAll()
    const q = root.getWorldQuaternion(_q)
    const hit = (x: number, y: number, z: number): boolean => {
      rc.set(eyeWorld, _a.set(x, y, z).normalize().applyQuaternion(q))
      return rc.intersectObjects(glass as Mesh[], false).length > 0
    }
    this.enclosed = hit(0, 0.5, 1) && hit(0, 0.5, -1) && (hit(1, 0.6, 0) || hit(1, 0.15, 0))
  }

  /**
   * @param rain lluvia líquida 0..1
   * @param tas velocidad del aire (m/s)
   * @param relWind aire relativo en el mundo (de dónde viene el aire visto desde el aparato → hacia dónde sopla)
   */
  update(dt: number, rain: number, tas: number, relWind: Vector3, root: Object3D, light: Vector3, depth: { depthBuffer: Texture | null; resolution: Vector2; cameraFar: number }): boolean {
    // el vidrio se moja en unos segundos y tarda más en secarse (antes con viento)
    const tau = rain > this.amount ? 4 : Math.max(4, 25 - tas)
    this.amount += (rain - this.amount) * Math.min(1, dt / tau)
    const active = this.amount > 0.01 && this.items.length > 0
    this.group.visible = active
    if (!active) return false
    this.time += dt
    // las matrices del modelo son las del fotograma anterior hasta que se dibuje la escena: en vuelo
    // las gotas quedarían un metro por detrás del vidrio
    root.updateMatrixWorld(true)
    const u = this.mat.uniforms
    u.depthBuffer.value = depth.depthBuffer
    u.resolution.value.copy(depth.resolution)
    u.cameraFar.value = depth.cameraFar
    u.uBody.value.copy(root.matrixWorld).invert()
    const run = Math.min(1, tas / 22)
    // en el marco del aparato: la gravedad y el aire relativo
    const inv = _q.copy(root.getWorldQuaternion(_q)).invert()
    _a.set(0, -1, 0)
    if (relWind.lengthSq() > 1) _a.lerp(_b.copy(relWind).normalize(), run * 0.9).normalize()
    u.uFlow.value.copy(_a).applyQuaternion(inv)
    u.uUp.value.set(0, 1, 0).applyQuaternion(inv)
    u.uAmount.value = this.amount
    u.uRun.value = run
    u.uTime.value = this.time
    u.uColor.value.copy(light)
    for (const it of this.items) {
      it.mesh.visible = it.src.visible
      it.mesh.matrix.copy(it.src.matrixWorld)
      it.mesh.matrixWorld.copy(it.src.matrixWorld)
    }
    return true
  }
}

const _a = new Vector3()
const _b = new Vector3()
const _q = new Quaternion()
