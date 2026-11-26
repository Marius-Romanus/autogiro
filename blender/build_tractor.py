"""
ELA Aviacion "Gyro Tractor" (crop-spraying gyroplane derived from the ELA 07 Cougar "High-Tail") for the
Autogiro web sim. Same airframe as the ELA 07 (build_ela07.py: mast, head, keel truss with its delta plate,
single bar up to the high tail sitting directly on the bar, swept tailplane with canted end plates, swept fin
and big rudder) with:
  - a single-seat pod: short round beak, raised instrument cowl (tombstone carbon panel, AgNav Titanium
    lightbar on a stalk, GPS puck), wrap-round screen with a black lower frame, one black bucket seat;
  - the 200 L hopper: white box with rounded edges where the rear seat was, sitting on the tub with a small
    overhang, dark filler lid, sight-gauge strip, "GYRO TRACTOR" in blue on both sides;
  - uncowled Rotax 915 iS (blue head covers and "915 iS" intake plate, turbo and stainless exhaust, red
    coolant hoses, grey intercooler ducts, radiator and oil cooler), Helix 3-blader on a red drum hub, bare
    aluminium mast;
  - small turf tyres on khaki tubular legs (wider track), nose wheel under a fairing;
  - spray gear DEPLOYED as in flight: 8.25 m boom (centre bar between the wheels at axle height + two
    outer booms hinged on brackets on the main legs, with dihedral), a strut from each hopper top corner to
    the boom, a drag wire to the pod side, 20 drop nozzles with magenta caps, pump in the right-side recess
    and clear hoses. Empties spray_00..spray_19 on the nozzle outlets and `hopper` in the hopper.

Traced in the hub frame (gyrokit.py) on the factory photo gyro-tractor-1.jpg (1900 px). That photo is a
PERSPECTIVE view from 25 deg ahead of the side (f 1792 px, camera 10.5 m away, 0.3 m above the runway), so
it is used through a solved pinhole camera (bundle adjustment on 18 points: ELA 07 tail and hub fixed, the
rest free: wheels, prop, nose tip, end plates; rms 1.7 px) instead of an ortho overlay: outlines are
back-projected on their planes and the model is rendered from that camera (--photocam) and compared on
the edge. Scale = ELA 07 airframe; checks: the free prop radius comes out 0.872 m (Helix 1.75 m) and the
free track 1.68 m matches the 15-m-width-pass front photo (track / boom span 0.204 -> 1.69 m for 8.25 m).
Widths from the front flight photos (15-m-width-pass, banner-ela-gyro), parts from Foldable-booms,
Rotax-915, 200-L-hopper, AgNav-Titanium.

  blender -b -P blender/build_tractor.py -- [--previews] [--only VIEW,...] [--show-rear]
                                            [--photocam cam.json out.png [--nospray] [--nopilot]]
  (--photocam renders the model from a solved photo camera, json {P: [Cx, Cy, Cz (hub frame), yaw, pitch,
  roll, f px], size}; --nospray leaves the booms out for the photos where they are folded; use with
  --no-export, it also re-saves the .blend)
Outputs: public/models/tractor.glb, blender/tractor.blend, blender/previews/tractor/*.png
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- ground, wheels (camera solve on gyro-tractor-1.jpg, hub frame) -----------------------------------
GROUND = -2.732                      # tyre bottoms
MAIN_R = 0.20                        # 16x6.50-8 class turf tyres
MAIN_W = 0.17
AXLE = (-0.20, GROUND + MAIN_R)
MAIN_Y = 0.84                        # half track (1.68 m)
NOSE_R = 0.19
NOSE = (1.51, GROUND + NOSE_R)
# CG: sim convention 0.33 m ahead of the hub; height 0.85 m above the main axle (as the ELA 07)
CG = (0.33, AXLE[1] + 0.85)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.206)
PROP = R(-1.04, -1.49)
PROP_R = 0.875                       # Helix 1.75 m

LIVERY = dict(body=('#F1F2EF', 0.0, 0.18), accent=('#0E62E6', 0.0, 0.35), dark=('#18191C', 0.25, 0.32),
              seat=('#121315', 0.0, 0.55))


def ensure_mats():
    for name, col, kw in (('Rotax_Blue', '#1E7FD0', dict(metal=0.35, rough=0.32)),
                          ('Hose_Red', '#C8281E', dict(rough=0.5)),
                          ('Leg_Khaki', '#A3A184', dict(metal=0.25, rough=0.5)),
                          ('Rod_Grey', '#9A9EA3', dict(metal=0.7, rough=0.35)),
                          ('Duct_Grey', '#A9ADB3', dict(rough=0.6)),
                          ('Belt_Black', '#1C1D20', dict(rough=0.8)),
                          ('Alu_Bright', '#C9CCCF', dict(metal=1.0, rough=0.25)),
                          ('Prop_Red', '#C4141C', dict(metal=0.6, rough=0.3)),
                          ('Nozzle_Pink', '#D23CC8', dict(rough=0.45)),
                          ('Lightbar_Green', '#3E5A2E', dict(rough=0.55)),
                          ('Gauge_Strip', '#B7B8B0', dict(metal=0.2, rough=0.5)),
                          ('Hose_Clear', '#D8DAD2', dict(rough=0.25)),
                          ('Valve_Yellow', '#F2C80F', dict(rough=0.4)),
                          ('GPS_Gold', '#B79A5C', dict(metal=0.7, rough=0.35))):
        if name not in MATS:
            B.make_mat(name, B.srgb(col), **kw)


# ---- pod: stations (X, top, shoulder z, shoulder half-width, crease z, crease half-width, bottom) ----
# Tub + short beak. Behind the cockpit the top is the ledge the hopper box sits on (step line, falling
# from -1.85 at the rear to -1.94 at the hopper front); in the cockpit it is cut away.
ROWS = [
    (2.32, -1.995, -2.035, 0.100, -2.090, 0.118, -2.152),
    (2.22, -1.942, -1.995, 0.168, -2.105, 0.190, -2.200),
    (2.11, -1.898, -1.960, 0.218, -2.125, 0.245, -2.246),
    (2.00, -1.862, -1.935, 0.258, -2.145, 0.288, -2.285),
    (1.85, -1.842, -1.915, 0.292, -2.165, 0.322, -2.330),
    (1.65, -1.830, -1.905, 0.318, -2.180, 0.346, -2.368),
    (1.40, -1.840, -1.905, 0.336, -2.180, 0.362, -2.392),
    (1.10, -1.880, -1.920, 0.346, -2.170, 0.372, -2.392),
    (0.85, -1.925, -1.950, 0.352, -2.155, 0.374, -2.378),
    (0.55, -1.895, -1.915, 0.352, -2.140, 0.372, -2.365),
    (0.25, -1.862, -1.880, 0.348, -2.130, 0.368, -2.352),
    (0.00, -1.838, -1.856, 0.340, -2.122, 0.360, -2.340),
    (-0.10, -1.830, -1.848, 0.332, -2.120, 0.352, -2.334),
]
NTS = [2.2, 2.3, 2.4, 2.4, 2.4, 2.4, 2.6, 3.5, 5.0, 5.0, 5.0, 5.0, 5.0]
NOSE_TIP = (2.40, -2.084)


class Pod(E.Fuselage):
    """Stationed fuselage with a per-station top exponent (round beak deck, flat hopper ledge)."""

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


POD = Pod(R.table(ROWS), NTS, tip=(R.x(NOSE_TIP[0]), R.z(NOSE_TIP[1])), nt=2.2, nb=1.8, bow=0.0, chine_sharp=False,
          linear_nose=True, nose_exp=0.55)

# ---- cockpit opening (side view, hub frame) ----
SILL = [(0.885, -1.940), (0.95, -1.985), (1.10, -2.010), (1.30, -2.012), (1.45, -2.000), (1.56, -1.965),
        (1.66, -1.905), (1.715, -1.860)]
OPEN_CK = SILL + [(1.715, 0.0), (0.885, 0.0)]
X_TUB_REAR = -0.10

SEAT_HIP = R(1.04, -1.895)
SEAT_BACK = 23.5                     # seat shell
PILOT_BACK = 19.0                    # the pilot sits a little more upright than the shell


def pod_y(X, Z):
    """Half-width of the pod envelope at hub-frame (X, Z)."""
    p = POD.params(R.x(X))
    h = POD.half(p)
    best = 0.0
    z = R.z(Z)
    for (a, b), (c, d) in zip(h, h[1:]):
        if (b - z) * (d - z) <= 0 and b != d:
            t = (z - b) / (d - b)
            best = max(best, lerp(a, c, t))
    return best


def build_pod():
    pod = POD.shell('pod', step=0.03, n_half=40, rear=((0.010, 0.94), (0.020, 0.80), (0.026, 0.55)))
    rim = K.cut_polys(pod, [R.pts(OPEN_CK)], rim_r=0.011, rim_mat='Paint_White', thickness=0.010)
    return pod, rim


def bulkheads():
    """Cockpit floor and the hopper front wall down to the floor (behind the seat)."""
    mb = MB('bulkheads')
    mb.box(R(1.38, -2.300), (0.86, 0.40, 0.012), 'Interior', bevel=0.0)
    zs = [lerp(-2.33, -1.93, k / 8) for k in range(9)]
    rows = [[R(0.86, z, -max(0.0, pod_y(0.86, z) - 0.012)), R(0.86, z, max(0.0, pod_y(0.86, z) - 0.012))] for z in zs]
    for a, b in zip(rows, rows[1:]):
        mb.faces([a[0], a[1], b[1], b[0]], [[0, 1, 2, 3]], 'Interior', smooth=False)
    return mb.finish(sharp_angle=80)


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


# ---------------------------------------------------------------------------
# Hopper (200 L): rounded box on the tub ledge
# ---------------------------------------------------------------------------
HOP_REAR = 0.02
HOP_FRONT_BOT, HOP_FRONT_TOP = 0.905, 0.790
HOP_TOP_REAR, HOP_TOP_FRONT = -1.335, -1.425
HOP_W = 0.384                        # half-width (the tub ledge is 0.352: 3 cm overhang)
HOP_R_SIDE, HOP_R_TOP = 0.04, 0.10


def hop_bot(X):
    """Bottom edge of the box = the tub ledge (step line), hub frame."""
    return lerp(-1.850, -1.944, max(0.0, min(1.0, (X - 0.09) / 0.795))) - 0.012


def hop_top(X):
    return lerp(HOP_TOP_REAR, HOP_TOP_FRONT, max(0.0, min(1.0, (X - HOP_REAR) / (HOP_FRONT_TOP - HOP_REAR))))


HOP_FRONT = [(-1.960, 0.905), (-1.510, 0.715), (-1.488, 0.742), (-1.465, 0.758), (-1.300, 0.758)]


def hop_front(Z):
    """Front face of the box: the lower part, which the seat back leans on, recedes at the seat angle; above
    the seat top a lip juts forward over it (gyro-tractor-1, 200-L-hopper, Foldable-booms)."""
    for (z0, x0), (z1, x1) in zip(HOP_FRONT, HOP_FRONT[1:]):
        if Z <= z1:
            return lerp(x0, x1, max(0.0, (Z - z0) / (z1 - z0)))
    return HOP_FRONT[-1][1]


def hop_x(u, Z):
    """Box surface X at fraction u (0 rear, 1 front) and height Z."""
    return lerp(HOP_REAR, hop_front(Z), u)


def build_hopper():
    mb = MB('hopper_box')
    nu, nring = 34, 96
    L = HOP_FRONT_BOT - HOP_REAR
    rings = []
    us = [0.0]
    for k in range(1, 7):
        us.append(HOP_R_SIDE / L * (1 - math.cos(0.5 * math.pi * k / 6)))
    us += [lerp(us[-1], 1 - us[-1], k / 12) for k in range(1, 12)]
    us += [1 - u for u in reversed(us[:7])]
    for u in us:
        d = min(u, 1 - u) * L                       # distance from the nearest end face
        inset = HOP_R_SIDE * (1 - math.sqrt(max(0.0, 1 - (1 - d / HOP_R_SIDE) ** 2))) if d < HOP_R_SIDE else 0.0
        ring = []
        X0 = hop_x(u, -1.6)
        zt = hop_top(X0) - inset * 0.6
        zb = hop_bot(X0)
        w = HOP_W - inset
        for j in range(nring + 1):
            # half-ring from bottom (y = w, z = zb) up over the top to (y = -w, zb): rounded top corners
            a = math.pi * j / nring
            ca, sa = math.cos(a), math.sin(a)
            rr = HOP_R_TOP
            # rounded rectangle param: straight side, quarter circle, flat top
            per = [(w, zb), (w, zt - rr), None, (-w, zt - rr), (-w, zb)]
            s = j / nring
            side_len = (zt - rr) - zb
            arc = 0.5 * math.pi * rr
            top_len = 2 * (w - rr)
            total = 2 * side_len + 2 * arc + top_len
            dist = s * total
            if dist <= side_len:
                y, z = w, zb + dist
            elif dist <= side_len + arc:
                t = (dist - side_len) / rr
                y, z = w - rr + rr * math.cos(t), zt - rr + rr * math.sin(t)
            elif dist <= side_len + arc + top_len:
                y, z = w - rr - (dist - side_len - arc), zt
            elif dist <= side_len + 2 * arc + top_len:
                t = 0.5 * math.pi + (dist - side_len - arc - top_len) / rr
                y, z = -w + rr + rr * math.cos(t), zt - rr + rr * math.sin(t)
            else:
                y, z = -w, zt - rr - (dist - side_len - 2 * arc - top_len)
            del ca, sa, per
            ring.append(R(hop_x(u, z), z, y))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=False, cap0=True, cap1=True)
    ob = mb.finish(sharp_angle=50)
    return ob


def hopper_details(hop):
    mb = MB('hopper_det')
    # filler lid on the top (dark, rounded) with its hinge and latch
    cx, w, l = 0.52, 0.15, 0.17
    ring = []
    for k in range(32):
        a = TAU * k / 32
        x = cx + l * B.sgnpow(math.cos(a), 0.5)
        y = w * B.sgnpow(math.sin(a), 0.5)
        ring.append((R(x, hop_top(x) + 0.3, y), V(0, 0, 1)))
    q = project(hop, ring, 0.004)
    if len(q) > 8:
        c = sum(q, Vector()) / len(q)
        mb.loft([q, [c + V(0, 0, 0.002)]], 'Paint_Dark', closed=True)
        mb.tube(q + [q[0]], 0.006, 'Rubber', n=6)
    mb.cyl(R(cx - l - 0.01, hop_top(cx - l) + 0.006, -0.08), R(cx - l - 0.01, hop_top(cx - l) + 0.006, 0.08), 0.008,
           'Metal_Frame', n=8)
    mb.box(R(cx + l + 0.01, hop_top(cx + l) + 0.004), (0.03, 0.05, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    # sight-gauge strip near the front edge (translucent grey, red level marks), both sides
    for sy in (1, -1):
        z0, z1 = -1.885, -1.525
        q = []
        for (z, dx) in ((z0, 0.0), (z1, 0.0), (z1, -0.055), (z0, -0.055)):
            q.append(R(hop_x(1.0, z) - HOP_R_SIDE - 0.006 + dx, z, sy * (HOP_W + 0.0015)))
        if True:
            nrm = (q[1] - q[0]).cross(q[3] - q[0])
            mb.faces(q, [[0, 1, 2, 3] if nrm.y * sy > 0 else [3, 2, 1, 0]], 'Gauge_Strip', smooth=False)
            for k in range(3):
                t = 0.2 + 0.3 * k
                a, b = q[0].lerp(q[1], t), q[3].lerp(q[2], t)
                mb.box(a.lerp(b, 0.3) + V(0, sy * 0.001, 0), (0.014, 0.002, 0.003), 'Lens_Red')
        # ELA oval logo on the top front corner
        ring = [(R(0.74 + 0.04 * math.cos(TAU * k / 24), -1.47 + 0.025 * math.sin(TAU * k / 24), sy * 0.5),
                 V(0, sy, 0.4)) for k in range(25)]
        q = project(hop, ring, 0.001)
        if len(q) > 3:
            mb.tube(q, 0.0025, 'Paint_Dark', n=6)
    return mb.finish(sharp_angle=50)


def _font(narrow=False):
    names = ('ARIALNBI.TTF', 'arialbi.ttf', 'arialbd.ttf') if narrow else ('arialbi.ttf', 'arialbd.ttf')
    for f in ['C:/Windows/Fonts/' + n for n in names]:
        if os.path.exists(f):
            try:
                return bpy.data.fonts.load(f, check_existing=True)
            except Exception:
                pass
    return None


def lettering(target, lines, mat='Paint_Accent'):
    """'GYRO / TRACTOR' as a decal shrink-wrapped on both hopper sides (bold italic like the factory one).
    lines = [(text, cx, cz, size)] in the hub frame."""
    font = _font(narrow=True)
    obs = []
    for side in (1, -1):
        mb = MB('lettering_' + ('L' if side > 0 else 'R'))
        for text, cx, cz, size in lines:
            cu = bpy.data.curves.new('lt', 'FONT')
            cu.body = text
            cu.size = size
            cu.align_x = 'CENTER'
            cu.align_y = 'CENTER'
            if font:
                cu.font = font
            else:
                cu.shear = 0.2
            tob = bpy.data.objects.new('lt_tmp', cu)
            bpy.context.scene.collection.objects.link(tob)
            dg = bpy.context.evaluated_depsgraph_get()
            me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
            bpy.data.objects.remove(tob)
            bpy.data.curves.remove(cu)
            bm = bmesh.new()
            bm.from_mesh(me)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])
            inv = target.matrix_world.inverted()
            for v in bm.verts:
                tx, ty = v.co.x, v.co.y
                X = cx - tx if side > 0 else cx + tx
                p = R(X, cz + ty, side * 1.0)
                ok, loc, nrm, _ = target.ray_cast(inv @ p, inv.to_3x3() @ V(0, -side, 0), distance=1.5)
                v.co = (target.matrix_world @ loc) + V(0, side * 0.0016, 0) if ok else p
            bm.normal_update()
            for f in bm.faces:
                if f.normal.y * side < 0:
                    f.normal_flip()
            verts = [v.co.copy() for v in bm.verts]
            faces = [[v.index for v in f.verts] for f in bm.faces]
            bm.free()
            bpy.data.meshes.remove(me)
            mb.faces(verts, faces, mat, smooth=False)
        obs.append(mb.finish(sharp_angle=80, recalc=False))
    return obs


# ---------------------------------------------------------------------------
# Instrument cowl on the nose, windscreen
# ---------------------------------------------------------------------------
COWL_REAR, COWL_FRONT = 1.715, 1.975


def cowl_top(X):
    return lerp(-1.575, -1.615, (X - COWL_REAR) / (COWL_FRONT - COWL_REAR))


def build_cowl():
    """Raised housing of the instrument panel: arch section (flat sides, round top), near-vertical front
    face rounded into the top and sides; open at the rear where the panel sits."""
    mb = MB('cowl')
    xs = [COWL_REAR, 1.75, 1.80, 1.85, 1.90, 1.93, 1.95, 1.962, 1.970, COWL_FRONT]
    rings = []
    n = 36
    for X in xs:
        d = COWL_FRONT - X
        rf = 0.035
        inset = rf * (1 - math.sqrt(max(0.0, 1 - (1 - d / rf) ** 2))) if d < rf else 0.0
        zt = cowl_top(X) - inset
        zb = -1.94                             # buried in the deck
        w = 0.248 - 0.012 * (X - COWL_REAR) / 0.26 - inset
        ring = []
        for j in range(n + 1):
            a = math.pi * j / n
            y = w * B.sgnpow(math.cos(a), 2 / 3.2)
            s = math.sin(a)
            z = zb + (zt - zb) * (s ** (2 / 3.2) if s > 0 else 0.0)
            if j in (0, n):
                z = zb
            ring.append(R(X, z, y))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=False, cap1=True)
    ob = mb.finish(sharp_angle=60)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.008
    sol.offset = -1
    B.apply_mods(ob)
    return ob


def dome_screen(name, base_c, tip, side_path, nu=28, nv=16, bulge=0.03, frame=0.010, smoke=0.0):
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
    # black moulding along the whole lower edge (sill -> cowl sides -> over the cowl top)
    fr.tube(rows[0], 0.0, 'Paint_Dark', n=8, square=(0.040, 0.014, 4), cap=True)
    for side in (0, nu):
        pts = [rows[j][side] for j in range(nv + 1) if (rows[j][side].z - rows[0][side].z) < smoke]
        if len(pts) > 1:
            fr.tube(pts, 0.0, 'Paint_Dark', n=8, square=(0.040, 0.012, 4), cap=True)
    # screw heads along the frame
    for k in range(2, len(rows[0]) - 2, 2):
        p = rows[0][k]
        fr.sphere(p + V(0.012, 0, 0.004), 0.0035, 'Metal_Frame', seg=6, rings=3)
    return ob, fr.finish(sharp_angle=60), rows


WS_TIP = (1.395, -1.200)
WS_BASE_C = (1.735, -1.555)          # on the rear edge of the cowl top
WS_BASE_S = (1.475, -1.985)          # on the sill, just ahead of the seat cushion


def front_screen():
    def side(v):
        # free side edge: from the sill nearly straight up, raking in to the rounded top
        x = lerp(WS_BASE_S[0], WS_TIP[0] + 0.01, v ** 1.2)
        z = lerp(WS_BASE_S[1], WS_TIP[1] - 0.01, v)
        w = 0.352 * (1 - max(0.0, v - 0.30) ** 2.0 / 0.70 ** 2.0) ** 0.6 if v < 1 else 0.0
        return x, z, max(w, 0.0)
    ob, fr, rows = dome_screen('ws_front', WS_BASE_C, WS_TIP, side, bulge=0.04, smoke=0.0)
    return ob, fr


# ---------------------------------------------------------------------------
# Mast, head, pre-rotator drive (ELA 07, bare aluminium mast)
# ---------------------------------------------------------------------------
MAST_TOP = (0.000, -0.375)
MAST_BASE = (-0.184, -1.360)
MAST_FOOT = (-0.225, -2.360)


def build_mast():
    mb = MB('mast')
    top, base, foot = R(*MAST_TOP), R(*MAST_BASE), R(*MAST_FOOT)
    pts = catmull([top, R(-0.09, -0.86), base, R(-0.205, -1.86), foot], 4)
    n = len(pts)
    for i in range(n - 1):
        a, b = pts[i], pts[i + 1]
        t = i / (n - 1)
        wa = lerp(0.075, 0.115, min(1.0, t * 1.6))
        wb = lerp(0.075, 0.115, min(1.0, (i + 1) / (n - 1) * 1.6))
        mb.tube([a, b], 0.0, 'Alu_Bright', n=16, square=((wa + wb) * 0.5, 0.060, 6), cap=True)
    for sy in (1, -1):
        mb.box(PIVOT + V(-0.010, sy * 0.038, -0.085), (0.13, 0.010, 0.20), 'Metal_Frame', bevel=0.012, segs=2,
               rot=K.rot_y(-6))
        mb.cyl(PIVOT + V(0, sy * 0.034, 0), PIVOT + V(0, sy * 0.056, 0), 0.016, 'Engine', n=12)
        mb.cyl(top + V(0.0, sy * 0.044, 0.04), top + V(0.0, sy * 0.05, 0.04), 0.009, 'Metal_Frame', n=8)
    mb.box(R(-0.06, -0.38), (0.16, 0.10, 0.012), 'Metal_Frame', bevel=0.004, segs=1)
    for sy in (1, -1):
        lo = R(-0.235, -1.30, sy * 0.12)
        hi = PIVOT + V(-0.16, sy * 0.12, 0.022)
        mb.cyl(lo, hi, 0.0085, 'Rod_Grey', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.035), 0.012, 'Alu_Black', n=8)
        mb.cyl(lo, lo + V(0, 0, -0.06), 0.013, 'Alu_Black', n=8)
        mb.box(lo + V(0.02, 0, -0.08), (0.10, 0.012, 0.08), 'Metal_Frame', bevel=0.004, segs=1)
    mb.cyl(R(-0.075, -0.52), R(-0.075, -0.40), 0.016, 'Alu_Bright', n=12)
    mb.cyl(R(-0.075, -0.40), R(-0.075, -0.30), 0.007, 'Chrome', n=8)
    mb.tube(catmull([R(-0.08, -0.52), R(-0.10, -0.80), R(-0.13, -1.10), R(-0.17, -1.32)], 5), 0.005, 'Rubber', n=6)
    box_c = R(-0.245, -1.29)
    mb.box(box_c, (0.09, 0.08, 0.09), 'Alu_Bright', bevel=0.012, segs=2)
    mb.tube(catmull([box_c + V(0.0, 0, 0.045), R(-0.215, -1.0), R(-0.175, -0.62), PIVOT + V(-0.137, 0, -0.07)], 5),
            0.008, 'Rod_Grey', n=8)
    mb.lathe([(0.0, 0.0), (0.020, 0.0), (0.024, 0.03), (0.018, 0.06), (0.024, 0.09), (0.018, 0.12), (0.012, 0.15),
              (0.0, 0.15)], box_c + V(0.0, 0, 0.045), V(0.1, 0, 1), 'Rubber', n=14)
    # pre-rotator shaft over the engine to the upper pulley, belt drive at the prop flange
    z_sh = -1.320
    px = PROP.x - R.dx + 0.075
    mb.cyl(R(-0.29, z_sh), R(px, z_sh), 0.013, 'Chrome', n=12)
    mb.box(R(-0.30, z_sh), (0.05, 0.04, 0.04), 'Metal_Frame', bevel=0.008, segs=1)
    mb.lathe([(0.0, -0.022), (0.11, -0.022), (0.11, 0.022), (0.0, 0.022)], R(px, PROP.z - R.dz), V(1, 0, 0),
             'Engine_Dark', n=32)
    mb.lathe([(0.0, -0.022), (0.05, -0.022), (0.05, 0.022), (0.0, 0.022)], R(px, z_sh), V(1, 0, 0), 'Engine_Dark',
             n=20)
    for sy in (1, -1):
        mb.box(R(px, (z_sh + PROP.z - R.dz) * 0.5, sy * 0.085), (0.04, 0.010, 0.17), 'Belt_Black')
    mb.box(R(px + 0.03, z_sh + 0.01, 0.0), (0.03, 0.06, 0.09), 'Metal_Frame', bevel=0.005, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotax 915 iS
# ---------------------------------------------------------------------------
def build_engine(P):
    """Rotax 915 iS in the open bay: crankcase and gearbox, four cylinders with BLUE head covers, the blue
    "915 iS" intake plenum plate on top, fuel rail and injectors, turbocharger at the rear-right with the
    stainless exhaust going down, waste-gate, intercooler + grey corrugated air ducts, red silicone coolant
    hoses, radiator (left, under the prop shaft) and oil cooler, stainless oil tank at the front right."""
    mb = MB('engine')
    P = Vector(P)

    def Q(dx, y, dz):
        return P + V(dx, y, dz)
    zc = -0.12
    mb.box(Q(0.33, 0, zc), (0.34, 0.22, 0.24), 'Engine', bevel=0.04, segs=3)
    mb.box(Q(0.33, 0, zc - 0.13), (0.30, 0.18, 0.06), 'Engine_Dark', bevel=0.02, segs=2)
    for sy, xs in ((1, (0.22, 0.40)), (-1, (0.26, 0.44))):
        for x in xs:
            mb.lathe(B.finned_profile(0.050, 0.064, 0.105, 0.225), Q(x, 0, zc), V(0, sy, 0), 'Engine', n=20)
            mb.box(Q(x, sy * 0.258, zc), (0.12, 0.06, 0.13), 'Engine', bevel=0.016, segs=2)
            mb.box(Q(x, sy * 0.296, zc + 0.008), (0.115, 0.034, 0.112), 'Rotax_Blue', bevel=0.015, segs=2)
            mb.box(Q(x, sy * 0.314, zc + 0.008), (0.07, 0.004, 0.02), 'Decal_White')
            mb.tube(catmull([Q(x, sy * 0.27, zc - 0.07), Q(x, sy * 0.27, zc - 0.15), Q(x - 0.05, sy * 0.19, zc - 0.22),
                             Q(0.06, sy * 0.10, -0.30)], 4), 0.018, 'Steel_Exhaust', n=10, cap=True)
            # injector + fuel rail
            mb.cyl(Q(x + 0.04, sy * 0.20, zc + 0.09), Q(x + 0.04, sy * 0.24, zc + 0.05), 0.009, 'Rotax_Blue', n=8)
        mb.cyl(Q(0.17, sy * 0.21, zc + 0.11), Q(0.49, sy * 0.21, zc + 0.11), 0.008, 'Rotax_Blue', n=8)
        mb.tube(catmull([Q(0.46, sy * 0.25, zc + 0.08), Q(0.33, sy * 0.24, zc + 0.11), Q(0.18, sy * 0.16, zc - 0.02),
                         Q(0.12, sy * 0.10, -0.22)], 5), 0.014, 'Hose_Red', n=8)
        mb.tube(catmull([Q(0.33, sy * 0.06, 0.08), Q(0.33, sy * 0.14, 0.10), Q(0.33, sy * 0.20, 0.05),
                         Q(0.33, sy * 0.25, zc + 0.08)], 4), 0.020, 'Alu_Bright', n=10)
    # intake plenum on top with the blue "915 iS" plate, throttle body
    mb.box(Q(0.33, 0, 0.11), (0.24, 0.16, 0.08), 'Engine_Dark', bevel=0.02, segs=2)
    mb.box(Q(0.33, 0, 0.158), (0.18, 0.12, 0.02), 'Rotax_Blue', bevel=0.008, segs=2)
    mb.box(Q(0.33, 0, 0.169), (0.10, 0.05, 0.003), 'Decal_White')
    mb.cyl(Q(0.47, 0, 0.11), Q(0.56, 0, 0.11), 0.035, 'Alu_Bright', n=16)
    # gearbox round the prop shaft
    mb.box(Q(0.11, 0, -0.05), (0.10, 0.19, 0.24), 'Engine', bevel=0.04, segs=3)
    mb.lathe([(0.0, 0.16), (0.085, 0.16), (0.090, 0.13), (0.080, 0.08), (0.055, 0.05), (0.0, 0.05)],
             P, V(1, 0, 0), 'Engine', n=28)
    mb.cyl(Q(0.47, -0.10, -0.22), Q(0.36, -0.10, -0.22), 0.040, 'Engine_Dark', n=16)
    mb.cyl(Q(0.50, 0.0, zc), Q(0.53, 0.0, zc), 0.09, 'Engine_Dark', n=24)
    # turbocharger at the rear right under the engine, waste-gate, stainless exhaust down and aft
    tc = Q(0.18, -0.14, -0.30)
    mb.lathe([(0.0, -0.06), (0.06, -0.06), (0.075, -0.03), (0.075, 0.03), (0.06, 0.06), (0.0, 0.06)], tc, V(0, 1, 0),
             'Steel_Exhaust', n=24)
    mb.lathe([(0.0, -0.04), (0.055, -0.04), (0.055, 0.04), (0.0, 0.04)], tc + V(0, 0.10, 0), V(0, 1, 0), 'Alu_Bright', n=20)
    mb.tube(catmull([tc + V(-0.02, -0.04, -0.05), tc + V(-0.08, -0.06, -0.14), tc + V(-0.16, -0.06, -0.22),
                     tc + V(-0.24, -0.06, -0.26)], 5), 0.028, 'Steel_Exhaust', n=12, cap=True)
    mb.cyl(tc + V(0.05, -0.06, 0.04), tc + V(0.05, -0.06, 0.10), 0.022, 'Steel_Exhaust', n=10)
    # intercooler + corrugated grey ducts from the turbo to the plenum
    ic = Q(0.10, 0.20, -0.08)
    mb.box(ic, (0.06, 0.06, 0.20), 'Alu_Bright', bevel=0.008, segs=1)
    mb.box(ic + V(0, 0.032, 0), (0.05, 0.004, 0.17), 'Radiator')
    for path in ([tc + V(0, 0.12, 0.0), Q(0.24, 0.10, -0.40), Q(0.12, 0.24, -0.22), ic + V(0, 0, -0.08)],
                 [ic + V(0, 0, 0.09), Q(0.16, 0.18, 0.10), Q(0.30, 0.10, 0.14), Q(0.42, 0.04, 0.11)]):
        pts = catmull(path, 6)
        mb.tube(pts, 0.030, 'Duct_Grey', n=12)
        for k in range(1, len(pts) - 1, 2):
            d = (pts[k + 1] - pts[k - 1]).normalized()
            mb.lathe([(0.0, -0.004), (0.033, -0.004), (0.033, 0.004), (0.0, 0.004)], pts[k], d, 'Duct_Grey', n=12)
    # radiator: alu core on the left behind the engine, under the prop shaft; oil cooler under it
    rc = Q(0.13, 0.20, -0.33)
    mb.box(rc, (0.24, 0.06, 0.24), 'Alu_Bright', bevel=0.006, segs=1)
    mb.box(rc + V(0, 0.032, 0), (0.21, 0.004, 0.21), 'Radiator')
    for k in range(8):
        mb.box(rc + V(0, 0.036, -0.09 + k * 0.026), (0.21, 0.004, 0.004), 'Alu_Bright')
    oc = Q(0.35, 0.10, -0.53)
    mb.box(oc, (0.20, 0.05, 0.12), 'Alu_Bright', bevel=0.005, segs=1)
    mb.box(oc + V(0, 0.027, 0), (0.18, 0.004, 0.10), 'Radiator')
    # red coolant hoses down the hopper back, blue silicone elbow
    for sy in (1, -1):
        mb.tube(catmull([Q(0.52, sy * 0.15, zc + 0.05), Q(0.62, sy * 0.30, -0.05), Q(0.66, sy * 0.30, -0.40),
                         Q(0.40, sy * 0.25, -0.55), rc + V(0.10, 0, -0.10)], 6), 0.017, 'Hose_Red', n=10)
    mb.tube(catmull([rc + V(-0.12, 0.0, -0.08), rc + V(-0.18, -0.02, -0.16), rc + V(-0.12, -0.08, -0.25)], 4), 0.02,
            'Rotax_Blue', n=10)
    # stainless oil tank at the front right of the bay with its hoses
    ot = Q(0.62, -0.22, -0.30)
    mb.cyl(ot, ot + V(0, 0, 0.28), 0.058, 'Alu_Bright', n=20)
    mb.cyl(ot + V(0, 0, 0.28), ot + V(0, 0, 0.30), 0.03, 'Paint_Dark', n=12)
    mb.box(ot + V(0.0, -0.058, 0.17), (0.05, 0.004, 0.07), 'Decal_White')
    mb.tube(catmull([ot + V(-0.03, 0.03, 0.26), Q(0.52, -0.12, -0.02), Q(0.45, -0.06, zc - 0.10)], 4), 0.009, 'Rubber',
            n=6)
    # ECU / fuse box (white) on the frame at the left
    mb.box(Q(0.35, 0.32, -0.36), (0.12, 0.05, 0.16), 'Bottle_White' if 'Bottle_White' in MATS else 'Paint_White',
           bevel=0.01, segs=1)
    # each arm runs from inside the crankcase to the mount plate on the bay upright (R(-0.29, -1.72)):
    # the lower pair used to start 8 cm under the crankcase and the upper pair to end 15 cm above the
    # plate, both in mid air
    for sy in (1, -1):
        for c, z in ((Q(0.47, sy * 0.09, zc + 0.03), -1.67), (Q(0.46, sy * 0.08, zc - 0.09), -1.77)):
            mb.cyl(c, R(-0.29, z, sy * 0.15), 0.011, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=38, wn=True)


# ---------------------------------------------------------------------------
# Bay frame, truss, boom (ELA 07, untouched apart from the colour)
# ---------------------------------------------------------------------------
NODE = (-1.057, -2.520)
STAB_Z = -2.170
TE_X = -2.360
APEX_X = -1.418
TIP_Y = 0.78
PLATE_LE = -1.830
PLATE_H = 0.515                      # Gyro Tractor end plates: 4.5 cm lower than the ELA 07 model
PLATE_TE_ROOT, PLATE_TE_TOP = -2.165, -2.080   # ... and shorter behind (gyro-tractor-1.jpg overlay)
STAB_TE_TIP = -2.185
PLATE_CANT = 15.0
HINGE = -2.050
FIN_TOP = -1.290
RUD_TOP = -1.310
FIN_LE = ((-1.665, -2.125), (-1.899, -1.319))


def build_frame():
    mb = MB('frame')
    keel0, keel1 = R(0.70, -2.33), R(-0.10, -2.31)
    mb.tube([keel0, keel1], 0.0, 'Paint_White', n=16, square=(0.05, 0.05, 6), cap=True)
    for sy in (1, -1):
        mb.tube([R(-0.08, -2.31, sy * 0.14), R(-0.20, -2.08, sy * 0.17), R(-0.27, -1.70, sy * 0.15)], 0.016,
                'Paint_White', n=10)
        mb.tube(catmull([R(-0.12, -1.72, sy * 0.29), R(-0.24, -1.675, sy * 0.33), R(-0.62, -1.675, sy * 0.33),
                         R(-0.80, -1.76, sy * 0.30), R(-0.92, -1.90, sy * 0.22), R(-0.93, -1.98, sy * 0.14)], 5),
                0.012, 'Paint_White', n=10)
        mb.box(R(-0.29, -1.72, sy * 0.15), (0.03, 0.06, 0.16), 'Paint_White', bevel=0.005, segs=1)
    for z in (-2.08, -1.70):
        mb.cyl(R(-0.20 if z < -2 else -0.27, z, -0.17), R(-0.20 if z < -2 else -0.27, z, 0.17), 0.016,
               'Paint_White', n=10)
    mb.cyl(R(-0.93, -1.98, -0.14), R(-0.93, -1.98, 0.14), 0.012, 'Paint_White', n=8)
    a, b = R(-0.25, -2.04), R(NODE[0] + 0.02, NODE[1] + 0.03)
    mb.tube([a, b], 0.0, 'Paint_White', n=16, square=(0.04, 0.14, 6), cap=True)
    mb.tube([R(-0.06, -2.33), R(NODE[0] + 0.03, NODE[1] - 0.01)], 0.0, 'Paint_White', n=16,
            square=(0.045, 0.045, 6), cap=True)
    for sy in (1, -1):
        poly = [R(-0.80, -2.33, sy * 0.03), R(NODE[0] - 0.08, NODE[1] - 0.025, sy * 0.03),
                R(-0.80, -2.475, sy * 0.03)]
        mb.faces(poly, [[0, 1, 2]], 'Paint_White', smooth=False)
        mb.faces(poly[::-1], [[0, 1, 2]], 'Paint_White', smooth=False)
        mb.cyl(R(NODE[0], NODE[1], sy * 0.03), R(NODE[0], NODE[1], sy * 0.045), 0.012, 'Metal_Frame', n=10)
    # "la aleta": the flat V plate on the lower bar at the node (ELA 07 keel truss)
    fin_le_ = [(-1.180, 0.162), (-1.130, 0.158), (-1.085, 0.146), (-1.035, 0.126), (-0.990, 0.102),
               (-0.945, 0.077), (-0.900, 0.052), (-0.855, 0.028), (-0.815, 0.008), (-0.795, 0.0)]
    st = []
    for X, hw in reversed(fin_le_):
        u = (-0.795 - X) / 0.385
        st.append((R(X, lerp(-2.452, -2.474, u)), hw, lerp(0.012, 0.020, u)))
    st.append((R(-1.205, -2.475), 0.150, 0.020))
    K.delta_plate(mb, st)
    saddle = R(-1.55, -2.240)
    mb.tube([R(NODE[0] - 0.02, NODE[1] + 0.01), saddle], 0.0, 'Paint_White', n=16, square=(0.05, 0.05, 6),
            cap=True)
    mb.tube([saddle, R(-1.85, -2.241), R(-2.13, -2.221)], 0.0, 'Paint_White', n=12, square=(0.06, 0.045, 6),
            cap=True)
    for x in (-1.60, -2.05):
        mb.box(R(x, -2.240 if x > -1.9 else -2.226), (0.035, 0.068, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
    mb.cyl(R(-1.62, -2.262, 0.04), R(-2.08, -2.245, 0.04), 0.006, 'Chrome', n=6)
    tw = R(-2.10, -2.340)
    mb.lathe(B.tire_profile(0.036, 0.018, 0.025), tw, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.box(tw + V(0.0, 0, 0.068), (0.03, 0.04, 0.09), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Tail (ELA 07 High Tail)
# ---------------------------------------------------------------------------
def stab_le(y):
    return APEX_X - (APEX_X - PLATE_LE) * min(abs(y), TIP_Y) / TIP_Y


def build_tail():
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
            # straight trailing edge inboard, swept forward over the outer 45 % to meet the end plate
            return stab_le(y), lerp(TE_X, STAB_TE_TIP, max(0.0, (abs(y) - 0.35) / (TIP_Y - 0.35)) ** 1.3)
        le = PLATE_LE - 0.06 * h ** 1.2 - 0.03 * max(0.0, (h - 0.88) / 0.12) ** 2
        te = lerp(PLATE_TE_ROOT, PLATE_TE_TOP, h ** 0.9) + 0.03 * max(0.0, (h - 0.88) / 0.12) ** 2
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
    if Z < STAB_Z + 0.08:
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
LEG_ROOT = (-0.24, -2.30)            # both legs meet the keel at the pod rear (gyro-tractor-1 back-projection)
BOOM_HINGE_Y = 0.50                  # outer boom hinge brackets on the legs


def leg_point(sy, t):
    """Point at fraction t along the main leg from its keel root to the axle stub (hub frame -> model)."""
    a = R(LEG_ROOT[0], LEG_ROOT[1], sy * 0.07)
    b = V(R.x(AXLE[0]) + 0.01, sy * (MAIN_Y - 0.13), R.z(AXLE[1]) + 0.04)
    return a.lerp(b, t)


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        root, tip = leg_point(sy, 0.0), leg_point(sy, 1.0)
        # khaki tubular leg from the keel fitting out to the axle block; a rear radius rod
        mb.cyl(root, tip, 0.026, 'Leg_Khaki', n=14)
        mb.box(root, (0.08, 0.05, 0.07), 'Metal_Frame', bevel=0.008, segs=1)
        # (its root is IN the keel tube: it used to start 3 cm under it)
        mb.cyl(R(0.12, -2.325, sy * 0.015), tip + V(0.02, 0, -0.01), 0.014, 'Leg_Khaki', n=10)
        mb.box(tip + V(0, 0, -0.02), (0.08, 0.05, 0.09), 'Leg_Khaki', bevel=0.01, segs=2)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.15), ax.z), V(ax.x, sy * (MAIN_Y + 0.10), ax.z), 0.015, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.105), ax.z), V(ax.x, sy * (MAIN_Y - 0.097), ax.z), 0.075, 'Metal_Frame',
               n=24)
        mb.box(V(ax.x + 0.065, sy * (MAIN_Y - 0.10), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', V(ax.x, sy * MAIN_Y, ax.z), R=MAIN_R, w=MAIN_W, rim_r=0.085)
    gear = mb.finish(sharp_angle=40, wn=True)
    nose = K.nose_gear(R(NOSE[0], NOSE[1]), R=NOSE_R, w=0.15, leg_top=R.z(-2.43), rake=-0.03,
                       fork_mat='Metal_Frame')
    return gear, nose


def build_chin():
    """Fairing over the nose wheel under the beak (open underneath)."""
    prof = [(1.925, -2.315), (1.895, -2.420), (1.830, -2.495), (1.740, -2.530), (1.450, -2.535), (1.330, -2.515),
            (1.255, -2.460), (1.215, -2.395)]
    rings = []
    for (X, zb) in prof:
        zt = POD.params(R.x(X))['zb'] - R.dz + 0.03
        hw = 0.135 * min(1.0, (1.925 - X) / 0.10, (X - 1.215) / 0.10) ** 0.5
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
    cm.box(R(NOSE[0], NOSE[1] + 0.02), (2 * NOSE_R + 0.06, 0.17, 2 * NOSE_R + 0.06), 'Paint_White', bevel=0.05,
           segs=3)
    B.boolean_cut_shell(ob, cm.finish(sharp_angle=80))
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    B.apply_mods(ob)
    return ob


# ---------------------------------------------------------------------------
# Spray gear (deployed as in flight)
# ---------------------------------------------------------------------------
BOOM_SPAN = 8.25
BOOM_X = -0.12                       # boom tubes just ahead of the main axle
BAR_Z = -2.535                       # centre bar at axle height
HINGE_Z = -2.360                     # outer boom hinges on the leg brackets
JUNC_Y, JUNC_Z = 2.49, -2.045        # strut / boom junction (between nozzles 3 and 4 from the inside)
TIP_Z = -1.940                       # boom tip (inner part ~9 deg dihedral, outer part ~3.5 deg)
STRUT_TOP = (-0.12, 0.40, -1.285)    # fittings behind the hopper top rear corners (front photo + gt1)
WIRE_POD = (1.10, 0.372, -1.96)      # drag-wire fittings on the pod sides
NOZ_OUT = [1.525, 1.945, 2.365, 2.785, 3.205, 3.625, 4.045]
NOZ_BAR = [0.21, 0.63, 1.05]
BAR_Y = 1.10


def boom_z(y):
    """Height of the outer boom tube at span y (>= hinge)."""
    y = abs(y)
    if y <= JUNC_Y:
        return lerp(HINGE_Z, JUNC_Z, (y - BOOM_HINGE_Y) / (JUNC_Y - BOOM_HINGE_Y))
    return lerp(JUNC_Z, TIP_Z, (y - JUNC_Y) / (BOOM_SPAN / 2 - JUNC_Y))


def nozzle(mb, p, d=None):
    """Drop nozzle body clamped under the tube: black clamp + check valve, magenta cap, grey tip.
    Returns the outlet point."""
    p = Vector(p)
    mb.cyl(p + V(0, 0, 0.004), p + V(0, 0, -0.050), 0.0135, 'Paint_Dark', n=10)
    mb.box(p + V(0.0, 0, 0.0), (0.032, 0.040, 0.030), 'Paint_Dark', bevel=0.006, segs=1)
    mb.sphere(p + V(-0.004, 0, -0.030), 0.014, 'Paint_Dark', seg=10, rings=6)
    mb.cyl(p + V(0, 0, -0.050), p + V(0, 0, -0.074), 0.0125, 'Nozzle_Pink', n=10)
    mb.cyl(p + V(0, 0, -0.074), p + V(0, 0, -0.092), 0.0055, 'Rod_Grey', n=8)
    return p + V(0, 0, -0.094)


def build_spray():
    mb = MB('spray_gear')
    outlets = []
    r_tube = 0.0125
    # centre bar between the wheels at axle height
    bar = [R(BOOM_X, BAR_Z, -BAR_Y - 0.02), R(BOOM_X, BAR_Z, BAR_Y + 0.02)]
    mb.cyl(bar[0], bar[1], r_tube, 'Alu_Bright', n=10)
    for sy in (1, -1):
        mb.cyl(R(BOOM_X, BAR_Z, sy * (BAR_Y + 0.02)), R(BOOM_X, BAR_Z, sy * (BAR_Y + 0.045)), 0.008, 'Metal_Frame', n=8)
        # clamps of the bar on the legs (inboard of the wheels)
        mb.box(R(BOOM_X, BAR_Z, sy * (MAIN_Y - 0.16)), (0.05, 0.03, 0.05), 'Paint_Dark', bevel=0.006, segs=1)
    for y in sorted([-v for v in NOZ_BAR] + NOZ_BAR):
        outlets.append(nozzle(mb, R(BOOM_X, BAR_Z - r_tube, y)))
    for sy in (1, -1):
        # hinge bracket (A frame) on the leg and the hinge block
        hb = R(BOOM_X, HINGE_Z, sy * BOOM_HINGE_Y)
        for t in (0.55, 0.80):
            lp = leg_point(sy, t)
            mb.cyl(lp, hb, 0.010, 'Leg_Khaki', n=8)
        mb.box(hb, (0.06, 0.05, 0.06), 'Alu_Bright', bevel=0.008, segs=1)
        mb.cyl(hb + V(0, 0, -0.04), hb + V(0, 0, 0.04), 0.008, 'Metal_Frame', n=8)
        # outer boom tube: inner part with dihedral to the strut junction, outer part flatter to the tip
        pts = [R(BOOM_X, HINGE_Z, sy * BOOM_HINGE_Y)]
        for k in range(1, 25):
            y = lerp(BOOM_HINGE_Y, BOOM_SPAN / 2, k / 24)
            pts.append(R(BOOM_X, boom_z(y), sy * y))
        mb.tube(catmull(pts, 2), r_tube, 'Alu_Bright', n=10, cap=True)
        tip = pts[-1]
        mb.cyl(tip, tip + V(0, sy * 0.035, 0), 0.010, 'Paint_Dark', n=8)
        mb.cyl(tip + V(0, sy * 0.035, 0), tip + V(0, sy * 0.06, 0), 0.006, 'Chrome', n=6)
        for y in NOZ_OUT:
            outlets.append(nozzle(mb, R(BOOM_X, boom_z(y) - r_tube, sy * y)))
        # strut (tube) from the hopper top corner to the boom junction, fittings at both ends
        st0 = R(STRUT_TOP[0], STRUT_TOP[2], sy * STRUT_TOP[1])
        st1 = R(BOOM_X, JUNC_Z + 0.02, sy * JUNC_Y)
        mb.cyl(st0, st1, 0.012, 'Alu_Bright', n=10)
        mb.box(st0, (0.05, 0.04, 0.04), 'Metal_Frame', bevel=0.006, segs=1)
        # the fitting sits on a bracket bolted to the hopper rear corner and tied to the mast
        mb.cyl(st0, R(0.03, -1.36, sy * (HOP_W - 0.03)), 0.011, 'Alu_Bright', n=8)
        mb.cyl(st0, R(-0.19, -1.36, sy * 0.05), 0.010, 'Alu_Bright', n=8)
        mb.box(st1, (0.05, 0.04, 0.05), 'Metal_Frame', bevel=0.006, segs=1)
        # drag wire from the junction forward to the pod side
        w0 = R(*WIRE_POD[::2], y=sy * WIRE_POD[1]) if False else R(WIRE_POD[0], WIRE_POD[2], sy * WIRE_POD[1])
        mb.cyl(st1 + V(0.02, 0, -0.01), w0, 0.0025, 'Metal_Frame', n=6)
        mb.box(w0, (0.035, 0.012, 0.025), 'Metal_Frame', bevel=0.004, segs=1)
        # clear feed hose along the boom (from the hinge) to the inner nozzles
        hose = [R(BOOM_X, HINGE_Z + 0.02, sy * (BOOM_HINGE_Y - 0.05)), R(BOOM_X, HINGE_Z + 0.03, sy * (BOOM_HINGE_Y + 0.25)),
                R(BOOM_X, boom_z(1.1) + 0.025, sy * 1.1)]
        mb.tube(catmull(hose, 4), 0.008, 'Hose_Clear', n=8)
    # feed: from the pump (right-side recess, recess_and_pump) out under the belly to a tee on the centre
    # bar, then clear hoses to the boom hinges
    feed = [R(0.62, -2.33, -0.30), R(0.50, -2.39, -0.22), R(0.25, -2.43, -0.08), R(BOOM_X + 0.05, BAR_Z + 0.03, 0.0)]
    mb.tube(catmull(feed, 6), 0.010, 'Hose_Clear', n=8)
    mb.box(R(BOOM_X + 0.05, BAR_Z + 0.015, 0.0), (0.05, 0.05, 0.04), 'Paint_Dark', bevel=0.006, segs=1)
    for sy in (1, -1):
        h = [R(BOOM_X + 0.05, BAR_Z + 0.03, 0.0), R(BOOM_X + 0.02, -2.47, sy * 0.25),
             R(BOOM_X, HINGE_Z + 0.02, sy * (BOOM_HINGE_Y - 0.05))]
        mb.tube(catmull(h, 5), 0.008, 'Hose_Clear', n=8)
    return mb.finish(sharp_angle=40, wn=True), outlets


def recess_and_pump(pod):
    """Dark recess in the right side of the tub (pump, yellow valve handle)."""
    mb = MB('recess')
    x0, x1, z0, z1 = 0.58, 0.97, -2.30, -2.05
    for sy in (-1,):
        rings = []
        for sc in (1.0, 0.75, 0.5, 0.25, 0.0):
            ring = []
            for k in range(28):
                a = TAU * k / 28
                X = (x0 + x1) / 2 + sc * (x1 - x0) / 2 * B.sgnpow(math.cos(a), 0.25)
                Z = (z0 + z1) / 2 + sc * (z1 - z0) / 2 * B.sgnpow(math.sin(a), 0.25)
                ring.append((R(X, Z, sy * 0.5), V(0, sy, 0)))
            q = project(pod, ring, 0.003)
            if len(q) < 28:
                break
            rings.append(q if sc > 0 else [sum(q, Vector()) / len(q)])
        if len(rings) == 5:
            # black pocket (a dark panel on the skin) with a thin lip round it
            mb.loft(rings, 'Paint_Dark', closed=True)
            mb.tube(rings[0] + [rings[0][0]], 0.004, 'Paint_Dark', n=6)
            # the pump in it: black body, yellow ball-valve handle, red tag
            pc = rings[-1][0]
            mb.box(pc + V(0.04, sy * 0.010, -0.03), (0.12, 0.02, 0.09), 'Rubber', bevel=0.008, segs=1)
            mb.cyl(pc + V(-0.07, 0, -0.06), pc + V(-0.07, sy * 0.025, -0.06), 0.03, 'Rubber', n=14)
            mb.box(pc + V(0.03, sy * 0.028, 0.045), (0.05, 0.016, 0.035), 'Valve_Yellow', bevel=0.004, segs=1)
            mb.box(pc + V(0.005, sy * 0.030, 0.07), (0.07, 0.014, 0.014), 'Valve_Yellow', bevel=0.003, segs=1)
            mb.cyl(pc + V(0.03, sy * 0.02, 0.02), pc + V(0.03, sy * 0.02, -0.01), 0.008, 'Lens_Red', n=8)
    return mb.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
# Cockpit
# ---------------------------------------------------------------------------
def low_bucket(mb, hip, back_deg, width=0.40, back_h=0.50, cushion_len=0.40):
    """Black leather low-back bucket seat of the Gyro Tractor (200-L-hopper.jpg): back about 0.50 m above
    the hip, wrap-round side bolsters, leaning on the hopper front."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rot_back = Euler((0, -b, 0))
    seat_top = hip.z - 0.085
    c = V(hip.x + cushion_len * 0.5 - 0.10, 0, seat_top - 0.04)
    mb.box(c, (cushion_len, width, 0.08), 'Seat', bevel=0.03, segs=3, rot=Euler((0, math.radians(-7), 0)))
    mb.box(c - V(0, 0, 0.08), (cushion_len - 0.04, width - 0.06, 0.10), 'Interior', bevel=0.02, segs=1)
    back_c = hip - f * 0.13 + u * (back_h * 0.5 - 0.02)
    mb.box(back_c, (0.06, width, back_h), 'Seat', bevel=0.03, segs=3, rot=rot_back)
    for sy in (1, -1):
        mb.box(back_c + f * 0.045 + V(0, sy * (width * 0.5 - 0.025), 0) - u * (back_h * 0.5 - 0.07), (0.11, 0.05, 0.13),
               'Seat', bevel=0.022, segs=2, rot=rot_back)
        mb.box(c + V(0.02, sy * (width * 0.5 - 0.03), 0.04), (cushion_len - 0.08, 0.05, 0.06), 'Seat', bevel=0.02,
               segs=2, rot=Euler((0, math.radians(-7), 0)))
    # stitched panels on the back (dark seams are part of the seat, not the paint)
    for k in range(3):
        mb.box(back_c + f * 0.032 + u * (-0.12 + 0.1 * k), (0.004, width - 0.12, 0.006), 'Paint_Dark',
               rot=rot_back)


def build_cockpit():
    mb = MB('cockpit')
    low_bucket(mb, SEAT_HIP, SEAT_BACK, width=0.48)
    b = math.radians(SEAT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    f = V(math.cos(b), 0, math.sin(b))
    hip = SEAT_HIP
    face = hip - f * 0.13 + f * 0.04
    buckle = hip + f * 0.16 + V(0, 0, -0.035)
    for sy in (1, -1):
        top = face + u * 0.40 + V(0, sy * 0.07, 0) - f * 0.09
        pts = [top, face + u * 0.38 + V(0, sy * 0.07, 0) - f * 0.01, face + u * 0.28 + V(0, sy * 0.075, 0),
               face + u * 0.12 + V(0, sy * 0.07, 0) + f * 0.02, buckle + V(-0.04, sy * 0.03, 0.03)]
        mb.tube(catmull(pts, 4), 0.0, 'Belt_Black', n=8, square=(0.045, 0.005, 6), cap=True)
        lap = [hip + V(-0.02, sy * 0.19, -0.03), hip + V(0.08, sy * 0.15, -0.035), buckle + V(0, sy * 0.04, 0.005)]
        mb.tube(catmull(lap, 4), 0.0, 'Belt_Black', n=8, square=(0.045, 0.005, 6), cap=True)
    mb.box(buckle, (0.06, 0.07, 0.02), 'Chrome', bevel=0.006, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


def build_nose_kit(cowl):
    """AgNav Titanium lightbar on its stalk, GPS puck, compass box, landing light under the beak."""
    mb = MB('nose_kit')
    st = R(1.935, cowl_top(1.935) - 0.01)
    mb.box(st + V(0, 0, 0.035), (0.025, 0.025, 0.08), 'Alu_Bright', bevel=0.003, segs=1)
    mb.box(st + V(-0.02, 0, 0.075), (0.07, 0.05, 0.02), 'Metal_Frame', bevel=0.004, segs=1)
    bar = st + V(-0.01, 0, 0.105)
    mb.box(bar, (0.07, 0.34, 0.055), 'Lightbar_Green', bevel=0.006, segs=2)
    mb.box(bar + V(-0.036, 0, 0.0), (0.004, 0.30, 0.040), 'Paint_Dark')
    mb.box(bar + V(-0.045, 0, 0.032), (0.03, 0.34, 0.004), 'Lightbar_Green')      # sun visor
    mb.cyl(bar + V(0, 0.17, 0), bar + V(0, 0.19, 0), 0.008, 'Metal_Frame', n=8)
    mb.cyl(bar + V(0, -0.17, 0), bar + V(0, -0.19, 0), 0.008, 'Metal_Frame', n=8)
    gp = R(1.83, cowl_top(1.83) - 0.002)
    mb.cyl(gp, gp + V(0, 0, 0.022), 0.052, 'GPS_Gold', n=24)
    mb.cyl(gp + V(0, 0, 0.022), gp + V(0, 0, 0.026), 0.040, 'GPS_Gold', n=24)
    return mb.finish(sharp_angle=40, wn=True)


def prop_decals(prop):
    """White HELIX lettering and the red double-X logo on the aft face of each blade (Rotax-915.jpg)."""
    font = _font()
    cu = bpy.data.curves.new('hx', 'FONT')
    cu.body = 'HELIX'
    cu.size = 0.062
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    if font:
        cu.font = font
    tob = bpy.data.objects.new('hx_tmp', cu)
    bpy.context.scene.collection.objects.link(tob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
    bpy.data.objects.remove(tob)
    bpy.data.curves.remove(cu)
    bm0 = bmesh.new()
    bm0.from_mesh(me)
    bmesh.ops.triangulate(bm0, faces=bm0.faces[:])
    text = [(v.co.x, v.co.y) for v in bm0.verts], [[v.index for v in f.verts] for f in bm0.faces]
    bm0.free()
    bpy.data.meshes.remove(me)
    mb = MB('prop_decals')
    mt = MB('prop_text')
    inv = prop.matrix_world.inverted()
    c = prop.matrix_world.translation.copy()

    def on_blade(k, r, w):
        a = TAU * k / 3
        y, z = -w * math.cos(a) - r * math.sin(a), r * math.cos(a) - w * math.sin(a)
        p = c + V(-0.4, y, z)
        ok, loc, nrm, _ = prop.ray_cast(inv @ p, V(1, 0, 0), distance=0.8)
        return (prop.matrix_world @ loc) + V(-0.0015, 0, 0) if ok else None
    for k in range(3):
        verts = []
        for tx, ty in text[0]:
            q = on_blade(k, 0.50 * PROP_R + tx, ty * 0.9 - 0.004)
            verts.append(q)
        if all(q is not None for q in verts):
            mt.faces(verts, text[1], 'Decal_White', smooth=False)
        # red double-X logo nearer the root
        for dx in (-0.018, 0.018):
            for sgn in (1, -1):
                a0 = on_blade(k, 0.30 * PROP_R + dx - 0.015, sgn * 0.018)
                a1 = on_blade(k, 0.30 * PROP_R + dx + 0.015, -sgn * 0.018)
                if a0 and a1:
                    mb.tube([a0, a1], 0.0, 'Lens_Red', n=4, square=(0.006, 0.0015, 2), cap=True)
    bm = mt.bm
    bm.normal_update()
    for f in bm.faces:
        if f.normal.x > 0:
            f.normal_flip()
    ot = mt.finish(origin=c, sharp_angle=80, recalc=False)
    ob = mb.finish(origin=c, sharp_angle=80)
    return B.join_objects('prop', [prop, ot, ob])


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


def empty(name, p):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.03
    ob.location = Vector(p)
    B.link(ob) if hasattr(B, 'link') else bpy.context.scene.collection.objects.link(ob)
    return ob


INFO = {}


def build_tractor():
    ensure_mats()
    E.set_paint('Rotor_Blade', '#9A917F', 0.8, 0.38)
    pod, rim = build_pod()
    bh = bulkheads()
    hop = build_hopper()
    hdet = hopper_details(hop)
    letters = lettering(hop, [('GYRO', 0.40, -1.566, 0.19), ('TRACTOR', 0.395, -1.710, 0.19)])
    cowl = build_cowl()
    ws1, fr1 = front_screen()
    mast = build_mast()
    K.build_head(PIVOT, HUB, arm=-0.16, arm_w=0.24, plate_mat='Metal_Frame')
    K.build_rotor(HUB, R=4.115, chord=0.22, root=0.50, tip_mat='Rotor_Blade', clamp_len=0.48, clamp_mat='Alu_Black')
    engine = build_engine(PROP)
    prop = K.build_prop(PROP, R=PROP_R, blades=3, hub='flange', hub_r=0.09, mat='Carbon', tip_mat='Carbon', pitch=1.0)
    prop_decals(prop)
    frame = build_frame()
    tail = build_tail()
    build_rudder()
    gear, nose = build_gear()
    chin = build_chin()
    cockpit = build_cockpit()
    spray, outlets = build_spray() if '--nospray' not in K.ARGV else (None, [])
    recess = recess_and_pump(pod)
    kit = build_nose_kit(cowl)

    ctrl = MB('controls_static')
    stick_base = R(1.34, -2.33)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.36, -1.77))
    knob, lever = controls.throttle_lever(ctrl, R(1.22, -1.98, 0.30))
    pilot.build_pilot('pilot_front', SEAT_HIP, PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.84, -2.17, 0.10), 'R': R(1.84, -2.17, -0.10)}, knee_out=0.03, elbow_out=0.04,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.28))
    p0 = R(1.735, -1.80)
    PANEL.build_panel(ctrl, p0, 14.0, [pod, ws1, cowl], zone=(0.0, 0.030, 0.36, 0.14), cw=0.04, v_leg=-0.050,
                      v_sb=-0.17, v_b=-0.255, top_arch=(0.235, 0.12, 0.22), max_u=0.232, leg_exp=0.25)
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)

    det = MB('details')
    # Helix hub: red anodised drum with its bolt circle and a black centre cap
    det.lathe([(0.0, 0.0), (0.095, 0.0), (0.100, 0.010), (0.100, 0.10), (0.095, 0.11), (0.0, 0.11)],
              PROP + V(0.055, 0, 0), V(-1, 0, 0), 'Prop_Red', n=36)
    det.lathe([(0.0, 0.0), (0.035, 0.0), (0.035, 0.012), (0.0, 0.016)], PROP + V(-0.055, 0, 0), V(-1, 0, 0),
              'Paint_Dark', n=20)
    for k in range(6):
        a = TAU * k / 6 + 0.3
        p = PROP + V(-0.056, math.cos(a) * 0.068, math.sin(a) * 0.068)
        det.cyl(p, p + V(-0.012, 0, 0), 0.009, 'Chrome', n=8)
    # landing light: round lens in the front of the nose-wheel fairing (Foldable-booms.jpg)
    K.lamp(det, R(1.918, -2.345), V(1, 0, -0.25), kind='white', r=0.026, length=0.012)
    K.lamp_node('landing', R(1.955, -2.355))
    # MINIMUM SET, NOT ON THE PHOTOS: no nav light or strobe is visible on any Gyro Tractor photo; the owner
    # wants landing + nav + one anti-collision light on every aircraft, so they go where ELA puts them on the
    # ELA 07: flush side markers at the rear of the pod (tub sides behind the hopper) and a strobe on the mast.
    for sy, kind in ((1, 'red'), (-1, 'green')):
        X, Z = 0.06, -2.02
        p = R(X, Z, sy * pod_y(X, Z))
        K.oval_lamp(det, pod, p, V(0, sy, 0), V(1, 0, 0), kind=kind, a=0.045, b=0.014)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0, sy * 0.03, 0))
    K.lamp(det, R(-0.16, -0.38), V(-1, 0, 0), kind='white', r=0.014, length=0.025)
    K.lamp_node('beacon', R(-0.215, -0.38))
    # ELA oval badge on the beak top
    ring = [(R(2.16 + 0.035 * math.cos(TAU * k / 32), -1.88, 0.075 * math.sin(TAU * k / 32)), V(0.4, 0, 1))
            for k in range(33)]
    q = project(pod, ring, 0.0008)
    if len(q) > 3:
        det.tube(q, 0.003, 'Paint_Dark', n=6)
    # small pitot / antenna under the beak (Foldable-booms.jpg), fuel filler (left, tub rear)
    K.pitot(det, R(2.08, -2.26, -0.08), d=(1, 0, -0.1), length=0.10, r=0.005)
    X, Z = 0.30, -2.00
    p = R(X, Z, pod_y(X, Z))
    det.cyl(p - V(0, 0.004, 0), p + V(0, 0.010, 0), 0.03, 'Alu_Black', n=16)
    # screw rows along the tub ledge under the hopper
    for sy in (1, -1):
        for X in (0.15, 0.35, 0.55, 0.75):
            Z = lerp(-1.850, -1.944, (X - 0.09) / 0.72) - 0.05
            q = project(pod, [(R(X, Z, sy * 0.3), V(0, sy, 0))], 0.0)
            if q:
                det.cyl(q[0] - V(0, sy * 0.001, 0), q[0] + V(0, sy * 0.0025, 0), 0.0045, 'Metal_Frame', n=8)
    K.antenna(det, R(0.82, -2.38), (-0.5, 0, -1), length=0.20)
    det = det.finish(sharp_angle=50)

    # spray outlets and hopper
    for i, p in enumerate(sorted(outlets, key=lambda v: -v.y)):
        empty('spray_%02d' % i, p)
    hop_c = R(0.43, -1.68)
    empty('hopper', hop_c)
    INFO['outlets'] = sorted(outlets, key=lambda v: -v.y)

    S = SEAT_HIP + V(-math.sin(math.radians(PILOT_BACK)), 0, math.cos(math.radians(PILOT_BACK))) * pilot.SPINE
    u = V(-math.sin(math.radians(PILOT_BACK)), 0, math.cos(math.radians(PILOT_BACK)))
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    INFO['eye'] = eye
    clearance(['pilot_front_leg', 'pilot_front_foot'], [bpy.data.objects.get('panel_face'), ctrl, pod, cowl], ' (legs)')
    clearance(['pilot_front'], [pod, cockpit, bh, hop, ws1], ' (body)')
    K.finalize([pod, rim, hop, hdet, cowl, fr1, mast, engine, frame, tail, gear, chin, cockpit, ctrl, det, bh, spray,
                recess, kit] + letters, [ws1])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.70), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z),
    })
    print('TRACTOR hub %s pivot %s prop %s ground z %.3f axle x %.3f nose x %.3f eye %s head %s' % (
        tuple(round(c, 3) for c in HUB), tuple(round(c, 3) for c in PIVOT), tuple(round(c, 3) for c in PROP),
        R.z(GROUND), ax.x, R.x(NOSE[0]), tuple(round(c, 3) for c in eye),
        (round(head.x - R.dx, 3), round(head.z - R.dz, 3))))
    for i, p in enumerate(INFO['outlets']):
        print('  spray_%02d model x %.3f y(up) %.3f z(right) %.3f' % (i, p.x, p.z, -p.y))


# ---------------------------------------------------------------------------
# Perspective render from a solved photo camera (hub-frame pinhole, see the docstring)
# ---------------------------------------------------------------------------
def photocam(scn, cam_json, out, samples=16):
    cam = json.load(open(cam_json))
    P, (W, H) = cam['P'], cam['size']
    cy, sy, cp, sp, cr, sr = (math.cos(P[3]), math.sin(P[3]), math.cos(P[4]), math.sin(P[4]), math.cos(P[5]),
                              math.sin(P[5]))
    fwd = Vector((cp * cy, cp * sy, sp))
    right = fwd.cross(Vector((0, 0, 1.0))).normalized()
    down = fwd.cross(right)
    Rm = Matrix(((cr, -sr, 0), (sr, cr, 0), (0, 0, 1.0))) @ Matrix((right, down, fwd))
    M = Matrix.Identity(4)
    for i in range(3):
        M[i][0], M[i][1], M[i][2] = Rm[0][i], -Rm[1][i], -Rm[2][i]
    M[0][3], M[1][3], M[2][3] = P[0] + R.dx, P[1], P[2] + R.dz
    B.setup_render(scn)
    scn.cycles.samples = samples
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = int(W), int(H)
    cd = bpy.data.cameras.new('PhotoCam')
    co = bpy.data.objects.new('PhotoCam', cd)
    scn.collection.objects.link(co)
    scn.camera = co
    cd.sensor_fit = 'HORIZONTAL'
    cd.sensor_width = 36.0
    cd.lens = P[6] / W * 36.0
    cd.clip_start, cd.clip_end = 0.05, 300.0
    co.matrix_world = M
    sun = bpy.data.lights.new('PSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('PSun', sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(20)), 'XYZ')
    scn.collection.objects.link(so)
    w = bpy.data.worlds.new('PW')
    scn.world = w
    try:
        w.use_nodes = True
        w.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
        w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    except Exception:
        pass
    for ob in scn.objects:
        if ob.name.startswith('ground') or ob.name.startswith('Studio'):
            ob.hide_render = True
        if '--nopilot' in K.ARGV and ob.name.startswith('pilot'):
            ob.hide_render = True
    scn.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print('rendered photocam', out)


if __name__ == '__main__':
    VIEWS = {
        # same angles as the factory photos (for side-by-side checks)
        'cmp_foldable': dict(extra=True, loc=(5.2, -3.6, 0.35), target=(0.9, 0.0, -0.05), lens=30, rotor=-35, prop=10),
        'cmp_rotax': dict(extra=True, loc=(-4.6, -3.0, 0.9), target=(-0.5, 0.0, 0.0), lens=28, rotor=-35, prop=10),
        'cmp_front': dict(extra=True, loc=(11.0, 0.3, -0.75), target=(0.0, 0.0, -0.15), lens=40, rotor=60, prop=0),
        'boom_detail': dict(extra=True, loc=(2.6, -3.4, -0.6), target=(-0.1, -2.2, -0.75), lens=40, rotor=75, prop=10),
        'pilot_eye': dict(extra=True, loc=(0.0, 0.0, 0.0), target=(5.0, 0.0, -0.2), lens=24, rotor=0, prop=0),
        'gear_detail': dict(extra=True, loc=(1.6, -2.8, -0.4), target=(-0.2, -0.5, -0.75), lens=40, rotor=75, prop=10),
    }
    if '--previews' in K.ARGV:
        # pilot view from eye_front, looking ahead (filled in after the build)
        pass
    _orig_render = B.render_previews

    def _render(scn):
        eye = INFO.get('eye')
        if eye is not None and 'pilot_eye' in B.PREVIEW_VIEWS:
            v = B.PREVIEW_VIEWS['pilot_eye']
            v['loc'] = tuple(eye)
            v['target'] = (eye.x + 5.0, eye.y, eye.z - 0.35)
        return _orig_render(scn)
    B.render_previews = _render
    K.run('tractor', build_tractor, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
    pc = K.arg('--photocam')
    if pc:
        i = K.ARGV.index('--photocam')
        photocam(bpy.context.scene, K.ARGV[i + 1], K.ARGV[i + 2])
