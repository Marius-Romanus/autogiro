"""
Sigilo SX-1 -- an INVENTED two-seat tandem gyroplane concept (~2060) for the Autogiro web sim (concept C "Dos vigas",
chosen by the owner). Gyro first: a compact faceted tandem pod with sharp chines and a smooth gold/amber bubble canopy,
a tall swept faceted mast fused into the spine with an integrated faceted rotor-head fairing (thin glowing ring round
the spindle), the big 3-blade rotor; tiny stub wings carry two slim faceted booms back to a high tailplane with fins
(canted 10 deg out, each with its rudder node `rudder_L` / `rudder_R`) at the boom ends. Propulsion (fiction,
"impulsor de plasma magnetohidrodinamico"): flush caret intakes on the pod flanks feed a compressor (node `prop`,
hidden inside the pod) and one wide serrated slot nozzle at the pod's tail between the booms, glowing (`Plasma_Glow`).
Finish: satin mid stealth grey with flat-colour edge-treatment panels and sawtooth edges, low-vis registration.
No real aircraft is traced or copied.

The pod is a height field (upper and lower surfaces as functions of X, Y, sharp where they meet on the chine) lofted
along X with columns that follow the cockpit hump and the chine.

Hub frame (gyrokit.py): X forward, Z up, origin on the rotor hub, metres. CG (sim convention) 0.33 m ahead of the hub,
1.72 m below it (0.87 m above the main axle).

  blender -b -P blender/build_sigilo.py -- [--previews] [--only VIEW,...] [--samples N] [--show-rear] [--no-export]
Outputs: public/models/sigilo.glb, blender/sigilo.blend, blender/previews/sigilo/*.png
"""
import bpy, bmesh, json, math, os, struct, sys
from mathutils import Vector, Euler, Matrix
from mathutils.geometry import delaunay_2d_cdt

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, airfoil_ring, pilot, controls, PANEL  # noqa: E402

T_LE = math.tan(math.radians(55.0))     # sawtooth teeth flanks
T35 = math.tan(math.radians(35.0))      # rotor tips

# ---- hub frame -----------------------------------------------------------------------------------------
GROUND = -2.77
R_MAIN, W_MAIN = 0.13, 0.065            # small fighter-style wheels (contacts unchanged)
R_NOSE, W_NOSE = 0.13, 0.065
AXLE = (-0.60, GROUND + R_MAIN)
CG = (0.33, -1.72)                       # 0.87 m above the axle of the original 0.18 m wheels
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.20)
ROTOR_R, ROTOR_CHORD, ROTOR_N = 4.40, 0.20, 3
MAIN_Y = 0.80                            # track 1.60
NOSE = (1.62, GROUND + R_NOSE)           # wheelbase 2.22

LIVERY = dict(body=('#4A5059', 0.15, 0.48), accent=('#5C636D', 0.15, 0.52), dark=('#2A2E34', 0.20, 0.50),
              seat=('#1B1D21', 0.0, 0.75))
REG = 'EC-SGX'

# ---- pod planform (hub X, |Y|) ----------------------------------------------------------------------------
PN = (2.30, 0.0)
OUTLINE = [PN, (1.55, 0.40), (0.70, 0.50), (-0.50, 0.50), (-1.05, 0.34), (-1.40, 0.28)]
X_AFT = OUTLINE[-1][0]

# ---- slot nozzle and hidden compressor -----------------------------------------------------------------------
NOZ_Z = -1.84                            # thrust line, 0.12 m below the CG
BOX_UP, BOX_LO = NOZ_Z + 0.070, NOZ_Z - 0.070
SLOT_HW, SLOT_H, SLOT_DEPTH, TOOTH_N = 0.17, 0.050, 0.08, 6
PROP_X, PROP_R, PROP_N = -0.88, 0.17, 15
PROP = R(PROP_X, NOZ_Z)

# ---- crew and cockpit ---------------------------------------------------------------------------------------
FLOOR_Z = -2.39
FRONT_HIP = R(1.00, -2.20)
REAR_HIP = R(0.14, -2.15)
FRONT_BACK, REAR_BACK = 25.0, 22.0
PANEL_P0, PANEL_TILT = R(1.56, -1.90), 22.0
BULK_AFT, BULK_FWD = -0.40, 1.98
CABIN_ZC = -1.95

# ---- clearances ---------------------------------------------------------------------------------------------
TILT_CHECK, CLEAR_MIN, TAILDOWN_MIN, BANK = 15.0, 0.33, 13.0, 10.0


# =========================================================================================================
# helpers
# =========================================================================================================
def P3(p):
    return R(p[0], p[2], p[1])


def ss(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def smin(a, b, r=0.035):
    h = max(r - abs(a - b), 0.0) / r
    return min(a, b) - h * h * r * 0.25


def seg_dist(px, py, a, b):
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = px - a[0], py - a[1]
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(px - a[0] - t * vx, py - a[1] - t * vy)


def interp(tab):
    xs, ys = [t[0] for t in tab], [t[1] for t in tab]
    f = B.hermite(xs, ys)
    lo, hi = min(xs), max(xs)
    return lambda x: f(min(hi, max(lo, x)))


def ramp(t):
    t = min(max(t, 0.0), 1.0)
    return t * (2.0 - t)


def bell(u):
    if u >= 1.0:
        return 0.0
    return (1.0 - u ** 2.4) ** 1.5


def slab(mb, loops, strip_mat, cap_mats=('Paint_White', 'Paint_White'), smooth=False):
    n = len(loops[0])
    for k in range(len(loops) - 1):
        a, b = loops[k], loops[k + 1]
        for j in range(n):
            j2 = (j + 1) % n
            mb.faces([a[j], a[j2], b[j2], b[j]], [[0, 1, 2, 3]], strip_mat(j), smooth=smooth)
    if cap_mats[0]:
        mb.faces(loops[0], [list(range(n))[::-1]], cap_mats[0], smooth=smooth)
    if cap_mats[1]:
        mb.faces(loops[-1], [list(range(n))], cap_mats[1], smooth=smooth)


def band(mb, pts, nrms, w, h, mat, under=0.004):
    rings = []
    m = len(pts)
    for i in range(m):
        p, n = pts[i], nrms[i].normalized()
        if i == 0:
            t, k = (pts[1] - pts[0]).normalized(), 1.0
        elif i == m - 1:
            t, k = (pts[-1] - pts[-2]).normalized(), 1.0
        else:
            t0, t1 = (pts[i] - pts[i - 1]).normalized(), (pts[i + 1] - pts[i]).normalized()
            t = (t0 + t1).normalized()
            k = 1.0 / max(0.35, math.cos(0.5 * t0.angle(t1, 0.0)))
        sd = n.cross(t).normalized()
        nn = t.cross(sd).normalized()
        if nn.dot(n) < 0:
            nn = -nn
        hw = 0.5 * w * k
        rings.append([p + sd * hw + nn * h, p - sd * hw + nn * h, p - sd * hw - nn * under, p + sd * hw - nn * under])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True, smooth=False)


def _local_bisect(ob, planes, region):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for co, no in planes:
        faces = [f for f in bm.faces if region(f)]
        if not faces:
            continue
        geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no)
    bm.to_mesh(ob.data)
    bm.free()


def _overlap(f, ax0, ax1, box):
    a = [v.co[ax0] for v in f.verts]
    b = [v.co[ax1] for v in f.verts]
    return max(a) > box[0] and min(a) < box[1] and max(b) > box[2] and min(b) < box[3]


def paint_plan(ob, poly, mat, test=None, margin=0.02):
    """Crisp flat colour region from a plan-view polygon (model x, y), vertical cut planes."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    box = (min(xs) - margin, max(xs) + margin, min(ys) - margin, max(ys) + margin)

    def region(f):
        return _overlap(f, 0, 1, box) and (test is None or test(f.calc_center_median()))
    planes = []
    n = len(poly)
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        d = Vector((x1 - x0, y1 - y0, 0.0))
        if d.length > 1e-6:
            planes.append((Vector((x0, y0, 0.0)), Vector((d.y, -d.x, 0.0)).normalized()))
    _local_bisect(ob, planes, region)
    K.repaint(ob, lambda c: PANEL.inside(poly, c.x, c.y) and (test is None or test(c)), mat)


def sawtooth(p0, p1, teeth, depth_dir, depth):
    out = []
    for k in range(2 * teeth + 1):
        t = k / (2 * teeth)
        q = (lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t))
        if k % 2 == 1:
            q = (q[0] + depth_dir[0] * depth, q[1] + depth_dir[1] * depth)
        out.append(q)
    return out


def hit(objs, p, n, far=1.5):
    n = Vector(n).normalized()
    best = None
    for ob in objs:
        inv = ob.matrix_world.inverted()
        ok, loc, nn, _i = ob.ray_cast(inv @ (Vector(p) + n * 0.6), inv.to_3x3() @ (-n), distance=far)
        if ok:
            w = ob.matrix_world @ loc
            d = (w - (Vector(p) + n * 0.6)).length
            if best is None or d < best[0]:
                best = (d, w, (ob.matrix_world.to_3x3() @ nn).normalized())
    if best is None:
        raise RuntimeError('ray missed at %s' % (tuple(p),))
    return best[1], best[2]


def hexbar(mb, p0, p1, w, h, mat, up=V(0, 0, 1), point0=0.0, point1=0.0):
    p0, p1 = Vector(p0), Vector(p1)
    d = (p1 - p0).normalized()
    sd = up.cross(d).normalized()
    uu = d.cross(sd).normalized()

    def sec(c, s):
        return [c + sd * (0.5 * w * s) + uu * (0.30 * h), c + uu * (0.5 * h * s) + sd * (0.25 * w * s),
                c + uu * (0.5 * h * s) - sd * (0.25 * w * s), c - sd * (0.5 * w * s) + uu * (0.30 * h * s),
                c - sd * (0.5 * w * s) - uu * (0.30 * h * s), c - uu * (0.5 * h * s) - sd * (0.25 * w * s),
                c - uu * (0.5 * h * s) + sd * (0.25 * w * s), c + sd * (0.5 * w * s) - uu * (0.30 * h * s)]
    loops = []
    if point0 > 0:
        loops += [sec(p0, 0.05), sec(p0 + d * point0, 1.0)]
    else:
        loops.append(sec(p0, 1.0))
    if point1 > 0:
        loops += [sec(p1 - d * point1, 1.0), sec(p1, 0.05)]
    else:
        loops.append(sec(p1, 1.0))
    slab(mb, loops, lambda j: mat, (mat, mat))


def plate_section(le, te, t, f_ridge=0.35):
    c = le - te
    return [(le, 0.0), (le - f_ridge * c, t), (le - 0.70 * c, t * 0.8), (te, 0.0), (le - 0.70 * c, -t * 0.8),
            (le - f_ridge * c, -t)]


# =========================================================================================================
# pod height field
# =========================================================================================================
def ye(X):
    o = OUTLINE
    if X >= o[0][0]:
        return 0.0
    for a, b in zip(o, o[1:]):
        if b[0] <= X <= a[0] and a[0] > b[0]:
            return lerp(a[1], b[1], (a[0] - X) / (a[0] - b[0]))
    return o[-1][1]


def ze(X, Y):
    """Chine height: level under the cabin, sweeping up into the tail."""
    return -2.12 + 0.26 * ss((-0.3 - X) / 1.1)


def d_edge(X, Y, r=0.08):
    y = abs(Y)
    ds = [seg_dist(X, y, a, b) for a, b in zip(OUTLINE, OUTLINE[1:])]
    m = min(ds)
    soft = m - r * math.log(sum(math.exp(-(d - m) / r) for d in ds))
    return lerp(m, max(soft, 0.0), ss(m / (2 * r)))


D_LO = interp([(2.3, 0.33), (-0.35, 0.33), (-0.90, 0.25), (-1.45, 0.10)])
HUMP = [(2.10, -1.93, 0.13), (1.95, -1.79, 0.23), (1.70, -1.575, 0.34), (1.45, -1.44, 0.40), (1.15, -1.35, 0.44),
        (0.85, -1.30, 0.46), (0.55, -1.275, 0.47), (0.25, -1.265, 0.47), (-0.05, -1.27, 0.46), (-0.35, -1.30, 0.44),
        (-0.65, -1.385, 0.38), (-0.95, -1.54, 0.30), (-1.20, -1.70, 0.22), (-1.40, -1.775, 0.17)]
H_TOP = interp([(x, z) for x, z, w in HUMP])
H_W = interp([(x, w) for x, z, w in HUMP])


def t_up(X, Y):
    return 0.12 - 0.04 * ss((-0.6 - X) / 0.8)


def t_lo(X, Y):
    return D_LO(X) * (1 - 0.20 * ss((abs(Y) - 0.25) / 0.30))


def s_up(X, Y):
    return lerp(0.30, 0.50, ss((X - 0.9) / 0.6))


def s_lo(X, Y):
    """Steep walls under the chine (roomy cabin, crisp chine), a V keel at the nose."""
    return lerp(1.80, 1.30, ss((X - 0.9) / 0.6))


def w_box(X, Y):
    return ss((-0.80 - X) / 0.55) * (1 - ss((abs(Y) - 0.12) / 0.16))


CAN_F, CAN_A = 1.96, -0.30
SILL_Z = -1.85                           # canopy sill height: level along the cabin, sweeping up at both ends
NH, NO = 22, 14
U_COLS = [1 - (1 - i / NH) ** 1.30 for i in range(NH + 1)]
U_CAN = min(U_COLS, key=lambda u: abs(u - 0.84))


def sill_z(X):
    w = max(ss((X - 1.50) / (CAN_F - 1.50)), ss((0.25 - X) / (0.25 - CAN_A)))
    return lerp(SILL_Z, zup(X, 0.0), w)


_CANW = {}


def can_w(X):
    """Canopy half width: where the upper surface comes down to the sill height (a clean sill line)."""
    if X >= CAN_F - 1e-4 or X <= CAN_A + 1e-4:
        return 0.0
    key = round(X, 5)
    if key in _CANW:
        return _CANW[key]
    zt = sill_z(X)
    lo, hi = 0.0, 0.97 * Wc(X)
    if zup(X, hi) >= zt:
        _CANW[key] = hi
        return hi
    for _ in range(40):
        m = 0.5 * (lo + hi)
        if zup(X, m) > zt:
            lo = m
        else:
            hi = m
    _CANW[key] = 0.5 * (lo + hi)
    return _CANW[key]


def stations():
    xs = []
    x = PN[0]
    while x > X_AFT + 1e-6:
        step = 0.018 if (x > 1.80 or (-0.45 < x < 0.12) or (1.30 < x < 2.05)) else 0.030
        x -= step
        xs.append(max(x, X_AFT))
    for k in [p[0] for p in OUTLINE[1:]] + [CAN_F, CAN_A]:
        if all(abs(k - q) > 0.006 for q in xs):
            xs.append(k)
    xs = sorted(set(round(q, 5) for q in xs), reverse=True)
    return [q for q in xs if X_AFT - 1e-6 <= q < PN[0]]


# =========================================================================================================
# materials
# =========================================================================================================
def sx_materials():
    def mk(name, hexc, **kw):
        if name in MATS:
            return
        if 'emit' in kw:
            kw['emit'] = B.srgb(kw['emit'])
        B.make_mat(name, B.srgb(hexc), **kw)
    mk('Glass_Amber', '#C49A48', metal=0.2, rough=0.03, alpha=0.40, spec=0.6)
    mk('Plasma_Glow', '#7058FF', rough=0.3, emit='#6A52FF', emit_strength=2.8)
    mk('Intake_Black', '#07080A', rough=0.95)
    mk('Nozzle_Housing', '#24272C', metal=0.6, rough=0.40)
    mk('Nozzle_Liner', '#4A4540', metal=0.9, rough=0.36)
    mk('Vane_Metal', '#25272B', metal=0.9, rough=0.30)
    mk('Reg_Grey', '#2F343B', metal=0.15, rough=0.5)
    mk('Sensor_Dark', '#0A0E14', metal=0.6, rough=0.05)
    E.set_paint('Rotor_Blade', '#3A3F47', 0.20, 0.45)
    E.set_paint('Interior', '#2A2D32', 0.0, 0.7)


# =========================================================================================================
# pod surfaces
# =========================================================================================================
def Wc(X):
    return min(H_W(X), 0.82 * ye(X))


# ---- canopy: its side edges lie on a hump column --------------------------------------------------------------


def half_cols(X):
    """Y of the columns from the outline edge to the centre line (edge first)."""
    e, w = ye(X), Wc(X)
    outer = [w + (e - w) * (1 - (1 - j / NO) ** 1.6) for j in range(NO, 0, -1)]
    inner = [w * u for u in reversed(U_COLS)]
    return outer + inner          # outer[0] = e, inner[0] = w, inner[-1] = 0


def hump(X, Y):
    if X > HUMP[0][0]:
        return 0.0
    h = max(0.0, H_TOP(X) - _up0(X, 0.0))
    return h * bell(abs(Y) / H_W(X))


def _up0(X, Y, d=None):
    T = t_up(X, Y)
    d = d_edge(X, Y) if d is None else d
    return ze(X, Y) + T * ramp(d * s_up(X, Y) / (2 * T))


def zup(X, Y):
    d = d_edge(X, Y)
    base = _up0(X, Y, d) + hump(X, Y)
    return base + w_box(X, Y) * (BOX_UP - base)


def zlo(X, Y):
    d = d_edge(X, Y)
    T = t_lo(X, Y)
    base = ze(X, Y) - T * ramp(d * s_lo(X, Y) / (2 * T))
    return base + w_box(X, Y) * (BOX_LO - base)


def surf_n(X, Y, upper=True):
    f = zup if upper else zlo
    h = 0.004
    dx = (f(X + h, Y) - f(X - h, Y)) / (2 * h)
    dy = (f(X, Y + h) - f(X, Y - h)) / (2 * h)
    n = V(-dx, -dy, 1.0) if upper else V(dx, dy, -1.0)
    return n.normalized()

G_UP, G_LO, G_CAP = 0, 1, 2


def build_hull():
    bm = bmesh.new()
    grp = bm.faces.layers.int.new('grp')
    mats = ['Paint_White', 'Glass_Amber', 'Nozzle_Housing', 'Nozzle_Liner', 'Plasma_Glow']
    xs = stations()
    tip = bm.verts.new(R(PN[0], ze(PN[0], 0.0), 0.0))
    rings, nup = [], None
    for X in xs:
        half = half_cols(X)
        e = half[0]
        ys = half + [-y for y in reversed(half[:-1])]
        up = []
        for y in ys:
            z = ze(X, y) if abs(abs(y) - e) < 1e-9 else zup(X, y)
            up.append(R(X, z, y))
        lo = [R(X, zlo(X, y), y) for y in ys[1:-1]][::-1]
        nup = len(ys) - 1
        rings.append([bm.verts.new(p) for p in up + lo])
    n = len(rings[0])

    def face(vs, g, mat, smooth=True):
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return None
        f[grp] = g
        f.material_index = mats.index(mat)
        f.smooth = smooth
        return f
    for j in range(n):
        face([tip, rings[0][(j + 1) % n], rings[0][j]], G_UP if j < nup else G_LO, 'Paint_White')
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        for j in range(n):
            j2 = (j + 1) % n
            upper = j < nup
            c = (a[j].co + a[j2].co + b[j].co + b[j2].co) * 0.25
            glass = upper and abs(c.y) < can_w(c.x - R.dx)
            face([a[j], a[j2], b[j2], b[j]], G_UP if upper else G_LO, 'Glass_Amber' if glass else 'Paint_White')
    # ---- aft face (X_AFT) with the slot hole: constrained triangulation in (y, z)
    last = rings[-1]
    zc = R.z(NOZ_Z)
    rects = []
    rects.append([(-SLOT_HW, zc - SLOT_H / 2), (SLOT_HW, zc - SLOT_H / 2), (SLOT_HW, zc + SLOT_H / 2),
                  (-SLOT_HW, zc + SLOT_H / 2)])
    pts2 = [Vector((v.co.y, v.co.z)) for v in last]
    rv = []
    for rc in rects:
        idx = []
        for (yy, zz) in rc:
            idx.append(len(pts2))
            pts2.append(Vector((yy, zz)))
        rv.append(idx)
    edges = [(i, (i + 1) % n) for i in range(n)]
    for idx in rv:
        edges += [(idx[i], idx[(i + 1) % 4]) for i in range(4)]
    loop = list(range(n))
    area = sum(pts2[loop[i]].x * pts2[loop[(i + 1) % n]].y - pts2[loop[(i + 1) % n]].x * pts2[loop[i]].y
               for i in range(n))
    if area < 0:
        loop = loop[::-1]
    out_v, _oe, out_f, orig_v, _o2, _o3 = delaunay_2d_cdt(pts2, edges, [loop], 1, 1e-7, True)
    rect_verts = [[bm.verts.new(V(R.x(X_AFT), yy, zz)) for (yy, zz) in rc] for rc in rects]
    vmap = {}
    for i, ov in enumerate(orig_v):
        if ov and ov[0] < n:
            vmap[i] = last[ov[0]]
        elif ov:
            k = ov[0] - n
            vmap[i] = rect_verts[k // 4][k % 4]
        else:
            vmap[i] = bm.verts.new(V(R.x(X_AFT), out_v[i].x, out_v[i].y))
    for f in out_f:
        cy = sum(out_v[i].x for i in f) / 3
        cz = sum(out_v[i].y for i in f) / 3
        if any(rc[0][0] < cy < rc[1][0] and rc[0][1] < cz < rc[2][1] for rc in rects):
            continue
        face([vmap[i] for i in f], G_CAP, 'Nozzle_Housing', smooth=False)
    # ---- slot channel: short glowing duct (walls and back wall)
    for rc, vs in zip(rects, rect_verts):
        back = [bm.verts.new(V(R.x(X_AFT + SLOT_DEPTH), yy, zz)) for (yy, zz) in rc]
        for i in range(4):
            i2 = (i + 1) % 4
            face([vs[i], vs[i2], back[i2], back[i]], G_CAP + 1, 'Plasma_Glow', smooth=False)
        face(back, G_CAP + 2, 'Plasma_Glow', smooth=False)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
            continue
        f1, f2 = e.link_faces
        e.smooth = (f1[grp] == f2[grp] and f1[grp] in (G_UP, G_LO) and f1.normal.angle(f2.normal, 0) < math.radians(40))
    me = bpy.data.meshes.new('hull')
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(MATS[m])
    ob = bpy.data.objects.new('hull', me)
    B.link(ob)
    return ob


def split_canopy(hull):
    me = hull.data
    gi = [i for i, m in enumerate(me.materials) if m.name == 'Glass_Amber'][0]
    can_me = me.copy()
    can = bpy.data.objects.new('canopy', can_me)
    B.link(can)
    bm = bmesh.new()
    bm.from_mesh(can_me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != gi], context='FACES')
    for f in bm.faces:
        f.material_index = 0
    bm.to_mesh(can_me)
    bm.free()
    can_me.materials.clear()
    can_me.materials.append(MATS['Glass_Amber'])
    B.remove_faces_with_material(hull, 'Glass_Amber')
    return can


def build_frame():
    """Canopy frame: a flat dark band following the canopy outline on the hump."""
    mb = MB('canopy_frame')
    xs = [lerp(CAN_F, CAN_A, k / 160) for k in range(161)]
    left = [(X, can_w(X)) for X in xs]
    pts, nrm = [], []
    path = left + [(X, -y) for X, y in reversed(left[1:-1])] + [left[0]]
    for X, y in path:
        pts.append(R(X, zup(X, y) + 0.001, y))
        nrm.append(surf_n(X, y))
    band(mb, pts, nrm, 0.044, 0.006, 'Paint_Dark')
    return mb.finish(sharp_angle=40)


def intake_poly(x0, yc, w, L):
    """Plan outline (hub X, |Y|) of a flush caret inlet: pointed apex forward, mouth lip at the aft end swept 55 deg."""
    xa = x0 - L
    return [(x0, yc), (xa + 0.5 * w * 0.35, yc - 0.5 * w), (xa - 0.5 * w * T_LE * 0.35, yc + 0.5 * w)]


def build_intakes():
    """Flush caret inlets: a dark ramp sunk in the skin (painted on the hull) ending at a thin sharp lip in the
    edge-treatment grey that overhangs the dark mouth."""
    mb = MB('intakes')
    for sy in (1, -1):
        for (x0, yc), w, L in INTAKES:
            ap, ci, co = intake_poly(x0, yc, w, L)
            n = 9
            lip_in, lip_top, mouth = [], [], []
            for k in range(n):
                t = k / (n - 1)
                X, y = lerp(ci[0], co[0], t), lerp(ci[1], co[1], t)
                z = zup(X, y)
                lip_in.append(R(X - 0.004, z + 0.002, sy * y))
                lip_top.append(R(X - 0.05, z + 0.026, sy * y))
                mouth.append(R(X + 0.002, z - 0.045, sy * y))
            under = [p + V(0.0, 0.0, -0.006) for p in lip_top]
            # lip: wedge from the mouth edge back into the skin
            back = [R(X_ - 0.17, zup(X_ - 0.17, abs(p.y)) - 0.003, p.y) for p, X_ in
                    zip(lip_in, [lerp(ci[0], co[0], k / (n - 1)) for k in range(n)])]
            rows = [lip_in, lip_top, back]
            for a, b in zip(rows, rows[1:]):
                for k in range(n - 1):
                    mb.faces([a[k], a[k + 1], b[k + 1], b[k]], [[0, 1, 2, 3]], 'Paint_Accent', smooth=False)
            for k in range(n - 1):
                mb.faces([lip_in[k], mouth[k], mouth[k + 1], lip_in[k + 1]], [[0, 1, 2, 3]], 'Intake_Black',
                         smooth=False)
            for end in (0, n - 1):
                mb.faces([lip_in[end], lip_top[end], back[end]], [[0, 1, 2]], 'Paint_Accent', smooth=False)
            del under
    return mb.finish(sharp_angle=30)


# =========================================================================================================
# nozzle lips, paint, intakes
# =========================================================================================================
def build_nozzle_details():
    """Serrated upper and lower lips: thin plates continuing the skins aft, 55-deg teeth."""
    mb = MB('nozzle_lips')
    th = 0.006
    w = 2 * SLOT_HW / TOOTH_N
    depth = 0.5 * w * T_LE
    for i in range(TOOTH_N):
        y0, y1 = -SLOT_HW + i * w, -SLOT_HW + (i + 1) * w
        ym = 0.5 * (y0 + y1)
        for upper in (True, False):
            zf = (lambda y: zup(X_AFT + 0.01, y) - 0.002) if upper else (lambda y: zlo(X_AFT + 0.01, y) + 0.002)
            sg = -1 if upper else 1
            a = [R(X_AFT + 0.012, zf(y0), y0), R(X_AFT + 0.012, zf(y1), y1), R(X_AFT - depth, zf(ym), ym)]
            b = [p + V(0, 0, sg * th) for p in a]
            mb.faces(a + b, [[0, 1, 2], [5, 4, 3], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]], 'Nozzle_Housing',
                     smooth=False)
    return mb.finish(sharp_angle=30, merge=1e-6)


INTAKES = [((-0.18, 0.40), 0.15, 0.36)]      # (ramp apex X, centre |Y|), mouth width, ramp length


def paint_hull(hull):
    up = lambda c: c.z > R.z(ze(c.x - R.dx, c.y)) + 0.002  # noqa: E731
    lo = lambda c: c.z < R.z(ze(c.x - R.dx, c.y)) - 0.002  # noqa: E731
    # nose cap: edge-treatment grey ahead of a sawtooth line
    zig = sawtooth((R.x(2.02), 0.40), (R.x(2.02), -0.40), 4, (1.0, 0.0), 0.10 * T_LE)
    paint_plan(hull, [(R.x(2.45), 0.40)] + zig + [(R.x(2.45), -0.40)], 'Paint_Accent')
    # aft deck round the slot nozzle (upper and lower), sawtooth leading edge
    zc = R.z(NOZ_Z)

    def skin(c):        # not the aft face, not the slot channel
        return c.x > R.x(X_AFT) + 0.003 and not (abs(c.y) < SLOT_HW + 0.003 and abs(c.z - zc) < 0.5 * SLOT_H + 0.003)
    for test in (up, lo):
        zz = sawtooth((R.x(-1.16), 0.32), (R.x(-1.16), -0.32), 4, (1.0, 0.0), 0.08 * T_LE)
        paint_plan(hull, zz + [(R.x(-1.50), -0.32), (R.x(-1.50), 0.32)], 'Paint_Accent',
                   test=lambda c, t=test: t(c) and skin(c))
    # chine strakes: a thin edge-treatment band along the chine under the cabin (flat colour, sawtooth ends)
    for sy in (1, -1):
        xa, xb = 1.30, -0.62
        y_in = 0.43
        poly = [(R.x(xa), sy * 0.47), (R.x(xa - 0.06 * T_LE), sy * y_in), (R.x(xb + 0.06 * T_LE), sy * y_in),
                (R.x(xb), sy * 0.55), (R.x(xa), sy * 0.55)]
        paint_plan(hull, poly, 'Paint_Accent', test=lo)
    # nose-wheel bay (dark under its doors; fore and aft edges are parallel chevrons) and landing-lamp bay
    bay = [(R.x(1.50 - 0.04), -0.070), (R.x(2.09 - 0.04), -0.070), (R.x(2.09), 0.0), (R.x(2.09 - 0.04), 0.070),
           (R.x(1.50 - 0.04), 0.070), (R.x(1.50), 0.0)]
    paint_plan(hull, bay, 'Intake_Black', test=lo)
    front = sawtooth((R.x(2.22), 0.05), (R.x(2.22), -0.05), 2, (1.0, 0.0), 0.025 * T_LE)
    back = sawtooth((R.x(2.10), -0.05), (R.x(2.10), 0.05), 2, (-1.0, 0.0), 0.025 * T_LE)
    paint_plan(hull, front + back, 'Intake_Black', test=lo)
    # intake ramps
    for sy in (1, -1):
        for (x0_, y0_), w, L in INTAKES:
            poly = [(R.x(X), sy * y) for X, y in intake_poly(x0_, y0_, w, L)]
            paint_plan(hull, poly, 'Intake_Black', test=up)


# =========================================================================================================
# mast and head fairing
# =========================================================================================================
MAST_LE, MAST_TE, MAST_TOP, MAST_TC = (-0.45, 0.06), (-1.25, -0.36), -0.32, 0.13


def _mast_loop(s, grow, tk, zfun):
    le, te = lerp(MAST_LE[0], MAST_LE[1], s) + grow, lerp(MAST_TE[0], MAST_TE[1], s) - grow
    c = le - te
    return [R(x, zfun(x, n * tk), n * tk) for x, n in plate_section(le, te, MAST_TC * c * 0.5, 0.36)]


def mast_loops():
    """Root flare sunk 4 cm into the skin (following it), a fillet loop just above it, then the swept blade."""
    zf = lambda x: zup(x, 0.0) + 0.08  # noqa: E731
    return [_mast_loop(0.0, 0.12, 3.2, lambda x, y: zup(x, y) - 0.04),
            _mast_loop(0.0, 0.05, 1.9, lambda x, y: zup(x, y) + 0.025),
            _mast_loop(0.10, 0.0, 1.0, lambda x, y: lerp(zf(x), MAST_TOP, 0.10)),
            _mast_loop(1.0, 0.0, 1.0, lambda x, y: MAST_TOP)]


def build_mast():
    mb = MB('mast')
    slab(mb, mast_loops(), lambda j: 'Paint_Accent' if j in (0, 5) else 'Paint_White', (None, 'Paint_White'))
    return mb.finish(sharp_angle=30)


def build_head_fairing(det):
    """Faceted rotor-head fairing merging into the mast top; thin glowing ring round the spindle."""
    mb = MB('head_fairing')
    st = [(0.38, 0.0, -0.215), (0.24, 0.071, -0.205), (0.05, 0.109, -0.215), (-0.20, 0.109, -0.230),
          (-0.42, 0.071, -0.250), (-0.60, 0.0, -0.265)]
    rings = []
    for X, w, zc in st:
        h = 1.3 * w
        rings.append([R(X, zc + 0.85 * h, 0.0), R(X, zc + 0.45 * h, w), R(X, zc - 0.55 * h, 0.8 * w), R(X, zc - h, 0.0),
                      R(X, zc - 0.55 * h, -0.8 * w), R(X, zc + 0.45 * h, -w)])
    rings[0], rings[-1] = [rings[0][0]], [rings[-1][0]]
    mb.loft(rings, 'Paint_White', closed=True, smooth=False)
    ob = mb.finish(sharp_angle=20)
    paint_plan(ob, [(R.x(0.42), 0.2), (R.x(0.26), 0.2), (R.x(0.26), -0.2), (R.x(0.42), -0.2)], 'Paint_Accent')
    ztop = -0.215 + 0.85 * 1.3 * 0.109
    pts = [R(0.066 * math.cos(TAU * k / 32), ztop - 0.004, 0.066 * math.sin(TAU * k / 32)) for k in range(32)]
    B.closed_tube(det, pts, 0.008, 'Rubber', n=8)
    det.lathe([(0.076, ztop - 0.012), (0.088, ztop - 0.012), (0.088, ztop - 0.003), (0.076, ztop - 0.003)], R(0, 0),
              V(0, 0, 1), 'Plasma_Glow', n=40, closed_profile=True)
    return ob


# =========================================================================================================
# stub wings, booms, high tailplane
# =========================================================================================================
STUB_Y0, STUB_Y1 = 0.30, 0.84
STUB_LE, STUB_TE = (-0.18, -0.40), (-0.90, -0.98)
STUB_Z = (-1.99, -1.97)
STUB_INC, STUB_TC = 2.0, 0.10
BOOM_Y, BOOM_X0, BOOM_X1 = 0.84, -0.12, -2.53     # the boom ends at the rudder hinge (full-height rudder behind)
BOOM_XS = -2.78                                    # length the boom's rise is shaped on


def stub_le(y):
    return lerp(STUB_LE[0], STUB_LE[1], (abs(y) - STUB_Y0) / (STUB_Y1 - STUB_Y0))


def stub_te(y):
    return lerp(STUB_TE[0], STUB_TE[1], (abs(y) - STUB_Y0) / (STUB_Y1 - STUB_Y0))


def boom_z(X):
    return -1.97 + 0.35 * ss((-0.40 - X) / (-0.40 - BOOM_XS))


def boom_hw(X):
    return lerp(0.075, 0.055, ss((-0.40 - X) / 2.4))


def boom_h(X):
    return lerp(0.14, 0.10, ss((-0.40 - X) / 2.4))


def boom_top(X):
    return boom_z(X) + 0.5 * boom_h(X)


def boom_bot(X):
    return boom_z(X) - 0.5 * boom_h(X)


TP_Y, TP_Z = 0.88, -1.46
TP_LE, TP_TE = (-2.22, -2.26), (-2.53, -2.53)
TP_TC = 0.09


def tp_le(y):
    return lerp(TP_LE[0], TP_LE[1], abs(y) / TP_Y)


def tp_te(y):
    return lerp(TP_TE[0], TP_TE[1], abs(y) / TP_Y)


def build_stubs_booms_tail(det):
    mb = MB('wings_booms')
    ci, si = math.cos(math.radians(STUB_INC)), math.sin(math.radians(STUB_INC))
    for sy in (1, -1):
        # stub wing (faceted section, 2 deg incidence about the quarter chord, LE band in accent)
        loops = []
        for y, z in ((STUB_Y0, STUB_Z[0]), (STUB_Y1, STUB_Z[1])):
            le, te = stub_le(y), stub_te(y)
            c = le - te
            xq = le - 0.25 * c
            loop = []
            for x, n in plate_section(le, te, STUB_TC * c * 0.5, 0.30):
                dx = x - xq
                loop.append(R(xq + dx * ci - n * si, z + dx * si + n * ci, sy * y))
            loops.append(loop)
        slab(mb, loops, lambda j: 'Paint_Accent' if j in (0, 5) else 'Paint_White')
        # boom: faceted hexagonal tube with a pointed nose (nav lamp) and a tapered end
        xs = [BOOM_X0, BOOM_X0 - 0.06, BOOM_X0 - 0.16] + [lerp(BOOM_X0 - 0.16, BOOM_X1 + 0.10, k / 9) for k in range(1, 10)] \
            + [BOOM_X1]
        rings = []
        for k, X in enumerate(xs):
            s = 0.15 if k == 0 else (0.75 if k == 1 else (0.85 if X == BOOM_X1 else 1.0))
            w, h, zc = boom_hw(X) * s, boom_h(X) * s, boom_z(X)
            rings.append([R(X, zc + 0.5 * h, sy * (BOOM_Y + 0.45 * w)), R(X, zc, sy * (BOOM_Y + w)),
                          R(X, zc - 0.5 * h, sy * (BOOM_Y + 0.45 * w)), R(X, zc - 0.5 * h, sy * (BOOM_Y - 0.45 * w)),
                          R(X, zc, sy * (BOOM_Y - w)), R(X, zc + 0.5 * h, sy * (BOOM_Y - 0.45 * w))])
        for k in range(len(rings) - 1):
            a, b = rings[k], rings[k + 1]
            for j in range(6):
                j2 = (j + 1) % 6
                mat = 'Paint_Accent' if k < 2 else 'Paint_White'
                mb.faces([a[j], a[j2], b[j2], b[j]], [[0, 1, 2, 3]], mat, smooth=False)
        mb.faces(rings[0], [list(range(6))[::-1]], 'Paint_Accent', smooth=False)
        mb.faces(rings[-1], [list(range(6))], 'Paint_White', smooth=False)
        # nav lamp in the boom nose, looking forward-outboard
        lp = R(BOOM_X0 - 0.045, boom_z(BOOM_X0), sy * (BOOM_Y + boom_hw(BOOM_X0) * 0.42))
        d = V(0.55, sy, 0.0).normalized()
        K.lamp(det, lp, d, kind='red' if sy > 0 else 'green', r=0.011, length=0.012, base='Paint_Dark')
        K.lamp_node('navL' if sy > 0 else 'navR', lp + d * 0.03)
    # high tailplane between the fins (passes into them)
    loops = []
    for y in (-TP_Y, -0.45, 0.0, 0.45, TP_Y):
        le, te = tp_le(y), tp_te(y)
        loops.append([R(x, TP_Z + n, y) for x, n in plate_section(le, te, TP_TC * (le - te) * 0.5, 0.35)])
    slab(mb, loops, lambda j: 'Paint_Accent' if j in (0, 5) else 'Paint_White')
    return mb.finish(sharp_angle=30)


# =========================================================================================================
# boom-end fins (canted 10 deg out): upper fin + ventral fin through the boom end, one full-height rudder behind
# =========================================================================================================
FIN_CANT = 10.0
CANT = math.radians(FIN_CANT)
CC, SC = math.cos(CANT), math.sin(CANT)
FIN_Y0 = BOOM_Y
FIN_Z0 = boom_top(-2.45)                 # slant coordinate s = 0: the boom top at the fin
FIN_HINGE = -2.55                        # rudder hinge line (hub X), straight along the canted fin plane
FIN_TE, TE_SWEEP = -2.75, math.tan(math.radians(15.0))     # trailing edge at s = 0, raked back going up
RUD_GAP_FIN, RUD_NOSE = 0.016, 0.012
FIN_TOP, VF_BOT = -1.15, -1.90           # upper fin tip, ventral fin bottom (hub Z)
S_TIP = (FIN_TOP - FIN_Z0) / CC
S_BOT = (VF_BOT - FIN_Z0) / CC
S_BB = (boom_bot(-2.45) - FIN_Z0) / CC   # the boom bottom at the fin
UP_LE0, UP_SWEEP = -1.99, math.tan(math.radians(28.0))     # upper fin LE at s = 0, swept back going up
LO_LE0, LO_SWEEP = -2.09, math.tan(math.radians(35.0))     # ventral fin LE at the boom bottom, swept back going down
RUD_S0, RUD_S1 = S_BOT + 0.02, S_TIP - 0.02
FIN_FLARE = 0.06


def fin_le_up(s):
    return UP_LE0 - s * UP_SWEEP


def fin_le_lo(s):
    return LO_LE0 - (S_BB - s) * LO_SWEEP


def fin_te(s):
    return FIN_TE - s * TE_SWEEP


def fin_h(f):
    if f <= 0.30:
        return 0.030 * f / 0.30
    return 0.030 - 0.027 * (f - 0.30) / 0.70


def fin_pt(X, s, n, sy):
    return (X, sy * (FIN_Y0 + s * SC + n * CC), FIN_Z0 + s * CC - n * SC)


def _fin_loop(s_of, le_fn, sy, mode='fixed', hk=1.0, le_ext=0.0):
    """One section of the canted fin plane. s_of(X): slant height (constant, or following the boom surface)."""
    def at(f=None, X=None):
        def xp(s):
            if X is None:
                return le_fn(s) - f * (le_fn(s) - fin_te(s))
            return X(s) if callable(X) else X
        s = s_of(le_fn(0.0))
        for _ in range(6):
            s = s_of(xp(s))
        Xp = xp(s)
        c = le_fn(s) - fin_te(s)
        return Xp, s, fin_h((le_fn(s) - Xp) / c) * c * hk
    if mode == 'fixed':
        up = [at(f=0.0), at(f=0.07), at(f=0.30), at(X=FIN_HINGE + RUD_GAP_FIN)]
        up[0] = (up[0][0] + le_ext, up[0][1], up[0][2])
        loop = [up[0]] + up[1:] + [(Xp, s, -h) for (Xp, s, h) in reversed(up[1:])]
    else:
        Xn, sn, _h = at(X=FIN_HINGE + RUD_NOSE)
        Xc, sc_, hc = at(X=FIN_HINGE - 0.004)
        Xt, st_, ht = at(X=fin_te)
        loop = [(Xn, sn, 0.0), (Xc, sc_, hc), (Xt, st_, ht), (Xt, st_, -ht), (Xc, sc_, -hc)]
    return [P3(fin_pt(Xp, s, n, sy)) for Xp, s, n in loop]


def build_fins(det):
    """Upper fin and ventral fin per boom end, both rooted in the boom with a flared fillet; strobe housing on the
    upper tip, accent cap on the ventral bottom."""
    mb = MB('fins')
    top = lambda X: (boom_top(X) - FIN_Z0) / CC  # noqa: E731
    bot = lambda X: (boom_bot(X) - FIN_Z0) / CC  # noqa: E731
    for sy in (1, -1):
        for loops in ([_fin_loop(lambda X: top(X) - 0.05, fin_le_up, sy, hk=3.0, le_ext=0.12),
                       _fin_loop(lambda X: top(X) + FIN_FLARE, fin_le_up, sy),
                       _fin_loop(lambda X: S_TIP, fin_le_up, sy)],
                      [_fin_loop(lambda X: bot(X) + 0.05, fin_le_lo, sy, hk=3.0, le_ext=0.10),
                       _fin_loop(lambda X: bot(X) - FIN_FLARE, fin_le_lo, sy),
                       _fin_loop(lambda X: S_BOT, fin_le_lo, sy)]):
            n = len(loops[0])
            slab(mb, loops, lambda j: 'Paint_Accent' if j in (0, n - 1) else 'Paint_White',
                 ('Paint_White', 'Paint_Accent'))
        es = V(0, sy * SC, CC)
        xa, xb = fin_le_up(S_TIP) - 0.03, FIN_HINGE + 0.02
        p0 = P3(fin_pt(xa, S_TIP + 0.006, 0.0, sy))
        p1 = P3(fin_pt(xb, S_TIP + 0.006, 0.0, sy))
        hexbar(mb, p0, p1, 0.024, 0.026, 'Paint_Accent', up=es, point0=0.05, point1=0.02)
        tp = P3(fin_pt(0.5 * (xa + xb), S_TIP + 0.018, 0.0, sy))
        K.lamp(det, tp, es, kind='white', r=0.0095, length=0.013, base='Paint_Dark')
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', tp + es * 0.035)
    return mb.finish(sharp_angle=30)


RUDDERS = {}


def build_rudders():
    """One rudder per fin, from the ventral bottom to the upper tip, hinged behind the boom end. Node origin on the
    hinge mid point, node rotation = the fin cant about X (the mesh is stored un-canted)."""
    for sy, name in ((1, 'rudder_L'), (-1, 'rudder_R')):
        loops = [_fin_loop(lambda X: RUD_S0, fin_le_lo, sy, 'rudder'), _fin_loop(lambda X: S_BB, fin_le_lo, sy, 'rudder'),
                 _fin_loop(lambda X: 0.0, fin_le_up, sy, 'rudder'), _fin_loop(lambda X: RUD_S1, fin_le_up, sy, 'rudder')]
        mb = MB(name)
        slab(mb, loops, lambda j: 'Paint_White', ('Paint_Accent', 'Paint_Accent'))
        origin = P3(fin_pt(FIN_HINGE, 0.5 * (RUD_S0 + RUD_S1), 0.0, sy))
        ob = mb.finish(origin=(0, 0, 0), sharp_angle=30)
        phi = -sy * CANT
        rot = Matrix.Rotation(phi, 4, 'X')
        ob.data.transform(rot.inverted() @ Matrix.Translation(-origin))
        ob.location = origin
        ob.rotation_euler = (phi, 0.0, 0.0)
        RUDDERS[name] = (ob, origin.copy(), phi, (RUD_S0, RUD_S1))


def restore_rudders():
    for name, (_ob, origin, phi, _s) in RUDDERS.items():
        ob = bpy.data.objects[name]
        ob.location = origin
        ob.rotation_mode = 'XYZ'
        ob.rotation_euler = (phi, 0.0, 0.0)



# =========================================================================================================
# rotor head, rotor, hidden compressor
# =========================================================================================================
def build_head():
    mb = MB('rotor_head')
    c = PIVOT
    mb.box(c, (0.10, 0.075, 0.055), 'Engine', bevel=0.01, segs=2)
    mb.cyl(c + V(0, -0.065, 0), c + V(0, 0.065, 0), 0.012, 'Metal_Frame', n=12)
    mb.cyl(c + V(-0.07, 0, 0.032), c + V(0.07, 0, 0.032), 0.015, 'Engine_Dark', n=14)
    z0, z1 = c.z + 0.045, HUB.z - 0.058
    mb.lathe([(0.0, z0), (0.050, z0), (0.056, z0 + 0.010), (0.056, z1 - 0.016), (0.062, z1 - 0.012),
              (0.074, z1 - 0.010), (0.074, z1), (0.0, z1)], V(HUB.x, 0, 0), V(0, 0, 1), 'Engine_Dark', n=24)
    return mb.finish(origin=PIVOT, sharp_angle=40, wn=True)

R_TIP0 = ROTOR_R - 0.27


def _rotor_blade(mb, az):
    c0 = ROTOR_CHORD
    pitch = Matrix.Rotation(math.radians(2.5), 3, 'X')
    cone = Matrix.Rotation(math.radians(-1.3), 3, 'Y')
    spin = Matrix.Rotation(az, 3, 'Z')

    def sect(r, n=14):
        u = min(1.0, max(0.0, (r - 0.18) / 0.36))
        sm = u * u * (3 - 2 * u)
        tc = lerp(0.40, 0.12, sm)
        c = lerp(0.085, c0, sm)
        y_le, y_te = 0.25 * c, -0.75 * c
        if r > R_TIP0:
            y_le = 0.25 * c0 - (r - R_TIP0) * T35
            y_te = -0.75 * c0 - max(0.0, r - (ROTOR_R - 0.10)) * math.tan(math.radians(20))
            tc = lerp(0.12, 0.10, (r - R_TIP0) / (ROTOR_R - R_TIP0))
        cc = max(y_le - y_te, 0.01)
        out = []
        for s, tz in airfoil_ring(n, tc, te_min=0.0035):
            p = pitch @ Vector((0.0, y_le - s * cc, tz * cc))
            out.append(HUB + spin @ (cone @ Vector((r, p.y, p.z))))
        return out
    rs = [0.16, 0.22, 0.28, 0.34, 0.40, 0.47, 0.56] + [lerp(0.56, R_TIP0, k / 8) for k in range(1, 9)] + \
         [R_TIP0 + (ROTOR_R - R_TIP0) * k / 4 for k in range(1, 5)]
    mb.loft([sect(r) for r in rs], 'Rotor_Blade', closed=True, cap0=True, cap1=True)


def build_rotor():
    K.ensure_materials()
    mb = MB('rotor')
    for b in range(ROTOR_N):
        _rotor_blade(mb, TAU * b / ROTOR_N)
    for b in range(ROTOR_N):
        a = TAU * b / ROTOR_N
        d = V(math.cos(a), math.sin(a), 0)
        mb.box(HUB + d * 0.13 - V(0, 0, 0.005), (0.24, 0.10, 0.045), 'Engine_Dark', bevel=0.008, segs=1,
               rot=Euler((0, 0, a)))
    # low lens-shaped hub cap (no nut), thin edge-treatment ring
    prof = [(0.0, -0.058), (0.195, -0.058), (0.205, -0.046)] + \
           [(0.205 * math.cos(0.5 * math.pi * k / 10) ** 0.8, -0.046 + 0.088 * math.sin(0.5 * math.pi * k / 10) ** 1.3)
            for k in range(1, 11)]
    mb.lathe(prof, V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Paint_White', n=48)
    mb.lathe([(0.2065, -0.054), (0.2075, -0.050), (0.2075, -0.046)], V(HUB.x, 0, HUB.z), V(0, 0, 1), 'Paint_Accent',
             n=48)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


def build_prop():
    mb = MB('prop')
    c = PROP
    ax = V(1, 0, 0)
    mb.lathe([(0.0, 0.05), (0.06, 0.05), (0.07, 0.03), (0.07, -0.03), (0.06, -0.05), (0.0, -0.05)], c, ax,
             'Vane_Metal', n=16)
    for k in range(PROP_N):
        a = TAU * k / PROP_N
        er, et = V(0, math.cos(a), math.sin(a)), V(0, -math.sin(a), math.cos(a))
        p0, p1 = c + er * 0.065, c + er * (PROP_R - 0.005)
        tw = Matrix.Rotation(math.radians(35), 3, er)
        d = (tw @ V(1, 0, 0)) * 0.025
        e2 = (tw @ et) * 0.004
        mb.faces([p0 - d - e2, p1 - d - e2, p1 + d - e2, p0 + d - e2, p0 - d + e2, p1 - d + e2, p1 + d + e2, p0 + d + e2],
                 [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]], 'Vane_Metal',
                 smooth=False)
    mb.lathe([(PROP_R - 0.006, -0.03), (PROP_R, -0.03), (PROP_R, 0.03), (PROP_R - 0.006, 0.03)], c, ax, 'Vane_Metal',
             n=40, closed_profile=True)
    return mb.finish(origin=c, sharp_angle=40, merge=1e-6)


def facet_spat(name, c, front, back, w, zt, zb, mat='Paint_White'):
    c = Vector(c)

    def sec(dx, s, lift=0.0):
        z0 = c.z + zb
        return [V(c.x + dx, c.y + w * s, z0), V(c.x + dx, c.y + w * s, c.z + 0.55 * zt * s + lift),
                V(c.x + dx, c.y + 0.55 * w * s, c.z + zt * (0.55 + 0.45 * s) + lift),
                V(c.x + dx, c.y - 0.55 * w * s, c.z + zt * (0.55 + 0.45 * s) + lift),
                V(c.x + dx, c.y - w * s, c.z + 0.55 * zt * s + lift), V(c.x + dx, c.y - w * s, z0)]
    loops = [sec(front, 0.08, -0.03), sec(front * 0.55, 0.85), sec(-back * 0.25, 1.0), sec(-back * 0.70, 0.90, 0.01),
             sec(-back, 0.10, 0.03)]
    mb = MB(name)
    for k in range(len(loops) - 1):
        a, b_ = loops[k], loops[k + 1]
        for j in range(5):
            mb.faces([a[j], a[j + 1], b_[j + 1], b_[j]], [[0, 1, 2, 3]], mat, smooth=False)
    mb.faces(loops[0], [[0, 1, 2, 3, 4, 5]], mat, smooth=False)
    mb.faces(loops[-1], [[5, 4, 3, 2, 1, 0]], mat, smooth=False)
    ob = mb.finish(sharp_angle=30, recalc=False)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    B.apply_mods(ob)
    return ob


def gear_door(mb, x0, x1, y, z_top, h, sy, teeth=0):
    """Open door hanging from a well edge: flat plate whose fore and aft ends are raked 55 deg (aligned edges)."""
    rk = h / T_LE
    poly = [(x0, z_top), (x0 - rk, z_top - h), (x1 - rk, z_top - h), (x1, z_top)]
    t = 0.010
    outer = [R(x, z, sy * (y + t)) for x, z in poly]
    inner = [R(x, z, sy * y) for x, z in poly]
    mb.faces(outer, [[0, 1, 2, 3]], 'Paint_White', smooth=False)
    mb.faces(inner, [[3, 2, 1, 0]], 'Paint_White', smooth=False)
    for i in range(4):
        i2 = (i + 1) % 4
        mb.faces([outer[i], outer[i2], inner[i2], inner[i]], [[0, 1, 2, 3]], 'Paint_Accent', smooth=False)



# =========================================================================================================
# cockpit
# =========================================================================================================
F_SW = B.hermite([0.0, 0.15, 0.45, 0.62, 0.70, 0.76, 0.84, 1.0], [0.40, 0.40, 0.42, 0.44, 0.34, 0.25, 0.27, 0.26])
F_SD = B.hermite([0.0, 0.25, 0.55, 0.68, 0.76, 0.86, 1.0], [0.06, 0.11, 0.09, 0.04, 0.03, 0.07, 0.05])


def sport_seat(mb, hip, back_deg, width=0.44, back_h=0.84, pan_len=0.46, screen=False):
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
        mb.box(sc, (0.016, 0.22, 0.125), 'Panel', bevel=0.006, segs=2, rot=rb)
        mb.box(sc - f * 0.0085, (0.002, 0.20, 0.104), 'Visor', rot=rb)


def hull_y(hull, X, Z):
    p, _n = hit([hull], R(X, Z, 0.0) + V(0, 0.4, 0), V(0, 1, 0), far=3.0)
    return p.y


def ray_inner(objs, o, d, far):
    best = None
    for ob in objs:
        inv = ob.matrix_world.inverted()
        ok, loc, _nn, _i = ob.ray_cast(inv @ o, (inv.to_3x3() @ d).normalized(), distance=far)
        if ok:
            dist = (ob.matrix_world @ loc - o).length
            if best is None or dist < best[0]:
                best = (dist, ob)
    return best


def build_lining(hull, canopy):
    """Cabin lining (inward-facing) from rays cast out of the cabin axis: hull hits shrink by 12 mm, rays that
    go far into the body are clipped (side walls), no lining where the ray leaves through the canopy."""
    mb = MB('cabin_lining')
    nr = 48
    xs = [lerp(BULK_AFT, BULK_FWD, k / 50) for k in range(51)]
    grid = []
    for X in xs:
        o = R(X, CABIN_ZC)
        row = []
        for k in range(nr):
            a = TAU * k / nr
            d = V(0, math.cos(a), math.sin(a))
            rmax = 0.78 if math.sin(a) > 0.5 else (0.55 if math.sin(a) > -0.3 else 0.62)
            h = ray_inner([hull, canopy], o, d, 2.0)
            if h is None:
                row.append((o + d * rmax, 'clip'))
            elif h[1] is canopy:
                row.append((o + d * min(h[0], rmax), 'glass'))
            elif h[0] - 0.012 > rmax:
                row.append((o + d * rmax, 'clip'))
            else:
                row.append((o + d * (h[0] - 0.012), 'hull'))
        grid.append(row)
    for i in range(len(xs) - 1):
        for k in range(nr):
            k2 = (k + 1) % nr
            q = [grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]]
            if any(t == 'glass' for _p, t in q):
                continue
            if all(p.z < R.z(FLOOR_Z + 0.03) for p, _t in q):
                continue
            pts = [p for p, _t in q]
            c = sum(pts, Vector()) / 4
            axis_pt = V(c.x, 0, R.z(CABIN_ZC))
            nrm = (pts[1] - pts[0]).cross(pts[3] - pts[0])
            if nrm.dot(axis_pt - c) < 0:
                pts = pts[::-1]
            mb.faces(pts, [[0, 1, 2, 3]], 'Interior', smooth=False)
    for i, sgn in ((0, 1), (len(xs) - 1, -1)):
        pts = [p for p, _t in grid[i]]
        nrm = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        if nrm.x * sgn < 0:
            pts = pts[::-1]
        mb.faces(pts, [list(range(nr))], 'Interior', smooth=False)
    return mb.finish(sharp_angle=60, recalc=False)


def build_cockpit(hull):
    sf = MB('seat_front')
    sport_seat(sf, FRONT_HIP, FRONT_BACK, width=0.42, back_h=0.84, screen=True)
    sr = MB('seat_rear')
    sport_seat(sr, REAR_HIP, REAR_BACK, width=0.46, back_h=0.80)
    mb = MB('cockpit')
    xs = [lerp(BULK_AFT + 0.01, 1.48, k / 40) for k in range(41)]
    rings = []
    for X in xs:
        zf = max(FLOOR_Z, zlo(X, 0.0) + 0.035)
        hw = max(hull_y(hull, X, zf) - 0.03, 0.02)
        rings.append([R(X, zf, hw), R(X, zf, -hw), R(X, zf - 0.008, -hw), R(X, zf - 0.008, hw)])
    mb.loft(rings, 'Interior', closed=True, cap0=True, cap1=True, smooth=False)
    for sy in (1, -1):
        for x0, x1, zc, yi in ((0.90, 1.38, -2.14, 0.335), (-0.02, 0.42, -2.12, 0.36)):
            Xc = 0.5 * (x0 + x1)
            yw = min(hull_y(hull, Xc, zc) - 0.02, 0.50)
            if yw < yi + 0.06:
                yw = yi + 0.12
            mb.box(R(Xc, zc, sy * 0.5 * (yi + yw)), (x1 - x0, yw - yi, 0.045), 'Carbon', bevel=0.012, segs=2)
        mb.box(R(0.71, -2.332, sy * 0.255), (0.22, 0.10, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    return sf.finish(sharp_angle=40, wn=True), sr.finish(sharp_angle=40, wn=True), mb.finish(sharp_angle=40, wn=True)


def eye_point():
    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    return head + V(0.077, 0, 0.007)



# =========================================================================================================
# verification and previews
# =========================================================================================================
def g(X, Z, y=0.0):
    p = R(X, Z, y)
    return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)


def gm(p):
    return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)


def _integrate(f, a, b, n=600):
    h = (b - a) / n
    return sum(f(a + (k + 0.5) * h) for k in range(n)) * h


def render_previews(scn):
    B.setup_render(scn)
    coll, cam = B.setup_studio(scn)
    rotor = bpy.data.objects.get('rotor')
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
        defl = v.get('rudder')
        if defl:
            for rname, (_ob, origin, phi, _s) in RUDDERS.items():
                ob = bpy.data.objects[rname]
                ob.matrix_world = (Matrix.Translation(origin) @ Matrix.Rotation(phi, 4, 'X') @
                                   Matrix.Rotation(-math.radians(defl), 4, 'Z'))
        gpose = v.get('gear')
        if gpose is not None:
            pose_gear(gpose)
        ghost = xray(True) if v.get('xray') else None
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
        if defl:
            restore_rudders()
        if gpose is not None:
            pose_gear(0.0)
        if ghost is not None:
            xray(False, ghost)
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


# =========================================================================================================
# retractable landing gear
#   mains: each leg folds AFT about a lateral hinge into a keel nacelle under its boom (the beams carry the
#          gear, as on a P-38); two door leaves per nacelle bottom, hinged on its edges
#   nose:  the leg folds FORWARD about a lateral hinge into a bay under the instrument panel; two leaves
#   Pivot nodes gear_L / gear_R / gear_nose (origin on the hinge, identity when down) carry the leg; the
#   wheel nodes are their children. Door nodes door_* (origin on the hinge, identity when open).
# =========================================================================================================
GY = MAIN_Y                                # main wheel plane |y| (track 1.60)
MAIN_H = (-0.40, -2.03)                    # main leg hinge (hub X, Z), lateral axis
NOSE_P = (1.55, -2.27)                     # nose leg hinge (hub X, Z), lateral axis
NAC_BOT = -2.19                            # flat nacelle bottom (the doors)
NAC_F, NAC_R = -0.38, -1.24                # full-depth part of the nacelle
NAC_TF, NAC_TR = -0.24, -1.40              # nacelle tips, merged into the boom
NAC_HB, NAC_HS = 0.062, 0.072              # nacelle half width at the bottom and at the sides
DOOR_F, DOOR_R, CHEV = -0.40, -1.18, 0.04  # main bay opening: chevron edges (centre X) raked CHEV at the sides
NB_F, NB_R, NB_W = 2.09, 1.50, 0.070       # nose bay opening: chevron edges (centre X), half width
MAIN_ANG, NOSE_ANG = 72.1, 105.0           # leg retraction (deg)
DOOR_ANG, NDOOR_ANG = 100.0, 95.0          # door opening (deg)
GEAR = []                                  # (node, hinge point, unit axis (Blender), deg down->up / open->closed, late)
WHEEL_PARENT = {}


def nac_s(X):
    if X > NAC_F:
        return ss((NAC_TF - X) / (NAC_TF - NAC_F))
    if X < NAC_R:
        return ss((X - NAC_TR) / (NAC_R - NAC_TR))
    return 1.0


def nac_sec(X):
    """Nacelle section at hub X: (dy outboard of the wheel plane, Z), closed through the inside of the boom."""
    s = nac_s(X)
    zc = boom_z(X)
    zb = lerp(zc - 0.03, NAC_BOT, s)
    ws = lerp(0.35, 1.0, s)
    zm = lerp(zc, zb, 0.55)
    return [(-0.058 * ws, zc + 0.035), (-NAC_HS * ws, zm), (-NAC_HB * ws, zb), (NAC_HB * ws, zb),
            (NAC_HS * ws, zm), (0.058 * ws, zc + 0.02)]


def chev(x0, d, hw):
    """X of a chevron edge (centre x0, pointing forward) at lateral offset d from the bay centre line."""
    return x0 - CHEV * abs(d) / hw


def build_nacelles():
    mb = MB('nacelles')
    ln = MB('nacelle_wells')
    xs = [NAC_TF, -0.27, -0.31, -0.35, NAC_F, -0.44, -0.60, -0.80, -1.00, -1.18, -1.22, NAC_R, -1.28, -1.32,
          -1.36, NAC_TR]
    for sy in (1, -1):
        def P(X, dy, z):
            return R(X, z, sy * (GY + dy))
        rings = [[P(X, dy, z) for dy, z in nac_sec(X)] for X in xs]
        for k in range(len(xs) - 1):
            a, b = rings[k], rings[k + 1]
            core = xs[k] <= NAC_F + 1e-6 and xs[k + 1] >= NAC_R - 1e-6
            for j in range(6):
                if j == 2 and core:
                    continue
                j2 = (j + 1) % 6
                mat = 'Paint_Accent' if (j == 2 or (j in (1, 3) and not core)) else 'Paint_White'
                mb.faces([a[j], a[j2], b[j2], b[j]], [[0, 1, 2, 3]], mat, smooth=False)
        mb.faces(rings[0], [[5, 4, 3, 2, 1, 0]], 'Paint_White', smooth=False)
        mb.faces(rings[-1], [[0, 1, 2, 3, 4, 5]], 'Paint_White', smooth=False)
        # bottom panels round the bay opening (its fore and aft edges are parallel chevrons)
        i_f, i_f2, i_r2, i_r = xs.index(NAC_F), xs.index(-0.44), xs.index(-1.22), xs.index(NAC_R)
        cf, cr = P(DOOR_F, 0.0, NAC_BOT), P(DOOR_R, 0.0, NAC_BOT)
        mb.faces([rings[i_f][2], rings[i_f][3], rings[i_f2][3], cf, rings[i_f2][2]], [[0, 1, 2, 3, 4]], 'Paint_White',
                 smooth=False)
        mb.faces([cr, rings[i_r2][3], rings[i_r][3], rings[i_r][2], rings[i_r2][2]], [[0, 1, 2, 3, 4]], 'Paint_White',
                 smooth=False)
        # dark well liner (faces looking inwards), from the opening's front to its rear
        def liner_ring(X):
            sec = nac_sec(X)
            cy = sum(d for d, z in sec) / 6
            cz = sum(z for d, z in sec) / 6
            return [P(X, d + (cy - d) * 0.05, z + (cz - z) * 0.03 if j != 2 and j != 3 else NAC_BOT + 0.003)
                    for j, (d, z) in enumerate(sec)]
        la, lb = liner_ring(DOOR_F + 0.005), liner_ring(chev(DOOR_R, NAC_HB, NAC_HB) - 0.005)
        for j in range(6):
            if j == 2:
                continue
            j2 = (j + 1) % 6
            ln.faces([la[j], lb[j], lb[j2], la[j2]], [[0, 1, 2, 3]], 'Intake_Black', smooth=False)
        ln.faces(la, [[0, 1, 2, 3, 4, 5]], 'Intake_Black', smooth=False)
        ln.faces(lb, [[5, 4, 3, 2, 1, 0]], 'Intake_Black', smooth=False)
    wells = ln.finish(sharp_angle=30)
    wells.data.flip_normals()          # the well liner looks inwards
    return B.join_objects('nacelles', [mb.finish(sharp_angle=30), wells])


def _leaf(name, poly, thick, a, b, open_deg):
    """Door leaf from its CLOSED outline (outer surface points, CCW seen from outside) and a thickness vector
    (inwards), built OPEN: turned open_deg about the hinge line a->b. Origin on the hinge mid point."""
    axis = (b - a).normalized()
    mid = (a + b) * 0.5
    rot = Matrix.Rotation(math.radians(open_deg), 3, axis)
    outer = [mid + rot @ (p - mid) for p in poly]
    inner = [mid + rot @ (p + thick - mid) for p in poly]
    mb = MB(name)
    n = len(poly)
    mb.faces(outer, [list(range(n))], 'Paint_White', smooth=False)
    mb.faces(inner, [list(range(n))[::-1]], 'Paint_Dark', smooth=False)
    for i in range(n):
        i2 = (i + 1) % n
        mb.faces([outer[i], outer[i2], inner[i2], inner[i]], [[0, 1, 2, 3]], 'Paint_Accent', smooth=False)
    ob = mb.finish(origin=mid, sharp_angle=30)
    GEAR.append((name, mid.copy(), axis.copy(), -open_deg, True))
    return ob


def build_main_doors():
    out = []
    for sy, sfx in ((1, 'L'), (-1, 'R')):
        for side, dh in (('out', NAC_HB), ('in', -NAC_HB)):
            dc = 0.0015 if dh > 0 else -0.0015
            def P(X, d):
                return R(X, NAC_BOT, sy * (GY + d))
            poly = [P(chev(DOOR_F, dh, NAC_HB), dh), P(chev(DOOR_F, 0, NAC_HB), dc), P(chev(DOOR_R, 0, NAC_HB), dc),
                    P(chev(DOOR_R, dh, NAC_HB), dh)]
            a, b = P(chev(DOOR_R, dh, NAC_HB), dh), P(chev(DOOR_F, dh, NAC_HB), dh)
            free = (sy * (GY + dc)) - (sy * (GY + dh))           # Blender y from the hinge to the free edge
            out.append(_leaf('door_%s_%s' % (sfx, side), poly, V(0, 0, 0.005), a, b,
                             DOOR_ANG if free < 0 else -DOOR_ANG))
    return out


def build_nose_doors():
    out = []
    nu, nv = 14, 4
    for sy, sfx in ((1, 'L'), (-1, 'R')):
        grid = []
        for i in range(nv + 1):
            y = lerp(0.0015, NB_W, i / nv)
            xa, xb = chev(NB_R, y, NB_W), chev(NB_F, y, NB_W)
            grid.append([R(X, zlo(X, y) - 0.0015, sy * y) for X in [lerp(xa, xb, j / nu) for j in range(nu + 1)]])
        a, b = grid[-1][0], grid[-1][-1]
        axis = (b - a).normalized()
        mid = (a + b) * 0.5
        od = NDOOR_ANG if sy > 0 else -NDOOR_ANG                  # free edge towards the centre line
        rot = Matrix.Rotation(math.radians(od), 3, axis)
        mb = MB('door_nose_' + sfx)
        th = V(0, 0, 0.005)
        for i in range(nv):
            for j in range(nu):
                q = [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]]
                mb.faces([mid + rot @ (p - mid) for p in q], [[0, 1, 2, 3] if sy > 0 else [3, 2, 1, 0]], 'Paint_White',
                         smooth=False)
                mb.faces([mid + rot @ (p + th - mid) for p in q], [[3, 2, 1, 0] if sy > 0 else [0, 1, 2, 3]],
                         'Paint_Dark', smooth=False)
        rim = grid[0] + [grid[i][-1] for i in range(1, nv + 1)] + grid[-1][-2::-1] + [grid[i][0] for i in
                                                                                     range(nv - 1, 0, -1)]
        for k in range(len(rim)):
            p, q = rim[k], rim[(k + 1) % len(rim)]
            mb.faces([mid + rot @ (p - mid), mid + rot @ (q - mid), mid + rot @ (q + th - mid), mid + rot @ (p + th - mid)],
                     [[0, 1, 2, 3]], 'Paint_Accent', smooth=False)
        ob = mb.finish(origin=mid, sharp_angle=30)
        GEAR.append(('door_nose_' + sfx, mid.copy(), axis.copy(), -od, True))
        out.append(ob)
    return out


def build_main_gear():
    out = []
    for sy, sfx in ((1, 'L'), (-1, 'R')):
        H = R(MAIN_H[0], MAIN_H[1], sy * GY)
        A = R(AXLE[0], AXLE[1], sy * GY)
        C = A + V(0.0, 0.0, R_MAIN + 0.045)
        mb = MB('gear_' + sfx)
        mb.cyl(H + V(0, -0.052, 0), H + V(0, 0.052, 0), 0.018, 'Metal_Frame', n=14)
        top = C + V(0, 0, 0.02)
        hexbar(mb, H, top, 0.046, 0.036, 'Paint_Dark', up=V(0, 1, 0))
        d = (top - H).normalized()
        mb.cyl(top - d * 0.13, top, 0.0155, 'Chrome', n=12)
        mb.box(C + V(0, 0, 0.012), (0.05, 0.098, 0.026), 'Metal_Frame', bevel=0.006, segs=1)
        for k in (-1, 1):
            mb.box((C + A) * 0.5 + V(0, k * 0.045, 0), (0.024, 0.009, (C - A).length + 0.02), 'Metal_Frame',
                   bevel=0.003, segs=1)
        mb.cyl(A + V(0, -0.056, 0), A + V(0, 0.056, 0), 0.010, 'Metal_Frame', n=10)
        out.append(mb.finish(origin=H, sharp_angle=40))
        B.build_wheel('wheel_' + sfx, A, R_MAIN, W_MAIN, R_MAIN * 0.60)
        GEAR.append(('gear_' + sfx, H.copy(), V(0, 1, 0), MAIN_ANG, False))
        WHEEL_PARENT['wheel_' + sfx] = 'gear_' + sfx
    return out


def build_nose_gear():
    P = R(NOSE_P[0], NOSE_P[1])
    A = R(NOSE[0], NOSE[1])
    C = A + V(0, 0, R_NOSE + 0.045)
    mb = MB('gear_nose')
    mb.cyl(P + V(0, -0.046, 0), P + V(0, 0.046, 0), 0.017, 'Metal_Frame', n=14)
    top = C + V(0, 0, 0.032)
    hexbar(mb, P, top, 0.040, 0.034, 'Paint_Dark', up=V(0, 1, 0))
    d = (top - P).normalized()
    mb.cyl(top - d * 0.10, top, 0.014, 'Chrome', n=12)
    ob = mb.finish(origin=P, sharp_angle=40)
    nb = MB('nose_wheel')
    nb.lathe(B.tire_profile(R_NOSE, R_NOSE * 0.56, W_NOSE), A, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    hw = W_NOSE * 0.36
    nb.lathe([(0.0, -hw), (0.03, -hw), (0.045, -hw * 0.75), (R_NOSE * 0.55, -hw * 0.95), (R_NOSE * 0.6, -hw),
              (R_NOSE * 0.6, hw), (R_NOSE * 0.55, hw * 0.95), (0.045, hw * 0.75), (0.03, hw), (0.0, hw)], A,
             V(0, 1, 0), 'Engine', n=28)
    nb.cyl(A + V(0, -0.049, 0), A + V(0, 0.049, 0), 0.009, 'Metal_Frame', n=10)
    for k in (-1, 1):
        nb.box((C + A) * 0.5 + V(0, k * 0.045, 0), (0.022, 0.009, (C - A).length + 0.02), 'Metal_Frame', bevel=0.003,
               segs=1)
    nb.box(C, (0.05, 0.094, 0.026), 'Metal_Frame', bevel=0.006, segs=1)
    nb.cyl(C, C + V(0, 0, 0.034), 0.0125, 'Metal_Frame', n=12)
    nb.finish(origin=A, sharp_angle=40)
    GEAR.append(('gear_nose', P.copy(), V(0, 1, 0), -NOSE_ANG, False))
    WHEEL_PARENT['nose_wheel'] = 'gear_nose'
    return ob


def _gear_pts(names, hinge, ang, axis):
    """World vertices of the named objects turned `ang` degrees about the hinge line."""
    bpy.context.view_layer.update()
    M = Matrix.Translation(hinge) @ Matrix.Rotation(math.radians(ang), 4, axis) @ Matrix.Translation(-hinge)
    pts = []
    for nm in names:
        ob = bpy.data.objects[nm]
        mw = M @ ob.matrix_world
        pts += [mw @ v.co for v in ob.data.vertices]
    return pts


def build_nose_tunnel():
    """Hood over the nose-wheel bay inside the cockpit (under the panel, between the pedals), shaped round the
    leg's whole sweep."""
    hinge = R(NOSE_P[0], NOSE_P[1])
    pts = []
    for k in range(0, 22):
        pts += _gear_pts(['gear_nose', 'nose_wheel'], hinge, -NOSE_ANG * k / 21, V(0, 1, 0))
    inside = [p for p in pts if p.z - R.dz > zlo(p.x - R.dx, p.y) + 0.002]
    hw = max(abs(p.y) for p in inside) + 0.010
    x0 = min(p.x for p in inside) - R.dx - 0.02
    x1 = max(p.x for p in inside) - R.dx + 0.02
    n = 24
    tops = []
    for j in range(n + 1):
        X = lerp(x0, x1, j / n)
        near = [p.z - R.dz for p in inside if abs(p.x - R.dx - X) < (x1 - x0) / n + 0.03]
        tops.append(max(near) + 0.015 if near else zlo(X, 0.0) + 0.02)
    rings = []
    for j in range(n + 1):
        X = lerp(x0, x1, j / n)
        zb = zlo(X, hw) + 0.004
        zt = max(tops[j], zb + 0.01)
        rings.append([R(X, zb, hw), R(X, zt, 0.6 * hw), R(X, zt, -0.6 * hw), R(X, zb, -hw)])
    mb = MB('nose_tunnel')
    for j in range(n):
        a, b = rings[j], rings[j + 1]
        for i in range(3):
            mb.faces([a[i], b[i], b[i + 1], a[i + 1]], [[0, 1, 2, 3]], 'Interior', smooth=False)
    mb.faces(rings[0], [[0, 1, 2, 3]], 'Interior', smooth=False)
    mb.faces(rings[-1], [[3, 2, 1, 0]], 'Interior', smooth=False)
    print('SX nose tunnel: X %.3f..%.3f hub, half width %.3f, top Z max %.3f' % (x0, x1, hw, max(tops)))
    return mb.finish(sharp_angle=30)


def attach_wheels():
    """After K.finalize (which unparents everything): the wheels become children of their gear nodes."""
    for wn, gn in WHEEL_PARENT.items():
        w, g = bpy.data.objects[wn], bpy.data.objects[gn]
        pw = w.matrix_world.translation.copy()
        w.parent = g
        w.matrix_parent_inverse = Matrix.Identity(4)
        w.location = pw - g.location
    bpy.context.view_layer.update()


def pose_gear(r):
    """Pose for a retraction fraction r (0 down, 1 up) with the sim's timing: legs in the first 70 %, doors
    (late) in the last 30 %."""
    for name, hinge, axis, ang, late in GEAR:
        x = (r - 0.7) / 0.3 if late else r / 0.7
        k = 0.0 if x <= 0 else 1.0 if x >= 1 else x * x * (3 - 2 * x)
        ob = bpy.data.objects[name]
        ob.matrix_world = Matrix.Translation(hinge) @ Matrix.Rotation(math.radians(ang * k), 4, axis)
    bpy.context.view_layer.update()


def xray(on, saved=None):
    if on:
        m = bpy.data.materials.get('Xray_Ghost')
        if m is None:
            m = bpy.data.materials.new('Xray_Ghost')
            m.use_nodes = True
            bs = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
            bs.inputs['Base Color'].default_value = (0.30, 0.36, 0.48, 1)
            bs.inputs['Alpha'].default_value = 0.22
            try:
                m.surface_render_method = 'BLENDED'
            except Exception:
                pass
        saved = []
        ghosts = ['airframe', 'windscreen'] + [g[0] for g in GEAR if g[0].startswith('door_')]
        keep = ghosts + [g[0] for g in GEAR] + list(WHEEL_PARENT)
        for ob in bpy.context.scene.objects:
            if ob.type == 'MESH' and ob.name not in keep and not ob.hide_render and not ob.name.startswith('ground'):
                ob.hide_render = True
                saved.append((ob, None))
        for nm in ghosts:
            ob = bpy.data.objects.get(nm)
            if ob:
                saved.append((ob, list(ob.data.materials)))
                for i in range(len(ob.data.materials)):
                    ob.data.materials[i] = m
        return saved
    for ob, mats in saved:
        if mats is None:
            ob.hide_render = False
            continue
        for i, mm in enumerate(mats):
            ob.data.materials[i] = mm
    return None


def _poly_margin(pt, poly):
    """Signed distance of a 2-D point to a convex polygon (positive inside)."""
    n = len(poly)
    area = sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1] for i in range(n))
    s = 1.0 if area > 0 else -1.0
    best = 1e9
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        ex, ey = x1 - x0, y1 - y0
        L = math.hypot(ex, ey)
        if L < 1e-9:
            continue
        best = min(best, s * (ex * (pt[1] - y0) - ey * (pt[0] - x0)) / L)
    return best


def _boom_poly(X):
    w, h, zc = boom_hw(X), boom_h(X), boom_z(X)
    return [(0.45 * w, zc + 0.5 * h), (w, zc), (0.45 * w, zc - 0.5 * h), (-0.45 * w, zc - 0.5 * h), (-w, zc),
            (-0.45 * w, zc + 0.5 * h)]


def gear_check():
    """Fully retracted, how deep every leg and wheel sits inside the skin; and that the legs pass the skin only
    through the bay openings."""
    res = {}
    for sy, sfx in ((1, 'L'), (-1, 'R')):
        H = R(MAIN_H[0], MAIN_H[1], sy * GY)
        worst = None
        for p in _gear_pts(['gear_' + sfx, 'wheel_' + sfx], H, MAIN_ANG, V(0, 1, 0)):
            X, y, Z = p.x - R.dx, sy * p.y, p.z - R.dz
            m1 = _poly_margin((y - GY, Z), nac_sec(X)) if NAC_TR < X < NAC_TF else -1.0
            m2 = _poly_margin((y - BOOM_Y, Z), _boom_poly(X)) if BOOM_X1 < X < BOOM_X0 else -1.0
            m = max(m1, m2)
            if worst is None or m < worst[0]:
                worst = (m, (round(X, 3), round(y, 3), round(Z, 3)))
        res['main_' + sfx] = worst
        bad = 0
        for k in range(1, 20):
            for p in _gear_pts(['gear_' + sfx, 'wheel_' + sfx], H, MAIN_ANG * k / 20, V(0, 1, 0)):
                X, dy, Z = p.x - R.dx, sy * p.y - GY, p.z - R.dz
                if abs(Z - NAC_BOT) < 0.01 and NAC_TR < X < NAC_TF:
                    if not (abs(dy) < NAC_HB and chev(DOOR_R, dy, NAC_HB) < X < chev(DOOR_F, dy, NAC_HB)):
                        bad += 1
        res['main_%s_outside_opening' % sfx] = bad
    P = R(NOSE_P[0], NOSE_P[1])
    worst = None
    for p in _gear_pts(['gear_nose', 'nose_wheel'], P, -NOSE_ANG, V(0, 1, 0)):
        X, y, Z = p.x - R.dx, p.y, p.z - R.dz
        m = min(Z - zlo(X, y), zup(X, y) - Z) if abs(y) < ye(X) else -1.0
        if worst is None or m < worst[0]:
            worst = (m, (round(X, 3), round(y, 3), round(Z, 3)))
    res['nose'] = worst
    bad = 0
    ymax = 0.0
    offs = []
    for k in range(1, 20):
        for p in _gear_pts(['gear_nose', 'nose_wheel'], P, -NOSE_ANG * k / 20, V(0, 1, 0)):
            X, y, Z = p.x - R.dx, p.y, p.z - R.dz
            if abs(Z - zlo(X, y)) < 0.01:
                ymax = max(ymax, abs(y))
                if not (abs(y) < NB_W and chev(NB_R, y, NB_W) < X < chev(NB_F, y, NB_W)):
                    bad += 1
                    offs.append((k, round(X, 3), round(y, 3), round(Z, 3)))
    res['nose_outside_opening'] = (bad, offs[:6])
    res['nose_max_y_at_skin'] = round(ymax, 3)
    for k, v in res.items():
        print('SX gear check %-24s %s' % (k, v))
    return res


def gear_up_report():
    """Gear up: the lowest points of the closed belly, nacelles and doors (what a wheels-up landing touches),
    the stowed wheel bottoms, and a flat-plate drag estimate of the extended gear."""
    pose_gear(1.0)
    pts = []
    for nm in ['airframe'] + [g[0] for g in GEAR if g[0].startswith('door_')]:
        ob = bpy.data.objects[nm]
        mw = ob.matrix_world
        pts += [(nm, mw @ v.co) for v in ob.data.vertices]
    regions = [('nose bay doors', lambda X, y: X > 1.45 and abs(y) < 0.08),
               ('cabin keel', lambda X, y: -0.4 < X <= 1.0 and abs(y) < 0.5),
               ('aft pod belly', lambda X, y: -1.45 < X <= -0.4 and abs(y) < 0.5),
               ('nacelle bottom L', lambda X, y: -1.45 < X < -0.2 and y > 0.6),
               ('nacelle bottom R', lambda X, y: -1.45 < X < -0.2 and y < -0.6),
               ('ventral fin L', lambda X, y: X < -2.0 and y > 0.5),
               ('ventral fin R', lambda X, y: X < -2.0 and y < -0.5)]
    for label, f in regions:
        sel = [(p.z, nm, p) for nm, p in pts if f(p.x - R.dx, p.y)]
        if sel:
            z, nm, p = min(sel, key=lambda t: t[0])
            print('SX gear-up crash %-26s %s  (%.3f m above the ground)' % (label, gm(p), z - R.z(GROUND)))
    for wn in WHEEL_PARENT:
        ob = bpy.data.objects[wn]
        zmin = min((ob.matrix_world @ v.co).z for v in ob.data.vertices)
        print('SX gear-up %-10s stowed, lowest point %.3f m above the ground (rises %.3f m)' % (
            wn, zmin - R.z(GROUND), zmin - R.z(GROUND)))
    pose_gear(0.0)
    a_wheel = 2 * R_MAIN * W_MAIN
    legs = 2 * 0.30 * 0.046 + 0.13 * 0.040
    f = 3 * 0.25 * a_wheel + 1.0 * legs + 0.006 + 0.012
    print('SX drag: extended gear flat-plate area ~%.3f m2 (3 wheels %.4f m2 frontal each at CD 0.25, legs %.3f m2 '
          'at CD 1.0, forks/axles 0.006, open wells and doors 0.012)' % (f, a_wheel, legs))


def _model_axis(a):
    return (round(a.x, 4), round(a.z, 4), round(-a.y, 4))


def gear_sheet():
    gear_up_report()
    print('SX ---- retractable gear (model axes x fwd, y up, z right; angle = right-hand rule about the axis,')
    print('SX      from down/open to up/closed; late = the sim moves it in the last 30 % of a retraction)')
    for name, hinge, axis, ang, late in GEAR:
        print('SX gear node %-12s hinge %s  axis %s  angle %+.1f deg  %s' % (
            name, gm(hinge), _model_axis(axis), ang, 'late (closes after the gear is in)' if late else 'leg'))
    print('SX sim spec: parts=[%s]' % ', '.join("{node:'%s',axis:[%g,%g,%g],angle:%.1f%s}" % (
        (name,) + _model_axis(axis) + (ang, ',late:true' if late else '')) for name, hinge, axis, ang, late in GEAR))


_KIT_VERIFY = B.verify_glb


def verify_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    clen, _ctype = struct.unpack_from('<II', data, 12)
    js = json.loads(data[20:20 + clen].decode('utf8'))
    nodes = js['nodes']
    roots = js['scenes'][js.get('scene', 0)]['nodes']
    by_name = {nodes[i].get('name'): nodes[i] for i in roots}
    ok = True
    for name in ('rudder_L', 'rudder_R'):
        n = by_name.get(name)
        if n is None:
            print('  !! missing root node', name)
            ok = False
            continue
        q = n.get('rotation', [0, 0, 0, 1])
        ang = math.degrees(2 * math.atan2(q[0], q[3]))
        if abs(q[1]) > 1e-5 or abs(q[2]) > 1e-5 or n.get('scale'):
            print('  !! %s rotation not about X only: %s' % (name, q))
            ok = False
        print('  %s rotation about X %.2f deg (quaternion %s)' % (name, ang, [round(c, 5) for c in q]))
        n.pop('rotation', None)
    if 'rudder' in by_name:
        print('  !! a node named rudder exists')
        ok = False
    # wheels nested under their gear nodes: identity rotation, origin on the axle
    idx = {n.get('name'): i for i, n in enumerate(nodes)}
    nested = {}
    for wn, gn in WHEEL_PARENT.items():
        want = B.REQUIRED.get(wn)
        nested[wn] = want
        gi, wi = idx.get(gn), idx.get(wn)
        if gi is None or wi is None or wi not in nodes[gi].get('children', []):
            print('  !! %s is not a child of %s' % (wn, gn))
            ok = False
            continue
        g, w = nodes[gi], nodes[wi]
        if w.get('rotation') or w.get('scale') or g.get('rotation') or g.get('scale'):
            print('  !! %s / %s rotated or scaled' % (gn, wn))
            ok = False
        t = [a + b for a, b in zip(g.get('translation', [0, 0, 0]), w.get('translation', [0, 0, 0]))]
        print('  nested node %-10s in %-9s local t=%s  world t=(%.3f, %.3f, %.3f)' % (
            wn, gn, [round(c, 4) for c in w.get('translation', [0, 0, 0])], t[0], t[1], t[2]))
        if want and max(abs(a - b) for a, b in zip(t, want)) > 1e-3:
            print('  !! wrong world translation', wn, t, want)
            ok = False
    for wn in nested:
        B.REQUIRED.pop(wn, None)
    tmp = path + '.chk.glb'
    js_b = json.dumps(js, separators=(',', ':')).encode('utf8')
    js_b += b' ' * ((4 - len(js_b) % 4) % 4)
    rest = data[20 + clen:]
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js_b) + len(rest)) + struct.pack('<II', len(js_b),
                                                                                         0x4E4F534A) + js_b + rest
    with open(tmp, 'wb') as f:
        f.write(out)
    try:
        ok2, tris = _KIT_VERIFY(tmp)
    finally:
        os.remove(tmp)
        B.REQUIRED.update(nested)
    print('  SIGILO VERIFY', 'OK' if (ok and ok2) else 'FAILED')
    return ok and ok2, tris


B.verify_glb = verify_glb

# =========================================================================================================
# details and lights
# =========================================================================================================
def build_details(hull, det):
    # landing lamp in its dark sawtooth bay under the nose
    p, n = hit([hull], R(2.16, -2.25), V(0, 0, -1))
    d = V(1.0, 0.0, -0.32).normalized()
    det.lathe([(0.0, -0.002), (0.030, -0.002), (0.030, 0.004), (0.0, 0.004)], p, n, 'Chrome', n=16)
    K.lamp(det, p + n * 0.003, d, kind='white', r=0.019, length=0.012, base='Chrome')
    K.lamp_node('landing', p + n * 0.004 + d * 0.035)
    # small faceted sensor blister on the nose deck ahead of the windscreen (dark window facing forward)
    sx = 2.10
    rings = []
    for dx, w, h in ((0.05, 0.0, 0.0), (0.03, 0.020, 0.018), (0.0, 0.028, 0.024), (-0.05, 0.022, 0.016),
                     (-0.09, 0.0, 0.0)):
        X = sx + dx
        zb = zup(X, 0.0) - 0.004
        if w == 0.0:
            rings.append([R(X, zb, 0.0)])
            continue
        rings.append([R(X, zb, w), R(X, zb + 0.6 * h, 0.8 * w), R(X, zb + h, 0.0), R(X, zb + 0.6 * h, -0.8 * w),
                      R(X, zb, -w)])
    for k in range(len(rings) - 1):
        a_, b_ = rings[k], rings[k + 1]
        mat = 'Sensor_Dark' if k < 2 else 'Paint_Accent'
        if len(a_) == 1:
            for j in range(4):
                det.faces([a_[0], b_[j + 1], b_[j]], [[0, 1, 2]], mat, smooth=False)
        elif len(b_) == 1:
            for j in range(4):
                det.faces([a_[j], a_[j + 1], b_[0]], [[0, 1, 2]], mat, smooth=False)
        else:
            for j in range(4):
                det.faces([a_[j], a_[j + 1], b_[j + 1], b_[j]], [[0, 1, 2, 3]], mat, smooth=False)
    # tail light on the tailplane trailing edge, looking aft
    tp = R(tp_te(0.0) - 0.003, TP_Z, 0.0)
    K.lamp(det, tp, V(-1, 0, 0), kind='white', r=0.010, length=0.011, base='Paint_Dark')
    K.lamp_node('tail', tp + V(-0.035, 0, 0))
    # red beacon on the mast trailing edge
    lp = mast_loops()
    bp = lp[2][3].lerp(lp[3][3], 0.40) + V(-0.003, 0, 0)
    K.lamp(det, bp, V(-1, 0, 0.15), kind='red', r=0.012, length=0.016, base='Paint_Dark')
    K.lamp_node('beacon', bp + V(-0.035, 0, 0.005), 'red')
    # blade antennas (belly aft, right boom top), flush static ports on the nose flanks
    for (X, Z0, y, sgn, hgt) in ((-0.62, zlo(-0.62, 0.0), 0.0, -1, 0.06),
                                 (-1.70, boom_top(-1.70), -BOOM_Y, 1, 0.08)):
        pts = [R(X + 0.05, Z0 - sgn * 0.01, y), R(X - 0.08, Z0 - sgn * 0.01, y), R(X - 0.10, Z0 + sgn * hgt, y),
               R(X - 0.05, Z0 + sgn * hgt, y)]
        loops = [[p_ + V(0, 0.004, 0) for p_ in pts], [p_ + V(0, -0.004, 0) for p_ in pts]]
        slab(det, loops, lambda j: 'Paint_Accent', ('Paint_Accent', 'Paint_Accent'))
    for sy in (1, -1):
        X = 1.85
        y = ye(X) * 0.75
        q, nq = hit([hull], R(X, zup(X, y), sy * y), surf_n(X, y) * V(1, sy, 1))
        det.cyl(q - nq * 0.002, q + nq * 0.0015, 0.007, 'Chrome', n=10)


# =========================================================================================================
# assembly
# =========================================================================================================
def build_sigilo():
    sx_materials()
    hull = build_hull()
    paint_hull(hull)
    canopy = split_canopy(hull)
    frame = build_frame()
    lips = build_nozzle_details()
    intakes = build_intakes()
    det = MB('details')
    mast = build_mast()
    hfair = build_head_fairing(det)
    build_head()
    build_rotor()
    build_prop()
    wbt = build_stubs_booms_tail(det)
    fins = build_fins(det)
    build_rudders()
    nac = build_nacelles()
    build_main_gear()
    build_nose_gear()
    build_main_doors()
    build_nose_doors()
    tunnel = build_nose_tunnel()
    lining = build_lining(hull, canopy)
    seat_f, seat_r, cockpit = build_cockpit(hull)
    build_details(hull, det)
    reg = E.build_registration(wbt, REG, cx=R.x(-1.45), cz=R.z(boom_z(-1.45)), size=0.062, mat='Reg_Grey')

    ctrl = MB('controls_static')
    stick_base = R(1.31, FLOOR_Z + 0.005)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.335, -1.895))
    knob, lever = controls.throttle_lever(ctrl, R(1.08, -2.083, 0.285))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.58, -2.11, 0.115), 'R': R(1.58, -2.11, -0.115)}, knee_out=0.04,
                      elbow_out=0.10, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.24))
    PANEL.build_panel(ctrl, PANEL_P0, PANEL_TILT, [hull, canopy], zone=(0.0, 0.036, 0.38, 0.145), cw=0.054,
                      v_leg=-0.05, v_sb=-0.30, v_b=-0.36, top_arch=(0.34, 0.10, 0.15), max_u=0.32, leg_exp=0.22)
    t = math.radians(PANEL_TILT)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    ctrl.box(PANEL_P0 + upv * 0.165 - nrm * 0.060, (0.13, 0.36, 0.016), 'Carbon', bevel=0.007, segs=2,
             rot=K.rot_y(-6))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.25, -0.13, 0.13), None),
                             'L': ('rest', REAR_HIP + V(0.25, 0.13, 0.13), None)},
                      feet={'L': R(0.71, -2.212, 0.255), 'R': R(0.71, -2.212, -0.255)}, knee_out=0.08, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    eye = eye_point()
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, hull, cockpit, seat_r, canopy, lining,
                                  bpy.data.objects.get('stick'), tunnel], ' (pilot)')
    K.clearance(['pilot_rear'], [hull, cockpit, seat_f, ctrl, canopy, lining, frame], ' (passenger)')
    det = det.finish(sharp_angle=40)
    K.finalize([hull, frame, lips, intakes, mast, hfair, wbt, fins, lining, cockpit, seat_f, seat_r, ctrl, det, nac,
                tunnel] + reg, [canopy])
    restore_rudders()
    attach_wheels()
    req = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP,
        'rudder_L': RUDDERS['rudder_L'][1], 'rudder_R': RUDDERS['rudder_R'][1],
        'stick': stick_base, 'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]),
        'wheel_L': R(AXLE[0], AXLE[1], MAIN_Y), 'wheel_R': R(AXLE[0], AXLE[1], -MAIN_Y), 'pilot_rear': None,
    }
    for name, hinge, _axis, _ang, _late in GEAR:
        req[name] = hinge
    K.required(req)
    gear_check()
    geometry_sheet(eye, stick_base)
    gear_sheet()



# =========================================================================================================
# flight-geometry sheet (MODEL coordinates: x fwd, y up, z right)
# =========================================================================================================
def trap_stats(le_f, te_f, y0, y1):
    c = lambda y: max(le_f(y) - te_f(y), 0.0)  # noqa: E731
    S = 2 * _integrate(c, y0, y1)
    mac = 2 * _integrate(lambda y: c(y) ** 2, y0, y1) / S
    xq = 2 * _integrate(lambda y: c(y) * (le_f(y) - 0.25 * c(y)), y0, y1) / S
    ym = 2 * _integrate(lambda y: c(y) * y, y0, y1) / S
    return S, mac, xq, ym


def geometry_sheet(eye, stick_base):
    gz = GROUND
    print('SX ---- flight geometry (model x fwd, y up, z right) ----')
    print('SX hub %s  head pivot %s  CG %s' % (g(0, 0), g(0, -0.20), g(CG[0], CG[1])))
    print('SX prop (hidden compressor disc) centre %s  R %.3f  blades %d ; slot nozzle at x %.3f, |z| < %.2f, height '
          '%.3f, thrust line y %.3f' % (g(PROP_X, NOZ_Z), PROP_R, PROP_N, R.x(X_AFT), SLOT_HW, SLOT_H, R.z(NOZ_Z)))
    air = bpy.data.objects.get('airframe')
    if air:
        m = []
        for k in range(72):
            a = TAU * k / 72
            h = ray_inner([air], PROP, V(0, math.cos(a), math.sin(a)), 2.0)
            if h:
                m.append((h[0], k * 5))
        dm, am = min(m)
        print('SX prop disc: nearest opaque structure %.3f m from its centre at %d deg from +z_model-left (radius '
              '%.3f, %.3f m to spare)' % (dm, am, PROP_R, dm - PROP_R))
    print('SX nose wheel contact %s  R %.3f' % (g(NOSE[0], gz), R_NOSE))
    print('SX main contacts %s %s  R %.3f  track %.2f  wheelbase %.2f' % (
        g(AXLE[0], gz, MAIN_Y), g(AXLE[0], gz, -MAIN_Y), R_MAIN, 2 * MAIN_Y, NOSE[0] - AXLE[0]))
    print('SX ground y %.3f  axle y %.3f' % (R.z(gz), R.z(AXLE[1])))
    # stub wings (exposed from the pod side |z| 0.42 to the boom centre 0.84; and extended to the centre line)
    Se, mace, xqe, yme = trap_stats(stub_le, stub_te, 0.42, STUB_Y1)
    le_x = lambda y: lerp(STUB_LE[0], STUB_LE[1], (y - STUB_Y0) / (STUB_Y1 - STUB_Y0))  # noqa: E731
    te_x = lambda y: lerp(STUB_TE[0], STUB_TE[1], (y - STUB_Y0) / (STUB_Y1 - STUB_Y0))  # noqa: E731
    Sc, macc, xqc, ymc = trap_stats(le_x, te_x, 0.0, STUB_Y1)
    c0, ct = le_x(0.0) - te_x(0.0), stub_le(STUB_Y1) - stub_te(STUB_Y1)
    print('SX stub wings: span %.3f (boom centres), exposed area %.3f m2 (MAC %.3f, 25%% MAC x %.3f at |z| %.3f); as a '
          'trapezoid to the centre line: area %.3f m2, root chord %.3f, tip %.3f, taper %.3f, MAC %.3f, 25%% MAC %s, '
          'incidence %.1f deg, dihedral %.1f deg' % (2 * STUB_Y1, Se, mace, R.x(xqe), yme, Sc, c0, ct, ct / c0, macc,
                                                   g(xqc, STUB_Z[0]), STUB_INC,
                                                   math.degrees(math.atan2(STUB_Z[1] - STUB_Z[0], STUB_Y1 - STUB_Y0))))
    St, mact, xqt, ymt = trap_stats(tp_le, tp_te, 0.0, TP_Y)
    s_tp = (TP_Z - FIN_Z0) / CC
    print('SX tailplane: span %.3f, area %.3f m2, MAC %.3f, 25%% MAC %s, incidence 0, between the fins at y %.3f; fins '
          'reach %.3f above it and %.3f below it (to the boom top)' % (2 * TP_Y, St, mact, g(xqt, TP_Z), R.z(TP_Z),
                                                                     FIN_TOP - TP_Z, TP_Z - FIN_Z0))
    del s_tp

    def fin_band(x_te_fn, s0, s1, x_le_fn, n=300):
        h = (s1 - s0) / n
        A = Mx = Ms = 0.0
        for k in range(n):
            s = s0 + (k + 0.5) * h
            l, t_ = x_le_fn(s), x_te_fn(s)
            c = max(l - t_, 0.0)
            A += c * h
            Mx += c * 0.5 * (l + t_) * h
            Ms += c * s * h
        return A, Mx / max(A, 1e-9), Ms / max(A, 1e-9)
    hinge = lambda s: FIN_HINGE  # noqa: E731
    Au, xu, su = fin_band(hinge, 0.0, S_TIP, fin_le_up)            # upper fin, boom top .. tip, LE .. hinge
    Al, xl, sl = fin_band(hinge, S_BOT, S_BB, fin_le_lo)           # ventral fin, bottom .. boom bottom
    Ar, xr_, sr_ = fin_band(fin_te, RUD_S0, RUD_S1, hinge)        # rudder, full height
    At = Au + Al + Ar
    xcen, scen = (Au * xu + Al * xl + Ar * xr_) / At, (Au * su + Al * sl + Ar * sr_) / At
    print('SX fins (per side, true areas in the 10-deg canted plane, fixed parts LE..hinge): upper fin %.3f + ventral '
          'fin %.3f + rudder %.3f = %.3f m2; both sides side-projected %.3f m2; centroid L %s / R %s' % (
              Au, Al, Ar, At, 2 * At * CC, g(xcen, FIN_Z0 + scen * CC, FIN_Y0 + scen * SC),
              g(xcen, FIN_Z0 + scen * CC, -(FIN_Y0 + scen * SC))))
    cu0, cut = fin_le_up(0.0) - fin_te(0.0), fin_le_up(S_TIP) - fin_te(S_TIP)
    cl0, clb = fin_le_lo(S_BB) - fin_te(S_BB), fin_le_lo(S_BOT) - fin_te(S_BOT)
    rc = lambda s: FIN_HINGE - fin_te(s)  # noqa: E731
    fu = _integrate(lambda s: rc(s), 0.0, S_TIP) / _integrate(lambda s: fin_le_up(s) - fin_te(s), 0.0, S_TIP)
    fl = _integrate(lambda s: rc(s), S_BOT, S_BB) / _integrate(lambda s: fin_le_lo(s) - fin_te(s), S_BOT, S_BB)
    print('SX fin chords (LE..TE): upper %.3f at the boom top -> %.3f at the tip (height %.3f above the boom top, top y '
          '%.3f), ventral %.3f at the boom bottom -> %.3f at the bottom (depth %.3f, bottom y %.3f); rudder chord %.3f '
          '(bottom) / %.3f (boom) / %.3f (top) = %.0f%% of the upper fin area, %.0f%% of the ventral fin area; TE raked '
          '%.0f deg' % (cu0, cut, FIN_TOP - FIN_Z0, R.z(FIN_TOP), cl0, clb, boom_bot(-2.45) - VF_BOT, R.z(VF_BOT),
                       rc(RUD_S0), rc(0.0), rc(RUD_S1), 100 * fu, 100 * fl, math.degrees(math.atan(TE_SWEEP))))
    for name, (ob, origin, phi, (s0, s1)) in RUDDERS.items():
        sy = 1 if name.endswith('L') else -1
        a = P3(fin_pt(FIN_HINGE, s0, 0.0, sy))
        b_ = P3(fin_pt(FIN_HINGE, s1, 0.0, sy))
        print('SX %s origin %s  rotation about x %.1f deg  hinge %s -> %s  axis %s  chord %.3f  area %.3f' % (
            name, gm(origin), math.degrees(phi), gm(a), gm(b_), gm((b_ - a).normalized()), rc(0.5 * (s0 + s1)), Ar))
    print('SX eye %s  stick base %s' % (gm(eye), gm(stick_base)))
    win = bpy.data.objects.get('windscreen')
    if air and win:
        n_ok = n_all = 0
        bad = []
        for yaw in range(-70, 71, 10):
            for pitch in range(-10, 46, 5):
                d = V(math.cos(math.radians(pitch)) * math.cos(math.radians(yaw)),
                      math.cos(math.radians(pitch)) * math.sin(math.radians(yaw)), math.sin(math.radians(pitch)))
                ha, hw_ = ray_inner([air], eye, d, 3.0), ray_inner([win], eye, d, 3.0)
                n_all += 1
                if hw_ and (ha is None or hw_[0] < ha[0]):
                    n_ok += 1
                else:
                    bad.append((yaw, pitch))
        print('SX eye: %d of %d rays (yaw -70..70, pitch -10..45 deg) leave through the glass first; blocked: %s' % (
            n_ok, n_all, bad[:12]))
    ts = S_TIP
    pts = [('nose tip', PN[0], ze(PN[0], 0), 0), ('keel', 0.80, zlo(0.80, 0.0), 0),
           ('belly antenna', -0.72, zlo(-0.62, 0.0) - 0.06, 0), ('chine L', 0.10, ze(0.10, 0), 0.50),
           ('chine R', 0.10, ze(0.10, 0), -0.50), ('canopy top', 0.25, H_TOP(0.25), 0),
           ('head fairing top', 0.0, -0.09, 0), ('rotor hub cap', 0.0, 0.042, 0),
           ('boom nose L', BOOM_X0, boom_z(BOOM_X0), BOOM_Y), ('boom nose R', BOOM_X0, boom_z(BOOM_X0), -BOOM_Y),
           ('boom end L', BOOM_X1, boom_z(BOOM_X1), BOOM_Y), ('boom end R', BOOM_X1, boom_z(BOOM_X1), -BOOM_Y),
           ('tailplane tip L', tp_te(TP_Y), TP_Z, TP_Y), ('tailplane tip R', tp_te(TP_Y), TP_Z, -TP_Y),
           ('fin strobe L', 0.5 * (fin_le_up(ts) - 0.01 + FIN_HINGE), FIN_Z0 + (ts + 0.037) * CC,
            FIN_Y0 + (ts + 0.037) * SC),
           ('fin strobe R', 0.5 * (fin_le_up(ts) - 0.01 + FIN_HINGE), FIN_Z0 + (ts + 0.037) * CC,
            -(FIN_Y0 + (ts + 0.037) * SC)),
           ('rudder tip TE L', fin_te(RUD_S1), FIN_Z0 + RUD_S1 * CC, FIN_Y0 + RUD_S1 * SC),
           ('rudder tip TE R', fin_te(RUD_S1), FIN_Z0 + RUD_S1 * CC, -(FIN_Y0 + RUD_S1 * SC)),
           ('ventral LE bot L', fin_le_lo(S_BOT), VF_BOT, FIN_Y0 + S_BOT * SC),
           ('ventral LE bot R', fin_le_lo(S_BOT), VF_BOT, -(FIN_Y0 + S_BOT * SC)),
           ('rudder bot TE L', fin_te(RUD_S0), FIN_Z0 + RUD_S0 * CC, FIN_Y0 + RUD_S0 * SC),
           ('rudder bot TE R', fin_te(RUD_S0), FIN_Z0 + RUD_S0 * CC, -(FIN_Y0 + RUD_S0 * SC)),
           ('slot lower lip', X_AFT - 0.05, BOX_LO, 0.0),
           ('nacelle bot fwd L', NAC_F, NAC_BOT, GY), ('nacelle bot fwd R', NAC_F, NAC_BOT, -GY),
           ('nacelle bot aft L', NAC_R, NAC_BOT, GY), ('nacelle bot aft R', NAC_R, NAC_BOT, -GY)]
    for name, X, Z, y in pts:
        print('SX crash %-17s %s' % (name, g(X, Z, y)))
    tt = math.tan(math.radians(TILT_CHECK))
    worst_c, worst_t = None, None
    verts = []
    for name in ('airframe', 'rudder_L', 'rudder_R', 'prop', 'nose_wheel', 'wheel_L', 'wheel_R', 'windscreen',
                 'gear_L', 'gear_R', 'gear_nose') + tuple(g_[0] for g_ in GEAR if g_[0].startswith('door_')):
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        mw = ob.matrix_world
        for v in ob.data.vertices:
            verts.append((name, mw @ v.co))
    for name, p in verts:
        X, Z = p.x - R.dx, p.z - R.dz
        if X < -1.2:
            c = X * tt - Z
            if worst_c is None or c < worst_c[0]:
                worst_c = (c, name, p.copy())
        if X < AXLE[0] - 0.6:
            a = math.degrees(math.atan2(Z - GROUND, AXLE[0] - X))
            if worst_t is None or a < worst_t[0]:
                worst_t = (a, name, p.copy())
    print('SX mesh check: min clearance under the %.0f-deg aft-tilted disc behind x=%.2f: %.3f m (%s at %s)' % (
        TILT_CHECK, R.x(-1.2), worst_c[0], worst_c[1], gm(worst_c[2])))
    print('SX mesh check: first tail contact on tail-down at %.2f deg (%s at %s)' % (
        worst_t[0], worst_t[1], gm(worst_t[2])))
    tl = math.tan(math.radians(TAILDOWN_MIN))
    mm = min(((p.z - R.dz - GROUND) - tl * (AXLE[0] - (p.x - R.dx))) * math.cos(math.radians(TAILDOWN_MIN))
             for _n, p in verts if p.x - R.dx < AXLE[0] - 0.6)
    print('SX mesh check: everything aft stays %.3f m above the %.0f-deg tail-down ground line' % (mm, TAILDOWN_MIN))
    pn = R(NOSE[0], gz)
    for sy in (1, -1):
        pm = R(AXLE[0], gz, sy * MAIN_Y)
        axis = (pm - pn).normalized()
        other = R(AXLE[0], gz, -sy * MAIN_Y)
        best = None
        for sgn in (1, -1):
            nrm = Matrix.Rotation(sgn * math.radians(BANK), 3, axis) @ V(0, 0, 1)
            lift = (other - pn).dot(nrm)          # the far main wheel comes off the ground
            if best is None or lift > best[0]:
                best = (lift, nrm)
        nrm = best[1]
        mh = None
        for name, p in verts:
            if name in ('nose_wheel', 'wheel_L', 'wheel_R'):
                continue
            hh = (p - pn).dot(nrm)
            if mh is None or hh < mh[0]:
                mh = (hh, name, p.copy())
        print('SX %d-deg bank on the %s main wheel + nose wheel: lowest point %.3f m above the ground (%s at %s)' % (
            BANK, 'left' if sy > 0 else 'right', mh[0], mh[1], gm(mh[2])))
    print('SX overall length %.3f (nose %.3f .. %.3f), width %.3f (fin-tip strobes), height %.3f' % (
        PN[0] - fin_te(RUD_S1), R.x(PN[0]), R.x(fin_te(RUD_S1)), 2 * (FIN_Y0 + (S_TIP + 0.037) * SC), 0.042 - GROUND))


B.render_previews = render_previews

_EYE = eye_point()
_EP = (round(_EYE.x, 3), round(_EYE.y, 3), round(_EYE.z, 3))
_RO = P3(fin_pt(FIN_HINGE, 0.5 * (FIN_FLARE + RUD_S1), 0.0, 1))
_ES = V(0, SC, CC)
VIEWS = {
    'side': dict(loc=(-0.35, -18.0, 0.45), target=(-0.35, 0.0, 0.45), ortho=9.6, rotor=0, prop=0),
    'top': dict(loc=(-0.35, 0.0, 30.0), target=(-0.35, 0.0, 0.0), ortho=9.8, rotor=30, prop=0),
    'front_ortho': dict(extra=True, loc=(14.0, 0.0, 0.7), target=(0.0, 0.0, 0.7), ortho=9.8, rotor=90, prop=0),
    'rear_ortho': dict(extra=True, loc=(-14.0, 0.0, 0.25), target=(0.0, 0.0, 0.25), ortho=4.0, rotor=90, prop=0),
    'pilot_eye': dict(extra=True, loc=_EP, target=(_EP[0] + 1.0, _EP[1], _EP[2] - 0.17), lens=16, rotor=75, prop=0,
                      hide=('pilot_front',)),
    'rear_eye': dict(extra=True, loc=tuple(R(0.02, -1.51)), target=tuple(R(1.02, -1.70)), lens=18, rotor=75, prop=0),
    'dusk': dict(extra=True, loc=(6.9, 5.6, 1.35), target=(-0.45, 0.0, 0.1), lens=33, rotor=-58, prop=0, dusk=True),
    'dusk_rear': dict(extra=True, loc=(-6.6, -2.7, 0.85), target=(-1.0, 0.0, 0.15), lens=35, rotor=-40, prop=0,
                      dusk=True),
    'rear_nozzle': dict(extra=True, loc=(-3.6, -0.9, 0.35), target=(-1.65, 0.0, -0.05), lens=55, rotor=75, prop=0),
    'rudder_axis_L0': dict(extra=True, loc=tuple(_RO + _ES * 2.0 + V(0.25, 0.25, 0.0)), target=tuple(_RO), lens=70,
                           rotor=75, prop=0),
    'rudder_axis_L': dict(extra=True, loc=tuple(_RO + _ES * 2.0 + V(0.25, 0.25, 0.0)), target=tuple(_RO), lens=70,
                          rotor=75, prop=0, rudder=20.0),
    'rudders_20': dict(extra=True, loc=(-5.4, 0.6, 1.4), target=(-2.6, 0.0, 0.2), lens=45, rotor=75, prop=0,
                       rudder=20.0),
    'aft_deck': dict(extra=True, loc=(-3.2, 1.6, 1.6), target=(-1.45, 0.0, -0.05), lens=50, rotor=75, prop=0),
    'tail_detail': dict(extra=True, loc=(-1.0, -3.0, 1.0), target=(-2.45, 0.0, 0.25), lens=40, rotor=75, prop=0),
    'nose_detail': dict(extra=True, loc=(3.7, -1.9, 0.15), target=(1.5, 0.0, -0.40), lens=45, rotor=75, prop=0),
    'nose_low': dict(extra=True, loc=(3.4, -1.4, -1.25), target=(1.6, 0.0, -0.55), lens=40, rotor=75, prop=0,
                     hide=('ground',)),
    'intake_detail': dict(extra=True, loc=(0.9, -2.0, 0.65), target=(-0.55, -0.35, -0.05), lens=45, rotor=75, prop=0),
    'head_detail': dict(extra=True, loc=(1.3, -1.45, 2.05), target=(-0.25, 0.0, 1.50), lens=45, rotor=17, prop=0),
    'cockpit': dict(extra=True, loc=(1.9, 1.55, 1.25), target=(0.55, 0.0, -0.2), lens=30, rotor=75, prop=0),
    'gear_q_down': dict(extra=True, loc=(7.6, 6.3, 2.5), target=(-0.40, 0.0, 0.42), lens=33, rotor=-58, prop=0,
                        gear=0.0),
    'gear_q_half': dict(extra=True, loc=(7.6, 6.3, 2.5), target=(-0.40, 0.0, 0.42), lens=33, rotor=-58, prop=0,
                        gear=0.35),
    'gear_q_up': dict(extra=True, loc=(7.6, 6.3, 2.5), target=(-0.40, 0.0, 0.42), lens=33, rotor=-58, prop=0, gear=1.0),
    'gear_side_down': dict(extra=True, loc=(-0.1, 7.2, -0.80), target=(-0.1, 0.0, -0.58), lens=32, rotor=0, prop=0,
                           gear=0.0),
    'gear_side_half': dict(extra=True, loc=(-0.1, 7.2, -0.80), target=(-0.1, 0.0, -0.58), lens=32, rotor=0, prop=0,
                           gear=0.35),
    'gear_side_up': dict(extra=True, loc=(-0.1, 7.2, -0.80), target=(-0.1, 0.0, -0.58), lens=32, rotor=0, prop=0,
                         gear=1.0),
    'gear_below_down': dict(extra=True, loc=(-0.10, 0.0, -20.0), target=(-0.10, 0.0, 0.0), ortho=5.4, rotor=60,
                            prop=0, hide=('ground', 'rotor'), gear=0.0),
    'gear_below_half': dict(extra=True, loc=(-0.10, 0.0, -20.0), target=(-0.10, 0.0, 0.0), ortho=5.4, rotor=60,
                            prop=0, hide=('ground', 'rotor'), gear=0.35),
    'gear_below_up': dict(extra=True, loc=(-0.10, 0.0, -20.0), target=(-0.10, 0.0, 0.0), ortho=5.4, rotor=60,
                          prop=0, hide=('ground', 'rotor'), gear=1.0),
    'gear_xray_up': dict(extra=True, loc=(2.6, 3.6, -2.2), target=(0.1, 0.0, -0.55), lens=30, rotor=60, prop=0,
                         hide=('ground', 'rotor', 'pilot_front'), gear=1.0, xray=True),
    'gear_xray_side': dict(extra=True, loc=(-0.1, 9.0, -0.5), target=(-0.1, 0.0, -0.5), ortho=4.6, rotor=0, prop=0,
                           hide=('ground', 'rotor', 'pilot_front'), gear=1.0, xray=True),
    'gear_detail': dict(extra=True, loc=(1.2, -3.2, -0.45), target=(-0.5, -0.5, -0.65), lens=40, rotor=75, prop=0),
    'cabin_side': dict(extra=True, loc=(0.45, 2.9, 0.65), target=(0.35, 0.0, -0.2), lens=30, rotor=75, prop=0),
    'bottom_ortho': dict(extra=True, loc=(-0.31, 0.0, -20.0), target=(-0.30, 0.0, 0.0), ortho=6.4, rotor=75, prop=0,
                         hide=('ground',)),
}

if __name__ == '__main__':
    K.run('sigilo', build_sigilo, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
