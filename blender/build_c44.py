"""
BellComm C-44 MEDEVAC for the Autogiro web sim: the ambulance gyroplane that BellComm Information Systems
(Madrid; defence communications, "Supporting Our Troops") and Celier Aviation (Raphael Celier; Warsaw /
Malta) developed in a joint venture in 2013-2016 on the Celier Xenon IV CA-22 airframe (sold later by
FlyArgo, Poland, as the "Xenon IV CA-22 / C-44 MEDEVAC"). Presented to the Spanish Army medical brigade at
Los Alcores (Seville) in April 2016. This is the camouflaged prototype D-MEDC of the owner's photo (hangar,
2016) with the red crosses, "C-44 MEDEVAC" stencil, BellComm logo and "PULL TO OPEN".

Airframe (DAeC type data sheet 61208.1 issue 6, Xenon IV CA-22): carbon monocoque, side-by-side cabin
"extended" with the stretcher on the RIGHT (loaded through the front door: the right half of the
windscreen and nose top hinges open), two sidepods (luggage) carrying the aluminium main legs, twin tail
booms to two fins with rudders and a high tailplane with downward winglets, cowled CA 912 ULST (Celier's
turbocharged 912 ULS) driving a Kaspar KA 2/3 three-blader (1.72 m) with spinner. Length 5.65 m, height
with rotor 2.80 m, width with sidepods 2.32 m, rotor 8.80 m.

TRACING. Side profile: Argo's MEDEVAC brochure photo of a white CA-22 on a runway (p10 of
XENON-CA-22-MEDEVAC-EN.pdf, 2967 x 1294 px, long lens from far away: both main wheels and both fins almost
overlap, so it is used as an orthographic view; camera 2.9 deg behind the beam and 2.9 deg above). Scale
403 px/m from the published height (2.80 m to the rotor top) and length (5.65 m); hub (teeter bolt) at px
(1609, 112). `p10()` converts its pixels to the hub frame. Plan view: the top-view drawing of BellComm's
2015 brochure (to scale with the type sheet: 2.32 m across the sidepods / tailplane, fins 1.36 m apart,
cabin 1.17 m wide). Checked on the Commons photo of D-MEDC (Luqa 2017), the hangar photos of the owner,
the factory side photo of SP-XFAA (camera solved in perspective, tools in the scratch dir) and the D800
front photo _2CA2925.

CENTRE OF GRAVITY. The type sheet gives 2121-2344 mm behind the nose tip (= 0.03-0.25 m ahead of the
rotor axis); the sim convention is used instead (0.33 m ahead of the hub, gyrokit point 5), height 0.85 m
above the main axle (no published value).

SEATING: pilot in command in the LEFT seat (+y in Blender, -z in the sim) with the stick, the throttle
quadrant on the left wall, pedals and the instrument pod; the right half of the cabin is the stretcher
(rails from the nose door to the rear bulkhead). The menu passenger (`pilot_rear`) is the PATIENT lying
on it, head aft next to the medical bags (BellComm / Argo: "1+1", pilot + patient on the stretcher; the
optional paramedic seat behind the pilot is not carried at 560 kg).

  blender -b -P blender/build_c44.py -- [--previews] [--only VIEW,...] [--show-rear]
                                        [--overlay yaw,cx,cz,ppm,w,h,side] [--overlay-out file.png]
Outputs: public/models/c44.glb, blender/c44.blend, blender/previews/c44/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix, noise

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- reference side photo (Argo brochure p10, nose to the LEFT) -> hub frame -----------------------
PPM = 403.0
HUB_PX = (1609.0, 112.0)


def p10(x, y):
    return ((HUB_PX[0] - x) / PPM, (HUB_PX[1] - y) / PPM)


def p10s(pts):
    return [p10(x, y) for x, y in pts]


# ---- hub frame -----------------------------------------------------------------------------------
GROUND = -2.754                          # nose tyre contact (px 1222): hub 2.754 m up, rotor top 2.80 m
WR = 0.178                               # 4.00-6 tyres (type sheet), all three wheels alike on the photos
AXLE = (-0.164, GROUND + WR)             # main axle 16 cm behind the rotor axis (mean of near and far wheel)
MAIN_Y = 0.98                            # main wheels under the sidepods (1.96 m track)
NOSE = (1.715, GROUND + WR)              # wheelbase 1.78 m
CG = (0.33, AXLE[1] + 0.85)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.03, -0.20)
PROP_X, PROP_Z = -1.00, -1.459           # Kaspar KA 2/3, 1.72 m, blade roots (spinner centre px 2005, 700)
PROP = R(PROP_X, PROP_Z)
SEAT_Y = 0.23                            # pilot on the left (+y)

LIVERY = dict(body=('#5D5C47', 0.0, 0.62), accent=('#626567', 0.0, 0.62), dark=('#2B2D2A', 0.1, 0.55),
              seat=('#1C1D1F', 0.0, 0.8))
REG = 'D-MEDC'

# ---- hull profile (P10 pixels) ----
TOP_PX = [(652, 947), (660, 932), (680, 918), (700, 906), (720, 896), (740, 887), (760, 878), (780, 870),
          (800, 862), (820, 855), (840, 845), (860, 830), (900, 805), (940, 781), (980, 757), (1020, 732),
          (1060, 708), (1085, 684), (1100, 660), (1115, 640), (1135, 626), (1175, 613), (1200, 606),
          (1275, 598), (1350, 595), (1425, 594), (1500, 594), (1600, 592), (1650, 590), (1700, 591),
          (1750, 600), (1800, 614), (1850, 629), (1900, 646), (1950, 664), (1990, 682)]
BOT_PX = [(652, 947), (655, 960), (670, 970), (700, 985), (750, 1005), (800, 1021), (850, 1031), (900, 1037),
          (950, 1040), (1100, 1042), (1300, 1042), (1450, 1041)]
# rear underside (hub frame): hidden behind the sidepod down to X -0.42, then the cowl bottom of the photo
BOT_REAR = [(0.10, -2.303), (-0.10, -2.296), (-0.22, -2.270), (-0.33, -2.205), (-0.424, -2.105), (-0.50, -2.005),
            (-0.60, -1.906), (-0.72, -1.782), (-0.85, -1.645), (-0.945, -1.533)]
XTIP, ZTIP = p10(652, 947)
X_END = -0.945
# plan half-width (BellComm drawing, 286 px/m, nose tip at drawing x 1560): (X hub frame, half-width)
W_TAB = [(XTIP, 0.0), (2.345, 0.115), (2.29, 0.180), (2.20, 0.240), (2.095, 0.287), (1.95, 0.352), (1.816, 0.405),
         (1.536, 0.480), (1.256, 0.527), (0.976, 0.556), (0.70, 0.575), (0.40, 0.583), (0.10, 0.575),
         (-0.15, 0.552), (-0.35, 0.515), (-0.55, 0.455), (-0.70, 0.385), (-0.80, 0.315), (-0.88, 0.235),
         (X_END, 0.135)]
# height of the widest line (front photo: widest a third of the way up the cabin side)
BELT_TAB = [(XTIP, ZTIP), (2.20, -2.110), (1.90, -2.090), (1.50, -2.050), (1.00, -2.010), (0.40, -1.990),
            (0.00, -1.990), (-0.30, -1.930), (-0.50, -1.800), (-0.70, -1.640), (-0.85, -1.540), (X_END, -1.475)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    pairs = sorted(pairs, key=lambda p: -p[0])
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


_top = p10s(TOP_PX)
_bot = p10s(BOT_PX) + BOT_REAR
F_T, F_B, F_W, F_M = _prof(_top), _prof(_bot), _prof(W_TAB), _prof(BELT_TAB)
F_NT = B.hermite([X_END, -0.6, -0.2, 0.4, 1.2, 1.9, XTIP], [2.2, 2.3, 2.4, 2.35, 2.3, 2.2, 2.0])
F_NB = B.hermite([X_END, -0.6, -0.3, 0.4, 1.4, 2.0, XTIP], [2.2, 2.6, 3.0, 3.2, 3.0, 2.4, 2.0])


def hull(X):
    u = _u(X)
    zt, zb, w = F_T(u), F_B(u), max(F_W(u), 1e-4)
    h = zt - zb
    zm = min(max(F_M(u), zb + 0.12 * h), zt - 0.2 * h)
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


def hull_ring(X, n_half=30, scale=1.0):
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


def hull_z(X, y, top=True):
    zt, zb, w, zm, nt, nb = hull(X)
    f = min(1.0, abs(y) / w)
    if top:
        return zm + (zt - zm) * max(0.0, 1 - f ** nt) ** (1 / nt)
    return zm - (zm - zb) * max(0.0, 1 - f ** nb) ** (1 / nb)


def cast_side(target, X, Z, sy, depth=1.6):
    p = R(X, Z, sy * depth)
    ok, loc, nrm, _ = target.ray_cast(p, V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def cast_top(target, X, y):
    ok, loc, nrm, _ = target.ray_cast(R(X, 1.0, y), V(0, 0, -1))
    return (loc, nrm) if ok else (None, None)


# ---- glazing (P10 pixels) ----
# windscreen: everything above this lower edge and ahead of the A-pillar (the right half is the stretcher door)
P_WS = [(838, 846), (850, 862), (870, 876), (900, 884), (935, 886), (968, 880), (990, 866), (1008, 842),
        (1030, 806), (1052, 765), (1074, 722), (1092, 684), (1104, 657), (1112, 636), (1112, 560), (830, 560),
        (830, 846)]
P_DOOR = [(1112, 655), (1180, 646), (1260, 640), (1340, 636), (1358, 641), (1364, 660), (1360, 760), (1352, 852),
          (1342, 874), (1300, 878), (1240, 884), (1160, 898), (1090, 926), (1030, 952), (1006, 962), (996, 952),
          (998, 925), (1012, 878), (1034, 822), (1058, 764), (1082, 710), (1100, 670)]
P_REAR = [(1440, 616), (1520, 613), (1598, 616), (1610, 630), (1612, 700), (1608, 778), (1596, 794), (1520, 796),
          (1436, 795), (1422, 782), (1422, 700), (1428, 630)]
ROOF_X = (p10(1380, 0)[0], p10(1130, 0)[0])          # tinted roof light (front of the roof, ahead of the mast)
ROOF_Z = -1.236


def build_hull():
    us = [0.016 * k for k in range(1, 46)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.04:
        x -= 0.032
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    rings.append(hull_ring(X_END - 0.01, scale=0.82))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60)
    return pod


def side_px(pts, y=0.55):
    """Near-side features of P10 are seen 20.4 px/m of lateral offset too far FORWARD (camera 2.9 deg behind
    the beam: the far main wheel shows 40 px aft of the near one): shift them aft to the centre plane."""
    return [(x + 20.4 * y, yy) for x, yy in pts]


def split_canopy(pod):
    ws, door, rear = R.pts(p10s(side_px(P_WS))), R.pts(p10s(side_px(P_DOOR))), R.pts(p10s(side_px(P_REAR)))
    rx0, rx1 = R.x(ROOF_X[0]), R.x(ROOF_X[1])
    rz = R.z(ROOF_Z)
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    for poly in (ws, door, rear):
        K.bisect_poly(bm, poly)
    E.bisect_all(bm, [E.plane_pts((rx0 - 1, rz), (rx1 + 1, rz))])
    bm.to_mesh(pod.data)
    bm.free()

    def inside(c):
        if PANEL.inside(ws, c.x, c.z) or PANEL.inside(door, c.x, c.z) or PANEL.inside(rear, c.x, c.z):
            return True
        return rx0 < c.x < rx1 and c.z > rz and abs(c.y) < 0.22
    return K.split_glass(pod, inside, frame_r=0.007, frame_mat='Paint_White', seal=True, thickness=0.012,
                         name='canopy')


# ---- mast ----
MAST_X0, MAST_X1, MAST_HW = 0.035, 0.270, 0.062
MAST_TOP = -0.150


def build_mast():
    mb = MB('mast')
    zb = -1.36
    h = MAST_TOP - zb
    mb.box(R(0.5 * (MAST_X0 + MAST_X1), zb + h * 0.5), (MAST_X1 - MAST_X0, 2 * MAST_HW, h), 'Paint_White',
           bevel=0.03, segs=3)
    # foot fairing flaring into the roof
    for k in range(4):
        t = k / 3.0
        mb.box(R(0.5 * (MAST_X0 + MAST_X1) + 0.01, -1.215 + 0.025 * t), (MAST_X1 - MAST_X0 + 0.10 * (1 - t) + 0.02,
               2 * MAST_HW + 0.10 * (1 - t), 0.05), 'Paint_White', bevel=0.02, segs=2)
    mast = mb.finish(sharp_angle=40)
    # head: cheek plates with lightening holes on top of the mast, aft to the pitch pivot
    hb = MB('mast_head')
    for sy in (1, -1):
        hb.box(R(0.11, -0.25, sy * 0.050), (0.22, 0.012, 0.20), 'Alu_Grey', bevel=0.012, segs=2)
        for zc in (-0.21, -0.30):
            hb.cyl(R(0.15, zc, sy * 0.058), R(0.15, zc, sy * 0.064), 0.026, 'Paint_Dark', n=18)
        hb.cyl(PIVOT + V(0, sy * 0.042, 0), PIVOT + V(0, sy * 0.066, 0), 0.016, 'Engine', n=12)
        for zc in (-0.17, -0.36):
            for xc in (0.04, 0.20):
                hb.cyl(R(xc, zc, sy * 0.056), R(xc, zc, sy * 0.062), 0.006, 'Metal_Frame', n=8)
    hb.box(R(0.13, MAST_TOP + 0.004), (0.24, 0.112, 0.016), 'Alu_Grey', bevel=0.006, segs=1)
    return mast, hb.finish(sharp_angle=40, wn=True)


def build_controls_up():
    """Push-pull rods and the pre-rotator drive hose from the roof up to the head (behind the mast)."""
    mb = MB('head_rods')
    zr = -1.16
    for (x, y) in ((-0.10, 0.05), (-0.19, -0.05)):
        top = R(-0.16, -0.24, y)
        mb.cyl(R(x, zr, y), R(x, -0.30, y), 0.011, 'Alu_Grey', n=10)
        mb.cyl(R(x, -0.30, y), top, 0.008, 'Metal_Frame', n=8)
        mb.cyl(R(x, zr - 0.02, y), R(x, zr + 0.03, y), 0.022, 'Rubber', n=12)
    hose = [R(-0.19, -1.17, 0.0), R(-0.20, -0.95, 0.0), R(-0.18, -0.62, 0.0), R(-0.12, -0.34, 0.0),
            R(-0.04, -0.25, 0.0)]
    mb.tube(catmull(hose, 6), 0.016, 'Rubber', n=12)
    return mb.finish(sharp_angle=40)


# ---- sidepods (CA-22 luggage pods carrying the main legs) ----
SP_Z = -2.175


def sp_le(y):
    t = max(0.0, (y - 0.45) / 0.71)
    return 0.375 - 0.16 * t ** 1.3


def sp_te(y):
    t = max(0.0, (y - 0.45) / 0.71)
    return -0.405 + 0.06 * t


def build_sidepods():
    mb = MB('sidepods')
    ys = [0.40, 0.48, 0.58, 0.70, 0.82, 0.94, 1.03, 1.09, 1.125, 1.145, 1.158, 1.163]
    for sy in (1, -1):
        rings = []
        for y in ys:
            le, te = sp_le(y), sp_te(y)
            tip = max(0.0, (y - 1.06) / 0.103)
            k = math.sqrt(max(0.0, 1 - tip ** 2))             # rounded tip in plan and in thickness
            xc = 0.5 * (le + te) - 0.04 * tip
            c = max((le - te) * (0.15 + 0.85 * k), 0.02)
            th = (0.118 - 0.03 * max(0.0, (y - 0.45) / 0.71)) * (0.2 + 0.8 * k)
            if y < 0.50:                                      # root fillet into the hull
                th += 0.06 * (0.50 - y) / 0.10
                c += 0.25 * (0.50 - y) / 0.10
            ring = []
            for j in range(28):
                a = TAU * j / 28
                ca, sa = math.cos(a), math.sin(a)
                ring.append(R(xc + 0.5 * c * math.copysign(abs(ca) ** 0.75, ca),
                              SP_Z + 0.5 * th * math.copysign(abs(sa) ** 0.85, sa), sy * y))
            rings.append(ring)
        if sy < 0:
            rings = [r[::-1] for r in rings]
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=False)
    return mb.finish(sharp_angle=50)


# ---- tail: twin booms, two fins with rudders, high tailplane with downward winglets ----
FIN_Y = 0.68
BOOM_Z = -2.165
BOOM_X0, BOOM_X1 = -0.25, -2.86
FIN_ZB, FIN_ZT = -2.117, -1.478
FIN_LE_B, FIN_LE_T = -2.084, -2.283
HINGE = -2.866
RUD_TE_T, RUD_TE_B, RUD_ZB, RUD_Z0 = -3.089, -3.362, -1.955, -2.104
STAB_LE, STAB_TE, STAB_ZT, STAB_T = -2.144, -3.089, -1.422, 0.060
STAB_Y = 1.16
WL_ZB = -1.790


def fin_le(z):
    Z = z - R.dz
    t = (Z - FIN_ZB) / (FIN_ZT - FIN_ZB)
    x = lerp(FIN_LE_B, FIN_LE_T, t)
    x += 0.06 * max(0.0, (0.10 - t) / 0.10) ** 2          # fillet onto the boom
    return R.x(x)


def rud_te(z):
    Z = z - R.dz
    if Z >= RUD_ZB:
        x = lerp(RUD_TE_B, RUD_TE_T, (Z - RUD_ZB) / (FIN_ZT - RUD_ZB))
    else:
        x = lerp(HINGE, RUD_TE_B, max(0.0, (Z - RUD_Z0) / (RUD_ZB - RUD_Z0)))
    return R.x(x)


def build_tail():
    mb = MB('tail')
    # booms (aluminium tubes painted with the airframe)
    for sy in (1, -1):
        mb.cyl(R(BOOM_X0, BOOM_Z, sy * FIN_Y), R(BOOM_X1, BOOM_Z, sy * FIN_Y), 0.0425, 'Paint_White', n=20)
        mb.lathe([(0.0, 0.0), (0.036, 0.0), (0.0425, 0.012), (0.0425, 0.02)], R(BOOM_X1 + 0.02, BOOM_Z, sy * FIN_Y),
                 V(1, 0, 0), 'Paint_Dark', n=16)
    # fixed fins (LE -> hinge)
    zs = [R.z(z) for z in (FIN_ZB, -2.09, -2.05, -1.95, -1.80, -1.65, -1.55, FIN_ZT + 0.01)]
    for sy in (1, -1):
        E.fin_loft(mb, zs, fin_le, lambda z: R.x(HINGE + 0.004), y_fn=lambda z, sy=sy: sy * FIN_Y, t=0.085)
        # root fairing along the boom under the fin
        mb.tube([R(FIN_LE_B + 0.05, BOOM_Z + 0.01, sy * FIN_Y), R(HINGE, BOOM_Z + 0.01, sy * FIN_Y)], 0.05,
                'Paint_White', n=16)
    # tailplane: one piece across both fins, symmetric section; each tip bends down (radius RB) into a
    # winglet whose leading edge sweeps back to a short bottom chord (type sheet: "downward pointing winglets")
    ch = STAB_LE - STAB_TE
    loop = airfoil_ring(16, STAB_T / ch, te_min=0.0025)
    zc = STAB_ZT - 0.5 * STAB_T
    RB = 0.06
    y0 = STAB_Y - RB
    rings = []
    for y in (-y0, -1.0, -0.8, -FIN_Y, -0.4, 0.0, 0.4, FIN_Y, 0.8, 1.0, y0):
        rings.append([R(STAB_LE - s * ch, zc + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True)
    for sy in (1, -1):
        secs = []
        for k in range(1, 8):                     # bend: the section turns from horizontal to vertical
            a = 0.5 * math.pi * k / 7
            yc, zcen = y0 + RB * math.sin(a), zc - RB * (1 - math.cos(a))
            secs.append([R(STAB_LE - s * ch, zcen + tz * ch * math.cos(a), sy * (yc + tz * ch * math.sin(a)))
                         for s, tz in loop])
        ztop = zc - RB
        for k in range(1, 9):                     # winglet
            t = k / 8.0
            z = lerp(ztop, WL_ZB, t)
            le = lerp(STAB_LE, -2.80, t ** 0.42)
            te = lerp(STAB_TE, STAB_TE - 0.012, t)
            c = le - te
            secs.append([R(le - s * c, z, sy * (STAB_Y + tz * c)) for s, tz in loop])
        first = [R(STAB_LE - s * ch, zc + tz * ch, sy * y0) for s, tz in loop]
        secs = [first] + secs
        if sy < 0:
            secs = [r[::-1] for r in secs]
        mb.loft(secs, 'Paint_White', closed=True, cap1=True)
    return mb.finish(sharp_angle=45)


def build_rudders():
    zs = [R.z(z) for z in (RUD_Z0 + 0.02, -2.06, -2.0, RUD_ZB, -1.85, -1.70, -1.58, FIN_ZT - 0.004)]
    rud = {}
    for sy, name in ((1, 'rudder_L'), (-1, 'rudder_R')):
        ob = E.build_rudder_surface(name, zs, fin_le, rud_te, R.x(HINGE), R(HINGE, -1.80, 0.0), t=0.085,
                                    mat='Paint_White')
        ob.location = R(HINGE, -1.80, sy * FIN_Y)
        rud[name] = (ob, ob.location.copy())
    # ground-adjustable trim tab on the right rudder (type sheet)
    ob, origin = rud['rudder_R']
    tab = MB('trimtab')
    tc = R(-3.20, -1.86, -FIN_Y)
    tab.box(tc, (0.10, 0.004, 0.12), 'Metal_Frame', bevel=0.0, rot=Euler((0, math.radians(-29), 0)))
    t_ob = tab.finish(origin=origin, sharp_angle=60)
    B.join_objects('rudder_R', [ob, t_ob])
    return rud


# ---- gear ----
def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # aluminium leg: from under the sidepod, down and out to the inboard axle stub
        top = R(-0.035, SP_Z - 0.045, sy * 0.80)
        bot = V(ax.x, sy * (MAIN_Y - 0.085), ax.z + 0.02)
        K.leg_blade(mb, [top, top.lerp(bot, 0.5) + V(0, 0, 0.0), bot], chord=0.075, thick=0.026, mat='Alu_Grey')
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.072), ax.z), V(ax.x, sy * (MAIN_Y - 0.064), ax.z), 0.085, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.07, sy * (MAIN_Y - 0.07), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008, segs=1)
        mb.box(R(-0.035, SP_Z - 0.05, sy * 0.80), (0.12, 0.06, 0.03), 'Alu_Grey', bevel=0.008, segs=2)
    gear = mb.finish(sharp_angle=40, wn=True)
    K.wheel('wheel_L', V(ax.x, MAIN_Y, ax.z), R=WR, w=0.11)
    K.wheel('wheel_R', V(ax.x, -MAIN_Y, ax.z), R=WR, w=0.11)
    nc = R(NOSE[0], NOSE[1])
    K.nose_gear(nc, R=WR, w=0.11, leg_top=R.z(-2.30), rake=-0.14, single=True, fork_mat='Alu_Grey')
    return gear


# ---- cabin interior ----
PILOT_HIP = R(0.80, -2.115, SEAT_Y)
BACK = 20.0
FLOOR_Z = -2.268
STR_Y = -0.230                          # stretcher centre line (right half)
STR_X0, STR_X1 = 0.08, 1.60
STR_Z = -2.115                          # canvas top (low on its rails: the patient lies flat under the canopy)
PAT_HIP = R(0.76, STR_Z + 0.135, STR_Y)


def seat(mb, hip, back_deg, width=0.38, cushion_len=0.44):
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    rc = Euler((0, math.radians(-6), 0))
    c = V(hip.x + cushion_len * 0.5 - 0.10, hip.y, hip.z - 0.125)
    mb.box(c, (cushion_len, width, 0.08), 'Seat', bevel=0.03, segs=3, rot=rc)
    mb.box(c - V(0, 0, 0.07), (cushion_len - 0.04, width - 0.06, 0.08), 'Interior', bevel=0.02, segs=1)
    back_c = hip - f * 0.175 + u * 0.36
    mb.box(back_c, (0.08, width, 0.74), 'Seat', bevel=0.03, segs=3, rot=rb)
    mb.box(back_c - f * 0.045, (0.03, width - 0.02, 0.72), 'Carbon', bevel=0.012, segs=2, rot=rb)
    for sy in (1, -1):
        mb.box(c + V(0.02, sy * (width * 0.5 - 0.02), 0.04), (cushion_len - 0.08, 0.045, 0.05), 'Seat', bevel=0.016,
               segs=2, rot=rc)


def build_cabin():
    mb = MB('cockpit')
    seat(mb, PILOT_HIP, BACK)
    # floor, rear bulkhead (luggage door to the sidepods behind it)
    mb.box(R(0.90, FLOOR_Z), (1.70, 0.70, 0.012), 'Interior', bevel=0.0)
    ring = hull_ring(-0.02, n_half=24, scale=0.975)
    mb.loft([ring, [p + V(-0.03, 0, 0) for p in ring]], 'Interior', closed=True, cap0=True, cap1=True)
    # stretcher on the right: two rails on the floor, aluminium frame, olive canvas, black straps, handles
    for dy in (0.18, -0.18):
        mb.box(R(0.84, FLOOR_Z + 0.03, STR_Y + dy), (1.56, 0.03, 0.05), 'Alu_Grey', bevel=0.006, segs=1)
        for xl in (0.25, 0.85, 1.48):
            mb.box(R(xl, FLOOR_Z + 0.09, STR_Y + dy), (0.05, 0.03, 0.12), 'Alu_Grey', bevel=0.006, segs=1)
    for dy in (0.215, -0.215):
        mb.cyl(R(STR_X0 - 0.02, STR_Z - 0.02, STR_Y + dy), R(STR_X1 + 0.06, STR_Z - 0.02, STR_Y + dy), 0.016,
               'Alu_Grey', n=12)
        for xe in (STR_X0 - 0.02, STR_X1 + 0.06):
            mb.cyl(R(xe, STR_Z - 0.02, STR_Y + dy), R(xe + math.copysign(0.05, xe - 0.8), STR_Z - 0.02, STR_Y + dy),
                   0.018, 'Rubber', n=12)
    mb.box(R(0.5 * (STR_X0 + STR_X1), STR_Z - 0.012, STR_Y), (STR_X1 - STR_X0, 0.40, 0.02), 'Canvas', bevel=0.006,
           segs=2)
    for xs_ in (0.40, 1.00, 1.45):
        mb.box(R(xs_, STR_Z + 0.002, STR_Y), (0.05, 0.44, 0.006), 'Decal_Black', bevel=0.002, segs=1)
    # medical kit: monitor (Tempus Pro) and bags at the head end, oxygen bottle, drip pole
    mb.box(R(0.30, FLOOR_Z + 0.20, 0.36), (0.30, 0.16, 0.22), 'Med_Red', bevel=0.03, segs=2)
    mb.box(R(0.14, -1.70, -0.50), (0.06, 0.24, 0.20), 'Canvas_Green', bevel=0.02, segs=2)
    mb.box(R(0.03, -1.80, 0.06), (0.09, 0.18, 0.14), 'Panel', bevel=0.012, segs=2)
    mb.box(R(0.075, -1.80, 0.06), (0.004, 0.15, 0.10), 'Visor', bevel=0.0, segs=1)
    mb.cyl(R(0.06, FLOOR_Z, 0.02), R(0.06, -1.38, 0.02), 0.009, 'Alu_Grey', n=8)
    mb.box(R(0.06, -1.50, 0.02), (0.05, 0.12, 0.09), 'Decal_White', bevel=0.01, segs=1)
    mb.cyl(R(0.16, FLOOR_Z + 0.04, 0.50), R(0.16, -1.85, 0.50), 0.05, 'Canvas_Green', n=14)
    return mb.finish(sharp_angle=40, wn=True)


# ---- prop: Kaspar KA 2/3 (grey, yellow tips, blue tape round the edges on the photo) ----
def build_prop():
    """Kaspar KA 2/3: grey blades, yellow tips; on the owner's photo blue tape runs round the blades: here a
    blue band just inside the yellow tip (what still reads on a turning prop)."""
    ob = K.build_prop(PROP, R=0.86, blades=3, hub='spinner', hub_r=0.105, hub_len=0.25, mat='Prop_Grey',
                      tip_mat='Prop_Yellow', spinner_mat='Paint_White', tip_band=0.16, chord_k=1.05)
    me = ob.data
    names = [m.name for m in me.materials]
    me.materials.append(MATS['Prop_Tape'])
    ti = len(me.materials) - 1
    yi = names.index('Prop_Yellow')
    for p in me.polygons:
        if p.material_index == yi and math.hypot(p.center.y, p.center.z) < 0.86 - 0.16 * 0.42:
            p.material_index = ti
    return ob


# ---- decals ----
FONTS = {}


def font(name):
    if name in FONTS:
        return FONTS[name]
    path = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', name)
    f = None
    if os.path.exists(path):
        try:
            f = bpy.data.fonts.load(path, check_existing=True)
        except Exception:
            f = None
    FONTS[name] = f
    return f


def text_poly_mesh(text, size, fnt=None, extrude=0.0, offset=0.0):
    cu = bpy.data.curves.new('dtxt', 'FONT')
    cu.body = text
    cu.size = size
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    cu.offset = offset
    if fnt is not None:
        cu.font = fnt
    try:
        cu.fill_mode = 'BOTH'
    except Exception:
        pass
    tob = bpy.data.objects.new('dtxt', cu)
    bpy.context.scene.collection.objects.link(tob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
    bpy.data.objects.remove(tob)
    bpy.data.curves.remove(cu)
    return me


def project_patch(me2d, target, center, normal, right, up, mat, lift=0.0018, name='decal', subdiv=2, scale=(1, 1)):
    """Lay a flat 2D mesh (x right, y up, metres) on `target` around `center`, projected along -normal."""
    n, rt, upv = Vector(normal).normalized(), Vector(right).normalized(), Vector(up).normalized()
    bm = bmesh.new()
    bm.from_mesh(me2d)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    if subdiv:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=subdiv, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
    else:
        # only split the long edges (glyph stems), so that the decal hugs a curved skin
        for _ in range(4):
            long_e = [e for e in bm.edges if e.calc_length() > 0.022]
            if not long_e:
                break
            bmesh.ops.subdivide_edges(bm, edges=long_e, cuts=1)
            bmesh.ops.triangulate(bm, faces=bm.faces[:])
    inv = target.matrix_world.inverted()
    for v in bm.verts:
        q = Vector(center) + rt * (v.co.x * scale[0]) + upv * (v.co.y * scale[1])
        ok, loc, nrm, _i = target.ray_cast(inv @ (q + n * 0.5), inv.to_3x3() @ (-n), distance=1.5)
        if ok:
            nw = (target.matrix_world.to_3x3() @ nrm).normalized()
            v.co = target.matrix_world @ loc + nw * lift
        else:
            v.co = q
    bm.normal_update()
    for f in bm.faces:
        if f.normal.dot(n) < 0:
            f.normal_flip()
        f.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(MATS[mat])
    ob = bpy.data.objects.new(name, me)
    K.link(ob)
    return ob


def poly_mesh(polys):
    bm = bmesh.new()
    for poly in polys:
        vs = [bm.verts.new((x, y, 0.0)) for x, y in poly]
        bm.faces.new(vs)
    me = bpy.data.meshes.new('dpoly')
    bm.to_mesh(me)
    bm.free()
    return me


def rect(cx, cy, w, h):
    return [(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)]


def cross_poly(s, arm):
    a, b = arm / 2, s / 2
    return [(-a, -b), (a, -b), (a, -a), (b, -a), (b, a), (a, a), (a, b), (-a, b), (-a, a), (-b, a), (-b, -a), (-a, -a)]


def red_cross(target, center, normal, right, up, size, name):
    """White square with a red Greek cross (arms a fifth of the square... as painted on D-MEDC)."""
    obs = [project_patch(poly_mesh([rect(0, 0, size, size * 1.06)]), target, center, normal, right, up, 'Decal_White',
                         lift=0.0016, name=name + '_w', subdiv=3)]
    obs.append(project_patch(poly_mesh([cross_poly(size * 0.98, size * 0.30)]), target, center, normal, right, up,
                             'Decal_Red', lift=0.0030, name=name + '_r', subdiv=3, scale=(1.0, 1.06)))
    return obs


def side_text(target, text, X, Z, size, mat, fnt=None, sides=(1, -1), lift=0.0018, slope=0.0, name='txt',
              scale=(1.0, 1.0), outline=0.0):
    obs = []
    for sy in sides:
        loc, nrm = cast_side(target, X, Z, sy)
        if loc is None:
            continue
        nn = V(0, nrm.y, nrm.z * 0.5).normalized()
        rt = V(-sy, 0, 0)                                   # reads nose -> tail on the left, tail -> nose on the right
        upv = V(0, 0, 1) - nn * nn.z
        upv.normalize()
        rt, upv = (rt * math.cos(slope) + upv * math.sin(slope)).normalized(), (upv * math.cos(slope) - rt * math.sin(slope)).normalized()
        me = text_poly_mesh(text, size, fnt, offset=outline)
        obs.append(project_patch(me, target, loc, nn, rt, upv, mat, lift=lift, name='%s_%s' % (name, 'L' if sy > 0 else 'R'),
                                 subdiv=0, scale=scale))
    return obs


# ---- camouflage: a tileable two-tone texture (olive base, warm light-grey blobs with soft edges, as on the
# owner's photo), projected per face from the dominant axis: crisp at any distance, unlike repainted faces ----
CAMO_TILE = 4.4            # metres per texture tile
CAMO_SIZE = 1024


def camo_image():
    import numpy as np
    img = bpy.data.images.get('camo_c44')
    if img is not None:
        return img
    rng = np.random.default_rng(44)
    n = CAMO_SIZE
    yy, xx = np.mgrid[0:n, 0:n] / n
    f = np.zeros((n, n))
    for _ in range(30):
        cx, cy = rng.random(2)
        rx, ry = rng.uniform(0.05, 0.13, 2)
        a = rng.uniform(0, math.pi)
        dx = (xx - cx + 0.5) % 1.0 - 0.5
        dy = (yy - cy + 0.5) % 1.0 - 0.5
        u = dx * math.cos(a) + dy * math.sin(a)
        v = -dx * math.sin(a) + dy * math.cos(a)
        f += np.exp(-((u / rx) ** 2 + (v / ry) ** 2))
    # small-scale wobble of the edges (periodic)
    f += 0.10 * np.sin(TAU * (7 * xx + 3 * yy)) * np.sin(TAU * (5 * yy - 2 * xx))
    t = np.quantile(f, 0.64)
    s = np.clip((f - t) / 0.16 + 0.5, 0.0, 1.0)
    s = s * s * (3 - 2 * s)
    def hexf(h):                       # an sRGB image takes the display values, not linear ones
        h = h.lstrip('#')
        return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
    olive, grey = hexf(LIVERY['body'][0]), hexf(LIVERY['accent'][0])
    col = olive[None, None, :] * (1 - s[..., None]) + grey[None, None, :] * s[..., None]
    rgba = np.concatenate([col, np.ones((n, n, 1))], axis=2).astype(np.float32)
    img = bpy.data.images.new('camo_c44', n, n, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = 'PNG'
    img.pack()
    return img


def camo_material():
    if 'Camo' in MATS:
        return MATS['Camo']
    m = B.make_mat('Camo', B.srgb(LIVERY['body'][0]), metal=0.0, rough=0.62)
    nt = m.node_tree
    bsdf = [nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED'][0]
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = camo_image()
    tex.interpolation = 'Linear'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    MATS['Camo'] = m
    return m


def camouflage(objs):
    """Faces in Paint_White become 'Camo' with planar UVs (side faces x/z, top and bottom x/y, ends y/z)."""
    cm = camo_material()
    for ob in objs:
        if ob is None:
            continue
        me = ob.data
        names = [m.name for m in me.materials]
        if 'Paint_White' not in names:
            continue
        wi = names.index('Paint_White')
        me.materials[wi] = cm
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        uvl = me.uv_layers.active.data
        mw = ob.matrix_world
        m3 = mw.to_3x3()
        for p in me.polygons:
            if p.material_index != wi:
                continue
            nrm = (m3 @ p.normal).normalized()
            ax = max(range(3), key=lambda i: abs(nrm[i]))
            for li in p.loop_indices:
                w = mw @ me.vertices[me.loops[li].vertex_index].co
                if ax == 1:
                    uv = (w.x, w.z + 0.37)
                elif ax == 2:
                    uv = (w.x + 0.21, w.y + 0.55)
                else:
                    uv = (w.y + 0.83, w.z + 0.12)
                uvl[li].uv = (uv[0] / CAMO_TILE, uv[1] / CAMO_TILE)


# ---- details: lamps, decals, antennas ----
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


def build_details(pod):
    mb = MB('details')
    # nose: almond landing lamp on the RIGHT of the tip (clear lens on a dark reflector; the front photo _2CA2925
    # and the owner's photo show the right side: the stretcher door, its 'PULL TO OPEN' and the nose cross)
    lp = R(2.285, -2.060, -0.115)
    ok, loc, nrm, _ = pod.ray_cast(lp + V(0.6, -0.25, 0.0), V(-0.92, 0.38, 0.0).normalized())
    if ok:
        n = nrm.normalized()
        fw = V(-0.35, -1.0, 0.18)
        oval_patch(mb, pod, loc, n, fw, 0.125, 0.040, 'Decal_Black', h0=0.0015, h1=0.004, taper=0.8)
        oval_patch(mb, pod, loc + n * 0.002, n, fw, 0.105, 0.030, 'Chrome', h0=0.003, h1=0.006, taper=0.8)
        oval_patch(mb, pod, loc + n * 0.004, n, fw, 0.07, 0.016, 'Lens_White', h0=0.006, h1=0.010, taper=0.55)
        K.lamp_node('landing', loc + n * 0.03, 'tip')
    # long slim lamps along the lower nose flanks, both sides (P10: px 690-845, 965-1030)
    for sy in (1, -1):
        X, Z = p10(768, 1000)
        loc, nrm = cast_side(pod, X, Z, sy)
        if loc is not None:
            nn = V(nrm.x * 0.4, nrm.y, nrm.z).normalized()
            fw = V(1.0, 0, 0.42)
            oval_patch(mb, pod, loc, nn, fw, 0.20, 0.052, 'Decal_Black', h0=0.0015, h1=0.004, taper=0.88)
            oval_patch(mb, pod, loc + nn * 0.002, nn, fw, 0.18, 0.040, 'Smoke', h0=0.004, h1=0.008, taper=0.7)
            K.lamp_node('landing', loc + nn * 0.03, 'L' if sy > 0 else 'R')
    # nav lights: red round lamp on the left cowl side behind the rear window (P10 px 1622, 793) in a dark
    # air-outlet recess; green on the right (MIRRORED: the right side is not shown well enough on any photo)
    for sy in (1, -1):
        X, Z = p10(1622, 793)
        loc, nrm = cast_side(pod, X, Z, sy)
        if loc is None:
            continue
        nn = V(0, nrm.y, nrm.z).normalized()
        oval_patch(mb, pod, loc + V(0.005, 0, 0.02), nn, V(0.2, 0, 1.0), 0.17, 0.030, 'Decal_Black', h0=0.0015,
                   h1=0.003, taper=0.9)
        K.lamp(mb, loc + nn * 0.002, nn, kind='red' if sy > 0 else 'green', r=0.022, length=0.018, base='Paint_Dark')
        K.lamp_node('navL' if sy > 0 else 'navR', loc + nn * 0.035)
        # two round air outlets with a lip (P10 px 1790, 685 / 785)
        for py in (685, 785):
            X2, Z2 = p10(1790, py)
            l2, n2 = cast_side(pod, X2, Z2, sy)
            if l2 is not None:
                n2 = V(0, n2.y, n2.z).normalized()
                mb.lathe([(0.0, -0.004), (0.026, -0.004), (0.030, 0.006), (0.034, 0.010), (0.034, 0.004)], l2, n2,
                         'Paint_White', n=18)
                mb.cyl(l2 - n2 * 0.003, l2 + n2 * 0.001, 0.024, 'Paint_Dark', n=16)
    # anti-collision: red beacon on the roof ahead of the mast (P10 px 1452, 575; also on the hangar photo)
    loc, nrm = cast_top(pod, 0.40, 0.0)
    if loc is not None:
        mb.cyl(loc - V(0, 0, 0.004), loc + V(0, 0, 0.012), 0.03, 'Paint_Dark', n=16)
        mb.lathe([(0.026, 0.0), (0.024, 0.02), (0.016, 0.034), (0.0, 0.038)], loc + V(0, 0, 0.012), V(0, 0, 1),
                 'Lens_Red', n=16)
        K.lamp_node('beacon', loc + V(0, 0, 0.065), 'red')
    # sidepod lamp lenses (small amber-clear lens on each pod top, P10 px 1505, 993)
    # (decorative: no light node: they are not lit on any photo)
    # nose door latches: two black knobs and a hasp on the nose top (front photo)
    for y, x in ((0.06, 1.95), (-0.10, 1.97)):
        l2, n2 = cast_top(pod, x, y)
        if l2 is not None:
            mb.lathe([(0.0, 0.0), (0.016, 0.0), (0.014, 0.012), (0.0, 0.016)], l2, n2, 'Decal_Black', n=12)
    l2, n2 = cast_top(pod, 1.90, -0.02)
    if l2 is not None:
        mb.box(l2 + n2 * 0.004, (0.06, 0.018, 0.008), 'Chrome', bevel=0.003, segs=1)
    # door handles and "PULL TO OPEN" pull knob ahead of the door
    for sy in (1, -1):
        X, Z = p10(1215, 912)
        loc, nrm = cast_side(pod, X, Z, sy)
        if loc is not None:
            mb.box(loc + nrm * 0.006, (0.075, 0.016, 0.020), 'Chrome', bevel=0.005, segs=2)
        X, Z = p10(972, 905)
        loc, nrm = cast_side(pod, X, Z, sy)
        if loc is not None:
            mb.cyl(loc - nrm * 0.004, loc + nrm * 0.004, 0.016, 'Decal_Black', n=14)
    # exhaust under the rear cowl, radiator scoop on the belly, antennas
    K.exhaust_stub(mb, [R(-0.62, -2.06, -0.10), R(-0.78, -2.02, -0.12), R(-0.88, -1.92, -0.12)], r=0.026)
    mb.box(R(-0.12, -2.312), (0.30, 0.34, 0.03), 'Paint_Dark', bevel=0.01, segs=2)
    K.antenna(mb, R(0.55, -2.30), (-0.25, 0, -1), length=0.22)
    K.antenna(mb, R(-0.35, -1.17, 0.10), (-0.3, 0.15, 1), length=0.32)
    K.pitot(mb, R(2.05, -2.27, -0.10), (1, 0, 0), length=0.08)
    # prop flange / shaft
    mb.cyl(R(X_END + 0.01, PROP_Z), PROP + V(0.08, 0, 0), 0.09, 'Engine_Dark', n=24)
    return mb.finish(sharp_angle=50)


def build_decals(pod, sidepods, tail):
    obs = []
    stencil = font('STENCIL.TTF')
    bold = font('arialbd.ttf')
    # red crosses: nose top (on the right half: the stretcher door) and each side of the rear fuselage
    loc, nrm = cast_top(pod, 2.08, -0.10)        # just ahead of the windscreen base (owner's photo)
    if loc is not None:
        w, h, arm = 0.13, 0.25, 0.045
        obs.append(project_patch(poly_mesh([rect(0, 0, w, h)]), pod, loc, nrm, V(0, -1, 0), V(1, 0, 0), 'Decal_White',
                                 lift=0.0016, name='cross_nose_w', subdiv=3))
        a = arm / 2
        cr = [(-a, -h / 2), (a, -h / 2), (a, -a), (w / 2, -a), (w / 2, a), (a, a), (a, h / 2), (-a, h / 2), (-a, a),
              (-w / 2, a), (-w / 2, -a), (-a, -a)]
        obs.append(project_patch(poly_mesh([cr]), pod, loc, nrm, V(0, -1, 0), V(1, 0, 0), 'Decal_Red', lift=0.0030,
                                 name='cross_nose_r', subdiv=3))
    for sy in (1, -1):
        loc, nrm = cast_side(pod, 0.18, -1.83, sy)
        if loc is not None:
            nn = V(0, nrm.y, nrm.z).normalized()
            obs += red_cross(pod, loc, nn, V(-sy, 0, 0), V(0, 0, 1), 0.22, 'cross_%s' % ('L' if sy > 0 else 'R'))
    # "C-44 MEDEVAC" stencil under the cross
    obs += side_text(pod, 'C-44 MEDEVAC', 0.17, -2.04, 0.085, 'Decal_Black', stencil, name='medevac')
    # BellComm logo under the door: "Bell" yellow with a red border, "Comm" black (owner's photo)
    for sy in (1, -1):
        heavy = font('ariblk.ttf') or bold
        sl = sy * 0.13                      # the logo rises toward the tail, along the lower fuselage
        # (reads Bell-Comm from nose to tail on the left and from tail to nose on the right)
        xb, zb, xc, zc_ = (1.30, -2.145, 1.01, -2.11) if sy > 0 else (0.86, -2.10, 1.15, -2.135)
        obs += side_text(pod, 'Bell', xb + sy * 0.012, zb - 0.012, 0.15, 'Decal_Red', heavy, sides=(sy,), name='bell_o',
                         outline=0.010, lift=0.0016, slope=sl)
        obs += side_text(pod, 'Bell', xb, zb, 0.15, 'Decal_Yellow', heavy, sides=(sy,), name='bell', lift=0.0030,
                         slope=sl)
        obs += side_text(pod, 'Comm', xc, zc_, 0.15, 'Decal_Black', heavy, sides=(sy,), name='comm', slope=sl)
    # "PULL TO OPEN" next to the pull knob
    obs += side_text(pod, 'PULL TO OPEN', p10(1010, 920)[0] - 0.02, p10(1010, 920)[1], 0.022, 'Decal_Black', stencil, sides=(-1,),
                     name='pull')
    return obs


def build_fin_regs(tail):
    obs = []
    for sy in (1, -1):
        X = -2.52
        Z = -1.80
        p = R(X, Z, sy * (FIN_Y + 0.5))
        ok, loc, nrm, _ = tail.ray_cast(p, V(0, -sy, 0))
        if not ok:
            continue
        me = text_poly_mesh(REG, 0.11, font('arialbd.ttf'))
        obs.append(project_patch(me, tail, loc, V(0, sy, 0), V(-sy, 0, 0), V(0, 0, 1), 'Decal_Black', lift=0.0016,
                                 name='reg_' + ('L' if sy > 0 else 'R'), subdiv=0))
    return obs


def ensure_mats():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Alu_Grey', '#A9ADB0', metal=0.85, rough=0.35)
    mk('Prop_Grey', '#8F959B', metal=0.1, rough=0.45)
    mk('Prop_Yellow', '#E8C21A', rough=0.45)
    mk('Prop_Tape', '#2C7BD6', rough=0.5)
    mk('Decal_Red', '#C8161E', rough=0.5)
    mk('Decal_Yellow', '#F2C200', rough=0.5)
    mk('Canvas', '#6B6B3E', rough=0.9)
    mk('Canvas_Green', '#3F5233', rough=0.85)
    mk('Med_Red', '#B0201E', rough=0.7)


def build_c44():
    ensure_mats()
    pod = build_hull()
    canopy, cframe, cseal = split_canopy(pod)
    mast, mast_head = build_mast()
    rods = build_controls_up()
    sidepods = build_sidepods()
    tail = build_tail()
    rud = build_rudders()
    K.build_head(PIVOT, HUB, arm=-0.17, arm_w=0.12, plate_mat='Alu_Grey')
    K.build_rotor(HUB, R=4.4, chord=0.20, root=0.52, tip_mat='Paint_Dark', clamp_len=0.48)
    build_prop()
    gear = build_gear()
    cabin = build_cabin()
    camouflage([pod, mast, sidepods, tail, bpy.data.objects.get('prop')] + [r[0] for r in rud.values()])

    # ---- controls and crew: pilot in the LEFT seat
    ctrl = MB('controls_static')
    yp = SEAT_Y
    stick_base = R(1.16, FLOOR_Z, yp)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.03, -1.80, yp))
    knob, lever = controls.throttle_lever(ctrl, R(0.97, -1.875, yp + 0.255))
    feet_z = FLOOR_Z + 0.135
    pilot.build_pilot('pilot_front', PILOT_HIP, BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.45, feet_z, yp + 0.10), 'R': R(1.45, feet_z, yp - 0.10)}, knee_out=0.03,
                      elbow_out=0.04, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(FLOOR_Z))
    # instrument pod in front of the pilot (live zone) and a centre stack; open over the stretcher
    # (BellComm CAD: a gauge pod in front of the left seat and a narrow console with the display next to it;
    #  nothing over the stretcher)
    p0 = R(1.40, -1.80, yp)
    tilt = 20.0
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(0.0, 0.0, 0.30, 0.13), cw=0.05, v_leg=-0.08,
                      v_sb=-0.14, v_b=-0.25, top_arch=(0.30, 0.02, 0.10), max_u=0.24, leg_exp=0.3)
    ctrl.box(R(1.42, -1.95, -0.004), (0.16, 0.034, 0.36), 'Panel', bevel=0.01, segs=2, rot=K.rot_y(-12))
    ctrl.box(R(1.43, -1.83, -0.022), (0.11, 0.004, 0.08), 'Visor', rot=K.rot_y(-12))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)

    # patient lying flat on the stretcher, head aft by the monitor, hands on the belly, blanket over the body
    b = 82.0
    pilot.build_pilot('pilot_rear', PAT_HIP, b,
                      hands={'R': ('rest', PAT_HIP + V(0.05, -0.07, 0.15), None),
                             'L': ('rest', PAT_HIP + V(0.05, 0.07, 0.15), None)},
                      feet={'L': PAT_HIP + V(0.84, 0.09, 0.005), 'R': PAT_HIP + V(0.84, -0.09, 0.005)}, knee_out=0.0,
                      elbow_out=0.0, head_pitch_deg=78.0)
    blanket = MB('pilot_rear_blanket')
    # olive blanket over the patient from the chest to the ankles
    prof = [(-0.32, 0.135), (-0.20, 0.145), (0.0, 0.125), (0.20, 0.14), (0.40, 0.17), (0.58, 0.14), (0.74, 0.10),
            (0.82, 0.08)]
    rings = []
    for dx, top in prof:
        ring = []
        for k in range(13):
            a_ = math.pi * k / 12
            ring.append(PAT_HIP + V(dx, 0.20 * math.cos(a_), -0.105 + 0.012 + (top + 0.105) * math.sin(a_) ** 0.6))
        rings.append(ring)
    blanket.loft(rings, 'Canvas_Green', closed=False)
    blanket.box(PAT_HIP + V(-0.60, 0.0, -0.045), (0.30, 0.36, 0.08), 'Decal_White', bevel=0.035, segs=3)
    bl = blanket.finish(sharp_angle=50)
    B.join_objects('pilot_rear', [bpy.data.objects['pilot_rear'], bl])
    K.print_joints('pilot_rear', R)

    det = build_details(pod)
    decals = build_decals(pod, sidepods, tail)
    regs = build_fin_regs(tail)

    bk = math.radians(BACK)
    u = V(-math.sin(bk), 0, math.cos(bk))
    head = PILOT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cabin, canopy], ' (pilot)')
    K.clearance(['pilot_rear'], [pod, cabin, ctrl, canopy, bpy.data.objects.get('panel_face')], ' (patient)')
    K.finalize([pod, cframe, cseal, mast, mast_head, rods, sidepods, tail, gear, cabin, ctrl, det] + decals + regs,
               [canopy])
    ax = R(AXLE[0], AXLE[1])
    nodes = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder_L': rud['rudder_L'][1],
        'rudder_R': rud['rudder_R'][1], 'stick': stick_base, 'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]),
        'wheel_L': V(ax.x, MAIN_Y, ax.z), 'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    }
    K.required(nodes)

    def g(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('C44 hub %s pivot %s prop %s eye %s cg %s' % (g(HUB), g(PIVOT), g(PROP), g(eye), g(R(CG[0], CG[1]))))
    print('C44 ground y %.3f main axle %s nose axle %s stick %s' % (R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)),
                                                                  g(R(NOSE[0], NOSE[1])), g(stick_base)))
    print('C44 nose tip %s rudder TE bottom %s stab LE %.3f TE %.3f z %.3f fin y %.3f' % (
        g(R(XTIP, ZTIP)), g(R(RUD_TE_B, RUD_ZB)), R.x(STAB_LE), R.x(STAB_TE), R.z(STAB_ZT), FIN_Y))
    cx = HUB.x + (HUB_PX[0] - 2967 / 2) / PPM
    cz = HUB.z - (1294 / 2 - HUB_PX[1]) / PPM
    print('C44 overlay p10: --overlay -2.9,%.4f,%.4f,%.1f,2967,1294,1' % (cx, cz, PPM))


VIEWS = {
    'thumb': dict(extra=True, loc=(5.2, -5.6, 4.6), target=(-0.5, 0.0, 0.0), lens=38, rotor=35, prop=10),
    'ref_p10': dict(extra=True, loc=(-0.6, 30.0, 0.0), target=(-0.6, 0.0, 0.0), ortho=7.4, rotor=60, prop=10),
    'ref_front_left': dict(extra=True, loc=(6.3, 4.6, 0.15), target=(-0.2, 0.0, -0.05), lens=34, rotor=75, prop=20),
    'ref_front': dict(extra=True, loc=(10.0, 0.0, 0.0), target=(0.0, 0.0, 0.0), ortho=3.4, rotor=90, prop=0),
    'ref_top': dict(extra=True, loc=(-0.2, 0.0, 30.0), target=(-0.2, 0.0, 0.0), ortho=6.4, rotor=90, prop=0),
    'ref_rear': dict(extra=True, loc=(-7.0, -4.2, 0.6), target=(-1.0, 0.0, 0.0), lens=40, rotor=40, prop=25),
    'cabin_detail': dict(extra=True, loc=(2.3, 1.4, 0.65), target=(0.7, 0.0, -0.15), lens=30, rotor=75, prop=0),
    'stretcher': dict(extra=True, loc=(2.0, -1.6, 0.9), target=(0.9, -0.2, -0.25), lens=28, rotor=75, prop=0),
    'pilot_eye': dict(extra=True, loc=(0.0, 0.0, 0.0), target=(5.0, 0.0, -0.3), lens=22, rotor=0, prop=0),
    'tail_left': dict(extra=True, loc=(-1.6, 2.6, 0.5), target=(-2.5, 0.6, -0.1), lens=35, rotor=75, prop=10),
    'nose_lamps': dict(extra=True, loc=(3.5, 1.2, -0.2), target=(2.0, 0.0, -0.45), lens=45, rotor=75, prop=20),
}

if __name__ == '__main__':
    _orig_overlay = K.render_overlay

    def _overlay(scn, *args, **kw):
        # opaque glass for the photo overlays: the outline of the canopy is what is compared
        g = MATS.get('Glass')
        if g is not None:
            for nd in g.node_tree.nodes:
                if nd.type == 'BSDF_PRINCIPLED':
                    nd.inputs['Alpha'].default_value = 1.0
        return _orig_overlay(scn, *args, **kw)
    K.render_overlay = _overlay
    _orig_render = B.render_previews

    def _render(scn):
        eo = bpy.data.objects.get('eye_front')
        if eo is not None and 'pilot_eye' in B.PREVIEW_VIEWS:
            v = B.PREVIEW_VIEWS['pilot_eye']
            v['loc'] = tuple(eo.location)
            v['target'] = (eo.location.x + 5.0, eo.location.y, eo.location.z - 0.35)
        return _orig_render(scn)
    B.render_previews = _render
    K.run('c44', build_c44, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
