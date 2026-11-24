"""
Carter PAV (Carter Aviation Technologies, Olney TX; N210AV = PAV-II, 2014) for the Autogiro web sim:
4-seat slowed-rotor compound. Tall egg-shaped cabin whose whole front (nose, windscreen, side
windows, instrument panel) is one canopy tilting forward; an engine-air scoop overhangs the
windscreen like a visor and runs back into the raised roof that carries the tilting mast (faceted
fairing, streamlined hub, 45 ft two-blade rotor with tip weights); Lycoming IO-540 in the rear
fuselage with a long spinner and a 5-blade scimitar pusher; a slender boom under the propeller to a
plank stabiliser with two big end fins and a centre fin (rudder) in the slipstream; 45 ft low wing
with root fillets, gear blisters on the wing roots, trailing-link main gear, steerable nose wheel.

Traced from six photos by a small bundle adjustment (work/carter/ba.py in the scratchpad: 16 key
points, 6 cameras, rms 2 px): scale from the 13.6 m wing-tip lights (wing span = rotor diameter =
45 ft in the front view). Hub frame as in gyrokit.py (origin on the teeter bolt, mast drawn
vertical). The mast tilts about a lateral pivot 0.20 m under the roof top (PIVOT, rotor_head origin).

SEATING: pilot in the front LEFT seat (+Y Blender, -z sim): pilot_front, stick, throttle, pedals,
eye_front and panel_face belong to it; pilot_rear = the front RIGHT seat occupant. Rear seats empty.

  blender -b -P blender/build_carter.py -- [--previews] [--only VIEW,...] [--samples N] [--show-rear]
                                            [--match CAM --match-out PNG]   (photo-matched overlay)
Outputs: public/models/carterpav.glb, blender/carterpav.blend, blender/previews/carterpav/*.png
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, naca4, pilot, controls, PANEL  # noqa: E402

# ---- hub frame ----------------------------------------------------------------------------------
GROUND = -3.93
# mass build-up for the CG height (1950 kg): engine+prop 300 @ -2.20, rotor 160 @ 0.0, mast+head 40 @ -0.70,
# airframe/gear/systems 1040 @ -2.95, two front occupants 180 @ -2.85, fuel 230 (wing) @ -3.25 -> -2.57
CG = (0.30, -2.57)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -1.37)
PROP = R(-1.68, -2.08)
PROP_R = 1.08
MAIN = (-0.35, 0.95, -3.73)          # main axle (X, half-track, Z), tyre R 0.20
MAIN_RW = 0.20
NOSE = (1.85, -3.76)                 # nose axle, tyre R 0.17
NOSE_RW = 0.17
SEAT_Y = 0.31

LIVERY = dict(body=('#F2F2EE', 0.0, 0.22), accent=('#B71F2A', 0.0, 0.3), dark=('#1E2C6E', 0.0, 0.3),
              seat=('#2A2C30', 0.0, 0.75))
REG = 'N451PV'

# ---- hull (cabin + roof + rear fuselage), traced profile -----------------------------------------
XTIP, ZTIP = 2.46, -3.20
X_END = -1.32
TOP = [(XTIP, ZTIP), (2.44, -3.06), (2.38, -2.89), (2.22, -2.62), (2.05, -2.36), (1.83, -2.12), (1.55, -1.95),
       (1.20, -1.82), (0.95, -1.68), (0.75, -1.44), (0.55, -1.27), (0.20, -1.175), (-0.40, -1.17), (-0.74, -1.18),
       (-1.05, -1.22), (-1.19, -1.27), (-1.27, -1.42), (X_END, -1.62)]
BOT = [(XTIP, ZTIP), (2.44, -3.36), (2.36, -3.48), (2.20, -3.55), (1.90, -3.575), (1.20, -3.575), (0.50, -3.565),
       (-0.10, -3.53), (-0.60, -3.45), (-1.00, -3.36), (X_END, -3.26)]
WID = [(XTIP, 0.0), (2.43, 0.20), (2.36, 0.33), (2.22, 0.45), (2.02, 0.55), (1.75, 0.625), (1.40, 0.675),
       (0.95, 0.70), (0.40, 0.685), (-0.20, 0.64), (-0.70, 0.56), (-1.05, 0.48), (X_END, 0.42)]
BELT = [(XTIP, ZTIP), (2.2, -3.05), (1.6, -2.92), (0.8, -2.85), (0.0, -2.80), (-0.8, -2.72), (X_END, -2.62)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T, F_B, F_W, F_M = _prof(TOP), _prof(BOT), _prof(WID), _prof(BELT)
F_NT = B.hermite([X_END, -0.6, 0.4, 1.2, 2.0, XTIP], [2.6, 2.4, 2.1, 2.0, 2.2, 2.0])
F_NB = B.hermite([X_END, 0.0, 1.5, XTIP], [2.6, 2.9, 2.8, 2.0])


def hull(X):
    u = _u(X)
    zt, zb, w = F_T(u), F_B(u), max(F_W(u), 1e-4)
    h = zt - zb
    zm = min(max(F_M(u), zb + 0.15 * h), zt - 0.3 * h)
    return zt, zb, w, zm, F_NT(X), F_NB(X)


def hull_ring(X, n_half=30, scale=1.0):
    zt, zb, w, zm, nt, nb = hull(X)
    half = []
    m = 40
    for i in range(m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.sin(a) ** (2 / nt), zm + (zt - zm) * math.cos(a) ** (2 / nt)))
    for i in range(1, m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.cos(a) ** (2 / nb), zm - (zm - zb) * math.sin(a) ** (2 / nb)))
    h = E.resample2d(half, n_half)
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


def build_hull():
    xs = [XTIP - (0.02 * k) ** 2 for k in range(1, 30)]
    x = xs[-1]
    while x > X_END + 0.04:
        x -= 0.05
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    rings.append(hull_ring(X_END - 0.015, scale=0.9))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    return mb.finish(sharp_angle=60)


# ---- glazing, stripes, seams (side view, hub frame) ----
# The windscreen WRAPS ROUND THE NOSE (in-flight photos pav_N110AV_front_air_aopa2015, abpic_N210AV_1464231,
# pav_front_taxi): in side view the glazed band therefore runs forward past the hull's own profile, between
# its top edge and the sill line. The first trace closed the polygon at X 1.9, which left the centre strip
# of the nose opaque: from the pilot's eye the whole view ahead was the black inside of the hull.
GLASS = [(1.00, -1.60), (1.48, -1.80), (1.74, -2.02), (2.05, -2.25), (2.30, -2.55), (2.60, -2.70), (2.60, -2.80),
         (2.31, -2.79), (2.10, -2.79), (1.88, -2.76), (1.57, -2.62), (1.24, -2.45), (0.96, -2.25)]
SEAM = [(0.66, -1.40), (0.69, -1.73), (0.66, -2.40), (0.60, -3.05), (0.64, -3.30), (0.75, -3.40), (1.2, -3.42),
        (1.8, -3.42), (2.25, -3.40), (2.42, -3.33)]


def band(pts, hw):
    """Side-view polygon of a stripe of half width hw along a polyline (hub frame) -> model."""
    left, right = [], []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        d = Vector((b[0] - a[0], b[1] - a[1])).normalized()
        n = Vector((-d.y, d.x))
        left.append((p[0] + n.x * hw, p[1] + n.y * hw))
        right.append((p[0] - n.x * hw, p[1] - n.y * hw))
    return R.pts(left + right[::-1])


RED = [(-1.62, -2.205), (0.30, -2.205), (0.62, -2.22), (0.86, -2.30), (1.03, -2.46), (1.14, -2.66), (1.21, -2.88),
       (1.25, -3.12), (1.27, -3.45)]
BLUE = [(-1.62, -2.305), (0.30, -2.305), (0.57, -2.325), (0.78, -2.40), (0.94, -2.54), (1.04, -2.72), (1.10, -2.92),
        (1.14, -3.15), (1.16, -3.45)]


def paint_stripes(ob, side_test=None):
    K.paint_poly(ob, band(RED, 0.038), 'Paint_Accent', side_test)
    K.paint_poly(ob, band(BLUE, 0.038), 'Paint_Dark', side_test)


def cast_side(target, x, z, sy):
    ok, loc, nrm, _ = target.ray_cast(V(x, sy * 2.0, z), V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def side_line(mb, target, pts, sy, r=0.004, mat='Decal_Black', lift=0.001, step=0.02, closed=False):
    pts = [R(X, Z) for X, Z in pts]
    if closed:
        pts = B.resample_loop(pts, step)
    else:
        out = []
        for a, b in zip(pts, pts[1:]):
            n = max(1, int((b - a).length / step))
            out += [a.lerp(b, k / n) for k in range(n)]
        pts = out + [pts[-1]]
    out = []
    for p in pts:
        loc, nrm = cast_side(target, p.x, p.z, sy)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 3:
        if closed:
            B.closed_tube(mb, out, r, mat, n=6)
        else:
            mb.tube(out, r, mat, n=6)


def thicken(ob, n_outer, thickness=0.012):
    """E.thicken_shell without even offset (even offset explodes on the slivers left by the paint cuts)."""
    me = ob.data
    me.materials.append(MATS['Interior'])
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = thickness
    sol.offset = -1.0
    sol.use_even_offset = False
    sol.material_offset = n_outer
    sol.material_offset_rim = n_outer
    K.apply_mods(ob)
    for p in ob.data.polygons:
        if p.material_index > n_outer:
            p.material_index = n_outer


def split_canopy(pod):
    poly = R.pts(GLASS)
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    K.bisect_poly(bm, poly)
    bm.to_mesh(pod.data)
    bm.free()
    E_th = E.thicken_shell
    E.thicken_shell = thicken
    try:
        return K.split_glass(pod, lambda c: PANEL.inside(poly, c.x, c.z), frame_r=0.009, frame_mat='Paint_White',
                             seal=True, thickness=0.014, name='canopy')
    finally:
        E.thicken_shell = E_th


# ---- engine-air scoop overhanging the windscreen ('visor') ----
SC_TOP = [(1.62, -1.62), (1.40, -1.51), (1.08, -1.38), (0.80, -1.29), (0.45, -1.205), (0.20, -1.18)]
SC_BOT = [(1.62, -1.62), (1.50, -1.94), (1.30, -1.92), (1.00, -1.84), (0.70, -1.62), (0.45, -1.42), (0.20, -1.30)]


def build_scoop():
    ft = B.hermite([p[0] for p in SC_TOP], [p[1] for p in SC_TOP])
    fb = B.hermite([p[0] for p in SC_BOT], [p[1] for p in SC_BOT])
    # Half width: the mouth is an oval about 0.37 m wide (1.4 helmet widths in abpic_N210AV_1464231 and
    # pav_N110AV_front_air_aopa2015), and the duct widens only where it runs into the mast base. The first
    # version was a letterbox 0.8-0.9 m wide; the owner: "no tiene una toma de aire tan grande arriba".
    fw = B.hermite([1.62, 1.55, 1.2, 0.7, 0.2], [0.150, 0.185, 0.20, 0.25, 0.34])
    mb = MB('scoop')

    def oval(x_top, x_bot, zt, zb, w, k=1.0, back=0.0):
        """Ring of the duct: an oval between zb and zt, slanted (top at x_top, bottom at x_bot)."""
        zc, hh = 0.5 * (zt + zb), 0.5 * (zt - zb)
        ring = []
        for j in range(32):
            a = TAU * j / 32
            s_, c_ = K.B.sgnpow(math.sin(a), 0.80), K.B.sgnpow(math.cos(a), 0.75)
            ring.append(R(lerp(x_bot, x_top, 0.5 * (s_ + 1.0)) - back, zc + s_ * hh * k, c_ * w * k))
        return ring

    # The duct is an open tube: its mouth is the slanted oval between the top lip (1.62, -1.62) and the
    # bottom lip 11 cm further back (abpic_N210AV_1668060: the mouth plane leans about 18 deg, top forward).
    # The slant fades out over the first 0.3 m; behind that the sections are upright as before.
    rings = []
    for d in (0.0, 0.03, 0.07, 0.12, 0.20, 0.30):
        f = max(0.0, 1.0 - d / 0.30)
        xt = 1.62 - d
        xb = xt - 0.11 * f
        zt = ft(xt)
        zb = min(max(fb(min(xb, 1.50)), -1.94), zt - 0.04)
        rings.append(oval(xt, xb, zt, zb, fw(0.5 * (xt + xb))))
    X = 1.32 - 0.07
    while X > 0.19:
        zt = ft(X)
        rings.append(oval(X, X, zt, min(fb(X), zt - 0.04), fw(X)))
        X -= 0.07
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    # rounded lip turning inwards, then a dark throat: in the photos the mouth is a black hole
    zt0, zb0, w0 = ft(1.62), -1.94, fw(1.565)
    lip_in = oval(1.62, 1.51, zt0, zb0, w0, k=0.86, back=0.035)
    throat = oval(1.62, 1.51, zt0, zb0, w0, k=0.80, back=0.24)
    mb.loft([rings[0], lip_in], 'Paint_White', closed=True)
    mb.loft([lip_in, throat, [R(1.20, 0.5 * (zt0 + zb0))]], 'Decal_Black', closed=True)
    return mb.finish(sharp_angle=55)


# ---- engine nacelle (cowl behind the roof, ring gap to the spinner) ----
NAC_Z = -2.12


def build_nacelle():
    mb = MB('nacelle')
    prof = [(0.0, -0.25), (0.30, -0.25), (0.345, 0.0), (0.345, 0.20), (0.338, 0.40), (0.332, 0.47), (0.31, 0.48),
            (0.20, 0.48), (0.0, 0.48)]
    mb.lathe(prof, R(-1.02, NAC_Z), V(-1, 0, 0), 'Paint_White', n=40)
    nac = mb.finish(sharp_angle=50)
    paint_stripes(nac)
    return nac


# ---- boom ----
BOOM = [(-0.90, -3.20, 0.13, 0.15), (-1.40, -3.175, 0.12, 0.14), (-2.00, -3.13, 0.11, 0.13), (-2.60, -3.06, 0.10, 0.12),
        (-3.00, -2.99, 0.095, 0.115), (-3.35, -2.92, 0.085, 0.11), (-3.62, -2.86, 0.07, 0.09), (-3.75, -2.84, 0.03, 0.04)]


def build_boom():
    mb = MB('boom')
    rings = []
    for X, Z, hw, hh in BOOM:
        rings.append([R(X, Z + K.B.sgnpow(math.sin(TAU * k / 24), 0.8) * hh, K.B.sgnpow(math.cos(TAU * k / 24), 0.7) * hw)
                      for k in range(24)])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # tail wheel (bumper) under the boom
    c = R(-3.24, -3.11)
    mb.lathe(B.tire_profile(0.06, 0.035, 0.04), c, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    for sy in (1, -1):
        mb.box(c + V(0.03, sy * 0.03, 0.06), (0.10, 0.008, 0.12), 'Metal_Frame', bevel=0.003, segs=1)
    mb.cyl(c + V(0, -0.04, 0), c + V(0, 0.04, 0), 0.008, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=50)


# ---- tail ----
STAB_Z = -2.33
FIN_Y = 2.19
EF_TOP, EF_BOT = -1.72, -2.78
CF_TOP, CF_BOT = -1.55, -2.96
TE_X = -3.65
HINGE = -3.34


def ef_le(z):
    t = (z - R.dz - EF_BOT) / (EF_TOP - EF_BOT)
    return R.x(lerp(-2.55, -3.00, t) - 0.10 * max(0.0, (t - 0.86) / 0.14) ** 2 - 0.10 * max(0.0, (0.14 - t) / 0.14) ** 2)


def ef_te(z):
    t = (z - R.dz - EF_BOT) / (EF_TOP - EF_BOT)
    return R.x(TE_X + 0.07 * max(0.0, (t - 0.88) / 0.12) ** 2 + 0.09 * max(0.0, (0.12 - t) / 0.12) ** 2)


def cf_le(z):
    Z = z - R.dz
    t = (Z - CF_BOT) / (CF_TOP - CF_BOT)
    x = lerp(-2.05, -2.88, t ** 0.8)
    return R.x(x - 0.10 * max(0.0, (t - 0.88) / 0.12) ** 2)


def cf_te(z):
    t = (z - R.dz - CF_BOT) / (CF_TOP - CF_BOT)
    return R.x(TE_X + 0.10 * max(0.0, (t - 0.9) / 0.1) ** 2)


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.10, te_min=0.002)
    rings = []
    for y in [-FIN_Y, -1.9, -1.4, -0.9, -0.4, 0.0, 0.4, 0.9, 1.4, 1.9, FIN_Y]:
        le, te = -3.02, -3.62
        ch = le - te
        rings.append([R(le - s * ch, STAB_Z + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # elevator hinge seam
    for sy in (1, -1):
        mb.cyl(R(-3.44, STAB_Z + 0.032, sy * 0.15), R(-3.44, STAB_Z + 0.032, sy * (FIN_Y - 0.07)), 0.004, 'Decal_Black', n=6)
    zs = [lerp(EF_BOT, EF_TOP, t) for t in (0.0, 0.02, 0.06, 0.14, 0.3, 0.5, 0.7, 0.86, 0.94, 0.98, 1.0)]
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], ef_le, ef_te, y_fn=lambda z, sy=sy: sy * FIN_Y, t=0.14)
        # rudder seam on the end fin (static rudders)
        for zz in (EF_BOT + 0.10, EF_TOP - 0.08):
            pass
        side = sy * (FIN_Y + 0.045)
        mb.cyl(R(-3.40, EF_BOT + 0.12, side), R(-3.40, EF_TOP - 0.10, side), 0.004, 'Decal_Black', n=6)
    zs = [CF_BOT, CF_BOT + 0.05, -2.80, -2.6, -2.35, -2.1, -1.85, -1.70, -1.62, -1.58, CF_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], cf_le, cf_te, t=0.12,
               s_end_fn=lambda z: (cf_le(z) - R.x(HINGE)) / (cf_le(z) - cf_te(z)))
    tail = mb.finish(sharp_angle=45)
    # centre fin stripes (red over blue near the top)
    K.paint_poly(tail, R.pts([(-4.0, -1.70), (-2.5, -1.70), (-2.5, -1.745), (-4.0, -1.745)]), 'Paint_Accent',
                 lambda c: abs(c.y) < 0.2)
    K.paint_poly(tail, R.pts([(-4.0, -1.785), (-2.5, -1.785), (-2.5, -1.84), (-4.0, -1.84)]), 'Paint_Dark',
                 lambda c: abs(c.y) < 0.2)
    return tail


def build_rudder():
    zs = [CF_BOT + 0.10, -2.80, -2.6, -2.35, -2.1, -1.85, -1.70, -1.62, -1.58, CF_TOP - 0.004]
    origin = R(HINGE, -2.25)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], cf_le, cf_te, R.x(HINGE), origin, t=0.12,
                                 mat='Paint_White')
    K.paint_poly(rud, [(x - origin.x, z - origin.z) for x, z in R.pts([(-4.0, -1.70), (-2.5, -1.70), (-2.5, -1.745),
                                                                        (-4.0, -1.745)])], 'Paint_Accent')
    K.paint_poly(rud, [(x - origin.x, z - origin.z) for x, z in R.pts([(-4.0, -1.785), (-2.5, -1.785), (-2.5, -1.84),
                                                                        (-4.0, -1.84)])], 'Paint_Dark')
    return rud


def fin_logo(mb):
    """Carter logo (dark ring + swept 'gyro' mark) on the outer face of each end fin."""
    for sy in (1, -1):
        c = R(-3.32, -2.06, sy * (FIN_Y + 0.048))
        ring = [c + V(math.cos(TAU * k / 40) * 0.13, 0, math.sin(TAU * k / 40) * 0.16) for k in range(40)]
        B.closed_tube(mb, ring, 0.009, 'Paint_Dark', n=6)
        mb.box(c, (0.03, 0.006, 0.20), 'Paint_Dark', rot=Euler((0, math.radians(25), 0)))
        mb.box(c + V(0.02, 0, -0.02), (0.14, 0.006, 0.025), 'Paint_Dark', rot=Euler((0, math.radians(-15), 0)))


# ---- wing ----
W_DIH = math.radians(7.0)
W_INC = 2.0
WY0, WY_TIP = 0.55, 6.86
LE_F = B.hermite([0.55, 0.75, 1.0, 1.3, 1.7, 3.5, 6.86], [0.60, 0.18, -0.16, -0.37, -0.50, -0.65, -0.86])
TE_F = B.hermite([0.55, 1.2, 1.7, 6.86], [-1.95, -1.90, -1.86, -1.46])
AIL = (3.30, 6.55)


def wing_z(y):
    return -3.40 + (abs(y) - WY0) * math.tan(W_DIH)


def wing_section(y, s0=0.0, s1=1.0, n=16):
    """Airfoil section at |y| (sign kept in y); points (model) between chord stations s0..s1."""
    ay = abs(y)
    le, te = LE_F(ay), TE_F(ay)
    c = le - te
    tc = lerp(0.15, 0.12, min(1.0, (ay - 1.7) / 5.0)) if ay > 1.7 else lerp(0.11, 0.15, (ay - WY0) / 1.15)
    inc = math.radians(W_INC)
    z0 = wing_z(y)
    pts = []
    if s0 == 0.0 and s1 == 1.0:
        loop = airfoil_ring(n, tc, m=0.02, te_min=0.002)
    else:
        loop = []
        up, lo = [], []
        for i in range(n + 1):
            s = lerp(s0, s1, (i / n) ** (1.0 if s0 > 0 else 1.6))
            yc, yt = naca4(s, tc, 0.02)
            yt = max(yt, 0.002)
            up.append((s, yc + yt))
            lo.append((s, yc - yt))
        loop = up[::-1] + lo[1:]
    for s, tz in loop:
        pts.append(R(le - s * c, z0 + tz * c - s * c * math.sin(inc), y))
    return pts


def build_wing():
    mb = MB('wing')
    for sy in (1, -1):
        ys_in = [WY0, 0.62, 0.70, 0.80, 0.92, 1.05, 1.2, 1.4, 1.7, 2.2, 2.8, AIL[0]]
        mb.loft([wing_section(sy * y) for y in ys_in], 'Paint_White', closed=True, cap0=True)
        ys_out = [AIL[0], 4.2, 5.0, 5.8, AIL[1]]
        # fixed part ahead of the aileron (closed with a flat spar face) and the aileron itself
        mb.loft([wing_section(sy * y, 0.0, 0.74) for y in ys_out], 'Paint_White', closed=True, cap0=True, cap1=True)
        mb.loft([wing_section(sy * (y if y not in AIL else y + (0.012 if y == AIL[0] else -0.012)), 0.755, 1.0, n=8)
                 for y in ys_out], 'Paint_White', closed=True, cap0=True, cap1=True)
        ys_tip = [AIL[1], 6.70, 6.80]
        rings = [wing_section(sy * y) for y in ys_tip]
        # rounded tip: shrink the last section toward its mean chord line
        last = wing_section(sy * 6.84)
        cen = sum(last, Vector()) / len(last)
        rings.append([cen + Vector(((p - cen).x * 0.96, (p - cen).y * 0.2, (p - cen).z * 0.25)) for p in last])
        mb.loft(rings, 'Paint_White', closed=True, cap1=True)
        # wing-tip light pod: slim fairing ending in a clear oval cover at the front of the tip, with the
        # nav light and the strobe side by side behind it (rb_N210AV_1.jpg right tip, abpic 1668060 left tip)
        tip = R(LE_F(6.82) - 0.02, wing_z(6.82), sy * 6.82)
        kind = 'red' if sy > 0 else 'green'
        mb.lathe([(0.0, -0.20), (0.03, -0.18), (0.042, -0.05), (0.042, 0.02), (0.0, 0.02)], tip, V(1, 0, 0),
                 'Paint_White', n=14)
        K.lamp(mb, tip + V(0.02, -sy * 0.014, 0), V(1, 0, 0), kind=kind, r=0.016, length=0.03, base='Chrome')
        K.lamp(mb, tip + V(0.02, sy * 0.018, 0), V(1, 0, 0), kind='white', r=0.012, length=0.024, base='Chrome')
        mb.lathe([(0.042, 0.02), (0.041, 0.06), (0.03, 0.10), (0.0, 0.12)], tip, V(1, 0, 0), 'Glass', n=14)
        # black anti-slip walkway at the root
        p0 = R(-0.6, wing_z(0.9) + 0.105, sy * 0.95)
        mb.box(p0, (0.75, 0.28, 0.004), 'Rubber', bevel=0.0, rot=Euler((sy * W_DIH, 0, 0)))
        # aileron hinge brackets underneath
        for y in (4.0, 5.6):
            xh = LE_F(y) - 0.745 * (LE_F(y) - TE_F(y))
            mb.box(R(xh, wing_z(y) - 0.03, sy * y), (0.08, 0.012, 0.03), 'Metal_Frame', bevel=0.003, segs=1)
    # pitot boom under the right wing (rb_N210AV_3)
    K.pitot(mb, R(-0.55, wing_z(2.7) - 0.10, -2.7), (1, 0, 0), length=0.85, r=0.008)
    mb.box(R(-0.45, wing_z(2.7) - 0.05, -2.7), (0.10, 0.012, 0.08), 'Paint_White', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=40)


def build_blisters():
    """Gear blisters on the wing roots (trailing-link pivot and shock strut inside)."""
    mb = MB('blisters')
    for sy in (1, -1):
        yc = sy * 0.86
        rings = []
        xs = [0.12, 0.10, 0.05, -0.05, -0.2, -0.4, -0.6, -0.8, -1.0, -1.15, -1.25]
        for X in xs:
            u = (0.12 - X) / 1.37
            f = math.sin(math.pi * min(1.0, u * 2.2)) ** 0.5 if u < 0.227 else (1 - (u - 0.227) / 0.773) ** 0.8
            f = max(f, 0.03)
            zb = wing_z(0.86) - 0.08
            hz = 0.30 * f
            hw = 0.16 * f + 0.01
            rings.append([R(X, zb + 0.06 + max(0.0, math.sin(TAU * k / 24)) * hz - max(0.0, -math.sin(TAU * k / 24)) * 0.08,
                            yc + math.cos(TAU * k / 24) * hw) for k in range(24)])
        rings.append([R(-1.27, wing_z(0.86) - 0.02, yc)])
        mb.loft([[R(0.14, wing_z(0.86) + 0.02, yc)]] + rings, 'Paint_White', closed=True)
    return mb.finish(sharp_angle=60)


# ---- landing gear ----
def build_gear():
    mb = MB('main_gear')
    ax_x, ty, ax_z = MAIN
    for sy in (1, -1):
        piv = R(0.02, -3.47, sy * (ty - 0.10))
        ax = R(ax_x, ax_z, sy * (ty - 0.10))
        # trailing arm (pivot ahead, axle aft), shock strut from the blister to the arm
        mb.tube([piv, piv.lerp(ax, 0.5) + V(0, 0, -0.02), ax], 0.0, 'Metal_Frame', n=12, square=(0.07, 0.04, 4))
        mb.cyl(piv + V(0, -0.05, 0), piv + V(0, 0.05, 0), 0.03, 'Metal_Frame', n=12)
        top = R(-0.30, -3.30, sy * (ty - 0.10))
        mid = piv.lerp(ax, 0.62) + V(0, 0, 0.03)
        mb.cyl(top, top.lerp(mid, 0.55), 0.032, 'Alu_Black', n=14)
        mb.cyl(top.lerp(mid, 0.5), mid, 0.018, 'Chrome', n=10)
        mb.box(R(0.02, -3.43, sy * (ty - 0.10)), (0.16, 0.10, 0.08), 'Metal_Frame', bevel=0.01, segs=2)
        # axle, brake disc, calliper
        c = R(ax_x, ax_z, sy * ty)
        mb.cyl(c - V(0, sy * 0.13, 0), c + V(0, sy * 0.04, 0), 0.02, 'Metal_Frame', n=12)
        mb.cyl(c - V(0, sy * 0.090, 0), c - V(0, sy * 0.082, 0), 0.10, 'Metal_Frame', n=24)
        mb.box(c - V(-0.085, sy * 0.086, -0.04), (0.05, 0.035, 0.06), 'Engine_Dark', bevel=0.008, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    for nm, sy in (('wheel_L', 1), ('wheel_R', -1)):
        K.wheel(nm, R(ax_x, ax_z, sy * ty), R=MAIN_RW, w=0.15)
    nose = K.nose_gear(R(NOSE[0], NOSE[1]), R=NOSE_RW, w=0.12, leg_top=R.z(-3.50), rake=-0.07,
                       mudguard='Paint_White')
    return gear, nose


# ---- mast + hub fairing (rotor_head node: everything above the pivot tilts) ----
def build_mast():
    mb = MB('rotor_head')
    zs = [-1.42, -1.20, -1.10, -0.90, -0.60, -0.35, -0.20, -0.13]
    rings = []
    for Z in zs:
        t = (Z + 1.17) / (1.17 - 0.13)
        le = lerp(0.33, 0.255, max(0.0, t))
        te = lerp(-0.33, -0.275, max(0.0, t))
        th = lerp(0.115, 0.095, max(0.0, t))
        if Z < -1.17:
            le, te, th = 0.36, -0.36, 0.13
        c = le - te
        # faceted section: blunt nose, flat sides, tapered tail
        sec = [(0.0, 0.0), (0.04, 0.55), (0.14, 0.92), (0.30, 1.0), (0.62, 0.95), (0.88, 0.55), (1.0, 0.12)]
        ring = [R(le - s * c, Z, w * th) for s, w in sec] + [R(le - s * c, Z, -w * th) for s, w in reversed(sec[1:])]
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True, smooth=False)
    # row of screws down the leading edge (cw_rotor_overall), spindle housing on top
    for k in range(9):
        Z = lerp(-1.10, -0.20, k / 8)
        t = (Z + 1.17) / 1.04
        x = lerp(0.33, 0.255, t) - 0.03
        for sy in (1, -1):
            mb.cyl(R(x, Z, sy * 0.05), R(x, Z, sy * 0.062), 0.006, 'Metal_Frame', n=6)
    mb.lathe([(0.0, -0.14), (0.13, -0.14), (0.12, -0.10), (0.09, -0.075), (0.0, -0.075)], HUB, V(0, 0, 1), 'Paint_Dark',
             n=28)
    # pivot trunnion inside the roof (the beacon is on the fuselage top behind the mast, build_details)
    mb.cyl(PIVOT + V(0, -0.14, 0), PIVOT + V(0, 0.14, 0), 0.035, 'Metal_Frame', n=12)
    return mb.finish(origin=PIVOT, sharp_angle=35)


def build_rotor():
    if 'Tip_Red' not in MATS:
        B.make_mat('Tip_Red', B.srgb('#C2321E'), rough=0.35)
    rot = K.build_rotor(HUB, R=6.86, chord=0.44, root=0.50, taper=0.68, tc=0.13, pitch_deg=1.0, precone_deg=0.5,
                        mat='Paint_White', tip_mat='Tip_Red', tip_len=0.55, under=0.03, clamp_len=0.30,
                        clamp_mat='Paint_White', tower_h=0.06, bar_w=0.12)
    # Only ONE blade has the red tip (pav_front3q_air_N110AV_aopa, pav_N110AV_air_cw500): repaint the other.
    me = rot.data
    names = [m.name if m else '' for m in me.materials]
    if 'Tip_Red' in names and 'Paint_White' in names:
        i_red, i_white = names.index('Tip_Red'), names.index('Paint_White')
        for f in me.polygons:
            if f.material_index == i_red and f.center.x < HUB.x:
                f.material_index = i_white
    # streamlined hub fairing with the blade-root fairings (lens over the flex beam)
    mb = MB('hubfair')
    prof = [(0.0, 0.10), (0.22, 0.085), (0.40, 0.05), (0.50, 0.012), (0.50, -0.012), (0.40, -0.05), (0.22, -0.07),
            (0.10, -0.075), (0.0, -0.075)]
    mb.lathe(prof, HUB + V(0, 0, -0.01), V(0, 0, 1), 'Paint_White', n=40)
    for b in (1, -1):
        rings = []
        for r, hw, hh in ((0.30, 0.30, 0.06), (0.55, 0.26, 0.05), (0.85, 0.24, 0.04), (1.05, 0.23, 0.035)):
            rings.append([HUB + V(b * r, b * (0.05 + K.B.sgnpow(math.cos(TAU * k / 20), 0.6) * hw * 0.6),
                                  -0.025 + K.B.sgnpow(math.sin(TAU * k / 20), 0.7) * hh) for k in range(20)])
        mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    # Tip weights: 34 kg of steel in a LEADING-EDGE EXTENSION at each tip (cw_rotor_overall_500 from below):
    # a flat horn swept forward of the leading edge over the last 0.3 m, about one chord long, its point at
    # the tip and a concave fillet inboard. (The first version was a 0.7 m torpedo across the tip.)
    Rr, c_tip, drop = 6.86, 0.44 * 0.68, 0.03
    y_le = 0.25 * c_tip
    fillet = [(0.0, 0.34), (0.035, 0.24), (0.13, 0.14), (0.26, 0.06), (0.335, 0.022)]   # (y ahead of LE, R - r)
    f_in = B.hermite([q[0] for q in fillet], [q[1] for q in fillet])
    cone = Matrix.Rotation(math.radians(-0.5), 3, 'Y')
    for b, az, mat in ((1, 0.0, 'Tip_Red'), (-1, math.pi, 'Paint_White')):
        spin = Matrix.Rotation(az, 3, 'Z')
        rings = []
        ys = [-0.04, 0.0, 0.035, 0.08, 0.13, 0.19, 0.26, 0.31, 0.335]
        for dy in ys:
            r_in = Rr - f_in(max(dy, 0.0)) - (0.03 if dy < 0 else 0.0)
            r_out = Rr + 0.004
            mid, a = 0.5 * (r_in + r_out), 0.5 * (r_out - r_in)
            th = lerp(0.050, 0.022, max(dy, 0.0) / 0.335)
            ring = []
            for k in range(14):
                t = TAU * k / 14
                ring.append(HUB + spin @ (cone @ Vector((mid + a * math.cos(t), y_le + dy,
                                                         0.5 * th * math.sin(t) - drop))))
            rings.append(ring)
        rings.append([HUB + spin @ (cone @ Vector((Rr - 0.008, y_le + 0.35, -drop)))])
        mb.loft(rings, mat, closed=True, cap0=True)
    fair = mb.finish(origin=HUB, sharp_angle=50)
    return B.join_objects('rotor', [rot, fair])


def build_prop():
    if 'Prop_Grey' not in MATS:
        B.make_mat('Prop_Grey', B.srgb('#A9ADB2'), rough=0.35)
    pr = K.build_prop(PROP, R=PROP_R, blades=5, hub='flange', hub_r=0.10, chord_k=1.25, pitch=1.6,
                      mat='Prop_Grey', tip_mat='Prop_Grey', scimitar=0.16)
    mb = MB('spinner')
    prof = [(0.0, 0.20), (0.30, 0.20)]
    for k in range(1, 15):
        u = k / 14
        prof.append((0.30 * max(0.0, 1 - u ** 1.6) ** 0.62 if k < 14 else 0.0, 0.20 - 0.78 * u))
    mb.lathe([(r, -a) for r, a in prof], PROP, V(-1, 0, 0), 'Paint_White', n=40)
    sp = mb.finish(origin=PROP, sharp_angle=60)
    return B.join_objects('prop', [pr, sp])


# ---- cockpit ----
FRONT_HIP_X, FRONT_HIP_Z = 1.06, -3.14
REAR_HIP_X, REAR_HIP_Z = 0.12, -2.88
BACK = 14.0


def seat(mb, hip, back_deg, width=0.46, cushion_len=0.44, headrest=True):
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    rc = Euler((0, math.radians(-6), 0))
    c = V(hip.x + cushion_len * 0.5 - 0.10, hip.y, hip.z - 0.125)
    mb.box(c, (cushion_len, width, 0.08), 'Seat', bevel=0.03, segs=3, rot=rc)
    mb.box(c - V(0, 0, 0.10), (cushion_len - 0.04, width - 0.06, 0.12), 'Interior', bevel=0.02, segs=1)
    back_c = hip - f * 0.175 + u * 0.33
    mb.box(back_c, (0.08, width, 0.66), 'Seat', bevel=0.03, segs=3, rot=rb)
    mb.box(back_c - f * 0.05, (0.03, width - 0.02, 0.64), 'Carbon', bevel=0.012, segs=2, rot=rb)
    for sy in (1, -1):
        mb.box(back_c + f * 0.03 + V(0, sy * (width * 0.5 - 0.03), -0.05), (0.12, 0.05, 0.46), 'Seat', bevel=0.02,
               segs=2, rot=rb)
    if headrest:
        hc = hip - f * 0.175 + u * 0.80
        mb.box(hc, (0.08, 0.26, 0.18), 'Seat', bevel=0.03, segs=3, rot=rb)


def build_cockpit():
    mb = MB('cockpit')
    for sy in (1, -1):
        seat(mb, R(FRONT_HIP_X, FRONT_HIP_Z, sy * SEAT_Y), BACK)
        seat(mb, R(REAR_HIP_X, REAR_HIP_Z, sy * 0.30), 16.0, width=0.44)
    # floor, raised rear-seat step, centre console between the front seats
    xs = [0.30 + k * 0.1 for k in range(19)]
    top = [R(X, -3.45, hull_y(X, -3.45) - 0.03) for X in xs]
    mb.loft([[R(X, -3.45, hull_y(X, -3.45) - 0.03), R(X, -3.45, -hull_y(X, -3.45) + 0.03),
              R(X, -3.47, -hull_y(X, -3.47) + 0.03), R(X, -3.47, hull_y(X, -3.47) - 0.03)] for X in xs], 'Interior',
            closed=True, cap0=True, cap1=True, smooth=False)
    mb.box(R(0.30, -3.24), (0.70, 1.05, 0.42), 'Interior', bevel=0.03, segs=2)
    mb.box(R(1.05, -3.30), (0.70, 0.14, 0.26), 'Panel', bevel=0.02, segs=2)
    return mb.finish(sharp_angle=40, wn=True)


BEACON_X = -0.41                     # red beacon behind the mast foot (hub frame X)


def build_details(pod):
    det = MB('details')
    for sy in (1, -1):
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: canopy seam and inspection-panel outlines removed)
        # canopy latch handle and hinge fairing low at the nose
        loc, nrm = cast_side(pod, R.x(0.72), R.z(-2.95), sy)
        if loc is not None:
            det.box(loc + nrm * 0.006, (0.03, 0.02, 0.12), 'Chrome', bevel=0.006, segs=2)
        # Carter logo on the canopy flank (red ring)
        loc, nrm = cast_side(pod, R.x(1.93), R.z(-3.05), sy)
        if loc is not None:
            ring = []
            for k in range(28):
                a = TAU * k / 28
                q = Vector((R.x(1.93) + math.cos(a) * 0.075, 0, R.z(-3.05) + math.sin(a) * 0.075))
                l2, n2 = cast_side(pod, q.x, q.z, sy)
                if l2 is not None:
                    ring.append(l2 + n2 * 0.002)
            if len(ring) > 8:
                B.closed_tube(det, ring, 0.006, 'Paint_Accent', n=6)
        # exhaust stubs under the rear fuselage
        K.exhaust_stub(det, [R(-0.95, -3.26, sy * 0.26), R(-1.15, -3.34, sy * 0.28), R(-1.35, -3.38, sy * 0.28)], r=0.032)
    K.antenna(det, R(-0.85, -1.19), (-0.55, 0, 1), length=0.55)
    K.antenna(det, R(0.3, -3.55), (-0.25, 0, -1), length=0.22)
    # small red beacon on the top of the fuselage just behind the foot of the mast fairing (rb_N210AV_3.jpg);
    # no light on the fins (abpic 1668060, rb_N210AV_3)
    ok, loc, nrm, _ = pod.ray_cast(R(BEACON_X, -0.5), V(0, 0, -1))
    if ok:
        K.lamp(det, loc - V(0, 0, 0.004), V(0, 0, 1), kind='red', r=0.026, length=0.035)
    fin_logo(det)
    return det.finish(sharp_angle=50)


def build_carter():
    pod = build_hull()
    paint_stripes(pod)
    K.paint_poly(pod, band([(0.80, -3.47), (2.0, -3.47)], 0.06), 'Paint_Dark')     # sill band under the canopy
    det = build_details(pod)
    regs = E.build_registration(pod, REG, cx=R.x(-0.27), cz=R.z(-2.76), size=0.36, mat='Paint_Dark')
    exp = E.build_registration(pod, 'EXPERIMENTAL', cx=R.x(0.05), cz=R.z(-2.43), size=0.055, mat='Decal_Black')
    canopy, cframe, cseal = split_canopy(pod)
    scoop = build_scoop()
    nac = build_nacelle()
    boom = build_boom()
    tail = build_tail()
    build_rudder()
    wing = build_wing()
    bl = build_blisters()
    gear, nose = build_gear()
    build_mast()
    build_rotor()
    build_prop()
    cockpit = build_cockpit()

    # ---- crew and controls (pilot: front LEFT seat, +Y)
    ctrl = MB('controls_static')
    yp = SEAT_Y
    hipF = R(FRONT_HIP_X, FRONT_HIP_Z, yp)
    stick_base = R(1.47, -3.45, yp)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.40, -2.93, yp))
    controls.gyro_stick(R(1.47, -3.45, -yp), R(1.40, -2.93, -yp), name='stick_right')
    knob, lever = controls.throttle_lever(ctrl, R(1.32, -2.98, yp + 0.29))
    feet_z = -3.32
    pilot.build_pilot('pilot_front', hipF, BACK, hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.78, feet_z, yp + 0.08), 'R': R(1.78, feet_z, yp - 0.10)}, knee_out=0.03,
                      elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-3.45))
    for dy in (0.11, -0.11):
        c = R(2.00, -3.36, -yp + dy)
        ctrl.box(c, (0.008, 0.10, 0.15), 'Metal_Frame', bevel=0.003, segs=1, rot=K.rot_y(-18))
    tilt = 12.0
    p0 = R(1.80, -2.80, yp)
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(0.0, 0.035, 0.38, 0.14), cw=0.05, v_leg=-0.09, v_sb=-0.15,
                      v_b=-0.26, top_arch=(0.30, 0.10, 0.14), max_u=0.29, leg_exp=0.3)
    # right-seat panel (decor): screen + gauges in the same plane
    t = math.radians(tilt)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    pc = R(1.80, -2.80, -yp) + upv * 0.03
    ctrl.box(pc - nrm * 0.02, (0.03, 0.56, 0.20), 'Panel', bevel=0.012, segs=2, rot=Euler((0, t, 0)))
    ctrl.box(pc + nrm * 0.0, (0.006, 0.22, 0.14), 'Btn_Black', bevel=0.003, segs=1, rot=Euler((0, t, 0)))
    ctrl.box(pc + nrm * 0.004, (0.002, 0.20, 0.12), 'Visor', rot=Euler((0, t, 0)))
    for dy in (0.18, -0.18):
        g = pc + V(0, dy, 0)
        ctrl.cyl(g, g + nrm * 0.007, 0.035, 'Metal_Frame', n=20)
        # dark dial with a white pointer (a plain white disc glowed like a lamp in the sim's cabin)
        ctrl.cyl(g + nrm * 0.007, g + nrm * 0.0075, 0.03, 'Btn_Black', n=20)
        ctrl.box(g + nrm * 0.0082 + upv * 0.010, (0.0015, 0.004, 0.024), 'Gauge_Face', rot=Euler((0, t, 0)))
    ctrl.box(R(1.84, -2.66), (0.22, 1.10, 0.025), 'Panel', bevel=0.01, segs=2, rot=K.rot_y(-8))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    hipP = R(FRONT_HIP_X, FRONT_HIP_Z, -yp)
    pilot.build_pilot('pilot_rear', hipP, BACK,
                      hands={'R': ('rest', hipP + V(0.26, -0.10, 0.10), None), 'L': ('rest', hipP + V(0.26, 0.10, 0.10), None)},
                      feet={'L': R(1.78, feet_z, -yp + 0.10), 'R': R(1.78, feet_z, -yp - 0.08)}, knee_out=0.03,
                      elbow_out=0.04)
    K.print_joints('pilot_rear', R)
    b = math.radians(BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = hipF + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)

    # ---- lamps: nav + strobe behind the clear cover of each wing tip, red beacon on the fuselage top.
    # No landing light and no tail light in any photo of N210AV (nose, wing leading edges, fins all clean).
    for sy in (1, -1):
        tip = R(LE_F(6.82) - 0.02, wing_z(6.82), sy * 6.82)
        K.lamp_node('navL' if sy > 0 else 'navR', tip + V(0.075, -sy * 0.014, 0))
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', tip + V(0.07, sy * 0.018, 0))
    ok, loc, _n, _i = pod.ray_cast(R(BEACON_X, -0.5), V(0, 0, -1))
    K.lamp_node('beacon', (loc if ok else R(BEACON_X, -1.17)) + V(0, 0, 0.055), 'red')
    # MINIMUM SET, NOT ON THE PHOTOS: a landing lamp under the nose, ahead of the nose gear. The owner
    # asked for at least landing + nav + one anti-collision light on every aircraft (night flying).
    lm = MB('min_lights')
    ok2, loc2, _n2, _i2 = pod.ray_cast(R(2.30, -4.6), V(0, 0, 1))
    lp = (loc2 if ok2 else R(2.30, -3.51)) + V(0, 0, -0.022)
    lm.box(lp + V(-0.02, 0, 0.012), (0.10, 0.07, 0.05), 'Paint_White', bevel=0.02, segs=3)
    K.lamp(lm, lp + V(0.028, 0, 0), V(1, 0, -0.12), kind='white', r=0.026, length=0.022, base='Chrome')
    K.lamp_node('landing', lp + V(0.085, 0, -0.008))
    lm = lm.finish(sharp_angle=50)

    stick_r = bpy.data.objects.get('stick_right')
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit], ' (pilot)')
    K.clearance(['pilot_rear'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit, stick_r], ' (passenger)')
    K.finalize([pod, det, lm, cframe, cseal, scoop, nac, boom, tail, wing, bl, gear, cockpit, ctrl, stick_r] + regs + exp,
               [canopy])
    ax_x, ty, ax_z = MAIN
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -2.25), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': R(ax_x, ax_z, ty), 'wheel_R': R(ax_x, ax_z, -ty),
        'pilot_rear': None,
    })

    def g(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('CARTER hub %s pivot %s prop %s eye %s' % (g(HUB), g(PIVOT), g(PROP), g(eye)))
    print('CARTER ground y %.3f main axle %s nose axle %s' % (R.z(GROUND), g(R(ax_x, ax_z, ty)), g(R(NOSE[0], NOSE[1]))))


# ---- photo-matched overlay: perspective camera solved by ba.py (scratchpad work/carter/cams.json) ----
SIZES = {'rb1': (1200, 675), 'rb3': (1200, 675), 'j': (1024, 660), 'h': (1800, 1200), 'a': (1024, 681),
         'front': (500, 332)}


def render_match(scn, cam_name, out):
    cams = json.load(open(K.arg('--cams')))
    c = cams[cam_name]
    Rm = Matrix(c['R'])
    t = Vector(c['t'])
    C = -(Rm.transposed() @ t)
    off = Vector((0.33 + R.dx, 0.0, -1.17 + R.dz))       # BA frame (MLE origin) -> model
    W, H = SIZES[cam_name]
    B.setup_render(scn)
    scn.cycles.samples = 16
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = W, H
    cam = bpy.data.cameras.new('MatchCam')
    co = bpy.data.objects.new('MatchCam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    xr, yd, zf = Rm[0], Rm[1], Rm[2]
    M = Matrix((xr, -yd, -zf)).transposed()
    co.matrix_world = Matrix.Translation(C + off) @ M.to_4x4()
    cam.sensor_fit = 'HORIZONTAL'
    cam.sensor_width = 36.0
    cam.lens = c['f'] * 36.0 / W
    cam.clip_start = 0.05
    cam.clip_end = 500
    sun = bpy.data.lights.new('MSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('MSun', sun)
    so.rotation_euler = Euler((math.radians(40), 0, math.radians(30)))
    scn.collection.objects.link(so)
    w = bpy.data.worlds.new('MW')
    scn.world = w
    scn.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print('rendered match', out)


VIEWS = {
    'three_quarter_front': dict(loc=(15.5, 13.0, 4.8), target=(-0.6, 0.0, 0.6), lens=33, rotor=-58, prop=20),
    'side': dict(loc=(0.0, 20.0, 0.6), target=(-0.6, 0.0, 0.6), ortho=15.0, rotor=0, prop=0),
    'top': dict(loc=(-0.6, 0.0, 25.0), target=(-0.6, 0.0, 0.0), ortho=15.5, rotor=30, prop=0),
    'rear_three_quarter': dict(loc=(-15.5, -12.0, 5.5), target=(-0.8, 0.0, 0.6), lens=35, rotor=-40, prop=40),
    'thumb': dict(extra=True, loc=(12.5, -13.0, 7.0), target=(-0.5, 0.0, 0.6), lens=44, rotor=-25, prop=10),
    'side_near': dict(extra=True, loc=(0.0, -20.0, 0.6), target=(-0.6, 0.0, 0.6), ortho=8.4, rotor=90, prop=0),
    'front': dict(extra=True, loc=(20.0, 0.0, 0.3), target=(0.0, 0.0, 0.3), ortho=15.0, rotor=90, prop=0),
    'front_near': dict(extra=True, loc=(20.0, 0.0, 0.3), target=(0.0, 0.0, 0.3), ortho=4.5, rotor=90, prop=0),
    'cabin': dict(extra=True, loc=(5.2, -3.0, 1.2), target=(1.3, 0.0, -0.3), lens=35, rotor=75, prop=0),
    'tail_detail': dict(extra=True, loc=(-8.0, -6.0, 1.5), target=(-3.5, 0.0, 0.0), lens=40, rotor=75, prop=10),
    'lamp_min': dict(extra=True, loc=(3.5, -1.4, -0.95), target=(2.1, 0.0, -0.86), lens=70, rotor=75, prop=10),
    'scoop': dict(extra=True, loc=(4.6, 2.7, 0.35), target=(1.0, 0.0, 0.80), lens=70, rotor=75, prop=10),
    'blade_tip': dict(extra=True, loc=(6.2, 1.6, 3.4), target=(6.55, 0.05, 2.70), lens=50, rotor=0, prop=10),
    'lamp_tip': dict(extra=True, loc=(0.5, 7.7, 0.45), target=(-1.05, 6.8, 0.04), lens=60, rotor=75, prop=10),
    'lamp_beacon': dict(extra=True, loc=(-2.4, -2.4, 2.3), target=(-0.5, 0.0, 1.5), lens=55, rotor=75, prop=10),
    'head_detail': dict(extra=True, loc=(2.5, -3.0, 3.2), target=(-0.2, 0.0, 2.4), lens=45, rotor=75, prop=0),
    'pilot_eye': dict(extra=True, loc=(0.82, 0.31, 0.23), target=(2.2, 0.22, -0.15), lens=16, rotor=75, prop=0),
}

if __name__ == '__main__':
    mc = K.arg('--match')
    if mc:
        scn = B.reset_scene()
        B.build_materials()
        pilot.ensure_materials()
        K.ensure_materials()
        for nm, v in (('Paint_White', LIVERY['body']), ('Paint_Accent', LIVERY['accent']), ('Paint_Dark', LIVERY['dark'])):
            K.set_paint(nm, *v)
        build_carter()
        render_match(scn, mc, K.arg('--match-out'))
    else:
        K.run('carterpav', build_carter, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
