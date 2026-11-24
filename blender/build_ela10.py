"""
ELA 10 Eclipse (ELA Aviación, Córdoba) for the Autogiro web sim: enclosed tandem gyroplane, Rotax 914
pusher. Long low pod with a pointed bullet nose; ONE big bubble canopy (thin dark rim, a painted roof
band at the rear top ending in a round tip over the front seat back, a frame band below the glass whose
seam climbs towards the rear) from the nose hatch to behind the rear seat; side sponsons from the nose
(teardrop LED landing/side lights in their front ends, storage hatch) back to the main legs; shark-fin
pylon growing out of the engine cowl with a long concave trailing edge, strobe on its top, ram-air
intake at its foot and the two control push rods outside it; rounded cowl with three triangular mesh
gills each side and the exhaust stub on the right; Helix three-blader with a black spinner; tail boom
(bare tube) leaving the belly behind the main gear, dipping under the prop and rising in a swan neck
into a box fin with a big rudder, swept tapered stabiliser with anhedral on top, chevron end plates
(winglets) carrying the PowerBurst nav/strobe lights and the registration; short faired main legs with
half spats, small nose wheel on a single curved leg, tow hook under the nose, tail wheel under the fin.

Traced in the HUB FRAME (gyrokit.py) on Commons "ELA 10 Eclipse (N561HL, cn 06164881014)
(4-11-2024).jpg" (3840 px copy, right side, refs/ela10/full/n02.jpg). That photo was taken from ~8 m
with a wide lens, so its pixels are turned into hub coordinates with a PINHOLE camera (`ph()`, camera
8.0 m from the centre plane, 1.6 m above the ground, yaw +3 deg (ahead), pitched 1.1 deg down, horizon
at y 1215) instead of a single px/m: centre-plane points use the plane y = 0, the near winglet / spat /
wheel their own plane. Scale 440 px/m on the centre plane from the 1.73 m Helix H50F (DULV data sheet;
blade tips solved for the three-blader, R 383 px), checked against the tyres (main 15x6.00-6 = 0.35 m,
nose 4.00-4 = 0.31 m) -> length 4.99 m, hub 2.76 m above the ground. Widths from the front photos
(track 1.60 m, pod 0.84 m, winglets 1.60 m apart). CG: sim convention 0.33 m ahead of the hub,
0.85 m above the main axle.

  blender -b -P blender/build_ela10.py -- [--previews] [--only VIEW,...] [--show-rear] [--samples N]
                                           [--povl out.png[,scale]]   (perspective overlay of photo n02)
Outputs: public/models/ela10.glb, blender/ela10.blend, blender/previews/ela10/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- photo n02 (3840 x 2560, right side, nose to the right): pinhole camera -> hub frame -----------
PH_W, PH_H, PH_CX, PH_CY = 3840, 2560, 1920.0, 1280.0
PH_HUB = (2127.0, 717.0)        # teeter bolt
PH_DIST = 8.0                   # camera -> centre plane (m)
PH_YAW = 3.0                    # deg, camera ahead of the pure side view
PH_PPM = 440.0                  # px per metre on the centre plane at the hub (1.73 m prop = 766 px)
PH_F = PH_PPM * PH_DIST
PH_PITCH = math.degrees(math.atan((PH_CY - 1215.0) / PH_F))     # horizon at y 1215 -> pitched down


def _cam():
    ps, th = math.radians(PH_YAW), math.radians(PH_PITCH)
    d = Vector((-math.sin(ps) * math.cos(th), math.cos(ps) * math.cos(th), -math.sin(th))).normalized()
    u = d.cross(Vector((0, 0, 1))).normalized()
    vd = d.cross(u)
    r = (d * PH_F + u * (PH_HUB[0] - PH_CX) + vd * (PH_HUB[1] - PH_CY)).normalized()
    t = PH_DIST / r.y
    return d, u, vd, Vector((-r.x * t, -PH_DIST, -r.z * t))


PH_D, PH_U, PH_V, PH_C = _cam()


def ph(x, y, y0=0.0):
    """Photo pixel -> hub frame (X, Z) on the plane Y = y0."""
    r = (PH_D * PH_F + PH_U * (x - PH_CX) + PH_V * (y - PH_CY)).normalized()
    t = (y0 - PH_C.y) / r.y
    p = PH_C + r * t
    return (p.x, p.z)


def phs(pts, y0=0.0):
    return [ph(x, y, y0) for x, y in pts]


# ---- hub frame -----------------------------------------------------------------------------------
GROUND = -2.76                  # mean of main and nose tyres (both sit a few cm in the grass in n02)
WR = 0.175                      # main tyres 15x6.00-6
NWR = 0.155                     # nose tyre 4.00-4
AXLE = (-0.217, GROUND + WR)    # near main axle, plane y = -0.80
CG = (0.33, AXLE[1] + 0.85)     # sim convention in x; 0.85 m above the main axle
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(-0.016, -0.19)
PROP_X, PROP_Z = ph(1675, 1431)
PROP = R(PROP_X, PROP_Z)
PROP_R = 0.865
MAIN_Y = 0.80                   # track 1.60 m (front photos)
NOSE = (ph(3000, 1858)[0], GROUND + NWR)
X_END = ph(1715, 1440)[0]       # cowl rear face (prop flange)

LIVERY = dict(body=('#1B6FC0', 0.55, 0.22), accent=('#C9CCD0', 1.0, 0.18), dark=('#0F1012', 0.3, 0.30))
REG = 'EC-ECL'

# ---- hull: side outline (photo px), plan half-width and belt (max width) height -------------------
XTIP, ZTIP = ph(3134, 1755)
# Top line read off 6-7x grids of n02 every 10-20 px: from the canopy roof to the tip it only gets
# steeper (30 deg over the windscreen, 40 deg on the nose, 46 deg at the tip). The first trace ran up to
# 25 px (5 cm) above this with an S-bend ahead of the canopy: a hump on the nose that the aircraft does
# not have (the owner spotted it at once). Check any change with a 4x edge overlay, not the whole photo.
TOP_PX = [(3134, 1755), (3120, 1740), (3101, 1720), (3082, 1700), (3062, 1680), (3043, 1660), (3023, 1640),
          (3003, 1620), (2980, 1600), (2957, 1580), (2933, 1560), (2908, 1540), (2881, 1520), (2848, 1500),
          (2812, 1480), (2776, 1460), (2740, 1440), (2702, 1420), (2660, 1400), (2607, 1380), (2546, 1360),
          (2470, 1340), (2400, 1325), (2330, 1315), (2280, 1311), (2240, 1309), (2200, 1309), (2160, 1311),
          (2140, 1314), (2110, 1319)]
TOP_REAR = [(-0.30, -1.362), (-0.60, -1.362), (X_END, -1.362)]
BOT_PX = [(3134, 1755), (3122, 1762), (3110, 1768), (3087, 1777), (3025, 1796), (2962, 1805), (2900, 1810),
          (2800, 1810), (2700, 1810), (2500, 1808), (2300, 1800), (2200, 1792), (2100, 1776), (2000, 1758),
          (1960, 1745), (1930, 1722), (1910, 1702), (1890, 1682), (1860, 1650), (1840, 1617), (1800, 1596),
          (1760, 1578), (1720, 1560)]
W_TAB = [(XTIP, 0.0), (2.20, 0.058), (2.10, 0.112), (1.95, 0.182), (1.80, 0.245), (1.60, 0.305), (1.30, 0.365),
         (1.00, 0.400), (0.60, 0.420), (0.20, 0.420), (-0.10, 0.400), (-0.40, 0.362), (-0.65, 0.322),
         (-0.85, 0.288), (X_END, 0.272)]
BELT_TAB = [(XTIP, ZTIP), (2.10, -2.275), (1.80, -2.205), (1.40, -2.155), (0.80, -2.125), (0.20, -2.10),
            (-0.30, -1.98), (-0.60, -1.80), (X_END, -1.64)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    pairs = sorted(pairs, key=lambda p: -p[0])
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T = _prof(phs(TOP_PX) + TOP_REAR)
F_B = _prof(phs(BOT_PX))
F_W, F_M = _prof(W_TAB), _prof(BELT_TAB)
F_NT = B.hermite([X_END, -0.5, 0.0, 0.8, 1.6, 2.0, XTIP], [2.3, 2.3, 2.1, 2.05, 2.05, 2.0, 2.0])
F_NB = B.hermite([X_END, -0.5, 0.0, 0.8, 1.6, 2.0, XTIP], [2.2, 2.4, 2.6, 2.6, 2.4, 2.1, 2.0])


def hull(X):
    u = _u(X)
    zt, zb, w = F_T(u), F_B(u), max(F_W(u), 1e-4)
    h = zt - zb
    zm = min(max(F_M(u), zb + 0.2 * h), zt - 0.2 * h)
    return zt, zb, w, zm, F_NT(X), F_NB(X)


def hull_half(X, m=40):
    zt, zb, w, zm, nt, nb = hull(X)
    half = []
    for i in range(m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.sin(a) ** (2 / nt), zm + (zt - zm) * math.cos(a) ** (2 / nt)))
    for i in range(1, m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.cos(a) ** (2 / nb), zm - (zm - zb) * math.sin(a) ** (2 / nb)))
    return half


def hull_ring(X, n_half=32, scale=1.0):
    h = E.resample2d(hull_half(X), n_half)
    zt, zb = h[0][1], h[-1][1]
    zc = 0.5 * (zt + zb)
    h = [(y * scale, zc + (z - zc) * scale) for y, z in h]
    return [R(X, z, y) for y, z in h] + [R(X, z, -y) for y, z in reversed(h[1:-1])]


def hull_y(X, Z):
    zt, zb, w, zm, nt, nb = hull(X)
    if Z >= zm:
        f = min(1.0, (Z - zm) / (zt - zm))
        return w * max(0.0, 1 - f ** nt) ** (1 / nt)
    f = min(1.0, (zm - Z) / (zm - zb))
    return w * max(0.0, 1 - f ** nb) ** (1 / nb)


def top_z(X):
    return F_T(_u(X))


def ph_surf(x, y, out=0.0, side=-1):
    """Photo pixel -> hub (X, Z) of a point lying on the near (right) hull side, `out` m outside it:
    the pinhole ray is intersected with the plane y = -(hull_y + out), iterated."""
    y0 = 0.0
    for _ in range(4):
        X, Z = ph(x, y, y0)
        y0 = side * (hull_y(X, Z) + out)
    return ph(x, y, y0)


def phsurf(pts, out=0.0):
    return [ph_surf(x, y, out) for x, y in pts]


# ---- canopy (photo px): glass outline, canopy-frame cut line (the clamshell seam), painted roof band --
GLASS_PX = [(2150, 1358), (2154, 1388), (2185, 1450), (2223, 1512), (2265, 1565), (2300, 1588), (2485, 1600),
            (2638, 1608), (2777, 1612), (2815, 1604), (2854, 1558), (2885, 1535)]
JOINT_PX = [(2088, 1318), (2100, 1380), (2118, 1430), (2150, 1500), (2185, 1580), (2215, 1630), (2260, 1652),
            (2331, 1661), (2500, 1668), (2700, 1674), (2800, 1676), (2845, 1670), (2870, 1648), (2888, 1605),
            (2905, 1565), (2922, 1545)]
# roof band: depth below the top in side view (n02: 0.10 m over the rear seat, round front end over the
# front seat back, as in the factory close-up of the grey Eclipse)
ROOF_D = [(0.054, 0.096), (0.18, 0.106), (0.30, 0.108), (0.50, 0.090), (0.65, 0.074), (0.78, 0.056), (0.88, 0.036),
          (0.94, 0.022), (0.975, 0.010), (0.99, 0.002)]


def glass_poly():
    pts = phsurf(GLASS_PX)
    pts += [(pts[-1][0] + 0.02, -1.0), (1.00, -1.0)]
    pts += [(X, top_z(X) - d) for X, d in reversed(ROOF_D)]
    return pts


FLOOR_Z = -2.41
FRONT_HIP = R(0.98, -2.25)
REAR_HIP = R(0.28, -2.23)
FRONT_BACK, REAR_BACK = 30.0, 22.0


# ---- small surface helpers -------------------------------------------------------------------------
def cast_side(target, x, z, sy, y0=1.5):
    inv = target.matrix_world.inverted()
    ok, loc, nrm, _ = target.ray_cast(inv @ V(x, sy * y0, z), inv.to_3x3() @ V(0, -sy, 0))
    if not ok:
        return None, None
    return target.matrix_world @ loc, (target.matrix_world.to_3x3() @ nrm).normalized()


def cast_down(target, x, y, z0=1.0):
    ok, loc, nrm, _ = target.ray_cast(V(x, y, z0), V(0, 0, -1))
    return (loc, nrm) if ok else (None, None)


def ray_on(target, q, n, h=0.0):
    """Point of target hit by a ray from outside along -n (q + 0.4 n -> q), lifted h along the normal."""
    n = Vector(n).normalized()
    inv = target.matrix_world.inverted()
    ok, loc, nn, _i = target.ray_cast(inv @ (Vector(q) + n * 0.4), (inv.to_3x3() @ (-n)).normalized(), distance=1.2)
    if not ok:
        return None, None
    nw = (target.matrix_world.to_3x3() @ nn).normalized()
    if nw.dot(n) < 0:
        nw = -nw
    return target.matrix_world @ loc + nw * h, nw


def side_line(mb, target, pts_hub, sy, r=0.0032, mat='Decal_Black', lift=0.001, step=0.012):
    pts = B.resample_loop([R(X, Z) for X, Z in pts_hub], step)[:-1]
    out = []
    for p in pts:
        loc, nrm = cast_side(target, p.x, p.z, sy)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 2:
        mb.tube(out, r, mat, n=6, cap=True)
    return out


def cross_line(mb, target, X, y0, r=0.0032, mat='Decal_Black', lift=0.001):
    out = []
    for k in range(25):
        loc, nrm = cast_down(target, R.x(X), lerp(y0, -y0, k / 24))
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 2:
        mb.tube(out, r, mat, n=6, cap=True)


def oval_patch(mb, target, p, n, fwd, a, b, mat, h0=0.002, h1=0.006, taper=0.55, k=24):
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    fwd = (fwd - n * fwd.dot(n)).normalized()
    up = n.cross(fwd).normalized()
    ring, ring2 = [], []
    for i in range(k):
        t = TAU * i / k
        for rr, out, hh in ((1.0, ring, h0), (taper, ring2, h1)):
            q = Vector(p) + fwd * (math.cos(t) * a * rr) + up * (math.sin(t) * b * rr)
            loc, nw = ray_on(target, q, n, hh)
            out.append(loc if loc is not None else Vector(p) + n * hh)
    ctr = sum(ring2, Vector()) / len(ring2)
    mb.loft([ring, ring2, [ctr]], mat, closed=True)


def shield_patch(mb, target, p, n, a, b, mat, h):
    """ELA badge: heraldic shield (flat top, pointed tip towards the canopy) shrink-wrapped on target;
    a = length along x, b = half width."""
    n = Vector(n).normalized()
    fwd = (V(1, 0, 0) - n * n.x).normalized()
    side = n.cross(fwd).normalized()
    pts2 = []
    for k in range(9):          # flat (slightly arched) top edge at the front
        t = k / 8
        pts2.append((0.5 * a + 0.004 * math.sin(math.pi * t), lerp(b, -b, t)))
    for k in range(1, 12):      # curved sides to the tip aft
        t = k / 12
        pts2.append((lerp(0.5 * a, -0.5 * a, t), -b * math.cos(0.5 * math.pi * t ** 1.6)))
    pts2.append((-0.5 * a, 0.0))
    pts2 += [(x, -y) for x, y in reversed(pts2[9:-1])]
    ring = []
    for x, y in pts2:
        q, _nw = ray_on(target, Vector(p) + fwd * x + side * y, n, h)
        ring.append(q if q is not None else Vector(p) + n * h)
    ctr = sum(ring, Vector()) / len(ring)
    mb.loft([ring, [ctr]], mat, closed=True)


def rounded_rect(cx, cz, w, h, rad, k=5):
    pts = []
    for (ox, oz, a0) in ((w / 2 - rad, h / 2 - rad, 0), (-w / 2 + rad, h / 2 - rad, 90), (-w / 2 + rad, -h / 2 + rad, 180),
                         (w / 2 - rad, -h / 2 + rad, 270)):
        for j in range(k + 1):
            a = math.radians(a0 + 90 * j / k)
            pts.append((cx + ox + rad * math.cos(a), cz + oz + rad * math.sin(a)))
    return pts


def surface_loop(mb, target, pts_model, n, r=0.0024, mat='Decal_Black', lift=0.0012):
    out = []
    for p in pts_model:
        q, _nw = ray_on(target, p, n, lift)
        if q is not None:
            out.append(q)
    if len(out) > 2:
        out.append(out[0])
        mb.tube(out, r, mat, n=6, cap=False)


def ensure_mats():
    K.ensure_materials()
    if 'Lens_Teal' not in MATS:
        B.make_mat('Lens_Teal', B.srgb('#1F6E6A'), rough=0.08, emit=B.srgb('#3FA89C'), emit_strength=0.15)
    if 'Glass_Teal' not in MATS:     # tinted clear cover of the nose landing lights (sim: any '*glass*' = clear)
        B.make_mat('Glass_Teal', B.srgb('#2C7774'), rough=0.04, alpha=0.35)
    if 'Lamp_Housing' not in MATS:
        B.make_mat('Lamp_Housing', B.srgb('#1A1E21'), metal=0.0, rough=0.55)
    if 'Decal_Red' not in MATS:
        B.make_mat('Decal_Red', B.srgb('#B3141B'), rough=0.4)
    if 'Mesh_Grille' not in MATS:
        B.make_mat('Mesh_Grille', B.srgb('#5A5D62'), metal=0.9, rough=0.35)


def where(a_names, b_objs, label=''):
    """Like K.clearance, but prints where (hub frame) the crew crosses each object."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()

    def tree(o):
        bm = bmesh.new()
        bm.from_object(o, dg)
        bm.transform(o.matrix_world)
        bm.faces.ensure_lookup_table()
        cs = [f.calc_center_median() for f in bm.faces]
        t = BVHTree.FromBMesh(bm)
        bm.free()
        return t, cs
    bt = [(o.name, tree(o)) for o in b_objs if o is not None]
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not any(o.name.startswith(n) for n in a_names):
            continue
        ta, ca = tree(o)
        for bn, (tb, cb) in bt:
            hits = ta.overlap(tb)
            if hits:
                ps = [ca[i] for i, _ in hits]
                lo = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
                hi = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
                print('  ?? %s%s x %s: %d  X %.2f..%.2f  y %.2f..%.2f  Z %.2f..%.2f' % (
                    o.name, label, bn, len(hits), lo.x - R.dx, hi.x - R.dx, lo.y, hi.y, lo.z - R.dz, hi.z - R.dz))


# ---- hull ------------------------------------------------------------------------------------------
def build_hull():
    us = [0.02 * k for k in range(1, 40)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.04:
        x -= 0.03
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    # rear face: a short rounded lip and the recessed flange ring the spinner sits in
    rings.append(hull_ring(X_END - 0.006, scale=0.97))
    rings.append(hull_ring(X_END - 0.010, scale=0.90))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    return mb.finish(sharp_angle=60)


def build_hull_lines(pod):
    """Drawn on the closed hull before the glazing is cut: clamshell seam round the canopy frame (it
    crosses the nose hatch at the front), cowl panel seams, fuel/oil caps."""
    mb = MB('hull_lines')
    joint = phsurf(JOINT_PX)
    for sy in (1, -1):
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: clamshell seam and cowl panel line removed)
        # caps behind the canopy (fuel left, oil right): white disc with a flush cover
        X, Z = ph_surf(2120, 1488)
        loc, nrm = cast_side(pod, R.x(X), R.z(Z), sy)
        if loc is not None:
            mb.lathe([(0.0, 0.004), (0.036, 0.004), (0.044, 0.002), (0.046, -0.004)], loc, nrm, 'Chrome', n=24)
            mb.lathe([(0.0, 0.0055), (0.030, 0.0055), (0.032, 0.004)], loc, nrm, 'Metal_Frame', n=24)
            mb.box(loc + nrm * 0.007, (0.010, 0.040, 0.006), 'Alu_Black', bevel=0.002, segs=1,
                   rot=Euler((math.radians(90 if sy > 0 else -90), 0, 0)))
    return mb.finish(sharp_angle=50)


def split_canopy(pod):
    glass = R.pts(glass_poly())
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    K.bisect_poly(bm, glass)
    bm.to_mesh(pod.data)
    bm.free()
    return K.split_glass(pod, lambda c: PANEL.inside(glass, c.x, c.z),
                         frame_r=0.0065, frame_mat='Decal_Black', seal=True, thickness=0.012, name='canopy')


# ---- sponsons with the nose lights ----------------------------------------------------------------
SPON_TOP = phsurf([(2175, 1672), (2210, 1662), (2300, 1664), (2400, 1670), (2500, 1676), (2600, 1683),
                   (2700, 1690), (2800, 1700), (2850, 1708)], 0.06)
SPON_BOT = phsurf([(2175, 1690), (2210, 1712), (2280, 1735), (2400, 1745), (2600, 1748), (2800, 1748),
                   (2850, 1748)], 0.06)
LENS_TIP = ph_surf(2950, 1722, 0.01)
SPON_X = [SPON_TOP[0][0] + d for d in (0.004, 0.03, 0.08, 0.16)] + [0.45, 0.65, 0.85, 1.10, 1.35, SPON_TOP[-1][0]]
LENS_INFO = []


def _interp(pts, X):
    pts = sorted(pts)
    if X <= pts[0][0]:
        return pts[0][1]
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if x0 <= X <= x1:
            return lerp(z0, z1, (X - x0) / max(x1 - x0, 1e-6))
    return pts[-1][1]


def build_sponsons():
    """Rounded ridge along the lower pod side (n02 band 1695-1755 px), ending forward in the teardrop
    lens of the LED landing / side light (close-ups: teal lens, white LED strip at its root)."""
    mb = MB('sponsons')
    LENS_INFO.clear()
    for sy in (1, -1):
        rings = []
        for X in SPON_X:
            zt, zb = _interp(SPON_TOP, X), _interp(SPON_BOT, X)
            zc, hz = 0.5 * (zt + zb), max(0.5 * (zt - zb), 0.004)
            yb = hull_y(X, zc)
            hy = min(0.085, hz * 1.3) * min(1.0, max(0.05, (X - SPON_X[0]) / 0.22)) ** 0.6
            ring = []
            for k in range(20):
                a = TAU * k / 20
                ca, sa = math.cos(a), math.sin(a)
                y = yb - 0.035 + (ca * hy + 0.035 if ca > 0 else ca * 0.035 + 0.035)
                ring.append(R(X, zc + B.sgnpow(sa, 0.8) * hz, sy * y))
            rings.append(ring)
        mb.loft(rings, 'Paint_White', closed=True, cap0=True)
        # lens: pointed teardrop continuing the ridge towards the nose
        X0 = SPON_X[-1]
        zt, zb = _interp(SPON_TOP, X0), _interp(SPON_BOT, X0)
        zc = 0.5 * (zt + zb)
        base = R(X0 - 0.004, zc, sy * (hull_y(X0, zc) + 0.018))
        tip = R(LENS_TIP[0], LENS_TIP[1], sy * (hull_y(LENS_TIP[0], LENS_TIP[1]) + 0.002))
        LENS_INFO.append((sy, base, tip, 0.5 * (zt - zb)))
    return mb.finish(sharp_angle=60)


def lens_profile(hz, L):
    """(radius, axial) of the teardrop cover over the landing lamp, blunt end aft at the sponson."""
    return [(0.0, -0.004), (hz * 0.95, -0.004), (hz * 0.95, 0.004), (hz * 0.9, L * 0.16), (hz * 0.72, L * 0.40),
            (hz * 0.45, L * 0.66), (hz * 0.18, L * 0.88), (0.0, L)]


def build_nose_lamps(pod):
    """LED landing lights in the front ends of the sponsons (close-ups Summer-Windscreen, EVO sheet): a clear,
    slightly teal-tinted teardrop cover (Glass) over a dark housing, with a cylindrical 'corn' LED bulb on
    the blunt rear bulkhead, a third of the way down from the top, pointing forward along the teardrop."""
    mb = MB('nose_lamps')
    gl = MB('nose_lamp_glass')
    for sy, base, tip, hz in LENS_INFO:
        d = tip - base
        L = d.length
        dn = d.normalized()
        prof = lens_profile(hz, L)
        gl.lathe(prof, base, d, 'Glass_Teal', n=24)
        up = (V(0, 0, 1) - dn * dn.z).normalized()

        def rad(a):
            for (r0, a0), (r1, a1) in zip(prof[2:], prof[3:]):
                if a0 <= a <= a1:
                    return lerp(r0, r1, (a - a0) / max(a1 - a0, 1e-6))
            return 0.0
        # rear bulkhead (closes the sponson front end) and the dark floor lining the hull inside the cover
        mb.lathe([(0.0, 0.0015), (hz * 0.93, 0.0015), (hz * 0.93, 0.0045), (0.0, 0.0045)], base, d,
                 'Lamp_Housing', n=24)
        rows, shell = [], []
        for t in [0.01 + 0.98 * k / 14 for k in range(15)]:
            c = base + d * t
            q0, _n0 = ray_on(pod, c, V(0, sy, 0))
            if q0 is None:
                continue
            r = rad(L * t) * 0.97
            e = (c - q0).length
            hc = math.sqrt(max(r * r - e * e, 0.0)) * 1.04    # hull chord inside the cover
            # inner half of the cover lined dark (the part not sunk in the hull)
            side = V(0, sy, 0) - dn * (dn.y * sy)
            side.normalize()
            shell.append([c + (up * math.cos(a) - side * math.sin(a)) * r
                          for a in [math.pi * k / 12 for k in range(13)]])
            row = []
            for j in range(-4, 5):
                q, _nw = ray_on(pod, c + up * (hc * j / 4), V(0, sy, 0), 0.0025)
                row.append(q if q is not None else c)
            rows.append(row)
        if len(rows) > 1:
            for fl in (False, True):        # both faces: the sim may cull back faces
                mb.loft(rows, 'Lamp_Housing', closed=False, flip=fl)
                mb.loft(shell, 'Lamp_Housing', closed=False, flip=fl)
        # corn LED bulb: chrome socket on the bulkhead, white LED cylinder, flat end cap
        bp = base + up * (hz * 0.33) + dn * 0.0045
        blen, br = 0.19 * L, 0.035 * L
        mb.lathe([(0.0, 0.0), (br * 1.5, 0.0), (br * 1.5, 0.010), (br * 1.05, 0.012)], bp, d, 'Chrome', n=16)
        mb.lathe([(br, 0.012), (br, blen), (br * 0.8, blen + 0.002), (0.0, blen + 0.002)], bp, d, 'Lens_White', n=16)
        LAMP_UNITS.append((sy, bp, dn, blen))
        K.lamp_node('landing', bp + dn * (blen + 0.025), 'L' if sy > 0 else 'R')
    return mb.finish(sharp_angle=60), gl.finish(sharp_angle=60)


LAMP_UNITS = []


# ---- pylon (shark fin) ------------------------------------------------------------------------------
PYL_LE = phs([(2178, 838), (2175, 911), (2164, 1002), (2145, 1093), (2123, 1165), (2098, 1220), (2082, 1256),
              (2075, 1302), (2080, 1320)])
PYL_TE = phs([(2000, 845), (2005, 911), (2005, 1002), (2000, 1093), (1986, 1147), (1964, 1193), (1936, 1229),
              (1891, 1265), (1836, 1288), (1782, 1302), (1736, 1311), (1715, 1318)])
PYL_TOP = PYL_LE[0][1]
F_PLE = B.hermite([z for _, z in reversed(PYL_LE)], [x for x, _ in reversed(PYL_LE)])
F_PTE = B.hermite([z for _, z in reversed(PYL_TE)], [x for x, _ in reversed(PYL_TE)])


def pyl_th(Z):
    """Half thickness of the pylon (front photos: ~0.11 m wide up the mast, flaring into the cowl)."""
    return 0.052 + 0.006 * max(0.0, min(1.0, (-0.30 - Z) / 0.6)) + 0.20 * max(0.0, (-1.02 - Z) / 0.40) ** 1.8


def build_pylon():
    mb = MB('pylon')
    zs = [PYL_TOP, -0.30, -0.40, -0.55, -0.70, -0.85, -0.95, -1.03, -1.10, -1.16, -1.21, -1.26, -1.30, -1.34,
          -1.38, -1.43]
    rings = []
    for Z in zs:
        xl = F_PLE(max(Z, PYL_LE[-1][1]))
        xt = max(F_PTE(max(Z, PYL_TE[-1][1])), X_END + 0.012)
        c = xl - xt
        th = pyl_th(Z)
        ring = []
        for s, tz in airfoil_ring(22, min(2 * th / c, 0.9), te_min=0.006):
            ring.append(R(xl - s * c, Z, tz * c))
        rings.append(ring)
    # rounded top: two shrinking rings above the top section
    top = rings[0]
    zc = R.z(PYL_TOP)
    ctr = sum(top, Vector()) / len(top)
    r1 = [ctr + (p - ctr) * 0.9 + V(0, 0, 0.012) for p in top]
    r1 = [V(p.x, p.y * 0.55, p.z) for p in r1]
    mb.loft([r1] + rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    pylon = mb.finish(sharp_angle=50)
    del zc
    return pylon


def build_pylon_details(pylon, pod):
    mb = MB('pylon_details')
    # strobe on the trailing edge near the top (n02 1995/895: white bullet pointing aft)
    sx, sz = ph(1995, 895)
    p = R(F_PTE(sz) + 0.004, sz)
    K.lamp(mb, p, V(-1, 0, 0), kind='white', r=0.016, length=0.05)
    K.lamp_node('beacon', p + V(-0.05, 0, 0))
    # mast stub above the fairing and the cheek plates of the pitch pivot
    mb.tube([R(-0.03, PYL_TOP - 0.05), PIVOT + V(-0.012, 0, -0.03)], 0.04, 'Metal_Frame', n=20, square=(0.065, 0.10, 8))
    for sy in (1, -1):
        mb.box(PIVOT + V(-0.015, sy * 0.045, -0.03), (0.14, 0.010, 0.12), 'Metal_Frame', bevel=0.012, segs=2)
        mb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.062, 0), 0.016, 'Engine', n=12)
    # the two control push rods outside the fairing, from the head's cross bar down into the fillet
    for sy in (1, -1):
        hi = PIVOT + V(-0.20, sy * 0.12, 0.022)
        lo = R(-0.20, -1.28, sy * 0.115)
        mb.cyl(lo, hi, 0.0075, 'Metal_Frame', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.03), 0.011, 'Alu_Black', n=8)
        # rubber boot where the rod enters the fillet
        mb.cyl(lo, lo + (hi - lo).normalized() * 0.07, 0.016, 'Rubber', n=12)
    # pre-rotator shaft (thin, behind the mast top) and the trim cylinder
    mb.cyl(R(-0.13, PYL_TOP - 0.02), PIVOT + V(-0.137, 0, -0.07), 0.010, 'Metal_Frame', n=10)
    # oval ram-air scoop on the leading edge just above the canopy (N1231S, D-MEVD, grey EVO photos)
    zi, ay, az = -1.10, 0.040, 0.075
    xl = F_PLE(zi) - 0.012

    def oval(x, sy_, sz_, dz=0.0):
        return [R(x, zi + dz + sz_ * math.sin(TAU * k / 28), sy_ * math.cos(TAU * k / 28)) for k in range(28)]
    mb.loft([oval(xl - 0.05, ay + 0.010, az + 0.012), oval(xl + 0.010, ay + 0.010, az + 0.012),
             oval(xl + 0.014, ay + 0.004, az + 0.006), oval(xl + 0.008, ay, az)], 'Paint_White', closed=True)
    mb.loft([oval(xl + 0.008, ay, az), oval(xl - 0.08, ay * 0.85, az * 0.85), [R(xl - 0.09, zi)]], 'Engine_Dark',
            closed=True)
    # ram-air intake at the foot of the pylon, each side (n02 2005-2045 / 1318-1340)
    (x0, z0), (x1, z1) = ph(2005, 1318, -0.14), ph(2045, 1340, -0.14)
    for sy in (1, -1):
        c = R(0.5 * (x0 + x1), 0.5 * (z0 + z1))
        loc, nrm = cast_side(pylon, c.x, c.z, sy)
        if loc is None:
            continue
        w, h = abs(x1 - x0) + 0.02, abs(z1 - z0) + 0.012
        mb.box(loc + nrm * 0.008, (w, 0.022, h), 'Paint_White', bevel=0.008, segs=2)
        mb.box(loc + nrm * 0.016 + V(0.004, 0, 0), (0.010, 0.012, h * 0.75), 'Radiator', bevel=0.002, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


# ---- cowl gills (three triangular slots with mesh each side) and exhaust -----------------------------
# n02 (right side): aft-top, fwd-top, bottom apex; the left side is mirrored
GILLS_PX = [((1743, 1380), (1778, 1402), (1737, 1442)),
            ((1788, 1410), (1837, 1440), (1797, 1525)),
            ((1848, 1445), (1920, 1497), (1873, 1593))]


def clip_tri(p, d, tri):
    t0, t1 = -10.0, 10.0
    area = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0])
    s = 1.0 if area > 0 else -1.0
    for i in range(3):
        a, b = tri[i], tri[(i + 1) % 3]
        nx, nz = -(b[1] - a[1]) * s, (b[0] - a[0]) * s
        num = (p[0] - a[0]) * nx + (p[1] - a[1]) * nz
        den = d[0] * nx + d[1] * nz
        if abs(den) < 1e-9:
            if num < 0:
                return None
            continue
        t = -num / den
        if den > 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
    if t1 - t0 < 0.004:
        return None
    return [(p[0] + d[0] * t0, p[1] + d[1] * t0), (p[0] + d[0] * t1, p[1] + d[1] * t1)]


def build_gills(pod):
    mb = MB('gills_mesh')
    mbl = MB('gills')
    for sy in (1, -1):
        n0 = V(0, sy, 0)
        for tri_px in GILLS_PX:
            tri = [R(*ph_surf(x, y)) for x, y in tri_px]
            cs = [V(p.x, sy * 0.6, p.z) for p in tri]
            cen = (cs[0] + cs[1] + cs[2]) / 3
            outline = []
            for i in range(3):
                a, b = cs[i], cs[(i + 1) % 3]
                for k in range(8):
                    outline.append(a.lerp(b, k / 8))
            hits = [ray_on(pod, p, n0) for p in outline]
            if any(q is None for q, _ in hits):
                continue
            qc, nc = ray_on(pod, cen, n0)
            skirt = [q + (q - qc) * 0.10 - nw * 0.001 for q, nw in hits]
            lip = [q + (q - qc) * 0.03 + nw * 0.006 for q, nw in hits]
            mouth = [q + (qc - q) * 0.04 + nw * 0.0055 for q, nw in hits]
            inner = [q + (qc - q) * 0.07 + nw * 0.001 for q, nw in hits]
            flip = (skirt[1] - skirt[0]).cross(inner[0] - skirt[0]).dot(nc) < 0
            mbl.loft([skirt, lip, mouth, inner], 'Paint_White', closed=True, flip=flip)
            mbl.loft([inner, [qc - nc * 0.01]], 'Radiator', closed=True, flip=flip)
            # hex mesh: two crossing sets of fine wires just inside the mouth
            tri2 = [(p.x, p.z) for p in (cs[0].lerp(cen, 0.10), cs[1].lerp(cen, 0.10), cs[2].lerp(cen, 0.10))]
            for d in ((0.7071, 0.7071), (0.7071, -0.7071)):
                nrm = (-d[1], d[0])
                offs = [nrm[0] * x + nrm[1] * z for x, z in tri2]
                o = min(offs) + 0.005
                while o < max(offs):
                    seg = clip_tri((nrm[0] * o, nrm[1] * o), d, tri2)
                    if seg:
                        ends = []
                        for (x, z) in seg:
                            q, nw = ray_on(pod, V(x, sy * 0.6, z), n0)
                            if q is None:
                                break
                            ends.append(q + nw * 0.0030)
                        if len(ends) == 2:
                            mb.cyl(ends[0], ends[1], 0.0011, 'Mesh_Grille', n=4, cap=True)
                    o += 0.010
    g = mbl.finish(sharp_angle=50, recalc=False)
    return [mb.finish(sharp_angle=60), g]


# ---- boom, struts, tail ----------------------------------------------------------------------------
BOOM = phs([(1985, 1790), (1960, 1793), (1880, 1812), (1800, 1825), (1700, 1834), (1600, 1830), (1540, 1822)])
STRUT_UP = phs([(1990, 1745), (1880, 1775), (1760, 1805), (1640, 1825)])
FLATBAR = phs([(1890, 1690), (1750, 1780)])
HINGE = ph(1130, 1600)[0]
RUD_TE = -2.715
STAB_LE0, STAB_TE0, STAB_Z0 = -1.85, RUD_TE, -1.545         # root (on the fin box)
WL_Y = 0.80
# near winglet, plane y = -0.80 (n02): top aft, top fwd, apex (= stab tip LE), bottom fwd, bottom aft
WL = phs([(890, 1330), (980, 1323), (1153, 1500), (1020, 1687), (940, 1680)], -WL_Y)
STAB_LE1, STAB_TE1 = WL[2][0], -2.465                       # tip (winglet plane)
STAB_Z1 = WL[2][1]                                          # ~12 deg anhedral (front photos show it too)
STAB_T = 0.09
FIN_TOP = STAB_Z0 - 0.5 * STAB_T * (STAB_LE0 - STAB_TE0) * 0.9
WL_CANT = math.radians(15.0)
WL_TOP = 0.5 * (WL[0][1] + WL[1][1])
WL_BOT = 0.5 * (WL[3][1] + WL[4][1])
# fin box: forward edge (swan neck) x(Z) and lower edge x(Z), centre plane
FIN_FWD = [(FIN_TOP, -1.850), (-1.70, -1.862), (-1.80, -1.880), (-1.90, -1.905), (-2.00, -1.914), (-2.09, -1.912),
           (-2.21, -1.868), (-2.29, -1.789), (-2.334, -1.683), (-2.367, -1.527), (-2.423, -1.342), (-2.47, -1.17),
           (-2.50, -1.06)]
FIN_LOW = phs([(1130, 1742), (1260, 1765), (1400, 1795), (1540, 1825)])     # aft -> fwd
RUD_LOW = (ph(945, 1690)[1])


def fin_fwd(Z):
    return _interp([(z, x) for z, x in FIN_FWD], Z)


def fin_aft(Z):
    zh = FIN_LOW[0][1]
    if Z >= zh:
        return HINGE
    return _interp([(z, x) for x, z in FIN_LOW], Z)


def fin_t(Z):
    """Half thickness of the fin box: flat-sided box ~0.15 m wide, the neck tapering into the boom."""
    return lerp(0.072, 0.030, max(0.0, min(1.0, (-2.25 - Z) / 0.27)) ** 1.2)


def box_ring(x_fwd, x_aft, Z, t, n=14, blunt=True, y0=0.0):
    """Horizontal section of a flat-sided box fin: round nose, straight sides, blunt or thin tail."""
    c = x_fwd - x_aft
    up, lo = [], []
    for i in range(n + 1):
        s = (i / n) ** 1.3
        x = x_fwd - s * c
        f = math.sin(0.5 * math.pi * min(1.0, s * c / min(0.10, 0.45 * c))) ** 0.55
        if not blunt:
            f *= 1.0 - 0.85 * max(0.0, (s - 0.55) / 0.45) ** 1.4
        y = max(t * f, 0.0015)
        up.append(R(x, Z, y0 + y))
        lo.append(R(x, Z, y0 - y))
    return [R(x_fwd, Z, y0)] + up[1:] + lo[1:][::-1]


def build_boom():
    mb = MB('boom')
    pts = catmull([R(-0.12, -2.40)] + [R(X, Z) for X, Z in BOOM] + [R(-1.50, -2.50), R(-1.65, -2.47)], 5)
    mb.tube(pts, 0.029, 'Paint_White', n=18)
    # upper strut from the cowl bottom to the boom, flat bar (n02) and a slim brace
    mb.tube(catmull([R(X, Z) for X, Z in STRUT_UP], 4), 0.022, 'Paint_White', n=14)
    a, b = R(*FLATBAR[0]), R(*FLATBAR[1])
    mb.tube([a, b], 0.0, 'Paint_Accent', n=14, square=(0.10, 0.018, 6), cap=True)
    mb.cyl(R(*ph(1820, 1790)), R(*ph(1930, 1715)), 0.009, 'Metal_Frame', n=8)
    # tail wheel under the fin (n02 1262/1785)
    tw = R(*ph(1262, 1785))
    mb.lathe(B.tire_profile(0.034, 0.018, 0.026), tw, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.lathe([(0.0, -0.011), (0.019, -0.011), (0.019, 0.011), (0.0, 0.011)], tw, V(0, 1, 0), 'Engine', n=14)
    for sy in (1, -1):
        mb.box(tw + V(0.006, sy * 0.019, 0.032), (0.035, 0.005, 0.07), 'Metal_Frame', bevel=0.002, segs=1,
               rot=Euler((0, math.radians(-12), 0)))
    mb.cyl(tw + V(0, -0.024, 0), tw + V(0, 0.024, 0), 0.005, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=45)


def wl_le(z):
    Z = z - R.dz
    ax, az = WL[2]
    if Z >= az:
        return R.x(lerp(ax, WL[1][0], (Z - az) / (WL_TOP - az)))
    return R.x(lerp(ax, WL[3][0], (az - Z) / (az - WL_BOT)))


def wl_te(z):
    Z = z - R.dz
    zk = STAB_Z1 + 0.10
    if Z >= zk:
        return R.x(lerp(STAB_TE1 - 0.005, WL[0][0], (Z - zk) / (WL_TOP - zk)))
    return R.x(lerp(STAB_TE1 - 0.005, WL[4][0], (zk - Z) / (zk - WL_BOT)))


def wl_y(z):
    return WL_Y + max(0.0, z - R.dz - STAB_Z1) * math.tan(WL_CANT)


WL_LAMP = ph(963, 1440, -WL_Y)          # PowerBurst lens centre on the near winglet (n02)
print('WL_LAMP', WL_LAMP, 'old', (-2.445, STAB_Z1 + 0.10))


def build_tail():
    mb = MB('tail')
    # stabiliser: tapered, LE swept, anhedral
    loop = airfoil_ring(16, STAB_T, te_min=0.002)
    rings = []
    for y in (-WL_Y, -0.70, -0.55, -0.40, -0.25, -0.10, 0.0, 0.10, 0.25, 0.40, 0.55, 0.70, WL_Y):
        u = abs(y) / WL_Y
        le, te = lerp(STAB_LE0, STAB_LE1, u), lerp(STAB_TE0, STAB_TE1, u)
        zc = lerp(STAB_Z0, STAB_Z1, u)
        ch = le - te
        rings.append([R(le - s * ch, zc + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # winglets: chevron end plates, apex at the stab tip LE, upper half canted out
    zs = [WL_BOT, WL_BOT + 0.02, WL_BOT + 0.06, -2.0, -1.90, -1.80, STAB_Z1 - 0.03, STAB_Z1, STAB_Z1 + 0.04, -1.58,
          -1.50, -1.44, WL_TOP - 0.03, WL_TOP - 0.01, WL_TOP]
    zs = sorted(set(round(z, 4) for z in zs if WL_BOT <= z <= WL_TOP))
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], wl_le, wl_te, y_fn=lambda z, sy=sy: sy * wl_y(z), t=0.065)
    # fin box (fixed part) from the stab down to the swan neck and the lower edge
    zl = [FIN_TOP, -1.62, -1.70, -1.80, -1.90, -2.00, -2.09, -2.16, -2.21, -2.26, -2.30, -2.334, -2.36, -2.39,
          -2.42, -2.45, -2.48, -2.50, -2.515]
    rings = []
    for Z in zl:
        xf, xa = fin_fwd(Z), fin_aft(Z)
        if xf - xa < 0.03:
            continue
        rings.append(box_ring(xf, xa, Z, fin_t(Z), blunt=Z >= FIN_LOW[0][1] - 0.005))
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # rudder hinge brackets and control horn at the bottom
    mb.box(R(HINGE + 0.03, FIN_LOW[0][1] + 0.02), (0.08, 0.03, 0.022), 'Metal_Frame', bevel=0.005, segs=1)
    for sy in (1, -1):
        mb.cyl(R(HINGE - 0.04, FIN_LOW[0][1] + 0.03, sy * 0.06), R(HINGE - 0.04, FIN_LOW[0][1] + 0.03, sy * 0.09),
               0.006, 'Chrome', n=8)
    return mb.finish(sharp_angle=45)


def teardrop(p, n, fwd, length, half_h, k):
    """Outline point k/24 of a teardrop on a surface: blunt end forward (along fwd), point aft."""
    a = TAU * k / 24
    up = n.cross(fwd).normalized()
    return p + fwd * (0.5 * length * math.cos(a)) + up * (half_h / 0.77 * math.sin(a) *
                                                         math.sqrt(max(0.0, 0.5 * (1 + math.cos(a)))))


def build_tail_lamps(tail):
    """PowerBurst nav + strobe unit on the outer face of each winglet just above the stabiliser, near the
    aft edge (n02 963/1440; Navigation-Strobe-lights and Luces close-ups; Cola-alta from behind): a flat
    clear teardrop dome, blunt end forward, on a chrome reflector, with the coloured nav LEDs at the
    blunt end and the white strobe LED strip in the aft half. No separate tail light (none in any photo)."""
    mb = MB('tail_lamps')
    gl = MB('tail_lamp_glass')
    X, Z = WL_LAMP
    ln, hh = 0.105, 0.019
    for sy in (1, -1):
        q, nw = ray_on(tail, R(X, Z, sy * wl_y(R.z(Z))), V(0, sy, -math.tan(WL_CANT)))
        if q is None:
            print('!! winglet lamp: no hit', sy)
            continue
        fwd = (V(1, 0, 0) - nw * nw.x).normalized()
        ring = lambda s, h: [teardrop(q + nw * h, nw, fwd, ln * s, hh * s, k) for k in range(24)]
        # chrome reflector base, then the coloured LED blocks, then the clear dome
        mb.loft([ring(1.06, 0.0005), ring(1.06, 0.003), ring(0.98, 0.004)], 'Chrome', closed=True, cap1=True)
        c = q + nw * 0.0045
        mb.box(c + fwd * 0.030, (0.022, 0.004, 0.012), 'Lens_Red' if sy > 0 else 'Lens_Green', bevel=0.002, segs=1)
        mb.box(c - fwd * 0.012, (0.042, 0.004, 0.006), 'Lens_White', bevel=0.0015, segs=1)
        gl.loft([ring(1.0, 0.003), ring(0.96, 0.009), ring(0.82, 0.014), ring(0.5, 0.017), [q + nw * 0.018]],
                'Glass', closed=True)
        K.lamp_node('navL' if sy > 0 else 'navR', c + fwd * 0.030 + nw * 0.025)
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', c - fwd * 0.012 + nw * 0.025)
    return mb.finish(sharp_angle=60), gl.finish(sharp_angle=60)


def rud_fwd(z):
    return R.x(HINGE)


def build_rudder():
    """Rudder = aft part of the box: hinge -> TE, from under the stabiliser to the lower edge that
    climbs aft (n02 1130/1742 -> 945/1690)."""
    mb = MB('rudder')
    z_bot_h, z_bot_te = FIN_LOW[0][1], RUD_LOW
    zs = [FIN_TOP - 0.004, -1.65, -1.75, -1.85, -1.95, -2.05, -2.15, -2.22, -2.27, -2.31, z_bot_h + 0.005]
    rings = []
    for Z in zs:
        xa = RUD_TE if Z >= z_bot_te else lerp(HINGE, RUD_TE, (Z - z_bot_h) / (z_bot_te - z_bot_h))
        xa = min(xa, HINGE - 0.04)
        rings.append(box_ring(HINGE - 0.004, xa, Z, fin_t(Z) * 0.97, blunt=False))
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    for z in (FIN_TOP - 0.06, -1.95, z_bot_h + 0.05):
        mb.box(R(HINGE + 0.01, z), (0.05, 0.02, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    origin = R(HINGE, -1.95)
    return mb.finish(origin=origin, sharp_angle=45)


# ---- landing gear ------------------------------------------------------------------------------------
def half_spat(name, c, R_=0.175, front=0.20, back=0.40, hw=0.085, top=0.030, lift=0.070, mat='Paint_White',
              exp_top=2.2, tail_drop=0.03):
    """ELA half spat: hood over the top/front of the wheel, long pointed tail aft (n02), open below the
    axle."""
    c = Vector(c)
    x0, x1 = c.x + front, c.x - back
    zc0 = c.z + lift
    ht_u = R_ + top - lift
    ht_d = lift + R_ * 0.05
    rings = [[V(x0, c.y, zc0 - 0.03)]]
    n = 36
    us = [0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.96, 1.0]
    u_max = front / (front + back) * 0.9
    for u in us:
        x = lerp(x0, x1, u)
        t = u / u_max if u < u_max else (1 - u) / (1 - u_max)
        f = max(math.sin(0.5 * math.pi * min(1.0, t)) ** (0.55 if u < u_max else 1.1), 0.02)
        zc = zc0 - 0.03 * (1 - u) - tail_drop * max(0.0, (u - u_max) / (1 - u_max))
        ring = []
        for k in range(n):
            a = TAU * k / n
            ca, sa = math.cos(a), math.sin(a)
            ring.append(V(x, c.y + B.sgnpow(ca, 2 / 2.4) * (hw * f + 0.003),
                          zc + (B.sgnpow(sa, 2 / exp_top) * ht_u if sa > 0 else B.sgnpow(sa, 2 / 2.6) * ht_d) * f))
        rings.append(ring)
    mb = MB(name)
    mb.loft(rings, mat, closed=True, cap1=True)
    ob = mb.finish(sharp_angle=70)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [f for f in bm.faces if f.calc_center_median().z < c.z + 0.03 and f.normal.z < -0.3
            and c.x - R_ * 1.1 < f.calc_center_median().x < c.x + R_ * 1.1]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(ob.data)
    bm.free()
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    K.apply_mods(ob)
    return ob


def build_gear(pod):
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # faired leg: wide aerofoil blade from the lower pod side out to the spat (front photos: nearly
        # level, at the spat's mid height), chord 0.25 m (n02 leg block 1960-2080 px)
        root = R(AXLE[0] + 0.01, -2.36, sy * (hull_y(AXLE[0], -2.36) - 0.04))
        mid = R(AXLE[0] + 0.005, -2.47, sy * 0.52)
        end = V(ax.x, sy * (MAIN_Y - 0.085), ax.z + 0.07)
        pts = catmull([root, mid, end], 6)
        rings = []
        for i, p in enumerate(pts):
            t = i / (len(pts) - 1)
            ch, th = lerp(0.25, 0.17, t), lerp(0.055, 0.04, t)
            ring = []
            for s, tz in airfoil_ring(16, th / ch, te_min=0.004):
                ring.append(p + V(0.10 - s * ch, 0, tz * ch))
            rings.append(ring)
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.075), ax.z), V(ax.x, sy * (MAIN_Y - 0.067), ax.z), 0.085, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.075, sy * (MAIN_Y - 0.071), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        mb.box(V(ax.x, sy * (MAIN_Y - 0.09), ax.z + 0.04), (0.09, 0.02, 0.11), 'Metal_Frame', bevel=0.006, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        spats.append(half_spat(name, c))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=WR, w=0.13)
    # nose wheel on a single curved leg; tow hook (stirrup) under the nose tip
    nc = R(NOSE[0], NOSE[1])
    leg_top = R.z(ph(2960, 1795)[1])
    K.nose_gear(nc, R=NWR, w=0.10, leg_top=leg_top, rake=-0.09, single=True)
    hb = MB('hook')
    (hx0, hz0), (hx1, hz1) = ph(3010, 1790), ph(3080, 1800)
    hook = [R(hx0, -2.395), R(hx0, hz0), R(hx0 + 0.02, hz0 - 0.012), R(hx1, hz1), R(hx1 + 0.02, hz1 + 0.006)]
    hb.tube(catmull(hook, 3), 0.0075, 'Metal_Frame', n=8, cap=True)
    hk = hb.finish(sharp_angle=40)
    return gear, spats, hk


# ---- cockpit -----------------------------------------------------------------------------------------
def seat(mb, hip, back_deg, width=0.42, waist=None, back_h=0.70):
    """Racing bucket seat with integrated headrest: carbon shell, black leather cushion and back."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    c = V(hip.x + 0.12, hip.y, hip.z - 0.125)
    mb.box(c, (0.44, width, 0.06), 'Seat', bevel=0.025, segs=3, rot=Euler((0, math.radians(-10), 0)))
    hb = c.z - 0.03 - R.z(FLOOR_Z)
    if hb > 0.02:
        mb.box(V(c.x - 0.02, c.y, R.z(FLOOR_Z) + hb * 0.5), (0.40, width - 0.06, hb), 'Carbon', bevel=0.008, segs=1)
    wb = waist if waist else width
    rings = []
    for k in range(9):
        t = k / 8
        cc = hip - f * 0.195 + u * (0.02 + back_h * t)
        w = lerp(wb, width, max(0.0, min(1.0, (t - 0.45) / 0.30)) ** 1.5) * 0.5
        if t > 0.78:
            w *= lerp(1.0, 0.62, (t - 0.78) / 0.22)        # headrest
        ring = []
        for j in range(13):
            a = math.pi * j / 12
            ring.append(cc + V(0, math.cos(a) * w, 0) - f * (0.045 * math.sin(a)))
        for j in range(12, -1, -1):
            a = math.pi * j / 12
            ring.append(cc + V(0, math.cos(a) * w, 0) - f * (0.045 * math.sin(a) + 0.03))
        rings.append(ring)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    pad_c = hip - f * 0.16 + u * (0.02 + back_h * 0.42)
    mb.box(pad_c, (0.04, width * 0.74, back_h * 0.78), 'Seat', bevel=0.016, segs=2, rot=rb)
    mb.box(hip - f * 0.16 + u * (0.02 + back_h * 0.90), (0.04, width * 0.48, back_h * 0.14), 'Seat', bevel=0.014,
           segs=2, rot=rb)


def build_cockpit():
    sb = MB('seats')
    seat(sb, FRONT_HIP, FRONT_BACK, width=0.38, waist=0.24, back_h=0.72)
    seat(sb, REAR_HIP, REAR_BACK, width=0.44, back_h=0.70)
    seats = sb.finish(sharp_angle=40, wn=True)
    mb = MB('cockpit')
    # floor
    for X0, X1 in ((-0.18, 1.80),):
        pts = []
        for k in range(14):
            X = lerp(X0, X1, k / 13)
            pts.append((X, max(0.05, hull_y(X, FLOOR_Z + 0.03) - 0.02)))
        rings = [[R(X, FLOOR_Z, -w), R(X, FLOOR_Z, w), R(X, FLOOR_Z - 0.012, w), R(X, FLOOR_Z - 0.012, -w)] for X, w in pts]
        mb.loft(rings, 'Interior', closed=True, cap0=True, cap1=True)
    # rear bulkhead (firewall) behind the passenger, under the pylon
    ring = hull_ring(-0.20, n_half=22, scale=0.965)
    mb.loft([ring, [p + V(-0.02, 0, 0) for p in ring]], 'Interior', closed=True, cap0=True, cap1=True)
    # side consoles / arm rests along the sills
    for sy in (1, -1):
        for X0, X1 in ((1.05, 1.45),):
            Z = -2.07
            pts = [R(X, Z, sy * (hull_y(X, Z) - 0.045)) for X in (X0, (X0 + X1) / 2, X1)]
            mb.tube(pts, 0.0, 'Interior', n=10, square=(0.05, 0.04, 4), cap=True)
    # passenger foot rests either side of the front seat
    for sy in (1, -1):
        mb.box(R(1.02, FLOOR_Z + 0.03, sy * 0.285), (0.20, 0.09, 0.012), 'Metal_Frame', bevel=0.003, segs=1,
               rot=K.rot_y(-15))
    return mb.finish(sharp_angle=40, wn=True), seats


# ---- details ------------------------------------------------------------------------------------------
def build_details(pod, canopy, spons):
    mb = MB('details')
    # canopy latch handle on the frame sill, each side under the front seat (close-up: lever)
    for sy in (1, -1):
        loc, nrm = cast_side(pod, R.x(0.98), R.z(-2.105), sy)
        if loc is not None:
            mb.box(loc + nrm * 0.010, (0.085, 0.014, 0.018), 'Alu_Gold', bevel=0.006, segs=2,
                   rot=Euler((0, math.radians(-12), 0)))
            mb.cyl(loc - nrm * 0.002, loc + nrm * 0.012, 0.008, 'Alu_Gold', n=8)
        # round eyeball vents in the canopy sides (n02: rear seat high, front seat low)
        # (only on the LEFT side: n02 shows them through the glass on the far side)
        for (x, y) in ((2419, 1458), (2673, 1546)) if sy > 0 else ():
            X, Z = ph_surf(x, y, side=1)
            q, nw = cast_side(canopy, R.x(X), R.z(Z), sy)
            if q is not None:
                mb.lathe([(0.026, -0.003), (0.036, -0.003), (0.038, 0.003), (0.030, 0.008), (0.024, 0.006)], q, nw,
                         'Chrome', n=24)
                mb.lathe([(0.0, 0.002), (0.025, 0.002), (0.019, 0.012), (0.0, 0.013)], q, nw, 'Panel', n=18)
        # storage hatch on the sponson: panel line, lock and hinge (close-up: X 0.77-1.38)
        zc = 0.5 * (_interp(SPON_TOP, 1.07) + _interp(SPON_BOT, 1.07))
        rect = rounded_rect(1.075, zc + 0.008, 0.60, 0.085, 0.03)
        q, nw = ray_on(spons, R(1.30, zc + 0.02, sy * 0.8), V(0, sy, 0))
        if q is not None:
            mb.lathe([(0.0, 0.0), (0.010, 0.0), (0.010, 0.003), (0.0, 0.004)], q, nw, 'Chrome', n=12)
        q, nw = ray_on(spons, R(1.07, zc - 0.03, sy * 0.8), V(0, sy, 0))
        if q is not None:
            mb.box(q + nw * 0.002, (0.045, 0.006, 0.010), 'Metal_Frame', bevel=0.002, segs=1)
    # ELA shield on the nose hatch, just ahead of the canopy frame (front photos)
    Xs = 1.84
    zt = top_z(Xs)
    p = R(Xs, zt)
    n = V(0.55, 0, 1).normalized()
    shield_patch(mb, pod, p, n, 0.052, 0.040, 'Decal_White', 0.0012)
    shield_patch(mb, pod, p + V(0.003, 0, 0.001), n, 0.040, 0.030, 'Decal_Red', 0.0024)
    # exhaust outlet: short stub out of the lower right cowl side, pointing aft and down (n02)
    (ex0, ez0), (ex1, ez1) = ph_surf(1917, 1572), ph_surf(1880, 1593, 0.04)
    q, nw = cast_side(pod, R.x(ex0 + 0.03), R.z(ez0 + 0.01), -1)
    if q is not None:
        a = q - nw * 0.02
        b = R(ex1, ez1, q.y - 0.03)
        mb.tube([a, a.lerp(b, 0.5) + V(0, -0.01, 0), b], 0.020, 'Steel_Exhaust', n=14, cap=False)
        mb.lathe([(0.020, 0.0), (0.024, 0.004), (0.022, 0.010), (0.017, 0.008)], b, (b - a).normalized(),
                 'Steel_Exhaust', n=14)
    # prop flange inside the recessed rear face of the cowl
    mb.cyl(R(X_END - 0.004, PROP_Z), PROP + V(0.06, 0, 0), 0.13, 'Engine_Dark', n=32)
    # antenna under the belly, pitot under the nose
    K.antenna(mb, R(0.45, -2.462), (-0.25, 0, -1), length=0.20)
    return mb.finish(sharp_angle=50)


def build_ela10():
    ensure_mats()
    pod = build_hull()
    lines = build_hull_lines(pod)
    canopy, cframe, cseal = split_canopy(pod)
    spons = build_sponsons()
    nlamps, nglass = build_nose_lamps(pod)
    pylon = build_pylon()
    pdet = build_pylon_details(pylon, pod)
    gills = build_gills(pod)
    boom = build_boom()
    K.build_head(PIVOT, HUB, arm=-0.20, arm_w=0.24, plate_mat='Alu_Black')
    K.build_rotor(HUB, R=4.25, chord=0.22, root=0.52, tip_mat='Paint_Accent', clamp_len=0.48, bar_mat='Alu_Gold')
    K.build_prop(PROP, R=PROP_R, blades=3, hub='spinner', hub_r=0.15, hub_len=0.30, mat='Carbon', tip_mat='Carbon',
                 spinner_mat='Paint_Dark')
    tail = build_tail()
    tlamps, tglass = build_tail_lamps(tail)
    rud = build_rudder()
    gear, spats, hook = build_gear(pod)
    cockpit, seats = build_cockpit()

    # ---- controls and crew: pilot in the FRONT seat, throttle on his left
    ctrl = MB('controls_static')
    stick_base = R(1.33, FLOOR_Z + 0.03)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.24, -2.00))
    knob, lever = controls.throttle_lever(ctrl, R(1.38, -2.03, 0.27))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.86, -2.27, 0.08), 'R': R(1.86, -2.27, -0.08)}, knee_out=0.13,
                      elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(FLOOR_Z + 0.02))
    tilt = 22.0
    p0 = R(1.47, -1.89)
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(0.0, 0.035, 0.38, 0.14), cw=0.05, v_leg=-0.20,
                      v_sb=-0.24, v_b=-0.265, top_arch=(0.30, 0.13, 0.175), max_u=0.32, leg_exp=0.25)
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    # dual controls: passenger stick (static)
    rstick, _g, _a = controls.gyro_stick(R(0.62, FLOOR_Z + 0.03), R(0.57, -2.00), name='stick_rear')
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.19, -0.16, 0.13), None),
                             'L': ('rest', REAR_HIP + V(0.19, 0.16, 0.13), None)},
                      feet={'L': R(0.96, -2.27, 0.27), 'R': R(0.96, -2.27, -0.27)}, knee_out=0.11, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    det = build_details(pod, canopy, spons)
    REG_X, REG_Z = ph(1055, 1498, -WL_Y - 0.01)
    regs = E.build_registration(tail, REG, cx=R.x(REG_X), cz=R.z(REG_Z), size=0.095, mat='Decal_White')

    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    where(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit, seats, canopy], ' (pilot)')
    where(['pilot_rear'], [pod, cockpit, seats, ctrl, canopy, rstick] + [o for o in bpy.data.objects
                                                                  if o.name.startswith('pilot_front')], ' (pass)')
    K.finalize([pod, lines, cframe, cseal, spons, pylon, pdet, boom, tail, gear, hook, cockpit, seats, ctrl, det, rstick,
                tlamps, nlamps] + gills + spats + regs, [canopy, nglass, tglass])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.95), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })

    def g(p):       # Blender (x, y, z) -> sim (x forward, y up, z right)
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('ELA10 hub %s pivot %s prop %s R %.3f eye %s' % (g(HUB), g(PIVOT), g(PROP), PROP_R, g(eye)))
    print('ELA10 ground y %.3f  main axle %s  nose axle %s  stick %s' % (
        R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)), g(R(NOSE[0], NOSE[1])), g(stick_base)))
    print('ELA10 nose tip %s  rudder TE %s  stab root LE %s tip LE %s  wl top %.3f bot %.3f  x_end %.3f' % (
        g(R(XTIP, ZTIP)), g(R(RUD_TE, -1.95)), g(R(STAB_LE0, STAB_Z0)), g(R(STAB_LE1, STAB_Z1, WL_Y)),
        R.z(WL_TOP), R.z(WL_BOT), R.x(X_END)))


def print_geometry():
    """Flight-geometry sheet in model coordinates (x fwd, y up, z right)."""
    def g(X, Z, Y=0.0):
        p = R(X, Z, Y)
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)

    def integ(z0, z1, fn, n=400):
        A = Mx = Mz = 0.0
        dz = (z1 - z0) / n
        for i in range(n):
            z = z0 + (i + 0.5) * dz
            a, b = fn(z)
            c = max(0.0, a - b)
            A += c * dz
            Mx += c * dz * (a + b) / 2
            Mz += c * dz * z
        return A, Mx, Mz
    zh, zte = FIN_LOW[0][1], RUD_LOW
    parts = {
        'fin box (fixed)': (integ(-2.53, FIN_TOP, lambda z: (fin_fwd(z), fin_aft(z))), 1),
        'rudder': (integ(zh, FIN_TOP, lambda z: (HINGE, RUD_TE if z >= zte else lerp(HINGE, RUD_TE, (z - zh) / (zte - zh)))), 1),
        'winglet': (integ(WL_BOT, WL_TOP, lambda z: (wl_le(R.z(z)) - R.dx, wl_te(R.z(z)) - R.dx)), 2),
    }
    tot = [0.0, 0.0, 0.0]
    for k, ((A, Mx, Mz), m) in parts.items():
        print('GEOM %-16s area %.3f m2 (x%d)  centroid %s' % (k, A, m, g(Mx / A, Mz / A)))
        tot = [tot[0] + A * m, tot[1] + Mx * m, tot[2] + Mz * m]
    print('GEOM vertical total %.3f m2 centroid %s' % (tot[0], g(tot[1] / tot[0], tot[2] / tot[0])))
    wu = integ(STAB_Z1, WL_TOP, lambda z: (wl_le(R.z(z)) - R.dx, wl_te(R.z(z)) - R.dx))[0]
    wd = integ(WL_BOT, STAB_Z1, lambda z: (wl_le(R.z(z)) - R.dx, wl_te(R.z(z)) - R.dx))[0]
    print('GEOM winglet above stab %.3f m2, below %.3f m2 each; height above %.3f below %.3f' % (
        wu, wd, WL_TOP - STAB_Z1, STAB_Z1 - WL_BOT))
    c0, c1 = STAB_LE0 - STAB_TE0, STAB_LE1 - STAB_TE1
    lam = c1 / c0
    S = WL_Y * (c0 + c1)
    mac = 2.0 / 3.0 * c0 * (1 + lam + lam * lam) / (1 + lam)
    ym = 2 * WL_Y / 6 * (1 + 2 * lam) / (1 + lam)
    u = ym / WL_Y
    le = lerp(STAB_LE0, STAB_LE1, u)
    print('GEOM stab span %.2f area %.3f MAC %.3f at y %.3f; 25%% MAC %s (anhedral %.1f deg)' % (
        2 * WL_Y, S, mac, ym, g(le - 0.25 * mac, lerp(STAB_Z0, STAB_Z1, u)),
        math.degrees(math.atan((STAB_Z0 - STAB_Z1) / WL_Y))))
    print('GEOM nose tyre bottom %s R %.3f | main tyre bottom %s R %.3f | track %.2f wheelbase %.3f' % (
        g(NOSE[0], GROUND), NWR, g(AXLE[0], GROUND, -MAIN_Y), WR, 2 * MAIN_Y, NOSE[0] - AXLE[0]))
    tw = ph(1262, 1785)
    pts = {
        'nose tip': (XTIP, ZTIP, 0), 'tow hook': (ph(3080, 1800)[0] + 0.02, ph(3080, 1800)[1], 0),
        'belly (lowest, under seats)': (1.30, F_B(_u(1.30)), 0), 'canopy top': (0.20, top_z(0.20), 0),
        'sponson R (widest)': (0.85, -2.29, -(hull_y(0.85, -2.29) + 0.085)),
        'sponson L (widest)': (0.85, -2.29, hull_y(0.85, -2.29) + 0.085),
        'mast top / head': (0.0, 0.05, 0), 'pylon top': (0.0, PYL_TOP, 0),
        'spat R outer': (AXLE[0], AXLE[1], -(MAIN_Y + 0.09)), 'spat L outer': (AXLE[0], AXLE[1], MAIN_Y + 0.09),
        'winglet top R': (WL[0][0], WL_TOP, -(WL_Y + (WL_TOP - STAB_Z1) * math.tan(WL_CANT))),
        'winglet top L': (WL[0][0], WL_TOP, WL_Y + (WL_TOP - STAB_Z1) * math.tan(WL_CANT)),
        'winglet bottom R': (WL[4][0], WL_BOT, -WL_Y), 'winglet bottom L': (WL[4][0], WL_BOT, WL_Y),
        'rudder TE bottom': (RUD_TE, RUD_LOW, 0), 'tail wheel (lowest tail)': (tw[0], tw[1] - 0.034, 0),
        'fin box bottom': (fin_aft(-2.50), -2.53, 0), 'prop tip low': (PROP_X, PROP_Z - PROP_R, 0),
    }
    for k, (X, Z, Y) in pts.items():
        print('GEOM crash %-28s %s' % (k, g(X, Z, Y)))


def render_photo_overlay(path, scale=0.5, render=True):
    """Perspective render from the camera of photo n02 on a transparent film (same pinhole as ph())."""
    scn = bpy.context.scene
    B.setup_render(scn)
    scn.cycles.samples = 16
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = PH_W, PH_H
    scn.render.resolution_percentage = int(scale * 100)
    cam = bpy.data.cameras.new('PhotoCam')
    co = bpy.data.objects.new('PhotoCam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    co.location = R(PH_C.x, PH_C.z, PH_C.y)
    co.rotation_euler = PH_D.to_track_quat('-Z', 'Y').to_euler()
    cam.sensor_fit = 'HORIZONTAL'
    cam.sensor_width = 36.0
    cam.lens = PH_F / PH_W * 36.0
    cam.clip_start = 0.05
    cam.clip_end = 200
    sun = bpy.data.lights.new('OSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('OSun', sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(20)), 'XYZ')
    scn.collection.objects.link(so)
    w = bpy.data.worlds.new('OW')
    scn.world = w
    try:
        w.use_nodes = True
        w.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
        w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    except Exception:
        pass
    for name in ('rotor',):
        ob = bpy.data.objects.get(name)
        if ob:
            ob.rotation_euler = (0, 0, math.radians(-165))
    pr = bpy.data.objects.get('pilot_rear')
    if pr:
        pr.hide_render = True
    for o in bpy.data.objects:
        if o.name.startswith('pilot_front'):
            o.hide_render = True
    if not render:
        return
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered photo overlay', path)


VIEWS = {
    # same angles as the reference photos
    'ref_02': dict(extra=True, loc=tuple(R(PH_C.x, PH_C.z, PH_C.y)), target=tuple(R(PH_C.x, PH_C.z, PH_C.y) + PH_D * 10),
                   lens=PH_F / PH_W * 36.0, rotor=-28, prop=20),
    'ref_front': dict(extra=True, loc=(14.0, 0.0, 0.9), target=(0.0, 0.0, 0.25), lens=60, rotor=90, prop=0),
    'ref_14': dict(extra=True, loc=(-3.4, 4.4, 1.1), target=(-0.6, 0.0, -0.25), lens=26, rotor=-60, prop=20),
    'ref_closeup': dict(extra=True, loc=(1.6, 4.6, 0.1), target=(1.3, 0.0, -0.32), lens=40, rotor=75, prop=20),
    'ref_tail': dict(extra=True, loc=(-4.3, 2.2, 1.0), target=(-2.25, 0.0, 0.0), lens=40, rotor=75, prop=20),
    'ref_top': dict(extra=True, loc=(0.0, 0.0, 30.0), target=(-0.3, 0.0, 0.0), ortho=6.0, rotor=90, prop=0),
    # lamps close up (Summer-Windscreen nose close-up, Navigation-Strobe / Luces winglet close-ups, Cola-alta)
    'lamp_nose': dict(extra=True, loc=tuple(R(LENS_TIP[0] - 0.15, LENS_TIP[1] + 0.30, 1.30)),
                      target=tuple(R(LENS_TIP[0] - 0.12, LENS_TIP[1] - 0.01, 0.20)), lens=55, rotor=75, prop=20),
    'lamp_front': dict(extra=True, loc=(9.0, 0.0, 0.2), target=(0.0, 0.0, -0.1), lens=70, rotor=90, prop=0),
    'lamp_winglet': dict(extra=True, loc=tuple(R(WL_LAMP[0] + 0.35, WL_LAMP[1] + 0.10, WL_Y + 1.10)),
                         target=tuple(R(WL_LAMP[0], WL_LAMP[1], WL_Y)), lens=55, rotor=75, prop=20),
    'lamp_tail_rear': dict(extra=True, loc=tuple(R(WL_LAMP[0] - 2.6, WL_LAMP[1] + 0.45, 1.5)),
                           target=tuple(R(WL_LAMP[0], WL_LAMP[1] - 0.1, 0.1)), lens=45, rotor=75, prop=20),
    'interior': dict(extra=True, loc=tuple(R(0.79, -1.62)), target=tuple(R(1.80, -1.80)), lens=18, rotor=75, prop=0),
}

def render_cam_overlay(path, loc, target, lens, size):
    """Generic perspective overlay (36 mm sensor, horizontal fit) for photos from other directions."""
    scn = bpy.context.scene
    co = bpy.data.objects.get('PhotoCam')
    if co is None:
        render_photo_overlay(path, 1.0, render=False)
        co = bpy.data.objects.get('PhotoCam')
    B.aim(co, loc, target, lens)
    co.data.sensor_fit = 'HORIZONTAL'
    co.data.sensor_width = 36.0
    scn.render.resolution_x, scn.render.resolution_y = size
    scn.render.resolution_percentage = 100
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered overlay', path)


if __name__ == '__main__':
    K.run('ela10', build_ela10, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
    if '--geom' in K.ARGV:
        print_geometry()
    pv = K.arg('--povl')
    if pv:
        parts = pv.split(',')
        render_photo_overlay(parts[0], float(parts[1]) if len(parts) > 1 else 0.5)
    pv = K.arg('--povl2')      # out.png,lx,ly,lz,tx,ty,tz,lens,w,h  (model coordinates)
    if pv:
        parts = pv.split(',')
        f = [float(v) for v in parts[1:]]
        render_cam_overlay(parts[0], f[0:3], f[3:6], f[6], (int(f[7]), int(f[8])))
