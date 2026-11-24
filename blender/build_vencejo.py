"""
Vencejo X1 -- an INVENTED two-seat tandem gyroplane concept (~2045) for the Autogiro web sim. No real
aircraft is traced: the shape is designed on the numbers below and drawn first as a dimensioned
three-view (tools script in the scratch folder renders it from these same functions).

Design: smooth raindrop / lifting-body pod with a sharp chine on each side where the pearl-white top
meets the graphite belly (a thin cyan line rides on the crease), ONE continuous smoked canopy from the
nose cone almost to the pylon with only a thin central spine over the cabin; swept carbon blade pylon
blended into the pod with generous fillets, teardrop fairing over the rotor head; three-blade composite
rotor (8.8 m, 0.20 m chord, swept parabolic tips) with a domed hub cap; the pod tapers into a tail cone
carrying a DUCTED pusher fan (1.45 m ring, 1.30 m seven-blade fan, eight stators, cyan light ring on the
lip) on the centre-of-gravity line; cruciform tail at the duct exit: horizontal stabiliser through the
exit out to two outward-canted end fins, vertical fin over the duct whose trailing part is the rudder
(its lower half works in the fan jet), small ventral fin with the tail skid; tricycle gear with slim
carbon spring legs, wheels in teardrop pods (only the bottom third of the tyre shows), nose wheel in a
pant faired under the nose.

Hub frame (gyrokit.py): X forward, Z up, origin on the rotor hub, metres. CG (sim convention) 0.33 m
ahead of the hub and 0.85 m above the main axle (a concept: no data sheet).

  blender -b -P blender/build_vencejo.py -- [--previews] [--only VIEW,...] [--samples N] [--show-rear]
Outputs: public/models/vencejo.glb, blender/vencejo.blend, blender/previews/vencejo/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, naca4, pilot, controls, PANEL  # noqa: E402

# ---- hub frame ---------------------------------------------------------------------------------------
GROUND = -2.77                       # hub 2.77 m above the ground
R_MAIN, W_MAIN = 0.20, 0.11          # main tyres 400 x 110
R_NOSE, W_NOSE = 0.15, 0.09          # nose tyre 300 x 90
AXLE = (-0.58, GROUND + R_MAIN)      # main axle
CG = (0.33, AXLE[1] + 0.85)          # sim convention in x; 0.85 m above the main axle
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.20)
ROTOR_R, ROTOR_CHORD, ROTOR_N = 4.40, 0.20, 3
FAN_X, FAN_Z = -2.00, -1.62          # fan plane / thrust line (0.10 m above the CG)
FAN_R, FAN_N, HUB_R = 0.648, 7, 0.165
PROP = R(FAN_X, FAN_Z)
MAIN_Y = 0.80                        # track 1.60 m
# wheelbase 2.22 m: nose wheel 0.12 m further forward than first drawn, so it carries ~44 % of the weight
# (the sim's ground test wants < 45 %)
NOSE = (1.64, GROUND + R_NOSE)

LIVERY = dict(body=('#E8EBEE', 0.12, 0.20), accent=('#17CDE0', 0.0, 0.25), dark=('#2A2D33', 0.45, 0.30),
              seat=('#1B1D21', 0.0, 0.72))
REG = 'EC-VX1'
CYAN = '#18D2E6'

# ---- pod: side outline, plan half-width, chine (crease) height ---------------------------------------
XN0, NOSE_STRETCH = 2.58, 0.04       # drawn nose tip, stretch of the nose ahead of X = 2.0
XN, ZN = XN0 + NOSE_STRETCH, -2.06    # nose tip
X_END = FAN_X + 0.037                # tail cone meets the fan hub (radius HUB_R round the fan axis)
TOP = [(XN0, ZN), (2.55, -2.005), (2.50, -1.977), (2.42, -1.948), (2.30, -1.912), (2.16, -1.868), (1.90, -1.762),
       (1.60, -1.615),
       (1.30, -1.48), (1.00, -1.37), (0.70, -1.298), (0.40, -1.245), (0.10, -1.207), (-0.20, -1.19),
       (-0.45, -1.198), (-0.75, -1.232), (-1.05, -1.283), (-1.35, -1.343), (-1.65, -1.403), (X_END, FAN_Z + HUB_R)]
BOT = [(XN0, ZN), (2.55, -2.112), (2.50, -2.145), (2.44, -2.172), (2.30, -2.218), (2.10, -2.287), (1.85, -2.345),
       (1.52, -2.40),
       (1.20, -2.44), (0.80, -2.465), (0.30, -2.475), (-0.20, -2.465), (-0.55, -2.435), (-0.85, -2.365),
       (-1.15, -2.24), (-1.45, -2.07), (-1.70, -1.93), (X_END, FAN_Z - HUB_R)]
CHINE = [(XN0, ZN), (2.35, -2.085), (2.00, -2.11), (1.60, -2.13), (1.20, -2.14), (0.80, -2.14), (0.40, -2.13),
         (0.00, -2.11), (-0.40, -2.065), (-0.80, -1.985), (-1.20, -1.875), (-1.55, -1.755), (X_END, FAN_Z)]
WID = [(XN0, 0.0), (2.55, 0.10), (2.50, 0.158), (2.44, 0.202), (2.36, 0.25), (2.23, 0.315), (2.03, 0.39), (1.78, 0.44),
       (1.48, 0.465), (1.18, 0.475), (0.88, 0.475), (0.58, 0.468), (0.28, 0.45), (-0.02, 0.42), (-0.32, 0.375),
       (-0.62, 0.322), (-0.92, 0.272), (-1.22, 0.228), (-1.52, 0.194), (X_END, HUB_R)]
# section shape along X: tumblehome of the top at the chine, belly angle at the chine (deg), Bezier
# fullness (top horizontal, top at chine, belly at chine, belly flatness); round at the tail end
AT = [(XN, 12.0), (1.0, 12.0), (-0.3, 12.0), (-1.0, 7.0), (-1.6, 2.0), (X_END, 0.0)]
AB = [(XN, 30.0), (1.0, 34.0), (-0.3, 32.0), (-1.0, 16.0), (-1.6, 4.0), (X_END, 0.0)]
KA = [(XN, 0.66), (1.0, 0.72), (-0.3, 0.68), (-1.2, 0.60), (X_END, 0.5523)]
KB = [(XN, 0.56), (1.0, 0.62), (-0.3, 0.60), (X_END, 0.5523)]
KC = [(XN, 0.45), (1.0, 0.45), (-0.3, 0.48), (X_END, 0.5523)]
KD = [(XN, 0.70), (1.0, 0.76), (-0.3, 0.72), (-1.2, 0.62), (X_END, 0.5523)]
X_BAND = (2.50, -1.62)               # cyan line along the chine, from the nose to the tail cone
N_UP, N_LO, BAND = 26, 16, 0.014


def _u(X):
    return math.sqrt(max(0.0, XN - X))


def _st(X):
    """Stretch of the nose region (the tables were drawn with the tip at XN0)."""
    return X + NOSE_STRETCH * max(0.0, X - 2.0) / (XN0 - 2.0)


def _prof(pairs):
    pairs = sorted([(_st(X), v) for X, v in pairs], key=lambda p: -p[0])
    return B.hermite([_u(X) for X, _ in pairs], [v for _, v in pairs])


def _lin(pairs):
    return B.hermite([p[0] for p in pairs], [p[1] for p in pairs])


F_T, F_B, F_C, F_W = _prof(TOP), _prof(BOT), _prof(CHINE), _prof(WID)
F_AT, F_AB, F_KA, F_KB, F_KC, F_KD = _lin(AT), _lin(AB), _lin(KA), _lin(KB), _lin(KC), _lin(KD)


def pod(X):
    u = _u(X)
    zt, zb, zc, w = F_T(u), F_B(u), F_C(u), max(F_W(u), 1e-5)
    h = max(zt - zb, 1e-5)
    zc = min(max(zc, zb + 0.08 * h), zt - 0.08 * h)
    return dict(zt=zt, zb=zb, zc=zc, w=w, at=math.radians(max(F_AT(X), 0.0)), ab=math.radians(max(F_AB(X), 0.0)),
                ka=F_KA(X), kb=F_KB(X), kc=F_KC(X), kd=F_KD(X))


def bez(P, t):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = P
    m = 1.0 - t
    a, b, c, d = m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t
    return (a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3)


def section(X, n=48):
    """Half section (y >= 0) at X: upper curve top centre -> chine, lower curve chine -> keel (y, z)."""
    p = pod(X)
    zt, zb, zc, w = p['zt'], p['zb'], p['zc'], p['w']
    hu, hl = zt - zc, zc - zb
    p2 = (max(w - p['kb'] * hu * math.tan(p['at']), 0.3 * w), zc + p['kb'] * hu)
    p1 = (max(w - p['kc'] * hl * math.tan(p['ab']), 0.3 * w), zc - p['kc'] * hl)
    up = [bez(((0.0, zt), (p['ka'] * w, zt), p2, (w, zc)), k / n) for k in range(n + 1)]
    lo = [bez(((w, zc), p1, (p['kd'] * w, zb), (0.0, zb)), k / n) for k in range(n + 1)]
    return up, lo


def _arc(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def _split(pts, d):
    acc = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if acc + L >= d and L > 0:
            t = (d - acc) / L
            p = (lerp(a[0], b[0], t), lerp(a[1], b[1], t))
            return p, [p] + pts[i + 1:]
        acc += L
    return pts[-1], [pts[-1], pts[-1]]


def half_ring(X):
    up, lo = section(X)
    up = E.resample2d(up, N_UP)
    p, rest = _split(lo, min(BAND, 0.15 * _arc(lo)))
    lo2 = E.resample2d(rest, N_LO)
    return up + [p] + lo2[1:]


def pod_ring(X):
    h = half_ring(X)
    return [R(X, z, y) for y, z in h] + [R(X, z, -y) for y, z in reversed(h[1:-1])]


def hull_y(X, Z):
    """Outer half-width of the pod at height Z (hub frame)."""
    up, lo = section(X, 80)
    pts = up + lo[1:]
    best = 0.0
    for (y0, z0), (y1, z1) in zip(pts, pts[1:]):
        if (z0 - Z) * (z1 - Z) <= 0 and z0 != z1:
            best = max(best, lerp(y0, y1, (Z - z0) / (z1 - z0)))
    return best


def top_z(X):
    return pod(X)['zt']


def pod_stations():
    xs = [XN - (0.012 * k) ** 2 for k in range(1, 51)]
    x = xs[-1]
    while x > X_END + 0.03:
        x -= 0.025
        xs.append(x)
    xs.append(X_END)
    return xs


# ---- canopy (side view, hub frame): glass = above the sill, from the nose cone to the pylon --------------
GLASS = [(2.285, -1.0), (2.285, -1.88), (2.128, -1.935), (2.00, -1.985), (1.86, -2.02), (1.60, -2.015),
         (1.20, -1.995), (0.80, -1.975), (0.40, -1.955), (0.10, -1.925), (-0.08, -1.865), (-0.19, -1.74),
         (-0.25, -1.55), (-0.27, -1.35), (-0.27, -1.0)]
SPINE_X = (1.06, -0.27)

# ---- pylon (hub frame): s = 0 root (sunk in the pod top) .. 1 top (inside the head fairing) -----------
PY_LE = (-0.31, 0.07)
PY_TE = (-1.12, -0.25)
PY_TOP_Z = -0.28


def py_le(s):
    return lerp(PY_LE[0], PY_LE[1], s)


def py_te(s):
    return PY_TE[1] - (PY_TE[1] - PY_TE[0]) * (1 - s) ** 2.2


def py_z(s, X):
    return lerp(top_z(X) - 0.08, PY_TOP_Z, s ** 0.85)


def py_th(s):
    return 0.046 + 0.012 * (1 - s) + 0.12 * max(0.0, 1 - s / 0.20) ** 2.2


# ---- rotor head fairing (teardrop, NACA thickness law) ------------------------------------------------
HF_X0, HF_X1, HF_ZC, HF_RM, HF_SQ = 0.22, -0.50, -0.225, 0.118, 0.90


def hf_r(X):
    L = HF_X0 - HF_X1
    s = min(max((HF_X0 - X) / L, 0.0), 1.0)
    return naca4(s, 2 * HF_RM / L)[1] * L


def hf_zc(X):
    s = min(max((HF_X0 - X) / (HF_X0 - HF_X1), 0.0), 1.0)
    return HF_ZC + 0.02 * s * s


# ---- duct (ring round the fan axis): mean radius + NACA 0015 thickness along the chord ---------------
D_LE, D_C = FAN_X + 0.16, 0.45       # fan at 36 % of the duct chord
D_TE = D_LE - D_C
DUCT_MAT = 'Paint_Dark'              # graphite ring, carbon inside, cyan light ring on the lip
F_DRM = B.hermite([0.0, 0.1, 0.36, 0.7, 1.0], [0.705, 0.700, 0.691, 0.682, 0.672])


def duct_h(s):
    return max(naca4(s, 0.15)[1], 0.004 * min(1.0, s / 0.05)) * D_C


def duct_r(s, outer=True):
    return F_DRM(s) + (duct_h(s) if outer else -duct_h(s))


D_TOP = FAN_Z + 0.728                # outer top of the ring (max outer radius ~0.728)
D_BOT = FAN_Z - 0.728

# ---- tail (hub frame) --------------------------------------------------------------------------------
# Nothing stands above the duct: the tail must clear the rotor disc tilted 15 deg aft (take-off roll,
# vertical descent) by >= 0.33 m. The rudder is a vertical vane in the fan jet inside the duct exit.
TILT_CHECK, CLEAR_MIN, TAILDOWN_MIN = 15.0, 0.33, 13.0
VANE_LE = FAN_X - 0.08                # stators (diagonal, vertical, the stabiliser) start here
STAB_LE0, STAB_TE0 = VANE_LE, -2.44   # centreline (the root runs on through the rudder slot)
STAB_LE1, STAB_TE1 = -2.10, -2.48     # tips
SPAN = 1.075                          # half span: 0.35 m outside the duct
EF_CANT = 15.0                        # end fins canted outward (deg)
EF_BOT, EF_TOP = FAN_Z - 0.34, FAN_Z + 0.56
HINGE = -2.205                        # rudder hinge: vertical, on the centreline, just behind the stators
RUD_TE = -2.37                        # rudder trailing edge (8 cm behind the duct exit)
VANE_TE = HINGE + 0.016               # fixed vertical stators end just ahead of the rudder nose
CONE_TIP = -2.40
Z_SKID = -2.36
FIN_T = 0.08                          # thickness ratio of the vertical vane + rudder section


def cone_r(X):
    """Pointed tail cone behind the fan hub: smooth shoulder, concave spike."""
    x0 = FAN_X - 0.06
    xi = min(max((x0 - X) / (x0 - CONE_TIP), 0.0), 1.0)
    return HUB_R * (1 - xi) ** 3.0 * (1 + 3.0 * xi)


def duct_r_at(X, outer=True):
    return duct_r(min(max((D_LE - X) / D_C, 0.0), 1.0), outer)


RUD_H0 = cone_r(HINGE) + 0.013        # rudder slot (the cone and the stabiliser pass through it)
RUD_H = min(duct_r_at(X, False) for X in (HINGE, 0.5 * (HINGE + D_TE), D_TE)) - 0.014   # tips 14 mm off the wall


def ef_le(t):
    """End fin leading edge X at fraction t (0 bottom .. 1 top), rounded corners."""
    return lerp(-1.97, -2.36, t) - 0.10 * max(0.0, (t - 0.85) / 0.15) ** 2 - 0.06 * max(0.0, (0.12 - t) / 0.12) ** 2


def ef_te(t):
    return lerp(-2.42, -2.66, t) + 0.05 * max(0.0, (t - 0.86) / 0.14) ** 2 + 0.04 * max(0.0, (0.10 - t) / 0.10) ** 2


def rud_le(z):
    """Leading edge (model x) of the vertical vane + rudder section (one airfoil)."""
    return R.x(VANE_LE)


def rud_te(z):
    h = abs(z - R.dz - FAN_Z)
    x = RUD_TE + 0.05 * max(0.0, (h - (RUD_H - 0.05)) / 0.05) ** 2 + 0.03 * max(0.0, (RUD_H0 + 0.03 - h) / 0.03) ** 2
    return R.x(x)


# ---- cockpit -----------------------------------------------------------------------------------------
FLOOR_Z = -2.41
FRONT_HIP = R(1.00, -2.22)
REAR_HIP = R(0.18, -2.13)
FRONT_BACK, REAR_BACK = 25.0, 22.0
PANEL_P0, PANEL_TILT = R(1.53, -1.915), 22.0


def eye_point():
    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    return head + V(0.077, 0, 0.007)


# ---------------------------------------------------------------------------------------------------
# materials
# ---------------------------------------------------------------------------------------------------
def vx_materials():
    if 'Glass_Smoke' not in MATS:
        B.make_mat('Glass_Smoke', B.srgb('#2C3848'), rough=0.02, alpha=0.46, spec=0.7)
    if 'Accent_Cyan' not in MATS:
        B.make_mat('Accent_Cyan', B.srgb(CYAN), rough=0.25, emit=B.srgb(CYAN), emit_strength=1.2)
    E.set_paint('Rotor_Blade', '#CDD2D8', 0.25, 0.28)
    m = MATS['Paint_White']
    bs = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    if 'Coat Weight' in bs.inputs:
        bs.inputs['Coat Weight'].default_value = 0.6
        bs.inputs['Coat Roughness'].default_value = 0.05


# ---------------------------------------------------------------------------------------------------
# pod
# ---------------------------------------------------------------------------------------------------
def build_pod():
    xs = pod_stations()
    rings = [[R(XN, ZN)]] + [pod_ring(X) for X in xs]
    H = N_UP + N_LO + 2
    M = 2 * H - 2
    mb = MB('pod')
    bm = mb.bm
    vr = [[bm.verts.new(p) for p in r] for r in rings]
    mi = {k: mb.mi(k) for k in ('Paint_White', 'Accent_Cyan', 'Paint_Dark')}
    xprev = [XN] + xs

    def seg_mat(j, X):
        s = j if j <= H - 2 else M - 1 - j
        if s < N_UP:
            return 'Paint_White'
        if s == N_UP and X_BAND[1] < X < X_BAND[0]:
            return 'Accent_Cyan'
        return 'Paint_Dark'
    for k in range(len(rings) - 1):
        a, b = vr[k], vr[k + 1]
        X = 0.5 * (xprev[k] + xprev[k + 1])
        for j in range(M):
            j2 = (j + 1) % M
            f = [a[0], b[j2], b[j]] if len(a) == 1 else [a[j], a[j2], b[j2], b[j]]
            face = bm.faces.new(f)
            face.material_index = mi[seg_mat(j, X)]
            face.smooth = True
    last = vr[-1]
    c = bm.verts.new(R(X_END, FAN_Z))
    for j in range(M):
        face = bm.faces.new([last[j], last[(j + 1) % M], c])
        face.material_index = mi['Paint_Dark']
    return mb.finish(sharp_angle=60)


def mark_chine(ob):
    """The chine is a real crease: sharp edges along it wherever the section folds by > 10 deg."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    ch = set()
    cache = {}
    for v in bm.verts:
        X, Z = v.co.x - R.dx, v.co.z - R.dz
        if not (X_END + 0.05 < X < XN - 0.02) or abs(v.co.y) < 0.05:
            continue
        key = round(X, 4)
        p = cache.get(key) or cache.setdefault(key, pod(X))
        if abs(abs(v.co.y) - p['w']) < 0.0015 and abs(Z - p['zc']) < 0.0015:
            ch.add(v)
    n = 0
    for e in bm.edges:
        a, b = e.verts
        if a in ch and b in ch:
            X = 0.5 * (a.co.x + b.co.x) - R.dx
            if F_AT(X) + F_AB(X) > 10.0:
                e.smooth = False
                n += 1
    bm.to_mesh(me)
    bm.free()
    print('  chine: %d crease edges' % n)


def split_canopy(pod_ob):
    glass = R.pts(GLASS)
    bm = bmesh.new()
    bm.from_mesh(pod_ob.data)
    K.bisect_poly(bm, glass)
    bm.to_mesh(pod_ob.data)
    bm.free()
    can, frame, seal = K.split_glass(pod_ob, lambda c: PANEL.inside(glass, c.x, c.z), frame_r=0.0055,
                                     frame_mat='Paint_Dark', seal=True, thickness=0.012, name='canopy')
    can.data.materials[0] = MATS['Glass_Smoke']
    return can, frame, seal


def build_spine():
    """Thin pearl spine along the canopy top (the canopy halves hinge on it), tapered at its front."""
    mb = MB('spine')
    n = 70
    rings = []
    for k in range(n + 1):
        X = lerp(SPINE_X[0], SPINE_X[1], k / n)
        z = top_z(X)
        w = 0.002 + 0.010 * min(1.0, (SPINE_X[0] - X) / 0.16) ** 0.6
        h = 0.001 + 0.006 * min(1.0, (SPINE_X[0] - X) / 0.16) ** 0.6
        ring = []
        for j in range(12):
            a = TAU * j / 12
            sa = math.sin(a)
            ring.append(R(X, z + (h * sa if sa > 0 else 0.003 * sa), w * math.cos(a)))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    return mb.finish(sharp_angle=60)


# ---------------------------------------------------------------------------------------------------
# pylon, head fairing, rotor head, rotor
# ---------------------------------------------------------------------------------------------------
def build_pylon():
    mb = MB('pylon')
    ss = [0.0, 0.025, 0.05, 0.08, 0.12, 0.17, 0.23, 0.30, 0.38, 0.47, 0.57, 0.67, 0.77, 0.86, 0.93, 0.97, 1.0]
    rings = []
    for s in ss:
        le, te = py_le(s), py_te(s)
        c = le - te
        th = py_th(s)
        ring = []
        for sc, tz in airfoil_ring(22, min(2 * th / c, 0.95), te_min=0.004):
            X = le - sc * c
            ring.append(R(X, py_z(s, X), tz * c))
        rings.append(ring)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    return mb.finish(sharp_angle=50)


def build_head_fairing(det):
    mb = MB('head_fairing')
    L = HF_X0 - HF_X1
    ss = [0.0] + [0.5 - 0.5 * math.cos(math.pi * k / 26) for k in range(1, 27)]
    rings = []
    for s in ss:
        X = HF_X0 - s * L
        r = hf_r(X)
        zc = hf_zc(X)
        if r < 1e-4:
            rings.append([R(X, zc)])
            continue
        rings.append([R(X, zc + r * math.sin(TAU * k / 36), HF_SQ * r * math.cos(TAU * k / 36)) for k in range(36)])
    if len(rings[-1]) > 1:
        rings.append([R(HF_X1 - 0.004, hf_zc(HF_X1))])
    mb.loft(rings, 'Paint_White', closed=True)
    ob = mb.finish(sharp_angle=60)
    # rubber boot where the spindle leaves the fairing
    pts = []
    for k in range(32):
        a = TAU * k / 32
        X, y = 0.086 * math.cos(a), 0.086 * math.sin(a)
        r = hf_r(X)
        z = hf_zc(X) + math.sqrt(max(r * r - (y / HF_SQ) ** 2, 0.0))
        pts.append(R(X, z - 0.002, y))
    B.closed_tube(det, pts, 0.009, 'Rubber', n=10)
    return ob


def build_head():
    """Gimbal (hidden in the fairing) and the spindle housing that leaves the fairing top."""
    mb = MB('rotor_head')
    c = PIVOT
    mb.box(c, (0.10, 0.075, 0.055), 'Engine', bevel=0.01, segs=2)
    mb.cyl(c + V(0, -0.065, 0), c + V(0, 0.065, 0), 0.012, 'Metal_Frame', n=12)
    mb.cyl(c + V(-0.07, 0, 0.032), c + V(0.07, 0, 0.032), 0.015, 'Engine_Dark', n=14)
    z0, z1 = c.z + 0.045, HUB.z - 0.062
    mb.lathe([(0.0, z0), (0.052, z0), (0.058, z0 + 0.010), (0.058, z1 - 0.016), (0.064, z1 - 0.012),
              (0.080, z1 - 0.010), (0.080, z1), (0.0, z1)], V(HUB.x, 0, 0), V(0, 0, 1), 'Engine_Dark', n=36)
    # thin cyan ring on the spindle collar
    mb.lathe([(0.0806, z1 - 0.0075), (0.0815, z1 - 0.007), (0.0815, z1 - 0.003), (0.0806, z1 - 0.0025)],
             V(HUB.x, 0, 0), V(0, 0, 1), 'Accent_Cyan', n=36)
    return mb.finish(origin=PIVOT, sharp_angle=40, wn=True)


DOME_R, DOME_Z0, DOME_H = 0.235, -0.035, 0.15


def _rotor_blade(mb, az):
    """Composite blade along +X (rotated by az): oval root shank out of the dome, 0.20 m chord, swept
    parabolic tip (leading edge recedes over the last 0.42 m, trailing edge straight)."""
    c0 = ROTOR_CHORD
    pitch = Matrix.Rotation(math.radians(2.5), 3, 'X')
    cone = Matrix.Rotation(math.radians(-1.3), 3, 'Y')
    spin = Matrix.Rotation(az, 3, 'Z')
    r_tip0 = ROTOR_R - 0.42

    def sect(r, n=14):
        u = min(1.0, max(0.0, (r - 0.20) / 0.36))
        sm = u * u * (3 - 2 * u)
        tc = lerp(0.42, 0.12, sm)
        c = lerp(0.085, c0, sm)
        y_le = 0.25 * c
        y_te = -0.75 * c
        if r > r_tip0:
            v = (r - r_tip0) / (ROTOR_R - r_tip0)
            y_le = 0.25 * c0 - (c0 - 0.06) * v ** 1.8
            y_te = -0.75 * c0 + 0.03 * max(0.0, (v - 0.75) / 0.25) ** 2
            tc = lerp(0.12, 0.10, v)
        cc = max(y_le - y_te, 0.01)
        ring = []
        for s, tz in airfoil_ring(n, tc, te_min=0.0035):
            p = pitch @ Vector((0.0, y_le - s * cc, tz * cc))
            ring.append(HUB + spin @ (cone @ Vector((r, p.y, p.z))))
        return ring
    rs = [0.16, 0.22, 0.28, 0.34, 0.40, 0.47, 0.56] + [lerp(0.56, r_tip0, k / 8) for k in range(1, 9)] + \
         [r_tip0 + (ROTOR_R - 0.012 - r_tip0) * k / 8 for k in range(1, 9)]
    mb.loft([sect(r) for r in rs], 'Rotor_Blade', closed=True, cap0=True)
    # rounded tip cap
    last = sect(ROTOR_R - 0.012)
    ctr = sum(last, Vector()) / len(last)
    mb.loft([last, [ctr + (spin @ (cone @ Vector((1.0, 0.0, 0.0)))) * 0.012]], 'Rotor_Blade', closed=True)


def build_rotor():
    K.ensure_materials()
    mb = MB('rotor')
    for b in range(ROTOR_N):
        _rotor_blade(mb, TAU * b / ROTOR_N)
    # hub star under the dome
    for b in range(ROTOR_N):
        a = TAU * b / ROTOR_N
        d = V(math.cos(a), math.sin(a), 0)
        mb.box(HUB + d * 0.13 - V(0, 0, 0.005), (0.24, 0.10, 0.045), 'Engine_Dark', bevel=0.008, segs=1,
               rot=Euler((0, 0, a)))
    mb.lathe([(0.0, DOME_Z0 - 0.03), (0.21, DOME_Z0 - 0.03), (0.22, DOME_Z0 - 0.02), (0.0, DOME_Z0 - 0.02)],
             V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Engine_Dark', n=48)
    # domed hub cap: pearl, cyan ring at its skirt, graphite tip
    prof = [(0.0, DOME_Z0 - 0.022), (DOME_R - 0.01, DOME_Z0 - 0.022), (DOME_R, DOME_Z0 - 0.012),
            (DOME_R, DOME_Z0)]
    for k in range(1, 15):
        t = 0.5 * math.pi * k / 14
        prof.append((DOME_R * math.cos(t) ** (2 / 2.3), DOME_Z0 + DOME_H * math.sin(t) ** (2 / 2.6)))
    mb.lathe(prof, V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Paint_White', n=48)
    mb.lathe([(DOME_R + 0.0015, DOME_Z0 - 0.0105), (DOME_R + 0.0015, DOME_Z0 - 0.0015)],
             V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Accent_Cyan', n=48)
    mb.lathe([(0.0, DOME_Z0 + DOME_H + 0.004), (0.035, DOME_Z0 + DOME_H - 0.001), (0.045, DOME_Z0 + DOME_H - 0.006)],
             V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Paint_Dark', n=24)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------------------------------
# ducted fan
# ---------------------------------------------------------------------------------------------------
def build_fan():
    """`prop`: hub drum + 7 swept carbon blades, origin on the hub centre, axis X."""
    mb = MB('prop')
    c = PROP
    ax = V(1, 0, 0)
    mb.lathe([(0.0, 0.037), (HUB_R - 0.003, 0.037), (HUB_R, 0.033), (HUB_R, -0.052), (HUB_R - 0.003, -0.056),
              (0.0, -0.056)], c, ax, 'Carbon', n=56)
    for k in range(10):         # retaining bolts on the drum front face
        a = TAU * k / 10
        p = c + V(0.037, math.cos(a) * 0.11, math.sin(a) * 0.11)
        mb.cyl(p, p + V(0.004, 0, 0), 0.007, 'Metal_Frame', n=6)
    pitch = 1.45
    rs = [0.150, 0.175, 0.21, 0.26, 0.32, 0.38, 0.44, 0.50, 0.555, 0.60, 0.63, FAN_R]
    rings = []
    for r in rs:
        u = max(0.0, (r - HUB_R) / (FAN_R - HUB_R))
        cc = lerp(0.128, 0.102, u)
        tc = lerp(0.12, 0.065, u)
        beta = math.atan(pitch / (TAU * r))
        sweep = -0.065 * u ** 2
        ring = []
        for sc, tz in airfoil_ring(10, tc, m=0.03, p=0.4, te_min=0.0025):
            ch = (0.35 - sc) * cc
            th = tz * cc
            ring.append(c + V(ch * math.sin(beta) + th * math.cos(beta), ch * math.cos(beta) - th * math.sin(beta) + sweep, r))
        rings.append(ring)
    bm = mb.bm
    f0 = set(bm.faces)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    blade = list(set(bm.faces) - f0)
    verts = list({v for f in blade for v in f.verts})
    edges = list({e for f in blade for e in f.edges})
    for k in range(1, FAN_N):
        ret = bmesh.ops.duplicate(bm, geom=verts + edges + blade)
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=c, matrix=Matrix.Rotation(TAU * k / FAN_N, 3, 'X'))
    return mb.finish(origin=c, sharp_angle=50, merge=1e-5)


def build_duct():
    mb = MB('duct')
    ss = [0.0, 0.003, 0.008, 0.015, 0.025, 0.04, 0.06, 0.09, 0.13, 0.18, 0.24, 0.30, 0.36, 0.45, 0.55, 0.65,
          0.75, 0.85, 0.93, 1.0]
    outer = [(duct_r(s, True), s * D_C) for s in ss]
    inner = [(duct_r(s, False), s * D_C) for s in ss]
    prof = outer[::-1] + inner[1:]
    axis_p = R(D_LE, FAN_Z)
    mb.lathe(prof, axis_p, V(-1, 0, 0), DUCT_MAT, n=112, closed_profile=True)
    ob = mb.finish(sharp_angle=50)

    def s_of(c):
        return min(max((axis_p.x - c.x) / D_C, 0.0), 1.0)

    def is_inner(c):
        return math.hypot(c.y, c.z - axis_p.z) < F_DRM(s_of(c)) - 1e-5
    K.repaint(ob, is_inner, 'Carbon')
    K.repaint(ob, lambda c: (not is_inner(c)) and 0.003 < s_of(c) < 0.025, 'Accent_Cyan')
    return ob


def vane(mb, phi, r0, r1, le, te, t, mat='Carbon', twist=0.0):
    """Radial stator vane in the duct at roll angle phi (0 = +Y), from radius r0 to r1."""
    er = V(0, math.cos(phi), math.sin(phi))
    et = V(0, -math.sin(phi), math.cos(phi))
    axis = R(0.0, FAN_Z)
    rings = []
    for r in (r0, lerp(r0, r1, 0.5), r1):
        c = le - te
        ring = []
        for s, tz in airfoil_ring(12, t, te_min=0.003):
            X = le - s * c
            off = tz * c + (s - 0.5) * c * math.tan(math.radians(twist))
            ring.append(V(R.x(X), 0, 0) + V(0, axis.y, axis.z) + er * r + et * off)
        rings.append(ring)
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True)


def build_tail():
    mb = MB('tail')
    # pointed tail cone behind the fan (static stator hub)
    cb = MB('tail_cone')
    x0 = FAN_X - 0.06
    prof = [(0.0, 0.0)] + [(cone_r(x0 - (x0 - CONE_TIP) * k / 18), (x0 - CONE_TIP) * k / 18) for k in range(19)]
    cb.lathe(prof, R(x0, FAN_Z), V(-1, 0, 0), 'Paint_Dark', n=48)
    # four diagonal stators behind the fan (the stabiliser and the vertical vanes make the other four)
    for k in range(4):
        vane(mb, math.radians(45 + 90 * k), HUB_R - 0.02, 0.672, VANE_LE, VANE_LE - 0.11, 0.08, twist=8.0)
    # horizontal stabiliser through the duct exit (carbon inside, pearl outside); its root runs on through
    # the slot of the rudder
    loop = airfoil_ring(14, 0.10, te_min=0.002)
    ys = [-SPAN, -1.06, -1.0, -0.9, -0.80, -0.735, -0.66, -0.5, -0.3, -0.12, 0.0, 0.12, 0.3, 0.5, 0.66, 0.735,
          0.80, 0.9, 1.0, 1.06, SPAN]
    rings = []
    for y in ys:
        u = abs(y) / SPAN
        le, te = lerp(STAB_LE0, STAB_LE1, u ** 1.3), lerp(STAB_TE0, STAB_TE1, u)
        ch = le - te
        rings.append([R(le - s * ch, FAN_Z + tz * ch, y) for s, tz in loop])
    f0 = set(mb.bm.faces)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    for f in set(mb.bm.faces) - f0:
        c = f.calc_center_median()
        if abs(c.y) < 0.70 and c.x > R.x(D_TE - 0.01):
            f.material_index = mb.mi('Carbon')
    # outward-canted end fins on the stabiliser tips (most of the vertical area)
    zs = [lerp(EF_BOT, EF_TOP, t) for t in (0.0, 0.012, 0.04, 0.09, 0.16, 0.26, 0.378, 0.45, 0.58, 0.7, 0.8, 0.88,
                                            0.94, 0.975, 0.993, 1.0)]

    def ef_t(z):
        return (z - R.dz - EF_BOT) / (EF_TOP - EF_BOT)
    tan_c = math.tan(math.radians(EF_CANT))
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], lambda z: R.x(ef_le(ef_t(z))), lambda z: R.x(ef_te(ef_t(z))),
                   y_fn=lambda z, sy=sy: sy * (SPAN - 0.012 + (z - R.dz - FAN_Z) * tan_c), t=0.085, mat='Paint_White')
    # fixed vertical stators on the centreline, ahead of the rudder (front part of the vane+rudder airfoil)
    s_end = lambda z: (rud_le(z) - R.x(VANE_TE)) / (rud_le(z) - R.x(RUD_TE))   # noqa: E731
    zs = [FAN_Z + h for h in (0.05, 0.12, 0.25, 0.40, 0.55, 0.63, 0.66, 0.69)]
    E.fin_loft(mb, [R.z(z) for z in zs], rud_le, lambda z: R.x(RUD_TE), t=FIN_T, mat='Paint_White', s_end_fn=s_end)
    # lower stator + ventral fin under the duct with the skid
    zv = FAN_Z - 0.663                       # just inside the duct's lower wall

    def v_le(z):
        Z = z - R.dz
        if Z > zv - 0.01:
            return R.x(VANE_LE)
        return R.x(lerp(VANE_LE, -2.15, ((zv - Z) / (zv - Z_SKID)) ** 0.8))

    def v_te(z):
        Z = z - R.dz
        if Z > zv - 0.01:
            return R.x(RUD_TE)
        return R.x(lerp(-2.27, -2.30, (zv - Z) / (zv - Z_SKID)))

    def v_send(z):
        return s_end(z) if z - R.dz > zv - 0.01 else 1.0
    zs = [Z_SKID + 0.003, Z_SKID + 0.015, -2.34, zv - 0.02, zv, -2.20, FAN_Z - 0.40, FAN_Z - 0.15, FAN_Z - 0.05]
    E.fin_loft(mb, [R.z(z) for z in zs], v_le, v_te, t=FIN_T, mat='Paint_White', s_end_fn=v_send)
    tail = mb.finish(sharp_angle=45)
    # carbon stators inside the duct, pearl outside
    axis = R(0.0, FAN_Z)

    def in_duct(c):
        X = c.x - R.dx
        if not (D_TE - 0.002 < X < D_LE) or abs(c.y) > 0.70:
            return False
        return math.hypot(c.y, c.z - axis.z) < F_DRM((D_LE - X) / D_C) - 0.002
    K.repaint(tail, in_duct, 'Carbon')
    cone = cb.finish(sharp_angle=50)
    # skid shoe
    sk = MB('skid')
    p0, p1 = R(-2.14, Z_SKID + 0.012), R(-2.28, Z_SKID + 0.016)
    sk.tube(catmull([p0 + V(0.03, 0, 0.03), p0, lerp(p0, p1, 0.5) - V(0, 0, 0.003), p1, p1 + V(-0.02, 0, 0.03)], 4),
            0.0, 'Alu_Black', n=12, square=(0.032, 0.026, 3.0), cap=True)
    return tail, B.join_objects('tail_parts', [sk.finish(sharp_angle=45), cone])


def rudder_blade(mb, zs, hinge_x, t, mat):
    """Aft part (hinge -> TE) of the vane+rudder airfoil, rounded nose round the hinge (like
    build_ela.build_rudder_surface, without the hinge brackets that would sweep into the fixed vane)."""
    rings = []
    for z in zs:
        lx, tx = rud_le(z), rud_te(z)
        cfull = lx - tx
        s_h = (lx - hinge_x) / cfull
        n = 12
        upper, lower = [], []
        for i in range(n + 1):
            s0 = s_h + 0.004 / cfull
            s = s0 + (1 - s0) * (i / n) ** 1.2
            yt = max(naca4(s, t)[1], 0.0012) * cfull
            upper.append(V(lx - s * cfull, yt, z))
            lower.append(V(lx - s * cfull, -yt, z))
        r0 = upper[0].y
        nose = [V(hinge_x - 0.004 + math.sin(math.pi * j / 6) * r0 * 0.9, math.cos(math.pi * j / 6) * r0, z)
                for j in range(1, 6)]
        rings.append(upper + lower[::-1] + nose[::-1])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True)


def build_rudder():
    """Rudder = one vertical vane in the fan jet inside the duct exit, hinge vertical on the centreline: two
    blades on a common torque tube, with a slot round the pointed tail cone and the stabiliser root; the tips
    follow the duct's inner wall 14 mm off it. Node origin on the hinge line at the fan axis."""
    origin = R(HINGE, FAN_Z)
    mb = MB('rudder')
    hs = [RUD_H0, RUD_H0 + 0.01, RUD_H0 + 0.03, 0.18, 0.28, 0.38, 0.48, RUD_H - 0.05, RUD_H - 0.03, RUD_H - 0.013,
          RUD_H - 0.004, RUD_H]
    for sgn in (1, -1):
        zs = sorted(R.z(FAN_Z + sgn * h) for h in hs)
        rudder_blade(mb, zs, R.x(HINGE), FIN_T, 'Paint_White')
    # torque tube through the cone joining the blades, actuator horn at its foot (inside the cone)
    mb.cyl(R(HINGE, FAN_Z - RUD_H0 - 0.01), R(HINGE, FAN_Z + RUD_H0 + 0.01), 0.008, 'Metal_Frame', n=12)
    return mb.finish(origin=origin, sharp_angle=45)


# ---------------------------------------------------------------------------------------------------
# landing gear
# ---------------------------------------------------------------------------------------------------
def split_paint(ob, z):
    """Graphite below the model height z, with a crisp line (bisect first)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6, plane_co=V(0, 0, z),
                           plane_no=V(0, 0, 1))
    bm.to_mesh(ob.data)
    bm.free()
    K.repaint(ob, lambda p: p.z < z, 'Paint_Dark')


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # slim carbon spring leg: from the belly out and down into the wheel pod
        pts = [R(-0.555, -2.40, sy * 0.06), R(-0.56, -2.44, sy * 0.24), R(-0.565, -2.475, sy * 0.45),
               R(-0.575, -2.515, sy * 0.62), V(ax.x, sy * (MAIN_Y - 0.085), ax.z + 0.04)]
        K.leg_blade(mb, pts, chord=0.095, thick=0.026, mat='Carbon', n=20)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.105), ax.z), V(ax.x, sy * (MAIN_Y + 0.065), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.074), ax.z), V(ax.x, sy * (MAIN_Y - 0.066), ax.z), 0.090, 'Metal_Frame', n=28)
        mb.box(V(ax.x + 0.075, sy * (MAIN_Y - 0.072), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008, segs=1)
        # boarding step clamped on the spring leg
        st = R(-0.565, -2.47, sy * 0.40)
        mb.box(st + V(0.0, 0, 0.022), (0.03, 0.03, 0.05), 'Alu_Black', bevel=0.006, segs=1)
        mb.box(st + V(0.08, 0, 0.045), (0.13, 0.085, 0.010), 'Alu_Black', bevel=0.004, segs=1)
        for k in range(4):
            mb.box(st + V(0.035 + 0.03 * k, 0, 0.0515), (0.010, 0.075, 0.003), 'Rubber', bevel=0.001, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        sp = K.spat(name, c, R=R_MAIN, front=0.40, back=0.52, hw=0.092, top=0.04, lift=0.03, mat='Paint_White',
                    tail_up=0.05, exp_top=2.3, belly=0.62)
        split_paint(sp, c.z - 0.005)
        spats.append(sp)
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=R_MAIN, w=W_MAIN)
    # nose wheel: fork + leg into the nose, a pant on the fork (steers with the wheel)
    nc = R(NOSE[0], NOSE[1])
    nose = K.nose_gear(nc, R=R_NOSE, w=W_NOSE, leg_top=R.z(pod(NOSE[0])['zb'] + 0.06), rake=-0.02)
    pant = K.spat('nose_pant', nc, R=R_NOSE, front=0.27, back=0.34, hw=0.086, top=0.035, lift=0.03,
                  mat='Paint_White', tail_up=0.02, exp_top=2.3, belly=0.62)
    split_paint(pant, nc.z - 0.005)
    B.join_objects('nose_wheel', [nose, pant])
    return gear, spats


# ---------------------------------------------------------------------------------------------------
# cockpit
# ---------------------------------------------------------------------------------------------------
F_SW = B.hermite([0.0, 0.15, 0.45, 0.62, 0.70, 0.76, 0.84, 1.0], [0.40, 0.40, 0.42, 0.44, 0.34, 0.25, 0.27, 0.26])
F_SD = B.hermite([0.0, 0.25, 0.55, 0.68, 0.76, 0.86, 1.0], [0.06, 0.11, 0.09, 0.04, 0.03, 0.07, 0.05])


def sport_seat(mb, hip, back_deg, width=0.44, back_h=0.84, pan_len=0.46, screen=False):
    """One-piece carbon sport seat: dished pan with thigh bolsters, back shell with side bolsters and an
    integral headrest, padded inserts. screen=True: a small display on the back of the headrest."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    ks = width / 0.44
    pr = Euler((0, math.radians(-9), 0))
    pc = V(hip.x + 0.10, hip.y, hip.z - 0.115)
    mb.box(pc, (pan_len, width - 0.08, 0.05), 'Seat', bevel=0.02, segs=2, rot=pr)
    mb.box(pc - V(0.0, 0, 0.045), (pan_len + 0.03, width, 0.045), 'Carbon', bevel=0.015, segs=2, rot=pr)
    for sy in (1, -1):
        mb.box(pc + V(0.02, sy * (width * 0.5 - 0.022), 0.03), (pan_len - 0.04, 0.045, 0.075), 'Carbon',
               bevel=0.018, segs=2, rot=pr)
    rings = []
    N = 16
    for k in range(N + 1):
        t = k / N
        cc = hip - f * 0.17 + u * (back_h * t)
        w = F_SW(t) * ks * 0.5
        d = F_SD(t)
        inner, outer = [], []
        for j in range(15):
            a = math.pi * j / 14
            ca, sa = math.cos(a), math.sin(a)
            inner.append(cc + V(0, ca * w, 0) - f * (0.03 * sa) + f * (d * abs(ca) ** 5))
        for j in range(14, -1, -1):
            a = math.pi * j / 14
            ca, sa = math.cos(a), math.sin(a)
            outer.append(cc + V(0, ca * (w + 0.012), 0) - f * (0.03 * sa + 0.026) + f * (d * abs(ca) ** 5 - 0.004))
        rings.append(inner + outer)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    mb.box(hip - f * 0.185 + u * (back_h * 0.33), (0.026, width * 0.66, back_h * 0.50), 'Seat', bevel=0.012, segs=2,
           rot=rb)
    mb.box(hip - f * 0.185 + u * (back_h * 0.89), (0.026, 0.19 * ks, 0.11), 'Seat', bevel=0.012, segs=2, rot=rb)
    if screen:
        sc = hip - f * (0.17 + 0.03 + 0.026 + 0.010) + u * (back_h * 0.86)
        mb.box(sc, (0.016, 0.20, 0.115), 'Panel', bevel=0.006, segs=2, rot=rb)
        mb.box(sc - f * 0.0085, (0.002, 0.18, 0.096), 'Visor', rot=rb)


def build_cockpit(pod_ob):
    """Returns (front seat, rear seat, floor + bulkhead + consoles) as separate objects (clearance)."""
    sf = MB('seat_front')
    sport_seat(sf, FRONT_HIP, FRONT_BACK, width=0.42, back_h=0.84, screen=True)
    sr = MB('seat_rear')
    sport_seat(sr, REAR_HIP, REAR_BACK, width=0.46, back_h=0.84)
    mb = MB('cockpit')
    # floor following the belly
    xs = [lerp(-0.26, 1.93, k / 40) for k in range(41)]
    rings = []
    for X in xs:
        zf = max(FLOOR_Z, pod(X)['zb'] + 0.035)
        hw = max(hull_y(X, zf) - 0.03, 0.02)
        rings.append([R(X, zf, hw), R(X, zf, -hw), R(X, zf - 0.008, -hw), R(X, zf - 0.008, hw)])
    mb.loft(rings, 'Interior', closed=True, cap0=True, cap1=True, smooth=False)
    # rear bulkhead behind the passenger (closes the engine bay)
    X = -0.29
    ring = [p + V(0, 0, 0) for p in pod_ring(X)]
    c = R(X, 0.5 * (pod(X)['zt'] + pod(X)['zb']))
    ring = [c + (p - c) * 0.965 for p in ring]
    mb.loft([ring, [p + V(-0.02, 0, 0) for p in ring]], 'Interior', closed=True, cap0=True, cap1=True)
    # side consoles (arm rests; throttle quadrant on the left one)
    for sy in (1, -1):
        for x0, x1, zc, yi in ((0.90, 1.38, -2.14, 0.335), (-0.02, 0.42, -2.12, 0.36)):
            Xc = 0.5 * (x0 + x1)
            yw = hull_y(Xc, zc) - 0.02
            mb.box(R(Xc, zc, sy * 0.5 * (yi + yw)), (x1 - x0, yw - yi, 0.045), 'Carbon', bevel=0.012, segs=2)
    # passenger foot rests either side of the front seat
    for sy in (1, -1):
        mb.box(R(0.76, -2.367, sy * 0.27), (0.22, 0.10, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    return sf.finish(sharp_angle=40, wn=True), sr.finish(sharp_angle=40, wn=True), mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------------------------------
# details and lights
# ---------------------------------------------------------------------------------------------------
def hit(ob, p, n):
    n = Vector(n).normalized()
    inv = ob.matrix_world.inverted()
    ok, loc, nn, _i = ob.ray_cast(inv @ (Vector(p) + n * 0.6), inv.to_3x3() @ (-n), distance=1.2)
    if not ok:
        raise RuntimeError('ray missed at %s' % (tuple(p),))
    return ob.matrix_world @ loc, (ob.matrix_world.to_3x3() @ nn).normalized()


def surface_strip(mb, target, pts_dir, half_h, mat, lift, up=V(0, 0, 1)):
    """Strip on target: pts_dir = [(point, outward dir)], height 2*half_h along `up`."""
    lo, hi = [], []
    for p, d in pts_dir:
        a, na = hit(target, p - up * half_h, d)
        b, nb = hit(target, p + up * half_h, d)
        lo.append(a + na * lift)
        hi.append(b + nb * lift)
    n = len(lo)
    mb.faces(lo + hi, [[k, k + 1, n + k + 1, n + k] for k in range(n - 1)], mat)
    return lo, hi


def build_details(pod_ob):
    det = MB('details')
    # --- LED landing bar across the nose (two lamps at its ends)
    zb = ZN + 0.035
    pts = []
    for k in range(17):
        y = lerp(-0.15, 0.15, k / 16)
        pts.append((R(XN, zb, y), V(1, y * 1.6, 0)))
    surface_strip(det, pod_ob, pts, 0.017, 'Paint_Dark', 0.0012)
    surface_strip(det, pod_ob, pts[1:-1], 0.0085, 'Lens_White', 0.0028)
    for sy, tag in ((1, 'L'), (-1, 'R')):
        p, n = hit(pod_ob, R(XN, zb, sy * 0.11), V(1, sy * 0.18, 0))
        K.lamp_node('landing', p + n * 0.03, tag)
    # --- red beacon on the tail of the rotor-head fairing
    bp = R(HF_X1 + 0.045, hf_zc(HF_X1 + 0.045) + hf_r(HF_X1 + 0.045) * 0.55)
    K.lamp(det, bp, (-0.35, 0, 1), kind='red', r=0.016, length=0.022)
    K.lamp_node('beacon', bp + V(-0.01, 0, 0.035), 'red')
    # --- NACA intakes (engine air) on both flanks behind the canopy, outlet gills on the lower tail cone
    for sy in (1, -1):
        X0, Z0 = -0.62, -1.72
        p, n = hit(pod_ob, R(X0, Z0, sy * hull_y(X0, Z0)), V(0, sy, 0))
        ring_o, ring_i = [], []
        for k in range(20):
            t = k / 19
            X = lerp(X0 + 0.09, X0 - 0.13, t)
            hw = lerp(0.010, 0.032, t ** 0.8)
            ring_o.append((X, hw))
        poly = [(X, Z0 + hw) for X, hw in ring_o] + [(X, Z0 - hw) for X, hw in reversed(ring_o)]
        rings3 = []
        for sc in (1.0, 0.66, 0.33):
            ring3 = []
            for X, Z in poly:
                Xs, Zs = X0 - 0.02 + (X - X0 + 0.02) * sc, Z0 + (Z - Z0) * sc
                q, nq = hit(pod_ob, R(Xs, Zs, sy * hull_y(Xs, Zs)), V(0, sy, 0))
                ring3.append(q + nq * 0.0015)
            rings3.append(ring3)
        q, nq = hit(pod_ob, R(X0 - 0.02, Z0, sy * hull_y(X0 - 0.02, Z0)), V(0, sy, 0))
        det.loft(rings3 + [[q + nq * 0.0015]], 'Radiator', closed=True)
        # the intake lip: a thin pearl ramp edge at its wide aft end
        lip = []
        for k in range(9):
            Z = lerp(Z0 - 0.030, Z0 + 0.030, k / 8)
            q, nq = hit(pod_ob, R(X0 - 0.135, Z, sy * hull_y(X0 - 0.135, Z)), V(0, sy, 0))
            lip.append(q + nq * 0.004)
        det.tube(lip, 0.0, 'Paint_White', n=8, square=(0.012, 0.006, 4.0), cap=True)
        K.louvres(det, pod_ob, R(-1.25, -2.02, sy * hull_y(-1.25, -2.02)), V(0, sy, -0.35), V(1, 0, 0.28), count=4,
                  length=0.14, pitch=0.030, depth=0.008, mat='Radiator', body_mat='Paint_Dark')
        # static port
        q, nq = hit(pod_ob, R(1.35, -2.06, sy * hull_y(1.35, -2.06)), V(0, sy, 0))
        det.cyl(q - nq * 0.002, q + nq * 0.002, 0.008, 'Chrome', n=10)
    # flush canopy latch handles on both sills (the canopy halves hinge on the spine)
    for sy in (1, -1):
        X0, Z0 = 0.62, -2.035
        pts = []
        for k in range(7):
            X = X0 + 0.07 * (k / 6 - 0.5)
            q, nq = hit(pod_ob, R(X, Z0, sy * hull_y(X, Z0)), V(0, sy, 0))
            pts.append(q + nq * 0.004)
        det.tube(pts, 0.0, 'Paint_Dark', n=10, square=(0.022, 0.008, 4.0), cap=True)
    # charge / fuel port on the left flank
    q, nq = hit(pod_ob, R(-0.40, -1.47, hull_y(-0.40, -1.47)), V(0, 1, 0))
    det.lathe([(0.0, 0.003), (0.030, 0.003), (0.034, 0.0), (0.034, -0.004)], q, nq, 'Paint_Dark', n=24)
    det.lathe([(0.0, 0.0035), (0.012, 0.0035), (0.0125, 0.0)], q, nq, 'Accent_Cyan', n=16)
    # pitot under the nose, belly antenna
    K.pitot(det, R(2.30, -2.205, -0.10), (1, 0, -0.05), length=0.09, r=0.005)
    K.antenna(det, R(0.25, -2.474), (-0.45, 0, -1), length=0.14, mat='Paint_Dark')
    return det


def build_tail_lights(det):
    """Nav LED strips on the end-fin leading edges (red left, green right), white strobes on the end-fin
    tops, white tail LEDs on their trailing edges."""
    tan_c = math.tan(math.radians(EF_CANT))
    for sy, kind, lens in ((1, 'navL', 'Lens_Red'), (-1, 'navR', 'Lens_Green')):
        def y_at(Z):
            return sy * (SPAN - 0.012 + (Z - FAN_Z) * tan_c)
        nrm = V(0, sy * math.cos(math.radians(EF_CANT)), -math.sin(math.radians(EF_CANT)))
        pts = []
        for k in range(9):
            t = lerp(0.45, 0.74, k / 8)
            Z = lerp(EF_BOT, EF_TOP, t)
            pts.append(R(ef_le(t) - 0.002, Z, y_at(Z)))
        det.tube(pts, 0.0, lens, n=10, square=(0.017, 0.011, 4.0), cap=True)
        mid = pts[4]
        K.lamp_node(kind, mid + V(0.028, 0, 0) + nrm * 0.012)
        # strobe on the top
        Zt = EF_TOP
        top = R(0.5 * (ef_le(1.0) + ef_te(1.0)), Zt - 0.004, y_at(Zt))
        d = V(0, sy * math.sin(math.radians(EF_CANT)), math.cos(math.radians(EF_CANT)))
        K.lamp(det, top, d, kind='white', r=0.013, length=0.018, base='Paint_Dark')
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', top + d * 0.035)
        # tail LED on the trailing edge just under the top
        Zb = lerp(EF_BOT, EF_TOP, 0.84)
        tb = R(ef_te(0.84) + 0.006, Zb, y_at(Zb))
        K.lamp(det, tb, (-1, 0, 0), kind='white', r=0.009, length=0.012, base='Paint_Dark')
        K.lamp_node('tail', tb + V(-0.03, 0, 0), 'L' if sy > 0 else 'R')


# ---------------------------------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------------------------------
def build_vencejo():
    vx_materials()
    pod_ob = build_pod()
    det = build_details(pod_ob)
    build_tail_lights(det)
    canopy, cframe, cseal = split_canopy(pod_ob)
    mark_chine(pod_ob)
    spine = build_spine()
    pylon = build_pylon()
    hfair = build_head_fairing(det)
    build_head()
    build_rotor()
    build_fan()
    duct = build_duct()
    tail, skid = build_tail()
    build_rudder()
    gear, spats = build_gear()
    seat_f, seat_r, cockpit = build_cockpit(pod_ob)
    reg = E.build_registration(pod_ob, REG, cx=R.x(-1.20), cz=R.z(-1.585), size=0.105, mat='Paint_Dark')

    # ---- controls and crew: pilot in the front seat, throttle on the left console
    ctrl = MB('controls_static')
    stick_base = R(1.31, FLOOR_Z + 0.005)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.335, -1.885))
    knob, lever = controls.throttle_lever(ctrl, R(1.08, -2.083, 0.33))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.79, -2.19, 0.12), 'R': R(1.79, -2.19, -0.12)}, knee_out=0.05,
                      elbow_out=0.10, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(max(FLOOR_Z, pod(1.88)['zb'] + 0.035)))
    PANEL.build_panel(ctrl, PANEL_P0, PANEL_TILT, [pod_ob, canopy], zone=(0.0, 0.05, 0.44, 0.15), cw=0.062,
                      v_leg=-0.05, v_sb=-0.21, v_b=-0.32, top_arch=(0.36, 0.11, 0.15), max_u=0.34, leg_exp=0.3)
    t = math.radians(PANEL_TILT)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    ctrl.box(PANEL_P0 + upv * 0.165 - nrm * 0.065, (0.15, 0.58, 0.016), 'Carbon', bevel=0.007, segs=2,
             rot=K.rot_y(-6))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.25, -0.13, 0.13), None),
                             'L': ('rest', REAR_HIP + V(0.25, 0.13, 0.13), None)},
                      feet={'L': R(0.76, -2.25, 0.27), 'R': R(0.76, -2.25, -0.27)}, knee_out=0.12, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    eye = eye_point()
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod_ob, cockpit, seat_r, canopy,
                                  bpy.data.objects.get('stick')], ' (pilot)')
    K.clearance(['pilot_rear'], [pod_ob, cockpit, seat_f, ctrl, canopy], ' (passenger)')
    det = det.finish(sharp_angle=50)
    K.finalize([pod_ob, cframe, cseal, spine, pylon, hfair, duct, tail, skid, gear, cockpit, seat_f, seat_r, ctrl, det]
               + spats + reg, [canopy])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, FAN_Z),
        'stick': stick_base, 'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })
    geometry_sheet(eye, stick_base)


# ---------------------------------------------------------------------------------------------------
# flight-geometry sheet (MODEL coordinates: x forward, y up, z right)
# ---------------------------------------------------------------------------------------------------
def g(X, Z, y=0.0):
    p = R(X, Z, y)
    return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)


def _integrate(f, a, b, n=400):
    h = (b - a) / n
    return sum(f(a + (k + 0.5) * h) for k in range(n)) * h


def geometry_sheet(eye, stick_base):
    gz = GROUND
    print('VX ---- flight geometry (model x fwd, y up, z right) ----')
    print('VX hub %s  head pivot %s  CG %s' % (g(0, 0), g(0, -0.20), g(CG[0], CG[1])))
    print('VX fan centre %s  R %.3f  blades %d  duct OD %.3f chord %.2f' % (g(FAN_X, FAN_Z), FAN_R, FAN_N,
                                                                            2 * max(duct_r(s / 100) for s in range(101)), D_C))
    print('VX nose wheel contact %s  R %.3f' % (g(NOSE[0], gz), R_NOSE))
    print('VX main contacts %s %s  R %.3f  track %.2f  wheelbase %.2f' % (
        g(AXLE[0], gz, MAIN_Y), g(AXLE[0], gz, -MAIN_Y), R_MAIN, 2 * MAIN_Y, NOSE[0] - AXLE[0]))
    print('VX ground y %.3f  axle y %.3f  skid %s  duct bottom %s' % (R.z(gz), R.z(AXLE[1]), g(-2.22, Z_SKID),
                                                                       g(D_LE - 0.07, D_BOT)))
    # stabiliser
    def ch(y):
        u = abs(y) / SPAN
        return lerp(STAB_LE0, STAB_LE1, u ** 1.3) - lerp(STAB_TE0, STAB_TE1, u)

    def le(y):
        return lerp(STAB_LE0, STAB_LE1, (abs(y) / SPAN) ** 1.3)
    S = _integrate(ch, -SPAN, SPAN)
    mac = _integrate(lambda y: ch(y) ** 2, -SPAN, SPAN) / S
    xq = _integrate(lambda y: ch(y) * (le(y) - 0.25 * ch(y)), -SPAN, SPAN) / S
    print('VX stab span %.3f area %.3f MAC %.3f  25%%MAC at %s' % (2 * SPAN, S, mac, g(xq, FAN_Z)))
    # vertical surfaces (side projection)
    def band(fle, fte, z0, z1, n=300):
        h = (z1 - z0) / n
        A = M = Zm = 0.0
        for k in range(n):
            z = z0 + (k + 0.5) * h
            l, t = fle(z), fte(z)
            c = max(l - t, 0.0)
            A += c * h
            M += c * 0.5 * (l + t) * h
            Zm += c * z * h
        return A, M, Zm
    rt = lambda Z: rud_te(R.z(Z)) - R.dx  # noqa: E731
    zv = FAN_Z - 0.663
    parts = {}
    parts['rudder upper blade'] = band(lambda Z: HINGE, rt, FAN_Z + RUD_H0, FAN_Z + RUD_H)
    parts['rudder lower blade'] = band(lambda Z: HINGE, rt, FAN_Z - RUD_H, FAN_Z - RUD_H0)
    parts['upper stator ahead of rudder'] = band(lambda Z: VANE_LE, lambda Z: VANE_TE, FAN_Z + 0.13, FAN_Z + 0.66)
    parts['lower stator ahead of rudder'] = band(lambda Z: VANE_LE, lambda Z: VANE_TE, FAN_Z - 0.66, FAN_Z - 0.13)
    parts['ventral fin'] = band(lambda Z: lerp(VANE_LE, -2.15, ((zv - Z) / (zv - Z_SKID)) ** 0.8),
                                lambda Z: lerp(-2.27, -2.30, (zv - Z) / (zv - Z_SKID)), Z_SKID, FAN_Z - 0.70)
    cosc = math.cos(math.radians(EF_CANT))
    efa = band(lambda Z: ef_le((Z - EF_BOT) / (EF_TOP - EF_BOT)),
               lambda Z: ef_te((Z - EF_BOT) / (EF_TOP - EF_BOT)), EF_BOT, EF_TOP)
    parts['end fins (x2, projected)'] = (2 * efa[0] * cosc, 2 * efa[1] * cosc, 2 * efa[2] * cosc)
    At = sum(p[0] for p in parts.values())
    xc = sum(p[1] for p in parts.values()) / At
    zc = sum(p[2] for p in parts.values()) / At
    for k, (A, M, Zm) in parts.items():
        print('VX   vertical %-30s %.3f m2  centroid %s' % (k, A, g(M / A, Zm / A)))
    ar = parts['rudder upper blade'][0] + parts['rudder lower blade'][0]
    print('VX vertical total %.3f m2 centroid %s ; rudder %.3f m2 ; duct side projection %.3f m2 (centre %s)' % (
        At, g(xc, zc), ar, 2 * 0.725 * D_C, g(D_LE - 0.5 * D_C, FAN_Z)))
    print('VX rudder hinge x %.3f, node origin %s, blades y %.3f..%.3f and %.3f..%.3f (slot for the cone), TE x %.3f'
          % (R.x(HINGE), g(HINGE, FAN_Z), R.z(FAN_Z + RUD_H0), R.z(FAN_Z + RUD_H), R.z(FAN_Z - RUD_H),
             R.z(FAN_Z - RUD_H0), R.x(RUD_TE)))
    print('VX end fins: top %.3f above stab, bottom %.3f below; cant %.0f deg out' % (EF_TOP - FAN_Z, FAN_Z - EF_BOT,
                                                                                     EF_CANT))
    print('VX eye %s  stick base %s' % ('(%.3f, %.3f, %.3f)' % (eye.x, eye.z, -eye.y),
                                         '(%.3f, %.3f, %.3f)' % (stick_base.x, stick_base.z, -stick_base.y)))
    tc = math.tan(math.radians(EF_CANT))
    y_top, y_bot = SPAN - 0.012 + (EF_TOP - FAN_Z) * tc, SPAN - 0.012 - (FAN_Z - EF_BOT) * tc
    x_top, x_bot = 0.5 * (ef_le(1.0) + ef_te(1.0)), 0.5 * (ef_le(0.0) + ef_te(0.0))
    pts = [('nose tip', XN, ZN, 0), ('nose low', 2.30, -2.215, 0), ('belly', 0.30, -2.475, 0),
           ('belly aft', -0.85, -2.365, 0), ('side left', 0.9, -2.14, 0.475), ('side right', 0.9, -2.14, -0.475),
           ('canopy top', 0.0, top_z(0.0), 0), ('pylon/head top', 0.0, hf_zc(0.0) + HF_RM, 0),
           ('rotor dome', 0.0, DOME_Z0 + DOME_H, 0), ('duct top', D_LE - 0.10, D_TOP, 0),
           ('duct bottom', D_LE - 0.07, D_BOT, 0), ('skid', -2.22, Z_SKID, 0),
           ('end fin top L', x_top, EF_TOP, y_top), ('end fin top R', x_top, EF_TOP, -y_top),
           ('end fin bottom L', x_bot, EF_BOT, y_bot), ('end fin bottom R', x_bot, EF_BOT, -y_bot),
           ('stab tip L', -2.29, FAN_Z, SPAN), ('stab tip R', -2.29, FAN_Z, -SPAN),
           ('duct side L', -2.0, FAN_Z, 0.728), ('duct side R', -2.0, FAN_Z, -0.728),
           ('wheel pod L', AXLE[0] - 0.40, AXLE[1] - 0.06, MAIN_Y), ('wheel pod R', AXLE[0] - 0.40, AXLE[1] - 0.06, -MAIN_Y)]
    for name, X, Z, y in pts:
        print('VX crash %-16s %s' % (name, g(X, Z, y)))
    # ---- design clearances: rotor disc tilted aft, tail-down on the main wheels
    for tilt in (TILT_CHECK, 14.2):
        tt = math.tan(math.radians(tilt))
        duct = min((X * tt - (FAN_Z + duct_r_at(X)), X) for X in [D_LE - D_C * k / 200 for k in range(201)])
        rud = min((X * tt - (FAN_Z + RUD_H), X) for X in [HINGE - (HINGE - RUD_TE) * k / 50 for k in range(51)])
        eft = min((X * tt - lerp(EF_BOT, EF_TOP, t), X) for t in [k / 100 for k in range(60, 101)]
                  for X in (ef_le(t), ef_te(t)))
        print('VX rotor %.1f deg aft: clearance duct top %.3f (x %.3f), rudder tip %.3f (x %.3f), end-fin top %.3f '
              '(x %.3f); no dorsal fairing' % (tilt, duct[0], R.x(duct[1]), rud[0], R.x(rud[1]), eft[0], R.x(eft[1])))
    td = math.tan(math.radians(TAILDOWN_MIN))
    for name, X, Z in (('skid', -2.22, Z_SKID - 0.001), ('duct bottom', D_LE - 0.07, D_BOT),
                       ('duct lip', D_TE, FAN_Z - duct_r(1.0)), ('end fin bottom', ef_te(0.0), EF_BOT)):
        print('VX tail-down: %-15s contact at %.1f deg (margin at %.0f deg %.3f m)' % (
            name, math.degrees(math.atan2(Z - GROUND, AXLE[0] - X)), TAILDOWN_MIN, (Z - GROUND) - (AXLE[0] - X) * td))
    # ---- the same, measured on every vertex of the built tail (airframe, rudder, fan)
    tt = math.tan(math.radians(TILT_CHECK))
    worst_c, worst_t = None, None
    for name in ('airframe', 'rudder', 'prop'):
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        mw = ob.matrix_world
        for v in ob.data.vertices:
            p = mw @ v.co
            X, Z = p.x - R.dx, p.z - R.dz
            if X < -1.5:
                c = X * tt - Z
                if worst_c is None or c < worst_c[0]:
                    worst_c = (c, name, p.copy())
            if X < AXLE[0] - 0.6:
                a = math.degrees(math.atan2(Z - GROUND, AXLE[0] - X))
                if worst_t is None or a < worst_t[0]:
                    worst_t = (a, name, p.copy())
    print('VX mesh check: min clearance under the %.0f-deg disc behind x=%.2f: %.3f m (%s at %s)' % (
        TILT_CHECK, R.x(-1.5), worst_c[0], worst_c[1], '(%.3f, %.3f, %.3f)' % (worst_c[2].x, worst_c[2].z, -worst_c[2].y)))
    print('VX mesh check: first tail contact on tail-down at %.1f deg (%s at %s)' % (
        worst_t[0], worst_t[1], '(%.3f, %.3f, %.3f)' % (worst_t[2].x, worst_t[2].z, -worst_t[2].y)))


# ---------------------------------------------------------------------------------------------------
# previews: per-view hidden objects and a dusk set-up
# ---------------------------------------------------------------------------------------------------
def render_previews(scn):
    B.setup_render(scn)
    coll, cam = B.setup_studio(scn)
    rotor = bpy.data.objects.get('rotor')
    prop = bpy.data.objects.get('prop')
    os.makedirs(B.PREVIEW_DIR, exist_ok=True)
    world = scn.world
    lights = [o for o in coll.objects if o.type == 'LIGHT']
    base = {o.name: (o.data.energy, tuple(o.data.color), o.rotation_euler.copy()) for o in lights}
    for name, v in B.PREVIEW_VIEWS.items():
        if (B.ONLY and name not in B.ONLY) or (v.get('extra') and not (B.ONLY and name in B.ONLY)):
            continue
        B.aim(cam, v['loc'], v['target'], v.get('lens', 50), v.get('ortho'))
        if rotor:
            rotor.rotation_euler = (0, 0, math.radians(v['rotor']))
        if prop:
            prop.rotation_euler = (math.radians(v['prop']), 0, 0)
        hidden = []
        for o in scn.objects:
            if any(o.name == h or o.name.startswith(h + '_head') for h in v.get('hide', ())):
                if not o.hide_render:
                    o.hide_render = True
                    hidden.append(o)
        dusk = v.get('dusk')
        if dusk:
            dw = bpy.data.worlds.new('Dusk')
            dw.use_nodes = True
            nt = dw.node_tree
            for n in list(nt.nodes):
                nt.nodes.remove(n)
            out = nt.nodes.new('ShaderNodeOutputWorld')
            bg = nt.nodes.new('ShaderNodeBackground')
            tc = nt.nodes.new('ShaderNodeTexCoord')
            sep = nt.nodes.new('ShaderNodeSeparateXYZ')
            ramp = nt.nodes.new('ShaderNodeValToRGB')
            nt.links.new(tc.outputs['Generated'], sep.inputs[0])
            nt.links.new(sep.outputs['Z'], ramp.inputs[0])
            nt.links.new(ramp.outputs[0], bg.inputs['Color'])
            nt.links.new(bg.outputs[0], out.inputs[0])
            ramp.color_ramp.elements[0].position = 0.48
            ramp.color_ramp.elements[0].color = (0.55, 0.22, 0.08, 1)
            ramp.color_ramp.elements[1].position = 0.72
            ramp.color_ramp.elements[1].color = (0.03, 0.06, 0.16, 1)
            bg.inputs['Strength'].default_value = 0.7
            scn.world = dw
            for o in lights:
                if o.data.type == 'SUN':
                    o.data.energy = 1.2
                    o.data.color = (1.0, 0.55, 0.30)
                    o.rotation_euler = Euler((math.radians(86), 0, math.radians(-120)), 'XYZ')
                else:
                    o.data.energy = base[o.name][0] * 0.06
            for mname, s in (('Lens_Red', 6.0), ('Lens_Green', 6.0), ('Lens_White', 5.0)):
                m = MATS.get(mname)
                if m:
                    bs = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
                    bs.inputs['Emission Strength'].default_value = s
        scn.render.filepath = os.path.join(B.PREVIEW_DIR, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
        for o in hidden:
            o.hide_render = False
        if dusk:
            scn.world = world
            for o in lights:
                o.data.energy, col, rot = base[o.name][0], base[o.name][1], base[o.name][2]
                o.data.color = col
                o.rotation_euler = rot
            for mname, s in (('Lens_Red', 0.5), ('Lens_Green', 0.5), ('Lens_White', 0.35)):
                m = MATS.get(mname)
                if m:
                    bs = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
                    bs.inputs['Emission Strength'].default_value = s
    if rotor:
        rotor.rotation_euler = (0, 0, 0)
    if prop:
        prop.rotation_euler = (0, 0, 0)


B.render_previews = render_previews

_EYE = eye_point()
_EP = (round(_EYE.x, 3), round(_EYE.y, 3), round(_EYE.z, 3))
VIEWS = {
    'side': dict(loc=(-0.35, 18.0, 0.45), target=(-0.35, 0.0, 0.45), ortho=9.6, rotor=0, prop=0),
    'top': dict(loc=(-0.35, 0.0, 30.0), target=(-0.35, 0.0, 0.0), ortho=9.8, rotor=30, prop=0),
    'front_ortho': dict(extra=True, loc=(14.0, 0.0, 0.7), target=(0.0, 0.0, 0.7), ortho=9.8, rotor=90, prop=0),
    'pilot_eye': dict(extra=True, loc=_EP, target=(_EP[0] + 1.0, _EP[1], _EP[2] - 0.17), lens=16, rotor=75, prop=0,
                      hide=('pilot_front',)),
    'dusk': dict(extra=True, loc=(6.9, 5.6, 1.35), target=(-0.45, 0.0, 0.25), lens=33, rotor=-58, prop=20, dusk=True),
    'dusk_rear': dict(extra=True, loc=(-7.2, -4.2, 1.3), target=(-0.8, 0.0, 0.3), lens=35, rotor=-40, prop=20,
                      dusk=True),
    'rear_duct': dict(extra=True, loc=(-6.2, -1.6, 0.75), target=(-2.25, 0.0, 0.22), lens=45, rotor=75, prop=10),
    'tail_detail': dict(extra=True, loc=(-0.9, -3.2, 1.05), target=(-2.45, 0.0, 0.15), lens=40, rotor=75, prop=10),
    'nose_detail': dict(extra=True, loc=(4.1, -2.1, 0.25), target=(1.7, 0.0, -0.35), lens=45, rotor=75, prop=15),
    'head_detail': dict(extra=True, loc=(1.3, -1.45, 2.05), target=(-0.25, 0.0, 1.55), lens=50, rotor=75, prop=0),
    'cockpit': dict(extra=True, loc=(1.9, 1.55, 1.25), target=(0.55, 0.0, -0.15), lens=30, rotor=75, prop=0),
    'gear_detail': dict(extra=True, loc=(1.2, -3.2, -0.35), target=(-0.6, -0.4, -0.65), lens=40, rotor=75, prop=10),
    'cabin_side': dict(extra=True, loc=(0.45, 2.9, 0.55), target=(0.35, 0.0, -0.15), lens=30, rotor=75, prop=0),
    'cabin_top': dict(extra=True, loc=(0.45, -0.4, 3.2), target=(0.45, 0.0, -0.2), lens=30, rotor=75, prop=0),
}

if __name__ == '__main__':
    K.run('vencejo', build_vencejo, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
