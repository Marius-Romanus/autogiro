// Normales del relieve global (Terrarium) para el pase de normales.
//
// El terreno se dibuja como albedo sin iluminar y lo ilumina el posproceso de la atmósfera con
// las normales del NormalPass. El relieve Terrarium se desplaza en la GPU con su rejilla de
// alturas, y el NormalPass lo dibuja todo con un único MeshNormalMaterial sin ese
// desplazamiento: saldría el elipsoide liso. Por eso hasta ahora fuera de España las laderas
// llevaban la normal plana hacia arriba (no se oscurecían de espaldas al sol).
//
// Aquí, solo mientras se dibuja el pase de normales, cada tesela del relieve cambia su material
// por un MeshNormalMaterial con el mismo desplazamiento y la pendiente de la propia rejilla
// (diferencias centradas a un texel, como el TerrainLambertMaterial de la librería: la
// pendiente es continua entre texeles, sin facetas). `allowOverride = false` hace que el pase
// lo respete en lugar de su material único.

import { MeshNormalMaterial, type Material, type Mesh, type Texture } from 'three'

// (el mismo cálculo que TerrainLambertMaterial de 3d-tiles-renderer)
const BUMP_PARS = /* glsl */ `
#ifdef USE_BUMPMAP
  uniform sampler2D bumpMap;
  uniform float bumpScale;
  const float DEGENERATE_DET_EPSILON = 1e-3;
  vec2 dHdxy_fwd() {
    vec2 dSTdx = dFdx( vBumpMapUv );
    vec2 dSTdy = dFdy( vBumpMapUv );
    vec2 texelSize = 1.0 / vec2( textureSize( bumpMap, 0 ) );
    vec2 dx = vec2( texelSize.x, 0.0 );
    vec2 dy = vec2( 0.0, texelSize.y );
    float gradU = ( texture2D( bumpMap, vBumpMapUv + dx ).x - texture2D( bumpMap, vBumpMapUv - dx ).x ) / ( 2.0 * texelSize.x );
    float gradV = ( texture2D( bumpMap, vBumpMapUv + dy ).x - texture2D( bumpMap, vBumpMapUv - dy ).x ) / ( 2.0 * texelSize.y );
    return bumpScale * vec2( gradU * dSTdx.x + gradV * dSTdx.y, gradU * dSTdy.x + gradV * dSTdy.y );
  }
  vec3 perturbNormalArb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
    vec3 vSigmaX = dFdx( surf_pos.xyz );
    vec3 vSigmaY = dFdy( surf_pos.xyz );
    vec3 vN = surf_norm;
    vec3 R1 = cross( vSigmaY, vN );
    vec3 R2 = cross( vN, vSigmaX );
    float fDet = dot( vSigmaX, R1 ) * faceDirection;
    // de canto (los faldones de las teselas): la normal de la superficie
    if ( abs( fDet ) < DEGENERATE_DET_EPSILON * length( vSigmaX ) * length( vSigmaY ) ) return surf_norm;
    vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
    return normalize( abs( fDet ) * surf_norm - vGrad );
  }
#endif
`

class TerrainNormalMaterial extends MeshNormalMaterial {
  constructor(map: Texture) {
    super()
    this.displacementMap = map
    this.bumpMap = map
    // el NormalPass usa un material único para toda la escena; este se respeta
    ;(this as unknown as { allowOverride: boolean }).allowOverride = false
    this.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <bumpmap_pars_fragment>', BUMP_PARS)
    }
  }

  customProgramCacheKey(): string {
    return 'terrain-normal'
  }
}

type TerrainMaterial = Material & { displacementMap?: Texture | null; displacementScale?: number }

export class TerrainNormals {
  private readonly mats = new WeakMap<Mesh, TerrainNormalMaterial>()
  private readonly swapped: Array<[Mesh, Material | Material[]]> = []

  /** Antes del pase de normales: las teselas del relieve pasan a su material de normales. */
  begin(meshes: Iterable<Mesh>): void {
    for (const m of meshes) {
      const mat = m.material as TerrainMaterial | TerrainMaterial[]
      if (Array.isArray(mat) || !mat.displacementMap) continue
      let n = this.mats.get(m)
      if (!n || n.displacementMap !== mat.displacementMap) {
        n?.dispose()
        n = new TerrainNormalMaterial(mat.displacementMap)
        this.mats.set(m, n)
      }
      const scale = mat.displacementScale ?? 1
      n.displacementScale = scale
      n.bumpScale = scale
      n.side = mat.side
      this.swapped.push([m, m.material])
      m.material = n
    }
  }

  /** Después del pase: cada tesela recupera su material. */
  end(): void {
    for (const [m, mat] of this.swapped) m.material = mat
    this.swapped.length = 0
  }

  /** Una tesela que se descarga. */
  release(m: Mesh): void {
    this.mats.get(m)?.dispose()
    this.mats.delete(m)
  }
}
