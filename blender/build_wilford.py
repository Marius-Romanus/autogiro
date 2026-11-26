"""
Wilford XOZ-1 gyroplane on twin Edo floats (Pennsylvania Aircraft Syndicate, Philadelphia; US Navy
BuNo 8602, naval trials 1936-37) for the Autogiro web sim: the first hydro-autogyro of the sim.

Layout of the real aircraft (Aero Digest Feb 1935 p.90 and Mar 1937 p.84, the photos and the 3-view):
  - welded chrome-moly tube fuselage, fabric covered, deep and round-topped (Fleet trainer lineage),
    two open cockpits in tandem with small windscreens; the pilot flies from the REAR seat (float
    photo), the passenger sits in front under the rotor;
  - Kinner R-5 five-cylinder radial (155 hp at 1975 rpm) with exposed cylinders, direct-drive metal
    two-blade propeller ("Standard equipment: metal propeller", Aero Digest 1937);
  - four-strut steel pylon over the FRONT cockpit carrying a four-blade feathering rotor (Rieseler-
    Wilford system: blades restrained in flap and lag, opposite blades rigidly linked, the stick
    changes the blade pitch cyclically and also moves ailerons and elevators): 32 ft (9.75 m) rotor,
    68.3 ft2 of blade -> 0.34 m chord;
  - low wing 27 ft 4 in x 55 in (8.33 x 1.40 m) with ailerons, braced by two struts each side to the
    upper longerons; steel-tube tail, fin + big rudder, tapered tailplane + elevators, wire braced to
    the bottom longerons;
  - twin Edo floats instead of the wheels: flat deck, chined V bottom, step a little behind the CG,
    upturned bow, stern rising to the deck; N struts + diagonal each side, spreader bars with cross
    wires, a water rudder on each stern (moves with the pedals).
  - Livery: aluminium dope, chrome-yellow wing upper surfaces (US Navy practice; dark on the
    orthochromatic float photo), "U.S. NAVY" on the rear fuselage, "8602" on the fin, "XOZ-1" on the
    rudder (Wilford_XOZ1.jpg).

Traced in the HUB FRAME of gyrokit.py on the Aero Digest general arrangement (p90.jpg, 56.3 px/m
from the published 6.50 m length; checked against the 8.33 m span, 1.71 m tread, 0.65 m 7.50x10
tyres and the 3.05 m height). Both photos are perspective views, so a pinhole camera is SOLVED from
model points <-> photo pixels (solve_camera: position, yaw, pitch, roll, focal; --solve):
  - float photo (Commons Wilford_Gyroplane_XOZ-1_floatplane.jpg, 662 px): hub, prop hub, three
    cylinder heads, wing-strut feet, near stabiliser tip, rudder TE, near wing TE corner and root, and
    the far-shore waterline as eye level; focal held at 700 px -> camera 11.4 m off, 8 deg ahead of the
    side view, ~2.3 m above the water; residuals 4-11 px. Floats (Edo 2000 class, 5.28 m), N struts
    and deck height fitted on it; the sterns are hidden in the wake.
  - landplane photo (Wilford_XOZ1.jpg, 901 px; --landplane drops the floats): hub, rudder corners,
    fin lettering, pylon feet, top cylinder, near wheel, tail wheel, near wing tip; the model pitch
    (3-point attitude, 12-16 deg) is solved too. It moved the fin top 5 cm down.
Outlines judged with the kit's 4x edge recipe on the nose, pylon, floats and tail.
CG: no data -> sim convention, hub 0.33 m behind the CG, 0.15 m below the thrust line (constants).

  blender -b -P blender/build_wilford.py -- [--previews] [--only VIEW,...] [--show-rear] [--samples N]
          [--no-export] [--solve float|land --solve-out out.png [--fixf 700] [--rotaz deg] [--landplane]]
          [--povl out.png,lx,ly,lz,tx,ty,tz,f_px,w,h[,,pitch]]
  float overlay:     -- --no-export --solve float --fixf 700 --rotaz 50 --solve-out float.png
  landplane overlay: -- --landplane --solve land --rotaz 30 --solve-out land.png   (writes nothing)
Outputs: public/models/wilford.glb, blender/wilford.blend, blender/previews/wilford/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, naca4, pilot, controls  # noqa: E402
from build_autogiro import hermite, sgnpow, closed_tube  # noqa: E402
import build_cierva as C  # noqa: E402  (windscreen(), build_wood_prop(), lens_fin(): reused, not edited)

# ---- hub frame (X forward, Z up, origin on the rotor hub; metres) --------------------------------
PPM_3V = 56.3                   # px/m of the general arrangement (p90.jpg crop at 1560,440)
THRUST_Z = -1.43                # thrust line (prop hub) below the hub
PROP_X = 1.776                  # prop hub ahead of the hub
PROP_R = 1.25                   # metal two-blader, ~8 ft 2 in (3-view 2.4-2.6 m)
ENGINE_X = 1.47                 # Kinner R-5 cylinder plane
# centre of gravity (no published data): sim convention in X (hub 0.33 m behind the CG), height
# 0.15 m below the thrust line (1930s tractor fuselage). Change and rebuild if the FDM wants it.
CG_AHEAD_OF_HUB = 0.33
CG_BELOW_THRUST = 0.15
CG = (CG_AHEAD_OF_HUB, THRUST_Z - CG_BELOW_THRUST)
R = K.Ref(CG)

HUB = R(0.0, 0.0)
PIVOT = R(0.0, -0.26)           # rotor head pivot (top of the pylon)
PROP = R(PROP_X, THRUST_Z)
ROTOR_R, BLADE_CHORD, BLADE_ROOT = 4.875, 0.34, 0.55

# wing (published 27 ft 4 in x 55 in; side view: root LE 0.64, TE -0.76)
W_LE, W_CHORD = 0.64, 1.40
W_SPAN2 = 4.165
W_DIH = math.radians(5.0)       # front view of the 3-view: 5-6 deg on the outer panels
W_INC = math.radians(2.0)
W_ZC = -1.865                   # chord line at the root (lower surface flush with the fuselage bottom)
W_Y0 = 0.20                     # root section inside the fuselage
W_Y1 = 0.40                     # dihedral break at the fuselage side
AIL = (1.87, 3.83)              # aileron span (top view: 0.45-0.92 of the semi-span), chord 0.31 m
AIL_S = 0.78
STRUT_Y = 2.08                  # wing strut attachment (front view)
JURY_Y = 1.27

# cockpits (hub frame X): front = passenger under the pylon, rear = pilot
CK_F = (0.50, -0.20, 0.27)
CK_R = (-0.34, -1.08, 0.28)
FLOOR_Z = -1.84
PILOT_HIP = (-0.74, -1.62)
PILOT_BACK = 12.0
PASS_HIP = (0.12, -1.66)
PASS_BACK = 8.0

# tail
HINGE_X = -3.98
TP_Z = -1.13
TP_LE_ROOT, TP_LE_TIP, TP_HALF = -3.16, -3.91, 1.31
ELEV_HINGE, ELEV_TE, ELEV_Y0 = -3.96, -4.35, 0.22

# floats (Edo type; length / position fitted on the float photo)
FLOAT_Y = 1.08                  # centre-line either side
FLOAT_L = 5.28                  # Edo 2000 (17 ft 4 in) for a 1985 lb gross weight
FLOAT_BOW = 2.62                # bow tip X
FLOAT_B = 0.33                  # half beam at the chine
FLOAT_DECK = -2.87              # deck Z (float-photo overlay: struts 0.95 m below the fuselage)
FLOAT_DEPTH = 0.56              # deck -> keel at the step
STEP_X = -0.05                  # step 0.38 m behind the CG (12 deg from the CG vertical)
STEP_H = 0.055
DEADRISE = 22.0
FRONT_STRUT_X, REAR_STRUT_X = 1.31, -0.36

LIVERY = dict(body=('#C6CACC', 0.30, 0.42), accent=('#E8A800', 0.0, 0.40), dark=('#111213', 0.1, 0.5),
              seat=('#4A2E1C', 0.0, 0.6))
LAND = '--landplane' in K.ARGV


def H(X, Z, y=0.0):
    return R(X, Z, y)


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
def build_extra_materials():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Wing_Yellow', '#E8A800', rough=0.42)             # chrome yellow (US Navy, upper wing surfaces)
    mk('Float_Alu', '#B9BEC1', metal=0.85, rough=0.36)   # bare aluminium Edo floats
    mk('Strut_Alu', '#BFC3C5', metal=0.6, rough=0.35)
    mk('Exhaust', '#3A3431', metal=0.55, rough=0.55)
    mk('Prop_Metal', '#C4C8CB', metal=1.0, rough=0.22)
    mk('Wire', '#7E8286', metal=1.0, rough=0.35)
    mk('Grip_Leather', '#3B2618', rough=0.6)
    C.set_paint('Rotor_Blade', '#B8BCBE', 0.25, 0.45)    # doped fabric / aluminium-painted blades
    C.set_paint('Interior', '#5A5246', 0.0, 0.8)
    C.set_paint('Panel', '#2A1C12', 0.0, 0.5)            # varnished wooden board
    # 1930s crew: leather coats, darker trousers, leather gloves and helmets (as the C.30A)
    C.set_paint('Pilot_Suit', '#5A3B26', 0.0, 0.62)
    C.set_paint('Suit_Dark', '#2A2420', 0.0, 0.8)
    C.set_paint('Glove', '#3A2618', 0.0, 0.55)
    C.set_paint('Harness', '#6B5A44', 0.0, 0.8)


# ---------------------------------------------------------------------------
# Fuselage: stations (X, top, bottom, half-width, z widest, e_top, e_bottom, e_side), hub frame.
# Section: superellipse, rounder decking on top, flatter sides; nose bowl closing on the crankcase.
# ---------------------------------------------------------------------------
BODY_TABLE = [
    (1.392, -1.215, -1.645, 0.215, -1.43, 2.0, 2.0, 2.0),
    (1.375, -1.155, -1.705, 0.275, -1.43, 2.0, 2.0, 2.0),
    (1.345, -1.110, -1.750, 0.320, -1.43, 2.0, 2.05, 2.05),
    (1.300, -1.075, -1.795, 0.355, -1.435, 2.05, 2.15, 2.15),
    (1.230, -1.050, -1.830, 0.380, -1.44, 2.1, 2.3, 2.3),
    (1.100, -1.030, -1.870, 0.398, -1.45, 2.2, 2.5, 2.6),
    (0.900, -1.005, -1.900, 0.405, -1.455, 2.2, 2.6, 2.7),
    (0.600, -0.968, -1.930, 0.410, -1.46, 2.2, 2.6, 2.8),
    (0.200, -0.952, -1.940, 0.410, -1.46, 2.2, 2.6, 2.8),
    (-0.400, -0.946, -1.940, 0.410, -1.46, 2.2, 2.6, 2.8),
    (-1.000, -0.946, -1.920, 0.400, -1.46, 2.2, 2.6, 2.8),
    (-1.440, -0.950, -1.875, 0.370, -1.45, 2.2, 2.5, 2.7),
    (-2.330, -1.020, -1.776, 0.280, -1.42, 2.1, 2.4, 2.5),
    (-3.210, -1.137, -1.670, 0.170, -1.40, 2.0, 2.3, 2.4),
    (-3.620, -1.160, -1.610, 0.105, -1.38, 2.0, 2.2, 2.3),
    (-3.950, -1.178, -1.540, 0.035, -1.36, 2.0, 2.2, 2.2),
]


class Hull:
    """Round-topped fabric fuselage (stations in the hub frame, evaluated in model coordinates)."""

    def __init__(self, table):
        cols = list(zip(*table))
        self.xs = [R.x(x) for x in cols[0]]
        f = lambda i, dz: hermite(self.xs, [v + dz for v in cols[i]])
        self.zt, self.zb = f(1, R.dz), f(2, R.dz)
        self.hw, self.zw = f(3, 0.0), f(4, R.dz)
        self.et, self.eb, self.es = f(5, 0.0), f(6, 0.0), f(7, 0.0)

    def ring(self, x, n=72, scale=1.0):
        zt, zb, hw, zw = self.zt(x), self.zb(x), self.hw(x), self.zw(x)
        et, eb, es = self.et(x), self.eb(x), self.es(x)
        out = []
        for k in range(n):
            a = TAU * k / n
            c, s = math.cos(a), math.sin(a)
            e = et if c >= 0 else eb
            h = (zt - zw) if c >= 0 else (zw - zb)
            out.append(V(x, hw * sgnpow(s, 2 / es) * scale, zw + h * sgnpow(c, 2 / e) * scale))
        return out

    def top_z(self, x, y):
        zt, hw, zw, es, et = self.zt(x), self.hw(x), self.zw(x), self.es(x), self.et(x)
        t = min(1.0, abs(y) / hw)
        return zw + (zt - zw) * max(0.0, 1 - t ** es) ** (1 / et)

    def half_width(self, x, z):
        zt, zb, hw, zw = self.zt(x), self.zb(x), self.hw(x), self.zw(x)
        up = z >= zw
        h = (zt - zw) if up else (zw - zb)
        e = self.et(x) if up else self.eb(x)
        t = min(1.0, abs(z - zw) / max(h, 1e-6))
        return hw * max(0.0, 1 - t ** e) ** (1 / self.es(x))


BODY = Hull(BODY_TABLE)


def in_opening(x, y, ck, r=0.10):
    xf, xr, hw = R.x(ck[0]), R.x(ck[1]), ck[2]
    if not (xr <= x <= xf):
        return False
    dx = max(0.0, max(xr + r - x, x - (xf - r)))
    dy = max(0.0, abs(y) - (hw - r))
    return dx * dx + dy * dy <= r * r


def build_fuselage():
    mb = MB('fuselage')
    xs, x = [], R.x(BODY_TABLE[0][0])
    while x > R.x(BODY_TABLE[-1][0]) + 1e-6:
        xs.append(x)
        x -= 0.02 if x > R.x(1.20) else (0.05 if x > R.x(0.70) else 0.07)
    xs.append(R.x(BODY_TABLE[-1][0]))
    rings = [BODY.ring(x) for x in xs]
    rings.append(BODY.ring(R.x(-3.975), scale=0.55))
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    kill = []
    for f in mb.bm.faces:
        c = f.calc_center_median()
        if c.z > R.z(-1.25) and (in_opening(c.x, c.y, CK_F) or in_opening(c.x, c.y, CK_R)):
            kill.append(f)
    bmesh.ops.delete(mb.bm, geom=kill, context='FACES')
    ob = mb.finish(sharp_angle=60)
    E.thicken_shell(ob, 1, thickness=0.012)
    rim = E.opening_rim(ob, 'coaming', r=0.022, mat='Seat', inset=0.004)
    return ob, rim


# ---------------------------------------------------------------------------
# Kinner R-5: five-cylinder air-cooled radial, direct drive (one cylinder on top)
# ---------------------------------------------------------------------------
def build_kinner(c, crank_r=0.19, cyl_len=0.31, bore=0.133, head_r=0.565):
    mb = MB('engine')
    ax = V(1, 0, 0)
    # crankcase drum + long nose case up to the prop flange
    mb.lathe([(0.0, -0.12), (0.15, -0.12), (0.185, -0.095), (crank_r, -0.07), (crank_r, 0.06), (0.17, 0.10),
              (0.125, 0.14), (0.105, 0.20), (0.095, 0.26), (0.08, 0.29), (0.0, 0.29)], c, ax, 'Engine', n=40)
    mb.lathe([(0.0, -0.26), (0.13, -0.26), (0.165, -0.22), (0.17, -0.12), (0.0, -0.12)], c, ax, 'Engine_Dark', n=36)
    for k in range(5):
        a = TAU * k / 5
        d = V(0, math.sin(a), math.cos(a))            # k=0 up, k=1 upper left (+Y)
        side = V(0, math.cos(a), -math.sin(a))
        base = c + d * (crank_r - 0.01)
        prof = B.finned_profile(bore * 0.52, bore * 0.52 + 0.024, 0.0, cyl_len * 0.60, pitch=0.013)
        mb.lathe(prof, base, d, 'Engine_Dark', n=18)
        h0 = base + d * cyl_len * 0.58
        prof = B.finned_profile(bore * 0.57, bore * 0.57 + 0.036, 0.0, cyl_len * 0.36, pitch=0.012)
        mb.lathe(prof, h0, d, 'Engine', n=20)
        top = base + d * (head_r - crank_r - 0.04)
        for s in (1, -1):
            mb.box(top + side * s * 0.036, (0.055, 0.04, 0.05), 'Engine', bevel=0.008, segs=1,
                   rot=Matrix.Rotation(-a, 4, 'X'))
            p0 = c + ax * 0.08 + d * (crank_r - 0.02) + side * s * 0.032
            p1 = top + ax * 0.025 + side * s * 0.036 - d * 0.02
            mb.cyl(p0, p1, 0.009, 'Metal_Frame', n=8)
        # short exhaust stack from the rear of each head, back and outwards (Fleet / Kinner installation)
        e0 = h0 + d * 0.045 - ax * 0.06
        e1 = e0 - ax * 0.12 + d * 0.05
        e2 = e1 - ax * 0.16 + d * 0.03
        mb.tube(catmull([e0, e1, e2], 4), 0.024, 'Exhaust', n=10, cap=True)
        mb.cyl(h0 + d * 0.05 + ax * 0.055, h0 + d * 0.05 + ax * 0.10, 0.006, 'Paint_Dark', n=6)
    ring = [c + ax * 0.115 + V(0, math.sin(TAU * k / 40), math.cos(TAU * k / 40)) * 0.15 for k in range(40)]
    closed_tube(mb, ring, 0.010, 'Paint_Dark', n=8)
    return mb.finish(sharp_angle=38, wn=True)


# ---------------------------------------------------------------------------
# Windscreens, pylon, rotor head, rotor
# ---------------------------------------------------------------------------
def build_windscreens():
    out = []
    for name, xb, xt, hw in (('ws_front', 0.56, 0.49, 0.20), ('ws_rear', -0.27, -0.33, 0.21)):
        z0 = BODY.top_z(R.x(xb), 0.0) - 0.012
        g, fr = C.windscreen(name, R.x(xb), R.x(xt), z0, z0 + 0.15, hw, bow=0.05)
        out.append((g, fr))
    return out


def body_entry(p, d, step=0.002):
    s = 0.0
    while s < 3.0:
        q = p + d * s
        if abs(q.y) < BODY.hw(q.x) and q.z <= BODY.top_z(q.x, q.y):
            return q
        s += step
    raise ValueError('leg misses the fuselage')


def body_normal(x, y, e=0.004):
    gx = (BODY.top_z(x + e, y) - BODY.top_z(x - e, y)) / (2 * e)
    gy = (BODY.top_z(x, y + e) - BODY.top_z(x, y - e)) / (2 * e)
    return V(-gx, -gy, 1.0).normalized()


def shoe(mb, hit, d, sq, mat='Paint_White'):
    """Faired foot of a strut on the decking: the section flares into a bolted plate."""
    mb.tube([hit - d * 0.07, hit - d * 0.02, hit + d * 0.01], [0.0, 0.0, 0.0], mat, n=14,
            square=(sq[0] * 1.45, sq[1] * 1.6, 2.2), cap=True)
    n = body_normal(hit.x, hit.y)
    ax = (V(1, 0, 0) - n * n.x).normalized()
    Rm = controls.basis(ax, n.cross(ax), n)
    mb.box(hit - n * 0.002, (0.12, 0.08, 0.012), 'Metal_Frame', bevel=0.004, segs=1, rot=Rm)


PYLON_TOP_Z = -0.36


def build_pylon():
    """Four streamlined steel legs from the shoulders round the front cockpit to a collar under the head
    (photos: front legs land ahead of the front cockpit, rear legs between the cockpits)."""
    mb = MB('pylon')
    feet = []
    for sy in (1, -1):
        for top, fx, fy, sq in ((H(0.07, PYLON_TOP_Z, sy * 0.06), 0.58, 0.37, (0.06, 0.028)),
                                (H(-0.07, PYLON_TOP_Z, sy * 0.06), -0.27, 0.38, (0.06, 0.028))):
            foot = V(R.x(fx), sy * fy, BODY.top_z(R.x(fx), fy) - 0.02)
            d = (foot - top).normalized()
            hit = body_entry(top, d)
            mb.tube([top, hit + d * 0.03], 0.0, 'Paint_White', n=14, square=sq + (2.2,), cap=True)
            shoe(mb, hit, d, sq)
            feet.append(hit)
    # collar and gusset plates under the head
    mb.lathe([(0.0, -0.06), (0.10, -0.06), (0.11, -0.04), (0.11, 0.05), (0.08, 0.07), (0.0, 0.07)],
             H(0.0, PYLON_TOP_Z), V(0, 0, 1), 'Engine_Dark', n=24)
    # cyclic-pitch control rods up the rear legs to the swash ring
    for sy in (1, -1):
        mb.cyl(H(-0.23, -1.00, sy * 0.30), H(-0.06, PYLON_TOP_Z + 0.02, sy * 0.13), 0.009, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=50, wn=True), feet


def build_head():
    """Rotor head (node `rotor_head`, origin on the pivot): bearing housing on the pylon collar, the
    non-rotating ring of the cyclic-pitch control under the hub."""
    mb = MB('rotor_head')
    p = PIVOT
    mb.box(p, (0.13, 0.13, 0.09), 'Engine', bevel=0.015, segs=2)
    mb.cyl(p + V(-0.09, 0, 0), p + V(0.09, 0, 0), 0.022, 'Metal_Frame', n=12)
    mb.cyl(p + V(0, -0.09, 0), p + V(0, 0.09, 0), 0.022, 'Metal_Frame', n=12)
    top = HUB.z - 0.10
    mb.lathe([(0.0, 0.0), (0.075, 0.0), (0.085, 0.025), (0.085, 0.10), (0.065, 0.13), (0.055, 0.13),
              (0.05, top - p.z), (0.0, top - p.z)], p + V(0, 0, 0.04), V(0, 0, 1), 'Engine_Dark', n=28)
    # non-rotating swash ring + its two arms
    zr = HUB.z - 0.155
    ring = [V(HUB.x + math.cos(TAU * k / 40) * 0.26, math.sin(TAU * k / 40) * 0.26, zr) for k in range(40)]
    closed_tube(mb, ring, 0.014, 'Engine', n=10)
    for a in (0.25, 0.75, 0.5):
        q = V(HUB.x + math.cos(TAU * a) * 0.26, math.sin(TAU * a) * 0.26, zr)
        mb.cyl(q, V(HUB.x, 0, zr), 0.010, 'Engine', n=8)
    mb.cyl(V(HUB.x, 0, zr - 0.02), V(HUB.x, 0, zr + 0.02), 0.07, 'Engine_Dark', n=20)
    return mb.finish(origin=p, sharp_angle=40, wn=True)


def blade(mb, hub, R_, chord, root, pitch_deg=2.0, cone_deg=1.2, tc=0.13):
    """Feathering blade (wood ribs on a steel spar, fabric): narrow root fairing widening to full chord
    at r ~ 1.8 m (3-view top), rounded tip. LE towards +Y for the blade along +X."""
    loop = airfoil_ring(14, tc, m=0.015, te_min=0.003)
    pitch = Matrix.Rotation(math.radians(pitch_deg), 3, 'X')
    cone = Matrix.Rotation(math.radians(-cone_deg), 3, 'Y')

    def section(r, c, th=1.0):
        return [hub + cone @ Vector((r, (pitch @ Vector((0.0, (0.25 - s) * c, tz * c * th))).y,
                                     (pitch @ Vector((0.0, (0.25 - s) * c, tz * c * th))).z)) for s, tz in loop]

    rs = [root, root + 0.08, 0.9, 1.3, 1.6, 1.85, 2.2, 3.0, 3.8, R_ - 0.45, R_ - 0.22]
    rings = []
    for r in rs:
        u = min(1.0, max(0.0, (r - 1.25) / 0.6))
        k = lerp(0.58, 1.0, u * u * (3 - 2 * u))
        th = lerp(1.6, 1.0, min(1.0, (r - root) / 0.5))
        rings.append(section(r, chord * k, th))
    mb.loft(rings, 'Rotor_Blade', closed=True, cap0=True)
    tip = []
    for k in range(9):
        u = k / 8.0
        r = R_ - 0.22 + 0.22 * math.sin(0.5 * math.pi * u)
        if k == 8:
            tip.append([section(r, 0.03, 0.6)[0]])
            continue
        f = math.cos(0.5 * math.pi * u) ** 0.5
        tip.append(section(r, max(chord * f, 0.03), 1.0 - 0.3 * u))
    mb.loft(tip, 'Rotor_Blade', closed=True)
    # root: steel spar shank out of the feathering bearing, clamp bands
    mb.cyl(hub + cone @ V(0.42, 0, 0), hub + cone @ V(root + 0.06, 0, 0), 0.030, 'Metal_Frame', n=14)
    for x in (root - 0.02, root + 0.10):
        mb.cyl(hub + cone @ V(x, 0, 0), hub + cone @ V(x + 0.025, 0, 0), 0.040, 'Engine_Dark', n=14)


def build_rotor():
    mb = MB('rotor')
    blade(mb, HUB, ROTOR_R, BLADE_CHORD, BLADE_ROOT)
    bm = mb.bm
    one = list(bm.verts)
    for k in range(1, 4):
        ret = bmesh.ops.duplicate(bm, geom=one + list({e for v in one for e in v.link_edges}) +
                                  list({f for v in one for f in v.link_faces}))
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=HUB, matrix=Matrix.Rotation(TAU * k / 4, 3, 'Z'))
    # hub drum; the two rigid cross spars (opposite blades linked) with a feathering bearing per blade
    mb.lathe([(0.0, -0.09), (0.10, -0.09), (0.12, -0.065), (0.12, 0.05), (0.09, 0.075), (0.0, 0.08)],
             HUB, V(0, 0, 1), 'Engine', n=32)
    for k in range(4):
        a = TAU * k / 4
        d = V(math.cos(a), math.sin(a), 0)
        t = V(-math.sin(a), math.cos(a), 0)
        mb.lathe([(0.0, 0.10), (0.05, 0.10), (0.058, 0.13), (0.058, 0.40), (0.048, 0.43), (0.0, 0.43)],
                 HUB, d, 'Engine', n=18)
        # pitch horn towards the leading edge and its link down to the rotating ring
        hp = HUB + d * 0.30 + t * 0.11 - V(0, 0, 0.02)
        mb.box(HUB + d * 0.30 + t * 0.06 - V(0, 0, 0.02), (0.04, 0.11, 0.022), 'Engine', bevel=0.006, segs=1,
               rot=Matrix.Rotation(a, 4, 'Z'))
        mb.cyl(hp, V(HUB.x, 0, HUB.z - 0.13) + (d * 0.30 + t * 0.11) * 0.9, 0.008, 'Metal_Frame', n=8)
    ring = [V(HUB.x + math.cos(TAU * k / 40) * 0.28, math.sin(TAU * k / 40) * 0.28, HUB.z - 0.135) for k in range(40)]
    closed_tube(mb, ring, 0.011, 'Metal_Frame', n=8)
    mb.lathe([(0.0, 0.08), (0.06, 0.08), (0.05, 0.12), (0.0, 0.13)], HUB, V(0, 0, 1), 'Engine', n=24)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Wing: low wing with dihedral outboard of the fuselage, rounded tips, ailerons, two struts a side
# ---------------------------------------------------------------------------
def w_le(ay):
    """LE X (hub frame) at |y|: straight, rounding into the tip."""
    y0 = 3.50
    if ay <= y0:
        return W_LE
    t = min(1.0, (ay - y0) / (W_SPAN2 - y0))
    return W_LE - 0.62 * (1 - math.sqrt(max(0.0, 1 - t * t)))


def w_te(ay):
    y0 = AIL[1]
    if ay <= y0:
        return W_LE - W_CHORD
    t = min(1.0, (ay - y0) / (W_SPAN2 - y0))
    return W_LE - W_CHORD + 0.78 * (1 - math.sqrt(max(0.0, 1 - t * t)))


def w_zc(ay):
    return W_ZC + max(0.0, ay - W_Y1) * math.tan(W_DIH)


def wing_section(y, s0=0.0, s1=1.0, n=16, tc=0.125):
    ay = abs(y)
    le, te = w_le(ay), w_te(ay)
    c = max(le - te, 0.02)
    if s0 == 0.0 and s1 == 1.0:
        loop = airfoil_ring(n, tc, m=0.03, te_min=0.0025)
    else:
        up, lo = [], []
        for i in range(n + 1):
            s = lerp(s0, s1, (i / n) ** (1.0 if s0 > 0 else 1.6))
            yc, yt = naca4(s, tc, 0.03)
            yt = max(yt, 0.0025)
            up.append((s, yc + yt))
            lo.append((s, yc - yt))
        loop = up[::-1] + lo[1:]
    z0 = w_zc(ay)
    return [H(le - s * c, z0 + tz * c - s * c * math.sin(W_INC), y) for s, tz in loop]


def wing_upper_z(X, ay):
    """Upper surface Z (hub frame) at chord position X."""
    le, te = w_le(ay), w_te(ay)
    c = le - te
    s = min(1.0, max(0.0, (le - X) / c))
    yc, yt = naca4(s, 0.125, 0.03)
    return w_zc(ay) + (yc + yt) * c - s * c * math.sin(W_INC)


def wing_lower_z(X, ay):
    le, te = w_le(ay), w_te(ay)
    c = le - te
    s = min(1.0, max(0.0, (le - X) / c))
    yc, yt = naca4(s, 0.125, 0.03)
    return w_zc(ay) + (yc - yt) * c - s * c * math.sin(W_INC)


def build_wing():
    mb = MB('wing')
    for sy in (1, -1):
        ys_in = [W_Y0, 0.30, W_Y1, 0.6, 0.9, 1.3, 1.6, AIL[0]]
        mb.loft([wing_section(sy * y) for y in ys_in], 'Paint_White', closed=True, cap0=True)
        ys_out = [AIL[0], 2.3, 2.8, 3.3, 3.5, 3.62, 3.73, AIL[1]]
        mb.loft([wing_section(sy * y, 0.0, AIL_S - 0.005) for y in ys_out], 'Paint_White', closed=True, cap0=True,
                cap1=True)
        mb.loft([wing_section(sy * (y if y not in AIL else y + (0.012 if y == AIL[0] else -0.012)), AIL_S + 0.008, 1.0,
                              n=8) for y in ys_out], 'Paint_White', closed=True, cap0=True, cap1=True)
        ys_tip = [AIL[1], 3.90, 3.97, 4.04, 4.09, 4.125]
        rings = [wing_section(sy * y) for y in ys_tip]
        last = wing_section(sy * 4.155)
        cen = sum(last, Vector()) / len(last)
        rings.append([cen + Vector(((p - cen).x * 0.9, (p - cen).y * 0.2, (p - cen).z * 0.3)) for p in last])
        mb.loft(rings, 'Paint_White', closed=True, cap1=True)
        # aileron hinge brackets underneath, control horn
        for y in (2.2, 3.5):
            xh = W_LE - AIL_S * W_CHORD
            mb.box(H(xh, wing_lower_z(xh, y) - 0.012, sy * y), (0.07, 0.012, 0.03), 'Metal_Frame', bevel=0.003, segs=1)
        xh = W_LE - (AIL_S + 0.05) * W_CHORD
        mb.box(H(xh, wing_lower_z(xh, 2.0) - 0.04, sy * 2.0), (0.06, 0.008, 0.07), 'Metal_Frame', bevel=0.003, segs=1)
    ob = mb.finish(sharp_angle=40)
    # chrome yellow on the upper surfaces outboard of the fuselage
    me = ob.data
    me.materials.append(MATS['Wing_Yellow'])
    yi = len(me.materials) - 1
    for p in me.polygons:
        if p.normal.z > 0.08 and abs(p.center.y) > 0.36:
            p.material_index = yi
    return ob


def build_wing_struts():
    """Two streamline struts a side from the upper longerons to the spars at 2.08 m, a jury strut."""
    mb = MB('wing_struts')
    sq = (0.07, 0.028, 2.2)
    for sy in (1, -1):
        for xf, xw in ((0.42, 0.40), (-0.24, -0.30)):
            top = H(xf, -1.24, sy * BODY.half_width(R.x(xf), R.z(-1.24)))
            bot = H(xw, wing_upper_z(xw, STRUT_Y), sy * STRUT_Y)
            d = (bot - top).normalized()
            mb.tube([top - d * 0.02, bot + d * 0.01], 0.0, 'Strut_Alu', n=14, square=sq, cap=True)
            mb.box(top, (0.09, 0.03, 0.06), 'Metal_Frame', bevel=0.006, segs=1)
            mb.box(bot + V(0, 0, 0.012), (0.10, 0.06, 0.02), 'Metal_Frame', bevel=0.005, segs=1)
            # jury strut from the strut down to the wing
            q = top + (bot - top) * ((JURY_Y - abs(top.y)) / (STRUT_Y - abs(top.y)))
            w = H(q.x - R.dx, wing_upper_z(q.x - R.dx, JURY_Y), sy * JURY_Y)
            mb.tube([q, w + V(0, 0, -0.01)], 0.0, 'Strut_Alu', n=10, square=(0.04, 0.018, 2.2), cap=True)
    return mb.finish(sharp_angle=50, wn=True)


# ---------------------------------------------------------------------------
# Tail: fin + rudder outline (hub frame), tapered tailplane, elevators, bracing wires
# ---------------------------------------------------------------------------
# 3-view side view, top lowered 5 cm and the upper LE moved aft after the landplane-photo overlay
FIN_OUTLINE = [(-2.30, -1.26), (-2.56, -1.03), (-2.80, -0.83), (-3.00, -0.66), (-3.15, -0.52), (-3.27, -0.42),
               (-3.38, -0.35), (-3.50, -0.312), (-3.64, -0.298), (-3.82, -0.302), (-3.98, -0.318), (-4.18, -0.345),
               (-4.38, -0.385), (-4.54, -0.44), (-4.645, -0.51), (-4.70, -0.60), (-4.72, -0.75), (-4.72, -1.36),
               (-4.55, -1.41), (-4.30, -1.47), (-3.98, -1.56)]


def outline_x(z_hub, front=True):
    """Front-most (or rear-most) X of the fin/rudder outline at height z (hub frame)."""
    pts = FIN_OUTLINE
    xs = []
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if (z0 - z_hub) * (z1 - z_hub) <= 0 and z0 != z1:
            xs.append(lerp(x0, x1, (z_hub - z0) / (z1 - z0)))
    if not xs:
        return None
    return max(xs) if front else min(xs)


FIN_ZTOP = -0.298


def fin_le(z):
    Zh = z - R.dz
    x = outline_x(min(Zh, FIN_ZTOP - 0.001), True)
    return R.x(x if x is not None else -2.30)


def fin_te(z):
    Zh = z - R.dz
    xb = outline_x(min(Zh, FIN_ZTOP - 0.001), False)
    return R.x(max(HINGE_X, xb if xb is not None else HINGE_X))


def full_te(z):
    """Rear-most X of the outline (rudder trailing edge, or the rounded top ahead of the hinge)."""
    Zh = z - R.dz
    xb = outline_x(min(Zh, FIN_ZTOP - 0.001), False)
    return R.x(xb if xb is not None else -4.72)


FIN_T = 0.05


def rud_le(z):
    """Leading edge of the full fin section (for the rudder thickness); below the fin: synthetic."""
    Zh = z - R.dz
    if Zh < -1.20:
        return R.x(HINGE_X + 0.55)
    return fin_le(z)


def rud_te(z):
    Zh = z - R.dz
    xb = outline_x(min(Zh, -0.319), False)
    return R.x(xb if xb is not None else -4.72)


def tp_le(ay):
    t = min(1.0, max(0.0, (ay - 0.13) / (TP_HALF - 0.13)))
    return lerp(TP_LE_ROOT, TP_LE_TIP, t)


def build_tail():
    mb = MB('tail')
    zs = [R.z(z) for z in (-1.26, -1.15, -1.00, -0.85, -0.70, -0.58, -0.49, -0.42, -0.37, -0.34, -0.32, -0.308,
                           -0.3005)]
    E.fin_loft(mb, zs, fin_le, full_te, t=FIN_T,
               s_end_fn=lambda z: min(1.0, (fin_le(z) - fin_te(z)) / max(fin_le(z) - full_te(z), 1e-3)))
    # tailplane: swept LE, straight hinge; elevators behind it (cut-out at the root for the rudder)
    loop = airfoil_ring(12, 0.09, te_min=0.002)
    for sy in (1, -1):
        rings = []
        for ay in (0.0, 0.13, 0.4, 0.7, 1.0, 1.2, TP_HALF - 0.02):
            le = tp_le(ay)
            c = le - ELEV_HINGE
            rings.append([H(le - s * c, TP_Z + tz * max(c, 0.25) * (c / max(c, 0.25)), sy * ay) for s, tz in loop])
        # rounded tip
        le = tp_le(TP_HALF)
        rings.append([H(le - s * (le - ELEV_HINGE), TP_Z + tz * 0.06, sy * TP_HALF) for s, tz in loop])
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        # elevator: hinge -> TE, from 0.22 m to the tip
        rings = []
        for ay in (ELEV_Y0, 0.5, 0.9, 1.2, TP_HALF + 0.02, TP_HALF + 0.05):
            c = (ELEV_HINGE - ELEV_TE) * (1.0 if ay <= TP_HALF else 0.75)
            x0 = ELEV_HINGE - 0.008
            th = 0.022 * (1.0 if ay <= TP_HALF else 0.6)
            ring = []
            for k in range(10):
                s = k / 9.0
                ring.append(H(x0 - s * c, TP_Z + th * (1 - s) + 0.002, sy * ay))
            for k in range(9, -1, -1):
                s = k / 9.0
                ring.append(H(x0 - s * c, TP_Z - th * (1 - s) - 0.002, sy * ay))
            rings.append(ring)
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        # bracing: wires from the fin to the tailplane top, struts/wires from its underside to the
        # bottom longeron
        mb.cyl(H(-3.38, -0.50, 0.0), H(-3.75, TP_Z + 0.02, sy * 0.95), 0.0035, 'Wire', n=6)
        mb.cyl(H(-3.85, -0.45, 0.0), H(-3.90, TP_Z + 0.02, sy * 0.95), 0.0035, 'Wire', n=6)
        for xs in (-3.55, -3.85):
            mb.cyl(H(xs, TP_Z - 0.02, sy * 0.95), H(-3.60, -1.60, sy * 0.09), 0.0045, 'Wire', n=6)
        for x in (-3.75, -3.90):
            mb.box(H(x, TP_Z + 0.025, sy * 0.95), (0.03, 0.012, 0.012), 'Metal_Frame', bevel=0.002, segs=1)
    # sternpost cap
    mb.box(H(-3.965, -1.36), (0.04, 0.05, 0.36), 'Paint_White', bevel=0.015, segs=2)
    return mb.finish(sharp_angle=45)


RUDDER_PIVOT = (HINGE_X, -0.90)


def build_rudder():
    zs = [R.z(z) for z in (-1.555, -1.50, -1.40, -1.30, -1.20, -1.05, -0.90, -0.75, -0.62, -0.52, -0.45, -0.39,
                           -0.35, -0.322)]
    origin = H(*RUDDER_PIVOT)
    rud = E.build_rudder_surface('rudder', zs, rud_le, rud_te, R.x(HINGE_X), origin, t=FIN_T, mat='Paint_White')
    regs = []
    try:
        regs = E.build_registration(rud, 'XOZ-1', cx=R.x(-4.27) - origin.x, cz=R.z(-0.60) - origin.z, size=0.085,
                                    mat='Paint_Dark')
    except Exception as ex:
        print('  !! rudder letters skipped:', ex)
    # white tail light on the trailing edge, low (period practice)
    det = MB('rudder_det')
    tl = H(-4.722, -1.10)
    K.lamp(det, tl - origin + origin, V(-1, 0, 0), kind='white', r=0.018, length=0.03, base='Metal_Frame')
    d_ob = det.finish(sharp_angle=50)
    for r in regs:
        r.location = r.location + origin
    B.join_objects('rudder', [rud] + regs + [d_ob])
    rud = bpy.data.objects['rudder']
    return rud


# ---------------------------------------------------------------------------
# Edo floats
# ---------------------------------------------------------------------------
def float_u(X):
    return (FLOAT_BOW - X) / FLOAT_L


def float_halfbeam(u):
    if u < 0.30:
        t = u / 0.30
        return FLOAT_B * math.sin(0.5 * math.pi * t) ** 0.75
    us = (FLOAT_BOW - STEP_X) / FLOAT_L
    if u <= us:
        return FLOAT_B
    t = (u - us) / (1 - us)
    return FLOAT_B * lerp(1.0, 0.26, t ** 1.25)


def float_top(u):
    """Deck Z: flat, curving down into the bow."""
    if u < 0.10:
        t = 1 - u / 0.10
        return FLOAT_DECK - 0.11 * t * t
    return FLOAT_DECK


def float_keel(u, aft=False):
    us = (FLOAT_BOW - STEP_X) / FLOAT_L
    zk = FLOAT_DECK - FLOAT_DEPTH
    if u <= us and not aft:
        if u < 0.30:
            t = u / 0.30
            return lerp(FLOAT_DECK - 0.17, zk, 1 - (1 - t) ** 2.2)
        return zk
    t = max(0.0, (u - us) / (1 - us))
    return lerp(zk + STEP_H, FLOAT_DECK - 0.11, t)


def float_section(X, aft=False, yc=0.0):
    u = float_u(X)
    b = max(float_halfbeam(u), 0.004)
    zt, zk = float_top(u), float_keel(u, aft)
    dr = math.radians(DEADRISE + 22.0 * max(0.0, 1 - u / 0.30) ** 2)
    zc = min(zk + b * math.tan(dr), zt - 0.06)        # chine
    bd = b * 0.90                                      # deck a little narrower than the chine (flared sides)
    half = [(0.0, zt + 0.012), (bd * 0.5, zt + 0.009), (bd - 0.03, zt + 0.003), (bd - 0.008, zt - 0.006),
            (bd, zt - 0.03), (lerp(bd, b, 0.5), lerp(zt - 0.03, zc, 0.5)), (b, zc + 0.012), (b, zc),
            (b * 0.66, lerp(zc, zk, 0.36)), (b * 0.33, lerp(zc, zk, 0.70)), (0.0, zk)]
    ring = [H(X, z, yc + y) for y, z in half]
    ring += [H(X, z, yc - y) for y, z in reversed(half[1:-1])]
    return ring


def build_float(sy):
    mb = MB('float_' + ('L' if sy > 0 else 'R'))
    yc = sy * FLOAT_Y
    xs = [FLOAT_BOW - FLOAT_L * u for u in (0.004, 0.012, 0.025, 0.045, 0.07, 0.10, 0.14, 0.19, 0.25, 0.31)]
    x = xs[-1]
    while x - 0.30 > STEP_X:
        x -= 0.30
        xs.append(x)
    fore = [float_section(x, False, yc) for x in xs] + [float_section(STEP_X + 0.001, False, yc)]
    nose = H(FLOAT_BOW, float_top(0.0) - 0.02, yc)
    mb.loft([[nose]] + fore, 'Float_Alu', closed=True)
    xa = [STEP_X - 0.001]
    x = STEP_X
    stern = FLOAT_BOW - FLOAT_L
    while x - 0.32 > stern + 0.05:
        x -= 0.32
        xa.append(x)
    xa.append(stern)
    aft = [float_section(STEP_X + 0.001, False, yc)] + [float_section(x, True, yc) for x in xa]
    mb.loft(aft, 'Float_Alu', closed=True, cap1=True)
    # deck fittings: hand-hole covers, bow cleat, lifting eyes over the struts
    for X in (2.0, 1.55, 0.6, -0.9, -1.6, -2.2):
        if stern + 0.3 < X < FLOAT_BOW - 0.4:
            mb.cyl(H(X, FLOAT_DECK + 0.010, yc), H(X, FLOAT_DECK + 0.022, yc), 0.075, 'Metal_Frame', n=20)
    mb.box(H(FLOAT_BOW - 0.35, float_top(0.35 / FLOAT_L) + 0.02, yc), (0.10, 0.03, 0.03), 'Metal_Frame', bevel=0.008,
           segs=1)
    # strut fittings on the deck
    for X in (FRONT_STRUT_X, REAR_STRUT_X):
        mb.box(H(X, FLOAT_DECK + 0.02, yc), (0.16, 0.09, 0.03), 'Metal_Frame', bevel=0.008, segs=1)
    # water-rudder post and bracket at the stern
    mb.cyl(H(stern - 0.01, FLOAT_DECK - 0.06, yc), H(stern - 0.01, FLOAT_DECK + 0.10, yc), 0.012, 'Metal_Frame', n=10)
    mb.box(H(stern + 0.04, FLOAT_DECK + 0.01, yc), (0.12, 0.05, 0.03), 'Metal_Frame', bevel=0.006, segs=1)
    return mb.finish(sharp_angle=35)


def build_water_rudder(sy):
    """Small water rudder hanging behind the stern on a vertical hinge (node rudder_waterL/R)."""
    name = 'rudder_water' + ('L' if sy > 0 else 'R')
    stern = FLOAT_BOW - FLOAT_L
    hinge = H(stern - 0.01, FLOAT_DECK - 0.12, sy * FLOAT_Y)
    mb = MB(name)
    z0, z1 = FLOAT_DECK - 0.42, FLOAT_DECK - 0.07
    c = 0.16
    rings = []
    for z in (z0, z0 + 0.03, lerp(z0, z1, 0.5), z1):
        cc = c * (0.85 if z == z0 else 1.0)
        rings.append([H(stern - 0.02 - s * cc, z, sy * FLOAT_Y + tz * cc) for s, tz in airfoil_ring(8, 0.10, te_min=0.002)])
    mb.loft(rings, 'Float_Alu', closed=True, cap0=True, cap1=True)
    mb.cyl(H(stern - 0.01, z0 + 0.02, sy * FLOAT_Y), H(stern - 0.01, FLOAT_DECK + 0.0, sy * FLOAT_Y), 0.010,
           'Metal_Frame', n=10)
    mb.box(H(stern - 0.05, FLOAT_DECK - 0.03, sy * FLOAT_Y), (0.07, 0.04, 0.02), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(origin=hinge, sharp_angle=40)


def build_float_struts():
    """N struts each side (front strut leaning forward, vertical rear strut, diagonal), spreader bars
    and cross wires."""
    mb = MB('float_struts')
    sq = (0.075, 0.03, 2.2)
    deck = FLOAT_DECK + 0.03
    feet = {}
    for sy in (1, -1):
        yc = sy * FLOAT_Y
        f_top = H(0.70, BODY.zb(R.x(0.70)) - R.dz + 0.02, sy * 0.22)
        r_top = H(-0.30, wing_lower_z(-0.30, 0.42), sy * 0.42)
        f_bot = H(FRONT_STRUT_X, deck, yc)
        r_bot = H(REAR_STRUT_X, deck, yc)
        for a, b in ((f_top, f_bot), (r_top, r_bot), (f_top + V(-0.06, 0, 0), r_bot + V(0.06, 0, 0))):
            d = (b - a).normalized()
            mb.tube([a - d * 0.02, b + d * 0.01], 0.0, 'Strut_Alu', n=14, square=sq, cap=True)
        for p in (f_top, r_top):
            mb.box(p + V(0, 0, 0.0), (0.10, 0.07, 0.04), 'Metal_Frame', bevel=0.006, segs=1)
        # inner wire from the front strut top to the rear foot of the other side is drawn below
        feet[sy] = (f_top, r_top, f_bot, r_bot)
    # spreader bars between the floats + cross wires
    for k in (2, 3):
        a, b = feet[1][k], feet[-1][k]
        mb.tube([a + V(0, -0.05, 0.0), b + V(0, 0.05, 0.0)], 0.0, 'Strut_Alu', n=12, square=(0.06, 0.03, 2.2),
                cap=True)
    for k_top, k_bot in ((0, 2), (1, 3)):
        for sy in (1, -1):
            mb.cyl(feet[sy][k_top] + V(0, 0, -0.03), feet[-sy][k_bot] + V(0, 0, 0.02), 0.004, 'Wire', n=6)
    for sy in (1, -1):
        mb.cyl(feet[sy][2] + V(-0.05, 0, 0.02), feet[-sy][3] + V(0.05, 0, 0.02), 0.004, 'Wire', n=6)
    return mb.finish(sharp_angle=50, wn=True)


# ---------------------------------------------------------------------------
# Cockpits, crew, controls
# ---------------------------------------------------------------------------
def period_stick(base, top):
    """Plain 1930s control column: steel tube with a leather-bound round grip; node `stick`."""
    mb = MB('stick')
    base, top = Vector(base), Vector(top)
    d = (top - base).normalized()
    mb.lathe([(0.0, 0.0), (0.05, 0.0), (0.05, 0.012), (0.035, 0.03), (0.0, 0.03)], base, d, 'Grip_Leather', n=18)
    g0 = top - d * 0.14
    mb.cyl(base, g0 + d * 0.01, 0.013, 'Metal_Frame', n=12)
    mb.lathe([(0.0, 0.0), (0.019, 0.0), (0.021, 0.01), (0.021, 0.11), (0.024, 0.125), (0.022, 0.135), (0.012, 0.14),
              (0.0, 0.141)], g0, d, 'Grip_Leather', n=18)
    ob = mb.finish(origin=base, sharp_angle=40)
    return ob, g0 + d * 0.06, d


def period_seat(mb, hip, back_deg, width=0.40):
    """1930s bucket seat: leather cushion and back pad on an aluminium pan, tube legs; the back stops
    0.13 m above the cushion so the rear pilot's boots pass under the front seat."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    seat_top = hip.z - 0.085
    tilt = Euler((0, math.radians(-6), 0))
    c = V(hip.x + 0.10, 0, seat_top - 0.035)
    mb.box(c, (0.40, width, 0.07), 'Seat', bevel=0.025, segs=2, rot=tilt)
    mb.box(c - V(0, 0, 0.045), (0.42, width + 0.02, 0.02), 'Metal_Frame', bevel=0.006, segs=1, rot=tilt)
    back_c = hip - f * 0.165 + u * 0.40
    rb = Euler((0, -b, 0))
    mb.box(back_c, (0.06, width, 0.48), 'Seat', bevel=0.025, segs=2, rot=rb)
    mb.box(back_c - f * 0.04, (0.02, width + 0.02, 0.50), 'Metal_Frame', bevel=0.006, segs=1, rot=rb)
    for sx in (-0.08, 0.26):
        for sy in (1, -1):
            mb.cyl(V(hip.x + sx, sy * (width / 2 - 0.03), seat_top - 0.09), V(hip.x + sx, sy * (width / 2 - 0.03), R.z(FLOOR_Z)),
                   0.012, 'Metal_Frame', n=8)


def build_cockpits():
    mb = MB('cockpit')
    xs_f = [lerp(CK_R[1] - 0.08, 0.92, k / 16) for k in range(17)]
    coords = []
    for X in xs_f:
        w = BODY.half_width(R.x(X), R.z(FLOOR_Z)) - 0.014
        coords += [H(X, FLOOR_Z, -w), H(X, FLOOR_Z, w)]
    mb.faces(coords, [[2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1] for k in range(16)], 'Interior')
    # bulkheads behind the pilot's seat and ahead of the passenger's feet (fuselage section shrunk 2.5 %)
    for Xb in (CK_R[1] - 0.08, 0.92):
        xb = R.x(Xb)
        c = V(xb, 0, BODY.zw(xb))
        ring = [c + (p - c) * 0.975 for p in BODY.ring(xb, 48)]
        idx = list(range(len(ring)))
        mb.faces(ring, [idx[::-1] if Xb < 0 else idx], 'Interior', smooth=False)
    # seats: leather cushions on a light frame (the pilot's feet pass under the passenger's seat)
    period_seat(mb, H(*PILOT_HIP), PILOT_BACK, width=0.42)
    period_seat(mb, H(*PASS_HIP), PASS_BACK, width=0.42)
    # pilot's wooden board under the rear windscreen, drawn live by the sim (src/aircraft/VintagePanel.ts):
    # engine tachometer, rotor tachometer, altimeter, airspeed, oil pressure, oil temperature (Aero Digest
    # list) and a cross level
    E.panel(mb, H(-0.315, -1.125), 0.46, 0.17, 12, glare=False, live=('vintage_board', [
        {'k': 'asi', 'u': -0.159, 'v': 0.022, 'd': 0.076},
        {'k': 'alt', 'u': -0.053, 'v': 0.022, 'd': 0.076},
        {'k': 'rotor', 'u': 0.053, 'v': 0.022, 'd': 0.076},
        {'k': 'engine', 'u': 0.159, 'v': 0.022, 'd': 0.076},
        {'k': 'oilp', 'u': -0.106, 'v': -0.045, 'd': 0.044},
        {'k': 'level', 'u': 0.0, 'v': -0.045, 'w': 0.09, 'h': 0.02},
        {'k': 'oilt', 'u': 0.106, 'v': -0.045, 'd': 0.044},
    ]))
    # fuel filler cap ahead of the front windscreen (16 US gal tank in the fuselage nose)
    zt = BODY.top_z(R.x(0.85), 0.0)
    mb.cyl(V(R.x(0.85), 0, zt - 0.01), V(R.x(0.85), 0, zt + 0.018), 0.045, 'Metal_Frame', n=20)
    # steps / hand holds
    for sy in (1, -1):
        mb.box(H(-0.05, -1.55, sy * BODY.half_width(R.x(-0.05), R.z(-1.55))), (0.12, 0.02, 0.05), 'Metal_Frame',
               bevel=0.005, segs=1)
    return mb.finish(sharp_angle=40, wn=True)


def build_crew():
    ctrl = MB('controls_static')
    stick, grip, axis = period_stick(H(-0.40, FLOOR_Z), H(-0.44, -1.28))
    knob, lever = controls.throttle_lever(ctrl, H(-0.58, -1.34, 0.31), length=0.10, brake=False)
    hip = H(*PILOT_HIP)
    pilot.build_pilot('pilot_front', hip, PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': H(-0.16, FLOOR_Z + 0.12, 0.19), 'R': H(-0.16, FLOOR_Z + 0.12, -0.19)},
                      helmet='leather', knee_out=0.04, elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(FLOOR_Z))
    K.print_joints('pilot_front', R)
    ph = H(*PASS_HIP)
    pilot.build_pilot('pilot_rear', ph, PASS_BACK,
                      hands={'R': ('rest', ph + V(0.22, -0.13, 0.18), None),
                             'L': ('rest', ph + V(0.22, 0.13, 0.18), None)},
                      feet={'L': H(0.74, FLOOR_Z + 0.12, 0.15), 'R': H(0.74, FLOOR_Z + 0.12, -0.15)},
                      helmet='leather', knee_out=0.03, elbow_out=0.04)
    # US Navy crew: no Spanish flag on the shoulder (pilot.py adds one), plain leather jacket there
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and (o.name.startswith('pilot_front') or o.name.startswith('pilot_rear')):
            for fl in ('Flag_Red', 'Flag_Yellow'):
                E.swap_material(o, fl, 'Pilot_Suit')
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = hip + u * (pilot.SPINE + 0.13) + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    E.make_eye(eye)
    return ctrl.finish(sharp_angle=40), stick, eye, head


# ---------------------------------------------------------------------------
# Markings and lights
# ---------------------------------------------------------------------------
def build_markings(fus, tail):
    obs = []
    try:
        obs += E.build_registration(fus, 'U.S. NAVY', cx=R.x(-3.02), cz=R.z(-1.48), size=0.25, mat='Paint_Dark')
        obs += E.build_registration(tail, '8602', cx=R.x(-3.74), cz=R.z(-0.55), size=0.085, mat='Paint_Dark')
    except Exception as ex:
        print('  !! letters skipped:', ex)
    return obs


def build_lights():
    """Real lights where period-correct: wing-tip nav lights (red left, green right), white tail light
    on the rudder. MINIMUM SET, NOT ON THE PHOTOS (every aircraft of the sim carries them): one landing
    lamp let into the left wing leading edge outboard of the strut (where 1930s makers put it) and one
    red anti-collision beacon on the fin top."""
    mb = MB('lights')
    for sy in (1, -1):
        ay = W_SPAN2 - 0.02
        X = w_le(ay) - 0.5 * (w_le(ay) - w_te(ay)) + 0.18
        p = H(X, w_zc(ay) + 0.005, sy * (ay - 0.01))
        K.lamp(mb, p, V(0.6, sy * 1.0, 0.0), kind='red' if sy > 0 else 'green', r=0.022, length=0.035)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0.6, sy * 1.0, 0).normalized() * 0.06)
    K.lamp_node('tail', H(-4.722 - 0.06, -1.10))
    # MINIMUM SET, NOT ON THE PHOTOS: landing lamp in the left wing leading edge
    ay = 2.75
    lp = H(w_le(ay) - 0.02, w_zc(ay) + 0.01, ay)
    mb.lathe([(0.0, -0.01), (0.075, -0.01), (0.075, 0.012), (0.0, 0.012)], lp, V(1, 0, 0), 'Metal_Frame', n=24)
    mb.lathe([(0.0, 0.012), (0.068, 0.012), (0.06, 0.026), (0.0, 0.032)], lp, V(1, 0, 0), 'Lens_White', n=24)
    K.lamp_node('landing', lp + V(0.07, 0, 0))
    # MINIMUM SET, NOT ON THE PHOTOS: red beacon on the fin top
    bp = H(-3.72, FIN_ZTOP - 0.004)
    K.lamp(mb, bp, V(0, 0, 1), kind='red', r=0.024, length=0.045, base='Paint_White')
    K.lamp_node('beacon', bp + V(0, 0, 0.07), 'red')
    return mb.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
GEOM = {}


def build_wilford():
    build_extra_materials()
    fus, rim = build_fuselage()
    ws = build_windscreens()
    engine = build_kinner(H(ENGINE_X, THRUST_Z))
    C.build_wood_prop(PROP, PROP_R, pitch_ratio=0.62, spin=1, body_mat='Prop_Metal', tip_mat='Prop_Metal')
    pylon, feet = build_pylon()
    build_head()
    build_rotor()
    wing = build_wing()
    struts = build_wing_struts()
    tail = build_tail()
    build_rudder()
    cockpit = build_cockpits()
    ctrl, stick, eye, head = build_crew()
    marks = build_markings(fus, tail)
    lights = build_lights()
    floats = []
    if not LAND:
        floats = [build_float(1), build_float(-1), build_float_struts()]
        build_water_rudder(1)
        build_water_rudder(-1)
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [cockpit, ctrl], ' (pilot legs)')
    K.clearance(['pilot_rear'], [fus, cockpit, pylon], ' (passenger)')
    K.clearance(['pilot_front'], [fus], ' (pilot)')
    K.finalize([fus, rim, engine, pylon, wing, struts, tail, cockpit, ctrl, lights] + [g[1] for g in ws] + marks
               + floats, [g[0] for g in ws])
    GEOM.update(eye=eye, head=head)
    req = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': H(*RUDDER_PIVOT), 'stick': H(-0.40, FLOOR_Z),
        'eye_front': eye, 'pilot_rear': None,
    }
    if not LAND:
        stern = FLOAT_BOW - FLOAT_L
        req['rudder_waterL'] = H(stern - 0.01, FLOAT_DECK - 0.12, FLOAT_Y)
        req['rudder_waterR'] = H(stern - 0.01, FLOAT_DECK - 0.12, -FLOAT_Y)
    B.REQUIRED = {k: (None if p is None else (round(p.x, 4), round(p.z, 4), round(-p.y, 4))) for k, p in req.items()}
    B.REQUIRED.update({k: None for k in ('pilot_front', 'throttle', 'pedal_L', 'pedal_R')})
    B.REQUIRED.update(controls.rig_nodes('pilot_front'))
    report()


def report():
    """Numbers for the hand-off (model coordinates as model-geom prints them: x fwd, y up, z right)."""
    def m(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('WILFORD CG model (0.08, 0.10); hub %s pivot %s prop %s D %.2f' % (m(HUB), m(PIVOT), m(PROP), 2 * PROP_R))
    stern = FLOAT_BOW - FLOAT_L
    print('WILFORD floats: bow x %.3f y %.3f | stern x %.3f y %.3f | z centre +-%.3f | keel at step y %.3f | '
          'deck y %.3f | half-width %.3f | step x %.3f' % (
              R.x(FLOAT_BOW), R.z(float_top(0.0) - 0.02), R.x(stern), R.z(FLOAT_DECK - 0.11), FLOAT_Y,
              R.z(FLOAT_DECK - FLOAT_DEPTH), R.z(FLOAT_DECK), FLOAT_B, R.x(STEP_X)))
    print('WILFORD eye %s head %s' % (m(GEOM['eye']), m(GEOM['head'])))
    # water rudders
    print('WILFORD water rudder hinge x %.3f y %.3f z +-%.3f, blade 0.16 x 0.35 m = %.3f m2 each' % (
        R.x(stern - 0.01), R.z(FLOAT_DECK - 0.12), FLOAT_Y, 0.16 * 0.35 - 0.5 * 0.024 * 0.03))
    # wing
    tip_le, tip_te = w_le(3.50), w_te(AIL[1])
    print('WILFORD wing span %.2f, root (y %.2f) LE %s TE %s | tip LE x %.3f (rounding from y 3.50) TE x %.3f (from y %.2f), '
          'tip point x %.3f y %.3f z +-%.3f | root chord %.2f, tip chord at y 3.83 %.2f | dihedral %.1f (outboard of y '
          '%.2f), incidence %.1f, aileron y %.2f-%.2f = %.0f-%.0f %% semi-span, chord %.2f m' % (
              2 * W_SPAN2, W_Y1, m(H(W_LE, w_zc(W_Y1), W_Y1)), m(H(W_LE - W_CHORD, w_zc(W_Y1), W_Y1)), R.x(W_LE), R.x(W_LE - W_CHORD),
              AIL[1], R.x(w_le(W_SPAN2 - 0.01)), R.z(w_zc(W_SPAN2)), W_SPAN2, W_CHORD, w_le(3.83) - w_te(3.83),
              math.degrees(W_DIH), W_Y1, math.degrees(W_INC), AIL[0], AIL[1], 100 * AIL[0] / W_SPAN2,
              100 * AIL[1] / W_SPAN2, (1 - AIL_S) * W_CHORD))

    def grid_area(inside, x0, x1, y0, y1, d=0.01):
        n, sx, sy = 0, 0.0, 0.0
        x = x0
        while x < x1:
            y = y0
            while y < y1:
                if inside(x, y):
                    n += 1
                    sx += x
                    sy += y
                y += d
            x += d
        return n * d * d, (sx / max(n, 1), sy / max(n, 1))

    def tp_in(X, y):
        ay = abs(y)
        if ay > TP_HALF + 0.03:
            return False
        if X > tp_le(ay) or X < ELEV_TE:
            return False
        return not (X < ELEV_HINGE and ay < ELEV_Y0)
    a, (cx, cy) = grid_area(tp_in, -4.40, -3.10, -1.40, 1.40)
    print('WILFORD tailplane + elevators area %.2f m2, centre x %.3f y %.3f (span %.2f)' % (a, R.x(cx), R.z(TP_Z),
                                                                                          2 * TP_HALF))
    from panel import inside as pin

    def fin_in(X, Z, rudder):
        if not pin(FIN_OUTLINE + [(-2.30, -1.56)], X, Z):
            return False
        if (X < HINGE_X) != rudder:
            return False
        return Z > BODY.top_z(R.x(X), 0.0) - R.dz or X < -3.95
    for nm, rud in (('fin', False), ('rudder', True)):
        a, (cx, cz) = grid_area(lambda X, Z: fin_in(X, Z, rud), -4.75, -2.2, -1.60, -0.2)
        print('WILFORD %s area %.2f m2 (exposed), centre x %.3f y %.3f' % (nm, a, R.x(cx), R.z(cz)))
    # candidate crash points
    pts = {'cyl_head_top': cyl_head(0, 0.59), 'cyl_head_L72': cyl_head(1, 0.59), 'cyl_head_R288': cyl_head(4, 0.59),
           'cyl_head_L144': cyl_head(2, 0.59), 'cyl_head_R216': cyl_head(3, 0.59),
           'rotor_cap_top': HUB + V(0, 0, 0.13), 'pylon_collar': H(0.0, PYLON_TOP_Z),
           'wing_tip_L': H(w_le(W_SPAN2 - 0.01), w_zc(W_SPAN2), W_SPAN2),
           'wing_tip_R': H(w_le(W_SPAN2 - 0.01), w_zc(W_SPAN2), -W_SPAN2),
           'fin_top': H(-3.72, FIN_ZTOP + 0.05), 'rudder_te_bottom': H(-4.72, -1.36), 'rudder_bottom': H(-3.98, -1.56),
           'float_bow_L': H(FLOAT_BOW, float_top(0.0) - 0.02, FLOAT_Y), 'float_bow_R': H(FLOAT_BOW, float_top(0.0) - 0.02, -FLOAT_Y),
           'float_stern_L': H(stern, FLOAT_DECK - 0.11, FLOAT_Y), 'water_rudder_bottom_L': H(stern - 0.1, FLOAT_DECK - 0.42, FLOAT_Y),
           'keel_step_L': H(STEP_X, FLOAT_DECK - FLOAT_DEPTH, FLOAT_Y), 'prop_tip_low': H(PROP_X, THRUST_Z - PROP_R)}
    for k, p in pts.items():
        print('WILFORD point %-22s %s' % (k, m(p)))


# ---------------------------------------------------------------------------
# Photo overlays: pinhole camera solved from correspondences (model points <-> photo pixels)
# ---------------------------------------------------------------------------
REF = os.path.join(os.environ.get('WILFORD_REF', ''), '')


def cyl_head(k, r=0.47):
    a = TAU * k / 5
    return H(ENGINE_X + 0.01, THRUST_Z + math.cos(a) * r, math.sin(a) * r)


def float_photo_points():
    """Commons Wilford_Gyroplane_XOZ-1_floatplane.jpg (662 x 279): features read on 4-7x zooms."""
    return [
        (HUB + V(0, 0, 0.02), (322.0, 53.0)),
        (PROP, (199.0, 141.0)),
        (cyl_head(0), (223.0, 109.0)),
        (cyl_head(1), (224.0, 130.0)),
        (cyl_head(2), (220.0, 162.0)),
        (H(0.42, -1.24, 0.40), (297.5, 135.0)),        # front wing strut on the fuselage
        (H(-0.24, -1.24, 0.40), (340.0, 135.0)),       # rear wing strut on the fuselage
        (H(ELEV_TE, TP_Z, TP_HALF + 0.03), (600.0, 136.0)),   # near elevator tip, trailing corner
        (H(-4.72, -0.95), (591.0, 108.0)),                    # rudder trailing edge (bright fin on the sky)
        (H(W_LE - W_CHORD, w_zc(AIL[1]) + 0.02, AIL[1]), (425.0, 177.0)),    # near wing TE corner (dark lens end)
        (H(W_LE, w_zc(0.42) + 0.04, 0.42), (272.0, 175.0)),                  # near wing root LE under the fuselage
    ]


FLOAT_HORIZON = [(0.0, 114.0), (200.0, 110.0)]     # far shore waterline left of the nose (eye level)


SOLVED = {}
LAND_PITCH = 15.0        # 3-point attitude of the landplane (3-view: main and tail tyres on one line)


def land_photo_points():
    """Wilford_XOZ1.jpg (901 x 351), landplane, rear three-quarter left, model pitched LAND_PITCH nose up."""
    pts = [
        (HUB + V(0, 0, 0.02), (462.0, 93.0)),
        (H(-4.71, -0.62), (889.0, 224.0)),          # rudder trailing edge, top of the straight part
        (H(-4.72, -1.36), (876.0, 318.0)),          # rudder trailing edge, bottom corner
        (H(-3.74, -0.55, 0.03), (784.0, 202.0)),    # "8602"
        (H(-4.27, -0.60, 0.03), (841.0, 213.0)),    # "XOZ-1"
        (H(0.58, -1.00, 0.37), (420.0, 178.0)),     # front-left pylon foot
        (H(-0.27, -1.00, 0.38), (455.0, 197.0)),    # rear-left pylon foot
        (cyl_head(0, 0.53), (349.0, 152.0)),        # top cylinder rocker boxes over the nose
        (H(0.52, -2.66, 0.857), (334.0, 313.0)),    # near main wheel hub (3-view: 7.50x10, tread 67.5 in)
        (H(-3.75, -1.72), (758.0, 331.0)),          # tail wheel
        (H(0.30, w_zc(4.05), 4.05), (115.0, 232.0)),  # near wing tip, left-most point
    ]
    return pts


def solve_camera(points, size, f0=900.0, loc0=(0.5, 16.0, 1.0), yaw0=-90.0, pitch0=-2.0, horizon=(), w_h=1.0,
                 fixed_f=None, model_pitch=None):
    """Gauss-Newton fit of a pinhole camera: position, yaw, pitch, roll, focal (px); the principal point
    is the picture centre. `horizon`: pixels of the eye-level line (distant waterline)."""
    import numpy as np
    W, Hh = size
    P0 = np.array([[p.x, p.y, p.z] for p, _ in points])
    U = np.array([q for _, q in points], dtype=float)
    free_pitch = model_pitch is not None

    def resid(x):
        pr, d, u = proj(x)
        res = list((pr - U).ravel())
        f = x[6]
        r = np.cross(d, u)
        for hx, hy in horizon:
            # image y where a ray of zero elevation crosses column hx
            y = Hh / 2 + f * (d[2] + (hx - W / 2) / f * r[2]) / u[2]
            res.append(w_h * (y - hy))
        if fixed_f:
            res.append(0.2 * (x[6] - fixed_f))
        return np.array(res)

    def proj(x):
        cx, cy, cz, yaw, pit, rol, f = x[:7]
        P = P0
        if free_pitch:
            a = math.radians(-x[7])
            Ry = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
            P = P0 @ Ry.T
        yaw, pit, rol = np.radians([yaw, pit, rol])
        d = np.array([math.cos(pit) * math.cos(yaw), math.cos(pit) * math.sin(yaw), math.sin(pit)])
        r0 = np.cross(d, [0, 0, 1.0])
        r0 /= np.linalg.norm(r0)
        u0 = np.cross(r0, d)
        r = r0 * math.cos(rol) + u0 * math.sin(rol)
        u = -r0 * math.sin(rol) + u0 * math.cos(rol)
        q = P - np.array([cx, cy, cz])
        z = q @ d
        return np.stack([W / 2 + f * (q @ r) / z, Hh / 2 - f * (q @ u) / z], 1), d, u

    x = np.array([loc0[0], loc0[1], loc0[2], yaw0, pitch0, 0.0, f0] + ([model_pitch] if free_pitch else []))
    for it in range(80):
        res = resid(x)
        J = np.zeros((res.size, x.size))
        for j in range(x.size):
            dx = np.zeros_like(x)
            dx[j] = 1e-4 * max(1.0, abs(x[j]))
            J[:, j] = (resid(x + dx) - res) / dx[j]
        step = np.linalg.lstsq(J.T @ J + 1e-3 * np.eye(x.size), -J.T @ res, rcond=None)[0]
        x = x + step
        if np.linalg.norm(step) < 1e-7:
            break
    pr, d, u = proj(x)
    err = np.linalg.norm(pr - U, axis=1)
    print('SOLVE camera loc (%.3f, %.3f, %.3f) yaw %.2f pitch %.2f roll %.2f f %.1f px' % tuple(x[:7]))
    if free_pitch:
        print('SOLVE model pitch %.2f deg' % x[7])
        SOLVED['pitch'] = float(x[7])
    print('SOLVE horizon residuals', resid(x)[2 * len(points):])
    for (p, q), e, pp in zip(points, err, pr):
        print('   (%.2f %.2f %.2f) photo (%.1f, %.1f) model (%.1f, %.1f) err %.1f' % (p.x, p.y, p.z, q[0], q[1],
                                                                                    pp[0], pp[1], e))
    loc = Vector(x[:3])
    return loc, loc + Vector(d) * 10.0, Vector(u), float(x[6])


def render_persp(path, loc, target, f_px, size, up=None, pitch_deg=0.0, rotor_az=None, hide=()):
    scn = bpy.context.scene
    B.setup_render(scn)
    scn.cycles.samples = 24
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = size
    scn.render.resolution_percentage = 100
    cam = bpy.data.cameras.new('PhotoCam')
    co = bpy.data.objects.new('PhotoCam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    co.location = Vector(loc)
    d = (Vector(target) - Vector(loc)).normalized()
    if up is None:
        co.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    else:
        r = d.cross(Vector(up)).normalized()
        u = r.cross(d)
        M = Matrix((r, u, -d)).transposed()
        co.rotation_euler = M.to_euler()
    cam.sensor_fit = 'HORIZONTAL'
    cam.sensor_width = 36.0
    cam.lens = f_px / size[0] * 36.0
    cam.clip_start = 0.05
    cam.clip_end = 300
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
    if rotor_az is not None:
        bpy.data.objects['rotor'].rotation_euler = (0, 0, math.radians(rotor_az))
    for o in bpy.data.objects:
        if any(o.name.startswith(h) for h in hide):
            o.hide_render = True
    if pitch_deg:
        st = bpy.data.objects.new('stand', None)
        scn.collection.objects.link(st)
        for o in list(scn.collection.objects):
            if o.type in ('MESH', 'EMPTY') and o is not st:
                o.parent = st
        st.rotation_euler = (0, math.radians(-pitch_deg), 0)
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered overlay', path)


VIEWS = {
    'three_quarter_front': dict(loc=(9.2, 7.6, 2.4), target=(-0.6, 0.0, 0.2), lens=30, rotor=-20, prop=30),
    'side': dict(loc=(-0.5, 22.0, 0.3), target=(-0.5, 0.0, 0.3), ortho=11.0, rotor=45, prop=90),
    'top': dict(loc=(-0.6, 0.0, 30.0), target=(-0.6, 0.0, 0.0), ortho=16.0, rotor=45, prop=90),
    'rear_three_quarter': dict(loc=(-9.6, -7.6, 2.9), target=(-0.8, 0.0, 0.3), lens=32, rotor=40, prop=20),
    'thumb': dict(extra=True, loc=(6.6, -7.2, 4.4), target=(-0.5, 0.0, -0.2), lens=34, rotor=-25, prop=10),
    'front': dict(extra=True, loc=(16.0, 0.0, 0.3), target=(0.0, 0.0, 0.3), ortho=9.0, rotor=45, prop=90),
    'photo_float': dict(extra=True, loc=(6.5, 14.0, 0.2), target=(-0.4, 0.0, 0.0), lens=55, rotor=-30, prop=30),
    'nose_detail': dict(extra=True, loc=(4.2, 2.3, 0.9), target=(1.3, 0.0, 0.2), lens=40, rotor=75, prop=15),
    'cockpit': dict(extra=True, loc=(0.9, 2.2, 1.9), target=(-0.7, 0.0, 0.4), lens=30, rotor=75, prop=0),
    'tail_detail': dict(extra=True, loc=(-2.4, 3.2, 1.0), target=(-4.0, 0.0, 0.4), lens=38, rotor=75, prop=10),
    'float_detail': dict(extra=True, loc=(4.5, 5.0, -0.6), target=(0.2, 1.0, -1.3), lens=30, rotor=75, prop=10),
    'head_detail': dict(extra=True, loc=(1.6, 2.2, 2.2), target=(-0.25, 0.0, 1.45), lens=45, rotor=75, prop=0),
}

if __name__ == '__main__':
    if LAND:
        # landplane variant only for the overlay on Wilford_XOZ1.jpg: never overwrite the real .blend / GLB
        import tempfile
        K.HERE = tempfile.gettempdir()
        if '--no-export' not in K.ARGV:
            K.ARGV.append('--no-export')
    gz = R.z(FLOAT_DECK - FLOAT_DEPTH)
    K.run('wilford', build_wilford, LIVERY, views=VIEWS, rest_ground=gz)
    sv = K.arg('--solve')
    if sv:
        ff = K.arg('--fixf')
        rz = float(K.arg('--rotaz')) if K.arg('--rotaz') else None
        out = K.arg('--solve-out')
        if sv == 'float':
            pts = float_photo_points()
            loc, tgt, up, f = solve_camera(pts, (662, 279), horizon=FLOAT_HORIZON, fixed_f=float(ff) if ff else None)
            if out:
                render_persp(out, loc, tgt, f, (662, 279), up=up, rotor_az=rz, hide=('pilot_rear',))
        else:
            pts = land_photo_points()
            loc, tgt, up, f = solve_camera(pts, (901, 351), loc0=(-6.0, 9.0, -0.4), yaw0=-60.0, pitch0=3.0,
                                           fixed_f=float(ff) if ff else None, model_pitch=LAND_PITCH)
            if out:
                render_persp(out, loc, tgt, f, (901, 351), up=up, rotor_az=rz, pitch_deg=SOLVED['pitch'],
                             hide=('pilot_rear', 'pilot_front'))
    pv = K.arg('--povl')
    if pv:
        parts = pv.split(',')
        f = [float(v) for v in parts[1:10]]
        render_persp(parts[0], f[0:3], f[3:6], f[6], (int(f[7]), int(f[8])),
                     pitch_deg=float(parts[11]) if len(parts) > 11 else 0.0,
                     rotor_az=float(K.arg('--rotaz')) if K.arg('--rotaz') else None, hide=('pilot_rear',))
