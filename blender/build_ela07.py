"""
ELA 07 Cougar (ELA Aviacion, Cordoba; the open "sport line" ELA 07) for the Autogiro web sim: one-piece
open tandem pod with a long pointed beak and a side crease, two windscreens (a tall raked front one
with a black lower frame, a short one on the body-coloured front-seat-back divider), open back whose
side walls rise into two horns round the mast, uncowled Rotax 912 ULS (red valve covers, carbs with K&N
filters, oil tank, coolant bottle, radiator, belt pre-rotator drive), Helix three-blader, flat tapered
body-coloured mast with the two grey push rods behind it, bare grey tubular main legs on big tundra
tyres, nose wheel in a keel fairing, tube truss (flat upper strut + lower bar + gusset) and single bar
up to the high tail: swept tailplane whose tips turn up into canted end plates, swept fin, big rudder.

Traced (hub frame, see gyrokit.py) on the ELA factory photo "High-Tail.jpg" (elaaviacion.com Cougar page,
1900 px, pure left side at lift-off), levelled by rotating it 14 deg about the teeter bolt (the angle that
puts nose and main tyre bottoms on one line, as when parked; checked on the parked "Descripcion.jpg").
Scale 160 px/m: propeller tip 135 px above the hub (R 0.86 m, 1.72 m Helix), checked with the 5.07 m
overall length of the ELA 07 maintenance manual (799 px / cos(yaw)) and the pilots' helmets. Camera yaw
+8.8 deg (far main wheel 37 px towards the nose; track 1.56 m). Widths from the 0.75 m pod ("careenage
width", maintenance manual) and the factory 3/4 photos (Cougar.jpg, 21.jpg).

  blender -b -P blender/build_ela07.py -- [--previews] [--only VIEW,...] [--show-rear]
                                           [--overlay yaw,cx,cz,ppm,w,h[,side]]
Outputs: public/models/ela07.glb, blender/ela07.blend, blender/previews/ela07/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- photo -> hub frame ------------------------------------------------------------------------
PPM = 160.0                          # px per metre on the levelled High-Tail photo
YAW = 8.8                            # camera ahead of the pure side view (deg)
HUB_PX = (1143.0, 372.0)             # teeter bolt (rotation centre of the levelling)
SY = math.sin(math.radians(YAW))


def H(x, y, side_y=0.0):
    """Levelled photo pixel -> hub frame (X, Z). side_y: lateral position of the traced point (near
    side > 0), whose image is shifted aft by side_y * sin(yaw)."""
    xs = (HUB_PX[0] - x) / PPM
    return ((xs + side_y * SY) / math.cos(math.radians(YAW)), (HUB_PX[1] - y) / PPM)


GROUND = -2.813                      # tyre bottoms (y 822.5 px)
MAIN_R = 0.244                       # 21x8-8 class tundra tyres (78 px)
MAIN_W = 0.19
AXLE = (-0.313, GROUND + MAIN_R)     # both wheels: near x 1211, far x 1174, y 783
MAIN_Y = 0.78                        # half track
NOSE_R = 0.19
NOSE = (1.570, GROUND + NOSE_R)      # nose wheel x 895 px
# CG: sim convention 0.33 m ahead of the hub; height 0.85 m above the main axle (no published limits)
CG = (0.33, AXLE[1] + 0.85)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.206)
PROP = R(-0.994, -1.456)
PROP_R = 0.86

LIVERY = dict(body=('#F5B400', 0.0, 0.16), accent=('#C41E1E', 0.1, 0.30), dark=('#18191C', 0.25, 0.32),
              seat=('#121315', 0.0, 0.75))
REG = 'EC-CUG'


def ensure_mats():
    for name, col, kw in (('Rotax_Red', '#B5121B', dict(metal=0.3, rough=0.35)),
                          ('Hose_Red', '#C8281E', dict(rough=0.5)),
                          ('Leg_Grey', '#7E8179', dict(metal=0.6, rough=0.45)),
                          ('Rod_Grey', '#9A9EA3', dict(metal=0.7, rough=0.35)),
                          ('Filter_Red', '#7A1016', dict(rough=0.7)),
                          ('Bottle_White', '#E9E6DA', dict(rough=0.4)),
                          ('Belt_Black', '#1C1D20', dict(rough=0.8)),
                          ('Alu_Bright', '#C9CCCF', dict(metal=1.0, rough=0.25))):
        if name not in MATS:
            B.make_mat(name, B.srgb(col), **kw)


# ---- pod: stations (X, top, shoulder z, shoulder half-width, crease z, crease half-width, bottom) ----
# The crease is the sharp horizontal ridge along the side (widest line); below it the hull tucks in
# to a narrow rounded keel.
ROWS = [
    (2.42, -2.050, -2.090, 0.085, -2.170, 0.100, -2.225),
    (2.17, -1.963, -2.025, 0.175, -2.190, 0.200, -2.288),
    (1.92, -1.844, -1.945, 0.245, -2.225, 0.275, -2.345),
    (1.86, -1.770, -1.920, 0.262, -2.235, 0.292, -2.358),
    (1.81, -1.650, -1.905, 0.275, -2.240, 0.305, -2.368),
    (1.76, -1.580, -1.895, 0.288, -2.245, 0.316, -2.378),
    (1.55, -1.550, -1.885, 0.318, -2.245, 0.345, -2.398),
    (1.30, -1.520, -1.880, 0.338, -2.230, 0.362, -2.405),
    (1.00, -1.450, -1.860, 0.348, -2.200, 0.373, -2.396),
    (0.82, -1.330, -1.840, 0.350, -2.180, 0.375, -2.385),
    (0.68, -1.300, -1.840, 0.350, -2.165, 0.375, -2.378),
    (0.55, -1.340, -1.840, 0.348, -2.155, 0.373, -2.372),
    (0.30, -1.500, -1.800, 0.343, -2.140, 0.368, -2.360),
    (0.05, -1.480, -1.640, 0.330, -2.125, 0.355, -2.346),
    (-0.12, -1.430, -1.560, 0.315, -2.120, 0.340, -2.341),
    (-0.27, -1.400, -1.500, 0.300, -2.120, 0.325, -2.338),
]
NTS = [2.2, 2.3, 2.4, 2.4, 2.4, 2.4, 2.4, 2.4, 2.2, 2.0, 2.0, 2.0, 2.2, 2.2, 2.2, 2.2]


class Pod(E.Fuselage):
    """Stationed fuselage with a per-station top exponent (round divider top, round nose deck)."""

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


POD = Pod(R.table(ROWS), NTS, tip=(R.x(2.544), R.z(-2.156)), nt=2.2, nb=1.7, bow=0.0, chine_sharp=True,
          linear_nose=True, nose_exp=0.45)

# ---- openings (side view, hub frame; near-side edges corrected for the yaw shift) ----
WS_BASE_C = (1.790, -1.590)          # front windscreen base on the deck centreline
WS_BASE_S = (1.620, -1.956)          # ... and at the sill
SILL_F = [WS_BASE_S, (1.460, -2.000), (1.260, -2.010), (1.005, -1.975), (0.880, -1.894)]
HUMP_FRONT = [(0.880, -1.894), (0.840, -1.830), (0.800, -1.610), (0.760, -1.420), (0.735, -1.350)]
HUMP_REAR = [(0.630, -1.360), (0.645, -1.490), (0.680, -1.610), (0.725, -1.770), (0.710, -1.850)]
SILL_R = [(0.710, -1.850), (0.575, -1.875), (0.320, -1.788), (0.130, -1.706), (0.005, -1.612),
          (-0.120, -1.500), (-0.215, -1.410), (-0.250, -1.398)]
OPEN_FRONT = SILL_F + HUMP_FRONT[1:] + [(0.735, 0.0), (1.790, 0.0), WS_BASE_C, (1.700, -1.780)]
OPEN_REAR = HUMP_REAR + SILL_R[1:] + [(-0.250, 0.0), (0.630, 0.0)]
# open back: the side walls end on a curve from the horn tops down to the bottom rear corner
REAR_EDGE = [(-0.250, -1.398), (-0.257, -1.456), (-0.190, -1.550), (-0.130, -1.675), (-0.065, -1.800),
             (-0.050, -1.925), (-0.020, -2.175), (0.000, -2.338)]
OPEN_BAY = REAR_EDGE + [(0.000, -2.70), (-0.70, -2.70), (-0.70, 0.0), (-0.250, 0.0)]
X_FIREWALL = -0.035

FRONT_HIP = R(1.200, -1.990)
REAR_HIP = R(0.480, -1.930)
FRONT_BACK, REAR_BACK = 22.0, 26.0


def pod_y(X, Z):
    """Half-width of the pod envelope at hub-frame (X, Z)."""
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


def build_pod():
    pod = POD.shell('pod', step=0.03, n_half=40, rear=())
    rim = K.cut_polys(pod, [R.pts(OPEN_FRONT), R.pts(OPEN_REAR), R.pts(OPEN_BAY)], rim_r=0.011,
                      rim_mat='Paint_White', thickness=0.010)
    return pod, rim


def bulkheads():
    """Faces of the front-seat-back divider (front, under the screen hump, rear), the firewall behind
    the rear seat and the floors."""
    mb = MB('bulkheads')
    for line, inset, zmin, narrow in ((HUMP_FRONT, -0.012, -2.30, 0.012), (HUMP_REAR, 0.012, -2.30, 0.012)):
        pts = [p for p in catmull([Vector((x, 0, z)) for x, z in line], 4)]
        # continue the face down to the floor
        last = pts[-1]
        pts += [Vector((last.x, 0, lerp(last.z, zmin, k / 4))) for k in range(1, 5)]
        rows = []
        for p in pts:
            X, Z = p.x, p.z
            w = max(0.0, pod_y(X + inset, Z) - narrow)
            if Z < -1.62:
                w = min(w, 0.13)
            rows.append([R(X + inset, Z, -w), R(X + inset, Z, w)])
        for a, b in zip(rows, rows[1:]):
            mb.faces([a[0], a[1], b[1], b[0]], [[0, 1, 2, 3]], 'Interior', smooth=False)
    # firewall behind the rear seat: from the floor up to the sill
    zs = [lerp(-2.32, -1.62, k / 10) for k in range(11)]
    rows = [[R(X_FIREWALL, z, -max(0.0, pod_y(X_FIREWALL, z) - 0.012)),
             R(X_FIREWALL, z, max(0.0, pod_y(X_FIREWALL, z) - 0.012))] for z in zs]
    for a, b in zip(rows, rows[1:]):
        mb.faces([a[0], a[1], b[1], b[0]], [[0, 1, 2, 3]], 'Interior', smooth=False)
    # floors (front and rear cockpit)
    mb.box(R(1.45, -2.335), (0.95, 0.40, 0.012), 'Interior', bevel=0.0)
    mb.box(R(0.60, -2.315), (1.15, 0.50, 0.012), 'Interior', bevel=0.0)
    return mb.finish(sharp_angle=80)


def surface_line(mb, target, pts, n, r=0.0022, mat='Paint_Dark', samples=6):
    q = pilot.surface_path(target, pts, n, 0.0005, samples=samples)
    if len(q) >= 2:
        mb.tube(q, r, mat, n=6, cap=True)


def project(target, pts_dirs, off):
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
    """Screw rows along the sills (the pod is one moulding; inspection screws show as dots) and the
    small access panel ahead of the rear wheel well."""
    mb = MB('panel_lines')
    for sy in (1, -1):
        for X, Z in ((1.40, -2.06), (1.10, -2.05), (0.80, -2.00), (0.55, -1.93), (0.30, -1.85), (0.10, -1.77),
                     (-0.05, -1.68), (0.95, -2.25), (0.45, -2.20), (0.05, -2.19)):
            q = project(pod, [(R(X, Z, sy * 0.3), V(0, sy, 0))], 0.0)
            if q:
                mb.cyl(q[0] - V(0, sy * 0.001, 0), q[0] + V(0, sy * 0.0025, 0), 0.0045, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=60)


# ---------------------------------------------------------------------------
# Windscreens
# ---------------------------------------------------------------------------
def dome_screen(name, base_c, tip, side_path, nu=28, nv=16, smoke=0.0, bulge=0.03, frame=0.010):
    """Wrap-round screen: centreline from base_c to tip (hub frame (X, Z)); side edges follow
    side_path(v) -> (X, Z, w); every row is an arc from side to side through the centreline."""
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
    clear = []
    for j in range(nv):
        for i in range(nu):
            a = j * W + i
            clear.append([a, a + 1, a + W + 1, a + W])
    mb.faces(coords, clear, 'Glass')
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
    fr.tube(rows[0], frame, 'Paint_Dark', n=8)
    if smoke > 0:
        # black frame strip along the lower side edges (the screen sits in a black moulding)
        for side in (0, nu):
            pts = [rows[j][side] for j in range(nv + 1) if (rows[j][side].z - rows[0][side].z) < smoke]
            if len(pts) > 1:
                fr.tube(pts, 0.0, 'Paint_Dark', n=8, square=(0.045, 0.012, 4), cap=True)
    return ob, fr.finish(sharp_angle=60), rows


def front_screen():
    tip = (1.487, -1.225)            # x 908, y 568 px

    def side(v):
        # side edge: from the sill up the cockpit side, then raked in to the rounded top
        if v < 0.40:
            t = v / 0.40
            x, z = lerp(WS_BASE_S[0], 1.600, t), lerp(WS_BASE_S[1], -1.700, t)
        else:
            t = (v - 0.40) / 0.60
            x, z = lerp(1.600, tip[0] + 0.015, t ** 0.9), lerp(-1.700, tip[1] - 0.012, t)
        w = 0.318 * (1 - max(0.0, v - 0.25) ** 2.2 / 0.75 ** 2.2) ** 0.55 if v < 1 else 0.0
        return x, z, max(w, 0.0)
    ob, fr, rows = dome_screen('ws_front', WS_BASE_C, tip, side, smoke=0.30, bulge=0.035)
    return ob, fr


def rear_screen():
    base = (0.690, -1.318)
    tip = (0.513, -1.050)            # x 1062, y 540 px

    def side(v):
        x, z = lerp(0.655, tip[0] + 0.012, v), lerp(-1.440, tip[1] - 0.006, v)
        w = 0.225 * (1 - v ** 2.4) ** 0.5 if v < 1 else 0.0
        return x, z, w
    ob, fr, rows = dome_screen('ws_rear', base, tip, side, nu=22, nv=12, bulge=0.012, frame=0.008)
    return ob, fr


# ---------------------------------------------------------------------------
# Mast, head, pre-rotator drive
# ---------------------------------------------------------------------------
MAST_TOP = (0.000, -0.375)            # x 1143, y 432 (top of the yellow mast, under the cheek plates)
MAST_BASE = (-0.184, -1.360)          # x 1172, y 590 (between the pod horns)
MAST_FOOT = (-0.225, -2.360)          # on the keel (hidden in the bay)


def build_mast():
    """Flat body-coloured mast tapering towards the head (0.075 m at the top, 0.11 m at the pod), grey
    cheek plates and cross plate at the head, two grey push rods behind it, the pre-rotator: belt from a
    pulley on the prop flange, shaft forward over the engine, right-angle box at the mast and the
    flexible shaft (with its rubber boot) up behind the mast to the Bendix."""
    mb = MB('mast')
    top, base, foot = R(*MAST_TOP), R(*MAST_BASE), R(*MAST_FOOT)
    pts = catmull([top, R(-0.09, -0.86), base, R(-0.205, -1.86), foot], 4)
    n = len(pts)
    for i in range(n - 1):
        a, b = pts[i], pts[i + 1]
        t = i / (n - 1)
        wa = lerp(0.075, 0.115, min(1.0, t * 1.6))
        wb = lerp(0.075, 0.115, min(1.0, (i + 1) / (n - 1) * 1.6))
        mb.tube([a, b], 0.0, 'Paint_White', n=16, square=((wa + wb) * 0.5, 0.060, 6), cap=True)
    # cheek plates up to the pitch pivot + bolts
    for sy in (1, -1):
        mb.box(PIVOT + V(-0.010, sy * 0.038, -0.085), (0.13, 0.010, 0.20), 'Metal_Frame', bevel=0.012, segs=2,
               rot=K.rot_y(-6))
        mb.cyl(PIVOT + V(0, sy * 0.034, 0), PIVOT + V(0, sy * 0.056, 0), 0.016, 'Engine', n=12)
        mb.cyl(top + V(0.0, sy * 0.044, 0.04), top + V(0.0, sy * 0.05, 0.04), 0.009, 'Metal_Frame', n=8)
    # cross plate at the mast top (x 1130-1170, y 432) with the rod guides
    mb.box(R(-0.06, -0.38), (0.16, 0.10, 0.012), 'Metal_Frame', bevel=0.004, segs=1)
    # push rods either side behind the mast, from the bellcranks between the horns to the head arm
    for sy in (1, -1):
        lo = R(-0.235, -1.30, sy * 0.12)
        hi = PIVOT + V(-0.16, sy * 0.12, 0.022)
        mb.cyl(lo, hi, 0.0085, 'Rod_Grey', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.035), 0.012, 'Alu_Black', n=8)
        mb.cyl(lo, lo + V(0, 0, -0.06), 0.013, 'Alu_Black', n=8)
        mb.box(lo + V(0.02, 0, -0.08), (0.10, 0.012, 0.08), 'Metal_Frame', bevel=0.004, segs=1)
    # pneumatic trim / brake cylinder + hose down the mast
    mb.cyl(R(-0.075, -0.52), R(-0.075, -0.40), 0.016, 'Alu_Bright', n=12)
    mb.cyl(R(-0.075, -0.40), R(-0.075, -0.30), 0.007, 'Chrome', n=8)
    mb.tube(catmull([R(-0.08, -0.52), R(-0.10, -0.80), R(-0.13, -1.10), R(-0.17, -1.32)], 5), 0.005, 'Rubber', n=6)
    # pre-rotator: right-angle box on the mast at the pod top, flexible shaft with boot up to the Bendix
    box_c = R(-0.245, -1.29)
    mb.box(box_c, (0.09, 0.08, 0.09), 'Alu_Bright', bevel=0.012, segs=2)
    mb.tube(catmull([box_c + V(0.0, 0, 0.045), R(-0.215, -1.0), R(-0.175, -0.62), PIVOT + V(-0.137, 0, -0.07)], 5),
            0.008, 'Rod_Grey', n=8)
    mb.lathe([(0.0, 0.0), (0.020, 0.0), (0.024, 0.03), (0.018, 0.06), (0.024, 0.09), (0.018, 0.12), (0.012, 0.15),
              (0.0, 0.15)], box_c + V(0.0, 0, 0.045), V(0.1, 0, 1), 'Rubber', n=14)
    # horizontal shaft over the engine to the upper pulley (y 578 px), universal joint at the box
    z_sh = -1.290
    mb.cyl(R(-0.29, z_sh), R(-0.905, z_sh), 0.013, 'Chrome', n=12)
    mb.box(R(-0.30, z_sh), (0.05, 0.04, 0.04), 'Metal_Frame', bevel=0.008, segs=1)
    # belt drive at the prop flange: big pulley on the prop shaft (behind the prop), small one above,
    # tensioner spring, belt
    px = PROP.x - R.dx + 0.075
    mb.lathe([(0.0, -0.022), (0.11, -0.022), (0.11, 0.022), (0.0, 0.022)], R(px, -1.456), V(1, 0, 0), 'Engine_Dark',
             n=32)
    mb.lathe([(0.0, -0.022), (0.05, -0.022), (0.05, 0.022), (0.0, 0.022)], R(px, z_sh), V(1, 0, 0), 'Engine_Dark',
             n=20)
    for sy in (1, -1):
        mb.box(R(px, (z_sh - 1.456) * 0.5, sy * 0.085), (0.04, 0.010, 0.17), 'Belt_Black')
    mb.box(R(px + 0.03, z_sh + 0.01, 0.0), (0.03, 0.06, 0.09), 'Metal_Frame', bevel=0.005, segs=1)
    mb.cyl(R(px + 0.05, z_sh - 0.02, -0.07), R(px + 0.03, -1.40, -0.16), 0.008, 'Chrome', n=8)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotax 912 ULS (written for the Cougar's open bay: crank 0.12 m under the prop shaft, red valve
# covers, two carbs with K&N pod filters, oil tank, coolant bottle, radiator, exhaust and muffler)
# ---------------------------------------------------------------------------
def build_engine(P):
    mb = MB('engine')
    P = Vector(P)

    def Q(dx, y, dz):
        return P + V(dx, y, dz)
    zc = -0.12
    mb.box(Q(0.33, 0, zc), (0.34, 0.22, 0.24), 'Engine', bevel=0.04, segs=3)               # crankcase
    mb.box(Q(0.33, 0, zc - 0.13), (0.30, 0.18, 0.06), 'Engine_Dark', bevel=0.02, segs=2)   # oil pan
    for sy, xs in ((1, (0.22, 0.40)), (-1, (0.26, 0.44))):
        for x in xs:
            mb.lathe(B.finned_profile(0.050, 0.064, 0.105, 0.225), Q(x, 0, zc), V(0, sy, 0), 'Engine', n=20)
            mb.box(Q(x, sy * 0.258, zc), (0.12, 0.06, 0.13), 'Engine', bevel=0.016, segs=2)
            mb.box(Q(x, sy * 0.298, zc + 0.005), (0.11, 0.028, 0.105), 'Rotax_Red', bevel=0.013, segs=2)
            mb.cyl(Q(x + 0.03, sy * 0.30, zc + 0.05), Q(x + 0.03, sy * 0.33, zc + 0.09), 0.008, 'Paint_Dark', n=8)
            # exhaust headers down under the engine
            mb.tube(catmull([Q(x, sy * 0.27, zc - 0.07), Q(x, sy * 0.27, zc - 0.15), Q(x - 0.05, sy * 0.19, zc - 0.22),
                             Q(0.12, sy * 0.06, -0.28)], 4), 0.018, 'Steel_Exhaust', n=10, cap=True)
        # coolant hoses (red) from the heads to the radiator
        mb.tube(catmull([Q(0.46, sy * 0.25, zc + 0.08), Q(0.33, sy * 0.24, zc + 0.11), Q(0.18, sy * 0.16, zc - 0.02),
                         Q(0.12, sy * 0.10, -0.22)], 5), 0.014, 'Hose_Red', n=8)
        # intake manifolds and the two carbs on the top, K&N pod filters
        mb.tube(catmull([Q(0.33, sy * 0.06, 0.08), Q(0.33, sy * 0.14, 0.10), Q(0.33, sy * 0.20, 0.05),
                         Q(0.33, sy * 0.25, zc + 0.08)], 4), 0.018, 'Alu_Bright', n=10)
        mb.cyl(Q(0.33, sy * 0.06, 0.08), Q(0.33, sy * 0.0, 0.08), 0.03, 'Engine', n=12)
        mb.cyl(Q(0.42, sy * 0.10, 0.06), Q(0.52, sy * 0.12, 0.02), 0.032, 'Alu_Bright', n=14)
        mb.cyl(Q(0.42, sy * 0.10, 0.01), Q(0.42, sy * 0.10, -0.04), 0.030, 'Engine', n=14)      # float bowl
        mb.lathe([(0.0, 0.0), (0.040, 0.0), (0.045, 0.012), (0.045, 0.10), (0.040, 0.11), (0.0, 0.11)],
                 Q(0.52, sy * 0.12, 0.02), V(1, sy * 0.4, -0.5), 'Filter_Red', n=18)
    # balance tube / airbox over the crankcase
    mb.box(Q(0.33, 0, 0.12), (0.22, 0.14, 0.06), 'Engine_Dark', bevel=0.02, segs=2)
    # gearbox round the prop shaft, down to the crankcase
    mb.box(Q(0.11, 0, -0.05), (0.10, 0.19, 0.24), 'Engine', bevel=0.04, segs=3)
    mb.lathe([(0.0, 0.16), (0.085, 0.16), (0.090, 0.13), (0.080, 0.08), (0.055, 0.05), (0.0, 0.05)],
             P, V(1, 0, 0), 'Engine', n=28)
    # starter, ignition housing, alternator cover
    mb.cyl(Q(0.47, -0.10, -0.22), Q(0.36, -0.10, -0.22), 0.040, 'Engine_Dark', n=16)
    mb.cyl(Q(0.50, 0.0, zc), Q(0.53, 0.0, zc), 0.09, 'Engine_Dark', n=24)
    # stainless muffler under the gearbox, tail pipe
    mb.lathe([(0.0, -0.11), (0.05, -0.11), (0.058, -0.09), (0.058, 0.09), (0.05, 0.11), (0.0, 0.11)],
             Q(0.10, 0.0, -0.32), V(0, 1, 0), 'Steel_Exhaust', n=20)
    mb.tube(catmull([Q(0.02, -0.06, -0.34), Q(-0.04, -0.07, -0.38), Q(-0.07, -0.07, -0.41)], 4), 0.02,
            'Steel_Exhaust', n=10, cap=True)
    # coolant expansion bottle (white, red cap) on its body-colour bracket above the gearbox
    mb.box(Q(0.13, 0.03, 0.17), (0.09, 0.012, 0.10), 'Paint_White', bevel=0.004, segs=1)
    mb.box(Q(0.13, -0.03, 0.17), (0.07, 0.10, 0.09), 'Bottle_White', bevel=0.02, segs=2)
    mb.cyl(Q(0.13, -0.03, 0.215), Q(0.13, -0.03, 0.245), 0.018, 'Lens_Red', n=12)
    # oil tank (tall alu can at the front left of the bay) with its hoses
    ot = Q(0.66, 0.20, -0.58)
    mb.cyl(ot, ot + V(0, 0, 0.24), 0.055, 'Alu_Bright', n=20)
    mb.cyl(ot + V(0, 0, 0.24), ot + V(0, 0, 0.26), 0.03, 'Paint_Dark', n=12)
    mb.tube(catmull([ot + V(0, -0.03, 0.22), Q(0.56, 0.12, -0.25), Q(0.45, 0.06, zc - 0.10)], 4), 0.009, 'Rubber', n=6)
    # radiator: alu core on the left behind the engine, under the prop shaft
    rc = Q(0.13, 0.20, -0.30)
    mb.box(rc, (0.24, 0.06, 0.26), 'Alu_Bright', bevel=0.006, segs=1)
    mb.box(rc + V(0, 0.032, 0), (0.21, 0.004, 0.23), 'Radiator')
    for k in range(9):
        mb.box(rc + V(0, 0.036, -0.10 + k * 0.025), (0.21, 0.004, 0.004), 'Alu_Bright')
    # engine mount: four rubber-mounted arms from the crankcase to the bay frame
    for sy in (1, -1):
        for dz in (0.03, -0.20):
            mb.cyl(Q(0.50, sy * 0.10, zc + dz), Q(0.70, sy * 0.15, zc + dz * 0.8), 0.011, 'Paint_White', n=8)
    return mb.finish(sharp_angle=38, wn=True)


# ---------------------------------------------------------------------------
# Bay frame, truss, boom
# ---------------------------------------------------------------------------
NODE = (-1.057, -2.520)              # truss node (gusset), x 1310, y 775 px
STAB_Z = -2.170
TE_X = -2.360
APEX_X = -1.418                      # x 1367, y 722 px
TIP_Y = 0.78
PLATE_LE = -1.880
PLATE_H = 0.56
PLATE_CANT = 15.0
HINGE = -2.050
FIN_TOP = -1.290                     # y 583 px read, -1.29 after the overlay
RUD_TOP = -1.310
FIN_LE = ((-1.665, -2.125), (-1.899, -1.319))   # x 1406 y 712 -> x 1443 y 583


def build_frame():
    """Stainless (body-coloured) frame of the open engine bay: two uprights from the keel to the
    engine mount, a bent crash tube along each side of the engine, cross tubes; truss = flat upper
    strut from the bay bottom and lower bar from the keel meeting at the gusset node; single bar up to
    the tail with the tailplane saddle and the tail wheel."""
    mb = MB('frame')
    keel0, keel1 = R(0.70, -2.33), R(-0.10, -2.31)
    mb.tube([keel0, keel1], 0.0, 'Paint_White', n=16, square=(0.05, 0.05, 6), cap=True)
    for sy in (1, -1):
        # uprights at the back of the pod
        mb.tube([R(-0.08, -2.31, sy * 0.14), R(-0.20, -2.08, sy * 0.17), R(-0.27, -1.70, sy * 0.15)], 0.016,
                'Paint_White', n=10)
        # bent tube along the side of the engine (x 1180-1290, y 640-690 px)
        mb.tube(catmull([R(-0.12, -1.72, sy * 0.29), R(-0.24, -1.675, sy * 0.33), R(-0.62, -1.675, sy * 0.33),
                         R(-0.80, -1.76, sy * 0.30), R(-0.92, -1.90, sy * 0.22), R(-0.93, -1.98, sy * 0.14)], 5),
                0.012, 'Paint_White', n=10)
        # engine mount plate on the uprights
        mb.box(R(-0.29, -1.72, sy * 0.15), (0.03, 0.06, 0.16), 'Paint_White', bevel=0.005, segs=1)
    for z in (-2.08, -1.70):
        mb.cyl(R(-0.20 if z < -2 else -0.27, z, -0.17), R(-0.20 if z < -2 else -0.27, z, 0.17), 0.016,
               'Paint_White', n=10)
    mb.cyl(R(-0.93, -1.98, -0.14), R(-0.93, -1.98, 0.14), 0.012, 'Paint_White', n=8)
    # upper strut: flat channel from the bay bottom to the node (wide in plan, Descripcion.jpg)
    a, b = R(-0.25, -2.04), R(NODE[0] + 0.02, NODE[1] + 0.03)
    mb.tube([a, b], 0.0, 'Paint_White', n=16, square=(0.04, 0.14, 6), cap=True)
    # lower bar from the keel to the node
    mb.tube([R(-0.06, -2.33), R(NODE[0] + 0.03, NODE[1] - 0.01)], 0.0, 'Paint_White', n=16,
            square=(0.045, 0.045, 6), cap=True)
    # gusset plates either side of the node with the lightening hole rim, bolts
    for sy in (1, -1):
        poly = [R(-0.80, -2.33, sy * 0.03), R(NODE[0] - 0.08, NODE[1] - 0.025, sy * 0.03),
                R(-0.80, -2.475, sy * 0.03)]
        mb.faces(poly, [[0, 1, 2]], 'Paint_White', smooth=False)
        mb.faces(poly[::-1], [[0, 1, 2]], 'Paint_White', smooth=False)
        mb.cyl(R(NODE[0], NODE[1], sy * 0.03), R(NODE[0], NODE[1], sy * 0.045), 0.012, 'Metal_Frame', n=10)
    # "La aleta" (the ONLY thing the owner asked to add here; strut, bar, gussets and boom are the traced
    # originals, he wants them untouched): a flat V-shaped plate on the lower bar at the node, apex forward,
    # trailing edge 12 cm behind the bolt and 32 cm across, the sides almost parallel for its aft 10 cm. Shape
    # measured by triangulation on the factory photo cougar_Cougar.jpg (camera solved from 11 model points)
    # and the side photo Descripcion.jpg.
    FIN_LE = [(-1.180, 0.162), (-1.130, 0.158), (-1.085, 0.146), (-1.035, 0.126), (-0.990, 0.102),
              (-0.945, 0.077), (-0.900, 0.052), (-0.855, 0.028), (-0.815, 0.008), (-0.795, 0.0)]
    st = []
    for X, hw in reversed(FIN_LE):
        u = (-0.795 - X) / 0.385                       # 0 at the apex, 1 at the trailing edge
        st.append((R(X, lerp(-2.452, -2.474, u)), hw, lerp(0.012, 0.020, u)))
    st.append((R(-1.205, -2.475), 0.150, 0.020))       # trailing edge, 2 cm further aft on the centre line
    K.delta_plate(mb, st)
    # boom up to the tailplane saddle, flat bar under the stab to the tail wheel (x 1380-1480 px)
    # The boom end and the flat bar run tight UNDER the tailplane, with nothing in between (Descripcion.jpg,
    # 239 px/m: stab underside y 917 = Z -2.234, bar 4.6 cm deep right below it, boom-end bolt at Z -2.255).
    # They used to sit 7 cm lower, with 10 cm metal blocks holding the stab up; the owner: "hay como unas
    # pletinas de aluminio que elevan la cola". The tailplane itself matches the photos and stays put.
    saddle = R(-1.55, -2.240)
    mb.tube([R(NODE[0] - 0.02, NODE[1] + 0.01), saddle], 0.0, 'Paint_White', n=16, square=(0.05, 0.05, 6),
            cap=True)
    mb.tube([saddle, R(-1.85, -2.241), R(-2.13, -2.221)], 0.0, 'Paint_White', n=12, square=(0.06, 0.045, 6),
            cap=True)
    for x in (-1.60, -2.05):        # clamp bands round the bar where the stab is bolted on
        mb.box(R(x, -2.240 if x > -1.9 else -2.226), (0.035, 0.068, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
    mb.cyl(R(-1.62, -2.262, 0.04), R(-2.08, -2.245, 0.04), 0.006, 'Chrome', n=6)
    # tail wheel (small castor) under the bar end
    tw = R(-2.10, -2.340)
    mb.lathe(B.tire_profile(0.036, 0.018, 0.025), tw, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.box(tw + V(0.0, 0, 0.068), (0.03, 0.04, 0.09), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Tail
# ---------------------------------------------------------------------------
def stab_le(y):
    """Leading edge of the tailplane (hub X) along the span: apex on the centreline, swept to the tip."""
    return APEX_X - (APEX_X - PLATE_LE) * min(abs(y), TIP_Y) / TIP_Y


def build_tail():
    """Tailplane in one piece: swept leading edge, straight trailing edge, tips bent up into canted end
    plates (a U seen from the front); swept central fin (the rudder is its own node)."""
    mb = MB('tail')
    cant = math.radians(PLATE_CANT)
    bend_r = 0.07
    path = []
    for y in [0.0, 0.10, 0.22, 0.36, 0.50, 0.62, TIP_Y - bend_r]:
        path.append((y, 0.0, 0.0, 1.0))
    for k in range(1, 7):
        a = (0.5 * math.pi - cant) * k / 6
        path.append((TIP_Y - bend_r + bend_r * math.sin(a), bend_r * (1 - math.cos(a)), -math.sin(a), math.cos(a)))
    top = PLATE_H - bend_r
    for s in (0.06, 0.16, 0.28, 0.40, top * 0.93, top):
        a = 0.5 * math.pi - cant
        y = (TIP_Y - bend_r + bend_r * math.sin(a)) + s * math.cos(a)
        dz = bend_r * (1 - math.cos(a)) + s * math.sin(a)
        path.append((y, dz, -math.sin(a), math.cos(a)))

    def chord(y, dz):
        h = dz / PLATE_H
        if dz < 0.02:
            return stab_le(y), TE_X
        # end plate: vertical leading edge, trailing edge swept forward towards the top, rounded top
        le = PLATE_LE + 0.02 * h - 0.04 * max(0.0, (h - 0.88) / 0.12) ** 2
        te = lerp(-2.33, -2.21, h ** 0.9) + 0.04 * max(0.0, (h - 0.88) / 0.12) ** 2
        return le, te
    loop = airfoil_ring(14, 0.09, te_min=0.0025)
    half = []
    for (y, dz, ny, nz) in path:
        le, te = chord(y, dz)
        c = le - te
        t_scale = 0.11 if dz < 0.02 else 0.085
        ring = []
        for s, tz in loop:
            th = tz * c * (t_scale / 0.09)
            ring.append((le - s * c, y + th * ny, STAB_Z + dz + th * nz))
        half.append(ring)
    rings = [[R(x, z, -yy) for x, yy, z in ring] for ring in reversed(half[1:])]
    rings += [[R(x, z, yy) for x, yy, z in ring] for ring in half]
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    zs = [STAB_Z - 0.03, STAB_Z + 0.04, -2.05, -1.90, -1.75, -1.60, -1.47, -1.38, -1.34, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, fin_te, t=0.10)
    return mb.finish(sharp_angle=45)


def fin_le(z):
    Z = z - R.dz
    (x0, z0), (x1, z1) = FIN_LE
    t = (Z - z0) / (z1 - z0)
    x = lerp(x0, x1, max(0.0, t))
    if Z < STAB_Z + 0.08:                      # fillet into the tailplane
        x += 0.06 * ((STAB_Z + 0.08 - Z) / 0.11) ** 1.5
    x -= 0.03 * max(0.0, (Z - (FIN_TOP - 0.03)) / 0.03) ** 2
    return R.x(x)


def fin_te(z):
    return R.x(HINGE + 0.004)


def rud_te(z):
    Z = z - R.dz
    if Z > -1.99:
        x = lerp(-2.510, -2.290, (Z + 1.99) / (RUD_TOP + 1.99))
    else:
        x = lerp(-2.510, HINGE - 0.10, min(1.0, (-1.99 - Z) / 0.08) ** 0.8)
    return R.x(x)


def build_rudder():
    zs = [-2.085, -2.075, -2.05, -2.02, -1.99, -1.88, -1.72, -1.56, -1.44, -1.37, RUD_TOP]
    origin = R(HINGE, -1.70)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], lambda z: R.x(HINGE + 0.01), rud_te, R.x(HINGE),
                                 origin, t=0.10, mat='Paint_White')
    deco = MB('rud_deco')
    # ELA oval logo high on the fin (x 1465-1505, y 590-610 px; straddles the hinge)
    for sy in (1, -1):
        ring = [R(-2.10 + 0.125 * math.cos(TAU * k / 40), -1.43 + 0.055 * math.sin(TAU * k / 40), sy * 0.12)
                for k in range(40)]
        q = pilot.surface_path(rud, ring + [ring[0]], V(0, sy, 0), 0.0008, samples=1)
        if len(q) > 3:
            deco.tube(q, 0.0035, 'Paint_Dark', n=6)
    deco_ob = deco.finish(sharp_angle=60)
    B.join_objects('rudder', [rud, deco_ob])
    return rud


# ---------------------------------------------------------------------------
# Gear
# ---------------------------------------------------------------------------
def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # bare grey tubular leg from the bay frame (side of the uprights) down and out to the axle fork
        root = R(-0.22, -2.06, sy * 0.19)
        tip = V(ax.x + 0.01, sy * (MAIN_Y - 0.155), ax.z + 0.05)
        mb.cyl(root, tip, 0.024, 'Leg_Grey', n=14)
        mb.box(root, (0.06, 0.06, 0.06), 'Metal_Frame', bevel=0.008, segs=1)
        # lower radius rod from the keel to the axle block
        mb.cyl(R(-0.05, -2.43, sy * 0.05), tip + V(0.02, 0, -0.03), 0.013, 'Leg_Grey', n=10)
        # axle block, stub axle, brake disc + calliper (inboard)
        mb.box(tip + V(0, 0, -0.03), (0.08, 0.05, 0.10), 'Leg_Grey', bevel=0.01, segs=2)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.16), ax.z), V(ax.x, sy * (MAIN_Y + 0.11), ax.z), 0.015, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.122), ax.z), V(ax.x, sy * (MAIN_Y - 0.114), ax.z), 0.085, 'Metal_Frame',
               n=24)
        mb.box(V(ax.x + 0.075, sy * (MAIN_Y - 0.118), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', V(ax.x, sy * MAIN_Y, ax.z), R=MAIN_R, w=MAIN_W, rim_r=0.11)
    gear = mb.finish(sharp_angle=40, wn=True)
    nose = K.nose_gear(R(NOSE[0], NOSE[1]), R=NOSE_R, w=0.11, leg_top=R.z(-2.43), rake=-0.03,
                       fork_mat='Metal_Frame')
    return gear, nose


def build_chin():
    """Keel fairing under the beak that houses the nose fork (x 826-950 px), open underneath."""
    prof = [(2.010, -2.335), (1.960, -2.440), (1.880, -2.515), (1.780, -2.540), (1.450, -2.542), (1.330, -2.530),
            (1.250, -2.470), (1.215, -2.400)]
    rings = []
    for (X, zb) in prof:
        zt = POD.params(R.x(X))['zb'] - R.dz + 0.03
        hw = 0.085 * min(1.0, (2.01 - X) / 0.10, (X - 1.215) / 0.10) ** 0.5
        hw = max(hw, 0.006)
        ring = []
        for j in range(18):
            a = TAU * j / 18
            ca, sa = math.cos(a), math.sin(a)
            zm = (zt + zb) * 0.5
            hz = (zt - zb) * 0.5
            ring.append(R(X, zm + B.sgnpow(sa, 0.8) * hz, B.sgnpow(ca, 0.6) * hw))
        rings.append(ring)
    mb = MB('chin')
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    ob = mb.finish(sharp_angle=60)
    cm = MB('chincut')
    cm.box(R(NOSE[0], NOSE[1] + 0.02), (2 * NOSE_R + 0.06, 0.135, 2 * NOSE_R + 0.06), 'Paint_White', bevel=0.05,
           segs=3)
    B.boolean_cut_shell(ob, cm.finish(sharp_angle=80))
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    B.apply_mods(ob)
    return ob


# ---------------------------------------------------------------------------
# Cockpit
# ---------------------------------------------------------------------------
def build_cockpit():
    mb = MB('cockpit')
    E.bucket_seat(mb, FRONT_HIP, FRONT_BACK, width=0.36, headrest=False, base=True)
    E.bucket_seat(mb, REAR_HIP, REAR_BACK, width=0.42, headrest=False, base=True)
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
    # rear stick and throttle (dual controls standard on the factory photos)
    mb.cyl(R(0.62, -2.31), R(0.64, -1.92), 0.012, 'Paint_Dark', n=10)
    mb.box(R(0.645, -1.88), (0.035, 0.03, 0.09), 'Rubber', bevel=0.01, segs=2)
    return mb.finish(sharp_angle=40, wn=True)


def clearance(a_names, b_objs, label=''):
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


def build_ela07():
    ensure_mats()
    # anodised blades (champagne grey on the factory photos)
    E.set_paint('Rotor_Blade', '#9A917F', 0.8, 0.38)
    pod, rim = build_pod()
    bh = bulkheads()
    lines = panel_lines(pod)
    ws1, fr1 = front_screen()
    ws2, fr2 = rear_screen()
    mast = build_mast()
    K.build_head(PIVOT, HUB, arm=-0.16, arm_w=0.24, plate_mat='Metal_Frame')
    K.build_rotor(HUB, R=4.115, chord=0.22, root=0.50, tip_mat='Rotor_Blade', clamp_len=0.48, clamp_mat='Alu_Black')
    engine = build_engine(PROP)
    K.build_prop(PROP, R=PROP_R, blades=3, hub='flange', hub_r=0.09, mat='Carbon', tip_mat='Carbon', pitch=1.0)
    frame = build_frame()
    tail = build_tail()
    build_rudder()
    gear, nose = build_gear()
    chin = build_chin()
    cockpit = build_cockpit()

    ctrl = MB('controls_static')
    stick_base = R(1.40, -2.32)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.42, -1.76))
    knob, lever = controls.throttle_lever(ctrl, R(1.36, -1.95, 0.29))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.98, -2.19, 0.10), 'R': R(1.98, -2.19, -0.10)}, knee_out=0.03, elbow_out=0.04,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.29))
    p0 = R(1.765, -1.845)
    PANEL.build_panel(ctrl, p0, 18.0, [pod, ws1], zone=(0.0, 0.042, 0.36, 0.14), cw=0.04, v_leg=-0.035,
                      v_sb=-0.30, v_b=-0.34, top_arch=(0.28, 0.08, 0.20), max_u=0.27, leg_exp=0.25)
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.24, -0.16, 0.17), None),
                             'L': ('rest', REAR_HIP + V(0.24, 0.16, 0.17), None)},
                      feet={'L': R(1.12, -2.15, 0.27), 'R': R(1.12, -2.15, -0.27)}, knee_out=0.07, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    det = MB('details')
    # prop hub: red anodised flange plate with its bolt circle (behind the blades)
    det.lathe([(0.0, 0.0), (0.105, 0.0), (0.105, 0.018), (0.0, 0.018)], PROP + V(-0.035, 0, 0), V(-1, 0, 0),
              'Rotax_Red', n=32)
    for k in range(6):
        a = TAU * k / 6
        p = PROP + V(-0.055, math.cos(a) * 0.07, math.sin(a) * 0.07)
        det.cyl(p, p + V(-0.02, 0, 0), 0.008, 'Chrome', n=8)
    # no exterior lights: none of the factory Cougar photos (Cougar, 21, Descripcion, High-Tail,
    # Light-weight, cabecera, spec sheet) shows a lamp on the beak, the pod sides, the mast or the tail, and
    # no equipment list names any for the Cougar (the side nav/strobe units, landing light and mast strobe
    # drawn before are Scorpion equipment).
    # MINIMUM SET, NOT ON THE PHOTOS: the owner asked for at least landing + nav + one anti-collision
    # light on every aircraft (night flying in the sim), so the Cougar carries them where the 07 family
    # does: side markers behind the rear cockpit, a landing lamp in the beak, a strobe on the mast.
    for sy, kind in ((1, 'red'), (-1, 'green')):
        X, Z = -0.10, -1.80
        p = R(X, Z, sy * pod_y(X, Z))
        K.oval_lamp(det, pod, p, V(0, sy, 0), V(1, 0, 0), kind=kind, a=0.045, b=0.014)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0, sy * 0.03, 0))
    K.lamp(det, R(2.52, -2.165), V(1, 0, -0.1), kind='white', r=0.014, length=0.010)
    K.lamp_node('landing', R(2.56, -2.169))
    K.lamp(det, R(-0.16, -0.38), V(-1, 0, 0), kind='white', r=0.014, length=0.025)
    K.lamp_node('beacon', R(-0.215, -0.38))
    # ELA oval badge on the nose deck ahead of the screen
    ring = [(R(1.93 + 0.035 * math.cos(TAU * k / 32), -1.70, 0.075 * math.sin(TAU * k / 32)), V(0.3, 0, 1))
            for k in range(33)]
    q = project(pod, ring, 0.0008)
    if len(q) > 3:
        det.tube(q, 0.003, 'Paint_Dark', n=6)
    # fuel filler (left side behind the rear seat), static vent
    X, Z = 0.12, -1.95
    p = R(X, Z, pod_y(X, Z))
    det.cyl(p - V(0, 0.004, 0), p + V(0, 0.010, 0), 0.03, 'Alu_Black', n=16)
    # antenna under the belly (y 760 px, x 1013)
    K.antenna(det, R(0.82, -2.39), (-0.5, 0, -1), length=0.22)
    det = det.finish(sharp_angle=50)
    regs = E.build_registration(pod, REG, cx=R.x(0.30), cz=R.z(-2.03), size=0.10, mat='Paint_Dark')

    S = FRONT_HIP + V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK))) * pilot.SPINE
    u = V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK)))
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    clearance(['pilot_front_leg', 'pilot_front_foot'], [bpy.data.objects.get('panel_face'), ctrl, pod], ' (front)')
    clearance(['pilot_front'], [pod, cockpit, bh], ' (front body)')
    clearance(['pilot_rear'], [pod, cockpit, bh], ' (rear)')
    K.finalize([pod, rim, fr1, fr2, mast, engine, frame, tail, gear, chin, cockpit, ctrl, det, lines, bh] + regs,
               [ws1, ws2])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.70), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })
    print('ELA07 hub %s pivot %s prop %s ground z %.3f axle x %.3f nose x %.3f eye %s head %s' % (
        tuple(round(c, 3) for c in HUB), tuple(round(c, 3) for c in PIVOT), tuple(round(c, 3) for c in PROP),
        R.z(GROUND), ax.x, R.x(NOSE[0]), tuple(round(c, 3) for c in eye),
        (round(head.x - R.dx, 3), round(head.z - R.dz, 3))))


if __name__ == '__main__':
    VIEWS = {
        # same angles as the factory photos (for side-by-side checks)
        # same side and height as the factory photo Cougar.jpg (camera front-RIGHT, nose to the right)
        'boom_fin': dict(extra=True, loc=(4.33, -5.69, 2.03), target=(-1.20, 0.0, -0.62), lens=200, rotor=-35, prop=10),
        'cmp_cougar': dict(extra=True, loc=(5.6, -6.4, 4.6), target=(-0.2, 0.0, 0.0), lens=34, rotor=-35, prop=10),
        'cmp_21': dict(extra=True, loc=(-5.6, -4.3, -0.3), target=(-0.6, 0.0, 0.3), lens=26, rotor=-30, prop=10),
        'cmp_des': dict(extra=True, loc=(-0.6, -6.8, -0.35), target=(-0.3, 0.0, 0.0), lens=24, rotor=0, prop=10),
        'cmp_front': dict(extra=True, loc=(9.5, 0.0, -0.3), target=(0.0, 0.0, 0.15), lens=70, rotor=90, prop=0),
        'gear_detail': dict(extra=True, loc=(1.0, 3.2, 0.0), target=(-0.5, 0.4, -0.6), lens=40, rotor=75, prop=10),
    }
    K.run('ela07', build_ela07, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
