"""
Wallis WA-116 "Agile" (Wing Commander Ken Wallis, Reymerston Hall, Norfolk): the prototype G-ARRT,
first flown on 2 August 1961, as it is preserved today (white glass-fibre nacelle with the two teal
stripes, "Wallis" and "Air BP" titles, LODGE badge on the fin). Same airframe as the Beagle-built
WA-116 Srs.1 batch (G-ARZA, G-ARZB "Little Nellie"...): single-seat open-cockpit autogyro with a short
nacelle, a single tubular keel running from the nose-wheel post to the tail, a forward-raked mast
carrying the Wallis offset-gimbal head, a 72 hp McCulloch 4318A flat-four two-stroke (target-drone
engine, direct drive) hung behind the mast with its two long cylinder-bank cooling shrouds, a 48 in
two-blade pusher with a small white spinner, main wheels on a transverse axle beam braced to the mast,
a castoring nose wheel, a big D-shaped fin with a large horn-balanced rudder and a small tailplane
across the fin.

Traced in the HUB FRAME (gyrokit.py) from three photos of G-ARRT (Mike Burdett, Flickr, CC BY-SA:
side_arrt_R = right side seen 18 deg from behind, on its trailer; arrt_fr2 = front-right 3/4;
arrt_fr1 = front-left 3/4) whose pinhole cameras were solved TOGETHER (bundle adjustment of 17 common
points, rms 2.6 px; scale from the published height 6 ft 1 in to the top of the head, which gives an
overall length of 3.32 m against the published 3.38 m); outlines back-projected on the centre plane.
G-ARZB / G-AVDG / G-SCAN photos for the parts the G-ARRT photos do not show (rudder split, seat,
panel, stick, gear structure).

  blender -b -P blender/build_wa116.py -- [--previews] [--only VIEW,...] [--samples N] [--show-rear]
          [--overlay yaw,cx,cz,ppm,w,h[,side]] [--overlay-out path]
Outputs: public/models/wa116.glb, blender/wa116.blend, blender/previews/wa116/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, sgnpow, pilot, controls, PANEL  # noqa: E402

NAME = 'wa116'

# ---- hub frame (X forward, Z up, origin on the teeter bolt, metres) ------------------------------
GROUND = -1.820                      # published height 6 ft 1 in to the top of the head (bolt + 3 cm)
NOSE_TIP = (1.715, -1.335)
AXLE = (0.141, -1.720)               # main axle (bundle adjustment: X 0.141, track 1.54 m)
RM, WM, MAIN_Y = 0.100, 0.075, 0.760  # small 8 in tyres
NOSE = (1.114, -1.725)               # nose-wheel axle
RN, WN = 0.095, 0.062
PIVOT_H = (0.100, -0.222)            # mast top: pitch pivot of the head
MAST_FOOT = (-0.160, -1.580)         # the mast is raked 11 deg forward (photos T, F1, F2)
PROP_H = (-0.625, -0.960)            # McCulloch crankshaft axis, direct drive
PROP_R = 0.610                       # 48 in two-blader (BMT: 1.2 m)
ROTOR_R, ROTOR_C = 3.100, 0.178      # 20 ft 4 in rotor; 7 in chord (Bensen-class blades, not measured)
ENG_Z = -0.958
SHROUD_Y, SHROUD_R = 0.210, 0.128
TP_Z = -0.960                        # tailplane across the fin


def keel_z(X):
    """Keel tube centre line (straight, 4.4 deg nose-up): F2 back-projection."""
    return -1.585 + 0.0767 * (X - 0.099)


def mast_x(Z):
    return MAST_FOOT[0] + (Z - MAST_FOOT[1]) * (PIVOT_H[0] - MAST_FOOT[0]) / (PIVOT_H[1] - MAST_FOOT[1])


# ---- centre of gravity -------------------------------------------------------------------------
# Height from a mass build-up (hub frame Z, kg): pilot 85 @ -1.13 (H-point -1.335 + 0.2), McCulloch
# 4318A + exhaust + mount 42 @ -0.95, fuel 26 @ -1.20 (58 lb, tank in the nacelle behind the seat),
# rotor + head 30 @ -0.03, nacelle 12 @ -1.28, keel / mast / struts 20 @ -1.25, gear 10 @ -1.66,
# tail 5 @ -1.25, seat + controls 4 @ -1.32, prop 3 @ -0.96  ->  237 kg (MTOW 249 kg), h = 1.007 m.
# Single-seat convention of the sim (as the Sport Copter): CG ahead of the hub by 0.19 h.
H_CG = 1.007
CG = (0.19 * H_CG, -H_CG)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(*PIVOT_H)
PROP = R(*PROP_H)

LIVERY = dict(body=('#F1F0EA', 0.0, 0.22), accent=('#3EAFB6', 0.0, 0.28), dark=('#1C1E21', 0.2, 0.4),
              seat=('#2A2C30', 0.0, 0.8))


def P(X, Z, y=0.0):
    return R(X, Z, y)


def mats():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Teal_Dark', '#16747D', rough=0.3)
    mk('Frame_Alu', '#C9C5B8', metal=0.55, rough=0.42)      # weathered light-alloy tubes
    mk('Shroud_Alu', '#B9BCBE', metal=0.9, rough=0.32)
    mk('Prop_White', '#EEE9DA', rough=0.35)
    mk('Tip_Red', '#C7261E', rough=0.35)
    mk('Lodge_Yellow', '#E8B820', rough=0.35)
    mk('Lever_Blue', '#2453A6', rough=0.35)
    mk('Smoke_Glass', '#6B7176', rough=0.05, alpha=0.35)


def tube(mb, a, b, r=0.016, mat='Frame_Alu', n=12):
    mb.cyl(P(*a), P(*b), r, mat, n=n)


def tube3(mb, a, b, r=0.016, mat='Frame_Alu', n=12):
    """a, b = (X, Y, Z) hub frame."""
    mb.cyl(R(a[0], a[2], a[1]), R(b[0], b[2], b[1]), r, mat, n=n)


# ---------------------------------------------------------------------------
# Nacelle (glass-fibre pod): stations traced on the solved photos (Y = 0 silhouettes)
# ---------------------------------------------------------------------------
#      X      top     shoulder z  half-w  chine z  half-w  bottom
POD_ROWS = [
    (1.66, -1.272, -1.305, 0.046, -1.348, 0.052, -1.392),
    (1.60, -1.180, -1.275, 0.092, -1.356, 0.096, -1.420),
    (1.50, -1.130, -1.250, 0.130, -1.362, 0.134, -1.443),
    (1.38, -1.078, -1.225, 0.158, -1.368, 0.160, -1.462),
    (1.20, -1.010, -1.190, 0.182, -1.370, 0.182, -1.475),
    (1.00, -0.945, -1.160, 0.198, -1.370, 0.196, -1.480),
    (0.88, -0.895, -1.140, 0.208, -1.368, 0.204, -1.484),
    (0.74, -0.900, -1.120, 0.214, -1.362, 0.212, -1.486),
    (0.55, -0.960, -1.095, 0.220, -1.348, 0.220, -1.478),
    (0.32, -1.030, -1.095, 0.222, -1.322, 0.224, -1.447),
    (0.10, -1.058, -1.115, 0.214, -1.300, 0.218, -1.420),
    (-0.10, -1.072, -1.128, 0.198, -1.285, 0.204, -1.402),
    (-0.24, -1.082, -1.140, 0.178, -1.276, 0.184, -1.392),
    (-0.33, -1.090, -1.148, 0.160, -1.272, 0.165, -1.388),
]
POD = E.Fuselage(R.table(POD_ROWS), tip=(R.x(NOSE_TIP[0]), R.z(NOSE_TIP[1])), nt=2.2, nb=2.0, bow=0.004,
                 nose_exp=0.55)
# cockpit sill (side wall top edge, traced at y = -0.21) and the arch of the cowl's rear edge
SILL = [(0.10, -1.140), (0.230, -1.142), (0.329, -1.132), (0.428, -1.119), (0.500, -1.102), (0.600, -1.082),
        (0.686, -1.036), (0.787, -0.989), (0.86, -0.95)]
COCKPIT_REAR = 0.095


def sill_z(X):
    for (x0, z0), (x1, z1) in zip(SILL, SILL[1:]):
        if x0 <= X <= x1:
            return lerp(z0, z1, (X - x0) / (x1 - x0))
    return SILL[0][1] if X < SILL[0][0] else SILL[-1][1]


def cowl_rear_x(y):
    return 0.740 + 0.060 * min(1.0, abs(y) / 0.24) ** 2


def cut_cockpit(pod):
    """Open cockpit: faces above the sill between the seat back and the arched rear edge of the
    instrument cowl are removed; padded rim, inner skin (as K.cut_polys, custom predicate)."""
    me = pod.data
    bm = bmesh.new()
    bm.from_mesh(me)
    planes = [E.plane_pts((R.x(a[0]), R.z(a[1])), (R.x(b[0]), R.z(b[1]))) for a, b in zip(SILL, SILL[1:])]
    planes.append((V(R.x(COCKPIT_REAR), 0, 0), V(1, 0, 0)))
    E.bisect_all(bm, planes)
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        f.smooth = True
        X, Z = c.x - R.dx, c.z - R.dz
        if COCKPIT_REAR < X < cowl_rear_x(c.y) and Z > sill_z(X):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    n_outer = len(me.materials)
    rim = E.opening_rim(pod, 'cockpit_rim', r=0.011, mat='Paint_Dark', inset=0.004)
    E.thicken_shell(pod, n_outer, 0.010)
    return rim


def build_pod():
    pod = POD.shell('pod', step=0.03, n_half=36, rear=((0.010, 0.93), (0.020, 0.76), (0.026, 0.48)))
    # livery (traced on T and F2): light teal band whose top edge sweeps up over the nose cap, a white
    # line, a dark teal band; both bands wrap round the nose tip
    light = [(-0.6, -1.218), (0.73, -1.221), (1.33, -1.206), (1.45, -1.192), (1.55, -1.172), (1.80, -1.160),
             (1.80, -1.292), (1.55, -1.276), (1.33, -1.258), (0.73, -1.271), (-0.6, -1.276)]
    dark = [(-0.6, -1.302), (0.73, -1.295), (1.33, -1.275), (1.55, -1.292), (1.80, -1.305),
            (1.80, -1.372), (1.55, -1.352), (1.33, -1.342), (0.73, -1.356), (-0.6, -1.352)]
    K.paint_poly(pod, R.pts(light), 'Paint_Accent')
    K.paint_poly(pod, R.pts(dark), 'Teal_Dark')
    rim = cut_cockpit(pod)
    return pod, rim


def build_windscreen(pod):
    """Small smoked screen on the rear edge of the instrument cowl (photos T, F1; G-ARZB front view)."""
    ws, fr = E.windscreen('ws', pod, R.x(0.905), R.x(0.835), 0.178, 0.150, 46, nu=24, nv=8)
    ws.data.materials.clear()
    ws.data.materials.append(MATS['Glass'])
    return ws, fr


# ---------------------------------------------------------------------------
# Frame: keel, mast, main gear (axle beam + struts to the mast), nose-gear post, engine mount
# ---------------------------------------------------------------------------
def build_frame():
    mb = MB('frame')
    A = 'Frame_Alu'
    # keel: round tube from the nose-gear post under the nacelle to the tail skid
    k0, k1 = 1.12, -1.50
    mb.cyl(P(k0, keel_z(k0)), P(k1, keel_z(k1)), 0.023, A, n=16)
    mb.lathe([(0.0, 0.0), (0.025, 0.0), (0.025, 0.010), (0.0, 0.014)], P(k1, keel_z(k1)), V(-1, 0, 0.0),
             'Engine_Dark', n=14)
    # tail skid shoe under the keel end
    mb.tube([P(-1.30, keel_z(-1.30) - 0.01), P(-1.44, keel_z(-1.44) - 0.045), P(-1.51, keel_z(-1.51) - 0.030)],
            0.0, 'Engine_Dark', n=10, square=(0.030, 0.012, 4))
    # mast: rectangular light-alloy tube raked forward, from the keel to the head
    top = (PIVOT_H[0], PIVOT_H[1] - 0.035)
    mb.tube([P(*MAST_FOOT), P(*top)], 0.0, A, n=24, square=(0.062, 0.050, 6))
    # foot gusset plates on the keel
    for sy in (1, -1):
        pl = [(-0.28, keel_z(-0.28) - 0.01), (-0.05, keel_z(-0.05) - 0.01), (-0.10, -1.48), (-0.17, -1.46)]
        c = [P(x, z, sy * 0.030) for x, z in pl]
        mb.faces(c + [q + V(0, sy * 0.005, 0) for q in c],
                 [[3, 2, 1, 0] if sy > 0 else [0, 1, 2, 3], [4, 5, 6, 7] if sy > 0 else [7, 6, 5, 4]] +
                 [[i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i] for i in range(4)], A, smooth=False)
    # pivot fork (two cheek plates) at the mast top
    for sy in (1, -1):
        mb.box(P(PIVOT_H[0] - 0.005, PIVOT_H[1] - 0.030, sy * 0.034), (0.070, 0.008, 0.075), A, bevel=0.006, segs=1,
               rot=K.rot_y(-11))
    mb.cyl(P(PIVOT_H[0], PIVOT_H[1], 0.045), P(PIVOT_H[0], PIVOT_H[1], -0.045), 0.009, 'Metal_Frame', n=10)
    # main gear: transverse axle beam under the keel, two posts to the keel, long struts to the mast
    ax, az = AXLE
    yb = MAIN_Y - WM * 0.5 - 0.012
    zb = az + 0.012
    mb.cyl(P(ax, zb, yb), P(ax, zb, -yb), 0.021, A, n=14)
    for sy in (1, -1):
        mb.cyl(P(ax, zb, sy * 0.10), P(ax - 0.01, keel_z(ax) - 0.01, sy * 0.012), 0.016, A, n=12)
        # long strut from the axle end up to the front of the mast (triangulated on T + F2: meets the
        # centre plane at Z -0.875, 5 cm ahead of the mast axis)
        zs = -0.875
        mb.cyl(P(ax, zb, sy * (yb - 0.02)), P(mast_x(zs) + 0.035, zs, sy * 0.020), 0.016, A, n=12)
        # drag brace from the axle end forward to the keel under the seat
        mb.cyl(P(ax + 0.01, zb, sy * (yb - 0.03)), P(0.52, keel_z(0.52) - 0.01, sy * 0.015), 0.012, A, n=10)
        # stub axle, fork plate
        mb.cyl(P(ax, az, sy * (yb - 0.01)), P(ax, az, sy * (MAIN_Y + WM * 0.5 + 0.012)), 0.011, 'Metal_Frame', n=10)
        mb.box(P(ax, az + 0.02, sy * (yb + 0.004)), (0.06, 0.008, 0.07), A, bevel=0.004, segs=1)
    mb.box(P(ax - 0.005, keel_z(ax) - 0.03), (0.06, 0.05, 0.05), A, bevel=0.006, segs=1)
    mb.box(P(mast_x(-0.875) + 0.030, -0.875), (0.03, 0.07, 0.05), A, bevel=0.005, segs=1)
    mb.cyl(P(mast_x(-0.875) + 0.035, -0.875, 0.045), P(mast_x(-0.875) + 0.035, -0.875, -0.045), 0.008, 'Metal_Frame', n=8)
    # nose-gear post: steering bushing where the keel meets the nacelle bottom
    nx = NOSE[0] + 0.01
    mb.cyl(P(nx, keel_z(nx) - 0.03), P(nx, keel_z(nx) + 0.05), 0.024, A, n=14)
    # seat frame: cross tubes on the keel, seat back frame to the mast
    for x in (0.18, 0.45):
        mb.cyl(P(x, keel_z(x) + 0.03, 0.17), P(x, keel_z(x) + 0.03, -0.17), 0.010, A, n=8)
    # engine mount: two pairs of tubes from the mast to the crankcase front, a lower one to the keel
    for zz in (-0.86, -1.05):
        for sy in (1, -1):
            mb.cyl(P(mast_x(zz) - 0.02, zz, sy * 0.028), P(-0.13, zz + (ENG_Z - zz) * 0.3, sy * 0.075), 0.011, A, n=10)
    mb.cyl(P(-0.30, keel_z(-0.30) + 0.02), P(-0.30, ENG_Z - 0.09), 0.013, A, n=10)
    # mast braces: from the rear of the head box down and forward to the seat-back cross tube
    # (the X with the mast seen in T; back-projected: (-0.27, -0.21) -> (0.10, -1.04))
    for sy in (1, -1):
        mb.cyl(P(-0.150, -0.205, sy * 0.045), P(0.095, -1.060, sy * 0.105), 0.014, A, n=12)
    mb.cyl(P(0.095, -1.060, 0.12), P(0.095, -1.060, -0.12), 0.012, A, n=10)
    # fin brace (keel -> fin mid-chord) and tailplane braces (fin root -> tailplane underside)
    mb.cyl(P(-0.55, keel_z(-0.55) + 0.01), P(-0.88, -1.22), 0.009, A, n=8)
    for sy in (1, -1):
        mb.cyl(P(-1.03, -1.13, sy * 0.013), P(-1.03, TP_Z - 0.010, sy * 0.30), 0.0055, A, n=8)
    return mb.finish(sharp_angle=40, wn=True)


def build_controls_rods():
    """Control arm of the head reaches aft; two push rods from it down to the bellcrank on the mast."""
    mb = MB('ctrl_rods')
    for sy in (1, -1):
        a = P(-0.255, -0.215, sy * 0.034)
        b = P(mast_x(-0.62) - 0.03, -0.62, sy * 0.046)
        mb.cyl(a, b, 0.0075, 'Metal_Frame', n=8)
        mb.cyl(b, b + (b - a).normalized() * 0.035, 0.010, 'Engine_Dark', n=8)
    mb.box(P(mast_x(-0.64) - 0.03, -0.64), (0.05, 0.11, 0.04), 'Frame_Alu', bevel=0.006, segs=1)
    # push-pull tube from the bellcrank down the front of the mast to the stick under the seat
    mb.cyl(P(mast_x(-0.66) + 0.01, -0.66), P(mast_x(-1.30) + 0.04, -1.30), 0.009, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotor head (Wallis offset gimbal): long fabricated box on the mast-top pivot, the rotor bearing
# 10 cm behind the pivot, control arm aft, blue lever forward
# ---------------------------------------------------------------------------
def build_head():
    mb = MB('rotor_head')
    c = PIVOT
    # side plates of the box (seen in T: X -0.17 .. +0.12, Z -0.21 .. -0.09)
    prof = [(-0.172, -0.110), (-0.164, -0.198), (0.075, -0.208), (0.118, -0.172), (0.117, -0.088),
            (-0.10, -0.088)]
    for sy in (1, -1):
        pts = [P(x, z, sy * 0.058) for x, z in prof]
        n = len(pts)
        mb.faces(pts + [q - V(0, sy * 0.007, 0) for q in pts],
                 [list(range(n))[::-1] if sy > 0 else list(range(n)), [n + i for i in range(n)] if sy > 0 else
                  [n + i for i in range(n)][::-1]] + [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)],
                 'Frame_Alu', smooth=False)
    # top plate, front and rear closures
    mb.box(P(-0.028, -0.092), (0.29, 0.118, 0.008), 'Frame_Alu', bevel=0.003, segs=1)
    mb.box(P(-0.168, -0.150), (0.010, 0.118, 0.10), 'Frame_Alu', bevel=0.003, segs=1)
    # gimbal axle through the cheeks (pitch pivot) and roll hinge block
    mb.cyl(c + V(0, 0.07, 0), c - V(0, 0.07, 0), 0.012, 'Metal_Frame', n=12)
    for sy in (1, -1):
        mb.cyl(c + V(0, sy * 0.066, 0), c + V(0, sy * 0.074, 0), 0.020, 'Engine', n=14)
    # rotor bearing housing under the hub, on top of the box
    mb.lathe([(0.0, -0.090), (0.048, -0.090), (0.052, -0.082), (0.050, -0.062), (0.040, -0.056), (0.0, -0.056)],
             V(HUB.x, 0, 0) + V(0, 0, HUB.z - 0.0), V(0, 0, 1), 'Engine', n=24)
    # bolts on the side plates
    for (x, z) in ((-0.13, -0.12), (-0.13, -0.18), (0.0, -0.12), (0.06, -0.19), (0.09, -0.12)):
        for sy in (1, -1):
            mb.cyl(P(x, z, sy * 0.058), P(x, z, sy * 0.066), 0.006, 'Metal_Frame', n=6)
    # control arm aft + cross bar with the rod-end forks
    mb.box(P(-0.215, -0.205), (0.11, 0.030, 0.020), 'Frame_Alu', bevel=0.004, segs=1)
    mb.box(P(-0.255, -0.205), (0.022, 0.090, 0.022), 'Frame_Alu', bevel=0.004, segs=1)
    for sy in (1, -1):
        mb.cyl(P(-0.255, -0.18, sy * 0.034), P(-0.255, -0.23, sy * 0.034), 0.009, 'Metal_Frame', n=8)
    # blue lever forward on the right (rotor brake / spin-up clutch)
    a, b = P(0.115, -0.120, -0.045), P(0.273, -0.141, -0.043)
    mb.cyl(a, a.lerp(b, 0.55), 0.008, 'Metal_Frame', n=8)
    mb.cyl(a.lerp(b, 0.55), b, 0.011, 'Lever_Blue', n=10)
    mb.sphere(b, 0.011, 'Lever_Blue', seg=10, rings=6)
    # spin-up drive: right-angle box at the rear of the bearing, where the flexible shaft arrives
    mb.box(P(-0.085, -0.075), (0.06, 0.05, 0.035), 'Engine_Dark', bevel=0.006, segs=1)
    return mb.finish(origin=PIVOT, sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# McCulloch 4318A: crankcase on the centre line, a long cooling shroud over each pair of cylinders
# (open intake in front, flanged rear), carburettor and white intake bell on top, plug leads,
# short exhaust stubs underneath, flywheel / starter in front, prop flange aft
# ---------------------------------------------------------------------------
def build_engine():
    mb = MB('engine')
    x0, x1 = -0.585, -0.110
    mb.box(P(-0.35, ENG_Z), (0.40, 0.17, 0.17), 'Engine', bevel=0.03, segs=3)
    for sy in (1, -1):
        c0 = P(x0, ENG_Z, sy * SHROUD_Y)
        L = x1 - x0
        prof = [(0.0, -0.010), (SHROUD_R * 0.55, -0.010), (SHROUD_R * 0.86, 0.004), (SHROUD_R + 0.006, 0.018),
                (SHROUD_R + 0.006, 0.030), (SHROUD_R, 0.036), (SHROUD_R, L - 0.05), (SHROUD_R * 0.97, L - 0.02),
                (SHROUD_R * 0.90, L), (SHROUD_R * 0.80, L - 0.006), (SHROUD_R * 0.78, L - 0.03)]
        mb.lathe(prof, c0, V(1, 0, 0), 'Shroud_Alu', n=32)
        # dark intake throat (fins behind the open front)
        mb.lathe([(SHROUD_R * 0.78, L - 0.03), (SHROUD_R * 0.70, L - 0.06), (0.0, L - 0.06)], c0, V(1, 0, 0),
                 'Engine_Dark', n=24)
        # rivet line along the shroud seam, flange bolts
        for k in range(7):
            x = x0 + 0.06 + k * 0.055
            mb.sphere(P(x, ENG_Z + SHROUD_R * 0.70, sy * (SHROUD_Y + SHROUD_R * 0.71)), 0.004, 'Metal_Frame', seg=6,
                      rings=4)
        # spark plugs on the outer face + black leads forward to the magneto
        for x in (-0.47, -0.25):
            p0 = P(x, ENG_Z + 0.02, sy * (SHROUD_Y + SHROUD_R - 0.004))
            mb.cyl(p0, p0 + V(0, sy * 0.025, 0.008), 0.010, 'Rubber', n=8)
            mb.tube(catmull([p0 + V(0, sy * 0.025, 0.008), P(x + 0.10, ENG_Z + 0.09, sy * (SHROUD_Y + 0.12)),
                             P(-0.12, ENG_Z + 0.10, sy * 0.10), P(-0.09, ENG_Z + 0.06, sy * 0.05)], 4), 0.0045,
                    'Rubber', n=6)
        # exhaust stubs under each bank, turned aft
        for x in (-0.45, -0.27):
            mb.tube(catmull([P(x, ENG_Z - 0.06, sy * (SHROUD_Y - 0.03)), P(x, ENG_Z - 0.15, sy * (SHROUD_Y - 0.03)),
                             P(x - 0.07, ENG_Z - 0.20, sy * (SHROUD_Y - 0.02))], 4), 0.018, 'Steel_Exhaust', n=10)
    # flywheel / starter housing and magneto at the front
    mb.lathe([(0.0, 0.0), (0.075, 0.0), (0.082, 0.012), (0.082, 0.045), (0.06, 0.06), (0.0, 0.062)], P(-0.16, ENG_Z),
             V(1, 0, 0), 'Engine_Dark', n=24)
    mb.box(P(-0.10, ENG_Z + 0.06), (0.05, 0.07, 0.06), 'Engine_Dark', bevel=0.008, segs=1)
    # carburettor on top and the white intake bell (T: top at X -0.345, Z -0.653)
    mb.box(P(-0.35, ENG_Z + 0.115), (0.08, 0.07, 0.07), 'Engine', bevel=0.01, segs=2)
    mb.lathe([(0.026, 0.0), (0.030, 0.03), (0.038, 0.07), (0.046, 0.10), (0.040, 0.112), (0.0, 0.118)],
             P(-0.348, ENG_Z + 0.15), V(0, 0, 1), 'Prop_White', n=20)
    # prop flange
    mb.lathe([(0.0, 0.0), (0.045, 0.0), (0.050, 0.008), (0.050, 0.030), (0.0, 0.030)], P(x0 - 0.0, ENG_Z),
             V(-1, 0, 0), 'Engine', n=24)
    # flexible rotor spin-up shaft (black) from the front of the engine up the back of the mast to the head
    pts = [P(-0.11, ENG_Z + 0.07), P(-0.07, -0.70), P(-0.06, -0.45), P(-0.09, -0.20), P(-0.085, -0.10)]
    mb.tube(catmull(pts, 6), 0.013, 'Rubber', n=10)
    return mb.finish(sharp_angle=38, wn=True)


def build_tank():
    """Fuel tank (58 lb) in the nacelle behind the seat; filler cap on the rear deck."""
    mb = MB('tank')
    mb.box(P(-0.10, -1.24), (0.30, 0.32, 0.22), 'Interior', bevel=0.03, segs=2)
    mb.cyl(P(-0.06, -1.070), P(-0.06, -1.052), 0.028, 'Metal_Frame', n=16)
    return mb.finish(sharp_angle=40)


# ---------------------------------------------------------------------------
# Tail: fixed fin strip along the swept leading edge, big horn-balanced rudder, small tailplane
# ---------------------------------------------------------------------------
def fin_le_x(Z):
    return -1.173 + (-0.768 - Z) * 0.600


def hinge_x(Z):
    return -1.030 + (Z - keel_z(-1.03)) * (0.181 / (keel_z(-1.03) + 0.880))


RUD_REAR = [(-1.40, keel_z(-1.40) + 0.045), (-1.48, -1.640), (-1.535, -1.585), (-1.554, -1.536), (-1.580, -1.473),
            (-1.602, -1.391), (-1.612, -1.298), (-1.605, -1.184), (-1.582, -1.060), (-1.532, -0.958),
            (-1.463, -0.865), (-1.381, -0.796), (-1.300, -0.765), (-1.257, -0.760), (-1.215, -0.763),
            (-1.185, -0.772), (-1.166, -0.788)]


def slab(name, outline, thick, mat, origin=None, bevel=0.006):
    """Flat plate on the centre plane from a side-view outline (hub frame), rounded edges."""
    n = len(outline)
    pts = [P(x, z, 0.0) for x, z in outline]
    coords = [p + V(0, thick * 0.5, 0) for p in pts] + [p - V(0, thick * 0.5, 0) for p in pts]
    faces = [list(range(n)), list(range(n, 2 * n))[::-1]] + [[i, n + i, n + (i + 1) % n, (i + 1) % n]
                                                             for i in range(n)]
    mb = MB(name)
    mb.faces(coords, faces, mat, smooth=False)
    ob = mb.finish(sharp_angle=30)
    bv = ob.modifiers.new('bev', 'BEVEL')
    bv.width = bevel
    bv.segments = 3
    bv.limit_method = 'ANGLE'
    bv.angle_limit = math.radians(60)
    K.apply_mods(ob)
    ob.modifiers.new('tri', 'TRIANGULATE')
    K.apply_mods(ob)
    for p in ob.data.polygons:
        p.use_smooth = abs(p.normal.y) < 0.95
    if origin is not None:
        o = Vector(origin)
        ob.data.transform(Matrix.Translation(-o))
        ob.location = o
    return ob


def fin_outline():
    zt = -0.885
    xf = fin_le_x(keel_z(-0.655) + 0.018)
    pts = [(xf, keel_z(xf) + 0.018)]
    for k in range(1, 6):
        x = lerp(xf, hinge_x(keel_z(-1.03)) + 0.006, k / 5)
        pts.append((x, keel_z(x) + 0.018))
    zb = keel_z(-1.03) + 0.018
    for k in range(1, 7):
        z = lerp(zb, zt, k / 6)
        pts.append((hinge_x(z) + 0.006, z))
    pts.append((fin_le_x(zt), zt))
    for k in range(1, 8):
        z = lerp(zt, keel_z(xf) + 0.018, k / 8)
        pts.append((fin_le_x(z), z))
    return pts[:-1][::-1]


def rudder_outline():
    zh = -0.875
    zb = keel_z(-1.03) + 0.045
    pts = []
    for k in range(0, 7):
        z = lerp(zh, zb, k / 6)
        pts.append((hinge_x(z) - 0.006, z))
    x = hinge_x(zb) - 0.006
    for k in range(1, 5):
        xx = lerp(x, -1.40, k / 4)
        pts.append((xx, keel_z(xx) + 0.045))
    pts += RUD_REAR[1:]
    z = -0.788
    while z > zh + 0.02:
        z -= 0.03
        pts.append((fin_le_x(max(z, zh)), max(z, zh)))
    pts.append((fin_le_x(zh), zh))
    return pts


def rudder_origin():
    z = -1.28
    return P(hinge_x(z), z)


def build_tail():
    fin = slab('fin', fin_outline(), 0.026, 'Paint_White', bevel=0.008)
    # tailplane: thin rectangular plate with round tips across the fixed fin
    mb = MB('tailplane')
    loop = airfoil_ring(12, 0.08, te_min=0.002)
    le, te = -0.900, -1.175
    span = 0.45
    rings = []
    for y in (-span, -span + 0.015, -span + 0.05, -0.2, 0.0, 0.2, span - 0.05, span - 0.015, span):
        u = abs(y) / span
        tip = max(0.0, (u - 0.85) / 0.15)
        c = (le - te) * math.sqrt(max(0.05, 1 - tip ** 2))
        l0 = le - (le - te - c) * 0.5
        rings.append([P(l0 - s * c, TP_Z + tz * c * (1 - 0.5 * tip), y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    tp = mb.finish(sharp_angle=50)
    # hinge brackets on the fin's rear edge
    hb = MB('hinges')
    for z in (keel_z(-1.03) + 0.10, -1.28, -0.95):
        hb.box(P(hinge_x(z) + 0.004, z), (0.04, 0.034, 0.025), 'Metal_Frame', bevel=0.004, segs=1)
    hb = hb.finish(sharp_angle=40)
    rud = slab('rudder', rudder_outline(), 0.024, 'Paint_White', origin=None, bevel=0.007)
    # livery (traced on T): light teal band, white line, dark teal band across fin and rudder
    for ob in (fin, rud):
        K.paint_poly(ob, R.pts([(-0.4, -1.237), (-1.8, -1.237), (-1.8, -1.284), (-0.4, -1.284)]), 'Paint_Accent')
        K.paint_poly(ob, R.pts([(-0.4, -1.331), (-1.8, -1.331), (-1.8, -1.372), (-0.4, -1.372)]), 'Teal_Dark')
    # LODGE badge on the rudder horn: yellow shield with the chequered band
    shield = [(-1.350, -0.842), (-1.198, -0.842), (-1.198, -0.920), (-1.225, -0.975), (-1.274, -1.010),
              (-1.323, -0.975), (-1.350, -0.920)]
    K.paint_poly(rud, R.pts(shield), 'Lodge_Yellow')
    K.paint_poly(rud, R.pts([(-1.346, -0.900), (-1.202, -0.900), (-1.202, -0.928), (-1.346, -0.928)]), 'Decal_Black')
    # titles painted across fin and rudder: ray-cast on a temporary union, then split at the hinge
    tmp = B.join_objects('tmp_tail', [_dup(fin), _dup(rud)])
    # (rays through the hinge gap miss: those vertices stay on the plate's face plane)
    letters = decal_text(tmp, 'G-ARRT', R.x(-1.233), R.z(-1.128), 0.150, font='ariblk.ttf', miss_y=0.0138)
    letters += decal_text(tmp, 'Air BP', R.x(-0.985), R.z(-1.452), 0.085, font='ariblk.ttf', skew=0.18, miss_y=0.0138)
    bpy.data.objects.remove(tmp)
    on_fin, on_rud = [], []
    for ob in letters:
        a_, b_ = split_at_hinge(ob)
        on_fin += a_
        on_rud += b_
    fin = B.join_objects('fin', [fin] + on_fin)
    rud = B.join_objects('rudder', [rud] + on_rud)
    o = rudder_origin()
    rud.data.transform(Matrix.Translation(-o))
    rud.location = o
    return fin, tp, hb, rud


def _dup(ob):
    d = ob.copy()
    d.data = ob.data.copy()
    bpy.context.scene.collection.objects.link(d)
    return d


def split_at_hinge(ob):
    """Faces forward of the hinge line -> fixed fin, the rest -> rudder (two new objects)."""
    out = ([], [])
    for side in (0, 1):
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        kill = []
        for f in bm.faces:
            c = ob.matrix_world @ f.calc_center_median()
            fwd = (c.x - R.dx) > hinge_x(c.z - R.dz)
            if fwd != (side == 0):
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        if bm.faces:
            me = bpy.data.meshes.new(ob.name + ('_f' if side == 0 else '_r'))
            bm.to_mesh(me)
            for m in ob.data.materials:
                me.materials.append(m)
            o2 = bpy.data.objects.new(me.name, me)
            o2.matrix_world = ob.matrix_world
            bpy.context.scene.collection.objects.link(o2)
            out[side].append(o2)
        bm.free()
    bpy.data.objects.remove(ob)
    return out


# ---------------------------------------------------------------------------
# Wheels
# ---------------------------------------------------------------------------
def main_wheel(name, sy):
    c = P(AXLE[0], AXLE[1], sy * MAIN_Y)
    mb = MB(name)
    mb.lathe(B.tire_profile(RM, 0.058, WM), c, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    hw = WM * 0.5
    mb.lathe([(0.0, -hw * 0.62), (0.022, -hw * 0.62), (0.034, -hw * 0.42), (0.056, -hw * 0.55), (0.062, -hw * 0.72),
              (0.062, hw * 0.72), (0.056, hw * 0.55), (0.034, hw * 0.42), (0.022, hw * 0.62), (0.0, hw * 0.62)],
             c, V(0, 1, 0), 'Engine', n=28)
    for k in range(5):
        a = TAU * k / 5
        p = c + V(math.cos(a) * 0.040, 0, math.sin(a) * 0.040)
        mb.cyl(p + V(0, -hw * 0.5, 0), p + V(0, hw * 0.5, 0), 0.004, 'Metal_Frame', n=6)
    return mb.finish(origin=c, sharp_angle=40)


def build_nose_wheel():
    """Castoring nose wheel: oleo leg from the post under the nacelle, single fork plate on the right."""
    c = P(*NOSE)
    mb = MB('nose_wheel')
    mb.lathe(B.tire_profile(RN, 0.052, WN), c, V(0, 1, 0), 'Rubber', n=32, closed_profile=True)
    hw = WN * 0.5
    mb.lathe([(0.0, -hw * 0.6), (0.02, -hw * 0.6), (0.032, -hw * 0.4), (0.054, -hw * 0.7), (0.054, hw * 0.7),
              (0.032, hw * 0.4), (0.02, hw * 0.6), (0.0, hw * 0.6)], c, V(0, 1, 0), 'Engine', n=24)
    y = -(hw + 0.014)
    top = P(NOSE[0] + 0.012, NOSE[1] + 0.150)
    mb.tube([c + V(0, y, 0), c + V(0.008, y, 0.07), top + V(0, y, -0.01)], 0.0, 'Frame_Alu', n=12,
            square=(0.030, 0.010, 4), cap=True)
    mb.cyl(c + V(0, y - 0.008, 0), c + V(0, hw + 0.008, 0), 0.008, 'Metal_Frame', n=10)
    mb.box(top + V(0, y * 0.5, 0.0), (0.05, abs(y) + 0.03, 0.03), 'Frame_Alu', bevel=0.006, segs=1)
    # oleo: chromed slider in a light-alloy barrel up to the post
    p_top = P(NOSE[0] + 0.012, keel_z(NOSE[0]) - 0.02)
    mb.cyl(top, top + V(0, 0, 0.06), 0.014, 'Chrome', n=12)
    mb.cyl(top + V(0, 0, 0.05), p_top, 0.019, 'Frame_Alu', n=14)
    # torque links
    mb.tube([top + V(0.03, 0, 0.0), top + V(0.06, 0, 0.04), top + V(0.03, 0, 0.09)], 0.0, 'Frame_Alu', n=8,
            square=(0.012, 0.016, 4))
    return mb.finish(origin=c, sharp_angle=40)


# ---------------------------------------------------------------------------
# Seat, pilot, controls, panel
# ---------------------------------------------------------------------------
HIP = (0.330, -1.280)
PILOT_BACK = 14.0
PANEL_C = (0.880, -1.005)
PANEL_TILT = 10.0


def build_seat():
    """Plain padded seat (black): cushion on the two cross tubes, back pad on a frame leaning against the
    mast, head pad on the mast (G-AVDG, G-ARZB, F1). No side bolsters."""
    mb = MB('seat')
    hip = P(*HIP)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    f = V(math.cos(b), 0, math.sin(b))
    mb.box(hip + V(0.10, 0, -0.125), (0.40, 0.30, 0.07), 'Seat', bevel=0.025, segs=3, rot=K.rot_y(-6))
    mb.box(hip + V(0.10, 0, -0.17), (0.38, 0.28, 0.02), 'Frame_Alu', bevel=0.004, segs=1, rot=K.rot_y(-6))
    bc = hip - f * 0.135 + u * 0.27
    mb.box(bc, (0.06, 0.29, 0.46), 'Seat', bevel=0.025, segs=3, rot=Euler((0, -b, 0)))
    mb.box(bc - f * 0.04, (0.015, 0.27, 0.44), 'Frame_Alu', bevel=0.004, segs=1, rot=Euler((0, -b, 0)))
    # head pad on the mast
    z = -0.560
    mb.box(P(mast_x(z) + 0.055, z), (0.07, 0.17, 0.16), 'Seat', bevel=0.025, segs=3, rot=K.rot_y(11))
    return mb.finish(sharp_angle=50, wn=True)


def build_controls_and_crew(pod, ws):
    ctrl = MB('controls_static')
    # floor stick in front of the seat, grip just under the panel (G-ARZB cockpit photo)
    stick_base = P(0.600, -1.452)
    stick, grip, axis = controls.gyro_stick(stick_base, P(0.655, -1.060))
    ctrl.box(stick_base + V(0, 0, -0.012), (0.08, 0.10, 0.02), 'Frame_Alu', bevel=0.005, segs=1)
    # throttle on the left cockpit wall
    tp = P(0.640, -0.975, 0.195)
    knob, lever = controls.throttle_lever(ctrl, tp, length=0.11)
    feet = {'L': P(1.050, -1.345, 0.078), 'R': P(1.050, -1.345, -0.078)}
    pilot.build_pilot('pilot_front', P(*HIP), PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet=feet, knee_out=0.0, elbow_out=0.12, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-1.464))
    K.print_joints('pilot_front', R)
    # floor board in the nacelle
    ctrl.box(P(0.72, -1.468), (0.64, 0.24, 0.008), 'Interior', bevel=0.0)
    face, F, poly = PANEL.build_panel(ctrl, P(*PANEL_C), PANEL_TILT, [pod, ws], zone=(0.0, 0.000, 0.22, 0.085),
                                      cw=0.045, v_leg=-0.075, v_sb=-0.050, v_b=-0.112, margin=0.014,
                                      max_u=0.20, leg_exp=0.5)
    # ignition key on the face under the instruments (the panel is too small for the switch rows)
    kc = F.P(0.0, -0.082)
    Rk = F.R()
    ctrl.cyl(kc - F.N * 0.001, kc + F.N * 0.006, 0.0125, 'Metal_Frame', n=20)
    k = MB('key')
    piv = kc + F.N * 0.0065
    k.box(piv + F.N * 0.006, (0.003, 0.0085, 0.012), 'Metal_Frame', bevel=0.0008, segs=1, rot=Rk)
    k.box(piv + F.N * 0.019, (0.0045, 0.024, 0.015), 'Btn_Black', bevel=0.002, segs=1, rot=Rk)
    k.finish(origin=piv, sharp_angle=40)
    ctrl = ctrl.finish(sharp_angle=40)
    hip = P(*HIP)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    S = hip + u * pilot.SPINE
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    return ctrl, stick_base, eye, face


# ---------------------------------------------------------------------------
# Lights: MINIMUM SET, NOT ON THE PHOTOS
# ---------------------------------------------------------------------------
def build_min_lights(pod):
    """MINIMUM SET, NOT ON THE PHOTOS: G-ARRT carries no lights. Every aircraft of the sim must have a
    landing light, both nav lights and one anti-collision light, so small modern units are fitted where
    a builder would put them on this airframe: an LED landing lamp under the nose, nav lamps on the
    tailplane tips (red left, green right) and a white strobe on the top of the fin (fixed part would be
    too low: it sits on the rudder horn, which is where a fin-top strobe goes on this tail)."""
    mb = MB('min_lights')
    # landing lamp in the lower nose, aimed slightly down
    inv = pod.matrix_world.inverted()
    q = P(2.0, -1.36)
    ok, loc, nrm, _i = pod.ray_cast(inv @ q, inv.to_3x3() @ V(-1, 0, 0), distance=1.0)
    c = (pod.matrix_world @ loc) if ok else P(1.71, -1.36)
    d = V(1, 0, -0.10).normalized()
    K.lamp(mb, c - d * 0.010, d, kind='white', r=0.020, length=0.014, base='Paint_Dark')
    K.lamp_node('landing', c + d * 0.03)
    for sy, kind in ((1, 'red'), (-1, 'green')):
        p = P(-1.04, TP_Z, sy * 0.452)
        K.lamp(mb, p, V(0, sy, 0), kind=kind, r=0.013, length=0.018)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0, sy * 0.04, 0))
    return mb.finish(sharp_angle=50)


def build_rudder_strobe():
    mb = MB('strobe')
    t = P(-1.290, -0.762)
    K.lamp(mb, t, V(0, 0, 1), kind='white', r=0.012, length=0.022)
    return mb.finish(sharp_angle=50), t


# ---------------------------------------------------------------------------
# Decal text (E.build_registration with a font and weight of our own)
# ---------------------------------------------------------------------------
FONT_DIR = os.path.join(os.environ.get('WINDIR', 'C:\Windows'), 'Fonts')


def load_font(fname):
    p = os.path.join(FONT_DIR, fname)
    if os.path.exists(p):
        try:
            return bpy.data.fonts.load(p, check_existing=True)
        except Exception:
            return None
    return None


def decal_text(target, text, cx, cz, size, mat='Decal_Black', font=None, bold=0.0, sides=(1, -1), skew=0.0,
               miss_y=None):
    """Text shrink-wrapped on both flanks of `target` (model x, z centre). font = file in Windows/Fonts
    (falls back to Blender's own), bold = outline offset as a fraction of the size, skew = italic shear."""
    obs = []
    fnt = load_font(font) if font else None
    for side in sides:
        cu = bpy.data.curves.new('dec_txt', 'FONT')
        cu.resolution_u = 3
        cu.body = text
        cu.size = size
        cu.align_x = 'CENTER'
        cu.align_y = 'CENTER'
        cu.shear = skew
        if fnt:
            cu.font = fnt
        if bold:
            cu.offset = bold * size
        try:
            cu.fill_mode = 'BOTH'
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
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=size * 0.004)
        bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(4), verts=bm.verts, edges=bm.edges)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        long_e = [e for e in bm.edges if e.calc_length() > 0.03]
        if long_e:
            bmesh.ops.subdivide_edges(bm, edges=long_e, cuts=1, use_grid_fill=True)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])
        inv = target.matrix_world.inverted()
        for v in bm.verts:
            tx, ty = v.co.x, v.co.y
            wx, wz = (cx - tx, cz + ty) if side > 0 else (cx + tx, cz + ty)
            hit, loc, nrm, idx = target.ray_cast(inv @ V(wx, side * 1.0, wz), inv.to_3x3() @ V(0, -side, 0))
            v.co = (target.matrix_world @ loc) + (target.matrix_world.to_3x3() @ nrm).normalized() * 0.0018                 if hit else V(wx, side * (miss_y if miss_y is not None else 0.3), wz)
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
        bpy.context.scene.collection.objects.link(ob)
        obs.append(ob)
    return obs


# ---------------------------------------------------------------------------
# Decals on the nacelle
# ---------------------------------------------------------------------------
def build_pod_decals(pod):
    obs = []
    # "Air BP" white panel with black letters (traced: X 0.70 .. 1.10, Z -1.231 .. -1.332)
    K.paint_poly(pod, R.pts([(0.70, -1.231), (1.10, -1.231), (1.10, -1.333), (0.70, -1.333)]), 'Decal_White')
    obs += decal_text(pod, 'Air BP', R.x(0.898), R.z(-1.288), 0.098, font='ariblk.ttf', skew=0.18)
    obs += decal_text(pod, 'Wallis', R.x(0.785), R.z(-1.118), 0.105, font='BRUSHSCI.TTF', bold=0.015)
    # underline swash under "Wallis"
    K.paint_poly(pod, R.pts([(0.655, -1.165), (0.915, -1.172), (0.915, -1.180), (0.655, -1.176)]), 'Decal_Black')
    return obs


# ---------------------------------------------------------------------------
def build_all():
    mats()
    pod, rim = build_pod()
    decals = build_pod_decals(pod)
    ws, wsf = build_windscreen(pod)
    frame = build_frame()
    rods = build_controls_rods()
    build_head()
    K.build_rotor(HUB, R=ROTOR_R, chord=ROTOR_C, root=0.30, tc=0.12, tip_mat='Tip_Red', mat='Rotor_Blade',
                  clamp_len=0.32, tower_h=0.056, under=0.030, bar_w=0.07, bar_mat='Frame_Alu', clamp_mat='Frame_Alu',
                  tip_len=0.10)
    engine = build_engine()
    K.build_prop(PROP, R=PROP_R, blades=2, hub='spinner', mat='Prop_White', tip_mat='Prop_White', chord_k=1.30,
                 pitch=0.80, hub_r=0.060, hub_len=0.12, tip_band=0.04, spinner_mat='Prop_White')
    tank = build_tank()
    fin, tp, hinges, rud = build_tail()
    strobe, st = build_rudder_strobe()
    B.join_objects('rudder', [rud, strobe])
    K.lamp_node('beacon', st + V(0, 0, 0.05))
    main_wheel('wheel_L', 1)
    main_wheel('wheel_R', -1)
    build_nose_wheel()
    seat = build_seat()
    ctrl, stick_base, eye, face = build_controls_and_crew(pod, ws)
    lights = build_min_lights(pod)
    static = [pod, rim, wsf, frame, rods, engine, tank, fin, tp, hinges, seat, ctrl, lights] + decals
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [face, ctrl, pod], ' (legs)')
    K.clearance(['pilot_front_torso', 'pilot_front_arm'], [seat, frame, pod], ' (torso)')
    K.clearance(['pilot_front'], [ws], ' (screen)')
    K.finalize(static, [ws])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': rudder_origin(), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': P(*NOSE), 'wheel_L': P(AXLE[0], AXLE[1], MAIN_Y),
        'wheel_R': P(AXLE[0], AXLE[1], -MAIN_Y),
    })

    def m(v):
        return '(%.3f, %.3f, %.3f)' % (v.x, v.z, -v.y)
    print('WA116 model (x fwd, y up, z right): hub %s pivot %s prop %s R %.3f' % (m(HUB), m(PIVOT), m(PROP), PROP_R))
    print('WA116 cg hub-frame (%.3f, %.3f) -> model (0.08, 0.10); ground y %.3f; eye %s' % (
        CG[0], CG[1], R.z(GROUND), m(eye)))
    geometry_sheet()
    print('WA116 nose contact %s main contact %s / %s' % (m(P(NOSE[0], GROUND)), m(P(AXLE[0], GROUND, MAIN_Y)),
                                                         m(P(AXLE[0], GROUND, -MAIN_Y))))


def eye_point():
    hip = P(*HIP)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = hip + u * (pilot.SPINE + 0.13) + V(0.035, 0, 0.072)
    return head + V(0.077, 0, 0.007)


EYE = eye_point()
def poly_area_centroid(pts):
    a = cx = cz = 0.0
    for (x0, z0), (x1, z1) in zip(pts, pts[1:] + pts[:1]):
        c = x0 * z1 - x1 * z0
        a += c
        cx += (x0 + x1) * c
        cz += (z0 + z1) * c
    a *= 0.5
    return abs(a), cx / (6 * a), cz / (6 * a)


def geometry_sheet():
    def m(X, Z, y=0.0):
        v = R(X, Z, y)
        return '(%.3f, %.3f, %.3f)' % (v.x, v.z, -v.y)
    af, xf, zf = poly_area_centroid(fin_outline())
    ar, xr, zr = poly_area_centroid(rudder_outline())
    xc, zc = (af * xf + ar * xr) / (af + ar), (af * zf + ar * zr) / (af + ar)
    print('WA116 fin %.3f m2 + rudder %.3f m2 = %.3f m2, centroid %s' % (af, ar, af + ar, m(xc, zc)))
    span, c = 0.90, 0.275
    print('WA116 tailplane span %.2f chord %.3f area ~%.3f m2 (round tips), 25%% MAC at %s' % (
        span, c, span * c * 0.97, m(-0.900 - 0.25 * c, TP_Z)))
    print('WA116 tail skid bottom %s' % m(-1.44, keel_z(-1.44) - 0.051))
    pts = {'nose tip': (NOSE_TIP[0], NOSE_TIP[1], 0), 'keel under seat': (0.60, keel_z(0.60) - 0.023, 0),
           'axle beam': (AXLE[0], AXLE[1] - 0.009, 0), 'nacelle side L': (0.32, -1.20, 0.224),
           'nacelle side R': (0.32, -1.20, -0.224), 'engine shroud L': (-0.35, ENG_Z, SHROUD_Y + SHROUD_R),
           'engine shroud R': (-0.35, ENG_Z, -SHROUD_Y - SHROUD_R), 'prop tip low': (PROP_H[0], PROP_H[1] - PROP_R, 0),
           'head top': (0.0, 0.035, 0), 'fin top': (-1.257, -0.760, 0), 'rudder rear': (-1.612, -1.298, 0),
           'tailplane tip L': (-1.04, TP_Z, 0.45), 'tailplane tip R': (-1.04, TP_Z, -0.45),
           'tail skid': (-1.44, keel_z(-1.44) - 0.051, 0)}
    for k, (X, Z, y) in pts.items():
        print('WA116 crash %-16s %s' % (k, m(X, Z, y)))


VIEWS = {
    'thumb': dict(extra=True, loc=(4.1, -4.4, 3.0), target=(-0.15, 0.0, 0.1), lens=38, rotor=-25, prop=10),
    'three_quarter_front': dict(loc=(5.4, 4.6, 1.8), target=(-0.2, 0.0, 0.2), lens=33, rotor=-58, prop=20),
    'rear_three_quarter': dict(loc=(-5.6, -4.8, 2.0), target=(-0.3, 0.0, 0.3), lens=35, rotor=-40, prop=40),
    'side': dict(loc=(0.0, 18.0, 0.30), target=(-0.1, 0.0, 0.30), ortho=7.6, rotor=0, prop=0),
    'tail_detail': dict(extra=True, loc=(-0.3, -3.0, 0.5), target=(-1.45, 0.0, -0.10), lens=40, rotor=75, prop=10),
    'nose_detail': dict(extra=True, loc=(2.9, -2.0, 0.3), target=(1.1, 0.0, -0.25), lens=40, rotor=75, prop=15),
    'engine_detail': dict(extra=True, loc=(-2.4, -1.9, 0.9), target=(-0.6, 0.0, 0.15), lens=40, rotor=75, prop=30),
    'head_detail': dict(extra=True, loc=(1.4, -1.3, 1.6), target=(-0.1, 0.0, 1.0), lens=50, rotor=75, prop=0),
    'cockpit': dict(extra=True, loc=(1.6, 1.3, 1.0), target=(0.5, 0.0, -0.2), lens=32, rotor=75, prop=0),
    'pilot_eye': dict(extra=True, loc=tuple(EYE), target=tuple(EYE + V(3.0, 0, -0.25)), lens=24, rotor=75, prop=0),
}

if __name__ == '__main__':
    K.run(NAME, build_all, LIVERY, views={k: v for k, v in VIEWS.items() if v.get('loc')}, rest_ground=R.z(GROUND))
