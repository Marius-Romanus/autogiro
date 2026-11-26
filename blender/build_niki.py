"""
Niki Lightning (Niki Rotor Aviation, Pravets, Bulgaria, 2016-) for the Autogiro web sim: enclosed
tandem gyroplane (carbon monocoque with a long glazed canopy wrapping nose and roof and two upward-
opening side doors), faired mast growing out of the roof and sweeping back into the engine cowl, Rotax
912/914 inside the pod behind the rear seat driving by belt a 3-blade E-Props propeller that turns in
the MIDDLE of the airframe: the hub sits on the fuselage axis right behind the cowl and the tail boom
passes through it (static shaft inside the rotating hub), a thick tail cone tapering into the boom
behind it. Tail: tailplane with arrow-shaped end fins, central fin above the boom and a deeper ventral
fin below it (cruciform from behind) carrying the rudder and the spring-steel tail skid. Curved carbon
main legs ending in lens-shaped wheel pods, bare nose wheel on a fork.

No pure side view exists: the two Commons photos of D-ME.. (AERO 2018) are taken from about 45 deg
BEHIND the left beam, 6 m away. The camera of side_a (Commons 1920 px) was solved in perspective
(tools in the scratch dir: camfit.py / bp.py) from the main and nose tyre contacts, the rotor hub at
2.78 m (published height 2.85 m to the head top), the 1.75 m propeller tips and the end-fin corners;
every outline point was back-projected onto the plane y = 0 (or y of the feature). Fit: yaw -44.9 deg,
level, 6.0 m, f = 2360 px; track 1.73 m, wheelbase 1.99 m, end fins 1.74 m apart, length 4.63 m
(published 4.55 / 4.74). Widths from the rear view (95AGF) and the 3/4 views. Hub frame as gyrokit.py.

  blender -b -P blender/build_niki.py -- [--previews] [--only VIEW,...] [--persp] [--show-rear]
  --persp renders blender/previews/niki/persp_side_a.png from the solved camera of side_a (1920x1336).
Outputs: public/models/niki.glb, blender/niki.blend, blender/previews/niki/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- hub frame ------------------------------------------------------------------------------------
GROUND = -2.78                     # rotor hub 2.78 m above the ground (2.85 m to the top of the head)
WR = 0.18                          # main tyres (fat low-pressure, about 0.36 m)
AXLE = (-0.27, GROUND + WR)        # main axle: 0.27 m behind the rotor axis (camera fit)
MAIN_Y = 0.865                     # track 1.73 m
NOSE_R = 0.165
NOSE = (1.72, GROUND + NOSE_R)     # wheelbase 1.99 m
# CG: sim convention 0.33 m ahead of the hub; height 0.85 m above the main axle (no published limits)
CG = (0.33, AXLE[1] + 0.85)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.20)
AXIS_Z = -1.57                     # propeller / tail-boom axis
PROP_X = -0.92
PROP = R(PROP_X, AXIS_Z)
PROP_R = 0.875                     # E-Props 1.75 m, 3 blades

LIVERY = dict(body=('#951A55', 0.55, 0.22), accent=('#C5C9CE', 0.85, 0.24), dark=('#2B2D31', 0.3, 0.32))
REG = 'EC-NL4'                     # fictional

# solved camera of side_a (ground frame: hub above the origin at 2.78 m)
CAM_A = dict(pos=(-4.5055, 4.0040, 1.4474), psi=-44.904, phi=-0.1446, f=2360.26, w=1920, h=1336)

# ---- hull: side profiles (hub frame), plan half-width, belt (max width) height --------------------
XTIP, ZTIP = 2.22, -2.15
X_END = -0.84                      # aft rim of the cowl round the propeller hub
TOP = [(XTIP, ZTIP), (2.205, -2.06), (2.17, -1.96), (2.10, -1.85), (1.98, -1.72), (1.80, -1.57), (1.55, -1.42),
       (1.25, -1.285), (0.95, -1.195), (0.70, -1.145), (0.40, -1.10), (0.10, -1.06), (-0.15, -1.07),
       (-0.35, -1.12), (-0.50, -1.19), (-0.62, -1.26), (-0.74, -1.34), (X_END, -1.41)]
BOT = [(XTIP, ZTIP), (2.205, -2.235), (2.16, -2.305), (2.07, -2.36), (1.92, -2.395), (1.70, -2.413),
       (1.45, -2.415), (1.00, -2.39), (0.50, -2.35), (0.10, -2.30), (-0.22, -2.22), (-0.50, -2.12),
       (-0.66, -2.03), (-0.76, -1.93), (X_END, -1.75)]
WID = [(XTIP, 0.0), (2.205, 0.085), (2.16, 0.16), (2.08, 0.23), (1.95, 0.285), (1.75, 0.33), (1.50, 0.365),
       (1.20, 0.39), (0.80, 0.405), (0.40, 0.41), (0.00, 0.405), (-0.25, 0.385), (-0.45, 0.345), (-0.60, 0.295),
       (-0.72, 0.24), (X_END, 0.175)]
BELT = [(XTIP, ZTIP), (2.00, -2.08), (1.60, -1.98), (1.00, -1.90), (0.30, -1.86), (-0.20, -1.80), (-0.50, -1.70),
        (X_END, -1.58)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T, F_B, F_W, F_M = _prof(TOP), _prof(BOT), _prof(WID), _prof(BELT)
F_NT = B.hermite([X_END, -0.5, 0.0, 0.6, 1.4, 1.9, XTIP], [2.0, 2.2, 2.5, 2.4, 2.25, 2.1, 2.0])
F_NB = B.hermite([X_END, -0.5, 0.0, 0.8, 1.6, XTIP], [2.0, 2.4, 2.7, 2.8, 2.4, 2.0])


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


def hull_ring(X, n_half=23, scale=1.0, zc=None):
    h = E.resample2d(hull_half(X), n_half)
    if zc is None:
        zc = 0.5 * (h[0][1] + h[-1][1])
    h = [(y * scale, zc + (z - zc) * scale) for y, z in h]
    return [R(X, z, y) for y, z in h] + [R(X, z, -y) for y, z in reversed(h[1:-1])]


def hull_y(X, Z):
    zt, zb, w, zm, nt, nb = hull(X)
    if Z >= zm:
        f = min(1.0, (Z - zm) / (zt - zm))
        return w * max(0.0, 1 - f ** nt) ** (1 / nt)
    f = min(1.0, (zm - Z) / (zm - zb))
    return w * max(0.0, 1 - f ** nb) ** (1 / nb)


# ---- glazing and livery (side view, hub frame) -----------------------------------------------------
# lower edge of the windscreen/roof glass = top edge of the door frame (traced at y = 0.36)
FRAME = [(1.80, -2.085), (1.76, -2.04), (1.55, -1.83), (1.32, -1.625), (1.05, -1.475), (0.83, -1.39),
         (0.55, -1.315), (0.30, -1.258), (0.16, -1.228)]
P_ROOF = [(2.40, -2.12), (1.95, -2.12)] + FRAME + [(0.15, -1.15), (0.17, -0.80), (2.40, -0.80)]
P_DOOR = [(1.70, -2.10), (1.66, -2.01), (1.53, -1.88), (1.32, -1.69), (1.05, -1.545), (0.83, -1.46),
          (0.55, -1.385), (0.30, -1.33), (0.17, -1.305), (0.135, -1.34), (0.13, -1.55), (0.17, -1.78),
          (0.24, -1.97), (0.33, -2.09), (0.45, -2.15), (0.65, -2.185), (0.90, -2.205), (1.20, -2.215),
          (1.45, -2.21), (1.58, -2.19), (1.66, -2.16)]
P_DOORCUT = [(1.76, -2.06), (1.56, -1.85), (1.32, -1.645), (1.05, -1.495), (0.83, -1.41), (0.55, -1.335),
             (0.30, -1.278), (0.12, -1.250), (0.085, -1.34), (0.085, -1.56), (0.125, -1.80), (0.20, -2.00),
             (0.30, -2.13), (0.45, -2.20), (0.65, -2.235), (0.90, -2.255), (1.20, -2.265), (1.48, -2.26),
             (1.64, -2.23), (1.74, -2.16)]
# silver: window surround + the upper rear body down to the swoosh line
SWOOSH = [(1.86, -2.13), (1.66, -2.285), (1.20, -2.305), (0.83, -2.295), (0.55, -2.265), (0.40, -2.21),
          (0.26, -2.03), (0.12, -1.86), (-0.08, -1.755), (-0.40, -1.695), (-0.70, -1.655), (-0.95, -1.64)]
P_SILVER = SWOOSH + [(-0.95, -0.60), (0.20, -0.60), (0.16, -1.15)] + FRAME[::-1][:-1] + [(1.86, -2.13)]
P_PIN = SWOOSH + [(x, z - 0.028) for x, z in SWOOSH[::-1]]
# magenta stripe across the silver behind the canopy
P_STRIPE = [(0.16, -1.24), (-0.10, -1.255), (-0.40, -1.31), (-0.72, -1.42), (-0.72, -1.475), (-0.40, -1.365),
            (-0.10, -1.31), (0.16, -1.295)]

FRONT_HIP = R(1.10, -2.13)
REAR_HIP = R(0.38, -2.12)
FRONT_BACK, REAR_BACK = 16.0, 18.0


def cast_side(target, x, z, sy):
    ok, loc, nrm, _ = target.ray_cast(V(x, sy * 1.5, z), V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def side_loop(mb, target, poly, sy, r=0.004, mat='Paint_Dark', lift=0.001, step=0.02, closed=True):
    pts = B.resample_loop([R(X, Z) for X, Z in poly], step) if closed else \
        [R(X, Z) for X, Z in poly]
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


def oval_patch(mb, target, p, n, fwd, a, b, mat, h0=0.002, h1=0.006, taper=0.55):
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    fwd = (fwd - n * fwd.dot(n)).normalized()
    up = n.cross(fwd).normalized()
    ring, ring2 = [], []
    for k in range(24):
        t = TAU * k / 24
        for rr, out, hh in ((1.0, ring, h0), (taper, ring2, h1)):
            q = Vector(p) + fwd * (math.cos(t) * a * rr) + up * (math.sin(t) * b * rr) + n * 0.3
            ok, loc, _nn, _i = target.ray_cast(q, -n, distance=0.8)
            out.append((loc if ok else Vector(p)) + n * hh)
    ctr = sum(ring2, Vector()) / len(ring2)
    mb.loft([ring, ring2, [ctr]], mat, closed=True)


STRIP_X = (XTIP - 0.11, XTIP - 0.28)     # LED strip on the nose flank: front / rear LED (hub frame)
STRIP_Z = (-2.172, -2.160)


def nose_strip(pod, sy, count=9):
    """Points and normals of the LEDs of one nose strip (sy = +1 left, -1 right)."""
    out = []
    for k in range(count):
        t = k / (count - 1)
        loc, nrm = cast_side(pod, R.x(lerp(STRIP_X[0], STRIP_X[1], t)), R.z(lerp(STRIP_Z[0], STRIP_Z[1], t)), sy)
        if loc is not None:
            out.append((loc, nrm))
    return out


def build_hull():
    us = [0.025 * k for k in range(1, 32)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.045:
        x -= 0.036
        xs.append(x)
    xs.append(X_END)
    mb = MB('pod')
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    mb.loft(rings, 'Paint_White', closed=True)
    # open aft end of the cowl: rounded lip, dark tunnel round the belt pulley, closed far inside
    zc = AXIS_Z
    end = rings[-1]
    lip = hull_ring(X_END - 0.006, scale=0.90, zc=zc)
    lip2 = hull_ring(X_END - 0.002, scale=0.80, zc=zc)
    tun = hull_ring(X_END, scale=0.74, zc=zc)
    tun = [p + V(0.06, 0, 0) for p in tun]
    deep = [p + V(0.20, 0, 0) for p in hull_ring(X_END, scale=0.62, zc=zc)]
    mb.loft([end, lip, lip2], 'Paint_White', closed=True)
    mb.loft([lip2, tun, deep], 'Engine_Dark', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60, merge=1e-5)
    K.paint_poly(pod, R.pts(P_PIN), 'Paint_Dark')
    K.paint_poly(pod, R.pts(P_SILVER), 'Paint_Accent', test=lambda c: c.x > R.x(X_END) + 0.004)
    K.paint_poly(pod, R.pts(P_STRIPE), 'Paint_White', test=lambda c: abs(c.y) > 0.10)
    return pod


def build_hull_lines(pod):
    """Door cut lines, roof hinges, latch, louvres, gills, side intake, badges, nose LED strip."""
    mb = MB('hull_lines')
    for sy in (1, -1):
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: door cut line removed)
        # gull-wing door: two hinges on the roof frame, latch handle at the lower rear corner
        for (X, Z), size, mat in (((1.20, -1.585), (0.07, 0.016, 0.02), 'Chrome'),
                                  ((0.45, -1.30), (0.07, 0.016, 0.02), 'Chrome'),
                                  ((0.36, -2.16), (0.09, 0.016, 0.024), 'Chrome')):
            loc, nrm = cast_side(pod, R.x(X), R.z(Z), sy)
            if loc is not None:
                mb.box(loc + nrm * 0.004, size, mat, bevel=0.004, segs=2,
                       rot=Euler((0, math.radians(-25 if Z > -1.8 else 0), 0)))
        # upper louvre block (eight vertical slots) behind the cabin
        K.louvres(mb, pod, R(-0.44, -1.40, sy * 0.35), V(0, sy, 0.25), V(0, 0, 1), count=8, length=0.13,
                  pitch=0.042, depth=0.016, mat='Radiator', body_mat='Paint_Accent')
        # lower gills (five slanted slots) at the bottom rear of the cowl
        K.louvres(mb, pod, R(-0.60, -1.93, sy * 0.30), V(0, sy, -0.3), V(1, 0, 0.35), count=5, length=0.20,
                  pitch=0.034, depth=0.016, mat='Radiator', body_mat='Paint_White', slant=-0.02)
        # oval cooling-air intake above the gills
        p = R(-0.30, -1.82, sy * 0.38)
        oval_patch(mb, pod, p, V(0.1, sy, 0), V(1, 0, 0.15), 0.065, 0.035, 'Radiator', h0=0.002, h1=-0.004,
                   taper=0.7)
        # round Rotax badge on the silver
        loc, nrm = cast_side(pod, R.x(-0.18), R.z(-1.66), sy)
        if loc is not None:
            mb.lathe([(0.0, 0.004), (0.036, 0.004), (0.042, 0.0), (0.042, -0.004)], loc, nrm, 'Chrome', n=24)
            mb.cyl(loc + nrm * 0.004, loc + nrm * 0.006, 0.026, 'Paint_Dark', n=20)
        # cabin air vent (small chrome eyeball) behind the door
        loc, nrm = cast_side(pod, R.x(0.02), R.z(-1.50), sy)
        if loc is not None:
            mb.lathe([(0.0, 0.010), (0.022, 0.010), (0.03, 0.0), (0.03, -0.004)], loc, nrm, 'Chrome', n=16)
    # LED landing light strips, one on each flank of the nose just below the canopy edge, parallel to it:
    # a row of small LEDs in a chrome-rimmed dark slot (threequarter_front_right_white_ground_brochure_1872
    # .jpg right side, front_nose_white_ground_fashion_2560.jpeg left side)
    for sy in (1, -1):
        for p, n in nose_strip(pod, sy):
            mb.lathe([(0.0, 0.0), (0.0055, 0.0), (0.0045, 0.003), (0.0, 0.004)], p + n * 0.0025, n, 'Lens_White',
                     n=10)
        ctr, n = cast_side(pod, R.x(STRIP_X[0] * 0.5 + STRIP_X[1] * 0.5), R.z(STRIP_Z[0] * 0.5 + STRIP_Z[1] * 0.5),
                           sy)
        fwd = V(STRIP_X[0] - STRIP_X[1], 0, STRIP_Z[0] - STRIP_Z[1])
        half = fwd.length * 0.5 + 0.024
        oval_patch(mb, pod, ctr, n, fwd, half + 0.004, 0.015, 'Chrome', h0=0.0005, h1=0.0022, taper=0.9)
        oval_patch(mb, pod, ctr, n, fwd, half, 0.011, 'Paint_Dark', h0=0.0024, h1=0.0024, taper=0.92)
    return mb.finish(sharp_angle=50)


def split_canopy(pod):
    roof, door = R.pts(P_ROOF), R.pts(P_DOOR)
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    K.bisect_poly(bm, roof)
    K.bisect_poly(bm, door)
    bm.to_mesh(pod.data)
    bm.free()
    # the dark tunnel at the back is never glass
    return K.split_glass(pod, lambda c: c.x > R.x(0.0) and (PANEL.inside(roof, c.x, c.z) or
                                                             PANEL.inside(door, c.x, c.z)),
                         frame_r=0.0075, frame_mat='Paint_Accent', seal=True, thickness=0.012, name='canopy')


# ---- mast fairing ------------------------------------------------------------------------------------
# (hub Z, leading edge X, trailing edge X, thickness) traced on side_a; thickness from the 3/4 views
MAST = [(-1.30, 0.078, -0.66, 0.30), (-1.20, 0.078, -0.50, 0.25), (-1.12, 0.078, -0.39, 0.20),
        (-1.04, 0.077, -0.31, 0.165), (-0.95, 0.076, -0.255, 0.14), (-0.85, 0.074, -0.215, 0.12),
        (-0.70, 0.072, -0.16, 0.105), (-0.55, 0.070, -0.11, 0.095), (-0.42, 0.068, -0.075, 0.088),
        (-0.32, 0.066, -0.055, 0.085)]
MAST_TOP = -0.32


def build_mast():
    mb = MB('mast')
    rings = []
    for Z, le, te, th in MAST:
        c = le - te
        rings.append([R(le - s * c, Z, tz * c) for s, tz in airfoil_ring(14, min(th / c, 0.9), te_min=0.004)])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    mast = mb.finish(sharp_angle=50)
    le_f = B.hermite([m[0] for m in MAST], [m[1] for m in MAST])
    te_f = B.hermite([m[0] for m in MAST], [m[2] for m in MAST])

    def aft(c):     # silver aft 40 % (D-ME.. / D-MEGJ)
        Z, X = c.z - R.dz, c.x - R.dx
        return (le_f(Z) - X) / max(1e-3, le_f(Z) - te_f(Z)) > 0.58
    K.repaint(mast, aft, 'Paint_Accent')
    # bare mast tube, gimbal cheeks, control push rods, hydraulic pre-rotator motor and hoses
    hb = MB('mast_head')
    hb.cyl(R(0.0, MAST_TOP - 0.05), PIVOT + V(0, 0, -0.02), 0.032, 'Metal_Frame', n=18)
    hb.lathe([(0.0, 0.0), (0.05, 0.0), (0.045, 0.02), (0.034, 0.03), (0.0, 0.03)], R(0.0, MAST_TOP), V(0, 0, 1),
             'Alu_Black', n=20)
    for sy in (1, -1):
        hb.box(PIVOT + V(-0.01, sy * 0.045, -0.03), (0.12, 0.010, 0.11), 'Metal_Frame', bevel=0.01, segs=2)
        hb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.062, 0), 0.016, 'Engine', n=12)
        lo = R(-0.06, MAST_TOP + 0.01, sy * 0.035)
        hi = PIVOT + V(-0.20, sy * 0.10, 0.02)
        hb.cyl(lo, hi, 0.006, 'Metal_Frame', n=8)
        hb.cyl(hi, hi + V(0, 0, 0.03), 0.010, 'Alu_Black', n=8)
    # hydraulic motor on the Bendix side and its two hoses looping down into the fairing
    m0 = PIVOT + V(-0.155, 0, 0.02)
    hb.cyl(m0 + V(0, 0, 0.03), m0 + V(0, 0, -0.07), 0.026, 'Alu_Black', n=14)
    for sy in (1, -1):
        hb.tube(catmull([m0 + V(0.0, sy * 0.02, -0.06), m0 + V(-0.10, sy * 0.06, -0.12),
                         R(-0.15, -0.55, sy * 0.06), R(-0.08, -0.72, sy * 0.035)], 6), 0.011, 'Rubber', n=8)
    return mast, hb.finish(sharp_angle=40, wn=True)


# ---- propeller: rotating sleeve round the static boom shaft -----------------------------------------
def build_prop():
    """Node `prop`: origin on the boom axis in the propeller plane, axis X. The hub is a ring (bore
    0.045 m) round the static shaft that carries the tail cone: toothed belt pulley ahead of it, blade
    clamp disc with six bolts, three E-Props carbon blades."""
    mb = MB('prop')
    c = PROP
    ax = V(1, 0, 0)
    # belt pulley (forward, inside the cowl lip) and blade clamp disc, both annular
    mb.lathe([(0.046, 0.075), (0.108, 0.075), (0.112, 0.071), (0.112, 0.030), (0.108, 0.026), (0.046, 0.026)],
             c, ax, 'Engine', n=40, closed_profile=True)
    for k in range(40):
        a = TAU * k / 40
        mb.box(c + V(0.050, math.cos(a) * 0.113, math.sin(a) * 0.113), (0.040, 0.006, 0.006), 'Engine_Dark',
               rot=Euler((a, 0, 0)))
    mb.lathe([(0.046, 0.030), (0.125, 0.030), (0.132, 0.022), (0.132, -0.030), (0.122, -0.040), (0.046, -0.040)],
             c, ax, 'Metal_Frame', n=40, closed_profile=True)
    for k in range(6):
        a = TAU * (k + 0.5) / 6
        p = c + V(0, math.cos(a) * 0.092, math.sin(a) * 0.092)
        mb.cyl(p + V(-0.040, 0, 0), p + V(-0.052, 0, 0), 0.010, 'Chrome', n=6)
    # blades (same law as gyrokit.build_prop)
    R_ = PROP_R
    k_r = R_ / 0.86
    tip_band = 0.05
    stations = [x * k_r for x in (0.12, 0.14, 0.20, 0.28, 0.36, 0.45, 0.55, 0.65, 0.74)] + \
               [R_ - tip_band, R_ - tip_band * 0.42, R_ - tip_band * 0.13, R_]

    def chord(r):
        u = r / k_r
        if u < 0.14:
            cc = lerp(0.075, 0.085, (u - 0.12) / 0.02)
        elif u < 0.30:
            cc = lerp(0.085, 0.100, (u - 0.14) / 0.16)
        else:
            cc = lerp(0.100, 0.058, (u - 0.30) / 0.50)
        return cc * (0.75 + 0.25 * k_r)
    rings = []
    for r in stations:
        tip_u = max(0.0, (r - (R_ - tip_band)) / tip_band)
        cc = chord(min(r, R_ - tip_band)) * math.sqrt(max(0.0, 1 - tip_u ** 2)) if r < R_ else 0.0
        beta = min(math.atan(1.15 * k_r / (TAU * max(r, 0.14 * k_r))), math.radians(48))
        u = r / k_r
        tc, cam = (lerp(0.30, 0.13, (u - 0.12) / 0.05), 0.0) if u < 0.17 else \
            (lerp(0.12, 0.07, min(1.0, (u - 0.17) / 0.69)), 0.035)
        if r >= R_ - 1e-6:
            rings.append([c + V(0.0, 0.0, R_)])
            continue
        ring = []
        for sc, tz in airfoil_ring(10, tc, m=cam, p=0.4, te_min=0.0015):
            ch = (0.35 - sc) * max(cc, 0.012)
            th = tz * max(cc, 0.012)
            ring.append(c + V(ch * math.sin(beta) + th * math.cos(beta), ch * math.cos(beta) - th * math.sin(beta), r))
        rings.append(ring)
    bm = mb.bm
    f_before = set(bm.faces)
    mb.loft(rings, 'Carbon', closed=True, cap0=True)
    blade_faces = list(set(bm.faces) - f_before)
    # yellow sticker band near the root (photo: yellow/white decal on every blade)
    for f in blade_faces:
        rr = (f.calc_center_median() - c)
        rr = math.hypot(rr.y, rr.z)
        if 0.27 < rr < 0.33:
            f.material_index = mb.mi('Decal_Yellow')
    verts = list({v for f in blade_faces for v in f.verts})
    for k in range(1, 3):
        ret = bmesh.ops.duplicate(bm, geom=verts + list({e for f in blade_faces for e in f.edges}) + blade_faces)
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=c, matrix=Matrix.Rotation(TAU * k / 3, 3, 'X'))
    return mb.finish(origin=c, sharp_angle=50, merge=1e-5)


# ---- tail cone, boom and the static shaft through the hub ------------------------------------------
CONE = [(-0.962, 0.0), (-0.966, 0.07), (-0.975, 0.115), (-0.992, 0.145), (-1.02, 0.163), (-1.07, 0.170),
        (-1.18, 0.165), (-1.30, 0.148), (-1.42, 0.124), (-1.56, 0.097), (-1.70, 0.074), (-1.85, 0.060),
        (-2.05, 0.052), (-2.25, 0.046), (-2.36, 0.040), (-2.40, 0.030), (-2.415, 0.0)]


def build_boom():
    mb = MB('boom')
    prof = [(r, X - PROP_X) for X, r in CONE]
    mb.lathe(prof, PROP, V(1, 0, 0), 'Paint_Accent', n=40)
    boom = mb.finish(sharp_angle=60)
    # aft of the tail cone the boom is in the body colour (D-MEGJ)
    K.repaint(boom, lambda c: c.x < R.x(-1.66), 'Paint_White')
    sb = MB('shaft')
    # static shaft (inside the rotating hub) from the engine bay to the tail cone
    sb.cyl(R(X_END + 0.10, AXIS_Z), R(-1.00, AXIS_Z), 0.040, 'Engine_Dark', n=20)
    # engine-side belt pulley (dark, deep in the cowl tunnel) and the belt strands
    sb.cyl(R(X_END + 0.15, AXIS_Z + 0.30), R(X_END + 0.11, AXIS_Z + 0.30), 0.07, 'Engine', n=24)
    for dz in (0.111, -0.111):
        p0 = R(PROP_X + 0.05, AXIS_Z + dz)
        p1 = R(X_END + 0.13, AXIS_Z + 0.30 + (0.07 if dz > 0 else -0.07))
        sb.tube([p0, p1], 0.0, 'Rubber', n=4, square=(0.034, 0.006, 6))
    return boom, sb.finish(sharp_angle=40)


# ---- tail (hub frame) --------------------------------------------------------------------------------
STAB_Z = -1.56
SPAN = 0.87
STAB_LE, STAB_TE = -2.01, -2.38
EF_TOP, EF_BOT = -1.27, -1.92
UF_TOP = -0.93
LF_BOT = -2.24
HINGE = -1.93
RUD_TOP = -1.66


def ef_le(z):
    Z = z - R.dz
    if Z >= STAB_Z:
        t = (Z - STAB_Z) / (EF_TOP - STAB_Z)
        return R.x(lerp(STAB_LE, -2.20, t))
    t = (STAB_Z - Z) / (STAB_Z - EF_BOT)
    return R.x(lerp(STAB_LE, -2.235, t))


def ef_te(z):
    Z = z - R.dz
    return R.x(lerp(-2.42, -2.39, (Z - EF_BOT) / (EF_TOP - EF_BOT)))


def uf_le(z):
    Z = z - R.dz
    t = (Z + 1.50) / (UF_TOP + 1.50)
    x = lerp(-1.72, -1.965, t)
    x -= 0.06 * max(0.0, (t - 0.90) / 0.10) ** 2
    return R.x(x)


def uf_te(z):
    Z = z - R.dz
    t = (Z + 1.50) / (UF_TOP + 1.50)
    return R.x(lerp(-2.27, -2.30, t) + 0.03 * max(0.0, (t - 0.94) / 0.06) ** 2)


def lf_le(z):
    Z = z - R.dz
    t = (-1.63 - Z) / (-1.63 - LF_BOT)
    return R.x(lerp(-1.75, -2.03, t))


def lf_te(z):
    Z = z - R.dz
    t = (-1.60 - Z) / (-1.60 - LF_BOT)
    return R.x(lerp(-2.36, -2.385, t) + 0.02 * max(0.0, (t - 0.95) / 0.05) ** 2)


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.09, te_min=0.002)
    rings = []
    for y in (-SPAN, -0.80, -0.6, -0.4, -0.2, -0.07, 0.0, 0.07, 0.2, 0.4, 0.6, 0.80, SPAN):
        ch = STAB_LE - STAB_TE
        rings.append([R(STAB_LE - s * ch, STAB_Z + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # arrow-shaped end fins, apex forward at the tailplane
    zs = [EF_BOT, -1.90, -1.84, -1.74, -1.64, -1.59, STAB_Z, -1.53, -1.46, -1.38, -1.31, -1.285, EF_TOP]
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], ef_le, ef_te, y_fn=lambda z, sy=sy: sy * SPAN, t=0.085)
    # dorsal fin (silver leading-edge strip) and the fixed part of the ventral fin
    zs = [-1.52, -1.48, -1.40, -1.30, -1.18, -1.07, -1.00, -0.96, -0.94, UF_TOP]
    f0 = set(mb.bm.faces)
    E.fin_loft(mb, [R.z(z) for z in zs], uf_le, uf_te, t=0.09)
    for f in set(mb.bm.faces) - f0:
        cc = f.calc_center_median()
        if uf_le(cc.z) - cc.x < 0.035:
            f.material_index = mb.mi('Paint_Accent')
    zs = [-1.60, -1.63, RUD_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], lf_le, lf_te, t=0.09)
    zs = [RUD_TOP, -1.72, -1.80, -1.88, -1.94, -1.98, -2.005]
    E.fin_loft(mb, [R.z(z) for z in zs], lf_le, lf_te, t=0.09,
               s_end_fn=lambda z: max(0.02, (lf_le(z) - R.x(HINGE)) / (lf_le(z) - lf_te(z))))
    # tail cap and tail light seat
    mb.cyl(R(-2.405, AXIS_Z), R(-2.425, AXIS_Z), 0.022, 'Paint_Dark', n=14)
    return mb.finish(sharp_angle=45)


def build_rudder():
    """Ventral rudder: the lower fin aft of the hinge (X -1.93) below Z -1.66; below Z -1.97 the whole
    fin chord swings (its leading edge is aft of the hinge there)."""
    mb = MB('rudder')
    t = 0.09
    rings = []
    zs = [RUD_TOP - 0.004, -1.72, -1.80, -1.88, -1.94, -1.98, -2.02, -2.07, -2.12, -2.17, -2.205, -2.228, LF_BOT]
    hx = R.x(HINGE)
    for Z in zs:
        z = R.z(Z)
        lx, tx = lf_le(z), lf_te(z)
        cf = lx - tx
        s_h = max(0.0, (lx - hx) / cf) + 0.004 / cf
        n = 12
        upper, lower = [], []
        for i in range(n + 1):
            s = s_h + (1 - s_h) * (i / n) ** 1.2
            _, yt = B.naca4(s, t)
            yt = max(yt, 0.0012) * cf
            if Z in (zs[-1],):
                yt *= 0.35
            upper.append(V(lx - s * cf, yt, z))
            lower.append(V(lx - s * cf, -yt, z))
        r0 = upper[0].y
        x0 = upper[0].x
        nose = [V(x0 + math.sin(math.pi * j / 6) * r0 * 0.9, math.cos(math.pi * j / 6) * r0, z) for j in range(1, 6)]
        rings.append(upper + lower[::-1] + nose[::-1])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    for Z in (-1.70, -1.90):
        mb.box(R(HINGE + 0.008, Z), (0.04, 0.014, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    origin = R(HINGE, -1.95)
    return mb.finish(origin=origin, sharp_angle=45), origin


def build_skid():
    mb = MB('skid')
    pts = [R(-1.935, -1.985, 0.0), R(-1.965, -2.10), R(-2.03, -2.24), R(-2.10, -2.36), R(-2.15, -2.41),
           R(-2.20, -2.405), R(-2.22, -2.375)]
    mb.tube(catmull(pts, 5), 0.0075, 'Paint_Dark', n=10)
    mb.box(R(-1.93, -1.985), (0.06, 0.03, 0.035), 'Metal_Frame', bevel=0.006, segs=1)
    return mb.finish(sharp_angle=40)


# ---- landing gear -------------------------------------------------------------------------------------
def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # curved carbon strut: out of the lower pod side, out and down to the top of the wheel pod
        pts = [R(-0.24, -2.17, sy * 0.30), R(-0.245, -2.21, sy * 0.45), R(-0.255, -2.29, sy * 0.62),
               R(-0.265, -2.38, sy * 0.74), R(-0.27, -2.45, sy * (MAIN_Y - 0.03))]
        # the root goes 3 cm into the pod side (it used to stop 2 cm outside it, under the root fairing)
        loc, nrm = cast_side(bpy.data.objects['pod'], pts[0].x, pts[0].z, sy)
        if loc is not None:
            pts[0] = loc - nrm * 0.03
        K.leg_blade(mb, pts, chord=0.072, thick=0.052, mat='Paint_White')
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.072), ax.z), V(ax.x, sy * (MAIN_Y - 0.064), ax.z), 0.085, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.07, sy * (MAIN_Y - 0.068), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        # root fairing where the strut leaves the pod
        loc, nrm = cast_side(bpy.data.objects['pod'], R.x(-0.24), R.z(-2.17), sy)
        if loc is not None:
            oval_patch(mb, bpy.data.objects['pod'], loc, nrm, V(1, 0, 0), 0.07, 0.045, 'Paint_White', h0=0.0,
                       h1=0.02, taper=0.6)
    gear = mb.finish(sharp_angle=40, wn=True)
    pods = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        # lens-shaped wheel pod: 0.30 ahead / 0.32 behind the axle, the lower third of the tyre shows
        pods.append(K.spat(name, c, R=WR, front=0.30, back=0.32, hw=0.085, top=0.055, lift=0.035,
                           mat='Paint_White', tail_up=0.035, belly=0.30))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=WR, w=0.11)
    # ROTAX lettering on the outer face of each pod
    regs = []
    for sp, sy in zip(pods, (1, -1)):
        cu_objs = E.build_registration(sp, 'ROTAX', cx=ax.x + 0.02, cz=ax.z + 0.075, size=0.055, mat='Decal_White')
        keep = cu_objs[0] if sy > 0 else cu_objs[1]
        for o in cu_objs:
            if o is not keep:
                bpy.data.objects.remove(o)
        regs.append(keep)
    nc = R(NOSE[0], NOSE[1])
    K.nose_gear(nc, R=NOSE_R, w=0.10, leg_top=R.z(-2.39), rake=-0.05, mudguard=None)
    return gear, pods, regs


# ---- cockpit -----------------------------------------------------------------------------------------
def seat(mb, hip, back_deg, width=0.38, cushion_len=0.40):
    """High-back composite racing bucket (quilted cushions, integrated headrest)."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    rc = Euler((0, math.radians(-8), 0))
    c = V(hip.x + cushion_len * 0.5 - 0.10, hip.y, hip.z - 0.125)
    mb.box(c, (cushion_len, width, 0.075), 'Seat', bevel=0.03, segs=3, rot=rc)
    back_c = hip - f * 0.175 + u * 0.36
    mb.box(back_c, (0.07, width, 0.72), 'Seat', bevel=0.03, segs=3, rot=rb)
    mb.box(back_c - f * 0.045, (0.03, width + 0.02, 0.74), 'Carbon', bevel=0.012, segs=2, rot=rb)
    for sy in (1, -1):
        mb.box(back_c + f * 0.045 + V(0, sy * (width * 0.5 - 0.02), -0.08), (0.10, 0.045, 0.46), 'Seat',
               bevel=0.02, segs=2, rot=rb)
        mb.box(c + V(0.02, sy * (width * 0.5 - 0.02), 0.04), (cushion_len - 0.06, 0.045, 0.06), 'Seat',
               bevel=0.016, segs=2, rot=rc)
    # headrest wings
    hc = hip - f * 0.16 + u * 0.80
    for sy in (1, -1):
        mb.box(hc + V(0, sy * 0.10, 0) + f * 0.03, (0.08, 0.04, 0.16), 'Seat', bevel=0.015, segs=2, rot=rb)
    # seat pan support
    mb.box(V(c.x - 0.02, hip.y, c.z - 0.075), (cushion_len - 0.05, width - 0.08, 0.07), 'Carbon', bevel=0.012, segs=1)


def build_cockpit():
    mb = MB('cockpit')
    seat(mb, FRONT_HIP, FRONT_BACK)
    seat(mb, REAR_HIP, REAR_BACK)
    # floor, rear bulkhead (firewall) behind the passenger, tunnel under the front seat
    mb.box(R(1.00, -2.362), (1.60, 0.46, 0.012), 'Interior', bevel=0.0)
    ring = hull_ring(-0.16, n_half=20, scale=0.965)
    mb.loft([[p + V(-0.03, 0, 0) for p in ring], ring], 'Interior', closed=True, cap0=True, cap1=True)
    # passenger foot wells either side of the front seat
    for sy in (1, -1):
        mb.box(R(0.96, -2.285, sy * 0.23), (0.20, 0.09, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


def build_niki():
    for nm, hexc in (('Decal_Yellow', '#F2C21B'),):
        if nm not in MATS:
            B.make_mat(nm, B.srgb(hexc), rough=0.35)
    pod = build_hull()
    lines = build_hull_lines(pod)
    canopy, cframe, cseal = split_canopy(pod)
    mast, mast_head = build_mast()
    boom, shaft = build_boom()
    K.build_head(PIVOT, HUB, arm=-0.20, arm_w=0.20, plate_mat='Metal_Frame')
    K.build_rotor(HUB, R=4.25, chord=0.21, root=0.50, tip_mat='Decal_White', clamp_len=0.48)
    build_prop()
    tail = build_tail()
    rud, rud_origin = build_rudder()
    skid = build_skid()
    gear, pods, pod_txt = build_gear()
    cockpit = build_cockpit()

    # ---- controls and crew
    ctrl = MB('controls_static')
    stick_base = R(1.40, -2.335)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.40, -1.86))
    knob, lever = controls.throttle_lever(ctrl, R(1.26, -1.96, 0.30))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.80, -2.22, 0.13), 'R': R(1.80, -2.22, -0.13)}, knee_out=0.08, elbow_out=0.10,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.355))
    # narrow pedestal panel ahead of the stick (photo: three rows of round gauges, compass on top)
    tilt = 18.0
    p0 = R(1.66, -1.83)
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(0.0, 0.025, 0.37, 0.14), cw=0.055, v_leg=-0.10,
                      v_sb=-0.22, v_b=-0.42, top_arch=(0.215, 0.088, 0.135), max_u=0.215, leg_exp=0.3)
    t = math.radians(tilt)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    # compass on the panel top, pedestal foot down to the floor
    cp = p0 + upv * 0.15 - nrm * 0.02
    ctrl.box(cp, (0.06, 0.07, 0.05), 'Panel', bevel=0.012, segs=2)
    ctrl.box(cp + V(-0.031, 0, 0.0), (0.004, 0.04, 0.03), 'Gauge_Face', bevel=0.002, segs=1)
    ctrl.box(R(1.76, -2.24), (0.09, 0.09, 0.24), 'Panel', bevel=0.02, segs=2, rot=K.rot_y(tilt))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.24, -0.13, 0.13), None),
                             'L': ('rest', REAR_HIP + V(0.24, 0.13, 0.13), None)},
                      feet={'L': R(0.95, -2.18, 0.23), 'R': R(0.95, -2.18, -0.23)}, knee_out=0.12, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    # ---- details
    det = MB('details')
    # lights as the photos show them: the two LED strips on the nose flanks (landing, one node on each) and
    # a small chrome-cased white light on the end of the tail boom, at the stabiliser (side_a 1920 px, D-MEP
    # at AERO 2018). No nav / strobe lights on the end fins and no beacon on the fin in any photo.
    for sy, tag in ((1, 'L'), (-1, 'R')):
        pts = nose_strip(pod, sy)
        p, n = pts[len(pts) // 2]
        K.lamp_node('landing', p + n * 0.025, tag)
    K.lamp(det, R(-2.425, AXIS_Z), V(-1, 0, 0), kind='white', r=0.014, length=0.018, base='Chrome')
    K.lamp_node('tail', R(-2.425 - 0.045, AXIS_Z))
    # MINIMUM SET, NOT ON THE PHOTOS: nav + strobe on the outer face of each end fin. The owner asked for
    # at least landing + nav + one anti-collision light on every aircraft (night flying in the sim).
    for sy, kind in ((1, 'red'), (-1, 'green')):
        K.lamp(det, R(-2.30, -1.45, sy * (SPAN + 0.014)), V(0, sy, 0), kind=kind, r=0.018, length=0.024)
        K.lamp(det, R(-2.33, -1.70, sy * (SPAN + 0.014)), V(0, sy, 0), kind='white', r=0.015, length=0.02)
        K.lamp_node('navL' if sy > 0 else 'navR', R(-2.30, -1.45, sy * (SPAN + 0.045)))
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', R(-2.33, -1.70, sy * (SPAN + 0.045)))
    K.antenna(det, R(0.20, -2.33), (-0.25, 0, -1), length=0.22)
    det = det.finish(sharp_angle=50)
    txt = K.decal_text(pod, 'LIGHTNING', R.x(-0.30), R.z(-1.32), size=0.058, mat='Paint_Dark')
    txt += K.decal_text(pod, 'ROTAX 914 UL', R.x(-0.43), R.z(-1.665), size=0.042, mat='Decal_White')
    regs = E.build_registration(boom, REG, cx=R.x(-1.22), cz=R.z(AXIS_Z), size=0.105, mat='Decal_Black')
    txt += regs

    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit], ' (pilot)')
    K.clearance(['pilot_rear'], [pod, cockpit], ' (passenger)')
    K.finalize([pod, lines, cframe, cseal, mast, mast_head, boom, shaft, tail, skid, gear, cockpit, ctrl, det]
               + pods + pod_txt + txt, [canopy])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': rud_origin, 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })

    def g(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('NIKI hub %s pivot %s prop %s eye %s cg %s' % (g(HUB), g(PIVOT), g(PROP), g(eye), g(R(CG[0], CG[1]))))
    print('NIKI ground y %.3f main axle %s nose axle %s stick %s' % (R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)),
                                                                    g(R(NOSE[0], NOSE[1])), g(stick_base)))


def render_persp(cam=CAM_A, out=None):
    """Perspective render from the solved camera of a reference photo, transparent film."""
    scn = bpy.context.scene
    B.setup_render(scn)
    scn.cycles.samples = 24
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = cam['w'], cam['h']
    for o in list(scn.objects):
        if o.type in ('CAMERA', 'LIGHT'):
            bpy.data.objects.remove(o)
    cd = bpy.data.cameras.new('PCam')
    co = bpy.data.objects.new('PCam', cd)
    scn.collection.objects.link(co)
    scn.camera = co
    cx, cy, cz = cam['pos']
    loc = R(cx, cz + GROUND, cy)
    psi, phi = math.radians(cam['psi']), math.radians(cam['phi'])
    f = V(math.cos(phi) * math.cos(psi), math.cos(phi) * math.sin(psi), math.sin(phi))
    cd.sensor_fit = 'HORIZONTAL'
    cd.sensor_width = 36.0
    B.aim(co, loc, loc + f * 10.0, lens=cam['f'] * 36.0 / cam['w'])
    sun = bpy.data.lights.new('OSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('OSun', sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(160)), 'XYZ')
    scn.collection.objects.link(so)
    w = bpy.data.worlds.new('OW')
    scn.world = w
    try:
        w.use_nodes = True
        w.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
        w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    except Exception:
        pass
    pr = bpy.data.objects.get('pilot_rear')
    scn.render.filepath = out or os.path.join(HERE, 'previews', 'niki', 'persp_side_a.png')
    bpy.ops.render.render(write_still=True)
    print('rendered', scn.render.filepath, pr is not None)


VIEWS = {
    # same angles as the reference photos: D-MEGJ low front-right quarter, 95AGF rear, white front-right
    'ref_megj': dict(extra=True, loc=(6.2, -4.6, -0.55), target=(-0.4, 0.0, 0.0), lens=28, rotor=-20, prop=15),
    'ref_rear': dict(extra=True, loc=(-6.4, -0.9, -0.55), target=(-0.6, 0.0, 0.6), lens=24, rotor=40, prop=25),
    'ref_white': dict(extra=True, loc=(5.0, -3.6, -0.6), target=(0.0, 0.0, 0.55), lens=26, rotor=-15, prop=40),
    'ref_front': dict(extra=True, loc=(10.0, 0.0, 0.2), target=(0.0, 0.0, 0.2), ortho=3.6, rotor=90, prop=0),
    'ref_top': dict(extra=True, loc=(0.0, 0.0, 30.0), target=(-0.1, 0.0, 0.0), ortho=5.6, rotor=90, prop=0),
    'prop_detail': dict(extra=True, loc=(-1.0, -2.2, 0.45), target=(-1.0, 0.0, 0.15), lens=40, rotor=75, prop=20),
    'lamp_nose': dict(extra=True, loc=(3.1, -1.25, -0.55), target=(1.85, 0.0, -0.30), lens=60, rotor=-15, prop=40),
    'lamp_nose_l': dict(extra=True, loc=(3.0, 1.5, -0.25), target=(1.85, 0.0, -0.30), lens=60, rotor=-15, prop=40),
    'lamp_tail': dict(extra=True, loc=(-3.6, -1.1, 0.05), target=(-2.7, 0.0, 0.28), lens=60, rotor=-15, prop=40),
    'cabin_detail': dict(extra=True, loc=(2.6, -1.9, 0.9), target=(0.9, 0.0, 0.2), lens=35, rotor=75, prop=0),
}

if __name__ == '__main__':
    K.run('niki', build_niki, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
    if '--persp' in K.ARGV:
        render_persp()
