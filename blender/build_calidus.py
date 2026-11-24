"""
AutoGyro Calidus (Hildesheim, 2009-) for the Autogiro web sim: enclosed tandem gyroplane. Egg-shaped
GRP/CRP monocoque with a blunt rounded nose (pair of landing lights in its tip), one large undivided
plexiglass canopy hinged on its LEFT side (two hinges on the left lower rail, locking lever on the
right) whose rear top is painted (a roof strip tapering forward), wide curved pylon fairing with the
ram-air scoop in its front cover sweeping back into a dorsal fillet over the fully cowled Rotax
912/914, HTC three-blader with spinner, polished stainless keel leaving the lower rear of the cabin,
dipping under the prop and climbing to the tail (two struts from the cowl to the keel), tapered
tailplane with two end fins and a central fin carrying the single rudder (aluminium trim tab), GRP
spring spar with half spats, steerable nose wheel.

Traced in the HUB FRAME (gyrokit.py) on the side photo Commons "AutoGyro Europe Calidus 01.JPG"
(refs/calidus/big/28.jpg, 1920 px: hub at px (943, 222), 271 px/m from the 4.00-8 main tyre (0.41 m
= 110 px) and the 1.72 m propeller, camera rolled 1.2 deg -> `ph()` rotates it out, camera yaw +3.7 deg
from the two main wheels); widths from the factory three-view of the POH (rev 4.1 p16; top view
117 px/m: pod 0.87 m, track 1.54 m, tailplane 1.62 m); details from G-DISP, RA-1300G (yellow, 14.jpg),
the copper D-M... (01.jpg) and the cockpit photo (09.jpg). Centre of gravity: sim convention 0.33 m
ahead of the hub; height from UK CAA data sheet BG04 (0.795-0.895 m above the main axle -> 0.845).

  blender -b -P blender/build_calidus.py -- [--previews] [--only VIEW,...] [--overlay yaw,cx,cz,ppm,w,h,side]
Outputs: public/models/calidus.glb, blender/calidus.blend, blender/previews/calidus/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- photo 28 (1920 x 1079, nose to the right) -> hub frame --------------------------------------
PH_HX, PH_HY, PH_PPM = 943.0, 222.0, 271.0
_C, _S = math.cos(math.radians(1.2)), math.sin(math.radians(1.2))


def ph(x, y):
    X0, Z0 = x - PH_HX, PH_HY - y
    return ((X0 * _C - Z0 * _S) / PH_PPM, (X0 * _S + Z0 * _C) / PH_PPM)


def phs(pts):
    return [ph(x, y) for x, y in pts]


# ---- hub frame -----------------------------------------------------------------------------------
GROUND = -2.705                         # both tyre bottoms of photo 28 (after the roll correction)
AXLE = (-0.35, GROUND + 0.205)          # main axle (4.00-8 tyres, 0.41 m), mean of near and far wheel
CG = (0.33, AXLE[1] + 0.845)            # sim convention in x; height: middle of the BG04 range
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.195)
PROP = R(-1.085, -1.415)
MAIN_Y = 0.77                           # track 1.54 m (three-view top and front)
NOSE = (1.745, GROUND + 0.145)          # nose wheel 400-4
X_END = -1.04                           # cowling ends at the prop flange

LIVERY = dict(body=('#F2BE0C', 0.35, 0.22), accent=('#C4C8CC', 0.85, 0.26), dark=('#141517', 0.3, 0.30))
REG = 'EC-GC4'

# ---- hull: side outline (photo px), plan half-width and belt (max width) height -------------------
XTIP, ZTIP = ph(1494, 820)
TOP_PX = [(1494, 820), (1487, 810), (1475, 797), (1460, 780), (1440, 757), (1420, 735), (1400, 715), (1380, 697),
          (1360, 680), (1320, 656), (1280, 637), (1240, 619), (1200, 601), (1160, 582), (1120, 568), (1080, 556),
          (1040, 547), (1000, 540), (960, 535), (900, 532)]
TOP_REAR = [(-0.35, -1.168), (-0.60, -1.212), (-0.80, -1.252), (-0.95, -1.288), (X_END, -1.313)]
BOT_PX = [(1494, 820), (1490, 832), (1480, 842), (1460, 850), (1440, 855), (1400, 862), (1360, 868), (1300, 872),
          (1240, 875), (1180, 876), (1100, 877), (1000, 876), (930, 873), (900, 866), (875, 855), (850, 840),
          (800, 815), (780, 800), (740, 745), (700, 690), (668, 650), (652, 627)]
W_TAB = [(XTIP, 0.0), (2.03, 0.105), (1.95, 0.165), (1.80, 0.255), (1.57, 0.345), (1.30, 0.395), (1.07, 0.418),
         (0.70, 0.430), (0.32, 0.432), (0.0, 0.415), (-0.20, 0.392), (-0.44, 0.350), (-0.65, 0.295),
         (-0.81, 0.240), (-0.95, 0.170), (X_END, 0.118)]
BELT_TAB = [(XTIP, ZTIP), (1.95, -2.09), (1.80, -2.06), (1.50, -2.00), (1.00, -1.93), (0.40, -1.88), (0.00, -1.85),
            (-0.30, -1.78), (-0.60, -1.64), (-0.85, -1.50), (X_END, -1.415)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    pairs = sorted(pairs, key=lambda p: -p[0])
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T = _prof(phs(TOP_PX) + TOP_REAR)
F_B = _prof(phs(BOT_PX))
F_W, F_M = _prof(W_TAB), _prof(BELT_TAB)
F_NT = B.hermite([X_END, -0.5, 0.0, 1.0, 1.7, XTIP], [2.2, 2.3, 2.15, 2.1, 2.1, 2.0])
F_NB = B.hermite([X_END, -0.5, -0.1, 1.0, 1.7, XTIP], [2.2, 2.5, 2.7, 2.7, 2.4, 2.0])


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


def hull_ring(X, n_half=31, scale=1.0):
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


# ---- canopy (photo px): glass outline, canopy-frame cut line, nose cover line --------------------
GLASS_PX = [(940, 581), (944, 600), (955, 622), (975, 650), (1005, 690), (1038, 722), (1100, 730), (1160, 738),
            (1240, 748), (1322, 760), (1340, 742), (1357, 716), (1372, 700), (1340, 688), (1300, 675), (1240, 654),
            (1180, 633), (1120, 613), (1060, 597), (1000, 585), (962, 578), (948, 578)]
JOINT_PX = [(899, 532), (898, 560), (903, 600), (915, 640), (940, 685), (975, 725), (1020, 748), (1080, 758),
            (1160, 766), (1240, 772), (1330, 778), (1345, 765), (1362, 742), (1378, 720), (1386, 700)]
NOSELINE_PX = [(1386, 712), (1405, 728), (1425, 748), (1445, 770), (1462, 792), (1472, 806)]

# the painted roof of the canopy: ~0.09 m deep in side view (photos 28 and 14), its rounded front end
# over the front seat back (55-58 % of the canopy length from the rear in photos 01 and 14); the
# windscreen and the front of the roof are all glass
ROOF_D = [(0.12, 0.105), (0.30, 0.092), (0.55, 0.09), (0.65, 0.082), (0.74, 0.064), (0.81, 0.044), (0.86, 0.026),
          (0.89, 0.012), (0.905, 0.004)]


def top_z(X):
    return F_T(_u(X))


def glass_poly():
    pts = phs(GLASS_PX[:13])
    pts += [(1.66, -1.0), (0.93, -1.0)]
    pts += [(X, top_z(X) - d) for X, d in reversed(ROOF_D)]
    return pts


FLOOR_Z = -2.372
FRONT_HIP = R(0.86, -2.215)
REAR_HIP = R(0.11, -2.150)
FRONT_BACK, REAR_BACK = 27.0, 22.0


def cast_side(target, x, z, sy):
    ok, loc, nrm, _ = target.ray_cast(V(x, sy * 1.5, z), V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def cast_down(target, x, y, z0=1.0):
    ok, loc, nrm, _ = target.ray_cast(V(x, y, z0), V(0, 0, -1))
    return (loc, nrm) if ok else (None, None)


def side_line(mb, target, pts_hub, sy, r=0.0035, mat='Decal_Black', lift=0.001, step=0.015):
    pts = B.resample_loop([R(X, Z) for X, Z in pts_hub], step)[:-1]
    out = []
    for p in pts:
        loc, nrm = cast_side(target, p.x, p.z, sy)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 2:
        mb.tube(out, r, mat, n=6, cap=True)
    return out


def cross_line(mb, target, X, y0, r=0.0035, mat='Decal_Black', lift=0.001):
    out = []
    for k in range(25):
        y = lerp(y0, -y0, k / 24)
        loc, nrm = cast_down(target, R.x(X), y)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 2:
        mb.tube(out, r, mat, n=6, cap=True)


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


# black sweep of the factory scheme (yellow RA-1300G): lower nose, band under the canopy, up the cowl
STRIPE = [(2.20, -2.125), (1.80, -2.083), (1.20, -2.072), (0.60, -2.063), (0.25, -2.045), (0.02, -1.975),
          (-0.18, -1.80), (-0.38, -1.60), (-0.62, -1.43), (-0.88, -1.345), (-1.20, -1.30),
          (-1.20, -1.47), (-0.92, -1.525), (-0.66, -1.625), (-0.44, -1.79), (-0.22, -1.995), (-0.02, -2.135),
          (0.35, -2.185), (1.00, -2.200), (1.60, -2.205), (2.20, -2.215)]


def build_hull():
    us = [0.02 * k for k in range(1, 40)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.04:
        x -= 0.03
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    rings.append(hull_ring(X_END - 0.010, scale=0.86))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60)
    K.paint_poly(pod, R.pts(STRIPE), 'Paint_Dark')
    return pod


def build_hull_lines(pod):
    """Everything drawn on the closed hull before the glazing is cut out: canopy-frame cut line,
    nose cover line, cowling panel line, hinges, locking lever, fuel filler, oil door, nav/strobe units,
    landing lights."""
    mb = MB('hull_lines')
    joint = phs(JOINT_PX)
    # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: canopy-frame cut line and nose cover line removed)
    # canopy hinges on the left lower rail, locking lever on the right
    for X in (0.42, 1.10):
        Z = -1.985 + (X - 0.42) * (-0.012)
        loc, nrm = cast_side(pod, R.x(X), R.z(Z + 0.022), 1)
        if loc is not None:
            mb.box(loc + nrm * 0.006, (0.075, 0.016, 0.020), 'Decal_Black', bevel=0.005, segs=2)
    loc, nrm = cast_side(pod, R.x(0.80), R.z(-1.965), -1)
    if loc is not None:
        mb.box(loc + nrm * 0.008, (0.13, 0.018, 0.024), 'Chrome', bevel=0.007, segs=2)
        mb.box(loc + nrm * 0.004 + V(0.07, 0, 0), (0.03, 0.012, 0.03), 'Decal_Black', bevel=0.004, segs=1)
    # fuel filler (left, just behind the canopy), oil-tank door (right, on the cowling)
    loc, nrm = cast_side(pod, R.x(-0.24), R.z(-1.55), 1)
    if loc is not None:
        mb.lathe([(0.0, 0.010), (0.034, 0.010), (0.042, 0.006), (0.046, 0.0), (0.046, -0.004)], loc, nrm, 'Chrome',
                 n=24)
        mb.cyl(loc + nrm * 0.010, loc + nrm * 0.016, 0.014, 'Alu_Black', n=10)
    X, Z = ph(842, 583)
    loc, nrm = cast_side(pod, R.x(X), R.z(Z), -1)
    if loc is not None:
        p = loc
        ring = []
        for k in range(40):
            t = TAU * k / 40
            q = p + V(math.cos(t) * 0.072, 0, math.sin(t) * 0.072)
            l2, n2 = cast_side(pod, q.x, q.z, -1)
            if l2 is not None:
                ring.append(l2 + n2 * 0.0012)
        # (oil-door outline not drawn: see the note on seams above)
    # nav + strobe units each side behind the passenger (red left, green right): black oval housing with a
    # clear lens, just aft of the canopy-frame line at the height of the canopy's lower rear corner
    # (photos 33 D-MCEY left, 31 D-MCUS right, 14 RA-1300G left; POH 9-2.7 'behind the passenger station')
    for sy, kind in ((1, 'red'), (-1, 'green')):
        p = R(0.02, -1.84, sy * hull_y(0.02, -1.84))
        oval_patch(mb, pod, p, V(0, sy, 0), V(1, 0, 0.15), 0.050, 0.020, 'Decal_Black', h0=0.002, h1=0.006, taper=0.8)
        oval_patch(mb, pod, p + V(0.018, sy * 0.004, 0), V(0, sy, 0), V(1, 0, 0.15), 0.026, 0.013,
                   'Lens_Red' if sy > 0 else 'Lens_Green', h0=0.006, h1=0.010, taper=0.6)
        oval_patch(mb, pod, p + V(-0.028, sy * 0.004, -0.004), V(0, sy, 0), V(1, 0, 0.15), 0.016, 0.011,
                   'Lens_White', h0=0.006, h1=0.010, taper=0.6)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0.018, sy * 0.03, 0))
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', p + V(-0.028, sy * 0.03, 0))
        # static port
        q = R(1.15, -2.10, sy * hull_y(1.15, -2.10))
        loc, nrm = cast_side(pod, q.x, q.z, sy)
        if loc is not None:
            mb.cyl(loc - nrm * 0.002, loc + nrm * 0.003, 0.010, 'Chrome', n=10)
    # pair of landing lights in the nose tip (photo 33 D-MCEY; POH 9-2.7 'a pair of lamps installed in the nose')
    for sy, tag in ((1, 'L'), (-1, 'R')):
        p = R(XTIP - 0.03, ZTIP - 0.005, sy * 0.042)
        ok, loc, nrm, _ = pod.ray_cast(p + V(0.4, 0, 0), V(-1, 0, 0))
        if ok:
            mb.lathe([(0.0, -0.004), (0.028, -0.004), (0.028, 0.002), (0.024, 0.004), (0.0, 0.004)], loc, nrm,
                     'Chrome', n=20)
            mb.lathe([(0.0, 0.004), (0.022, 0.004), (0.016, 0.010), (0.0, 0.012)], loc, nrm, 'Lens_White', n=20)
            K.lamp_node('landing', loc + nrm.normalized() * 0.03, tag)
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


# ---- pylon fairing: (LE x, LE z, TE x, TE z, half thickness) in the hub frame; LE = photo front edge
# of the mast cover, TE = its rear edge sweeping into the dorsal fillet over the cowling -----------
PYLON = [(-0.158, -1.32, -1.00, -1.32, 0.205), (-0.150, -1.25, -0.88, -1.25, 0.190),
         (-0.142, -1.19, -0.75, -1.19, 0.170), (-0.131, -1.12, -0.59, -1.12, 0.140),
         (-0.117, -1.02, -0.485, -1.02, 0.110), (-0.096, -0.93, -0.40, -0.93, 0.093),
         (-0.068, -0.83, -0.326, -0.83, 0.085), (-0.040, -0.736, -0.269, -0.736, 0.081),
         (-0.006, -0.625, -0.219, -0.625, 0.079), (0.031, -0.51, -0.189, -0.51, 0.078),
         (0.080, -0.40, -0.180, -0.40, 0.079), (0.107, -0.31, -0.181, -0.31, 0.080),
         (0.130, -0.235, -0.183, -0.272, 0.082), (0.150, -0.180, -0.182, -0.262, 0.082)]


def build_pylon():
    mb = MB('pylon')
    rings = []
    for xl, zl, xt, zt, th in PYLON:
        c = xl - xt
        ring = []
        for s, tz in airfoil_ring(20, min(2 * th / c, 0.95), te_min=0.006):
            # normalised thickness of the ring (tz * c is the NACA half thickness at 2*th/c)
            ring.append(R(xl - s * c, lerp(zl, zt, s), tz * c))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    pylon = mb.finish(sharp_angle=50)
    # ram-air scoop in the front cover, just above the canopy
    le_f = B.hermite([p[1] for p in PYLON], [p[0] for p in PYLON])
    te_f = B.hermite([p[1] for p in PYLON], [p[2] for p in PYLON])

    def scoop(c):
        Z, X = c.z - R.dz, c.x - R.dx
        return -1.10 < Z < -0.86 and (le_f(Z) - X) / max(le_f(Z) - te_f(Z), 1e-3) < 0.10
    K.repaint(pylon, scoop, 'Radiator')
    # mast head: steel mast stub, cheek plates on the pitch pivot, pre-rotator shaft, trim cylinder
    hb = MB('mast_head')
    hb.tube([R(-0.02, -0.32), PIVOT + V(-0.01, 0, -0.03)], 0.04, 'Metal_Frame', n=20, square=(0.06, 0.10, 8))
    for sy in (1, -1):
        hb.box(PIVOT + V(-0.02, sy * 0.045, -0.03), (0.15, 0.010, 0.11), 'Metal_Frame', bevel=0.012, segs=2)
        hb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.062, 0), 0.016, 'Engine', n=12)
    hb.cyl(R(-0.15, -0.27), PIVOT + V(-0.137, 0, -0.07), 0.010, 'Metal_Frame', n=10)
    hb.cyl(R(-0.12, -0.26, 0.05), R(-0.15, -0.14, 0.05), 0.015, 'Alu_Black', n=12)
    hb.cyl(R(-0.15, -0.14, 0.05), R(-0.16, -0.095, 0.05), 0.007, 'Chrome', n=8)
    # rivet lines along the front cover (photo 28)
    for k in range(9):
        Z = lerp(-1.05, -0.30, k / 8)
        xl, xt = le_f(Z), te_f(Z)
        for sy in (1, -1):
            X = xl - 0.30 * (xl - xt)
            loc, nrm = cast_side(pylon, R.x(X), R.z(Z), sy)
            if loc is not None:
                hb.sphere(loc, 0.0045, 'Chrome', seg=8, rings=4)
    return pylon, hb.finish(sharp_angle=40, wn=True)


# ---- keel (polished stainless), cowl struts --------------------------------------------------------
KEEL_PX = [(880, 812), (855, 806), (830, 818), (800, 832), (760, 848), (720, 862), (680, 868), (650, 870), (620, 867),
           (590, 858), (560, 843), (530, 822), (500, 800), (470, 785), (440, 778), (400, 778), (370, 781)]


def build_keel():
    mb = MB('keel')
    pts = catmull([R(X, Z) for X, Z in phs(KEEL_PX)], 5)
    mb.tube(pts, 0.031, 'Chrome', n=18)
    # two struts from the engine mount (inside the cowling) down to the keel bend
    kb = R(*ph(650, 868))
    for sy in (1, -1):
        top = R(-0.52, -2.00, sy * 0.075)
        bot = kb + V(0.05, sy * 0.028, 0.02)
        mb.cyl(top, bot, 0.016, 'Chrome', n=12)
        mb.box(bot + V(0.0, 0, -0.01), (0.06, 0.012, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
    # tailplane saddle on the keel end
    return mb.finish(sharp_angle=50)


# ---- tail (hub frame) ------------------------------------------------------------------------------
STAB_LE0, STAB_LE1, STAB_TE = -1.745, -1.975, -2.355
SPAN = 0.81
STAB_Z = -2.035
HINGE = -2.180
FIN_TOP = -1.257
EF_TOP = -1.464


def fin_le(z):
    Z = z - R.dz
    t = (Z - (STAB_Z + 0.03)) / (FIN_TOP - (STAB_Z + 0.03))
    x = lerp(-1.752, -1.886, t)
    x -= 0.07 * max(0.0, (t - 0.92) / 0.08) ** 2
    return R.x(x)


def rud_te(z):
    Z = z - R.dz
    if Z < -1.875:
        x = lerp(HINGE - 0.02, -2.655, max(0.0, (Z + 2.03) / 0.155))
    else:
        x = lerp(-2.655, -2.384, (Z + 1.875) / (FIN_TOP + 1.875))
    t = (Z - STAB_Z) / (FIN_TOP - STAB_Z)
    x += 0.05 * max(0.0, (t - 0.95) / 0.05) ** 2
    return R.x(x)


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.09, te_min=0.002)
    rings = []
    for y in (-SPAN, -0.76, -0.66, -0.5, -0.3, -0.12, 0.0, 0.12, 0.3, 0.5, 0.66, 0.76, SPAN):
        le = lerp(STAB_LE0, STAB_LE1, abs(y) / SPAN)
        ch = le - STAB_TE
        rings.append([R(le - s * ch, STAB_Z + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # end fins on the tailplane tips: LE raked back, vertical TE, rounded top corners
    z0, z1 = STAB_Z - 0.02, EF_TOP
    zs = [lerp(z0, z1, t) for t in (0.0, 0.05, 0.15, 0.35, 0.55, 0.75, 0.88, 0.95, 0.985, 1.0)]

    def efin_le(z):
        t = (z - R.dz - z0) / (z1 - z0)
        return R.x(lerp(-1.975, -2.045, t) - 0.06 * max(0.0, (t - 0.9) / 0.1) ** 2)

    def efin_te(z):
        t = (z - R.dz - z0) / (z1 - z0)
        return R.x(STAB_TE + 0.012 + 0.035 * max(0.0, (t - 0.92) / 0.08) ** 2)
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], efin_le, efin_te, y_fn=lambda z, sy=sy: sy * (SPAN - 0.01), t=0.12)
    # central fin; the rudder is its aft part
    zs = [STAB_Z - 0.03, STAB_Z + 0.04, -1.95, -1.80, -1.65, -1.50, -1.38, -1.31, -1.285, -1.268, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, rud_te, t=0.10,
               s_end_fn=lambda z: (fin_le(z) - R.x(HINGE)) / (fin_le(z) - rud_te(z)))
    # saddle clamping the tailplane on the keel end, rudder post foot
    mb.box(R(-1.93, STAB_Z - 0.035), (0.30, 0.07, 0.025), 'Metal_Frame', bevel=0.008, segs=2, rot=K.rot_y(-3))
    mb.cyl(R(HINGE, STAB_Z - 0.02), R(HINGE, -2.02), 0.011, 'Metal_Frame', n=10)
    return mb.finish(sharp_angle=45)


def build_rudder():
    zs = [-2.028, -1.99, -1.94, -1.875, -1.75, -1.60, -1.45, -1.35, -1.30, -1.28, -1.265, FIN_TOP - 0.004]
    origin = R(HINGE, -1.65)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], fin_le, rud_te, R.x(HINGE), origin, t=0.10,
                                 mat='Paint_White')
    # ground-adjustable aluminium trim tab on the trailing edge
    tz = -1.62
    tx = rud_te(R.z(tz)) - R.dx
    tab = MB('trimtab')
    tab.box(R(tx - 0.04, tz), (0.12, 0.004, 0.15), 'Metal_Frame', bevel=0.0, rot=Euler((0, math.radians(24.0), 0)))
    tab_ob = tab.finish(sharp_angle=60)
    regs = E.build_registration(rud, REG, cx=R.x(-2.405) - origin.x, cz=R.z(-1.79) - origin.z, size=0.072,
                                mat='Paint_Dark')
    for r in regs:
        r.location = r.location + origin
    B.join_objects('rudder', [rud, tab_ob] + regs)
    return rud


# ---- landing gear ------------------------------------------------------------------------------------
def half_spat(name, c, R=0.205, front=0.235, back=0.37, hw=0.088, top=0.058, lift=0.085, mat='Paint_White',
              exp_top=2.2, belly=0.02):
    """Calidus half spat: teardrop hood over the upper half of the wheel with a long pointed tail,
    open underneath (the lower surface is cut away below the axle and the shell thickened)."""
    c = Vector(c)
    x0, x1 = c.x + front, c.x - back
    zc0 = c.z + lift
    ht_u = R + top - lift
    ht_d = lift + R * belly
    rings = [[V(x0, c.y, zc0 - 0.02)]]
    n = 36
    us = [0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.96, 1.0]
    u_max = front / (front + back)
    for u in us:
        x = lerp(x0, x1, u)
        t = u / u_max if u < u_max else (1 - u) / (1 - u_max)
        f = max(math.sin(0.5 * math.pi * min(1.0, t)) ** (0.62 if u < u_max else 1.25), 0.02)
        zc = zc0 - 0.02 * (1 - u)
        ring = []
        for k in range(n):
            a = TAU * k / n
            ca, sa = math.cos(a), math.sin(a)
            ring.append(V(x, c.y + B.sgnpow(ca, 2 / 2.3) * (hw * f + 0.003),
                          zc + (B.sgnpow(sa, 2 / exp_top) * ht_u if sa > 0 else B.sgnpow(sa, 2 / 2.6) * ht_d) * f))
        rings.append(ring)
    mb = MB(name)
    mb.loft(rings, mat, closed=True, cap1=True)
    ob = mb.finish(sharp_angle=70)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [f for f in bm.faces if f.calc_center_median().z < c.z + 0.035 and f.normal.z < -0.35
            and c.x - R * 1.05 < f.calc_center_median().x < c.x + R * 1.05]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(ob.data)
    bm.free()
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    K.apply_mods(ob)
    return ob


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # GRP spring spar under the cabin, out and down to the axle
        K.leg_blade(mb, [R(-0.30, -2.255, sy * 0.02), R(-0.31, -2.262, sy * 0.25), R(-0.32, -2.300, sy * 0.45),
                         R(-0.335, -2.385, sy * 0.60), V(ax.x + 0.005, sy * (MAIN_Y - 0.075), ax.z + 0.05)],
                    chord=0.15, thick=0.036, mat='Paint_Dark')
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.075), ax.z), V(ax.x, sy * (MAIN_Y - 0.067), ax.z), 0.09, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.075, sy * (MAIN_Y - 0.071), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        # brake line along the spar
        mb.tube(catmull([R(-0.29, -2.27, sy * 0.10), R(-0.305, -2.305, sy * 0.45),
                         V(ax.x + 0.06, sy * (MAIN_Y - 0.08), ax.z + 0.06)], 5), 0.004, 'Rubber', n=6)
    mb.box(R(-0.30, -2.25), (0.17, 0.12, 0.04), 'Metal_Frame', bevel=0.008, segs=2)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        spats.append(half_spat(name, c, R=0.205, front=0.235, back=0.37, hw=0.088, top=0.058, lift=0.085,
                               mat='Paint_White', exp_top=2.2, belly=0.02))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=0.205, w=0.11)
    nc = R(NOSE[0], NOSE[1])
    K.nose_gear(nc, R=0.145, w=0.10, leg_top=R.z(-2.33), rake=-0.075)
    return gear, spats


# ---- cockpit ---------------------------------------------------------------------------------------
def seat(mb, hip, back_deg, width=0.42, waist=None, back_h=0.62):
    """Composite seat shell with a padded cushion and back (red-striped black upholstery)."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    c = V(hip.x + 0.12, hip.y, hip.z - 0.135)
    mb.box(c, (0.44, width, 0.06), 'Seat', bevel=0.025, segs=3, rot=Euler((0, math.radians(-8), 0)))
    hb = c.z - 0.03 - R.z(FLOOR_Z)
    if hb > 0.02:
        mb.box(V(c.x - 0.02, c.y, R.z(FLOOR_Z) + hb * 0.5), (0.42, width - 0.04, hb), 'Carbon', bevel=0.008, segs=1)
    wb = waist if waist else width
    rings = []
    for k in range(7):
        t = k / 6
        cc = hip - f * 0.195 + u * (0.02 + back_h * t)
        w = lerp(wb, width, max(0.0, min(1.0, (t - 0.55) / 0.35)) ** 1.5) * 0.5
        ring = []
        for j in range(13):
            a = math.pi * j / 12
            ring.append(cc + V(0, math.cos(a) * w, 0) - f * (0.04 * math.sin(a)))
        for j in range(12, -1, -1):
            a = math.pi * j / 12
            ring.append(cc + V(0, math.cos(a) * w, 0) - f * (0.04 * math.sin(a) + 0.03))
        rings.append(ring)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    pad_c = hip - f * 0.158 + u * (0.02 + back_h * 0.5)
    mb.box(pad_c, (0.04, width * 0.78, back_h * 0.92), 'Seat', bevel=0.016, segs=2, rot=rb)
    for dy in (-0.07, 0.07):
        mb.box(pad_c + f * 0.021 + V(0, dy, 0), (0.004, 0.022, back_h * 0.88), 'Lens_Red', rot=rb)


def build_cockpit():
    mb = MB('cockpit')
    seat(mb, FRONT_HIP, FRONT_BACK, width=0.42, waist=0.24, back_h=0.64)
    seat(mb, REAR_HIP, REAR_BACK, width=0.44, back_h=0.60)
    # floor, tank / baggage boxes under the rear seat, rear bulkhead under the pylon
    ring = [p for p in hull_ring(-0.24, n_half=20, scale=0.97)]
    ring2 = [p + V(-0.03, 0, 0) for p in ring]
    mb.loft([ring, ring2], 'Interior', closed=True, cap0=True, cap1=True)
    # passenger foot rests either side of the front seat
    for sy in (1, -1):
        mb.box(R(0.80, -2.345, sy * 0.25), (0.20, 0.10, 0.012), 'Metal_Frame', bevel=0.003, segs=1, rot=K.rot_y(-15))
    return mb.finish(sharp_angle=40, wn=True)


def build_calidus():
    pod = build_hull()
    lines = build_hull_lines(pod)
    canopy, cframe, cseal = split_canopy(pod)
    pylon, mast_head = build_pylon()
    keel = build_keel()
    K.build_head(PIVOT, HUB, arm=-0.22, arm_w=0.22)
    K.build_rotor(HUB, R=4.2, chord=0.20, root=0.50, tip_mat='Decal_White', clamp_len=0.50)
    K.build_prop(PROP, R=0.86, blades=3, hub='spinner', hub_r=0.098, hub_len=0.20, tip_mat='Carbon',
                 spinner_mat='Paint_White')
    tail = build_tail()
    build_rudder()
    gear, spats = build_gear()
    cockpit = build_cockpit()

    # ---- controls and crew: pilot in the FRONT seat, throttle quadrant on his left
    ctrl = MB('controls_static')
    stick_base = R(1.255, -2.335)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.20, -1.83))
    knob, lever = controls.throttle_lever(ctrl, R(1.06, -2.02, 0.285))
    feet_z = -2.20
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.56, feet_z, 0.12), 'R': R(1.56, feet_z, -0.12)}, knee_out=0.04,
                      elbow_out=0.06, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(FLOOR_Z + 0.03))
    tilt = 22.0
    p0 = R(1.46, -1.95)
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(0.0, 0.035, 0.38, 0.14), cw=0.062, v_leg=-0.06,
                      v_sb=-0.26, v_b=-0.33, top_arch=(0.26, 0.05, 0.13), max_u=0.30, leg_exp=0.25)
    t = math.radians(tilt)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    ctrl.box(p0 + upv * 0.135 - nrm * 0.07, (0.17, 0.52, 0.02), 'Panel', bevel=0.01, segs=2, rot=K.rot_y(-8))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.25, -0.13, 0.13), None),
                             'L': ('rest', REAR_HIP + V(0.25, 0.13, 0.13), None)},
                      feet={'L': R(0.80, -2.19, 0.245), 'R': R(0.80, -2.19, -0.245)}, knee_out=0.12, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    # ---- details
    det = MB('details')
    K.pitot(det, R(XTIP - 0.012, ZTIP + 0.035), (1, 0, -0.05), length=0.07)
    # (no lamp on the fin top: plain on every photographed Calidus, 01, 28, 31, 33)
    # prop flange between the cowling and the spinner, exhaust tail pipe (left)
    det.cyl(R(X_END + 0.02, -1.415), PROP + V(0.075, 0, 0), 0.105, 'Engine_Dark', n=28)
    K.exhaust_stub(det, [R(-0.62, -1.80, 0.235), R(-0.72, -1.86, 0.235), R(-0.80, -1.93, 0.215)], r=0.022)
    det.cyl(R(-0.80, -1.93, 0.215) + V(-0.012, -0.002, -0.013), R(-0.80, -1.93, 0.215) + V(0.004, 0, 0.004), 0.017,
            'Radiator', n=10)
    K.antenna(det, R(0.35, -2.40), (-0.25, 0, -1), length=0.22)
    K.antenna(det, R(-0.70, -2.21), (-0.3, 0, -1), length=0.16)
    det = det.finish(sharp_angle=50)
    script = K.decal_text(pod, 'calidus', R.x(1.05), R.z(-2.135), size=0.075, mat='Paint_White')

    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit], ' (pilot)')
    K.clearance(['pilot_rear'], [pod, cockpit, ctrl], ' (passenger)')
    K.finalize([pod, lines, cframe, cseal, pylon, mast_head, keel, tail, gear, cockpit, ctrl, det] + spats + script,
               [canopy])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.65), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })

    def g(p):       # Blender (x, y, z) -> sim (x forward, y up, z right)
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('CALIDUS hub %s pivot %s prop %s eye %s' % (g(HUB), g(PIVOT), g(PROP), g(eye)))
    print('CALIDUS ground y %.3f  main axle %s  nose axle %s  stick %s' % (
        R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)), g(R(NOSE[0], NOSE[1])), g(stick_base)))
    print('CALIDUS nose tip %s  rudder TE %s  fin top %s  keel low %s  stab LE root %s tip %s TE %s' % (
        g(R(XTIP, ZTIP)), g(R(-2.655, -1.875)), g(R(-2.03, FIN_TOP)), g(R(*ph(650, 870))),
        g(R(STAB_LE0, STAB_Z)), g(R(STAB_LE1, STAB_Z, SPAN)), g(R(STAB_TE, STAB_Z))))


VIEWS = {
    # same angles as the reference photos: 14 (RA-1300G, front left quarter), 01 (left side, from behind),
    # 06 (front)
    'ref_14': dict(extra=True, loc=(3.3, 4.7, 0.45), target=(-0.45, 0.0, -0.15), lens=28, rotor=-60, prop=20),
    'ref_01': dict(extra=True, loc=(-3.6, 9.6, 0.35), target=(-0.40, 0.0, 0.10), lens=45, rotor=5, prop=20),
    'ref_front': dict(extra=True, loc=(10.0, 0.0, -0.10), target=(0.0, 0.0, -0.10), ortho=3.4, rotor=90, prop=0),
    'interior': dict(extra=True, loc=(0.56, 0.0, 0.17), target=(1.25, 0.0, -0.17), lens=22, rotor=75, prop=0),
    'ref_top': dict(extra=True, loc=(0.0, 0.0, 30.0), target=(-0.3, 0.0, 0.0), ortho=5.8, rotor=90, prop=0),
    # lamp close-ups: left unit as on 33 (D-MCEY), right unit as on 31 (D-MCUS), nose lamps as on 33
    'lamp_left': dict(extra=True, loc=(1.2, 2.5, 0.25), target=(-0.23, 0.38, -0.09), lens=50, rotor=75, prop=20),
    'lamp_right': dict(extra=True, loc=(-1.6, -2.4, 0.45), target=(-0.23, -0.38, -0.09), lens=50, rotor=75, prop=20),
    'nose_lamps': dict(extra=True, loc=(2.75, 0.55, -0.30), target=(1.80, 0.0, -0.42), lens=55, rotor=75, prop=20),
}

if __name__ == '__main__':
    K.run('calidus', build_calidus, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
