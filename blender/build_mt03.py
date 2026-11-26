"""
AutoGyro MT-03 (Hildesheim, 2004-2010) for the Autogiro web sim: open tandem pod with a drooping
pointed nose and deep-cut cockpit sides, bare forward-leaning mast with the two control push rods
behind it, uncowled Rotax 912 with a spinner-less HTC three-blader, keel that dips under the prop and
climbs to a low U-shaped tail (tailplane with two short end fins) carrying a tall central fin and a
big rudder, bow main gear with teardrop spats.

Traced on Wikimedia Commons side photos (D-MTBI, D-MAWK, D-MMFS, D-MAAU, D-MLGH) in the hub frame
(see gyrokit.py); scale from the 1.73 m propeller and the 5.08 m overall length.

  blender -b -P blender/build_mt03.py -- [--previews] [--only VIEW,...] [--overlay yaw,cx,cz,ppm,w,h]
Outputs: public/models/mt03.glb, blender/mt03.blend, blender/previews/mt03/*.png
  --floats: MTOamphib-style amphibious floats (see floatkit.py) -> ONLY public/models/mt03_floats.glb
            + blender/previews/mt03_floats/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- --floats variant (amphibious floats instead of the land gear) ----
FLOATS = '--floats' in K.ARGV
if FLOATS:
    import floatkit as FK  # noqa: E402

# ---- hub frame -------------------------------------------------------------------------------
GROUND = -2.706                    # ground under the wheels
AXLE = (-0.54, GROUND + 0.187)     # main wheel axle (400x100 tyres)
# Centre of gravity. The UK CAA data sheet BG01 allows 0.376-0.596 m ahead of the main axle and
# 0.82-0.95 m above it, i.e. almost under the hub; the sim's flight model, though, is validated with
# the hub 0.33 m BEHIND the CG (rotor thrust line through the CG with the fuselage level, as on every
# aircraft of the sim: with the data-sheet CG it tail-slides power off). So: the sim's longitudinal
# convention, the data sheet's height.
CG = (0.33, AXLE[1] + 0.885)
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.215)
PROP = R(-1.18, -1.447)
MAIN_Y = 0.83
NOSE = (1.54, GROUND + 0.175)

LIVERY = dict(body=('#0B8468', 0.25, 0.20), accent=('#C4C8CC', 0.85, 0.26), dark=('#17181B', 0.25, 0.32))
REG = 'EC-GT3'

# ---- pod: stations (X, top, shoulder z, shoulder half-width, chine z, chine half-width, bottom) ----
POD = E.Fuselage(R.table([
    (2.20, -2.090, -2.140, 0.085, -2.215, 0.078, -2.272),
    (2.05, -1.965, -2.050, 0.150, -2.220, 0.138, -2.315),
    (1.90, -1.840, -1.965, 0.205, -2.225, 0.188, -2.345),
    (1.75, -1.715, -1.885, 0.250, -2.228, 0.230, -2.370),
    (1.60, -1.632, -1.825, 0.290, -2.230, 0.265, -2.385),
    (1.40, -1.600, -1.790, 0.325, -2.230, 0.298, -2.395),
    (1.00, -1.555, -1.760, 0.375, -2.230, 0.340, -2.408),
    (0.56, -1.520, -1.570, 0.392, -2.225, 0.360, -2.402),
    (0.25, -1.400, -1.660, 0.400, -2.215, 0.362, -2.392),
    (0.00, -1.300, -1.620, 0.395, -2.200, 0.356, -2.385),
    (-0.26, -1.240, -1.585, 0.385, -2.180, 0.346, -2.370),
    (-0.50, -1.238, -1.570, 0.372, -2.150, 0.332, -2.300),
]), tip=(R.x(2.32), R.z(-2.212)), nt=2.3, nb=2.6, bow=0.010,
    # the last 12 cm keep converging at the slopes of the last station (top -0.84, bottom +0.29 per metre:
    # linear law with exponent = cap length x convergence / height = 0.74) and end in a small round tip;
    # a cap that starts parallel (cosine law) leaves a visible knob on the nose
    linear_nose=True, nose_exp=0.74)

# cockpit openings (side view, hub frame): rear cockpit, front cockpit; both end at the apex of the
# side panels that rise to the front seat back
APEX = (0.545, -1.530)
OPEN_REAR = [(-0.22, -1.262), (-0.11, -1.40), (0.06, -1.655), (0.234, -1.91), (0.32, -1.985), (0.72, -2.02),
             APEX, (APEX[0], -1.0), (-0.22, -1.0)]
OPEN_FRONT = [APEX, (1.294, -2.19), (1.40, -2.217), (1.654, -1.69), (1.654, -1.0), (APEX[0], -1.0)]
PANEL_TILT = 26.0

FRONT_HIP = R(1.02, -1.97)
REAR_HIP = R(0.22, -1.94)
FRONT_BACK, REAR_BACK = 10.0, 20.0


def build_pod():
    pod = POD.shell('pod', step=0.03, n_half=36, rear=())
    K.recess_rear(pod, POD.xrear, depth=0.09, inset=0.022)
    # front and rear windscreens need the closed envelope under them
    ws1, fr1 = E.windscreen('ws_front', pod, R.x(1.672), R.x(1.60), 0.235, 0.66, 39, nu=28, nv=12)
    # silver cheeks wrapping the open back of the pod (crescent seen from the side)
    zt, zb, xr = R.z(-1.30), R.z(-2.34), R.x(-0.50)
    cres = [(xr - 0.2, zb)] + [(xr + 0.225 * math.sin(math.pi * k / 14) ** 0.75, lerp(zb, zt, k / 14))
                               for k in range(0, 15)] + [(xr - 0.2, zt)]
    K.paint_poly(pod, cres, 'Paint_Accent')
    rim = K.cut_polys(pod, [R.pts(OPEN_REAR), R.pts(OPEN_FRONT)], rim_r=0.013, rim_mat='Seat')
    return pod, rim, ws1, fr1


def build_divider(pod):
    """Front seat back: carbon shell between the side panels, with the hoop that carries the rear
    windscreen and the passenger's grab handle."""
    mb = MB('divider')
    b = math.radians(27)
    u = V(-math.sin(b), 0, math.cos(b))
    f = V(math.cos(b), 0, math.sin(b))
    foot = R(0.84, -2.20)
    top = foot + u * 0.80
    # shell (slightly dished), following the pod width
    rings = []
    for k in range(9):
        t = k / 8
        c = foot + u * (0.80 * t)
        # narrow waist (the passenger's knees pass either side), wide shoulders up to the side panels
        hw = 0.15 + 0.18 * max(0.0, min(1.0, (t - 0.62) / 0.30)) ** 1.5
        ring = []
        for j in range(15):
            a = math.pi * j / 14
            y = math.cos(a) * hw
            bulge = -0.05 * math.sin(a)
            ring.append(c + V(0, y, 0) + f * bulge)
        for j in range(14, -1, -1):
            a = math.pi * j / 14
            ring.append(c + V(0, math.cos(a) * hw, 0) + f * (-0.05 * math.sin(a) - 0.022))
        rings.append(ring)
    mb.loft(rings, 'Carbon', closed=True, cap0=True, cap1=True)
    # hoop tube round the top
    hoop = [top + V(0, math.cos(math.pi * j / 12) * 0.33, 0) + f * (-0.05 * math.sin(math.pi * j / 12) - 0.011)
            for j in range(13)]
    mb.tube(hoop, 0.011, 'Paint_Dark', n=8)
    return mb.finish(sharp_angle=50), top, u, f


def build_mast():
    """Flat stainless mast leaning forward, cheek plates on the pitch pivot, the two control push rods
    behind it with their bellcranks on the pod, pre-rotator drive (horizontal shaft over the engine with
    the pneumatic clutch, slim vertical shaft up to the Bendix)."""
    mb = MB('mast')
    foot = R(-0.33, -2.33)                      # on the keel, inside the pod
    base = R(-0.235, -1.225)                    # where it leaves the rear shell
    top = PIVOT + V(-0.012, 0, -0.03)
    mb.tube([foot, base, top], 0.05, 'Metal_Frame', n=28, square=(0.058, 0.115, 8))
    for sy in (1, -1):
        mb.box(PIVOT + V(-0.012, sy * 0.045, -0.02), (0.13, 0.010, 0.15), 'Metal_Frame', bevel=0.012, segs=2,
               rot=K.rot_y(-14))
        mb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.062, 0), 0.016, 'Engine', n=12)
    # cross brace + pneumatic trim/brake cylinder between mast and head
    cb = R(-0.085, -0.50)
    mb.box(cb + V(-0.06, 0, 0), (0.17, 0.26, 0.022), 'Metal_Frame', bevel=0.005, segs=1)
    mb.cyl(cb + V(-0.10, 0.0, 0.01), R(-0.12, -0.275), 0.017, 'Alu_Black', n=12)
    mb.cyl(R(-0.12, -0.275), R(-0.125, -0.20), 0.008, 'Chrome', n=8)
    # push rods (left and right), rod ends at both ends
    for sy in (1, -1):
        lo = R(-0.335, -1.20, sy * 0.125)
        hi = PIVOT + V(-0.24, sy * 0.12, 0.022)
        mb.cyl(lo, hi, 0.0075, 'Metal_Frame', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.03), 0.011, 'Alu_Black', n=8)
        # bellcrank bracket on the pod top
        mb.box(lo + V(0.015, 0, -0.03), (0.09, 0.012, 0.07), 'Metal_Frame', bevel=0.004, segs=1)
        mb.cyl(lo + V(0, -0.012 * sy, -0.02), lo + V(0, 0.012 * sy, -0.02), 0.012, 'Alu_Black', n=10)
    # pre-rotator: horizontal tube over the engine, clutch bell, slim vertical shaft behind the mast
    z = R.z(-1.272)
    mb.cyl(V(R.x(-0.40), 0, z), V(R.x(-1.03), 0, z), 0.014, 'Metal_Frame', n=12)
    mb.lathe([(0.0, 0.0), (0.030, 0.0), (0.046, 0.03), (0.046, 0.075), (0.036, 0.085), (0.0, 0.085)],
             V(R.x(-1.03), 0, z), V(-1, 0, 0), 'Engine', n=20)
    mb.box(V(R.x(-1.075), 0, z - 0.06), (0.05, 0.05, 0.13), 'Engine_Dark', bevel=0.01, segs=2)
    mb.cyl(V(R.x(-0.42), 0, z), PIVOT + V(-0.137, 0, -0.07), 0.009, 'Metal_Frame', n=10)
    return mb.finish(sharp_angle=40, wn=True)


def build_frame():
    """Keel (rectangular aluminium tube): under the pod, down to the bend below the prop, up to the tail;
    upper strut from the engine mount to the bend; engine mount frame; radiator under the engine."""
    mb = MB('frame')
    sec = (0.052, 0.085, 6)
    k0, k1 = R(1.30, -2.345), R(-0.50, -2.372)
    bend, end = R(-1.15, -2.470), R(-2.30, -2.118)
    mb.tube([k0, k1, bend], 0.04, 'Metal_Frame', n=20, square=sec)
    mb.tube([bend, end], 0.04, 'Metal_Frame', n=20, square=sec)
    mb.box(bend, (0.16, 0.058, 0.12), 'Metal_Frame', bevel=0.012, segs=2, rot=K.rot_y(-4))   # welded gusset
    for sy in (1, -1):
        mb.cyl(bend + V(0.03, sy * 0.03, 0.0), bend + V(0.03, sy * 0.036, 0.0), 0.012, 'Alu_Black', n=8)
    # upper strut (engine mount foot -> bend)
    mb.tube([R(-0.50, -2.165), R(-1.12, -2.445)], 0.03, 'Metal_Frame', n=16, square=(0.045, 0.07, 6))
    # engine mount: vertical frame behind the pod + four arms to the crankcase
    for sy in (1, -1):
        mb.tube([R(-0.47, -2.36, sy * 0.13), R(-0.46, -1.80, sy * 0.15), R(-0.45, -1.32, sy * 0.10)], 0.014,
                'Metal_Frame', n=10)
        for z in (-1.38, -1.66):
            mb.cyl(R(-0.455, z, sy * 0.12), R(-0.60, z + 0.02, sy * 0.10), 0.012, 'Metal_Frame', n=10)
    mb.tube([R(-0.47, -2.36, 0.13), R(-0.47, -2.36, -0.13)], 0.014, 'Metal_Frame', n=10)
    # radiator lying under the engine, coolant hoses
    rc = R(-0.80, -2.14)
    mb.box(rc, (0.30, 0.36, 0.045), 'Radiator', bevel=0.006, segs=1, rot=K.rot_y(-6))
    for k in range(13):
        mb.box(rc + V(0, -0.165 + k * 0.0275, -0.024), (0.28, 0.004, 0.006), 'Engine', rot=K.rot_y(-6))
    for sy in (1, -1):
        mb.tube(catmull([rc + V(0.12, sy * 0.15, 0.02), rc + V(0.10, sy * 0.17, 0.20), R(-0.72, -1.62, sy * 0.20)], 5),
                0.014, 'Rubber', n=8)
    # battery box (red) and oil tank on the mount
    mb.box(R(-0.60, -2.02, -0.10), (0.11, 0.16, 0.13), 'Lens_Red', bevel=0.012, segs=2)
    mb.cyl(R(-0.57, -1.95, 0.14), R(-0.57, -1.70, 0.14), 0.055, 'Alu_Black', n=18)
    mb.cyl(R(-0.57, -1.70, 0.14), R(-0.57, -1.68, 0.14), 0.03, 'Metal_Frame', n=12)
    return mb.finish(sharp_angle=40, wn=True)


# ---- tail (hub frame numbers) ----
STAB_Z = -2.118
HINGE = -2.19
FIN_TOP = -1.222


def fin_le(z):
    Z = z - R.dz
    t = (Z - STAB_Z) / (FIN_TOP - STAB_Z)
    x = lerp(-1.80, -1.90, t)
    x -= 0.07 * max(0.0, (t - 0.93) / 0.07) ** 2      # rounded top-front corner
    return R.x(x)


def rud_te(z):
    Z = z - R.dz
    if Z < -1.875:
        x = lerp(-2.215, -2.77, (Z + 2.145) / 0.27)
    else:
        x = lerp(-2.77, -2.47, (Z + 1.875) / (FIN_TOP + 1.875))
    t = (Z - STAB_Z) / (FIN_TOP - STAB_Z)
    x += 0.07 * max(0.0, (t - 0.93) / 0.07) ** 2      # rounded top-rear corner
    return R.x(x)


def build_tail():
    """Tailplane bolted on top of the keel, its tips turned up into two short end fins (one moulded U),
    tall central fin; white bumper fairing under the keel."""
    mb = MB('tail')
    loop = airfoil_ring(14, 0.075, te_min=0.002)
    span = 0.83
    rings = []
    ys = [-span, -0.79, -0.7, -0.5, -0.3, -0.12, 0.0, 0.12, 0.3, 0.5, 0.7, 0.79, span]
    for y in ys:
        uu = abs(y) / span
        le = lerp(-1.80, -1.94, uu ** 1.2)
        te = lerp(-2.33, -2.30, uu)
        ch = le - te
        # the tips curl up into the end fins
        zc = STAB_Z + 0.035 * max(0.0, (uu - 0.9) / 0.1) ** 2
        rings.append([R(le - s * ch, zc + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    h = 0.60
    zs = [STAB_Z - 0.02 + h * t for t in (0.0, 0.04, 0.12, 0.3, 0.5, 0.7, 0.85, 0.93, 0.975, 1.0)]
    for sy in (1, -1):
        def le(z, sy=sy):
            t = (z - R.dz - (STAB_Z - 0.02)) / h
            return R.x(lerp(-1.935, -1.975, t) - 0.06 * max(0.0, (t - 0.9) / 0.1) ** 2)

        def te(z, sy=sy):
            t = (z - R.dz - (STAB_Z - 0.02)) / h
            return R.x(lerp(-2.305, -2.215, t) + 0.05 * max(0.0, (t - 0.9) / 0.1) ** 2)
        E.fin_loft(mb, [R.z(z) for z in zs], le, te,
                   y_fn=lambda z, sy=sy: sy * (span + 0.035 * (z - R.dz - STAB_Z) / h), t=0.085)
    zs = [STAB_Z - 0.03, STAB_Z + 0.06, -1.95, -1.75, -1.55, -1.40, -1.30, -1.255, -1.232, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, rud_te, t=0.105,
               s_end_fn=lambda z: (fin_le(z) - R.x(HINGE)) / (fin_le(z) - rud_te(z)))
    # keel end cap, stab saddle, bumper fairing with its little wheel
    mb.box(R(-2.06, STAB_Z - 0.035), (0.50, 0.10, 0.02), 'Metal_Frame', bevel=0.004, segs=1, rot=K.rot_y(-17))
    c = R(-1.74, -2.185)
    prof = [(0.0, -0.13)] + [(0.034 * math.sin(math.pi * k / 10) ** 0.6, lerp(-0.13, 0.12, k / 10)) for k in range(1, 10)] \
        + [(0.0, 0.12)]
    mb.lathe(prof, c, V(1, 0, 0.33).normalized(), 'Decal_White', n=16)
    return mb.finish(sharp_angle=45)


def build_rudder():
    zs = [STAB_Z + 0.005, -2.06, -1.95, -1.875, -1.72, -1.55, -1.40, -1.30, -1.255, -1.232, FIN_TOP - 0.004]
    origin = R(HINGE, -1.68)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], fin_le, rud_te, R.x(HINGE), origin, t=0.105,
                                 mat='Paint_Accent')
    # ground-adjustable trim tab (bare aluminium) on the trailing edge
    tab = MB('trimtab')
    tab.box(R(-2.728, -1.675), (0.10, 0.004, 0.15), 'Metal_Frame', bevel=0.0, rot=Euler((0, math.radians(24.7), 0)))
    tab_ob = tab.finish(sharp_angle=60)
    regs = E.build_registration(rud, REG, cx=R.x(-2.375) - origin.x, cz=R.z(-1.42) - origin.z, size=0.082,
                                mat='Paint_Dark')
    for r in regs + [tab_ob]:
        r.location = r.location + (origin if r is not tab_ob else Vector((0, 0, 0)))
    B.join_objects('rudder', [rud, tab_ob] + regs)
    return rud


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    root = R(AXLE[0] + 0.02, -2.41)
    for sy in (1, -1):
        K.leg_blade(mb, [root + V(0, sy * 0.02, 0), root + V(0, sy * 0.26, -0.018), root + V(-0.01, sy * 0.52, -0.055),
                         V(ax.x, sy * (MAIN_Y - 0.09), ax.z + 0.012)], chord=0.125, thick=0.034, mat='Paint_White')
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.11), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.075), ax.z), V(ax.x, sy * (MAIN_Y - 0.066), ax.z), 0.085, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.07, sy * (MAIN_Y - 0.07), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008, segs=1)
    mb.box(root, (0.14, 0.12, 0.04), 'Metal_Frame', bevel=0.008, segs=2)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        spats.append(K.spat(name, c, R=0.187, front=0.33, back=0.30, hw=0.10, top=0.055, lift=0.065,
                            mat='Paint_Accent', tail_up=0.075))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=0.187, w=0.105)
    nose = K.nose_gear(R(NOSE[0], NOSE[1]), R=0.175, w=0.10, leg_top=R.z(-2.30), rake=0.012)
    return gear, spats, nose


def build_cockpit(pod):
    mb = MB('cockpit')
    E.bucket_seat(mb, FRONT_HIP, 24, width=0.42, headrest=False, base=True)
    E.bucket_seat(mb, REAR_HIP, 24, width=0.42, headrest=False, base=True)
    # floor boards and the fuel tank under the rear seat (filler cap on the left)
    mb.box(R(0.95, -2.345), (1.30, 0.42, 0.012), 'Interior', bevel=0.0)
    mb.box(R(0.16, -2.22), (0.46, 0.50, 0.20), 'Interior', bevel=0.04, segs=3)
    # passenger foot rests either side of the front seat
    for sy in (1, -1):
        mb.box(R(0.80, -2.30, sy * 0.265), (0.20, 0.10, 0.012), 'Metal_Frame', bevel=0.003, segs=1, rot=K.rot_y(-15))
    return mb.finish(sharp_angle=40, wn=True)


def hull_hit(ob, p, n):
    """Point and outward normal of `ob` hit by a ray coming from outside along -n through p."""
    n = Vector(n).normalized()
    inv = ob.matrix_world.inverted()
    ok, loc, nn, _i = ob.ray_cast(inv @ (Vector(p) + n * 0.6), inv.to_3x3() @ (-n), distance=1.2)
    if not ok:
        raise RuntimeError('lamp ray missed the hull at %s' % (tuple(p),))
    return ob.matrix_world @ loc, (ob.matrix_world.to_3x3() @ nn).normalized()


def build_lights(det, pod):
    """Optional lights as fitted on the photographed MT-03s (POH MTOsport 9-2.7: 'combined units at the
    left hand and right hand side of the fuselage, behind the passenger station'; 'a pair of lamps
    installed in the nose'):
    - nav + strobe: one slim capsule on each pod flank, just ahead of the silver cheek, at the height of
      the rear seat back; clear strobe body with the coloured nav lens at its front end (D-MAWK left
      red, D-MNTV right green);
    - landing: two small round lamps side by side in the nose tip (D-MAWK).
    No beacon and no tail light on any photographed MT-03."""
    for sy in (1, -1):
        c, n = hull_hit(pod, R(-0.16, -1.66, sy * 0.40), V(0, sy, 0))
        n = V(0, n.y, n.z).normalized()
        K.oval_lamp(det, pod, c + V(-0.016, 0, 0), n, V(1, 0, 0), kind='white', a=0.034, b=0.0115)
        K.oval_lamp(det, pod, c + V(0.034, 0, 0), n, V(1, 0, 0), kind='red' if sy > 0 else 'green',
                    a=0.017, b=0.0115)
        K.lamp_node('navL' if sy > 0 else 'navR', c + V(0.036, 0, 0) + n * 0.025)
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', c + V(-0.022, 0, 0) + n * 0.025)
    for sy, tag in ((1, 'L'), (-1, 'R')):
        c, n = hull_hit(pod, R(2.20, -2.212, sy * 0.040), V(1, 0, 0))
        d = V(1, sy * 0.22, -0.04).normalized()
        K.lamp(det, c - d * 0.006, d, kind='white', r=0.017, length=0.011, base='Chrome')
        K.lamp_node('landing', c + d * 0.03, tag)


def build_mt03():
    pod, rim, ws1, fr1 = build_pod()
    div, dtop, du, df = build_divider(pod)
    # rear windscreen on the hoop of the front seat back
    ws2, fr2 = E.windscreen('ws_rear', pod, dtop.x + 0.043, dtop.x + 0.062, 0.235, 0.48, 27, nu=24, nv=10,
                            base_z=dtop.z + 0.02)
    mast = build_mast()
    frame = build_frame()
    K.build_head(PIVOT, HUB, arm=-0.24, arm_w=0.24)
    K.build_rotor(HUB, R=4.2, chord=0.20, root=0.50, tip_mat='Decal_White', clamp_len=0.50)
    engine = K.rotax(PROP)
    K.build_prop(PROP, R=0.865, blades=3, hub='drum', hub_r=0.066, hub_len=0.15, tip_mat='Carbon')
    tail = build_tail()
    build_rudder()
    if FLOATS:          # --floats: no land gear; floats, struts, amph wheels and water rudders instead
        gear, spats, nose = None, [], None
        kit = FK.mt03_kit(R, R.x(2.32))
    else:
        gear, spats, nose = build_gear()
        kit = None
    cockpit = build_cockpit(pod)

    ctrl = MB('controls_static')
    stick_base = R(1.29, -2.335)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.345, -1.74))
    knob, lever = controls.throttle_lever(ctrl, R(1.09, -2.05, 0.30))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.70, -2.22, 0.13), 'R': R(1.70, -2.22, -0.13)}, knee_out=0.03, elbow_out=0.06,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.345))
    p0 = R(1.585, -1.835)
    PANEL.build_panel(ctrl, p0, PANEL_TILT, [pod, ws1], zone=(0.0, 0.04, 0.38, 0.14), cw=0.058, v_leg=-0.04,
                      v_sb=-0.34, v_b=-0.40, top_arch=(0.262, 0.03, 0.155), max_u=0.245, leg_exp=0.25)
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.22, -0.15, 0.15), None),
                             'L': ('rest', REAR_HIP + V(0.22, 0.15, 0.15), None)},
                      feet={'L': R(0.79, -2.24, 0.24), 'R': R(0.79, -2.24, -0.24)}, knee_out=0.09, elbow_out=0.03)
    K.print_joints('pilot_rear', R)

    det = MB('details')
    K.pitot(det, R(2.30, -2.215), (1, 0, -0.1), length=0.10)
    build_lights(det, pod)
    K.antenna(det, R(-1.55, -2.31), (-0.25, 0, -1), length=0.30)
    # fuel filler on the left cheek, static port, towing eye under the nose
    det.cyl(R(-0.02, -1.80, 0.398), R(-0.02, -1.80, 0.412), 0.032, 'Alu_Black', n=16)
    det = det.finish(sharp_angle=50)

    make = K.make_eye
    S = FRONT_HIP + V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK))) * pilot.SPINE
    u = V(-math.sin(math.radians(FRONT_BACK)), 0, math.cos(math.radians(FRONT_BACK)))
    head = S + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    make(eye)
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [bpy.data.objects.get('panel_face'), ctrl, pod], ' (front)')
    K.clearance(['pilot_rear'], [pod, div, cockpit], ' (rear)')
    K.finalize([pod, rim, fr1, fr2, div, mast, frame, engine, tail, gear, cockpit, ctrl, det] + spats
               + (kit.static if kit else []), [ws1, ws2])
    ax = R(AXLE[0], AXLE[1])
    nodes = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.68), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    }
    if kit:             # --floats: amph wheels and water rudders replace the land wheels
        for k in ('nose_wheel', 'wheel_L', 'wheel_R'):
            nodes.pop(k)
        nodes.update(kit.nodes)
        kit.report()
    K.required(nodes)
    print('MT03 hub %s pivot %s prop %s ground z %.3f axle x %.3f nose x %.3f eye %s' % (
        tuple(round(c, 3) for c in HUB), tuple(round(c, 3) for c in PIVOT), tuple(round(c, 3) for c in PROP),
        R.z(GROUND), ax.x, R.x(NOSE[0]), tuple(round(c, 3) for c in eye)))


VIEWS = {
    # lamp close-ups: left flank as on D-MAWK (side_L_08), right flank as on D-MNTV (02), nose lamps
    'lamp_left': dict(extra=True, loc=(1.2, 2.4, 0.45), target=(-0.40, 0.30, 0.05), lens=55, rotor=75, prop=20),
    'lamp_right': dict(extra=True, loc=(0.6, -2.4, 0.40), target=(-0.40, -0.30, 0.05), lens=55, rotor=75, prop=20),
    'nose_lamps': dict(extra=True, loc=(2.85, 0.55, -0.36), target=(2.02, 0.0, -0.49), lens=50, rotor=75, prop=20),
}

if __name__ == '__main__':
    if FLOATS:          # --floats: writes only mt03_floats.glb + previews/mt03_floats
        FK.run('mt03', build_mt03, LIVERY, VIEWS, FK.mt03_ground(R.x(2.32)))
    else:
        K.run('mt03', build_mt03, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
