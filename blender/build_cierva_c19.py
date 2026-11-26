"""
Cierva C.19 Mk IV (Avro 620, c/n 5158, built by Avro in 1932) for the Autogiro web sim: the only
C.19 left in the world, EC-AIM of the Museo del Aire (Cuatro Vientos, Madrid). Ex G-ABXH, sold in
December 1932 to Andres Lasso de la Vega (Aero Club de Sevilla, Tablada) as EC-W13 / EC-ATT, impressed
in the Civil War as 30-62, returned as EC-CAB, EC-AIM from 1953 (restored by the Maestranza Aerea de
Sevilla, flown at Geneva in 1955), in the museum since 1961/1968.

Layout of the Mk IV (Flight 20 Nov 1931 p.1148 and 17 Nov 1932; Revista de Aeronautica, May 1932):
  - welded steel-tube fuselage, fabric covered: deep and narrow (0.6 m wide, 1.0 m deep), two open
    cockpits in tandem with dual control; pilot in the REAR seat, passenger in front under the rotor;
  - Armstrong Siddeley Genet Major I five-cylinder radial (100 hp normal, 110 max at 2200 rpm), direct
    drive, cylinders out in the air through a spun nose cowl, black exhaust collector ring behind them,
    two-blade metal propeller;
  - four-tube steel pyramid over the FRONT cockpit, from the shoulders of the fuselage; from its four
    feet four struts brace the wing (NACA AC-120: "two struts above the wing brace the latter to the
    fuselage"); the engine-driven rotor starter (single-plate clutch, 180 rpm in 30 s) runs up the front
    of the pyramid;
  - three-blade CANTILEVER rotor of 34 ft (10.36 m): solid balsa blades with a spruce core on a steel
    tube spar, flapping and drag hinges, droop stops, two blades fold back; resting on the stops the
    blades droop;
  - small wooden wing (span 21 ft, chord 2 ft 9 in) under the rotor with dihedral, upturned tips and two
    ailerons (NOT a tilting head: that came with the Mk V / C.30); the wide split undercarriage hangs
    from the wing spar (oleo legs, 24 cm travel) with radius rods to the bottom longerons;
  - conventional monoplane tail of wood (Mk IV): tailplane with elevators on the upper longerons, a long
    low dorsal fin (later enlarged) and the rudder on the stern post; tail SKID (museum record).
  - EC-AIM livery: silver all over, "EC-AIM" in black on the fuselage sides and on the upper wing
    ("EC-" port, "AIM" starboard), Spanish red-yellow-red bands on the wing tips (upper and lower) and
    on both sides of the rudder.

Traced in the HUB FRAME of gyrokit.py (origin on the rotor hub, X forward, Z up) on the NACA Aircraft
Circular No. 120 general arrangement of the Mk III (Commons, 1920 px: 170.6 px/m from the 35 ft rotor and
the 18 ft 3 in length; fuselage, wing, undercarriage, pylon, engine) with the Mk IV parts (rotor, tail,
skid, pylon head) and every placement checked on the museum photos with solved pinhole cameras
(--solve, see PHOTOS below; Blender's numpy).
CG: no data for the C.19 -> the one Cierva of the period that was measured, the C.30A (ARC R&M 1859): hub
0.13 m behind the CG, CG at the height of the thrust line (4 cm above it on the C.30A). Not the sim's usual
0.33 m: with the head FIXED to the pylon, the rotor thrust 0.33 m behind the CG pitches the nose down so hard
that the elevator cannot slow it below ~70 km/h, and the main wheels (0.56 m ahead of the hub, NACA drawing)
end up only 0.23 m ahead of the CG: it noses over at the first touch of the brakes.

  blender -b -P blender/build_cierva_c19.py -- [--previews] [--only VIEW,...] [--show-rear] [--samples N]
          [--no-export] [--solve PHOTO --solve-out out.png [--fixf F] [--rotaz deg]]
Outputs: public/models/cierva_c19.glb, blender/cierva_c19.blend, blender/previews/cierva_c19/*.png
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, naca4, pilot, controls  # noqa: E402
from build_autogiro import hermite, sgnpow, closed_tube  # noqa: E402
import build_cierva as C  # noqa: E402  (windscreen(), build_wood_prop(), tyre(): reused, not edited)
import build_wilford as W  # noqa: E402  (period_stick(), solve_camera(), render_persp(): reused, not edited)

NAME = 'cierva_c19'

# ---- hub frame (X forward, Z up, origin on the rotor hub; metres) --------------------------------
PPM_3V = 170.6                  # px/m of the NACA AC-120 general arrangement (Commons 1920 px)
THRUST_Z = -1.512               # propeller axis below the hub
PROP_X = 1.823                  # propeller hub ahead of the hub
PROP_R = 0.95                   # two-blade metal propeller (Mk III drawing: 6 ft 3 in)
ENGINE_X = 1.512                # cylinder plane of the Genet Major I
CYL_R = 0.455                   # rocker boxes from the crankshaft axis (5-cyl Genet Major: 0.91 m over the heads)
CG = (0.13, THRUST_Z + 0.01)
R = K.Ref(CG)


def H(X, Z, y=0.0):
    return R(X, Z, y)


# The Mk IV head stands higher on its pyramid than the Mk III's of the drawing (photo solves: +0.13 / +0.14 m;
# published height 10 ft 3 in against 10 ft 0 in): the frame origin stays on the drawing's hub.
HUB_Z = 0.12
HUB = H(0.0, HUB_Z)
PIVOT = H(0.0, HUB_Z - 0.33)    # rotor shaft foot on the pyramid collar (node rotor_head)
ROTOR_R = 5.18                  # 34 ft
BLADE_CHORD = 0.48              # solidity ~0.09 (Mk III blades 89.5 sq ft for four; plan views of EC-AIM)
BLADE_ROOT = 0.62               # end of the root cuff, start of the aerofoil
BLADE_FULL = 1.35               # full chord from here outwards
DROOP = 3.5                     # blades resting on the droop stops (deg)

# wing (Flight 1932: span 21 ft; NACA: chord 2 ft 9 in, 5 deg dihedral, tips turned up)
W_LE = 0.705
W_CHORD = 0.838
W_ZC = -1.845                   # chord line at the root (lower surface on the bottom longerons)
W_Y0 = 0.22                     # root section inside the fuselage
W_Y1 = 0.30                     # dihedral from the fuselage side
W_DIH = math.radians(5.0)
W_BREAK = 2.78                  # start of the upturned tip (|y|)
TIP_LEN = 0.47
TIP_ANG = math.radians(35.0)
W_INC = math.radians(3.0)
AIL = (1.05, W_BREAK - 0.02)    # ailerons (|y|), chord 0.25 m
AIL_S = 0.70
GEAR_Y = 1.18                   # wing-strut / oleo-leg station

# undercarriage (NACA: wheel 0.50 m ahead of the hub, 0.60 m Dunlop low-pressure tyres, track 8 ft 10 in)
# (the owner's photo wants the EC-AIM wheels ~15 % smaller than the 0.60 m of the Mk III drawing and a
# little further forward)
WHEEL_X = 0.56
WHEEL_R = 0.27
WHEEL_W = 0.14
WHEEL_Y = 1.35
AXLE_Z = -2.60
GROUND = AXLE_Z - WHEEL_R

# pyramid feet on the shoulders of the fuselage
PYL_F = (0.43, 0.285)           # X, |y| (photo solves: the feet sit ~0.1 m down the rounded shoulders)
PYL_R = (-0.33, 0.285)
PYL_TOP = HUB_Z - 0.40          # collar under the head
SHOULDER_Z = -1.22

# cockpits (X front, X rear, half width)
CK_F = (0.28, -0.28, 0.255)
CK_R = (-0.58, -1.18, 0.26)
FLOOR_Z = -1.80
PILOT_HIP = (-0.98, -1.43)
PILOT_BACK = 12.0
PASS_HIP = (0.06, -1.43)
PASS_BACK = 8.0

# tail
# The Mk IV fuselage is longer than the Mk III's (which ended in the box deflector tail): Revista de Aeronautica
# 1932 gives 6.71 m overall; the owner's photo solve wants the tail ~0.5 m further back than the Mk III stern post
STERN_X = -3.55
HINGE_X = -3.56                 # rudder hinge on the stern post
RUD_TE = -4.38                  # (owner's photo overlay: the rudder reaches ~0.1 m further aft)
FIN_TOP = -0.80
TP_Z = -1.06                    # tailplane on the upper longerons
TP_HINGE = -3.48
TP_LE_ROOT = TP_HINGE + 0.58
TP_HALF = 1.45
ELEV_CHORD = 0.40
SKID_X = -3.38

LIVERY = dict(body=('#B7BBBE', 0.35, 0.42), accent=('#B5161B', 0.0, 0.40), dark=('#101112', 0.1, 0.5),
              seat=('#5A3522', 0.0, 0.6))


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
def build_extra_materials():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Flag_Yellow', '#F1BF00', rough=0.45)
    mk('Exhaust', '#1E1C1B', metal=0.5, rough=0.5)
    mk('Prop_Metal', '#C9CDD0', metal=1.0, rough=0.22)
    mk('Rocker_Black', '#141414', metal=0.3, rough=0.4)
    mk('Wire', '#7E8286', metal=1.0, rough=0.35)
    mk('Grip_Leather', '#3B2618', rough=0.6)
    C.set_paint('Rotor_Blade', '#B4B8BB', 0.35, 0.42)    # silver-doped blades
    C.set_paint('Interior', '#4E4639', 0.0, 0.8)
    C.set_paint('Panel', '#2A1C12', 0.0, 0.5)            # varnished wooden board
    C.set_paint('Pilot_Suit', '#5A3B26', 0.0, 0.62)       # 1930s crew: leather coats
    C.set_paint('Suit_Dark', '#2A2420', 0.0, 0.8)
    C.set_paint('Glove', '#3A2618', 0.0, 0.55)
    C.set_paint('Harness', '#6B5A44', 0.0, 0.8)


# ---------------------------------------------------------------------------
# Fuselage: stations (X, top, bottom, half-width, z widest, e_top, e_bottom, e_side), hub frame.
# Deep narrow section (rounded decking, flat sides) behind a round nose drum around the engine.
# ---------------------------------------------------------------------------
BODY_TABLE = [
    (1.430, -1.120, -1.890, 0.385, -1.505, 2.0, 2.0, 2.0),
    (1.330, -1.090, -1.915, 0.395, -1.500, 2.0, 2.05, 2.05),
    (1.190, -1.035, -1.925, 0.375, -1.480, 2.1, 2.3, 2.4),
    (0.950, -0.965, -1.925, 0.335, -1.460, 2.1, 2.8, 2.9),
    (0.600, -0.925, -1.925, 0.310, -1.440, 2.0, 3.2, 3.0),
    (0.200, -0.910, -1.930, 0.302, -1.440, 1.9, 3.4, 3.0),
    (-0.400, -0.910, -1.930, 0.300, -1.440, 1.9, 3.4, 3.0),
    (-1.000, -0.935, -1.915, 0.288, -1.440, 2.0, 3.3, 3.1),
    (-1.740, -0.980, -1.890, 0.248, -1.440, 2.2, 3.0, 3.2),
    (-2.490, -1.040, -1.860, 0.180, -1.440, 2.1, 2.7, 2.9),
    (-3.100, -1.090, -1.830, 0.100, -1.450, 2.0, 2.4, 2.6),
    (STERN_X, -1.120, -1.800, 0.030, -1.460, 2.0, 2.2, 2.2),
]


class Hull:
    """Fabric fuselage (stations in the hub frame, evaluated in model coordinates)."""

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
        x -= 0.025 if x > R.x(1.15) else 0.06
    xs.append(R.x(BODY_TABLE[-1][0]))
    rings = [BODY.ring(x) for x in xs]
    rings.append(BODY.ring(R.x(STERN_X - 0.02), scale=0.5))
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    kill = []
    for f in mb.bm.faces:
        c = f.calc_center_median()
        if c.z > R.z(-1.15) and (in_opening(c.x, c.y, CK_F) or in_opening(c.x, c.y, CK_R)):
            kill.append(f)
    bmesh.ops.delete(mb.bm, geom=kill, context='FACES')
    ob = mb.finish(sharp_angle=60)
    E.thicken_shell(ob, 1, thickness=0.012)
    rim = E.opening_rim(ob, 'coaming', r=0.024, mat='Seat', inset=0.004)
    return ob, rim


# ---------------------------------------------------------------------------
# Armstrong Siddeley Genet Major I: five-cylinder radial, one cylinder at the BOTTOM (two in a V on top,
# museum photos), aluminium finned heads with black rocker boxes, spun nose cowl round the crankcase
# ---------------------------------------------------------------------------
def cyl_dir(k):
    a = math.pi + TAU * k / 5
    return V(0, math.sin(a), math.cos(a)), V(0, math.cos(a), -math.sin(a)), a


def cyl_head(k, r=CYL_R):
    d, _, _ = cyl_dir(k)
    return H(ENGINE_X, THRUST_Z) + d * r


def build_engine(c, crank_r=0.17, cyl_len=0.29, bore=0.108):
    mb = MB('engine')
    ax = V(1, 0, 0)
    mb.lathe([(0.0, -0.11), (0.14, -0.11), (0.165, -0.09), (crank_r, -0.065), (crank_r, 0.055), (0.15, 0.09),
              (0.11, 0.13), (0.095, 0.20), (0.085, 0.25), (0.0, 0.25)], c, ax, 'Engine', n=40)
    for k in range(5):
        d, side, a = cyl_dir(k)
        base = c + d * (crank_r - 0.01)
        prof = B.finned_profile(bore * 0.52, bore * 0.52 + 0.022, 0.0, cyl_len * 0.60, pitch=0.012)
        mb.lathe(prof, base, d, 'Engine_Dark', n=18)
        h0 = base + d * cyl_len * 0.58
        prof = B.finned_profile(bore * 0.57, bore * 0.57 + 0.034, 0.0, cyl_len * 0.36, pitch=0.011)
        mb.lathe(prof, h0, d, 'Engine', n=20)
        top = base + d * (CYL_R - crank_r - 0.035)
        # black rocker box cover over the head (the black "hats" of the photos)
        mb.box(top + ax * 0.0, (0.10, 0.10, 0.05), 'Rocker_Black', bevel=0.014, segs=2,
               rot=Matrix.Rotation(-a, 4, 'X'))
        for s in (1, -1):
            p0 = c + ax * 0.07 + d * (crank_r - 0.02) + side * s * 0.03
            p1 = top + ax * 0.03 + side * s * 0.035 - d * 0.03
            mb.cyl(p0, p1, 0.009, 'Metal_Frame', n=8)
        # exhaust stub from the rear of the head into the collector ring
        e0 = h0 + d * 0.05 - ax * 0.05
        e1 = c - ax * 0.15 + d * 0.43
        mb.tube(catmull([e0, e0 - ax * 0.06 + d * 0.02, e1], 4), 0.022, 'Exhaust', n=10, cap=True)
        mb.cyl(h0 + d * 0.05 + ax * 0.05, h0 + d * 0.05 + ax * 0.09, 0.006, 'Paint_Dark', n=6)
    ring = [c + ax * 0.10 + V(0, math.sin(TAU * k / 40), math.cos(TAU * k / 40)) * 0.14 for k in range(40)]
    closed_tube(mb, ring, 0.010, 'Paint_Dark', n=8)
    # black exhaust collector ring round the nose drum, with its tail pipe under the fuselage
    rc = c - ax * 0.15
    ring = [rc + V(0, math.sin(TAU * k / 64), math.cos(TAU * k / 64)) * 0.43 for k in range(64)]
    closed_tube(mb, ring, 0.034, 'Exhaust', n=12)
    p0 = rc + V(0, 0.12, -0.41)
    mb.tube(catmull([p0, p0 + V(-0.10, 0.02, -0.06), p0 + V(-0.45, 0.03, -0.10), p0 + V(-0.75, 0.03, -0.10)], 4),
            0.034, 'Exhaust', n=12, cap=True)
    return mb.finish(sharp_angle=38, wn=True)


def build_nose_cowl():
    """Spun aluminium cowl round the crankcase, opened for the cylinders (the cylinders pass through)."""
    mb = MB('nose_cowl')
    c = H(0.0, THRUST_Z)
    # (photos: the barrels stand out of it, only the crankcase and the cylinder feet are covered)
    prof = [(0.0, PROP_X - 0.10), (0.10, PROP_X - 0.10), (0.14, PROP_X - 0.13), (0.19, PROP_X - 0.19),
            (0.23, PROP_X - 0.25), (0.25, ENGINE_X + 0.03), (0.27, ENGINE_X - 0.04), (0.33, 1.45), (0.36, 1.43)]
    mb.lathe([(r, x - 0.0) for r, x in prof], V(R.x(0.0), 0, c.z), V(1, 0, 0), 'Paint_White', n=48)
    ob = mb.finish(sharp_angle=50)
    return ob


# ---------------------------------------------------------------------------
# Windscreens, pyramid, wing struts, rotor head, rotor
# ---------------------------------------------------------------------------
def build_windscreens():
    out = []
    for name, xb, xt, hw, h in (('ws_front', 0.32, 0.25, 0.19, 0.13), ('ws_rear', -0.53, -0.59, 0.20, 0.115)):
        z0 = BODY.top_z(R.x(xb), 0.0) - 0.012
        out.append(C.windscreen(name, R.x(xb), R.x(xt), z0, z0 + h, hw, bow=0.05))
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


FEET = {}


def build_pylon():
    """Four streamlined steel legs from a collar under the head to fittings on the shoulders of the
    fuselage (front pair ahead of the front cockpit, rear pair behind it); the starter shaft runs up
    in front."""
    mb = MB('pylon')
    sq = (0.07, 0.03, 2.2)
    for sy in (1, -1):
        for key, (fx, fy), top_dx in (('F', PYL_F, 0.06), ('R', PYL_R, -0.06)):
            top = H(top_dx, PYL_TOP, sy * 0.06)
            # fitting on the side of the fuselage, on the upper longeron (photo solves: the rear pair ~0.3 m
            # under the top of the decking, the front pair higher, where the decking is lower)
            zf = R.z(SHOULDER_Z if key == 'R' else SHOULDER_Z + 0.12)
            hw = BODY.half_width(R.x(fx), zf)
            foot = V(R.x(fx), sy * (hw + 0.02), zf)
            d = (foot - top).normalized()
            mb.tube([top, foot + d * 0.02], 0.0, 'Paint_White', n=14, square=sq, cap=True)
            # fitting plate on the side
            Rm = controls.basis(V(1, 0, 0), V(0, 0, -sy), V(0, sy, 0))
            mb.box(V(foot.x, sy * (hw + 0.004), zf), (0.14, 0.09, 0.012), 'Metal_Frame', bevel=0.004, segs=1, rot=Rm)
            FEET[(key, sy)] = foot
    # collar and gussets under the head
    mb.lathe([(0.0, -0.07), (0.10, -0.07), (0.115, -0.05), (0.115, 0.05), (0.08, 0.075), (0.0, 0.075)],
             H(0.0, PYL_TOP), V(0, 0, 1), 'Engine_Dark', n=24)
    # rotor-starter drive: shaft from the engine (behind the top cylinders) up the front of the pyramid
    s0 = H(0.80, BODY.top_z(R.x(0.80), 0.0) - R.dz + 0.01)
    s1 = H(0.12, HUB_Z - 0.40)
    mb.cyl(s0, s1, 0.016, 'Engine_Dark', n=10)
    mb.box(s0 + V(0, 0, 0.02), (0.10, 0.08, 0.06), 'Engine', bevel=0.01, segs=1)
    mb.box(s0 + (s1 - s0) * 0.55, (0.05, 0.05, 0.08), 'Engine_Dark', bevel=0.008, segs=1)   # universal joint
    return mb.finish(sharp_angle=50, wn=True)


def build_wing_struts():
    """From each pyramid foot a streamlined strut down to the wing spar at the undercarriage station."""
    mb = MB('wing_struts')
    sq = (0.065, 0.028, 2.2)
    for sy in (1, -1):
        for key, xw in (('F', W_LE - 0.22), ('R', W_LE - 0.60)):
            top = FEET[(key, sy)] + V(0, sy * 0.02, -0.03)
            bot = H(xw, wing_upper_z(xw, GEAR_Y), sy * GEAR_Y)
            d = (bot - top).normalized()
            mb.tube([top - d * 0.02, bot + d * 0.012], 0.0, 'Paint_White', n=14, square=sq, cap=True)
            mb.box(bot + V(0, 0, 0.012), (0.09, 0.06, 0.024), 'Metal_Frame', bevel=0.005, segs=1)
    return mb.finish(sharp_angle=50, wn=True)


def build_head():
    """Fixed rotor head (node rotor_head, origin on the shaft foot): bearing housing on the collar, the
    starter bevel box in front, the rotor brake drum under the hub."""
    mb = MB('rotor_head')
    p = PIVOT
    top = HUB.z - 0.12
    mb.lathe([(0.0, 0.0), (0.085, 0.0), (0.095, 0.025), (0.095, 0.11), (0.07, 0.15), (0.06, 0.15),
              (0.055, top - p.z), (0.0, top - p.z)], p, V(0, 0, 1), 'Engine_Dark', n=28)
    mb.box(p + V(0.11, 0, 0.10), (0.12, 0.10, 0.10), 'Engine', bevel=0.012, segs=1)          # bevel box
    mb.cyl(p + V(0.11, 0, 0.04), p + V(0.17, 0, -0.06), 0.022, 'Engine_Dark', n=10)
    mb.lathe([(0.0, 0.0), (0.15, 0.0), (0.15, 0.045), (0.0, 0.045)], HUB + V(0, 0, -0.11), V(0, 0, 1),
             'Engine_Dark', n=32)                                                                # brake drum
    return mb.finish(origin=p, sharp_angle=40, wn=True)


def blade(mb, hub, R_, chord, root, droop_deg=DROOP, tc=0.12):
    """Cantilever blade: steel spar out of the hinges, thick root cuff fairing into the aerofoil, full
    chord from BLADE_FULL, rounded tip; resting on the droop stop (droop_deg down)."""
    loop = airfoil_ring(14, tc, m=0.01, te_min=0.003)
    pitch = Matrix.Rotation(math.radians(2.0), 3, 'X')
    cone = Matrix.Rotation(math.radians(droop_deg), 3, 'Y')

    def section(r, c, th=1.0, sag=0.0):
        out = []
        for s, tz in loop:
            p = pitch @ Vector((0.0, (0.25 - s) * c, tz * c * th))
            out.append(hub + cone @ Vector((r, p.y, p.z - sag)))
        return out

    def sag(r):
        # small extra bending of the cantilever blade towards the tip
        return 0.06 * max(0.0, (r - 1.0) / (R_ - 1.0)) ** 2

    rs = [root, root + 0.10, 0.85, 1.10, BLADE_FULL, 1.8, 2.5, 3.2, 3.9, R_ - 0.45, R_ - 0.25]
    rings = []
    for r in rs:
        u = min(1.0, max(0.0, (r - root) / (BLADE_FULL - root)))
        k = lerp(0.38, 1.0, u * u * (3 - 2 * u))
        th = lerp(1.9, 1.0, min(1.0, (r - root) / 0.6))
        rings.append(section(r, chord * k, th, sag(r)))
    mb.loft(rings, 'Rotor_Blade', closed=True, cap0=True)
    tip = []
    for k in range(9):
        u = k / 8.0
        r = R_ - 0.25 + 0.25 * math.sin(0.5 * math.pi * u)
        if k == 8:
            tip.append([section(r, 0.03, 0.6, sag(r))[0]])
            continue
        f = math.cos(0.5 * math.pi * u) ** 0.5
        tip.append(section(r, max(chord * f, 0.03), 1.0 - 0.3 * u, sag(r)))
    mb.loft(tip, 'Rotor_Blade', closed=True)
    # spar shank from the drag hinge into the cuff, clamp bands
    mb.cyl(hub + cone @ V(0.34, 0, 0), hub + cone @ V(root + 0.08, 0, 0), 0.026, 'Metal_Frame', n=14)
    for x in (root - 0.02, root + 0.12):
        mb.cyl(hub + cone @ V(x, 0, 0), hub + cone @ V(x + 0.025, 0, 0), 0.036, 'Engine_Dark', n=14)


def build_rotor():
    mb = MB('rotor')
    blade(mb, HUB, ROTOR_R, BLADE_CHORD, BLADE_ROOT)
    bm = mb.bm
    one = list(bm.verts)
    for k in range(1, 3):
        ret = bmesh.ops.duplicate(bm, geom=one + list({e for v in one for e in v.link_edges}) +
                                  list({f for v in one for f in v.link_faces}))
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=HUB, matrix=Matrix.Rotation(TAU * k / 3, 3, 'Z'))
    # hub forging with three arms: flapping hinge (tangential pin), droop stop under it, drag hinge
    # (vertical pin) with its friction damper, folding joint
    mb.lathe([(0.0, -0.09), (0.10, -0.09), (0.12, -0.06), (0.12, 0.045), (0.09, 0.07), (0.0, 0.075)],
             HUB, V(0, 0, 1), 'Engine', n=36)
    for k in range(3):
        a = TAU * k / 3
        d = V(math.cos(a), math.sin(a), 0)
        t = V(-math.sin(a), math.cos(a), 0)
        rot = Matrix.Rotation(a, 4, 'Z')
        mb.box(HUB + d * 0.16, (0.11, 0.09, 0.065), 'Engine', bevel=0.012, segs=2, rot=rot)
        mb.cyl(HUB + d * 0.19 - t * 0.07, HUB + d * 0.19 + t * 0.07, 0.015, 'Metal_Frame', n=10)
        mb.box(HUB + d * 0.17 + V(0, 0, -0.07), (0.07, 0.05, 0.05), 'Engine_Dark', bevel=0.008, segs=1, rot=rot)
        mb.box(HUB + d * 0.26, (0.07, 0.065, 0.09), 'Engine_Dark', bevel=0.01, segs=1, rot=rot)
        mb.cyl(HUB + d * 0.26 + V(0, 0, -0.065), HUB + d * 0.26 + V(0, 0, 0.065), 0.013, 'Metal_Frame', n=10)
        mb.cyl(HUB + d * 0.22 + t * 0.055, HUB + d * 0.33 + t * 0.045, 0.016, 'Engine', n=10)
    mb.lathe([(0.0, 0.075), (0.055, 0.075), (0.045, 0.11), (0.0, 0.12)], HUB, V(0, 0, 1), 'Engine', n=24)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Wing: low wing under the rotor, 5 deg dihedral from the fuselage side, tips turned up 35 deg,
# rounded ends, ailerons (nodes aileron_L / aileron_R, hinge on the 70 % line)
# ---------------------------------------------------------------------------
def w_zc(ay):
    return W_ZC + max(0.0, min(ay, W_BREAK) - W_Y1) * math.tan(W_DIH)


def wing_section(y, s0=0.0, s1=1.0, n=16, tc=0.12, chord_k=1.0):
    ay = abs(y)
    c = W_CHORD * chord_k
    le = W_LE - 0.5 * (W_CHORD - c)
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
    c = W_CHORD
    s = min(1.0, max(0.0, (W_LE - X) / c))
    yc, yt = naca4(s, 0.12, 0.03)
    return w_zc(ay) + (yc + yt) * c - s * c * math.sin(W_INC)


def wing_lower_z(X, ay):
    c = W_CHORD
    s = min(1.0, max(0.0, (W_LE - X) / c))
    yc, yt = naca4(s, 0.12, 0.03)
    return w_zc(ay) + (yc - yt) * c - s * c * math.sin(W_INC)


def tip_point(sy, u, s, tz):
    """Point of the upturned tip: u along the tip panel (0 at the break), chord station s."""
    c = W_CHORD
    if u > TIP_LEN - 0.20:
        k = (u - (TIP_LEN - 0.20)) / 0.20
        c = W_CHORD * max(0.06, math.sqrt(max(0.0, 1 - k * k)))
    le = W_LE - 0.5 * (W_CHORD - c)
    base = H(0.0, w_zc(W_BREAK), sy * W_BREAK)
    dirn = V(0, sy * math.cos(TIP_ANG), math.sin(TIP_ANG))
    nrm = V(0, -sy * math.sin(TIP_ANG), math.cos(TIP_ANG))
    return V(R.x(le - s * c), 0, 0) + V(0, base.y, base.z) + dirn * u + nrm * (tz * c) + V(0, 0, -s * c * math.sin(W_INC))


def build_wing():
    mb = MB('wing')
    for sy in (1, -1):
        ys_in = [W_Y0, W_Y1, 0.6, 0.9, AIL[0]]
        mb.loft([wing_section(sy * y) for y in ys_in], 'Paint_White', closed=True, cap0=True)
        ys_out = [AIL[0], 1.5, 2.0, 2.4, AIL[1]]
        mb.loft([wing_section(sy * y, 0.0, AIL_S - 0.004) for y in ys_out], 'Paint_White', closed=True, cap0=True,
                cap1=True)
        # short fixed bit between the aileron end and the break, then the upturned tip
        mb.loft([wing_section(sy * y) for y in (AIL[1], W_BREAK)], 'Paint_White', closed=True, cap0=True)
        loop = airfoil_ring(16, 0.12, m=0.03, te_min=0.0025)
        rings = []
        us = [0.0, 0.08, 0.18, 0.27, TIP_LEN - 0.14, TIP_LEN - 0.08, TIP_LEN - 0.035, TIP_LEN - 0.01]
        for u in us:
            rings.append([tip_point(sy, u, s, tz) for s, tz in loop])
        last = rings[-1]
        cen = sum(last, Vector()) / len(last)
        rings.append([cen + (p - cen) * 0.25 for p in last])
        mb.loft(rings, 'Paint_White', closed=True, cap1=True)
        # aileron hinge brackets underneath
        for y in (1.3, 2.4):
            xh = W_LE - AIL_S * W_CHORD
            mb.box(H(xh, wing_lower_z(xh, y) - 0.012, sy * y), (0.07, 0.012, 0.03), 'Metal_Frame', bevel=0.003, segs=1)
    ob = mb.finish(sharp_angle=40)

    def tipband(p):
        # Spanish bands on the upturned tips, upper and lower surfaces: red at the end, yellow, red at the fold
        if abs(p.y) < W_BREAK - 0.004:
            return None
        sy = 1 if p.y > 0 else -1
        base = H(0.0, w_zc(W_BREAK), sy * W_BREAK)
        u = (p.y - base.y) * sy * math.cos(TIP_ANG) + (p.z - base.z) * math.sin(TIP_ANG)
        return 'Paint_Accent' if (u < 0.14 or u > TIP_LEN - 0.15) else 'Flag_Yellow'
    paint_flags(ob, tipband)
    for sy, name in ((1, 'aileron_L'), (-1, 'aileron_R')):
        am = MB(name)
        ys = [AIL[0] + 0.012, 1.5, 2.0, 2.4, AIL[1] - 0.012]
        am.loft([wing_section(sy * y, AIL_S + 0.006, 1.0, n=8) for y in ys], 'Paint_White', closed=True, cap0=True,
                cap1=True)
        xh = W_LE - AIL_S * W_CHORD
        o = H(xh, w_zc(AIL[0]), sy * AIL[0])
        am.finish(origin=o, sharp_angle=40)
    return ob


# ---------------------------------------------------------------------------
# Undercarriage: oleo leg from the wing spar to the stub axle, front and rear radius rods to the
# bottom longerons; Dunlop wheels (nodes wheel_L / wheel_R)
# ---------------------------------------------------------------------------
def build_gear():
    mb = MB('main_gear')
    for sy in (1, -1):
        top = H(WHEEL_X, wing_lower_z(WHEEL_X, GEAR_Y) + 0.01, sy * GEAR_Y)
        axle_in = H(WHEEL_X, AXLE_Z, sy * (WHEEL_Y - 0.11))
        mid = top + (axle_in - top) * 0.50
        mb.cyl(top + (axle_in - top) * -0.02, mid, 0.045, 'Paint_White', n=16)
        mb.cyl(mid - (axle_in - top) * 0.03, axle_in, 0.030, 'Metal_Frame', n=14)
        mb.cyl(mid - (axle_in - top) * 0.06, mid + (axle_in - top) * 0.03, 0.050, 'Rubber', n=16)
        mb.box(top + V(0, 0, 0.01), (0.10, 0.07, 0.03), 'Metal_Frame', bevel=0.006, segs=1)
        for xf in (0.72, -0.33):
            p = H(xf, -1.925, sy * 0.25)
            mb.tube([axle_in + V(0, 0, 0.02), p], 0.0, 'Paint_White', n=12, square=(0.055, 0.028, 2.2), cap=True)
            mb.box(p + V(0, 0, 0.01), (0.07, 0.05, 0.03), 'Metal_Frame', bevel=0.005, segs=1)
        mb.box(axle_in, (0.09, 0.06, 0.09), 'Metal_Frame', bevel=0.01, segs=1)
        mb.cyl(axle_in, H(WHEEL_X, AXLE_Z, sy * (WHEEL_Y + 0.09)), 0.02, 'Metal_Frame', n=10)
    gear = mb.finish(sharp_angle=40, wn=True)
    for name, sy in (('wheel_L', 1), ('wheel_R', -1)):
        wb = MB(name)
        c = H(WHEEL_X, AXLE_Z, sy * WHEEL_Y)
        C.tyre(wb, c, WHEEL_R, WHEEL_W, 0.16, hub_mat='Metal_Frame')
        wb.finish(origin=c, sharp_angle=40)
    return gear


# ---------------------------------------------------------------------------
# Tail: long low dorsal fin, rudder on the stern post (node rudder), tailplane on the upper longerons
# with elevators (node elevator), tail skid
# ---------------------------------------------------------------------------
# (owner's photo overlay: the top of the fin is level at the height of the rudder top, not rising to it)
FIN_PROFILE = [(-1.68, -0.93), (-1.85, -0.865), (-2.05, -0.815), (-2.40, -0.795), (-2.90, -0.788), (HINGE_X, -0.785)]
RUDDER_OUT = [(HINGE_X, -0.78), (-3.84, -0.76), (-4.10, -0.79), (-4.26, -0.86), (-4.35, -0.97), (-4.38, -1.12),
              (-4.37, -1.40), (-4.31, -1.58), (-4.19, -1.72), (-3.99, -1.82), (-3.77, -1.86), (HINGE_X, -1.86)]


def interp_pts(pts, x):
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if min(x0, x1) <= x <= max(x0, x1) and x0 != x1:
            return lerp(z0, z1, (x - x0) / (x1 - x0))
    return pts[-1][1] if x < pts[-1][0] else pts[0][1]


def build_fin():
    """Dorsal fin: lens sections from the decking up to the fin profile, blending into the decking."""
    mb = MB('fin')
    x0 = FIN_PROFILE[0][0]
    xs = [x0 - 0.06 * k for k in range(60)]
    xs = [x for x in xs if x > STERN_X + 0.01] + [STERN_X + 0.005]
    rings = []
    for X in xs:
        top = interp_pts(FIN_PROFILE, X)
        base = BODY.top_z(R.x(X), 0.0) - R.dz - 0.04
        # (thicker at the front, where it fairs into the decking)
        t = 0.035 + 0.03 * max(0.0, (X - (x0 - 0.20)) / 0.20)
        if top - base < 0.01:
            continue
        ring = []
        for k in range(14):
            a = TAU * k / 14
            s = 0.5 - 0.5 * math.cos(a)
            z = lerp(base, top, s)
            y = t * math.sin(a) * (1 - 0.6 * abs(math.cos(a)) ** 6)
            ring.append(H(X, z, y))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # stern post cap
    mb.box(H(STERN_X - 0.01, -1.40), (0.04, 0.05, 0.62), 'Paint_White', bevel=0.015, segs=2)
    return mb.finish(sharp_angle=45)


def rud_le(z):
    return R.x(HINGE_X + 0.02)


def rud_te(z):
    Zh = z - R.dz
    pts = RUDDER_OUT
    xs = []
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if (z0 - Zh) * (z1 - Zh) <= 0 and z0 != z1:
            xs.append(lerp(x0, x1, (Zh - z0) / (z1 - z0)))
    return R.x(min(xs) if xs else HINGE_X - 0.05)


def build_rudder():
    zs = [R.z(z) for z in (-1.855, -1.82, -1.74, -1.62, -1.45, -1.25, -1.05, -0.92, -0.86, -0.81, -0.785)]
    origin = H(HINGE_X, -1.40)
    rud = E.build_rudder_surface('rudder', zs, lambda z: R.x(HINGE_X + 0.10), rud_te, R.x(HINGE_X), origin,
                                 t=0.08, mat='Paint_White')
    # Spanish flag on both sides: red / yellow (double) / red, horizontal bands
    z0, z1 = -0.76, -1.86
    h = z0 - z1

    def band(p):
        Zh = p.z - R.dz
        if Zh > z0 - 0.25 * h or Zh < z1 + 0.25 * h:
            return 'Paint_Accent'
        return 'Flag_Yellow'
    paint_flags(rud, band)
    # white tail light on the rudder trailing edge (period practice, as on the Wilford): moves with the rudder
    det = MB('rudder_det')
    tl = H(RUD_TE + 0.004, -1.12)
    K.lamp(det, tl, V(-1, 0, 0), kind='white', r=0.018, length=0.03, base='Metal_Frame')
    d_ob = det.finish(sharp_angle=50)
    bpy.context.view_layer.update()
    B.join_objects('rudder', [rud, d_ob])      # (join keeps world positions and the rudder's hinge origin)
    rud = bpy.data.objects['rudder']
    K.lamp_node('tail', H(RUD_TE - 0.05, -1.12))
    return rud


def tp_le(ay):
    """Tailplane leading edge X at |y|: straight then a big round end."""
    y0 = TP_HALF - 0.55
    if ay <= y0:
        return lerp(TP_LE_ROOT, TP_LE_ROOT - 0.06, ay / y0)
    t = min(1.0, (ay - y0) / 0.55)
    return TP_LE_ROOT - 0.06 - (TP_LE_ROOT - 0.06 - TP_HINGE) * (1 - math.sqrt(max(0.0, 1 - t * t)))


def elev_te(ay):
    y0 = TP_HALF - 0.45
    if ay <= y0:
        return TP_HINGE - ELEV_CHORD
    t = min(1.0, (ay - y0) / 0.45)
    return TP_HINGE - ELEV_CHORD * math.sqrt(max(0.0, 1 - t * t))


def build_tailplane():
    mb = MB('tailplane')
    loop = airfoil_ring(12, 0.08, te_min=0.002)
    for sy in (1, -1):
        rings = []
        for ay in (0.05, 0.15, 0.40, 0.65, 0.85, 1.0, 1.15, 1.27, 1.36, TP_HALF - 0.04):
            le = tp_le(ay)
            c = max(le - TP_HINGE, 0.02)
            rings.append([H(le - s * c, TP_Z + tz * max(c, 0.3), sy * ay) for s, tz in loop])
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        # bracing struts from the tailplane underside to the bottom longeron
        mb.tube([H(-3.30, TP_Z - 0.02, sy * 0.75), H(-3.19, -1.78, sy * 0.07)], 0.0, 'Paint_White', n=10,
                square=(0.035, 0.016, 2.2), cap=True)
    tp = mb.finish(sharp_angle=45)
    em = MB('elevator')
    for sy in (1, -1):
        rings = []
        for ay in (0.10, 0.3, 0.6, 0.9, 1.1, 1.25, 1.34, 1.40, TP_HALF - 0.02):
            c = max(TP_HINGE - elev_te(ay), 0.02)
            th = 0.022
            ring = []
            for k in range(10):
                s = k / 9.0
                ring.append(H(TP_HINGE - 0.008 - s * c, TP_Z + th * (1 - s) + 0.002, sy * ay))
            for k in range(9, -1, -1):
                s = k / 9.0
                ring.append(H(TP_HINGE - 0.008 - s * c, TP_Z - th * (1 - s) - 0.002, sy * ay))
            rings.append(ring)
        em.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    em.cyl(H(TP_HINGE - 0.01, TP_Z, 0.12), H(TP_HINGE - 0.01, TP_Z, -0.12), 0.012, 'Metal_Frame', n=10)
    em.finish(origin=H(TP_HINGE, TP_Z), sharp_angle=45)
    return tp


def skid_contact():
    """Tail skid shoe (hub frame): the point that rests on the ground."""
    return (SKID_X - 0.07, -2.00)


def build_skid():
    mb = MB('skid')
    sx, sz = skid_contact()
    top = H(SKID_X + 0.10, BODY.zb(R.x(SKID_X + 0.10)) - R.dz + 0.01)
    shoe = H(sx, sz + 0.02)
    mb.tube(catmull([top, H(SKID_X + 0.02, sz + 0.10), shoe, H(sx - 0.10, sz + 0.05)], 4), 0.0, 'Paint_Dark', n=10,
            square=(0.03, 0.05, 2.4), cap=True)
    # rubber-cord spring to the stern post
    mb.cyl(H(SKID_X + 0.02, sz + 0.10), H(SKID_X - 0.10, BODY.zb(R.x(SKID_X - 0.10)) - R.dz + 0.01), 0.012, 'Paint_Dark',
           n=8)
    return mb.finish(sharp_angle=40)


# ---------------------------------------------------------------------------
# Cockpits, crew, controls
# ---------------------------------------------------------------------------
def period_seat(mb, hip, back_deg, width=0.40):
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    seat_top = hip.z - 0.085
    tilt = Euler((0, math.radians(-6), 0))
    c = V(hip.x + 0.10, 0, seat_top - 0.035)
    mb.box(c, (0.40, width, 0.07), 'Seat', bevel=0.025, segs=2, rot=tilt)
    mb.box(c - V(0, 0, 0.045), (0.42, width + 0.02, 0.02), 'Metal_Frame', bevel=0.006, segs=1, rot=tilt)
    back_c = hip - f * 0.165 + u * 0.36
    rb = Euler((0, -b, 0))
    mb.box(back_c, (0.06, width, 0.44), 'Seat', bevel=0.025, segs=2, rot=rb)
    mb.box(back_c - f * 0.04, (0.02, width + 0.02, 0.46), 'Metal_Frame', bevel=0.006, segs=1, rot=rb)
    for sx in (-0.08, 0.26):
        for sy in (1, -1):
            mb.cyl(V(hip.x + sx, sy * (width / 2 - 0.03), seat_top - 0.09),
                   V(hip.x + sx, sy * (width / 2 - 0.03), R.z(FLOOR_Z)), 0.012, 'Metal_Frame', n=8)


def build_cockpits():
    mb = MB('cockpit')
    xs_f = [lerp(CK_R[1] - 0.08, 0.95, k / 16) for k in range(17)]
    coords = []
    for X in xs_f:
        w = BODY.half_width(R.x(X), R.z(FLOOR_Z)) - 0.014
        coords += [H(X, FLOOR_Z, -w), H(X, FLOOR_Z, w)]
    mb.faces(coords, [[2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1] for k in range(16)], 'Interior')
    for Xb in (CK_R[1] - 0.08, 0.95):
        xb = R.x(Xb)
        c = V(xb, 0, BODY.zw(xb))
        ring = [c + (p - c) * 0.975 for p in BODY.ring(xb, 48)]
        idx = list(range(len(ring)))
        mb.faces(ring, [idx[::-1] if Xb < 0 else idx], 'Interior', smooth=False)
    period_seat(mb, H(*PILOT_HIP), PILOT_BACK, width=0.40)
    period_seat(mb, H(*PASS_HIP), PASS_BACK, width=0.40)
    # pilot's wooden board under the rear windscreen, drawn live by the sim (src/aircraft/VintagePanel.ts)
    E.panel(mb, H(-0.545, -1.075), 0.44, 0.17, 12, glare=False, live=('vintage_board', [
        {'k': 'asi', 'u': -0.153, 'v': 0.022, 'd': 0.074},
        {'k': 'alt', 'u': -0.051, 'v': 0.022, 'd': 0.074},
        {'k': 'rotor', 'u': 0.051, 'v': 0.022, 'd': 0.074},
        {'k': 'engine', 'u': 0.153, 'v': 0.022, 'd': 0.074},
        {'k': 'oilp', 'u': -0.10, 'v': -0.046, 'd': 0.042},
        {'k': 'level', 'u': 0.0, 'v': -0.046, 'w': 0.09, 'h': 0.02},
        {'k': 'oilt', 'u': 0.10, 'v': -0.046, 'd': 0.042},
    ]))
    # passenger's board (dual control: air speed, altimeter, engine revolutions)
    E.panel(mb, H(0.30, -1.07), 0.34, 0.13, 12, glare=False, live=('vintage_board_front', [
        {'k': 'asi', 'u': -0.09, 'v': 0.0, 'd': 0.068},
        {'k': 'alt', 'u': 0.0, 'v': 0.0, 'd': 0.068},
        {'k': 'engine', 'u': 0.09, 'v': 0.0, 'd': 0.068},
    ]))
    # rotor-starter clutch (red) and wheel-brake levers on the right wall (nodes, pivot at their foot)
    for name, x, col in (('starter_lever', -0.80, 'Paint_Accent'), ('brake_lever', -0.88, 'Paint_Dark')):
        p0 = H(x, -1.55, -0.25)
        mb.box(p0 + V(0, -0.014, 0), (0.05, 0.012, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
        lv = MB(name)
        lv.cyl(p0 + V(0, -0.010, 0), p0 + V(0, 0.012, 0), 0.012, 'Metal_Frame', n=12)
        lv.cyl(p0, p0 + V(0.05, 0.03, 0.24), 0.007, 'Metal_Frame', n=8)
        lv.sphere(p0 + V(0.05, 0.03, 0.25), 0.018, col, seg=10, rings=6)
        lv.finish(origin=p0, sharp_angle=40)
    # fuel filler cap on the decking ahead of the front windscreen
    zt = BODY.top_z(R.x(0.75), 0.0)
    mb.cyl(V(R.x(0.75), 0, zt - 0.01), V(R.x(0.75), 0, zt + 0.018), 0.045, 'Metal_Frame', n=20)
    # foot steps (dark kick-in steps under the cockpits, the black half-discs of the photos)
    return mb.finish(sharp_angle=40, wn=True)


RUDDER_BAR = (-0.30, -1.66)


def build_crew():
    ctrl = MB('controls_static')
    stick, grip, axis = W.period_stick(H(-0.48, FLOOR_Z), H(-0.53, -1.26))
    knob, lever = controls.throttle_lever(ctrl, H(-0.70, -1.17, 0.235), length=0.10, brake=False)
    hip = H(*PILOT_HIP)
    fb = H(*RUDDER_BAR)
    pilot.build_pilot('pilot_front', hip, PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': fb + V(-0.02, 0.17, 0.06), 'R': fb + V(-0.02, -0.17, 0.06)},
                      helmet='leather', knee_out=0.03, elbow_out=0.0, rig=True)
    K.print_joints('pilot_front', R)
    # rudder bar on a vertical pin (node foot_bar), as on the C.30A
    ctrl.cyl(fb + V(0, 0, -0.012), V(fb.x, 0, R.z(FLOOR_Z)), 0.016, 'Metal_Frame', n=12)
    ctrl.box(V(fb.x, 0, R.z(FLOOR_Z) + 0.006), (0.10, 0.08, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    fbm = MB('foot_bar')
    fbm.cyl(fb + V(0, 0.23, 0), fb + V(0, -0.23, 0), 0.014, 'Metal_Frame', n=10)
    fbm.cyl(fb + V(0, 0, -0.016), fb + V(0, 0, 0.018), 0.022, 'Metal_Frame', n=14)
    for sy in (1, -1):
        fbm.box(fb + V(-0.02, sy * 0.17, 0.04), (0.03, 0.10, 0.10), 'Metal_Frame', bevel=0.006, segs=1)
    fbm.finish(origin=fb, sharp_angle=40)
    # passenger's (dual control) stick, static, between his knees
    s2, _, _ = W.period_stick(H(0.42, FLOOR_Z), H(0.38, -1.36))
    s2.name = 'stick_front_tmp'
    ph = H(*PASS_HIP)
    pilot.build_pilot('pilot_rear', ph, PASS_BACK,
                      hands={'R': ('rest', ph + V(0.22, -0.13, 0.18), None),
                             'L': ('rest', ph + V(0.22, 0.13, 0.18), None)},
                      feet={'L': H(0.80, FLOOR_Z + 0.10, 0.15), 'R': H(0.80, FLOOR_Z + 0.10, -0.15)},
                      helmet='leather', knee_out=0.03, elbow_out=0.04)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = hip + u * (pilot.SPINE + 0.13) + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    E.make_eye(eye)
    return ctrl.finish(sharp_angle=40), s2, eye, head


# ---------------------------------------------------------------------------
# Markings and lights
# ---------------------------------------------------------------------------
def text_mesh(text, size, sx=1.0):
    """Triangulated, subdivided outline of a text in its own plane: list of (bmesh, None)."""
    cu = bpy.data.curves.new('reg_txt', 'FONT')
    cu.body = text
    cu.size = size
    cu.align_x = 'CENTER'
    cu.align_y = 'CENTER'
    try:
        cu.fill_mode = 'BOTH'
    except Exception:
        pass
    tob = bpy.data.objects.new('reg_tmp', cu)
    bpy.context.scene.collection.objects.link(tob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
    bpy.data.objects.remove(tob)
    bpy.data.curves.remove(cu)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for v in bm.verts:
        v.co.x *= sx
    return bm


def project_text(name, target, text, size, place, ray, sx=1.0, mat='Paint_Dark', lift=0.004):
    """Text projected onto `target`: place(tx, ty) -> ray origin (model), ray = direction."""
    bm = text_mesh(text, size, sx)
    ray = Vector(ray).normalized()
    miss = 0
    for v in bm.verts:
        o = place(v.co.x, v.co.y)
        hit, loc, nrm, _ = target.ray_cast(o, ray)
        miss += not hit
        v.co = loc + nrm.normalized() * lift if hit else o + ray * 1.0
    if miss:
        print('  !! %s: %d of %d text vertices missed the surface' % (name, miss, len(bm.verts)))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.dot(ray) > 0:
            f.normal_flip()
        f.smooth = False
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(MATS[mat])
    ob = bpy.data.objects.new(name, me)
    B.link(ob)
    return ob


def build_markings(fus, wing, rud):
    """EC-AIM in black: big condensed letters low on both fuselage sides (from under the front cockpit
    to the tailplane, photos), and on the upper wing read from behind, "EC-" on the port wing and "AIM"
    on the starboard wing (museum hangar plan, owner's photo)."""
    obs = []
    try:
        cx, cz = R.x(-1.47), R.z(-1.47)
        for sy in (1, -1):
            obs.append(project_text('reg_side_' + str(sy), fus, 'EC-AIM', 0.86,
                                    lambda tx, ty, sy=sy: V(cx - sy * tx, sy * 1.0, cz + ty), (0, -sy, 0), sx=0.86))
        # (ahead of the aileron hinge: the letters stay on the fixed wing)
        xm = R.x(W_LE - 0.36 * W_CHORD)
        for text, yc in (('EC-', 1.72), ('AIM', -1.72)):
            obs.append(project_text('reg_wing_' + text, wing, text, 0.56,
                                    lambda tx, ty, yc=yc: V(xm + ty, yc - tx, 2.0), (0, 0, -1), sx=0.9))
    except Exception as ex:
        print('  !! letters skipped:', ex)
    return obs


def paint_flags(ob, band_of):
    """Spanish red-yellow-red bands: band_of(face centre) -> 'Paint_Accent' / 'Flag_Yellow' / None."""
    me = ob.data
    idx = {}
    for name in ('Paint_Accent', 'Flag_Yellow'):
        if name not in [m.name for m in me.materials]:
            me.materials.append(MATS[name])
        idx[name] = [m.name for m in me.materials].index(name)
    white = [m.name for m in me.materials].index('Paint_White') if 'Paint_White' in [m.name for m in me.materials] else -1
    for p in me.polygons:
        if p.material_index != white:
            continue
        b = band_of(ob.location + p.center)
        if b:
            p.material_index = idx[b]


def build_lights():
    """1930s practice as on the Wilford: wing-tip navigation lights (red left, green right) and a white
    tail light on the rudder (build_rudder). MINIMUM SET, NOT ON THE PHOTOS (every aircraft of the sim carries them):
    a landing lamp let into the left wing leading edge and a red beacon on the fin."""
    mb = MB('lights')
    for sy in (1, -1):
        p = tip_point(sy, TIP_LEN - 0.04, 0.45, 0.0)
        K.lamp(mb, p, V(0.4, sy * 0.6, 0.7).normalized(), kind='red' if sy > 0 else 'green', r=0.02, length=0.03)
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0.4, sy * 0.6, 0.7).normalized() * 0.05)
    # MINIMUM SET, NOT ON THE PHOTOS: landing lamp in the left wing leading edge outboard of the strut
    ay = 1.85
    lp = H(W_LE - 0.01, w_zc(ay) + 0.01, ay)
    mb.lathe([(0.0, -0.01), (0.07, -0.01), (0.07, 0.012), (0.0, 0.012)], lp, V(1, 0, 0), 'Metal_Frame', n=24)
    mb.lathe([(0.0, 0.012), (0.063, 0.012), (0.056, 0.024), (0.0, 0.030)], lp, V(1, 0, 0), 'Lens_White', n=24)
    K.lamp_node('landing', lp + V(0.07, 0, 0))
    # MINIMUM SET, NOT ON THE PHOTOS: red beacon on the fin top
    bp = H(-3.00, interp_pts(FIN_PROFILE, -3.00) - 0.004)
    K.lamp(mb, bp, V(0, 0, 1), kind='red', r=0.022, length=0.04, base='Paint_White')
    K.lamp_node('beacon', bp + V(0, 0, 0.065), 'red')
    return mb.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
GEOM = {}


def build_c19():
    build_extra_materials()
    fus, rim = build_fuselage()
    ws = build_windscreens()
    engine = build_engine(H(ENGINE_X, THRUST_Z))
    cowl = build_nose_cowl()
    C.build_wood_prop(H(PROP_X, THRUST_Z), PROP_R, pitch_ratio=0.62, spin=-1, body_mat='Prop_Metal',
                      tip_mat='Prop_Metal')
    pylon = build_pylon()
    build_head()
    build_rotor()
    wing = build_wing()
    struts = build_wing_struts()
    gear = build_gear()
    fin = build_fin()
    rud = build_rudder()
    tp = build_tailplane()
    skid = build_skid()
    cockpit = build_cockpits()
    ctrl, s2, eye, head = build_crew()
    marks = build_markings(fus, wing, rud)
    lights = build_lights()
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [cockpit, ctrl], ' (pilot legs)')
    K.clearance(['pilot_rear'], [fus, cockpit, pylon], ' (passenger)')
    K.clearance(['pilot_front'], [fus], ' (pilot)')
    K.finalize([fus, rim, engine, cowl, pylon, wing, struts, gear, fin, tp, skid, cockpit, ctrl, s2, lights]
               + [g[1] for g in ws] + marks, [g[0] for g in ws])
    GEOM.update(eye=eye, head=head)
    req = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': H(PROP_X, THRUST_Z), 'rudder': H(HINGE_X, -1.40),
        'stick': H(-0.48, FLOOR_Z), 'eye_front': eye, 'pilot_rear': None, 'foot_bar': H(*RUDDER_BAR),
        'wheel_L': H(WHEEL_X, AXLE_Z, WHEEL_Y), 'wheel_R': H(WHEEL_X, AXLE_Z, -WHEEL_Y),
        'starter_lever': None, 'brake_lever': None, 'elevator': None, 'aileron_L': None, 'aileron_R': None,
    }
    B.REQUIRED = {k: (None if p is None else (round(p.x, 4), round(p.z, 4), round(-p.y, 4))) for k, p in req.items()}
    B.REQUIRED.update({k: None for k in ('pilot_front', 'throttle')})
    B.REQUIRED.update(controls.rig_nodes('pilot_front'))
    report()


def report():
    """Numbers for airframes.ts (model coordinates as model-geom prints them: x fwd, y up, z right)."""
    def m(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('C19 CG model (0.08, 0.10); hub %s pivot %s prop %s D %.2f' % (m(HUB), m(PIVOT), m(H(PROP_X, THRUST_Z)),
                                                                     2 * PROP_R))
    print('C19 wheels %s / %s R %.2f ground y %.3f' % (m(H(WHEEL_X, AXLE_Z, WHEEL_Y)), m(H(WHEEL_X, AXLE_Z, -WHEEL_Y)),
                                                      WHEEL_R, R.z(GROUND)))
    sx, sz = skid_contact()
    print('C19 skid contact %s' % m(H(sx, sz)))
    print('C19 eye %s head %s' % (m(GEOM['eye']), m(GEOM['head'])))

    def grid_area(inside, x0, x1, y0, y1, d=0.01):
        n, sx_, sy_ = 0, 0.0, 0.0
        x = x0
        while x < x1:
            y = y0
            while y < y1:
                if inside(x, y):
                    n += 1
                    sx_ += x
                    sy_ += y
                y += d
            x += d
        return n * d * d, (sx_ / max(n, 1), sy_ / max(n, 1))

    def tp_in(X, y, elev):
        ay = abs(y)
        if ay > TP_HALF:
            return False
        if elev:
            return elev_te(ay) <= X < TP_HINGE and ay >= 0.10
        return TP_HINGE <= X <= tp_le(ay) and ay > 0.03
    for nm, el in (('tailplane', False), ('elevator', True)):
        a, (cx_, cy_) = grid_area(lambda X, y: tp_in(X, y, el), -4.2, -2.6, -1.5, 1.5)
        print('C19 %s area %.2f m2 (both halves), centre x %.3f y %.3f' % (nm, a, R.x(cx_), R.z(TP_Z)))

    def fin_in(X, Z):
        if X < STERN_X or X > FIN_PROFILE[0][0]:
            return False
        return BODY.top_z(R.x(X), 0.0) - R.dz < Z < interp_pts(FIN_PROFILE, X)

    from panel import inside as pin
    a, (cx_, cz_) = grid_area(fin_in, -3.6, -1.6, -1.2, -0.7)
    print('C19 fin area %.2f m2 (above the decking), centre x %.3f y %.3f' % (a, R.x(cx_), R.z(cz_)))
    a, (cx_, cz_) = grid_area(lambda X, Z: pin(RUDDER_OUT, X, Z), -4.3, -3.5, -1.9, -0.7)
    print('C19 rudder area %.2f m2, centre x %.3f y %.3f' % (a, R.x(cx_), R.z(cz_)))
    print('C19 wing: root chord line z %.3f, quarter chord x %.3f; span %.2f; tip fold at %.2f' % (
        R.z(W_ZC), R.x(W_LE - 0.25 * W_CHORD), 2 * (W_BREAK + TIP_LEN * math.cos(TIP_ANG)), W_BREAK))
    pts = {'cyl_head_bot': cyl_head(0), 'cyl_head_top_L': cyl_head(3), 'cyl_head_top_R': cyl_head(2),
           'cyl_head_L': cyl_head(4), 'cyl_head_R': cyl_head(1), 'rotor_cap': HUB + V(0, 0, 0.12),
           'pylon_collar': H(0.0, PYL_TOP), 'wing_tip_L': tip_point(1, TIP_LEN - 0.01, 0.3, 0.0),
           'wing_tip_R': tip_point(-1, TIP_LEN - 0.01, 0.3, 0.0), 'fold_L': H(0.4, w_zc(W_BREAK), W_BREAK),
           'fold_R': H(0.4, w_zc(W_BREAK), -W_BREAK), 'tp_tip_L': H(TP_HINGE, TP_Z, TP_HALF),
           'tp_tip_R': H(TP_HINGE, TP_Z, -TP_HALF), 'fin_top': H(-3.0, -0.80), 'rudder_te': H(RUD_TE, -1.12),
           'rudder_bottom': H(-3.80, -1.86), 'prop_tip_low': H(PROP_X, THRUST_Z - PROP_R),
           'belly_wing': H(0.3, -1.93), 'belly_tail': H(-2.5, -1.86), 'exhaust_low': H(1.37, THRUST_Z - 0.43)}
    for k, p in pts.items():
        print('C19 point %-16s %s' % (k, m(p)))


VIEWS = {
    'three_quarter_front': dict(loc=(8.6, 7.2, 2.0), target=(-0.6, 0.0, 0.0), lens=30, rotor=-20, prop=30),
    'side': dict(loc=(-0.6, 22.0, -0.2), target=(-0.6, 0.0, -0.2), ortho=11.4, rotor=0, prop=90),
    'top': dict(loc=(-0.6, 0.0, 30.0), target=(-0.6, 0.0, 0.0), ortho=11.4, rotor=45, prop=90),
    'rear_three_quarter': dict(loc=(-9.2, -7.4, 2.4), target=(-0.8, 0.0, -0.1), lens=32, rotor=40, prop=20),
    'thumb': dict(extra=True, loc=(6.4, -6.8, 3.6), target=(-0.5, 0.0, -0.4), lens=34, rotor=-25, prop=10),
    'front': dict(extra=True, loc=(16.0, 0.0, -0.2), target=(0.0, 0.0, -0.2), ortho=11.0, rotor=45, prop=90),
    'nose_detail': dict(extra=True, loc=(4.0, 2.4, 0.4), target=(1.2, 0.0, -0.2), lens=40, rotor=75, prop=15),
    'cockpit': dict(extra=True, loc=(0.6, 2.2, 1.4), target=(-0.8, 0.0, -0.1), lens=30, rotor=75, prop=0),
    'tail_detail': dict(extra=True, loc=(-2.2, 3.3, 0.6), target=(-3.0, 0.0, -0.3), lens=38, rotor=75, prop=10),
    'head_detail': dict(extra=True, loc=(1.6, 2.0, 2.0), target=(-0.2, 0.0, 1.30), lens=45, rotor=75, prop=0),
    # the pilot's view ahead from eye_front (rear cockpit): open air and the small windscreen
    'pilot_eye': dict(extra=True, loc=(-1.05, 0.0, 0.87), target=(8.0, 0.0, 0.35), lens=22, rotor=60, prop=30),
}

# ---------------------------------------------------------------------------
# Photo overlays: pinhole camera solved from model points <-> photo pixels (build_wilford.solve_camera)
# ---------------------------------------------------------------------------
REST_PITCH = math.degrees(math.atan2(-2.00 - GROUND, WHEEL_X - (SKID_X - 0.07)))   # three-point attitude (~13.3 deg)


def photo_points(name):
    """Features read on 3-4x gridded zooms of each photo: (model point, (px, py))."""
    if name == 'own':
        # the owner's photo (user_photo_c19_ECAIM.png = h4-3p.jpg, 800x600, 3/4 rear left, raised); features
        # read on h4-3g.jpg (the same shot at 1.6x, cropped 244 px from the top): u = (xg/1.6, yg/1.6 + 152.5)
        g = lambda x, y: (x / 1.6, y / 1.6 + 152.5)
        a = math.radians(REST_PITCH)
        contact = V(math.sin(a), 0, -math.cos(a)) * WHEEL_R     # tyre point under the axle when parked
        return [
            (HUB, g(467.0, 104.0)),
            (H(PROP_X, THRUST_Z), g(200.0, 345.0)),
            (H(WHEEL_X, AXLE_Z, WHEEL_Y), (107.0, 515.0)),
            (H(WHEEL_X, AXLE_Z, -WHEEL_Y), (281.0, 470.0)),
            (H(WHEEL_X, AXLE_Z, WHEEL_Y) + contact, (110.0, 547.0)),
            (H(WHEEL_X, AXLE_Z, -WHEEL_Y) + contact, (283.0, 488.0)),
            (FEET[('R', 1)], (299.0, 368.0)),
            (H(W_LE - 0.22, wing_upper_z(W_LE - 0.22, GEAR_Y), GEAR_Y), g(265.0, 445.0)),
            (H(W_LE - 0.60, wing_upper_z(W_LE - 0.60, GEAR_Y), GEAR_Y), g(305.0, 458.0)),
            (H(CK_R[0], BODY.top_z(R.x(CK_R[0]), 0.0) - R.dz), (340.0, 343.0)),
            (H(CK_R[1], BODY.top_z(R.x(CK_R[1]), 0.0) - R.dz), (398.0, 343.0)),
            (H(HINGE_X, -0.82), (670.0, 400.0)),
        ]
    if name == 'm2012':
        # Commons Autogiro_Cierva_C.19.jpg (Agustin Ruzafa, 2012; 1920 px thumb of 3888): Canon EOS-1D Mk III,
        # 20 mm on a 28.1 mm sensor -> f = 1366 px. 3/4 front left, camera low, close.
        a = math.radians(REST_PITCH)
        top = V(-math.sin(a), 0, math.cos(a)) * WHEEL_R
        return [
            (HUB, (960.0, 145.0)),
            (H(PROP_X, THRUST_Z), (250.0, 655.0)),
            (H(WHEEL_X, AXLE_Z, -WHEEL_Y), (432.0, 1058.0)),
            (H(WHEEL_X, AXLE_Z, WHEEL_Y) + top, (1292.0, 1192.0)),
            (H(WHEEL_X, wing_lower_z(WHEEL_X, GEAR_Y), GEAR_Y), (1243.0, 930.0)),
            (H(W_LE - 0.22, wing_upper_z(W_LE - 0.22, GEAR_Y), GEAR_Y), (1222.0, 862.0)),
            (H(W_LE - 0.60, wing_upper_z(W_LE - 0.60, GEAR_Y), GEAR_Y), (1285.0, 860.0)),
            (FEET[('F', 1)], (955.0, 555.0)),
            (cyl_head(3), (530.0, 450.0)),
            (cyl_head(2), (410.0, 445.0)),
        ]
    raise ValueError(name)


PHOTO_SIZE = {'own': (800, 600), 'm2012': (1920, 1280)}

if __name__ == '__main__':
    sv = K.arg('--solve')
    if sv and '--no-export' not in K.ARGV:
        K.ARGV.append('--no-export')
    def build():
        build_c19()
        if '--hide-pilot' in K.ARGV:          # (for the pilot_eye view: the camera sits in his head)
            for o in bpy.data.objects:
                if o.name.startswith('pilot_front'):
                    o.hide_render = True
    K.run(NAME, build, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
    if sv and K.arg('--dump'):
        # hand the correspondences to an external multi-start solver (scratch camsolve.py)
        pts = photo_points(sv)
        with open(K.arg('--dump'), 'w') as fh:
            json.dump({'P': [[p.x, p.y, p.z] for p, _ in pts], 'U': [list(q) for _, q in pts],
                       'size': list(PHOTO_SIZE[sv]), 'pitch': float(K.arg('--pitch', str(REST_PITCH))),
                       'free_pitch': '--fix-pitch' not in K.ARGV,
                       'fixf': float(K.arg('--fixf')) if K.arg('--fixf') else None}, fh)
        print('dumped', K.arg('--dump'))
        sv = None
    if sv and K.arg('--cam'):
        # render from a solved camera: cx,cy,cz,yaw,pitch,roll,f[,model pitch]
        x = [float(v) for v in K.arg('--cam').split(',')]
        yaw, pit, rol = (math.radians(v) for v in x[3:6])
        d = Vector((math.cos(pit) * math.cos(yaw), math.cos(pit) * math.sin(yaw), math.sin(pit)))
        r0 = d.cross(Vector((0, 0, 1))).normalized()
        u0 = r0.cross(d)
        up = -r0 * math.sin(rol) + u0 * math.cos(rol)
        loc = Vector(x[0:3])
        mp = x[7] if len(x) > 7 else float(K.arg('--pitch', str(REST_PITCH)))
        W.render_persp(K.arg('--solve-out'), loc, loc + d * 10.0, x[6], PHOTO_SIZE[sv], up=up, pitch_deg=mp,
                       rotor_az=float(K.arg('--rotaz')) if K.arg('--rotaz') else None,
                       hide=tuple(K.arg('--hide', 'pilot_rear,pilot_front').split(',')))
        sv = None
    if sv:
        ff = K.arg('--fixf')
        rz = float(K.arg('--rotaz')) if K.arg('--rotaz') else None
        out = K.arg('--solve-out')
        pts = photo_points(sv)
        size = PHOTO_SIZE[sv]
        kw = dict(loc0=tuple(float(v) for v in K.arg('--loc0', '-6,8,2').split(',')),
                  yaw0=float(K.arg('--yaw0', '-50')), pitch0=float(K.arg('--pitch0', '-8')),
                  f0=float(K.arg('--f0', '1200')), fixed_f=float(ff) if ff else None)
        pitch = float(K.arg('--pitch', str(REST_PITCH)))
        if '--fix-pitch' in K.ARGV:
            # rotate the model points nose-up by the parked attitude and solve the camera only
            a = math.radians(pitch)
            rot = Matrix(((math.cos(a), 0, -math.sin(a)), (0, 1, 0), (math.sin(a), 0, math.cos(a))))   # nose (+X) up
            pts = [(rot @ p, q) for p, q in pts]
            print('NOTE: model pitch held at', pitch)
        else:
            kw['model_pitch'] = pitch
        loc, tgt, up, f = W.solve_camera(pts, size, **kw)
        if '--fix-pitch' not in K.ARGV:
            pitch = W.SOLVED.get('pitch', pitch)
        if out:
            W.render_persp(out, loc, tgt, f, size, up=up, pitch_deg=pitch, rotor_az=rz, hide=('pilot_rear', 'pilot_front'))
