"""
ELA 07 Scorpion (ELA Aviacion, Cordoba; the "sport line" ELA 07 with the Rotax 914 UL Turbo) for the
Autogiro web sim: open tandem pod with a long pointed beak, two separate windscreens (a tall raked front
one with a smoked lower rim, a folding rear one on the reclined front-seat-back hump), sponson ridges
along the pod sides with the storage hatches, carbon hood over the engine with three stacked scalloped
tiers, Helix H50 three-blader with spinner, flat blade main legs with open teardrop spats, bare nose fork,
faired keel plate + single tube up to a high tail: swept tailplane whose tips turn up into canted end
plates, boxy fin with a big rudder.

Traced on the ELA factory side photo (Streamlined-design.jpg, pure left side, 1900 px) in the hub
frame (see gyrokit.py): scale 279 px/m from the propeller (upper blade vertical, 240 px = R 0.86 m),
checked with the 4.00-6 main tyres (R 0.18 m = 50 px) and the other photos (Oshkosh N463LA, cut-out
3/4, front view, close-ups).

  blender -b -P blender/build_scorpion.py -- [--previews] [--only VIEW,...] [--show-rear]
                                              [--overlay yaw,cx,cz,ppm,w,h[,side]]
Outputs: public/models/scorpion.glb, blender/scorpion.blend, blender/previews/scorpion/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- photo -> hub frame ------------------------------------------------------------------------
PPM = 279.0                         # px per metre on side_left_pure_1.jpg
HUB_PX = (976.0, 333.0)             # teeter bolt


def H(x, y):
    """Photo pixel -> hub frame (X, Z)."""
    return ((x - HUB_PX[0]) / PPM, (HUB_PX[1] - y) / PPM)


# The camera stood ~10 m away and ~1.3 m up (horizon y 698): the near main wheel is 0.76 m closer than
# the centreline, so it looks 8 % bigger and its tyre bottom 27 px lower (y 1088) than the ground under
# the centreline (y 1061, the nose tyre). Near-side points are corrected with
# x' = 950 + (x - 950) / 1.08, y' = 698 + (y - 698) / 1.08 before conversion.
GROUND = -2.609                     # ground under the centreline (y 1061 px)
AXLE = (-0.300, GROUND + 0.175)     # main axle (corrected near wheel: R 0.175)
MAIN_R = 0.175
MAIN_Y = 0.76                       # half track (front view)
NOSE = (1.620, GROUND + 0.136)      # nose wheel centre (x 1428, tyre 985..1061 px)
NOSE_R = 0.136
# CG: sim convention 0.33 m ahead of the hub; height 0.85 m above the main axle (no published limits)
CG = (0.33, AXLE[1] + 0.85)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.012, -0.200)
PROP = R(-0.946, -1.412)
PROP_R = 0.86

LIVERY = dict(body=('#F07812', 0.45, 0.22), accent=('#1A1B1E', 0.3, 0.35), dark=('#141517', 0.2, 0.4),
              seat=('#121315', 0.0, 0.75))
REG = 'EC-GS7'


def ensure_mats():
    if 'Rotax_Red' not in MATS:
        B.make_mat('Rotax_Red', B.srgb('#C0161C'), metal=0.3, rough=0.35)
    if 'Hose_Orange' not in MATS:
        B.make_mat('Hose_Orange', B.srgb('#E2541A'), rough=0.5)
    if 'Glass_Smoke' not in MATS:
        B.make_mat('Glass_Smoke', B.srgb('#101418'), metal=0.0, rough=0.05, alpha=0.82)
    if 'Groove' not in MATS:
        B.make_mat('Groove', B.srgb('#4A1E06'), rough=0.5)
    if 'Crease' not in MATS:
        B.make_mat('Crease', B.srgb('#9A3A06'), metal=0.3, rough=0.35)
    if 'Belt_Black' not in MATS:
        B.make_mat('Belt_Black', B.srgb('#1C1D20'), rough=0.8)


# ---- pod: stations (X, top, shoulder z, shoulder half-width, chine z, chine half-width, bottom) ----
# The chine is the sponson ridge: wider than the shoulder, concave wall above it (bow < 0).
ROWS = [
    (2.20, -2.112, -2.142, 0.058, -2.170, 0.064, -2.202),
    (2.10, -2.015, -2.085, 0.125, -2.158, 0.140, -2.228),
    (1.95, -1.875, -1.995, 0.200, -2.140, 0.228, -2.262),
    (1.80, -1.735, -1.905, 0.255, -2.118, 0.290, -2.287),
    (1.65, -1.560, -1.845, 0.292, -2.098, 0.330, -2.300),
    (1.48, -1.500, -1.800, 0.315, -2.082, 0.357, -2.305),
    (1.25, -1.480, -1.760, 0.322, -2.065, 0.370, -2.306),
    (1.00, -1.470, -1.720, 0.332, -2.052, 0.378, -2.306),
    (0.80, -1.390, -1.720, 0.334, -2.050, 0.380, -2.306),
    (0.60, -1.272, -1.740, 0.334, -2.050, 0.380, -2.307),
    (0.45, -1.300, -1.780, 0.333, -2.052, 0.379, -2.309),
    (0.25, -1.420, -1.800, 0.330, -2.058, 0.376, -2.312),
    (0.05, -1.290, -1.700, 0.320, -2.066, 0.368, -2.316),
    (-0.15, -1.172, -1.600, 0.300, -2.075, 0.350, -2.322),
    (-0.35, -1.168, -1.540, 0.282, -2.085, 0.330, -2.328),
    (-0.55, -1.168, -1.470, 0.268, -2.095, 0.305, -2.330),
    (-0.70, -1.178, -1.420, 0.250, -2.100, 0.285, -2.330),
    (-0.80, -1.195, -1.400, 0.232, -2.100, 0.265, -2.330),
]
NTS = [2.2, 2.3, 2.4, 2.5, 2.7, 2.6, 2.3, 2.0, 1.7, 1.5, 1.6, 2.0, 2.0, 2.0, 2.1, 2.1, 2.1, 2.1]


class Pod(E.Fuselage):
    """Stationed fuselage with a per-station top exponent (narrow headrest hump, round nose deck)."""

    def __init__(self, table, nts, **kw):
        super().__init__(table, **kw)
        self.NT = B.hermite([r[0] for r in table], nts)

    def params(self, x):
        p = super().params(x)
        p['nt'] = self.NT(max(self.xrear, min(x, self.xn)))
        return p

    def half(self, p, m=40):
        self.nt = p.get('nt', 2.2)
        return super().half(p, m)


POD = Pod(R.table(ROWS), NTS, tip=(R.x(2.272), R.z(-2.183)), nt=2.2, nb=2.4, bow=-0.022,
          linear_nose=True, nose_exp=0.55)

# ---- openings (side view, hub frame) ----
SILL_F = [(1.530, -1.870), (1.520, -1.817), (1.341, -1.753), (1.161, -1.728), (0.982, -1.681), (0.918, -1.663)]
HUMP_FRONT = [(0.918, -1.663), (0.821, -1.584), (0.749, -1.495), (0.677, -1.387), (0.624, -1.297)]
HUMP_REAR = [(0.487, -1.300), (0.459, -1.362), (0.470, -1.452), (0.531, -1.548), (0.616, -1.624),
             (0.727, -1.692), (0.753, -1.792)]
SILL_R = [(0.753, -1.792), (0.717, -1.846), (0.531, -1.867), (0.384, -1.828), (0.287, -1.767), (0.186, -1.706),
          (0.115, -1.631), (0.039, -1.545), (-0.030, -1.434), (-0.055, -1.333), (-0.062, -1.20)]
WS_BASE_C = (1.630, -1.566)          # front windscreen base on the deck centreline
WS_BASE_S = (1.530, -1.870)          # ... and at the sill
OPEN_FRONT = SILL_F + HUMP_FRONT[1:] + [(0.624, 0.0), (1.630, 0.0), WS_BASE_C, (1.580, -1.725)]
OPEN_REAR = HUMP_REAR + SILL_R[1:] + [(-0.062, 0.0), (0.487, 0.0)]
# engine bay below the hood (the pod's rear wall stands at X -0.432)
X_WALL = -0.432
HOOD_LIP = [(-0.432, -1.470), (-0.560, -1.455), (-0.660, -1.440), (-0.735, -1.400), (-0.775, -1.330),
            (-0.795, -1.250), (-0.80, -1.20)]
OPEN_BAY = HOOD_LIP + [(-1.0, -1.20), (-1.0, -2.6), (-0.432, -2.6)]

FRONT_HIP = R(1.13, -2.02)
REAR_HIP = R(0.36, -1.960)
FRONT_BACK, REAR_BACK = 24.0, 26.0


def pod_y(X, Z):
    """Half-width of the pod envelope at hub-frame (X, Z) (largest y on the section at that height)."""
    p = POD.params(R.x(X))
    h = POD.half(p)
    if POD.chine_sharp:
        h = h[0] + h[1][1:]
    best = 0.0
    z = R.z(Z)
    for (a, b), (c, d) in zip(h, h[1:]):
        if (b - z) * (d - z) <= 0 and b != d:
            t = (z - b) / (d - b)
            best = max(best, lerp(a, c, t))
    return best


def cap_poly(name, X, zmax, mat='Paint_White', zmin=-9.0):
    """Flat wall at station X: the envelope section between zmin and zmax (hub frame)."""
    ring = POD.ring(R.x(X), 48)
    pts = [p for p in ring if R.z(zmin) <= p.z <= R.z(zmax)]
    pts.sort(key=lambda p: math.atan2(p.z - R.z(zmax), p.y))
    mb = MB(name)
    c = sum(pts, Vector()) / len(pts)
    mb.faces([c] + pts, [[0, i, i + 1] for i in range(1, len(pts))] + [[0, len(pts), 1]], mat, smooth=False)
    return mb.finish(sharp_angle=80)


def build_pod():
    pod = POD.shell('pod', step=0.03, n_half=40, rear=())
    # crisp outline of the hatch / door / round fuel door: panel lines are separate (details)
    rim = K.cut_polys(pod, [R.pts(OPEN_FRONT), R.pts(OPEN_REAR), R.pts(OPEN_BAY)], rim_r=0.012,
                      rim_mat='Paint_White', thickness=0.010)
    return pod, rim


def bulkheads():
    """Close the reclined front-seat-back hump: its front face (behind the pilot's seat) and its
    underside seen from the rear cockpit; rear wall of the pod over the engine bay; floors."""
    mb = MB('bulkheads')
    for line, inset, zmin, narrow in ((HUMP_FRONT, -0.012, -1.60, 0.012), (HUMP_REAR, 0.012, -1.66, 0.05)):
        pts = [p for p in catmull([Vector((x, 0, z)) for x, z in line], 4) if p.z >= zmin]
        rows = []
        for p in pts:
            X, Z = p.x, p.z
            w = max(0.0, pod_y(X + inset, Z) - narrow)
            rows.append([R(X + inset, Z, -w), R(X + inset, Z, w)])
        for a, b in zip(rows, rows[1:]):
            mb.faces([a[0], a[1], b[1], b[0]], [[0, 1, 2, 3]], 'Interior', smooth=False)
    ob = mb.finish(sharp_angle=80)
    wall = cap_poly('rear_wall', X_WALL + 0.006, -1.47)
    return [ob, wall]


def surface_line(mb, target, pts, n, r=0.0022, mat='Groove', samples=6):
    """Thin dark groove along a polyline projected on target along -n."""
    q = pilot.surface_path(target, pts, n, 0.0005, samples=samples)
    if len(q) >= 2:
        mb.tube(q, r, mat, n=6, cap=True)


def project(target, pts_dirs, off):
    """Project (point, outward direction) pairs on target: ray from 0.5 m outside along -direction."""
    inv = target.matrix_world.inverted()
    out = []
    for p, d in pts_dirs:
        d = Vector(d).normalized()
        o = Vector(p) + d * 0.5
        ok, loc, nrm, _ = target.ray_cast(inv @ o, (inv.to_3x3() @ -d).normalized(), distance=1.2)
        if ok:
            out.append(target.matrix_world @ loc + (target.matrix_world.to_3x3() @ nrm).normalized() * off)
    return out


def panel_lines(pod):
    mb = MB('panel_lines')
    for sy in (1, -1):
        n = V(0, sy, 0)

        def side(pts):
            return [R(x, z, sy * 0.6) for x, z in pts]
        # storage hatch in the sponson (rounded rectangle), latch below its front end
        hx0, hx1, hz0, hz1 = 0.444, 1.179, -2.193, -1.953
        rr = 0.035
        poly = []
        for cx, cz, a0 in ((hx1 - rr, hz1 - rr, 0), (hx0 + rr, hz1 - rr, 90), (hx0 + rr, hz0 + rr, 180),
                           (hx1 - rr, hz0 + rr, 270)):
            for k in range(4):
                a = math.radians(a0 + 90 * k / 3)
                poly.append((cx + rr * math.cos(a), cz + rr * math.sin(a)))
        poly.append(poly[0])
        # front cockpit side panel (lift-out door) below the sill
        dx0, dx1, dz0, dz1 = 0.964, 1.515, -1.958, -1.705
        door = [(dx0 + 0.03, dz1 + 0.012), (dx0, dz1 - 0.02), (dx0, dz0 + 0.03), (dx0 + 0.03, dz0),
                (dx1 - 0.03, dz0 + 0.008), (dx1, dz0 + 0.04), (dx1 + 0.012, dz1 - 0.07)]
        # round fuel door + rear section seams
        circ = [(-0.235 + 0.095 * math.cos(TAU * k / 20), -1.745 + 0.095 * math.sin(TAU * k / 20)) for k in range(21)]
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: hatch, door, fuel-door and rear-section outlines removed)
    # scalloped tiers of the hood: three overlapping "scorpion" segments whose edges run from the top
    # centreline (aft) forward and down the sides (photo: hood lines from y 662-668 down to y 720-767)
    for x_top, x_end, z_end in ((-0.774, -0.226, -1.55), (-0.606, -0.190, -1.47), (-0.513, -0.13, -1.40)):
        for sy in (1, -1):
            pts = []
            for k in range(13):
                t = k / 12
                x = lerp(x_top, x_end, t)
                z = lerp(-1.17, z_end, t ** 1.25)
                phi = 0.5 * math.pi * min(1.0, t * 2.2)
                d = V(0, sy * math.sin(phi), math.cos(phi))
                pts.append((R(x, z, 0.0) + V(0, sy * 0.15 * math.sin(phi), 0), d))
            q = project(pod, pts, 0.0006)
            if len(q) > 2:
                mb.tube(catmull(q, 3), 0.0024, 'Crease', n=6)
    # the same segment lines across the nose deck (front view: three gull-wing creases)
    for x0 in (1.72, 1.86, 2.00):
        pts = []
        for j in range(17):
            u = -1 + 2 * j / 16
            x = x0 + 0.045 * (math.cos(1.5 * math.pi * u) - 1) * 0.5 - 0.03 * abs(u)
            w = pod_y(x, -1.92)
            pts.append((R(x, -1.55, u * 0.74 * w), V(0, 0, 1)))
        q = project(pod, pts, 0.0006)
        if len(q) > 2:
            mb.tube(catmull(q, 3), 0.0022, 'Crease', n=6)
    # moulded shoulder creases from the windscreen corners to the beak tip
    for sy in (1, -1):
        pts = []
        for k in range(12):
            t = k / 11
            x = lerp(1.62, 2.20, t)
            z = lerp(-1.76, -2.14, t ** 1.1)
            pts.append((R(x, z, 0.0), V(0, sy, 0.9).normalized()))
        q = project(pod, pts, 0.0006)
        if len(q) > 2:
            mb.tube(catmull(q, 3), 0.0022, 'Crease', n=6)
    return mb.finish(sharp_angle=60)


# ---------------------------------------------------------------------------
# Windscreens
# ---------------------------------------------------------------------------
def dome_screen(name, base_c, base_s, tip, hw, side_path, nu=28, nv=16, smoke=0.0, bulge=0.03):
    """Wrap-round screen: centreline from base_c to tip (hub frame (X, Z)); side edges (y = +-hw at the
    base) follow side_path(v) -> (X, Z, w); every row is an arc from side to side through the centreline.
    smoke: rows whose height above the base is below it are smoked glass (rim)."""
    rows = []
    for j in range(nv + 1):
        v = j / nv
        cx, cz = lerp(base_c[0], tip[0], v), lerp(base_c[1], tip[1], v)
        sx, sz, w = side_path(v)
        row = []
        for i in range(nu + 1):
            u = -1 + 2 * i / nu
            a = 1 - math.cos(0.5 * math.pi * u)
            x, z = lerp(cx, sx, a), lerp(cz, sz, a)
            x += bulge * math.sin(math.pi * v) * math.cos(0.5 * math.pi * u)
            row.append(R(x, z, w * math.sin(0.5 * math.pi * u)))
        rows.append(row)
    mb = MB(name)
    coords = [p for r in rows for p in r]
    W = nu + 1
    clear, dark = [], []
    for j in range(nv):
        for i in range(nu):
            a = j * W + i
            f = [a, a + 1, a + W + 1, a + W]
            hz = (rows[j][i].z + rows[j + 1][i + 1].z) * 0.5 - (rows[0][i].z + rows[0][i + 1].z) * 0.5
            (dark if hz < smoke else clear).append(f)
    mb.faces(coords, clear, 'Glass')
    if dark:
        mb.faces(coords, dark, 'Glass_Smoke')
    bm = mb.bm
    bm.normal_update()
    if sum(f.normal.x * f.calc_area() for f in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    ob = mb.finish(sharp_angle=80, recalc=False)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    B.apply_mods(ob)
    fr = MB(name + '_frame')
    fr.tube(rows[0], 0.009, 'Paint_Dark', n=8)
    return ob, fr.finish(sharp_angle=60), rows


def front_screen():
    tip = H(1311, 662)
    def side(v):
        # side edge: steep from the sill up to the deck shoulder, then raked to the tip
        if v < 0.34:
            t = v / 0.34
            x, z = lerp(1.530, 1.480, t ** 0.8), lerp(-1.870, -1.640, t)
        else:
            t = (v - 0.34) / 0.66
            x, z = lerp(1.480, tip[0] + 0.02, t ** 0.9), lerp(-1.640, tip[1] - 0.01, t)
        w = 0.312 * (1 - max(0.0, v - 0.15) ** 2.4 / 0.85 ** 2.4) ** 0.55 if v < 1 else 0.0
        return x, z, max(w, 0.0)
    return dome_screen('ws_front', WS_BASE_C, WS_BASE_S, tip, 0.312, side, smoke=0.10, bulge=0.03)


def rear_screen():
    base = (0.556, -1.282)
    tip = H(1083, 612)
    def side(v):
        x, z = lerp(0.548, tip[0] + 0.015, v), lerp(-1.33, tip[1] - 0.005, v)
        w = 0.215 * (1 - v ** 2.6) ** 0.5 if v < 1 else 0.0
        return x, z, w
    ob, fr, rows = dome_screen('ws_rear', base, None, tip, 0.215, side, nu=22, nv=12, bulge=0.015)
    # folding hinge bracket on the hump top
    for sy in (1, -1):
        fr_mb = MB('rws_hinge')
        fr_mb.box(R(0.545, -1.29, sy * 0.10), (0.06, 0.03, 0.05), 'Paint_Dark', bevel=0.008, segs=2)
        fr = B.join_objects(fr.name, [fr, fr_mb.finish(sharp_angle=50)])
    return ob, fr


# ---------------------------------------------------------------------------
# Mast, head, rotor
# ---------------------------------------------------------------------------
def build_mast():
    """Body-coloured flat steel mast leaning forward, cheek plates on the pitch pivot, the two push rods
    behind it, cross bar with the strobe, pneumatic trim/brake cylinder, pre-rotator shaft."""
    mb = MB('mast')
    foot = R(-0.25, -2.30)
    base = R(-0.100, -1.17)
    top = R(0.030, -0.26)
    mb.tube([foot, base, top], 0.05, 'Paint_White', n=28, square=(0.052, 0.100, 8))
    for sy in (1, -1):
        mb.box(PIVOT + V(-0.012, sy * 0.040, -0.02), (0.12, 0.010, 0.13), 'Paint_White', bevel=0.012, segs=2,
               rot=K.rot_y(-6))
        mb.cyl(PIVOT + V(0, sy * 0.036, 0), PIVOT + V(0, sy * 0.058, 0), 0.016, 'Engine', n=12)
    # cross bar aft of the mast with the strobe at its end, and the side rod guides
    cb = R(-0.10, -0.385)
    mb.box(cb, (0.20, 0.03, 0.022), 'Paint_White', bevel=0.006, segs=1)
    mb.box(R(-0.19, -0.385), (0.025, 0.29, 0.02), 'Paint_White', bevel=0.005, segs=1)
    K.lamp(mb, R(-0.215, -0.385), V(-1, 0, 0), kind='white', r=0.016, length=0.03)
    # pneumatic trim / rotor brake cylinder between head and cross bar, hose down the mast
    mb.cyl(R(-0.07, -0.42), R(-0.07, -0.30), 0.017, 'Chrome', n=14)
    mb.cyl(R(-0.07, -0.30), R(-0.07, -0.23), 0.008, 'Chrome', n=8)
    mb.tube(catmull([R(-0.07, -0.43), R(-0.09, -0.62), R(-0.10, -0.95), R(-0.09, -1.15)], 5), 0.006, 'Rubber', n=6)
    # push rods either side behind the mast
    for sy in (1, -1):
        lo = R(-0.20, -1.17, sy * 0.13)
        hi = PIVOT + V(-0.19, sy * 0.13, 0.02)
        mb.cyl(lo, hi, 0.0085, 'Paint_White', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.035), 0.012, 'Alu_Black', n=8)
        mb.cyl(lo, lo + V(0, 0, -0.06), 0.013, 'Alu_Black', n=8)
    # pre-rotator flexible shaft from the engine up behind the mast to the Bendix
    mb.tube(catmull([R(-0.42, -1.25), R(-0.25, -1.10), R(-0.15, -0.80), R(-0.13, -0.40), PIVOT + V(-0.135, 0, -0.07)], 5), 0.009, 'Paint_Dark', n=8)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotax 914 UL (rewritten from build_autogiro.build_engine with the Scorpion's proportions: crank 0.1 m
# under the prop shaft, red valve covers, turbo + stainless muffler at the back, orange hoses)
# ---------------------------------------------------------------------------
def build_engine(P):
    mb = MB('engine')
    P = Vector(P)

    def Q(dx, y, dz):
        return P + V(dx, y, dz)
    zc = -0.10
    mb.box(Q(0.33, 0, zc), (0.34, 0.22, 0.24), 'Engine', bevel=0.04, segs=3)               # crankcase
    mb.box(Q(0.33, 0, zc - 0.13), (0.30, 0.18, 0.06), 'Engine_Dark', bevel=0.02, segs=2)   # oil pan
    for sy, xs in ((1, (0.22, 0.40)), (-1, (0.26, 0.44))):
        for x in xs:
            mb.lathe(B.finned_profile(0.050, 0.064, 0.105, 0.225), Q(x, 0, zc), V(0, sy, 0), 'Engine', n=20)
            mb.box(Q(x, sy * 0.258, zc), (0.12, 0.06, 0.13), 'Engine', bevel=0.016, segs=2)
            mb.box(Q(x, sy * 0.298, zc + 0.005), (0.10, 0.026, 0.10), 'Rotax_Red', bevel=0.012, segs=2)
            mb.cyl(Q(x + 0.03, sy * 0.30, zc + 0.05), Q(x + 0.03, sy * 0.33, zc + 0.09), 0.008, 'Paint_Dark', n=8)
            mb.tube(catmull([Q(x, sy * 0.27, zc - 0.07), Q(x, sy * 0.27, zc - 0.15), Q(x - 0.05, sy * 0.19, zc - 0.21),
                             Q(0.10, sy * 0.06, -0.24)], 4), 0.018, 'Steel_Exhaust', n=10, cap=True)
        mb.tube(catmull([Q(0.46, sy * 0.25, zc + 0.08), Q(0.33, sy * 0.24, zc + 0.11), Q(0.18, sy * 0.16, zc - 0.02),
                         Q(0.12, sy * 0.10, -0.20)], 5), 0.015, 'Hose_Orange', n=8)
        # carbs on the plenum, float bowls
        mb.cyl(Q(0.33, sy * 0.10, 0.10), Q(0.33, sy * 0.19, 0.07), 0.032, 'Engine', n=14)
        mb.cyl(Q(0.33, sy * 0.19, 0.07), Q(0.33, sy * 0.21, 0.05), 0.040, 'Engine_Dark', n=14)
        mb.tube(catmull([Q(0.33, sy * 0.15, 0.08), Q(0.32, sy * 0.21, 0.0), Q(0.33, sy * 0.25, zc + 0.08)], 4),
                0.016, 'Engine', n=8)
    # airbox / plenum on top, turbo charger + wastegate at the back left
    mb.box(Q(0.33, 0, 0.14), (0.30, 0.20, 0.10), 'Engine_Dark', bevel=0.03, segs=3)
    mb.lathe([(0.0, -0.05), (0.06, -0.05), (0.07, -0.02), (0.07, 0.03), (0.05, 0.05), (0.0, 0.05)],
             Q(0.13, 0.12, -0.20), V(0, 1, 0), 'Steel_Exhaust', n=20)
    mb.cyl(Q(0.13, 0.17, -0.20), Q(0.13, 0.22, -0.14), 0.035, 'Hose_Orange', n=12)
    # stainless muffler can at the bottom rear (the silver box seen under the gearbox)
    mb.lathe([(0.0, -0.10), (0.042, -0.10), (0.05, -0.085), (0.05, 0.085), (0.042, 0.10), (0.0, 0.10)],
             Q(0.075, -0.03, -0.32), V(0, 0, 1), 'Chrome', n=20)
    mb.tube(catmull([Q(0.075, -0.03, -0.42), Q(0.06, -0.05, -0.46), Q(-0.02, -0.06, -0.47)], 4), 0.02,
            'Steel_Exhaust', n=10, cap=True)
    mb.tube(catmull([Q(0.10, 0.06, -0.24), Q(0.09, 0.0, -0.25), Q(0.08, -0.03, -0.24)], 3), 0.022,
            'Steel_Exhaust', n=10)
    # gearbox: housing round the prop shaft, down to the crankcase
    mb.box(Q(0.11, 0, -0.04), (0.10, 0.19, 0.24), 'Engine', bevel=0.04, segs=3)
    mb.lathe([(0.0, 0.16), (0.085, 0.16), (0.090, 0.13), (0.080, 0.08), (0.055, 0.05), (0.0, 0.05)],
             P, V(1, 0, 0), 'Engine', n=28)
    # starter, alternator cover, coolant expansion tank, oil tank on the mount
    mb.cyl(Q(0.47, -0.10, -0.20), Q(0.36, -0.10, -0.20), 0.040, 'Engine_Dark', n=16)
    mb.cyl(Q(0.50, 0.0, zc), Q(0.53, 0.0, zc), 0.09, 'Engine_Dark', n=24)
    mb.cyl(Q(0.47, 0.16, 0.0), Q(0.47, 0.16, 0.12), 0.042, 'Metal_Frame', n=18)
    mb.cyl(Q(0.50, -0.20, -0.30), Q(0.50, -0.20, -0.08), 0.055, 'Alu_Black', n=18)
    # engine mount ring bolted to the rear wall
    for sy in (1, -1):
        for dz in (0.02, -0.22):
            mb.cyl(Q(0.52, sy * 0.10, zc + dz), V(R.x(X_WALL), sy * 0.13, P.z + zc + dz * 1.2), 0.011, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=38, wn=True)


def build_hood_details():
    """Cooling air inlets (dark slots between the hood and the rear cockpit fairing)."""
    mb = MB('hood_det')
    for sy in (1, -1):
        for dx in (0.0,):
            x0, x1 = -0.20, -0.12
            pts = [R(x, z, sy * (pod_y(x, z) + 0.002)) for x, z in ((x0, -1.40), (x1, -1.40), (x1, -1.64), (x0, -1.64))]
            c = sum(pts, Vector()) / 4
            mb.faces(pts, [[0, 1, 2, 3]], 'Paint_Dark', smooth=False)
            del c, dx
    return mb.finish(sharp_angle=80)


# ---------------------------------------------------------------------------
# Keel and tail
# ---------------------------------------------------------------------------
NODE = (-0.985, -2.372)
STAB_Z = -2.115
TE_X = -2.29
APEX_X = -1.376
TIP_Y = 0.78
PLATE_H = 0.52
PLATE_CANT = 15.0
HINGE = -1.978
FIN_TOP = -1.272
RUD_TOP = -1.297


def build_keel():
    """Horizontal arrow-head fairing plate behind the pod bottom (carries the main leg roots), keel
    bar under it, gusset node, single round tube up to the tailplane and the bar under it, tail wheel."""
    mb = MB('keel')
    # fairing plate: wedge in plan, slanting down aft
    x0, z0 = -0.40, -2.150
    x1, z1 = NODE[0] - 0.02, NODE[1] + 0.025
    rings = []
    for k in range(9):
        t = k / 8
        x, z = lerp(x0, x1, t), lerp(z0, z1, t)
        hw = lerp(0.24, 0.035, t ** 0.85)
        th = lerp(0.045, 0.03, t)
        ring = []
        for j in range(16):
            a = TAU * j / 16
            ring.append(R(x, z + B.sgnpow(math.sin(a), 0.6) * th * 0.5, B.sgnpow(math.cos(a), 0.35) * hw))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # "La aleta" (the ONLY thing the owner asked to add here; the rest of the keel is the traced original):
    # the same V-shaped plate as on the Cougar (build_ela07.py), on the keel bar at the node, apex forward,
    # trailing edge 12 cm behind the bolt (side_left_pure_1: px 677 / 980), the strut landing flush on it.
    FIN_LE = [(-1.180, 0.162), (-1.130, 0.158), (-1.085, 0.146), (-1.035, 0.126), (-0.990, 0.102),
              (-0.945, 0.077), (-0.900, 0.052), (-0.855, 0.028), (-0.815, 0.008), (-0.795, 0.0)]
    st = []
    for X, hw in reversed(FIN_LE):
        u = (-0.795 - X) / 0.385
        st.append((R(X + 0.073, lerp(-2.336, -2.338, u)), hw, lerp(0.012, 0.020, u)))
    st.append((R(-1.205 + 0.073, -2.338), 0.150, 0.020))
    K.delta_plate(mb, st)
    # keel bar from the pod belly to the node (stainless, body colour)
    mb.tube([R(-0.30, -2.33), R(-0.60, -2.355), R(NODE[0], NODE[1] - 0.02)], 0.0, 'Paint_White', n=16,
            square=(0.05, 0.05, 6), cap=True)
    # node gusset plates and bolt
    for sy in (1, -1):
        mb.box(R(NODE[0], NODE[1], sy * 0.03), (0.16, 0.008, 0.075), 'Paint_White', bevel=0.004, segs=1,
               rot=K.rot_y(8))
        mb.cyl(R(NODE[0] + 0.02, NODE[1] - 0.005, sy * 0.034), R(NODE[0] + 0.02, NODE[1] - 0.005, sy * 0.045), 0.012,
               'Metal_Frame', n=10)
    # tail tube up to the tailplane, flattened bar under the stab to the tail wheel
    a = R(NODE[0] - 0.03, NODE[1] + 0.01)
    # tube end and bar tight under the tailplane, no gap (side_left_pure_1: the stab underside rests on the
    # bar); they sat 2 cm low with spacer blocks in between
    b = R(-1.44, -2.182)
    mb.cyl(a, b, 0.030, 'Paint_White', n=16)
    mb.tube([R(-1.40, -2.181), R(-1.80, -2.182), R(-2.12, -2.158)], 0.0, 'Paint_White', n=12,
            square=(0.05, 0.04, 6), cap=True)
    for x in (-1.50, -1.90):        # clamp bands round the bar
        mb.box(R(x, -2.181 if x > -1.7 else -2.177), (0.03, 0.058, 0.045), 'Metal_Frame', bevel=0.004, segs=1)
    # tail wheel (small castor) under the bar end
    tw = R(-2.07, -2.222)
    mb.lathe(B.tire_profile(0.032, 0.016, 0.022), tw, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.box(tw + V(0.0, 0, 0.022), (0.03, 0.035, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


def stab_le(y):
    """Leading edge of the tailplane (hub X) along the span: apex on the centreline, swept to the tip."""
    return APEX_X - (1.99 + APEX_X) * min(abs(y), TIP_Y) / TIP_Y


def build_tail():
    """Tailplane in one piece: swept leading edge, straight trailing edge, tips bent up into canted end
    plates (a U seen from the front); boxy central fin (the rudder is its own node)."""
    mb = MB('tail')
    cant = math.radians(PLATE_CANT)
    bend_r = 0.07
    # path in the (y, z) plane for the right half (y > 0); mirrored
    path = []
    ys = [0.0, 0.10, 0.22, 0.36, 0.50, 0.62, TIP_Y - bend_r]
    for y in ys:
        path.append((y, 0.0, 0.0, 1.0))       # (y, dz, ny, nz) normal = up
    for k in range(1, 7):
        a = (0.5 * math.pi - cant) * k / 6
        y = TIP_Y - bend_r + bend_r * math.sin(a)
        dz = bend_r * (1 - math.cos(a))
        path.append((y, dz, -math.sin(a), math.cos(a)))
    top = PLATE_H - bend_r
    for s in (0.06, 0.16, 0.28, 0.40, top * 0.92, top):
        a = 0.5 * math.pi - cant
        y = path[-1][0] if s == 0 else (TIP_Y - bend_r + bend_r * math.sin(a)) + s * math.cos(a)
        dz = bend_r * (1 - math.cos(a)) + s * math.sin(a)
        path.append((y, dz, -math.sin(a), math.cos(a)))

    def chord(i, y, dz):
        h = dz / PLATE_H
        if dz < 0.02:
            return stab_le(y), TE_X
        le = lerp(-1.99, -2.10, h) - 0.035 * max(0.0, (h - 0.9) / 0.1) ** 2
        te = TE_X + 0.03 * max(0.0, (h - 0.9) / 0.1) ** 2
        return le, te
    loop = airfoil_ring(14, 0.09, te_min=0.0025)
    half = []
    for i, (y, dz, ny, nz) in enumerate(path):
        le, te = chord(i, y, dz)
        c = le - te
        t_scale = 0.11 if dz < 0.02 else 0.085
        ring = []
        for s, tz in loop:
            th = tz * c * (t_scale / 0.09)
            ring.append((le - s * c, y + th * ny, STAB_Z + dz + th * nz))
        half.append(ring)
    rings = []
    for ring in reversed(half[1:]):
        rings.append([R(x, z, -yy) for x, yy, z in ring])
    for ring in half:
        rings.append([R(x, z, yy) for x, yy, z in ring])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # central fin (fixed part, up to the hinge)
    zs = [STAB_Z - 0.03, STAB_Z + 0.04, -1.98, -1.85, -1.70, -1.55, -1.42, -1.33, -1.295, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, fin_te, t=0.10)
    return mb.finish(sharp_angle=45)


def fin_le(z):
    Z = z - R.dz
    t = (Z - (STAB_Z + 0.05)) / (FIN_TOP - (STAB_Z + 0.05))
    x = lerp(-1.645, -1.824, max(0.0, t))
    if Z < STAB_Z + 0.08:                      # fillet into the tailplane
        x += 0.05 * ((STAB_Z + 0.08 - Z) / 0.11) ** 1.5
    return R.x(x)


def fin_te(z):
    return R.x(HINGE + 0.004)


def rud_te(z):
    Z = z - R.dz
    if Z > -1.95:
        x = lerp(-2.530, -2.254, (Z + 1.95) / (RUD_TOP + 1.95))
    else:
        x = lerp(-2.530, HINGE - 0.08, min(1.0, (-1.95 - Z) / 0.08) ** 0.8)
    return R.x(x)


def build_rudder():
    zs = [-2.030, -2.022, -2.0, -1.975, -1.95, -1.85, -1.70, -1.55, -1.42, -1.33, RUD_TOP]
    origin = R(HINGE, -1.66)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], lambda z: R.x(HINGE + 0.01), rud_te, R.x(HINGE),
                                 origin, t=0.10, mat='Paint_White')
    # ELA oval logo (top) and registration
    deco = MB('rud_deco')
    for sy in (1, -1):
        ring = []
        for k in range(40):
            a = TAU * k / 40
            ring.append(R(-2.13 + 0.115 * math.cos(a), -1.375 + 0.048 * math.sin(a), sy * 0.12))
        q = pilot.surface_path(rud, ring + [ring[0]], V(0, sy, 0), 0.0008, samples=1)
        if len(q) > 3:
            deco.tube(q, 0.0035, 'Paint_Dark', n=6)
    regs = E.build_registration(rud, REG, cx=R.x(-2.17) - origin.x, cz=R.z(-1.54) - origin.z, size=0.075,
                                mat='Paint_Dark')
    deco_ob = deco.finish(sharp_angle=60)
    for r in regs:
        r.location = r.location + origin
    B.join_objects('rudder', [rud, deco_ob] + regs)
    return rud


# ---------------------------------------------------------------------------
# Gear
# ---------------------------------------------------------------------------
def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # flat composite leg: wide chord at the pod, down and out to the spat
        rings = []
        for k in range(7):
            t = k / 6
            y = lerp(0.28, MAIN_Y - 0.06, t)
            z = lerp(-2.06, AXLE[1] + 0.12, t ** 1.1)
            le = lerp(-0.105, -0.17, t)
            te = lerp(-0.465, -0.40, t)
            c = le - te
            loop = airfoil_ring(12, 0.16, te_min=0.004)
            rings.append([R(le - s * c, z + tz * c, sy * y) for s, tz in loop])
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        # root fairing blending the leg into the sponson
        mb.sphere(R(-0.29, -2.10, sy * 0.33), 0.12, 'Paint_White', seg=20, rings=10, scale=(1.55, 0.35, 0.75))
        # axle, brake disc + calliper (inboard)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.072), ax.z), V(ax.x, sy * (MAIN_Y - 0.064), ax.z), 0.08, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.07, sy * (MAIN_Y - 0.068), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        sp = K.spat(name, c, R=MAIN_R, front=0.235, back=0.38, hw=0.115, top=0.03, lift=0.035, mat='Paint_White',
                    tail_up=0.035, cut=False, belly=0.35)
        # open front-lower quadrant and the slot under the wheel
        cm = MB('spatcut')
        cm.box((c.x + 0.16, c.y, c.z - 0.09), (0.34, 0.4, 0.30), 'Paint_White', bevel=0.05, segs=3)
        cm.box((c.x - 0.02, c.y, c.z - MAIN_R), (2 * MAIN_R * 0.98, 0.16, 2 * MAIN_R * 0.55), 'Paint_White', bevel=0.04,
               segs=3)
        B.boolean_cut_shell(sp, cm.finish(sharp_angle=80))
        spats.append(sp)
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=MAIN_R, w=0.11)
    nose = K.nose_gear(R(NOSE[0], NOSE[1]), R=NOSE_R, w=0.10, leg_top=R.z(-2.29), rake=-0.035,
                       fork_mat='Paint_White')
    # chin fairing ahead of the nose leg and the tow / step bar under the beak
    ch = MB('chin')
    x0, x1 = 1.95, 1.75
    rings = []
    for k in range(8):
        t = k / 7
        x = lerp(x0, x1, t)
        f = math.sin(math.pi * min(1.0, t * 1.15)) ** 0.5 if k < 7 else 0.15
        ring = []
        for j in range(16):
            a = TAU * j / 16
            ring.append(R(x, -2.27 + 0.045 * f * min(0.0, math.sin(a)) * 1.6 + 0.02 * max(0.0, math.sin(a)),
                          0.06 * f * math.cos(a)))
        rings.append(ring)
    ch.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    ch.tube(catmull([R(2.00, -2.24), R(2.04, -2.285), R(2.10, -2.295), R(2.19, -2.295)], 4), 0.009, 'Paint_White', n=8)
    return gear, spats, nose, ch.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
# Cockpit
# ---------------------------------------------------------------------------
def build_cockpit():
    mb = MB('cockpit')
    E.bucket_seat(mb, FRONT_HIP, FRONT_BACK, width=0.34, headrest=False, base=True)
    E.bucket_seat(mb, REAR_HIP, REAR_BACK, width=0.40, headrest=False, base=True)
    # side pockets beside the front seat
    for sy in (1, -1):
        mb.box(R(1.20, -2.05, sy * 0.29), (0.30, 0.03, 0.16), 'Interior', bevel=0.01, segs=1)
    # 4-point harnesses lying on both seats (seen when a seat is empty)
    for hip, back in ((FRONT_HIP, FRONT_BACK), (REAR_HIP, REAR_BACK)):
        b = math.radians(back)
        u = V(-math.sin(b), 0, math.cos(b))
        f = V(math.cos(b), 0, math.sin(b))
        face = hip - f * 0.13 + f * 0.04
        buckle = hip + f * 0.16 + V(0, 0, -0.035)
        for sy in (1, -1):
            top = face + u * 0.66 + V(0, sy * 0.07, 0) - f * 0.05
            pts = [top, face + u * 0.60 + V(0, sy * 0.07, 0), face + u * 0.35 + V(0, sy * 0.075, 0),
                   face + u * 0.12 + V(0, sy * 0.07, 0) + f * 0.02, buckle + V(-0.04, sy * 0.03, 0.03)]
            mb.tube(catmull(pts, 4), 0.0, 'Belt_Black', n=8, square=(0.045, 0.005, 6), cap=True)
            lap = [hip + V(-0.02, sy * 0.19, -0.03), hip + V(0.08, sy * 0.15, -0.035), buckle + V(0, sy * 0.04, 0.005)]
            mb.tube(catmull(lap, 4), 0.0, 'Belt_Black', n=8, square=(0.045, 0.005, 6), cap=True)
        mb.box(buckle, (0.06, 0.07, 0.02), 'Chrome', bevel=0.006, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


def decal(pod, text, cx, cz, size, ang_deg, mat):
    """E.build_registration with the text rotated in the side plane (both sides, mirror symmetric)."""
    obs = []
    for side in (1, -1):
        cu = bpy.data.curves.new('dec_txt', 'FONT')
        cu.body = text
        cu.size = size
        cu.align_x = 'CENTER'
        cu.align_y = 'CENTER'
        try:
            cu.fill_mode = 'BOTH'
            cu.shear = 0.25
        except Exception:
            pass
        tob = bpy.data.objects.new('dec_tmp', cu)
        bpy.context.scene.collection.objects.link(tob)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
        bpy.data.objects.remove(tob)
        bpy.data.curves.remove(cu)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        a = math.radians(ang_deg * side)
        for v in bm.verts:
            tx = v.co.x * math.cos(a) - v.co.y * math.sin(a)
            ty = v.co.x * math.sin(a) + v.co.y * math.cos(a)
            wx, wz = (cx - tx, cz + ty) if side > 0 else (cx + tx, cz + ty)
            hit, loc, nrm, idx = pod.ray_cast(V(wx, side * 1.0, wz), V(0, -side, 0))
            v.co = loc + nrm.normalized() * 0.0018 if hit else V(wx, side * 0.3, wz)
        bm.normal_update()
        for f in bm.faces:
            if f.normal.y * side < 0:
                f.normal_flip()
            f.smooth = False
        me2 = bpy.data.meshes.new('decal_' + ('L' if side > 0 else 'R'))
        bm.to_mesh(me2)
        bm.free()
        bpy.data.meshes.remove(me)
        me2.materials.append(MATS[mat])
        ob = bpy.data.objects.new(me2.name, me2)
        B.link(ob)
        obs.append(ob)
    return obs


def clearance(a_names, b_objs, label=''):
    """K.clearance, also printing where the crossings are (hub frame) to place the crew."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()

    def tree(o):
        bm = bmesh.new()
        bm.from_object(o, dg)
        bm.transform(o.matrix_world)
        bm.faces.ensure_lookup_table()
        return BVHTree.FromBMesh(bm), bm
    bt = [(o.name, tree(o)) for o in b_objs if o is not None]
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH' or not any(o.name.startswith(n) for n in a_names):
            continue
        ta, bma = tree(o)
        for bn, (tb, _bmb) in bt:
            hits = ta.overlap(tb)
            if hits:
                cs = [bma.faces[i].calc_center_median() for i, _j in hits]
                lo = Vector((min(c.x for c in cs), min(c.y for c in cs), min(c.z for c in cs)))
                hi = Vector((max(c.x for c in cs), max(c.y for c in cs), max(c.z for c in cs)))
                print('  !! clearance%s: %s crosses %s (%d) X %.2f..%.2f y %.2f..%.2f Z %.2f..%.2f' % (
                    label, o.name, bn, len(hits), lo.x - R.dx, hi.x - R.dx, lo.y, hi.y, lo.z - R.dz, hi.z - R.dz))


def build_scorpion():
    ensure_mats()
    pod, rim = build_pod()
    bh = bulkheads()
    lines = panel_lines(pod)
    ws1, fr1, _rows = front_screen()
    ws2, fr2 = rear_screen()
    mast = build_mast()
    K.build_head(PIVOT, HUB, arm=-0.19, arm_w=0.26, plate_mat='Paint_White')
    K.build_rotor(HUB, R=4.25, chord=0.22, root=0.50, tip_mat='Rotor_Blade', clamp_len=0.48, clamp_mat='Alu_Black')
    engine = build_engine(PROP)
    K.build_prop(PROP, R=PROP_R, blades=3, hub='spinner', hub_r=0.105, hub_len=0.25, mat='Carbon', tip_mat='Carbon',
                 spinner_mat='Paint_White', pitch=1.0)
    keel = build_keel()
    tail = build_tail()
    build_rudder()
    gear, spats, nose, chin = build_gear()
    cockpit = build_cockpit()
    hood = build_hood_details()

    ctrl = MB('controls_static')
    stick_base = R(1.33, -2.255)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.345, -1.66))
    knob, lever = controls.throttle_lever(ctrl, R(1.16, -1.83, 0.27))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.895, -2.13, 0.10), 'R': R(1.895, -2.13, -0.10)}, knee_out=0.03, elbow_out=0.04,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.256))
    p0 = R(1.665, -1.80)
    _pf, _F, _poly = PANEL.build_panel(ctrl, p0, 18.0, [pod, ws1], zone=(0.0, 0.045, 0.34, 0.14), cw=0.04, v_leg=-0.03,
                      v_sb=-0.30, v_b=-0.34, top_arch=(0.27, 0.08, 0.20), max_u=0.25, leg_exp=0.25)
    print('  panel outline top:', [(round(u, 3), round(v, 3)) for u, v in _poly if v > 0.0 and abs(u) < 0.3][::4])
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.24, -0.16, 0.17), None),
                             'L': ('rest', REAR_HIP + V(0.24, 0.16, 0.17), None)},
                      feet={'L': R(1.04, -2.10, 0.255), 'R': R(1.04, -2.10, -0.255)}, knee_out=0.06, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    det = MB('details')
    lglass = MB('lamp_glass')
    # nav + strobe: the chrome teardrop units on the pod sides under the "07-Scorpion" decal (side photo
    # 962..996 / 838 px; close-ups scorpion-descripcion, purple pod side): PowerBurst-type, clear lens on a
    # chrome reflector, blunt end forward, LED strip inside
    for sy in (1, -1):
        X, Z = 0.003, -1.785
        q = project(pod, [(R(X, Z, sy * pod_y(X, Z)), V(0, sy, 0))], 0.0)
        if not q:
            print('!! side lamp: no hit', sy)
            continue
        q = q[0]
        _ok, _l, nl, _i = pod.ray_cast(pod.matrix_world.inverted() @ (q + V(0, sy * 0.3, 0)), V(0, -sy, 0))
        nw = (pod.matrix_world.to_3x3() @ nl).normalized()
        if nw.y * sy < 0:
            nw = -nw
        fwd = (V(1, 0, 0) - nw * nw.x).normalized()
        up = nw.cross(fwd).normalized()

        def ring(s, h, q=q, nw=nw, fwd=fwd, up=up):
            out = []
            for k in range(24):
                a = TAU * k / 24
                out.append(q + nw * h + fwd * (0.5 * 0.112 * s * math.cos(a)) +
                           up * (0.015 / 0.77 * s * math.sin(a) * math.sqrt(max(0.0, 0.5 * (1 + math.cos(a))))))
            return out
        det.loft([ring(1.06, -0.002), ring(1.06, 0.003), ring(0.98, 0.004)], 'Chrome', closed=True, cap1=True)
        c = q + nw * 0.0045
        det.box(c + fwd * 0.030, (0.022, 0.004, 0.010), 'Lens_Red' if sy > 0 else 'Lens_Green', bevel=0.002, segs=1)
        det.box(c - fwd * 0.012, (0.042, 0.004, 0.005), 'Lens_White', bevel=0.0015, segs=1)
        lglass.loft([ring(1.0, 0.003), ring(0.96, 0.009), ring(0.82, 0.013), ring(0.5, 0.016), [q + nw * 0.017]],
                    'Glass', closed=True)
        K.lamp_node('navL' if sy > 0 else 'navR', c + fwd * 0.030 + nw * 0.025)
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', c - fwd * 0.012 + nw * 0.025)
    # landing light: round chrome-rimmed lamp in the blunt front of the chin fairing under the beak, ahead
    # of the nose wheel (front_three_quarter_right_purple_1: 505/330 px)
    lp = R(1.953, -2.282)
    det.lathe([(0.0, -0.03), (0.026, -0.03), (0.027, 0.002), (0.024, 0.006), (0.019, 0.004)], lp, V(1, 0, 0),
              'Chrome', n=24)
    det.lathe([(0.0, 0.0), (0.020, 0.0), (0.017, 0.006), (0.0, 0.008)], lp, V(1, 0, 0), 'Lens_White', n=24)
    K.lamp_node('landing', lp + V(0.03, 0, 0))
    # strobe in the mast: clear dome at the aft end of the cross bar (side photo 905/436 px)
    K.lamp_node('beacon', R(-0.27, -0.385))
    # hatch latches (sponson) and the door latch tab
    for sy in (1, -1):
        X, Z = 0.86, -2.225
        p = R(X, Z, sy * (pod_y(X, Z) - 0.004))
        det.cyl(p, p + V(0, sy * 0.016, 0), 0.016, 'Paint_Dark', n=14)
        X, Z = 1.52, -1.95
        p = R(X, Z, sy * (pod_y(X, Z) - 0.004))
        det.box(p + V(0, sy * 0.006, 0), (0.035, 0.012, 0.03), 'Paint_Dark', bevel=0.004, segs=1)
    # ELA oval badge on the nose deck
    ring = [(R(1.70 + 0.03 * math.cos(TAU * k / 32), -1.45, 0.07 * math.sin(TAU * k / 32)), V(0, 0, 1))
            for k in range(33)]
    q = project(pod, ring, 0.0008)
    if len(q) > 3:
        det.tube(q, 0.003, 'Paint_Dark', n=6)
    del ring
    det = det.finish(sharp_angle=50)
    lglass = lglass.finish(sharp_angle=60)
    scorp = decal(pod, '07-Scorpion', R.x(0.045), R.z(-1.715), 0.058, 28.0, 'Paint_Dark')

    S = FRONT_HIP + V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK))) * pilot.SPINE
    u = V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK)))
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    clearance(['pilot_front_leg', 'pilot_front_foot'], [bpy.data.objects.get('panel_face'), ctrl, pod], ' (front)')
    clearance(['pilot_front'], [pod, cockpit] + bh, ' (front body)')
    clearance(['pilot_rear'], [pod, cockpit] + bh, ' (rear)')
    K.finalize([pod, rim, fr1, fr2, mast, engine, keel, tail, gear, cockpit, ctrl, det, lines, chin, hood] + bh +
               spats + scorp, [ws1, ws2, lglass])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.66), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })
    print('SCORPION hub %s pivot %s prop %s ground z %.3f axle x %.3f nose x %.3f eye %s' % (
        tuple(round(c, 3) for c in HUB), tuple(round(c, 3) for c in PIVOT), tuple(round(c, 3) for c in PROP),
        R.z(GROUND), ax.x, R.x(NOSE[0]), tuple(round(c, 3) for c in eye)))


if __name__ == '__main__':
    VIEWS = {
        # same angles as the reference photos (for side-by-side checks)
        # same side and height as the factory photo three_quarter_front_left_high_1 (camera front-RIGHT)
        'boom_fin': dict(extra=True, loc=(4.33, -5.69, 2.03), target=(-1.12, 0.0, -0.50), lens=200, rotor=-35, prop=10),
        'cmp_cutout': dict(extra=True, loc=(5.6, -3.9, 0.9), target=(-0.3, 0.0, 0.25), lens=30, rotor=-20, prop=10),
        'cmp_high': dict(extra=True, loc=(5.0, -7.0, 6.2), target=(-0.3, 0.0, -0.3), lens=40, rotor=-35, prop=10),
        'cmp_front': dict(extra=True, loc=(9.5, 0.0, -0.45), target=(0.0, 0.0, 0.15), lens=70, rotor=90, prop=0),
        'gear_detail': dict(extra=True, loc=(1.2, -3.2, 0.2), target=(-0.55, -0.5, -0.65), lens=45, rotor=75, prop=10),
        'cmp_rear': dict(extra=True, loc=(-6.0, 3.6, -0.45), target=(-0.8, 0.0, 0.0), lens=35, rotor=-30, prop=10),
        # lamps close up: side nav/strobe unit, landing light in the chin, strobe on the mast cross bar
        'lamp_side': dict(extra=True, loc=tuple(R(0.35, -1.65, 1.25)), target=tuple(R(0.003, -1.785, 0.35)), lens=60,
                          rotor=75, prop=10),
        'lamp_chin': dict(extra=True, loc=tuple(R(3.0, -2.15, -0.75)), target=tuple(R(1.93, -2.27, 0.0)), lens=85,
                          rotor=75, prop=10),
        'lamp_mast': dict(extra=True, loc=tuple(R(-0.25, -0.20, 1.6)), target=tuple(R(-0.15, -0.40, 0.0)), lens=50,
                          rotor=75, prop=10),
    }
    K.run('scorpion', build_scorpion, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
