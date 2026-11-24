"""
Sport Copter Lightning (Sport Copter Inc., Scappoose, Oregon): single-seat ultralight gyroplane with an
open, fully triangulated frame of white large-diameter aluminium tube and blue anodised plates, tall
tubular mast with the Sport Copter shock-mounted head, composite "Cyber Seat", Rotax 503 two-stroke
twin (fan-cooled, dual carbs, B gearbox, tuned pipe + muffler) behind the mast driving a 60 in wooden
two-blader, tricycle gear (polymer main suspension, trailing-arm nose wheel), straight tail boom with
a big fin + rudder, a stabiliser on the boom and two end plates under its tips, small tail wheel.

Two variants (everything except the fairing is identical):
  --variant open    bare frame                       -> public/models/sclightning.glb
  --variant faired  nose pod + windscreen + roof     -> public/models/sclightning_f.glb
                    header (Vancraft-type fairing)

Traced in the HUB FRAME (gyrokit.py) on the Sport Copter air-to-air side photo (lighting-1.jpg,
3510 px, camera 9.6 deg behind the side view, aircraft 4.8 deg nose-up relative to its ground stance),
cross-checked on the ground photo of N403SC and the two 2015 brochure views. Scale 740 px/m from the
60 in propeller and the published 137 in length / 100.5 in height (both match within 3 %).

  blender -b -P blender/build_sportcopter.py -- --variant open|faired [--previews] [--only VIEW,...]
          [--samples N] [--overlay yaw,cx,cz,ppm,w,h[,side]] [--overlay-out path]
Outputs: public/models/sclightning[_f].glb, blender/sclightning[_f].blend,
         blender/previews/sclightning[_f]/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, sgnpow, pilot, controls, PANEL  # noqa: E402

VARIANT = K.arg('--variant', 'open')
FAIRED = VARIANT == 'faired'
NAME = 'sclightning_f' if FAIRED else 'sclightning'

# ---- hub frame (X forward, Z up, origin on the teeter bolt, metres) ------------------------------
GROUND = -2.452
AXLE = (-0.041, -2.282)            # main axle on the ground (flight photo -2.343 + 6 cm sag)
RM, WM, MAIN_Y = 0.170, 0.115, 0.86    # 4.00-6 balloon tyres (photo: 13.4 in), track 1.72 m
NOSE = (1.366, -2.329)             # nose axle (flight photo -2.359 + 3 cm sag)
RN, WN = 0.123, 0.085
PIVOT_H = (0.030, -0.180)          # pitch pivot of the head (bolt through the blue mast-top plates)
PROP_H = (-0.544, -1.270)
PROP_R = 0.762                     # 60 in wooden two-blader
ROTOR_R, ROTOR_C = 3.505, 0.178    # 23 ft x 7 in Sport Rotor blades

# CG height from a mass build-up (hub frame Z, kg): pilot 85 @ -1.45 (H-point -1.63 + 0.18),
# Rotax 503 + gearbox + exhaust 45 @ -1.25, fuel 14 @ -0.83, rotor + head 22 @ -0.02,
# rest of the airframe 48 @ -1.93 (gear 14 @ -2.35, keel/boom/frame 18 @ -2.0, tail 6 @ -1.8,
# seat 5 @ -1.5, mast 5 @ -1.1)  ->  h = 284.3 / 214 = 1.328 m below the hub.
# Single-seat convention of the sim: hub behind the CG by 0.206 h.
H_CG = 1.328
CG = (0.206 * H_CG, -H_CG)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(*PIVOT_H)
PROP = R(*PROP_H)

LIVERY = dict(body=('#F3F4F2', 0.0, 0.22), accent=('#1E58B8', 0.0, 0.25), dark=('#1C1E22', 0.2, 0.4),
              seat=('#1A2448', 0.0, 0.8))


def P(X, Z, y=0.0):
    return R(X, Z, y)


def mast_x(Z):
    """Mast axis (2 in tube): foot on the keel gusset, leaning back 5.8 deg."""
    return 0.192 + (Z + 2.132) * -0.10223


def boom_z(X):
    return lerp(-2.255, -2.190, (0.30 - X) / 1.66)


def mats():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Polymer_Red', '#B8221E', rough=0.6)
    mk('Filter_Blue', '#2A4FA8', rough=0.75)
    mk('Tank_White', '#E9E7DD', rough=0.45)
    mk('Shroud_Black', '#16171A', metal=0.1, rough=0.55)
    mk('Seat_Shell', '#F1F2F0', rough=0.25)


def tube(mb, a, b, r=0.019, mat='Paint_White', n=14):
    mb.cyl(P(*a), P(*b), r, mat, n=n)


def sq_tube(mb, pts, w, h, mat='Paint_White', n=20):
    mb.tube([P(*p) for p in pts], 0.0, mat, n=n, square=(w, h, 6))


# ---------------------------------------------------------------------------
# Coons-patch plates (fin, rudder, end plates) in the side plane
# ---------------------------------------------------------------------------
def _poly(pts):
    d = [0.0]
    for a, b in zip(pts, pts[1:]):
        d.append(d[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))

    def f(t):
        s = max(0.0, min(1.0, t)) * d[-1]
        for i in range(len(pts) - 1):
            if s <= d[i + 1] + 1e-12:
                k = (s - d[i]) / max(1e-12, d[i + 1] - d[i])
                return (lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k))
        return pts[-1]
    return f


def naca_t(u):
    u = max(0.0, min(1.0, u))
    return (0.2969 * math.sqrt(u) - 0.1260 * u - 0.3516 * u ** 2 + 0.2843 * u ** 3 - 0.1036 * u ** 4) / 0.1003


def plate(mb, Bp, Tp, Lp, Rp, half_t, y0=0.0, nu=16, nv=12, mat='Paint_White', ucos=True):
    """Thin solid whose side-view outline is the Coons patch of the four edges (hub frame (X, Z)
    polylines: bottom/top from front to rear, front/rear from bottom to top); half_t(u) = half
    thickness at chordwise u (0 front, 1 rear)."""
    Bf, Tf, Lf, Rf = _poly(Bp), _poly(Tp), _poly(Lp), _poly(Rp)
    b0, b1, t0, t1 = Bf(0), Bf(1), Tf(0), Tf(1)
    us = [(1 - math.cos(math.pi * i / nu)) / 2 if ucos else i / nu for i in range(nu + 1)]
    rings = []
    for j in range(nv + 1):
        v = j / nv
        up, lo = [], []
        for u in us:
            bb, tt, ll, rr = Bf(u), Tf(u), Lf(v), Rf(v)
            x = (1 - v) * bb[0] + v * tt[0] + (1 - u) * ll[0] + u * rr[0] - (
                (1 - u) * (1 - v) * b0[0] + u * (1 - v) * b1[0] + (1 - u) * v * t0[0] + u * v * t1[0])
            z = (1 - v) * bb[1] + v * tt[1] + (1 - u) * ll[1] + u * rr[1] - (
                (1 - u) * (1 - v) * b0[1] + u * (1 - v) * b1[1] + (1 - u) * v * t0[1] + u * v * t1[1])
            h = max(half_t(u), 0.0012)
            up.append(P(x, z, y0 + h))
            lo.append(P(x, z, y0 - h))
        rings.append(up + lo[::-1][1:-1])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True)


# ---------------------------------------------------------------------------
# Frame (tubes, plates, gear struts), mast, push rods
# ---------------------------------------------------------------------------
def build_frame():
    mb = MB('frame')
    W = 'Paint_White'
    # front keel (2.5 in) from the gusset to the nose post
    tube(mb, (0.19, -2.105), (1.33, -2.135), 0.031, W, n=18)
    # tail boom (2 1/8 in) from the gusset to the tail
    tube(mb, (0.42, boom_z(0.42)), (-1.37, boom_z(-1.37)), 0.0275, W, n=18)
    mb.lathe([(0.0, 0.0), (0.029, 0.0), (0.029, 0.012), (0.0, 0.016)], P(-1.37, boom_z(-1.37)), V(-1, 0, 0),
             'Engine_Dark', n=16)
    # mast: 2 in square-ish tube from the gusset to the head plates
    sq_tube(mb, [(mast_x(-2.20), -2.20), (mast_x(-0.25), -0.25)], 0.056, 0.056, W)
    # keel gusset: blue plates either side, bolts
    gus = [(0.193, -2.240), (0.274, -2.091), (0.405, -2.089), (0.416, -2.205), (0.319, -2.298)]
    for sy in (1, -1):
        y = sy * 0.036
        c = [P(x, z, y) for x, z in gus]
        mb.faces(c + [p + V(0, sy * 0.006, 0) for p in c],
                 [list(range(5))[::-1] if sy > 0 else list(range(5)), [5 + i for i in range(5)] if sy > 0 else
                  [5 + i for i in range(5)][::-1]] + [[i, (i + 1) % 5, 5 + (i + 1) % 5, 5 + i] for i in range(5)],
                 'Alu_Blue', smooth=False)
        for (x, z) in ((0.24, -2.20), (0.30, -2.12), (0.38, -2.11), (0.39, -2.19), (0.32, -2.26), (0.29, -2.19)):
            mb.cyl(P(x, z, sy * 0.044), P(x, z, sy * 0.050), 0.007, 'Metal_Frame', n=8)
    mb.cyl(P(0.30, -2.19, 0.06), P(0.30, -2.19, -0.06), 0.006, 'Metal_Frame', n=8)
    # engine mount: rear post, platform at the crankcase, two braces boom -> mast
    tube(mb, (-0.35, boom_z(-0.35)), (-0.35, -1.475), 0.019, W)
    for sy in (1, -1):
        tube(mb, (-0.40, -1.49, sy * 0.11), (mast_x(-1.49) - 0.02, -1.49, sy * 0.11), 0.014, W, n=12)
        tube(mb, (-0.27, boom_z(-0.27) + 0.01, sy * 0.025), (mast_x(-1.735) - 0.03, -1.735, sy * 0.04), 0.016, W)
    tube(mb, (-0.40, -1.49, 0.125), (-0.40, -1.49, -0.125), 0.014, W, n=12)
    tube(mb, (mast_x(-1.49) - 0.02, -1.49, 0.125), (mast_x(-1.49) - 0.02, -1.49, -0.125), 0.014, W, n=12)
    tube(mb, (-0.35, -1.49, 0.0), (-0.40, -1.49, 0.0), 0.016, W, n=12)
    # seat rails: mast -> nose post (pair, converging), seat-front struts from the keel
    for sy in (1, -1):
        tube(mb, (mast_x(-1.72) + 0.025, -1.72, sy * 0.075), (1.30, -2.055, sy * 0.035), 0.016, W)
        tube(mb, (0.40, -2.085, sy * 0.03), (0.545, -1.80, sy * 0.068), 0.014, W, n=12)
    for x in (0.545, 0.95):
        z = lerp(-1.722, -2.055, (x - mast_x(-1.72)) / (1.30 - mast_x(-1.72)))
        tube(mb, (x, z, 0.075), (x, z, -0.075), 0.011, W, n=10)
    # nose post: welded block where keel and rails meet, bushing of the nose-gear pivot
    mb.box(P(1.345, -2.085), (0.11, 0.07, 0.17), W, bevel=0.012, segs=2)
    mb.box(P(1.345, -2.085, 0.037), (0.09, 0.004, 0.13), 'Alu_Blue', bevel=0.004, segs=1)
    mb.box(P(1.345, -2.085, -0.037), (0.09, 0.004, 0.13), 'Alu_Blue', bevel=0.004, segs=1)
    mb.cyl(P(1.395, -2.20), P(1.395, -2.155), 0.024, 'Metal_Frame', n=16)
    # main gear: lower V (to gusset and boom) + tall strut with the polymer stack up to the mast
    ax, az = AXLE
    for sy in (1, -1):
        yi = sy * (MAIN_Y - WM * 0.5 - 0.045)
        tube(mb, (ax, az, yi), (0.33, -2.255, sy * 0.04), 0.017, W)
        tube(mb, (ax, az, yi), (-0.33, boom_z(-0.33) - 0.01, sy * 0.03), 0.017, W)
        top = (mast_x(-1.27) - 0.005, -1.27, sy * 0.055)
        low = (ax + 0.005, az + 0.03, yi)
        tube(mb, low, top, 0.020, W)
        # polymer donut stack + sleeve near the top
        d = (Vector((top[0], top[2], top[1])) - Vector((low[0], low[2], low[1]))).normalized()
        st = Vector((top[0], top[2], top[1])) - d * 0.06
        for k in range(5):
            c0 = st - d * (0.018 * k)
            mb.cyl(P(c0.x, c0.z, c0.y), P(c0.x - d.x * 0.014, c0.z - d.z * 0.014, c0.y - d.y * 0.014), 0.030,
                   'Polymer_Red', n=16)
        # axle fitting (blue plate), axle stub
        mb.box(P(ax, az, yi), (0.10, 0.012, 0.075), 'Alu_Blue', bevel=0.006, segs=1)
        mb.cyl(P(ax, az, yi), P(ax, az, sy * (MAIN_Y + WM * 0.5 + 0.01)), 0.012, 'Metal_Frame', n=10)
        # hydraulic brake calliper on the disc (inboard, front)
        mb.box(P(ax + 0.085, az + 0.05, sy * (MAIN_Y - WM * 0.5 - 0.018)), (0.045, 0.028, 0.035), 'Engine_Dark',
               bevel=0.006, segs=1)
    # strut heads on the mast: cross bolt
    mb.cyl(P(mast_x(-1.27), -1.27, 0.08), P(mast_x(-1.27), -1.27, -0.08), 0.008, 'Metal_Frame', n=8)
    # tail-wheel fork under the boom end
    tz = boom_z(-1.33)
    for sy in (1, -1):
        mb.box(P(-1.335, tz - 0.05, sy * 0.022), (0.03, 0.006, 0.09), 'Paint_White', bevel=0.003, segs=1)
    mb.cyl(P(-1.335, tz - 0.02, 0.03), P(-1.335, tz - 0.02, -0.03), 0.01, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=40, wn=True)


def build_tail_wheel():
    mb = MB('tailwheel')
    c = P(-1.335, -2.258)
    mb.lathe(B.tire_profile(0.037, 0.018, 0.03), c, V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.cyl(c + V(0, -0.017, 0), c + V(0, 0.017, 0), 0.02, 'Polymer_Red', n=14)
    mb.cyl(c + V(0, -0.026, 0), c + V(0, 0.026, 0), 0.005, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=40)


def build_mast_top():
    """Shock-mounted head support: two blue plates bolted to the mast top (pitch bolt through their
    front-upper corner), rubber bushings, and the push rods with their rod ends."""
    mb = MB('mast_top')
    pl = [(-0.052, -0.240), (0.010, -0.164), (0.104, -0.192), (0.106, -0.321), (0.039, -0.390), (-0.029, -0.384)]
    n = len(pl)
    for sy in (1, -1):
        y = sy * 0.034
        c = [P(x, z, y) for x, z in pl]
        o = [p + V(0, sy * 0.008, 0) for p in c]
        faces = [list(range(n)), [n + i for i in range(n)][::-1]] + [[i, (i + 1) % n, n + (i + 1) % n, n + i]
                                                                       for i in range(n)]
        mb.faces(c + o, faces, 'Alu_Blue', smooth=False)
        for (x, z) in ((0.0, -0.36), (0.07, -0.30), (0.0, -0.27), (0.075, -0.215)):
            mb.cyl(P(x, z, sy * 0.042), P(x, z, sy * 0.05), 0.011, 'Rubber', n=12)
            mb.cyl(P(x, z, sy * 0.05), P(x, z, sy * 0.055), 0.0065, 'Metal_Frame', n=8)
    # push rods: control yoke (aft of the head) down beside the mast to the bellcrank under the seat
    for sy in (1, -1):
        a = P(-0.165, -0.170, sy * 0.05)
        b = P(0.300, -1.700, sy * 0.05)
        mb.cyl(a, b, 0.0075, 'Metal_Frame', n=8)
        mb.cyl(b, b + (b - a).normalized() * 0.04, 0.010, 'Alu_Black', n=8)
    # bellcrank + control tube along the rails to the stick
    mb.cyl(P(0.30, -1.74, 0.07), P(0.30, -1.74, -0.07), 0.012, 'Metal_Frame', n=10)
    mb.box(P(0.30, -1.72, 0.0), (0.04, 0.12, 0.06), 'Alu_Blue', bevel=0.006, segs=1)
    tube(mb, (0.31, -1.775), (0.93, -1.975), 0.013, 'Metal_Frame', n=10)
    return mb.finish(sharp_angle=40, wn=True)


def build_head():
    """Sport Copter head (node rotor_head, origin on the pitch bolt): gimbal block on the bolt,
    bearing housing up to the rotor spindle, control yoke reaching aft to the two push rods."""
    mb = MB('rotor_head')
    c = PIVOT
    mb.cyl(c + V(0, -0.062, 0), c + V(0, 0.062, 0), 0.0105, 'Metal_Frame', n=10)
    mb.box(c + V(0.0, 0, 0.01), (0.07, 0.06, 0.05), 'Alu_Blue', bevel=0.008, segs=2)
    # roll hinge block and bearing housing on the rotor axis
    top = HUB.z - 0.09 - 0.012
    ax = V(HUB.x, 0, 0)
    mb.cyl(V(HUB.x - 0.06, 0, c.z + 0.04), V(HUB.x + 0.06, 0, c.z + 0.04), 0.017, 'Engine_Dark', n=14)
    mb.lathe([(0.0, c.z + 0.035), (0.052, c.z + 0.035), (0.058, c.z + 0.045), (0.058, top - 0.012), (0.046, top - 0.004),
              (0.034, top), (0.0, top)], ax, V(0, 0, 1), 'Engine', n=28)
    # control yoke: arm aft, cross bar with rod-end forks at the push rods
    za = PIVOT.z + 0.012
    ya = R.x(-0.165)
    mb.box(V((c.x + ya) * 0.5, 0, za), (c.x - ya + 0.03, 0.035, 0.022), 'Alu_Blue', bevel=0.005, segs=1)
    mb.box(V(ya, 0, za), (0.03, 0.13, 0.02), 'Alu_Blue', bevel=0.005, segs=1)
    for sy in (1, -1):
        mb.cyl(V(ya, sy * 0.05, za - 0.02), V(ya, sy * 0.05, za + 0.02), 0.011, 'Metal_Frame', n=10)
    return mb.finish(origin=PIVOT, sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotax 503 with B gearbox, fan shroud, dual carbs, tuned pipe and muffler
# ---------------------------------------------------------------------------
def build_engine():
    mb = MB('engine')
    zc = -1.38                                     # crankshaft axis
    # crankcase (cast aluminium) and magneto / recoil-starter housing at the front
    mb.box(P(-0.18, zc - 0.005), (0.34, 0.20, 0.12), 'Engine', bevel=0.03, segs=3)
    mb.lathe([(0.0, 0.0), (0.075, 0.0), (0.082, 0.01), (0.082, 0.05), (0.06, 0.07), (0.0, 0.075)], P(-0.01, zc),
             V(1, 0, 0), 'Engine', n=28)
    # cylinders under the fan shroud: shroud box with the axial fan housing at the front end
    mb.box(P(-0.18, -1.185), (0.30, 0.22, 0.25), 'Shroud_Black', bevel=0.03, segs=3)
    mb.box(P(-0.18, -1.31), (0.26, 0.17, 0.05), 'Engine', bevel=0.01, segs=1)            # cylinder bases
    for k in range(6):                                                                    # visible fins
        mb.box(P(-0.18, -1.30 + 0.0, 0) + V(0, 0, -0.01 + k * 0.0), (0.27, 0.18, 0.004), 'Engine', segs=1)
    mb.lathe([(0.0, 0.0), (0.09, 0.0), (0.098, 0.012), (0.098, 0.07), (0.088, 0.08), (0.0, 0.08)], P(-0.04, -1.15),
             V(1, 0, 0), 'Shroud_Black', n=32)
    mb.lathe([(0.0, 0.081), (0.05, 0.081), (0.05, 0.088), (0.0, 0.088)], P(-0.04, -1.15), V(1, 0, 0), 'Engine', n=20)
    mb.box(P(0.02, -1.265), (0.035, 0.06, 0.19), 'Shroud_Black', bevel=0.01, segs=1)      # belt cover
    # spark plugs and red caps on top of the heads
    for x in (-0.25, -0.11):
        mb.cyl(P(x, -1.06), P(x, -1.035), 0.012, 'Engine', n=10)
        mb.cyl(P(x, -1.035, 0.0), P(x - 0.02, -1.01, 0.03), 0.013, 'Polymer_Red', n=10)
        mb.cyl(P(x - 0.02, -1.01, 0.03), P(x - 0.06, -1.03, 0.10), 0.005, 'Engine_Dark', n=6)
    # intake side (right): rubber sockets, Bing carbs, blue pod filters
    for x in (-0.25, -0.11):
        mb.cyl(P(x, -1.24, -0.10), P(x, -1.24, -0.135), 0.03, 'Rubber', n=14)
        mb.cyl(P(x, -1.24, -0.135), P(x, -1.245, -0.20), 0.033, 'Engine', n=14)
        mb.box(P(x, -1.215, -0.17), (0.04, 0.04, 0.04), 'Engine', bevel=0.006, segs=1)        # float bowl / top
        mb.lathe([(0.0, 0.0), (0.035, 0.0), (0.05, 0.012), (0.05, 0.075), (0.04, 0.09), (0.0, 0.09)],
                 P(x, -1.245, -0.20), V(0, -1, 0), 'Filter_Blue', n=20)
    # exhaust side (left): manifold, expansion chamber down the left side, muffler across under the engine
    for x in (-0.25, -0.11):
        mb.tube(catmull([P(x, -1.23, 0.10), P(x, -1.25, 0.15), P(-0.19, -1.31, 0.18)], 4), 0.024, 'Engine_Dark', n=12)
    pts = [P(-0.19, -1.31, 0.18), P(-0.27, -1.36, 0.205), P(-0.35, -1.45, 0.21), P(-0.36, -1.56, 0.20),
           P(-0.30, -1.66, 0.17), P(-0.20, -1.69, 0.14), P(-0.13, -1.65, 0.12)]
    path = catmull(pts, 6)
    nn = len(path)
    rads = [0.028 + 0.034 * math.sin(math.pi * min(1.0, (i / (nn - 1)) * 1.15)) ** 1.3 for i in range(nn)]
    rads[-1] = 0.026
    mb.tube(path, rads, 'Engine_Dark', n=16)
    mb.lathe([(0.0, -0.13), (0.06, -0.13), (0.078, -0.11), (0.08, 0.10), (0.06, 0.125), (0.0, 0.125)],
             P(-0.12, -1.615, -0.01), V(0, 1, 0), 'Engine_Dark', n=24)
    mb.tube(catmull([P(-0.12, -1.64, -0.13), P(-0.14, -1.70, -0.16), P(-0.24, -1.73, -0.16)], 4), 0.018,
            'Steel_Exhaust', n=10)
    # B gearbox at the prop end: lower lobe on the crank, upper lobe on the prop shaft, output flange
    for zz, rr in ((zc, 0.085), (PROP_H[1], 0.07)):
        mb.lathe([(0.0, 0.0), (rr, 0.0), (rr + 0.006, 0.012), (rr + 0.006, 0.08), (rr, 0.095), (0.0, 0.095)],
                 P(-0.355, zz), V(-1, 0, 0), 'Engine', n=28)
    mb.box(P(-0.40, (zc + PROP_H[1]) * 0.5), (0.095, 0.15, 0.10), 'Engine', bevel=0.02, segs=2)
    mb.cyl(P(-0.45, PROP_H[1]), P(-0.505, PROP_H[1]), 0.035, 'Metal_Frame', n=16)
    # rubber engine mounts on the platform, CDI box, ignition coils
    for x in (-0.31, -0.05):
        for sy in (1, -1):
            mb.cyl(P(x, -1.48, sy * 0.11), P(x, -1.445, sy * 0.10), 0.02, 'Rubber', n=12)
    mb.box(P(-0.05, -1.31, 0.135), (0.10, 0.03, 0.07), 'Engine_Dark', bevel=0.006, segs=1)
    return mb.finish(sharp_angle=38, wn=True)


def build_tank():
    """5 US gal roto-moulded tank behind the mast, above the engine, on a bracket."""
    mb = MB('tank')
    mb.box(P(-0.072, -0.83), (0.18, 0.38, 0.23), 'Tank_White', bevel=0.04, segs=3)
    mb.cyl(P(-0.10, -0.715, 0.10), P(-0.10, -0.69, 0.10), 0.03, 'Engine_Dark', n=16)
    mb.cyl(P(-0.04, -0.94, -0.12), P(-0.04, -1.05, -0.14), 0.006, 'Rubber', n=6)
    for z in (-0.92, -0.74):
        mb.box(P(mast_x(z) - 0.015, z), (0.03, 0.40, 0.022), 'Alu_Blue', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Tail: fin + rudder (one big plate), stabiliser on the boom, two end plates under its tips
# ---------------------------------------------------------------------------
HINGE_B, HINGE_T = (-1.300, -2.168), (-1.235, -1.347)
FIN_T = 0.050
STAB_Z = -2.168


def fin_half(u):
    return 0.5 * FIN_T * naca_t(0.05 + 0.50 * u)


def rud_half(u):
    return 0.5 * FIN_T * naca_t(0.55 + 0.45 * u)


def build_tail():
    mb = MB('tail')
    plate(mb, [(-0.698, -2.172), HINGE_B], [(-0.975, -1.410), (-1.02, -1.392), HINGE_T],
          [(-0.698, -2.172), (-0.955, -1.47), (-0.975, -1.410)], [HINGE_B, HINGE_T], fin_half, nu=14, nv=12)
    # stabiliser on top of the boom
    loop = airfoil_ring(14, 0.07, te_min=0.002)
    rings = []
    span = 0.60
    for y in (-span, -0.5, -0.25, 0.0, 0.25, 0.5, span):
        le, te = -1.00, -1.40
        rings.append([P(le - s * (le - te), STAB_Z + tz * (le - te), y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # end plates (mostly under the stabiliser tips)
    for sy in (1, -1):
        plate(mb, [(-1.03, -2.255), (-1.06, -2.300), (-1.10, -2.312), (-1.34, -2.312), (-1.385, -2.30), (-1.40, -2.27)],
              [(-1.17, -2.02), (-1.41, -2.02)],
              [(-1.03, -2.255), (-1.17, -2.02)], [(-1.40, -2.27), (-1.41, -2.02)],
              lambda u: 0.5 * 0.022 * naca_t(0.05 + 0.9 * u), y0=sy * span, nu=12, nv=8)
    # boom saddle and fin root bracket, rudder hinge brackets on the fin
    mb.box(P(-1.20, STAB_Z - 0.022), (0.30, 0.07, 0.016), 'Metal_Frame', bevel=0.004, segs=1)
    mb.box(P(-0.75, -2.18), (0.10, 0.06, 0.02), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=45)


def rudder_origin():
    return P(lerp(HINGE_B[0], HINGE_T[0], 0.5), lerp(HINGE_B[1], HINGE_T[1], 0.5))


def build_rudder():
    mb = MB('rudder')
    te = [(-1.786, -2.027), (-1.851, -1.976), (-1.895, -1.90), (-1.909, -1.847), (-1.909, -1.722), (-1.82, -1.549),
          (-1.755, -1.521), (-1.601, -1.257)]
    plate(mb, [HINGE_B, (-1.786, -2.027)], [HINGE_T, (-1.601, -1.257)], [HINGE_B, HINGE_T], te, rud_half,
          nu=12, nv=16, ucos=False)
    # hinge brackets
    for t in (0.1, 0.5, 0.9):
        x, z = lerp(HINGE_B[0], HINGE_T[0], t), lerp(HINGE_B[1], HINGE_T[1], t)
        mb.box(P(x + 0.012, z), (0.05, 0.03, 0.025), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(origin=rudder_origin(), sharp_angle=45)


# ---------------------------------------------------------------------------
# Wheels
# ---------------------------------------------------------------------------
def main_wheel(name, sy):
    c = P(AXLE[0], AXLE[1], sy * MAIN_Y)
    mb = MB(name)
    mb.lathe(B.tire_profile(RM, 0.078, WM), c, V(0, 1, 0), 'Rubber', n=40, closed_profile=True)
    hw = WM * 0.5
    # spun aluminium two-piece rim, bolt circle, hub
    mb.lathe([(0.0, -hw * 0.55), (0.03, -hw * 0.55), (0.045, -hw * 0.40), (0.075, -hw * 0.55), (0.082, -hw * 0.75),
              (0.082, hw * 0.75), (0.075, hw * 0.55), (0.045, hw * 0.40), (0.03, hw * 0.55), (0.0, hw * 0.55)],
             c, V(0, 1, 0), 'Chrome', n=32)
    for k in range(6):
        a = TAU * k / 6
        p = c + V(math.cos(a) * 0.055, 0, math.sin(a) * 0.055)
        mb.cyl(p + V(0, -hw * 0.45, 0), p + V(0, hw * 0.45, 0), 0.0045, 'Metal_Frame', n=6)
    # brake disc inboard
    yi = -sy * (hw + 0.012)
    mb.lathe([(0.03, -0.003), (0.10, -0.003), (0.10, 0.003), (0.03, 0.003)], c + V(0, yi, 0), V(0, 1, 0),
             'Metal_Frame', n=32, closed_profile=True)
    return mb.finish(origin=c, sharp_angle=40)


def build_nose_wheel():
    """Nose wheel on a trailing link of two blue plates hanging from the pivot under the nose post."""
    c = P(*NOSE)
    mb = MB('nose_wheel')
    mb.lathe(B.tire_profile(RN, 0.052, WN), c, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    hw = WN * 0.5
    mb.lathe([(0.0, -hw * 0.6), (0.025, -hw * 0.6), (0.04, -hw * 0.4), (0.056, -hw * 0.7), (0.056, hw * 0.7),
              (0.04, hw * 0.4), (0.025, hw * 0.6), (0.0, hw * 0.6)], c, V(0, 1, 0), 'Chrome', n=28)
    piv = P(1.398, -2.205)
    for sy in (1, -1):
        y = sy * (hw + 0.018)
        mb.tube([c + V(0, y, 0), piv + V(0, y, 0)], 0.0, 'Alu_Blue', n=12, square=(0.035, 0.008, 4))
        for t in (0.25, 0.5, 0.75):                           # lightening holes as dark dots
            q = c.lerp(piv, t) + V(0, y + sy * 0.0045, 0)
            mb.cyl(q, q + V(0, sy * 0.001, 0), 0.007, 'Alu_Black', n=10)
    mb.cyl(c + V(0, -hw - 0.03, 0), c + V(0, hw + 0.03, 0), 0.009, 'Metal_Frame', n=10)
    mb.box(piv + V(0, 0, 0.01), (0.05, WN + 0.05, 0.035), 'Alu_Blue', bevel=0.006, segs=1)
    mb.cyl(piv + V(0, 0, 0.02), piv + V(0, 0, 0.065), 0.016, 'Metal_Frame', n=12)
    # elastomer spring between the link and the post
    mb.cyl(piv + V(-0.05, 0, -0.05), piv + V(-0.02, 0, 0.02), 0.016, 'Polymer_Red', n=10)
    return mb.finish(origin=c, sharp_angle=40)


# ---------------------------------------------------------------------------
# Seat, pilot, controls, instrument pod
# ---------------------------------------------------------------------------
HIP = (0.48, -1.63)
SEAT_BACK = 12.0
PILOT_BACK = 12.0


def build_seat():
    """Composite Cyber Seat: white shell (high back, deep sides), dark blue cushions."""
    mb = MB('seat')
    b = math.radians(SEAT_BACK)
    u = Vector((-math.sin(b), math.cos(b)))
    f = Vector((math.cos(b), math.sin(b)))
    H = Vector(HIP)
    corner = H - f * 0.135 - u * 0.075
    path = [corner + u * 0.56, corner + u * 0.30, corner + u * 0.06, corner + u * 0.0 + f * 0.04,
            corner + f * 0.12 + u * -0.01, H + Vector((0.20, -0.105)), H + Vector((0.34, -0.085))]
    path = [Vector(p) for p in catmull([V(p.x, 0, p.y) for p in path], 4)]
    path = [Vector((p.x, p.z)) for p in path]
    hw, side = 0.225, 0.10
    rings = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        nrm = Vector((-t.y, t.x))                            # toward the occupant
        if nrm.dot(H - p) < 0:
            nrm = -nrm
        s_ = side * (0.55 if i >= len(path) - 2 else 0.25 + 0.75 * min(1.0, i / (len(path) * 0.6)))
        outer, inner = [], []
        m = 10
        for k in range(m + 1):
            a = math.pi * k / m
            yy = math.cos(a) * hw
            dd = (1 - math.sin(a) ** 0.25) * s_
            outer.append(P(p.x + nrm.x * dd, p.y + nrm.y * dd, yy))
            inner.append(P(p.x + nrm.x * (dd + 0.012), p.y + nrm.y * (dd + 0.012), yy * 0.95))
        rings.append(outer + inner[::-1])
    mb.loft(rings, 'Seat_Shell', closed=True, cap0=True, cap1=True)
    # cushions
    bc = corner + u * 0.30 + f * 0.035
    mb.box(P(bc.x, bc.y), (0.05, 0.36, 0.50), 'Seat', bevel=0.02, segs=2, rot=Euler((0, -b, 0)))
    pc = H + Vector((0.13, -0.075))
    mb.box(P(pc.x, pc.y), (0.36, 0.36, 0.05), 'Seat', bevel=0.02, segs=2, rot=Euler((0, math.radians(-5), 0)))
    # seat mounts on the rails
    for x in (0.38, 0.70):
        z = lerp(-1.722, -2.055, (x - mast_x(-1.72)) / (1.30 - mast_x(-1.72)))
        mb.box(P(x, z + 0.04), (0.04, 0.16, 0.07), 'Alu_Blue', bevel=0.005, segs=1)
    return mb.finish(sharp_angle=50, wn=True)


POD_FACE = (1.155, -1.895)     # centre of the instrument face (hub frame)
POD_TILT = 40.0


def build_pod():
    """Small instrument pod on the seat rails between the pilot's shins (white glass-fibre box, black
    face tilted back toward the pilot)."""
    t = math.radians(POD_TILT)
    N = Vector((-math.cos(t), math.sin(t)))
    Vv = Vector((math.sin(t), math.cos(t)))
    c = Vector(POD_FACE) - N * 0.010
    a, b = c - Vv * 0.062, c + Vv * 0.062
    poly = [a, b, Vector((1.31, b.y + 0.005)), Vector((1.32, -2.04)), Vector((a.x + 0.01, -2.04))]
    hw = 0.072
    mb = MB('instr_pod')
    n = len(poly)
    c3 = [P(p.x, p.y, hw) for p in poly] + [P(p.x, p.y, -hw) for p in poly]
    faces = [list(range(n))[::-1], [n + i for i in range(n)]] + [[i, (i + 1) % n, n + (i + 1) % n, n + i]
                                                                   for i in range(n)]
    mb.faces(c3, faces, 'Paint_White', smooth=False)
    ob = mb.finish(sharp_angle=30)
    bev = ob.modifiers.new('bev', 'BEVEL')
    bev.width = 0.012
    bev.segments = 3
    bev.limit_method = 'ANGLE'
    K.apply_mods(ob)
    return ob


def build_controls_and_crew():
    ctrl = MB('controls_static')
    stick_base = P(0.925, -1.955)
    stick, grip, axis = controls.gyro_stick(stick_base, P(0.765, -1.375))
    ctrl.box(stick_base + V(0, 0, -0.01), (0.06, 0.16, 0.03), 'Alu_Blue', bevel=0.005, segs=1)
    # throttle quadrant on the left of the seat front, bracket down to the left rail
    tp = P(0.62, -1.64, 0.28)
    knob, lever = controls.throttle_lever(ctrl, tp, length=0.11)
    ctrl.cyl(tp + V(0, -0.02, -0.03), P(0.62, -1.79, 0.075), 0.008, 'Metal_Frame', n=8)
    feet = {'L': P(1.285, -1.905, 0.150), 'R': P(1.285, -1.905, -0.150)}
    pilot.build_pilot('pilot_front', P(*HIP), PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet=feet, knee_out=0.045, elbow_out=0.13, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.005))
    K.print_joints('pilot_front', R)
    pod = build_pod()
    face, F, poly = PANEL.build_panel(ctrl, P(*POD_FACE), POD_TILT, [], zone=(0.0, 0.004, 0.124, 0.066), cw=0.066,
                                      v_leg=-0.046, v_sb=-0.048, v_b=-0.054, top_arch=(0.068, 0.046, 0.052),
                                      max_u=0.068, leg_exp=0.4)
    # ignition key (the console is too small for the panel's own switch rows): lock on the face, under
    # the instruments, node `key` turning about the face normal
    kc = F.P(0.045, -0.040)
    Rk = F.R()
    ctrl.cyl(kc - F.N * 0.001, kc + F.N * 0.006, 0.0125, 'Metal_Frame', n=20)
    k = MB('key')
    piv = kc + F.N * 0.0065
    k.box(piv + F.N * 0.006, (0.003, 0.0085, 0.012), 'Metal_Frame', bevel=0.0008, segs=1, rot=Rk)
    k.box(piv + F.N * 0.019, (0.0045, 0.024, 0.015), 'Btn_Black', bevel=0.002, segs=1, rot=Rk)
    k.finish(origin=piv, sharp_angle=40)
    ctrl = ctrl.finish(sharp_angle=40)
    # eye from the pilot's head (as build_mt03)
    hip = P(*HIP)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    S = hip + u * pilot.SPINE
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    return ctrl, pod, stick_base, eye, face


# ---------------------------------------------------------------------------
# Faired variant: nose pod, windscreen, roof header (Vancraft / Sport Copter fairing)
# ---------------------------------------------------------------------------
FP_TIP = 1.625
FP_REAR = 0.58
FP_SILL = [(0.58, -1.800), (0.80, -1.765), (1.00, -1.725), (1.18, -1.675), (1.32, -1.630)]
WS_SIDE_X = 1.00
ROOF_Z = -0.700


def fp_params(X):
    if X > 1.32:
        t = (X - 1.32) / (FP_TIP - 1.32)
        w = 0.275 * max(0.0, 1 - t ** 2.2) ** 0.5
        zb = -2.19 + 0.20 * t ** 2.0
        zt = -1.62 - 0.27 * t ** 1.9
    else:
        t = (1.32 - X) / (1.32 - FP_REAR)
        w = 0.275 + 0.015 * math.sin(math.pi * min(1.0, t * 1.4))
        zb = -2.19 + 0.025 * t ** 2
        zt = -1.62 + 0.06 * math.sin(math.pi * t * 0.8)
    return w, zb, zt


def fp_ring(X, n=40, e=2.6):
    w, zb, zt = fp_params(X)
    zc, h = (zb + zt) * 0.5, (zt - zb) * 0.5
    return [P(X, zc + sgnpow(math.sin(TAU * k / n), 2 / e) * h, sgnpow(math.cos(TAU * k / n), 2 / e) * w)
            for k in range(n)]


def fp_y_at(X, Z, e=2.6):
    w, zb, zt = fp_params(X)
    zc, h = (zb + zt) * 0.5, (zt - zb) * 0.5
    s = max(-1.0, min(1.0, (Z - zc) / h))
    return w * (1 - abs(s) ** e) ** (1 / e)


def sill_z(X):
    for (x0, z0), (x1, z1) in zip(FP_SILL, FP_SILL[1:]):
        if x0 <= X <= x1:
            return lerp(z0, z1, (X - x0) / (x1 - x0))
    return FP_SILL[-1][1] if X > FP_SILL[-1][0] else FP_SILL[0][1]


def build_fairing():
    xs = [FP_REAR + (1.32 - FP_REAR) * k / 18 for k in range(19)]
    xs += [1.32 + (FP_TIP - 1.32) * (1 - math.cos(0.5 * math.pi * k / 12)) for k in range(1, 12)]
    rings = [fp_ring(x) for x in xs]
    w, zb, zt = fp_params(FP_TIP - 0.0005)
    rings.append([P(FP_TIP, (zb + zt) * 0.5, 0.0)])
    mb = MB('nosepod')
    mb.loft(rings, 'Paint_White', closed=True)
    pod = mb.finish(sharp_angle=70)
    # blue lightning bolt on both flanks (side-view polygon)
    bolt = [(0.66, -1.835), (1.06, -1.875), (1.01, -1.915), (1.52, -1.985), (1.07, -1.955), (1.115, -1.912),
            (0.66, -1.870)]
    K.paint_poly(pod, R.pts(bolt), 'Paint_Accent')
    rim = K.cut_openings(pod, [R.pts(FP_SILL)], rim_r=0.012, rim_mat='Rubber', thickness=0.008)
    # windscreen: from the pod rim (across the deck at X 1.32 and back along both sills) to the roof
    nf = 14
    front = []
    yw = fp_y_at(1.32, -1.632)
    for k in range(nf + 1):
        y = lerp(yw, -yw, k / nf)
        w_, zb_, zt_ = fp_params(1.32)
        zc, h = (zb_ + zt_) * 0.5, (zt_ - zb_) * 0.5
        s = (1 - (abs(y) / w_) ** 2.6) ** (1 / 2.6)
        front.append((1.32, zc + h * s + 0.003, y))
    side = []
    for k in range(1, 9):
        X = lerp(1.32, WS_SIDE_X, k / 8)
        Z = sill_z(X)
        side.append((X, Z + 0.004, fp_y_at(X, Z) + 0.004))
    base = [(x, z, y) for (x, z, y) in side[::-1]] + front + [(x, z, -y) for (x, z, y) in side]
    nb = len(base)
    # parametrise by arc length along the base, map onto the roof edge (corner, nose, corner)
    d = [0.0]
    for a, b in zip(base, base[1:]):
        d.append(d[-1] + math.dist(a, b))
    top = []
    for k in range(nb):
        s = d[k] / d[-1] * 2 - 1                                # -1 left .. +1 right
        y = -s * 0.215
        x = 0.805 - 0.085 * abs(s) ** 1.6
        top.append((x, ROOF_Z - 0.006 - 0.012 * abs(s) ** 2, y))
    nv = 12
    coords, faces = [], []
    for j in range(nv + 1):
        v = j / nv
        for k in range(nb):
            bx, bz, by = base[k]
            tx, tz, ty = top[k]
            x, z, y = lerp(bx, tx, v), lerp(bz, tz, v), lerp(by, ty, v)
            # bulge outward (forward + sideways) between the edges
            bul = 0.05 * math.sin(math.pi * v)
            sgn = 1 if by >= 0 else -1
            fwd = 1.0 - min(1.0, abs(by) / 0.30) ** 2
            x += bul * (0.6 + 0.4 * fwd)
            y += bul * sgn * (1 - fwd) * 0.8
            coords.append(P(x, z, y))
    for j in range(nv):
        for k in range(nb - 1):
            a = j * nb + k
            faces.append([a, a + 1, a + nb + 1, a + nb])
    ws = MB('windscreen_glass')
    ws.faces(coords, faces, 'Glass')
    ws.bm.normal_update()
    if sum(f.normal.x for f in ws.bm.faces) < 0:
        bmesh.ops.reverse_faces(ws.bm, faces=ws.bm.faces[:])
    glass = ws.finish(sharp_angle=80, recalc=False)
    sol = glass.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.004
    sol.offset = -1
    K.apply_mods(glass)
    # frame: black edge on the sides and top of the screen, screws along the base
    fr = MB('ws_frame')
    for k0 in (0, nb - 1):
        fr.tube([coords[j * nb + k0] for j in range(nv + 1)], 0.008, 'Paint_Dark', n=8)
    fr.tube([coords[nv * nb + k] for k in range(nb)], 0.008, 'Paint_Dark', n=8)
    for k in range(0, nb, 2):
        p = coords[k]
        fr.sphere(p + V(0, 0, 0.004), 0.0045, 'Metal_Frame', seg=8, rings=4)
    frame = fr.finish(sharp_angle=60)
    # roof header: top plate from the screen to the mast with side skirts deepening toward the mast
    rf = MB('roof')
    xs = [0.83, 0.75, 0.62, 0.48, 0.34, 0.20, mast_x(ROOF_Z) + 0.03]
    rings = []
    for x in xs:
        t = (0.83 - x) / (0.83 - xs[-1])
        hw = lerp(0.225, 0.14, t ** 1.2)
        dep = 0.035 + 0.15 * max(0.0, (t - 0.45) / 0.55) ** 1.4
        z0 = ROOF_Z
        ring = []
        m = 6
        # outer: skirt bottom L -> up -> across the top (slightly crowned) -> down -> skirt bottom R
        ring.append(P(x, z0 - dep, hw))
        for k in range(m + 1):
            yy = lerp(hw, -hw, k / m)
            ring.append(P(x, z0 + 0.012 * (1 - (yy / hw) ** 2), yy))
        ring.append(P(x, z0 - dep, -hw))
        ring.append(P(x, z0 - dep, -hw + 0.012))
        for k in range(m, -1, -1):
            yy = lerp(hw - 0.012, -hw + 0.012, k / m)
            ring.append(P(x, z0 - 0.018, yy))
        ring.append(P(x, z0 - dep, hw - 0.012))
        rings.append(ring)
    rf.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # bracket to the mast, beacon on top
    rf.box(P(mast_x(ROOF_Z) + 0.02, ROOF_Z - 0.05), (0.06, 0.10, 0.10), 'Alu_Blue', bevel=0.006, segs=1)
    K.lamp(rf, P(0.46, ROOF_Z + 0.012), V(0, 0, 1), kind='amber', r=0.04, length=0.08)
    roof = rf.finish(sharp_angle=50, wn=True)
    # amber rotating beacon on the roof: the only light on the Vancraft photos (faired_front3q_flight_VANCRAFT,
    # faired_rear3q_flight_VANCRAFT_RAC); the open Lightning photos show no lights at all, so it declares none
    K.lamp_node('beacon', P(0.46, ROOF_Z + 0.115), 'amber')
    return pod, rim, glass, frame, roof


def build_min_lights():
    """MINIMUM SET, NOT ON THE PHOTOS (the open Lightning shows no lights at all and the Vancraft only its
    roof beacon): the owner asked for at least landing + nav + one anti-collision light on every aircraft,
    so that it can be flown and seen at night in the sim. Landing lamp on the nose (keel end / fairing
    tip), nav lamps on the outer faces of the stabiliser end plates and, on the open one, a white strobe
    on top of the fin (the faired one has its amber roof beacon)."""
    mb = MB('min_lights')
    if FAIRED:
        w, zb, zt = fp_params(FP_TIP - 0.0005)
        p = P(FP_TIP - 0.014, 0.5 * (zb + zt))
    else:
        p = P(1.402, -2.06)        # front face of the nose post block
    K.lamp(mb, p, V(1, 0, -0.06), kind='white', r=0.026, length=0.026, base='Engine_Dark')
    K.lamp_node('landing', p + V(0.06, 0, -0.004))
    for sy, kind in ((1, 'red'), (-1, 'green')):
        q = P(-1.20, -2.12, sy * 0.612)
        K.lamp(mb, q, V(0, sy, 0), kind=kind, r=0.016, length=0.02)
        K.lamp_node('navL' if sy > 0 else 'navR', q + V(0, sy * 0.045, 0))
    if not FAIRED:
        t = P(-1.00, -1.398)
        K.lamp(mb, t, V(0, 0, 1), kind='white', r=0.016, length=0.026)
        K.lamp_node('beacon', t + V(0, 0, 0.055))
    return mb.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
def build_all():
    mats()
    frame = build_frame()
    mtop = build_mast_top()
    build_head()
    K.build_rotor(HUB, R=ROTOR_R, chord=ROTOR_C, root=0.40, tc=0.12, tip_mat='Rotor_Blade', mat='Rotor_Blade',
                  clamp_len=0.36, tower_h=0.09, under=0.04, bar_w=0.09, bar_mat='Engine', clamp_mat='Alu_Black',
                  tip_len=0.12)
    engine = build_engine()
    K.build_prop(PROP, R=PROP_R, blades=2, hub='flange', mat='Wood', tip_mat='Wood', chord_k=1.25, pitch=0.81,
                 hub_r=0.075, tip_band=0.05)
    tank = build_tank()
    tail = build_tail()
    build_rudder()
    tw = build_tail_wheel()
    main_wheel('wheel_L', 1)
    main_wheel('wheel_R', -1)
    build_nose_wheel()
    seat = build_seat()
    ctrl, pod, stick_base, eye, face = build_controls_and_crew()
    static = [frame, mtop, engine, tank, tail, tw, seat, ctrl, pod, build_min_lights()]
    glass = []
    if FAIRED:
        fpod, frim, fglass, fframe, roof = build_fairing()
        static += [fpod, frim, fframe, roof]
        glass.append(fglass)
        K.clearance(['pilot_front'], [fpod, fglass, roof], ' (fairing)')
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [face, ctrl, pod, frame], ' (legs)')
    K.clearance(['pilot_front_torso', 'pilot_front_arm'], [seat, frame, mtop], ' (torso)')
    K.finalize(static, glass)
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': rudder_origin(), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': P(*NOSE), 'wheel_L': P(AXLE[0], AXLE[1], MAIN_Y),
        'wheel_R': P(AXLE[0], AXLE[1], -MAIN_Y),
    })

    def m(v):
        return '(%.3f, %.3f, %.3f)' % (v.x, v.z, -v.y)
    print('SCL %s model (x fwd, y up, z right): hub %s pivot %s prop %s R %.3f' % (NAME, m(HUB), m(PIVOT), m(PROP),
                                                                                    PROP_R))
    print('SCL cg hub-frame (%.3f, %.3f) -> model (0.08, 0.10); ground y %.3f; eye %s' % (CG[0], CG[1], R.z(GROUND),
                                                                                       m(eye)))
    print('SCL nose contact %s main contact %s / %s' % (m(P(NOSE[0], GROUND)), m(P(AXLE[0], GROUND, MAIN_Y)),
                                                       m(P(AXLE[0], GROUND, -MAIN_Y))))


if __name__ == '__main__':
    views = {
        'thumb': dict(extra=True, loc=(4.1, -4.4, 3.3), target=(-0.15, 0.0, 0.15), lens=38, rotor=-25, prop=10),
        'three_quarter_front': dict(loc=(5.6, 4.7, 1.9), target=(-0.2, 0.0, 0.25), lens=33, rotor=-58, prop=20),
        'rear_three_quarter': dict(loc=(-5.8, -4.9, 2.2), target=(-0.3, 0.0, 0.3), lens=35, rotor=-40, prop=40),
        # the angles of the reference photos
        'photo_flight': dict(extra=True, loc=(-2.4, -14.0, 1.4), target=(0.0, 0.0, 0.25), lens=70, rotor=-20, prop=60),
        'photo_n403': dict(extra=True, loc=(-1.6, -6.2, 0.6), target=(-0.1, 0.0, 0.1), lens=33, rotor=-30, prop=80),
        'photo_brochure_l': dict(extra=True, loc=(3.0, 5.4, 1.4), target=(-0.2, 0.0, 0.1), lens=35, rotor=60, prop=80),
        'photo_brochure_f': dict(extra=True, loc=(4.6, 2.6, 2.0), target=(0.1, 0.0, -0.1), lens=35, rotor=60, prop=80),
        'photo_vancraft': dict(extra=True, loc=(5.2, -3.4, 0.2), target=(0.0, 0.0, 0.1), lens=40, rotor=40, prop=60),
        'tail_detail': dict(extra=True, loc=(-0.4, -3.0, 0.4), target=(-1.8, 0.0, -0.45), lens=40, rotor=75, prop=10),
        'lamp_min': dict(extra=True, loc=(2.5, -1.1, -0.45), target=(1.25, 0.0, -0.64), lens=70, rotor=40, prop=20),
        'lamp_roof': dict(extra=True, loc=(2.6, -1.9, 1.4), target=(0.3, 0.0, 0.55), lens=50, rotor=40, prop=20),
        'nose_detail': dict(extra=True, loc=(2.8, -2.0, 0.4), target=(1.1, 0.0, -0.55), lens=40, rotor=75, prop=15),
        'engine_detail': dict(extra=True, loc=(-2.6, -1.9, 0.6), target=(-0.6, 0.0, 0.0), lens=40, rotor=75, prop=30),
        'engine_left': dict(extra=True, loc=(-2.4, 2.1, 0.5), target=(-0.6, 0.0, 0.0), lens=40, rotor=75, prop=30),
        'head_detail': dict(extra=True, loc=(1.4, -1.4, 1.9), target=(-0.15, 0.0, 1.2), lens=50, rotor=75, prop=0),
        'cockpit': dict(extra=True, loc=(1.6, 1.4, 1.1), target=(0.6, 0.0, -0.3), lens=32, rotor=75, prop=0),
    }
    K.run(NAME, build_all, LIVERY, views=views, rest_ground=R.z(GROUND))
