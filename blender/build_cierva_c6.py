"""
Cierva C.6bis (1925) autogiro of Juan de la Cierva for the Autogiro web sim, with the colours of the
replica in the Museo del Aire (Cuatro Vientos, Madrid; built for Expo 92 and donated by the Region of
Murcia; "C6.B." on the rudder).

Layout (Flight 22 Oct 1925 pp. 682-686, the museum's sheet and its hangar-4 plan, photos of the replica):
  - fuselage of an Avro 504K (fabric-covered wooden box, orange on the replica) with the front metal
    panels, the decking up to the cockpit and the horseshoe cowl painted black; ONE open cockpit, just
    behind the rotor mast (the front cockpit is faired over);
  - Le Rhone 9J nine-cylinder ROTARY engine (110 hp): the cylinders turn with the propeller, so they
    are part of the `prop` node (materials Rotary_*: the sim keeps them visible when the propeller is
    drawn as a blurred disc); two-blade wooden tractor propeller;
  - four-blade rotor (36 ft, flapping hinges) on a vertical tube mast braced by four struts; a short
    king post above the hub carries the cords that keep the blades from drooping; no pre-rotator: the
    ground crew spun the rotor with a rope wound under the blades;
  - controlled like an aeroplane: two all-moving ailerons on outrigger spars low on the fuselage,
    the bigger tailplane of the C.6bis with horn-balanced elevators, and the 504K comma rudder;
  - 504K undercarriage: two wheels on a split axle, rubber-cord shock boxes, the long central skid
    with its up-turned toe, and the 504K tail skid.

Tracing (prop frame first: X forward from the propeller plane, Z up from the thrust line, metres):
  - side view: Avro 504 general-arrangement drawing (Wikimedia Commons "Avro 504K 3-view line drawing",
    1918 rigging notes), 75.1 px/m from the published 29 ft 5 in length (propeller 9 ft and 700 mm
    tyres then match);
  - top view: plan of hangar 4 of the Museo del Aire (piece 01, the replica), 81.9 px/m from the same
    length; it gives the 36 ft rotor of Flight, the hub 2.32 m behind the propeller, the aileron panels,
    the C.6bis tailplane and the black/orange split;
  - hub height (1.75 m above the thrust line) from the Flight side photo (p. 685) and the replica
    photos; mast, struts, head, gear and cowl from the replica photos (Commons "Cierva C.6, Madrid").
Overlays: --ovl side|top OUT.png renders an orthographic view at the scale of the drawing / plan.
CG: no data -> the sim convention (hub 0.33 m behind the CG), 0.10 m under the thrust line.

  blender -b -P blender/build_cierva_c6.py -- [--previews] [--only VIEW,...] [--samples N] [--no-export]
          [--ovl side|top --ovl-out OUT.png]
Outputs: public/models/cierva_c6.glb, blender/cierva_c6.blend, blender/previews/cierva_c6/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, naca4, pilot, controls  # noqa: E402
from build_autogiro import hermite, sgnpow, closed_tube  # noqa: E402
import build_cierva as C  # noqa: E402  (build_wood_prop(): reused, not edited)

NAME = 'cierva_c6'

# ---- prop frame -> hub frame -> model ------------------------------------------------------------
HUB_P = (-2.32, 1.75)              # rotor hub (plan: 2.32 m behind the propeller; photos: 1.75 m up)
CG_P = (HUB_P[0] + 0.33, -0.10)    # sim convention: hub 0.33 m behind the CG
CG = (CG_P[0] - HUB_P[0], CG_P[1] - HUB_P[1])
R = K.Ref(CG)


def P(X, Z, y=0.0):
    """Prop-frame point -> model coordinates."""
    return R(X - HUB_P[0], Z - HUB_P[1], y)


def px(X):
    return R.x(X - HUB_P[0])


def pz(Z):
    return R.z(Z - HUB_P[1])


def ux(x):
    """model x -> prop frame X"""
    return x - R.dx + HUB_P[0]


def uz(z):
    return z - R.dz + HUB_P[1]


HUB = P(*HUB_P)
PIVOT = P(HUB_P[0], HUB_P[1] - 0.15)          # rotor head pivot: top of the mast
PROP = P(0.0, 0.0)
PROP_R = 1.37                                  # 504K: 9 ft, pitch 8 ft 8 in (the plan of the replica draws ~2.4 m)
ROTOR_R, CHORD = 5.49, 0.61                    # 36 ft (Flight); chord from the plan of the replica
ENGINE_X = -0.33                               # Le Rhone cylinder plane

# main gear (504K drawing): wheels 700 x 75, track 1.28 m
WHEEL_X, WHEEL_Z, WHEEL_Y, WHEEL_R, WHEEL_W = -1.54, -1.41, 0.64, 0.35, 0.10
GROUND_Z = WHEEL_Z - WHEEL_R                  # level attitude
SKID_TOE, SKID_END, SKID_Z = 0.53, -3.07, -1.505   # central skid: toe, rear end, underside
TAIL_SKID = (-8.27, -0.62)                     # tail-skid shoe (contact)
HINGE_X = -8.14                                # rudder post

# cockpit (plan: dark opening between x 430 and 490 px)
CK = (-2.62, -3.55, 0.27)                      # front X, rear X, half width
PILOT_HIP = (-3.20, 0.08)
PILOT_BACK = 12.0
FLOOR_Z = -0.50
FOOT_BAR_P = (-2.47, -0.30)

# outriggers and aileron panels (plan)
SPAR_X, SPAR_Z = -1.92, -0.50
AIL_LE, AIL_TE, AIL_Y0, AIL_Y1 = -1.76, -2.54, 1.75, 3.89

# tailplane (plan, C.6bis): fixed part + horn-balanced elevators
TP_LE, TP_HINGE, TP_TE = -7.08, -7.97, -8.64
TP_HALF, EL_HALF, HORN_LE = 1.40, 2.01, -7.51
TP_Z = 0.15

LIVERY = dict(body=('#D48A48', 0.0, 0.5), accent=('#C8141B', 0.0, 0.35), dark=('#101113', 0.25, 0.35),
              seat=('#3B2618', 0.0, 0.6))

ARGV = K.ARGV


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
def build_extra_materials():
    def mk(name, hexc, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)
    mk('Fabric_Orange', '#D48A48', rough=0.55)          # doped fabric of the replica (no lacquer)
    mk('Wood_Skid', '#D9A35A', rough=0.4)               # varnished ash skids
    mk('Prop_Wood', '#D7862E', rough=0.28)              # laminated propeller, orange varnish
    mk('Hub_Orange', '#D08C4C', rough=0.45)             # painted wheel covers
    mk('Hub_Olive', '#6C6A46', metal=0.5, rough=0.45)   # rotor hub fittings (olive drab)
    mk('Strut_Black', '#141517', metal=0.3, rough=0.4)
    mk('Wire', '#7E8286', metal=1.0, rough=0.35)
    mk('Rudder_Yellow', '#F1BF00', rough=0.4)
    mk('Grip_Leather', '#3B2618', rough=0.6)
    mk('Rotary_Steel', '#8E9296', metal=0.9, rough=0.38)   # cylinders (turn with the propeller)
    mk('Rotary_Dark', '#3A3936', metal=0.6, rough=0.5)
    mk('Rotary_Copper', '#B06A3A', metal=1.0, rough=0.35)  # Le Rhone induction pipes
    C.set_paint('Rotor_Blade', '#B9BDBF', 0.2, 0.45)       # aluminium-doped fabric blades
    C.set_paint('Interior', '#5A4C3A', 0.0, 0.8)
    C.set_paint('Panel', '#2A1C12', 0.0, 0.5)              # varnished wooden board
    C.set_paint('Pilot_Suit', '#5A3B26', 0.0, 0.62)
    C.set_paint('Suit_Dark', '#2A2420', 0.0, 0.8)
    C.set_paint('Glove', '#3A2618', 0.0, 0.55)
    C.set_paint('Harness', '#6B5A44', 0.0, 0.8)


# ---------------------------------------------------------------------------
# Fuselage: stations (X, top, bottom, half-width, z widest, e_top, e_bottom, e_side) in the prop frame.
# Round behind the cowl, a black metal front with a rounded decking, then the 504K box (flat sides and
# bottom, slightly domed decking) tapering to a vertical rudder post.
# ---------------------------------------------------------------------------
BODY_TABLE = [
    (-0.66, 0.535, -0.535, 0.535, 0.00, 2.0, 2.0, 2.0),
    (-0.80, 0.545, -0.545, 0.540, 0.00, 2.05, 2.2, 2.1),
    (-1.05, 0.555, -0.565, 0.540, -0.01, 2.15, 2.8, 2.5),
    (-1.40, 0.560, -0.580, 0.530, -0.02, 2.25, 3.6, 3.1),
    (-1.90, 0.560, -0.590, 0.505, -0.03, 2.35, 4.2, 3.7),
    (-2.50, 0.545, -0.600, 0.475, -0.04, 2.45, 4.6, 4.2),
    (-3.10, 0.515, -0.600, 0.455, -0.05, 2.6, 4.8, 4.6),
    (-3.60, 0.465, -0.590, 0.435, -0.06, 2.9, 5.0, 5.0),
    (-4.30, 0.410, -0.555, 0.385, -0.07, 3.3, 5.0, 5.0),
    (-5.20, 0.330, -0.500, 0.315, -0.08, 3.4, 5.0, 5.0),
    (-6.00, 0.260, -0.450, 0.255, -0.09, 3.4, 5.0, 5.0),
    (-7.00, 0.160, -0.380, 0.170, -0.10, 3.4, 5.0, 5.0),
    (-7.70, 0.120, -0.330, 0.095, -0.10, 3.0, 4.5, 4.0),
    (-8.15, 0.100, -0.300, 0.020, -0.10, 2.5, 3.0, 3.0),
]


class Hull:
    def __init__(self, table):
        cols = list(zip(*table))
        self.xs = [px(x) for x in cols[0]]
        f = lambda i, conv: hermite(self.xs, [conv(v) for v in cols[i]])
        self.zt, self.zb, self.zw = f(1, pz), f(2, pz), f(4, pz)
        self.hw = f(3, lambda v: v)
        self.et, self.eb, self.es = f(5, lambda v: v), f(6, lambda v: v), f(7, lambda v: v)

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


def bt(X, y=0.0):
    """Decking height (model z) at prop-frame X."""
    return BODY.top_z(px(X), y)


def bb(X):
    return BODY.zb(px(X))


def side_y(X, Z):
    return BODY.half_width(px(X), pz(Z))


def in_cockpit(x, y, r=0.12):
    xf, xr, hw = px(CK[0]), px(CK[1]), CK[2]
    if not (xr <= x <= xf):
        return False
    dx = max(0.0, max(xr + r - x, x - (xf - r)))
    dy = max(0.0, abs(y) - (hw - r))
    return dx * dx + dy * dy <= r * r


def build_fuselage():
    mb = MB('fuselage')
    xs, X = [], BODY_TABLE[0][0]
    while X > BODY_TABLE[-1][0] + 1e-6:
        xs.append(px(X))
        X -= 0.04 if X > -1.4 else 0.08
    xs.append(px(BODY_TABLE[-1][0]))
    rings = [BODY.ring(x) for x in xs]
    mb.loft(rings, 'Fabric_Orange', closed=True, cap0=True, cap1=True)
    kill = []
    for f in mb.bm.faces:
        c = f.calc_center_median()
        if c.z > pz(0.25) and in_cockpit(c.x, c.y):
            kill.append(f)
    bmesh.ops.delete(mb.bm, geom=kill, context='FACES')
    ob = mb.finish(sharp_angle=60)
    # black metal front (all round ahead of X -1.80: replica photos) and black decking back to the cockpit
    shoulder = lambda X: uz(bt(X, 0.0)) - 0.16
    poly = [(px(-1.80), pz(-1.0)), (px(-1.80), pz(shoulder(-1.80))), (px(-2.2), pz(shoulder(-2.2))),
            (px(-3.0), pz(shoulder(-3.0))), (px(-3.50), pz(shoulder(-3.50))), (px(-3.50), pz(1.2)), (px(0.5), pz(1.2)),
            (px(0.5), pz(-1.0))]
    K.paint_poly(ob, poly, 'Paint_Dark')
    E.thicken_shell(ob, len(ob.data.materials), thickness=0.012)
    rim = E.opening_rim(ob, 'coaming', r=0.024, mat='Seat', inset=0.004)
    return ob


# ---------------------------------------------------------------------------
# Horseshoe cowl (open underneath) + fixed engine mount
# ---------------------------------------------------------------------------
def build_cowl():
    mb = MB('cowl')
    prof = [(-0.68, 0.537), (-0.50, 0.540), (-0.32, 0.538), (-0.20, 0.530), (-0.135, 0.515), (-0.10, 0.493),
            (-0.085, 0.468), (-0.082, 0.445), (-0.088, 0.425), (-0.10, 0.415)]
    gap = math.radians(34)                         # half-angle of the opening under the engine
    n = 46
    rings = []
    for X, r in prof:
        ring = []
        for k in range(n + 1):
            a = -math.pi + gap + (TAU - 2 * gap) * k / n      # angle from the top; the gap is underneath
            ring.append(P(X, r * math.cos(a), r * math.sin(a)))
        rings.append(ring)
    mb.loft(rings, 'Paint_Dark', closed=False)
    ob = mb.finish(sharp_angle=50)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.006
    sol.offset = -1
    K.apply_mods(ob)
    # fixed crankshaft carrier: spider on the firewall
    sp = MB('engine_mount')
    sp.lathe([(0.0, -0.66), (0.20, -0.66), (0.20, -0.655), (0.0, -0.655)], P(0, 0), V(1, 0, 0), 'Engine_Dark', n=32)
    for k in range(6):
        a = TAU * (k + 0.5) / 6
        d = V(0, math.sin(a), math.cos(a))
        sp.cyl(P(-0.65, 0) + d * 0.19, P(-0.50, 0) + d * 0.07, 0.016, 'Strut_Black', n=8)
    sp.cyl(P(-0.66, 0), P(-0.44, 0), 0.05, 'Engine', n=16)
    # oil tank cap and fuel filler on the decking ahead of the mast
    zt = bt(-1.15)
    sp.cyl(V(px(-1.15), 0.12, zt - 0.01), V(px(-1.15), 0.12, zt + 0.02), 0.045, 'Metal_Frame', n=20)
    return ob, sp.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Le Rhone 9J rotary: joined into the `prop` node (it turns with the propeller)
# ---------------------------------------------------------------------------
def build_rotary():
    mb = MB('rotary')
    c = P(ENGINE_X, 0.0)
    ax = V(1, 0, 0)
    # crankcase drum, front cam box and nose to the propeller boss
    mb.lathe([(0.0, -0.10), (0.13, -0.10), (0.15, -0.085), (0.155, -0.06), (0.155, 0.06), (0.145, 0.08),
              (0.12, 0.10), (0.11, 0.14), (0.09, 0.17), (0.075, 0.25), (0.06, 0.30), (0.0, 0.30)],
             c, ax, 'Rotary_Steel', n=36)
    mb.lathe([(0.0, -0.17), (0.08, -0.17), (0.11, -0.14), (0.13, -0.10), (0.0, -0.10)], c, ax, 'Rotary_Dark', n=30)
    for k in range(9):
        a = TAU * k / 9
        d = V(0, math.sin(a), math.cos(a))
        side = V(0, math.cos(a), -math.sin(a))
        base = c + d * 0.145
        prof = B.finned_profile(0.060, 0.086, 0.0, 0.25, pitch=0.012)
        mb.lathe(prof, base, d, 'Rotary_Steel', n=16)
        head = base + d * 0.25
        prof = B.finned_profile(0.064, 0.080, 0.0, 0.065, pitch=0.011)
        mb.lathe(prof, head, d, 'Rotary_Dark', n=16)
        mb.lathe([(0.0, 0.065), (0.06, 0.065), (0.045, 0.085), (0.0, 0.09)], head, d, 'Rotary_Dark', n=14)
        # rocker on the head and the single push-pull rod from the front cam box
        rk = head + d * 0.08 + ax * 0.03
        mb.box(rk, (0.10, 0.03, 0.03), 'Rotary_Steel', bevel=0.006, segs=1, rot=Matrix.Rotation(-a, 4, 'X'))
        mb.cyl(c + ax * 0.13 + d * 0.11, rk + ax * 0.045 - d * 0.01, 0.008, 'Rotary_Steel', n=8)
        # copper induction pipe from the back of the crankcase to the rear of the head
        p0 = c - ax * 0.09 + d * 0.11
        p1 = c - ax * 0.12 + d * 0.22 + side * 0.012
        p2 = head - ax * 0.07 + d * 0.02
        mb.tube(catmull([p0, p1, p2], 5), 0.017, 'Rotary_Copper', n=10, cap=True)
        # spark plug lead
        mb.cyl(head + d * 0.03 + ax * 0.075, head + d * 0.06 + ax * 0.10, 0.005, 'Rotary_Dark', n=6)
    return mb.finish(sharp_angle=38, wn=True)


def build_prop():
    pr = C.build_wood_prop(PROP, PROP_R, pitch_ratio=0.62, spin=1, body_mat='Prop_Wood', tip_mat='Prop_Wood')
    eng = build_rotary()
    eng.location = Vector(eng.location)
    return B.join_objects('prop', [pr, eng])


# ---------------------------------------------------------------------------
# Pylon: vertical tube mast and four struts; rotor head; rotor with the king post and its cords
# ---------------------------------------------------------------------------
def body_entry(p, d, step=0.002):
    s = 0.0
    while s < 3.0:
        q = p + d * s
        if abs(q.y) < BODY.hw(q.x) and q.z <= BODY.top_z(q.x, q.y):
            return q
        s += step
    raise ValueError('strut misses the fuselage')


def body_normal(x, y, e=0.004):
    gx = (BODY.top_z(x + e, y) - BODY.top_z(x - e, y)) / (2 * e)
    gy = (BODY.top_z(x, y + e) - BODY.top_z(x, y - e)) / (2 * e)
    return V(-gx, -gy, 1.0).normalized()


def shoe(mb, hit, d, r):
    mb.cyl(hit - d * 0.06, hit + d * 0.01, r * 1.6, 'Strut_Black', n=12)
    n = body_normal(hit.x, hit.y)
    ax = (V(1, 0, 0) - n * n.x).normalized()
    Rm = controls.basis(ax, n.cross(ax), n)
    mb.box(hit - n * 0.002, (0.10, 0.07, 0.012), 'Metal_Frame', bevel=0.004, segs=1, rot=Rm)


COLLAR_Z = HUB_P[1] - 0.24
MAST_FEET = [(-1.02, 0.44), (-2.66, 0.31)]     # (X, |y|) of the strut feet: shoulders ahead, cockpit corners


def build_pylon():
    mb = MB('pylon')
    foot = V(HUB.x, 0, bt(HUB_P[0]) - 0.05)
    mb.cyl(foot, PIVOT + V(0, 0, -0.005), 0.034, 'Strut_Black', n=16)
    mb.lathe([(0.0, 0.0), (0.075, 0.0), (0.075, 0.012), (0.04, 0.03), (0.0, 0.03)], V(HUB.x, 0, bt(HUB_P[0]) - 0.004),
             V(0, 0, 1), 'Metal_Frame', n=20)
    col = P(HUB_P[0], COLLAR_Z)
    mb.lathe([(0.0, -0.04), (0.055, -0.04), (0.06, -0.03), (0.06, 0.03), (0.055, 0.04), (0.0, 0.04)], col, V(0, 0, 1),
             'Engine_Dark', n=20)
    feet = []
    for X, ay in MAST_FEET:
        for sy in (1, -1):
            lug = col + V(0.035 if X > HUB_P[0] else -0.035, sy * 0.035, 0)
            aim = V(px(X), sy * ay, bt(X, ay) - 0.02)
            d = (aim - lug).normalized()
            hit = body_entry(lug, d)
            mb.cyl(lug, hit + d * 0.02, 0.019, 'Strut_Black', n=10)
            shoe(mb, hit, d, 0.019)
            feet.append(hit)
    return mb.finish(sharp_angle=50, wn=True), feet


def build_head():
    """Node `rotor_head` (origin on the pivot at the top of the mast): bearing housing under the hub."""
    mb = MB('rotor_head')
    p = PIVOT
    top = HUB.z - 0.06
    mb.lathe([(0.0, -0.02), (0.05, -0.02), (0.06, 0.0), (0.06, 0.06), (0.075, 0.075), (0.075, top - p.z - 0.02),
              (0.06, top - p.z), (0.0, top - p.z)], p, V(0, 0, 1), 'Hub_Olive', n=24)
    for k in range(6):
        a = TAU * k / 6
        q = p + V(math.cos(a) * 0.075, math.sin(a) * 0.075, 0.075)
        mb.cyl(q, q + V(0, 0, 0.012), 0.008, 'Metal_Frame', n=6)
    return mb.finish(origin=p, sharp_angle=40, wn=True)


BLADE_ROOT = 0.30
CORD_R = 1.90                                   # blade fitting of the top cords
KING_H = 0.44


def blade(mb, hub, Rr, chord, pitch_deg=3.0, cone_deg=2.0, tc=0.11):
    """Wide wooden blade (ribs on a single spar, doped fabric): narrow root, constant chord from r ~1.1 m,
    square tip with rounded corners (plan of the replica). LE towards +Y for the blade along +X."""
    loop = airfoil_ring(14, tc, m=0.035, te_min=0.003)
    pitch = Matrix.Rotation(math.radians(pitch_deg), 3, 'X')
    cone = Matrix.Rotation(math.radians(-cone_deg), 3, 'Y')

    def section(r, c, th=1.0):
        out = []
        for s, tz in loop:
            q = pitch @ Vector((0.0, (0.25 - s) * c, tz * c * th))
            out.append(hub + cone @ Vector((r, q.y, q.z)))
        return out

    rs = [BLADE_ROOT, 0.40, 0.55, 0.75, 0.95, 1.12, 1.5, 2.2, 3.0, 3.8, 4.6, Rr - 0.16]
    rings = []
    for r in rs:
        u = min(1.0, max(0.0, (r - BLADE_ROOT) / (1.12 - BLADE_ROOT)))
        k = lerp(0.26, 1.0, u * u * (3 - 2 * u))
        th = lerp(1.9, 1.0, u)
        rings.append(section(r, chord * k, th))
    mb.loft(rings, 'Rotor_Blade', closed=True, cap0=True)
    tip = []
    for k in range(7):
        u = k / 6.0
        r = Rr - 0.16 + 0.16 * math.sin(0.5 * math.pi * u)
        if k == 6:
            tip.append([section(r, chord * 0.55, 0.5)[0]])
            continue
        f = 1.0 - 0.45 * (1 - math.cos(0.5 * math.pi * u)) ** 1.5
        tip.append(section(r, chord * f, 1.0 - 0.3 * u))
    mb.loft(tip, 'Rotor_Blade', closed=True)
    # steel spar root out of the flapping hinge, clamp band, cord fitting on the upper surface
    mb.cyl(hub + cone @ V(0.20, 0, 0), hub + cone @ V(BLADE_ROOT + 0.06, 0, 0), 0.028, 'Metal_Frame', n=12)
    mb.cyl(hub + cone @ V(BLADE_ROOT - 0.02, 0, 0), hub + cone @ V(BLADE_ROOT + 0.04, 0, 0), 0.040, 'Hub_Olive', n=12)
    fit = hub + cone @ V(CORD_R, 0.0, 0.5 * tc * chord + 0.004)
    mb.box(fit, (0.10, 0.04, 0.02), 'Hub_Olive', bevel=0.005, segs=1)
    return fit + V(0, 0, 0.01)


def build_rotor():
    mb = MB('rotor')
    fit = blade(mb, HUB, ROTOR_R, CHORD)
    bm = mb.bm
    one = list(bm.verts)
    for k in range(1, 4):
        ret = bmesh.ops.duplicate(bm, geom=one + list({e for v in one for e in v.link_edges}) +
                                  list({f for v in one for f in v.link_faces}))
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=HUB, matrix=Matrix.Rotation(TAU * k / 4, 3, 'Z'))
    # hub: olive plate with four forks of the flapping hinges
    mb.lathe([(0.0, -0.05), (0.13, -0.05), (0.15, -0.03), (0.15, 0.03), (0.12, 0.05), (0.0, 0.05)], HUB, V(0, 0, 1),
             'Hub_Olive', n=32)
    for k in range(4):
        a = TAU * k / 4
        d = V(math.cos(a), math.sin(a), 0)
        t = V(-math.sin(a), math.cos(a), 0)
        rot = Matrix.Rotation(a, 4, 'Z')
        for s in (1, -1):
            mb.box(HUB + d * 0.18 + t * s * 0.035, (0.10, 0.015, 0.075), 'Hub_Olive', bevel=0.005, segs=1, rot=rot)
        mb.cyl(HUB + d * 0.20 - t * 0.055, HUB + d * 0.20 + t * 0.055, 0.012, 'Metal_Frame', n=8)
    # king post with a small cross-head; cords to the blade fittings
    ktop = HUB + V(0, 0, KING_H)
    mb.cyl(HUB + V(0, 0, 0.04), ktop, 0.018, 'Hub_Olive', n=12)
    mb.lathe([(0.0, 0.0), (0.035, 0.0), (0.035, 0.03), (0.0, 0.04)], ktop, V(0, 0, 1), 'Hub_Olive', n=14)
    for k in range(4):
        a = TAU * k / 4
        q = Matrix.Rotation(a, 3, 'Z') @ (fit - HUB) + HUB
        mb.cyl(ktop + V(0, 0, 0.015), q, 0.004, 'Wire', n=6)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Outriggers with the all-moving aileron panels
# ---------------------------------------------------------------------------
def build_ailerons():
    mb = MB('ailerons')
    ch = AIL_LE - AIL_TE
    loop = airfoil_ring(12, 0.06, m=0.0, te_min=0.002)
    piv = (AIL_LE - SPAR_X) / ch
    for sy in (1, -1):
        # streamlined spar from inside the fuselage to the tip, lower brace, lift wire
        y0 = side_y(SPAR_X, SPAR_Z) - 0.05
        mb.tube([P(SPAR_X, SPAR_Z, sy * y0), P(SPAR_X, SPAR_Z, sy * (AIL_Y1 - 0.02))], 0.0, 'Wood_Skid', n=12,
                square=(0.085, 0.040, 2.2), cap=True)
        mb.tube([P(SPAR_X + 0.05, bb(SPAR_X) - R.dz + HUB_P[1] + 0.03, sy * 0.30),
                 P(SPAR_X, SPAR_Z - 0.02, sy * AIL_Y0)], 0.0, 'Strut_Black', n=10, square=(0.035, 0.018, 2.2),
                cap=True)
        top = P(SPAR_X, uz(bt(SPAR_X, 0.40)) - 0.03, sy * (side_y(SPAR_X, 0.35) - 0.005))
        mb.cyl(top, P(SPAR_X, SPAR_Z + 0.02, sy * (AIL_Y0 + 0.9)), 0.0035, 'Wire', n=6)
        mb.cyl(top + V(-0.05, 0, 0), P(SPAR_X, SPAR_Z + 0.02, sy * (AIL_Y1 - 0.25)), 0.0035, 'Wire', n=6)
        # panel: rounded outer leading corner (plan), small rounded inner corners
        ys = [AIL_Y0, AIL_Y0 + 0.02, AIL_Y0 + 0.06, 2.2, 2.7, 3.2, 3.55, 3.70, 3.80, 3.86, AIL_Y1]
        rings = []
        for y in ys:
            k_in = max(0.0, 1 - (y - AIL_Y0) / 0.06)
            k_out = max(0.0, (y - (AIL_Y1 - 0.20)) / 0.20)
            le = AIL_LE - 0.20 * (1 - math.sqrt(max(0.0, 1 - k_out * k_out))) - 0.03 * (1 - math.sqrt(max(0.0, 1 - k_in * k_in)))
            te = AIL_TE + 0.03 * (1 - math.sqrt(max(0.0, 1 - k_in * k_in))) + 0.06 * (1 - math.sqrt(max(0.0, 1 - k_out * k_out)))
            c = max(0.05, le - te)
            rings.append([P(le - s * c, SPAR_Z + tz * c + (s - piv) * 0.0, sy * y) for s, tz in loop])
        mb.loft(rings, 'Fabric_Orange', closed=True, cap0=True, cap1=True)
        # hinge brackets on the spar and the control horn (the "V" of the plan) with its cables
        for y in (AIL_Y0 + 0.15, 2.9, AIL_Y1 - 0.15):
            mb.box(P(SPAR_X, SPAR_Z, sy * y), (0.11, 0.03, 0.06), 'Metal_Frame', bevel=0.004, segs=1)
        hy = 2.75
        for sz in (1, -1):
            hz = SPAR_Z + sz * 0.16
            mb.tube([P(SPAR_X - 0.10, SPAR_Z + sz * 0.02, sy * hy), P(SPAR_X - 0.02, hz, sy * hy)], 0.0, 'Metal_Frame',
                    n=8, square=(0.03, 0.006, 3), cap=True)
            mb.cyl(P(SPAR_X - 0.02, hz, sy * hy), P(-2.3, SPAR_Z + sz * 0.06, sy * (side_y(-2.3, SPAR_Z) + 0.002)),
                   0.003, 'Wire', n=5)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Tail: tailplane on the top longerons, horn-balanced elevators, comma rudder, tail skid
# ---------------------------------------------------------------------------
RUDDER_OUTLINE = [(-8.14, -0.40), (-8.14, 0.20), (-7.97, 0.29), (-7.87, 0.42), (-7.84, 0.56), (-7.88, 0.69),
                  (-7.99, 0.79), (-8.16, 0.845), (-8.36, 0.84), (-8.56, 0.78), (-8.74, 0.65), (-8.88, 0.47),
                  (-8.96, 0.27), (-8.95, 0.08), (-8.84, -0.08), (-8.64, -0.22), (-8.42, -0.33), (-8.24, -0.40)]


def outline_x(z, front=True):
    xs = []
    pts = RUDDER_OUTLINE + [RUDDER_OUTLINE[0]]
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if (z0 - z) * (z1 - z) <= 0 and z0 != z1:
            xs.append(lerp(x0, x1, (z - z0) / (z1 - z0)))
    if not xs:
        return None
    return max(xs) if front else min(xs)


def tp_le(ay):
    """Fixed tailplane LE (prop X): straight, rounding into the tip."""
    r = 0.16
    if ay <= TP_HALF - r:
        return TP_LE
    t = min(1.0, (ay - (TP_HALF - r)) / r)
    return TP_LE - r * (1 - math.sqrt(max(0.0, 1 - t * t)))


def el_le(ay):
    """Elevator LE: the hinge, or the horn ahead of it outboard of the tailplane."""
    if ay <= TP_HALF + 0.01:
        return TP_HINGE + 0.01
    r = 0.12
    t = min(1.0, max(0.0, (ay - (EL_HALF - r)) / r))
    return HORN_LE - r * (1 - math.sqrt(max(0.0, 1 - t * t)))


def el_te(ay):
    if ay < 0.34:
        return lerp(-8.30, TP_TE, max(0.0, (ay - 0.10) / 0.24))
    r = 0.14
    t = min(1.0, max(0.0, (ay - (EL_HALF - r)) / r))
    return TP_TE + r * (1 - math.sqrt(max(0.0, 1 - t * t)))


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(12, 0.07, te_min=0.002)
    for sy in (1, -1):
        rings = []
        for ay in (0.0, 0.3, 0.7, 1.0, 1.18, 1.28, 1.34, 1.375, TP_HALF - 0.005):
            le = tp_le(ay)
            c = max(0.04, le - TP_HINGE)
            rings.append([P(le - s * c, TP_Z + tz * max(c, 0.5) * (c / max(c, 0.5)), sy * ay) for s, tz in loop])
        mb.loft(rings, 'Fabric_Orange', closed=True, cap0=True, cap1=True)
        # elevator (+ horn): thin cambered-plate section
        rings = []
        for ay in (0.10, 0.2, 0.34, 0.7, 1.1, 1.38, 1.42, 1.60, 1.80, 1.89, 1.95, 1.99, EL_HALF - 0.003):
            le, te = el_le(ay), el_te(ay)
            c = max(0.04, le - te)
            ring = []
            for s, tz in airfoil_ring(10, 0.05, te_min=0.0015):
                ring.append(P(le - s * c, TP_Z + tz * c, sy * ay))
            rings.append(ring)
        mb.loft(rings, 'Fabric_Orange', closed=True, cap0=True, cap1=True)
        # two struts from the tailplane underside to the bottom longeron, hinge brackets, control horn
        for X in (-7.35, -7.85):
            mb.cyl(P(X, TP_Z - 0.02, sy * 0.95), P(-7.55, uz(bb(-7.55)) + 0.03, sy * 0.06), 0.011, 'Strut_Black', n=8)
        for ay in (0.5, 1.2, 1.8):
            mb.box(P(TP_HINGE, TP_Z, sy * ay), (0.05, 0.02, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
        mb.box(P(TP_HINGE - 0.05, TP_Z - 0.10, sy * 0.28), (0.06, 0.008, 0.16), 'Metal_Frame', bevel=0.003, segs=1)
    # rudder post cap and the tail skid (504K: ash skid, sprung at its front end)
    mb.box(P(HINGE_X + 0.02, -0.10), (0.05, 0.05, 0.42), 'Fabric_Orange', bevel=0.015, segs=2)
    a = P(-7.98, -0.36)
    b = P(*TAIL_SKID) + V(0, 0, 0.03)
    mb.tube([a, a + (b - a) * 0.5 + V(0, 0, -0.01), b], 0.0, 'Wood_Skid', n=10, square=(0.05, 0.035, 2.5), cap=True)
    mb.box(P(TAIL_SKID[0] - 0.02, TAIL_SKID[1] + 0.025), (0.14, 0.05, 0.02), 'Metal_Frame', bevel=0.006, segs=1)
    mb.cyl(P(-7.75, uz(bb(-7.75)) - 0.01), P(-8.02, -0.40), 0.010, 'Metal_Frame', n=8)
    return mb.finish(sharp_angle=45)


RUDDER_PIVOT = (HINGE_X, 0.20)


def build_rudder():
    mb = MB('rudder_surf')
    zs = [-0.40 + 0.0001] + [lerp(-0.38, 0.83, k / 24) for k in range(25)] + [0.844]
    rings = []
    for z in zs:
        lx, tx = outline_x(z, True), outline_x(z, False)
        if lx is None or lx - tx < 0.01:
            continue
        c = lx - tx
        ring = []
        for s, tz in airfoil_ring(12, 0.07, te_min=0.0015):
            ring.append(P(lx - s * c, z, tz * max(c, 0.25) * (min(c, 0.6) / max(c, 0.6))))
        rings.append(ring)
    mb.loft(rings, 'Rudder_Yellow', closed=True, cap0=True, cap1=True)
    origin = P(*RUDDER_PIVOT)
    for z in (-0.25, 0.05):
        mb.box(P(HINGE_X, z), (0.05, 0.05, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    ob = mb.finish(origin=origin, sharp_angle=45)
    # flag of the time: red / yellow (double) / red, with "C6.B." on the yellow (replica)
    K.repaint(ob, lambda c: c.z + origin.z > pz(0.50) or c.z + origin.z < pz(-0.12), 'Paint_Accent')
    # "C6" big and ".B." small, reading C6.B. from either side (photo: right side, C6 aft)
    regs = []
    try:
        for text, size, cz, x_left, x_right in (('C6', 0.26, 0.27, -8.40, -8.68), ('.B.', 0.11, 0.22, -8.72, -8.38)):
            for keep, cx in ((0, x_left), (1, x_right)):
                obs = E.build_registration(ob, text, cx=px(cx) - origin.x, cz=pz(cz) - origin.z, size=size,
                                           mat='Paint_Dark')
                regs.append(obs[keep])
                bpy.data.objects.remove(obs[1 - keep])
    except Exception as ex:
        print('  !! rudder letters skipped:', ex)
    det = MB('rudder_det')
    tl = P(-8.955, 0.12)
    K.lamp(det, tl, V(-1, 0, 0), kind='white', r=0.016, length=0.026, base='Metal_Frame')
    d_ob = det.finish(sharp_angle=50)
    for r in regs:
        r.location = r.location + origin
    B.join_objects('rudder', [ob] + regs + [d_ob])
    rud = bpy.data.objects['rudder']
    return rud


# ---------------------------------------------------------------------------
# 504K undercarriage
# ---------------------------------------------------------------------------
def build_wheels():
    out = []
    for name, sy in (('wheel_L', 1), ('wheel_R', -1)):
        wb = MB(name)
        c = P(WHEEL_X, WHEEL_Z, sy * WHEEL_Y)
        wb.lathe(B.tire_profile(WHEEL_R, WHEEL_R - 0.065, WHEEL_W), c, V(0, 1, 0), 'Rubber', n=40, closed_profile=True)
        hw = WHEEL_W / 2
        rim = WHEEL_R - 0.06
        # fabric-covered spoked wheel (the replica's orange discs) with the hub cap
        wb.lathe([(0.0, -hw * 1.1), (0.045, -hw * 1.1), (0.06, -hw * 0.9), (rim * 0.92, -hw * 0.45), (rim, -hw * 0.62),
                  (rim, hw * 0.62), (rim * 0.92, hw * 0.45), (0.06, hw * 0.9), (0.045, hw * 1.1), (0.0, hw * 1.1)], c,
                 V(0, 1, 0), 'Hub_Orange', n=32)
        out.append(wb.finish(origin=c, sharp_angle=40))
    return out


def build_gear():
    mb = MB('gear')
    # central skid: ash with an up-turned toe
    pts = [P(SKID_END, SKID_Z + 0.035), P(-2.0, SKID_Z + 0.035), P(-0.8, SKID_Z + 0.035), P(0.0, SKID_Z + 0.04),
           P(0.25, SKID_Z + 0.07), P(0.42, SKID_Z + 0.14), P(SKID_TOE, SKID_Z + 0.25)]
    mb.tube(catmull(pts, 6), 0.0, 'Wood_Skid', n=12, square=(0.065, 0.07, 3.0), cap=True)
    mb.box(P(SKID_END + 0.08, SKID_Z + 0.01), (0.16, 0.07, 0.015), 'Metal_Frame', bevel=0.005, segs=1)
    sk_front = P(-0.05, SKID_Z + 0.08)
    sk_mid = P(WHEEL_X + 0.06, SKID_Z + 0.08)
    sk_rear = P(-2.63, SKID_Z + 0.08)
    for sy in (1, -1):
        # front V from the skid to the nose bottom; rear V to the bottom longerons
        nose = V(px(-0.72), sy * 0.30, bb(-0.72) + 0.06)
        mb.cyl(sk_front + V(0, sy * 0.02, 0), nose, 0.016, 'Strut_Black', n=8)
        rear = V(px(-2.60), sy * 0.26, bb(-2.60) + 0.03)
        mb.cyl(sk_rear + V(0, sy * 0.02, 0), rear, 0.016, 'Strut_Black', n=8)
        # long diagonal from the skid toe region back up to the fuselage (photos)
        mb.cyl(sk_front + V(-0.02, sy * 0.02, 0), V(px(-1.30), sy * 0.33, bb(-1.30) + 0.03), 0.013, 'Strut_Black', n=8)
        # shock box over each wheel, leg to the axle, V struts to the fuselage
        bx = P(WHEEL_X, -0.93, sy * (WHEEL_Y - 0.10))
        mb.box(bx, (0.15, 0.11, 0.21), 'Hub_Orange', bevel=0.025, segs=2)
        axle_in = P(WHEEL_X, WHEEL_Z, sy * (WHEEL_Y - WHEEL_W / 2 - 0.035))
        mb.cyl(bx + V(0, 0, -0.10), axle_in + V(0, 0, 0.02), 0.020, 'Strut_Black', n=10)
        for X in (-1.08, -2.02):
            mb.cyl(bx + V(0.04 if X > WHEEL_X else -0.04, 0, 0.09), V(px(X), sy * (side_y(X, -0.58) - 0.03),
                   bb(X) + 0.02), 0.017, 'Strut_Black', n=8)
        mb.cyl(bx + V(0, 0, 0.10), V(px(WHEEL_X), sy * (side_y(WHEEL_X, -0.58) - 0.04), bb(WHEEL_X) + 0.02), 0.017,
               'Strut_Black', n=8)
        # split axle from the wheel to its hinge on the skid
        mb.cyl(P(WHEEL_X, WHEEL_Z, sy * (WHEEL_Y + WHEEL_W / 2 + 0.03)), sk_mid + V(0, sy * 0.04, 0.03 + 0.0), 0.018,
               'Strut_Black', n=10)
        mb.cyl(P(WHEEL_X, WHEEL_Z, sy * (WHEEL_Y + WHEEL_W / 2 + 0.035)), P(WHEEL_X, WHEEL_Z, sy * (WHEEL_Y + WHEEL_W / 2 + 0.06)),
               0.03, 'Metal_Frame', n=12)
        # bracing wires (front and rear) from the skid to the boxes and the fuselage
        mb.cyl(sk_front + V(0, 0, 0.01), bx + V(0.05, 0, -0.06), 0.003, 'Wire', n=5)
        mb.cyl(sk_rear + V(0, 0, 0.01), bx + V(-0.05, 0, -0.06), 0.003, 'Wire', n=5)
        mb.cyl(sk_front + V(0, 0, 0.0), axle_in, 0.003, 'Wire', n=5)
    # cross wires between the gear V struts
    l = V(px(-1.08), 0.33, bb(-1.08) + 0.02)
    r = V(px(-2.02), -0.33, bb(-2.02) + 0.02)
    mb.cyl(P(WHEEL_X, -0.98, WHEEL_Y - 0.10), V(px(WHEEL_X), -0.30, bb(WHEEL_X) + 0.02), 0.003, 'Wire', n=5)
    mb.cyl(P(WHEEL_X, -0.98, -(WHEEL_Y - 0.10)), V(px(WHEEL_X), 0.30, bb(WHEEL_X) + 0.02), 0.003, 'Wire', n=5)
    del l, r
    mb.box(sk_mid + V(0, 0, 0.03), (0.10, 0.10, 0.05), 'Metal_Frame', bevel=0.008, segs=1)
    return mb.finish(sharp_angle=45, wn=True)


# ---------------------------------------------------------------------------
# Cockpit, crew, controls
# ---------------------------------------------------------------------------
def period_stick(base, top):
    mb = MB('stick')
    base, top = Vector(base), Vector(top)
    d = (top - base).normalized()
    mb.lathe([(0.0, 0.0), (0.05, 0.0), (0.05, 0.012), (0.035, 0.03), (0.0, 0.03)], base, d, 'Grip_Leather', n=18)
    g0 = top - d * 0.13
    mb.cyl(base, g0 + d * 0.01, 0.014, 'Metal_Frame', n=12)
    # spade grip of the period with the blip switch of the rotary
    mb.lathe([(0.0, 0.0), (0.02, 0.0), (0.022, 0.01), (0.022, 0.10), (0.026, 0.115), (0.02, 0.128), (0.0, 0.13)],
             g0, d, 'Grip_Leather', n=18)
    mb.cyl(top - d * 0.004, top + d * 0.012, 0.009, 'Paint_Accent', n=10)
    ob = mb.finish(origin=base, sharp_angle=40)
    return ob, g0 + d * 0.06, d


def period_seat(mb, hip, back_deg, width=0.42):
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    seat_top = hip.z - 0.105
    tilt = Euler((0, math.radians(-3), 0))
    c = V(hip.x + 0.10, 0, seat_top - 0.035)
    c = c - V(0.04, 0, 0)
    mb.box(c, (0.32, width, 0.07), 'Seat', bevel=0.025, segs=2, rot=tilt)
    mb.box(c - V(0, 0, 0.045), (0.34, width + 0.02, 0.02), 'Wood_Skid', bevel=0.006, segs=1, rot=tilt)
    back_c = hip - f * 0.165 + u * 0.36
    rb = Euler((0, -b, 0))
    mb.box(back_c, (0.06, width, 0.42), 'Seat', bevel=0.025, segs=2, rot=rb)
    for sx in (-0.10, 0.26):
        for sy in (1, -1):
            mb.cyl(V(hip.x + sx, sy * (width / 2 - 0.03), seat_top - 0.09), V(hip.x + sx, sy * (width / 2 - 0.03), pz(FLOOR_Z)),
                   0.013, 'Wood_Skid', n=8)


def build_cockpit():
    mb = MB('cockpit')
    xs_f = [lerp(CK[1] - 0.12, -1.95, k / 14) for k in range(15)]
    coords = []
    for X in xs_f:
        w = side_y(X, FLOOR_Z) - 0.014
        coords += [P(X, FLOOR_Z, -w), P(X, FLOOR_Z, w)]
    mb.faces(coords, [[2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1] for k in range(14)], 'Interior')
    for Xb, back in ((CK[1] - 0.12, True), (-1.95, False)):
        xb = px(Xb)
        c = V(xb, 0, BODY.zw(xb))
        ring = [c + (p - c) * 0.975 for p in BODY.ring(xb, 48)]
        idx = list(range(len(ring)))
        mb.faces(ring, [idx[::-1] if back else idx], 'Interior', smooth=False)
    period_seat(mb, P(*PILOT_HIP), PILOT_BACK)
    # small wooden board under the decking at the front of the cockpit, drawn live by the sim
    # (src/aircraft/VintagePanel.ts): air speed, altimeter, engine and rotor revolution counters (the
    # rotor counter is an assumption: the game needs it), oil pulsator (oil pressure), cross level
    zb = bt(CK[0] + 0.02) - 0.20
    E.panel(mb, V(px(CK[0] + 0.05), 0, zb), 0.42, 0.16, 14, glare=False, live=('vintage_board', [
        {'k': 'asi', 'u': -0.14, 'v': 0.02, 'd': 0.072},
        {'k': 'alt', 'u': -0.05, 'v': 0.02, 'd': 0.072},
        {'k': 'rotor', 'u': 0.05, 'v': 0.02, 'd': 0.072},
        {'k': 'engine', 'u': 0.14, 'v': 0.02, 'd': 0.072},
        {'k': 'level', 'u': -0.07, 'v': -0.048, 'w': 0.09, 'h': 0.02},
        {'k': 'oilp', 'u': 0.08, 'v': -0.048, 'd': 0.042},
    ]))
    # rudder bar on its vertical pin (504K)
    fbp = P(*FOOT_BAR_P)
    mb.cyl(fbp + V(0, 0, -0.012), V(fbp.x, 0, pz(FLOOR_Z) + 0.005), 0.016, 'Metal_Frame', n=12)
    fb = MB('foot_bar')
    fb.box(fbp, (0.05, 0.50, 0.035), 'Wood_Skid', bevel=0.008, segs=1)
    fb.cyl(fbp + V(0, 0, -0.016), fbp + V(0, 0, 0.022), 0.022, 'Metal_Frame', n=14)
    for sy in (1, -1):
        fb.box(fbp + V(-0.02, sy * 0.17, 0.035), (0.03, 0.10, 0.04), 'Metal_Frame', bevel=0.005, segs=1)
        fb.cyl(fbp + V(0, sy * 0.24, 0), P(-2.70, -0.30, sy * 0.40), 0.0025, 'Wire', n=5)
    fb.finish(origin=fbp, sharp_angle=40)
    return mb.finish(sharp_angle=40, wn=True)


def build_crew():
    ctrl = MB('controls_static')
    stick, grip, axis = period_stick(P(-2.88, FLOOR_Z), P(-2.93, 0.02))
    knob, lever = controls.throttle_lever(ctrl, P(-2.98, -0.06, 0.30), length=0.10, brake=False)
    hip = P(*PILOT_HIP)
    fbp = P(*FOOT_BAR_P)
    pilot.build_pilot('pilot_front', hip, PILOT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': fbp + V(0.03, 0.17, 0.085), 'R': fbp + V(0.03, -0.17, 0.085)},
                      helmet='leather', knee_out=0.06, elbow_out=0.04, rig=True)
    K.print_joints('pilot_front', R)
    b = math.radians(PILOT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = hip + u * (pilot.SPINE + 0.13) + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    E.make_eye(eye)
    return ctrl.finish(sharp_angle=40), stick, eye, head


# ---------------------------------------------------------------------------
# Lights (the 1925 aircraft carried none)
# ---------------------------------------------------------------------------
def build_lights():
    """MINIMUM SET, NOT ON THE PHOTOS (the C.6 of 1925 carried no lights; every aircraft of the sim has
    them, as on the Wilford): navigation lamps on the outer ends of the aileron spars (red left, green
    right), white tail lamp low on the rudder trailing edge (node in the rudder), a landing lamp under
    the left spar near the fuselage and a red beacon on top of the rudder post."""
    mb = MB('lights')
    for sy in (1, -1):
        p = P(SPAR_X, SPAR_Z, sy * (AIL_Y1 + 0.005))
        K.lamp(mb, p, V(0.4, sy * 1.0, 0.0), kind='red' if sy > 0 else 'green', r=0.018, length=0.03, base='Metal_Frame')
        K.lamp_node('navL' if sy > 0 else 'navR', p + V(0.4, sy * 1.0, 0).normalized() * 0.05)
    K.lamp_node('tail', P(-8.955 - 0.05, 0.12))
    lp = P(SPAR_X + 0.06, SPAR_Z - 0.06, 1.05)
    mb.lathe([(0.0, -0.05), (0.075, -0.05), (0.075, 0.012), (0.0, 0.012)], lp, V(1, 0, 0), 'Metal_Frame', n=24)
    mb.lathe([(0.0, 0.012), (0.068, 0.012), (0.06, 0.026), (0.0, 0.032)], lp, V(1, 0, 0), 'Lens_White', n=24)
    mb.cyl(lp + V(-0.03, 0, 0.03), P(SPAR_X, SPAR_Z, 1.05), 0.012, 'Metal_Frame', n=8)
    K.lamp_node('landing', lp + V(0.07, 0, 0))
    bp = P(HINGE_X + 0.02, 0.115)
    K.lamp(mb, bp, V(0, 0, 1), kind='red', r=0.02, length=0.035, base='Fabric_Orange')
    K.lamp_node('beacon', bp + V(0, 0, 0.06), 'red')
    return mb.finish(sharp_angle=50)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------
GEOM = {}


def build_c6():
    build_extra_materials()
    fus = build_fuselage()
    rim = bpy.data.objects.get('coaming')
    cowl, mount = build_cowl()
    build_prop()
    pylon, feet = build_pylon()
    build_head()
    build_rotor()
    ail = build_ailerons()
    tail = build_tail()
    build_rudder()
    build_wheels()
    gear = build_gear()
    cockpit = build_cockpit()
    ctrl, stick, eye, head = build_crew()
    lights = build_lights()
    K.clearance(['pilot_front_leg', 'pilot_front_foot'], [cockpit, ctrl, pylon], ' (pilot legs)')
    K.clearance(['pilot_front'], [fus, pylon], ' (pilot)')
    K.finalize([fus, rim, cowl, mount, pylon, ail, tail, gear, cockpit, ctrl, lights], [])
    GEOM.update(eye=eye, head=head, feet=feet)
    req = {
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': P(*RUDDER_PIVOT), 'stick': P(-2.88, FLOOR_Z),
        'wheel_L': P(WHEEL_X, WHEEL_Z, WHEEL_Y), 'wheel_R': P(WHEEL_X, WHEEL_Z, -WHEEL_Y), 'eye_front': eye,
        'foot_bar': P(*FOOT_BAR_P),
    }
    B.REQUIRED = {k: (None if p is None else (round(p.x, 4), round(p.z, 4), round(-p.y, 4))) for k, p in req.items()}
    B.REQUIRED.update({k: None for k in ('pilot_front', 'throttle')})
    B.REQUIRED.update(controls.rig_nodes('pilot_front'))
    report()


def report():
    def m(p):
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('C6 CG model (0.08, 0.10); hub %s pivot %s prop %s D %.2f' % (m(HUB), m(PIVOT), m(PROP), 2 * PROP_R))
    print('C6 wheels L %s R %s R %.2f | ground (level) y %.3f' % (m(P(WHEEL_X, WHEEL_Z, WHEEL_Y)),
                                                               m(P(WHEEL_X, WHEEL_Z, -WHEEL_Y)), WHEEL_R, pz(GROUND_Z)))
    print('C6 wheel contacts y %.3f; tail skid contact %s; skid toe %s; skid rear %s' % (
        pz(GROUND_Z), m(P(*TAIL_SKID)), m(P(SKID_TOE, SKID_Z + 0.25)), m(P(SKID_END, SKID_Z))))
    pitch = math.degrees(math.atan2(TAIL_SKID[1] - GROUND_Z, WHEEL_X - TAIL_SKID[0]))
    print('C6 rest pitch %.2f deg' % pitch)
    print('C6 eye %s head %s' % (m(GEOM['eye']), m(GEOM['head'])))
    ch = AIL_LE - AIL_TE
    print('C6 ailerons: y %.2f-%.2f, chord %.2f, area each %.2f m2, centre x %.3f y %.3f; spar x %.3f' % (
        AIL_Y0, AIL_Y1, ch, ch * (AIL_Y1 - AIL_Y0), px(AIL_LE - 0.25 * ch), pz(SPAR_Z), px(SPAR_X)))

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
        if ay <= TP_HALF and TP_HINGE <= X <= tp_le(ay):
            return True
        return ay <= EL_HALF and el_te(ay) <= X <= el_le(ay) and ay >= 0.10
    a, (cx, cy) = grid_area(tp_in, -8.8, -7.0, -2.1, 2.1)
    print('C6 tailplane + elevators %.2f m2 (span %.2f), centre x %.3f; 25%% of the mean chord x %.3f' % (
        a, 2 * EL_HALF, px(cx), px(TP_LE - 0.25 * (TP_LE - TP_TE))))
    from panel import inside as pin
    a, (cx, cz) = grid_area(lambda X, Z: pin(RUDDER_OUTLINE, X, Z), -9.0, -7.8, -0.45, 0.9)
    print('C6 rudder area %.2f m2, centre x %.3f y %.3f' % (a, px(cx), pz(cz)))
    pts = {'cowl_top': P(-0.3, 0.54), 'cowl_side_L': P(-0.3, 0.0, 0.54), 'cyl_bottom': P(ENGINE_X, -0.49),
           'belly_front': P(-1.0, -0.58), 'belly_rear': P(-4.0, -0.57), 'side_L': P(-2.0, -0.1, 0.50),
           'aileron_tip_L': P(AIL_LE - 0.3, SPAR_Z, AIL_Y1), 'aileron_tip_R': P(AIL_LE - 0.3, SPAR_Z, -AIL_Y1),
           'pylon_collar': P(HUB_P[0], COLLAR_Z), 'tp_tip_L': P(-8.2, TP_Z, EL_HALF), 'tp_tip_R': P(-8.2, TP_Z, -EL_HALF),
           'rudder_top': P(-8.2, 0.84), 'rudder_te': P(-8.96, 0.27), 'rudder_bottom': P(-8.3, -0.40),
           'skid_toe': P(SKID_TOE, SKID_Z + 0.25), 'skid_front': P(0.15, SKID_Z), 'prop_tip_low': P(0.0, -PROP_R)}
    for k, p in pts.items():
        print('C6 point %-16s %s' % (k, m(p)))


# ---------------------------------------------------------------------------
# Overlays: orthographic renders at the scale of the 504 drawing (side) and of the hangar plan (top)
# ---------------------------------------------------------------------------
OVL = {
    # avro504k_dwg.jpg side view: propeller plane x 61.5, thrust line y 320, 75.1 px/m; crop 0,180 760x290
    'side': dict(ppm=75.1, origin=(61.5, 320.0), crop=(0, 180, 760, 290), view='side'),
    # plan_c6.png (hangar 4 plan): propeller plane x 205, centre line y 380, 81.9 px/m; whole image
    'top': dict(ppm=81.9, origin=(205.0, 380.0), crop=(0, 0, 972, 864), view='top'),
}


def render_ortho(path, which):
    o = OVL[which]
    ppm = o['ppm']
    x0, y0, w, h = o['crop']
    xc, yc = x0 + w / 2, y0 + h / 2
    Xp = -(xc - o['origin'][0]) / ppm
    scn = bpy.context.scene
    B.setup_render(scn)
    scn.cycles.samples = 16
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = w, h
    scn.render.resolution_percentage = 100
    cam = bpy.data.cameras.new('OvlCam')
    cam.type = 'ORTHO'
    cam.ortho_scale = max(w, h) / ppm
    cam.clip_start = 0.1
    cam.clip_end = 200
    co = bpy.data.objects.new('OvlCam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    if o['view'] == 'side':
        Zp = (o['origin'][1] - yc) / ppm
        tgt = P(Xp, Zp)
        d, up = V(0, -1, 0), V(0, 0, 1)          # from the left side: nose to the left of the picture
        co.location = tgt - d * 50
    else:
        Yc = (yc - o['origin'][1]) / ppm
        tgt = P(Xp, 0.0, Yc)
        d, up = V(0, 0, -1), V(0, -1, 0)         # from above, nose to the left
        co.location = tgt - d * 50
    r = d.cross(up).normalized()
    u = r.cross(d)
    co.rotation_euler = Matrix((r, u, -d)).transposed().to_euler()
    sun = bpy.data.lights.new('OSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('OSun', sun)
    so.rotation_euler = Euler((math.radians(40), 0, math.radians(30)), 'XYZ')
    scn.collection.objects.link(so)
    wd = bpy.data.worlds.new('OW')
    scn.world = wd
    try:
        wd.use_nodes = True
        wd.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
        wd.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    except Exception:
        pass
    for ob in bpy.data.objects:
        if ob.name.startswith('pilot') or ob.name.startswith('lamp_'):
            ob.hide_render = True
    if o['view'] == 'top':
        # rotor as in the plan: blades on the diagonals
        bpy.data.objects['rotor'].rotation_euler = (0, 0, math.radians(45))
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered overlay', path)


# ---------------------------------------------------------------------------
# Run: build, export, previews on the parked attitude (tail skid on the floor)
# ---------------------------------------------------------------------------
VIEWS = {
    'three_quarter_front': dict(loc=(9.4, 7.6, 2.6), target=(-0.9, 0.0, 0.5), lens=30, rotor=-20, prop=30),
    'side': dict(loc=(-1.6, 24.0, 0.6), target=(-1.6, 0.0, 0.6), ortho=12.6, rotor=45, prop=90),
    'top': dict(loc=(-1.6, 0.0, 30.0), target=(-1.6, 0.0, 0.0), ortho=12.6, rotor=45, prop=90),
    'front': dict(loc=(18.0, 0.0, 0.6), target=(0.0, 0.0, 0.6), ortho=11.5, rotor=45, prop=90),
    'rear_three_quarter': dict(loc=(-11.0, -8.0, 3.0), target=(-1.6, 0.0, 0.4), lens=32, rotor=40, prop=20),
    'thumb': dict(loc=(6.4, -7.6, 4.0), target=(-1.4, 0.0, 0.2), lens=30, rotor=-25, prop=10),
    'photo_museo': dict(loc=(5.4, -4.2, 0.2), target=(-0.6, 0.0, 0.6), lens=24, rotor=-35, prop=60),
    'nose_detail': dict(loc=(3.4, -2.2, 0.3), target=(1.3, 0.0, -0.2), lens=38, rotor=75, prop=15),
    'head_detail': dict(loc=(1.2, -2.4, 2.6), target=(-0.15, 0.0, 1.9), lens=42, rotor=10, prop=0),
    'tail_detail': dict(loc=(-4.0, -3.6, 1.2), target=(-6.2, 0.0, 0.1), lens=36, rotor=75, prop=10),
    'gear_detail': dict(loc=(3.2, -3.4, -0.4), target=(0.6, 0.0, -1.2), lens=34, rotor=75, prop=10),
    'cockpit': dict(loc=(-0.1, -1.9, 1.9), target=(-1.2, 0.0, 0.6), lens=30, rotor=75, prop=0),
}


def stand(scn, on):
    """Parent everything to an empty rotated to the parked attitude (wheels and tail skid on the floor)."""
    st = bpy.data.objects.get('stand')
    if st is None:
        st = bpy.data.objects.new('stand', None)
        scn.collection.objects.link(st)
        for ob in list(scn.collection.objects):
            if ob is not st and ob.type in ('MESH', 'EMPTY') and not ob.name.startswith('ground'):
                ob.parent = st
    if on:
        piv = P(WHEEL_X, GROUND_Z)
        pitch = math.atan2(TAIL_SKID[1] - GROUND_Z, WHEEL_X - TAIL_SKID[0])
        st.matrix_world = Matrix.Translation(V(0, 0, -1.05)) @ Matrix.Rotation(-pitch, 4, 'Y') @ Matrix.Translation(-piv)
    else:
        st.matrix_world = Matrix.Identity(4)


def render_previews(scn):
    B.setup_render(scn)
    coll, cam = B.setup_studio(scn)
    try:
        scn.cycles.samples = int(K.arg('--samples', '64'))
    except Exception:
        pass
    only = K.arg('--only', None)
    only = set(only.split(',')) if only else None
    rotor = bpy.data.objects.get('rotor')
    prop = bpy.data.objects.get('prop')
    out = os.path.join(HERE, 'previews', NAME)
    os.makedirs(out, exist_ok=True)
    stand(scn, True)
    for name, v in VIEWS.items():
        if only and name not in only:
            continue
        B.aim(cam, v['loc'], v['target'], v.get('lens', 50), v.get('ortho'))
        rotor.rotation_euler = (0, 0, math.radians(v['rotor']))
        prop.rotation_euler = (math.radians(v['prop']), 0, 0)
        scn.render.filepath = os.path.join(out, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
    if only is None or 'eye' in only:
        # the pilot's view forward from eye_front (pilot hidden)
        stand(scn, False)
        eye = bpy.data.objects['eye_front'].matrix_world.translation.copy()
        for ob in bpy.data.objects:
            if ob.name.startswith('pilot_front'):
                ob.hide_render = True
        g = bpy.data.objects.get('ground')
        if g:
            g.hide_render = True
        B.aim(cam, tuple(eye), tuple(eye + V(10, 0, -0.9)), 18)
        scn.render.filepath = os.path.join(out, 'eye.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
    rotor.rotation_euler = (0, 0, 0)
    prop.rotation_euler = (0, 0, 0)


def main():
    scn = B.reset_scene()
    B.build_materials()
    pilot.ensure_materials()
    K.ensure_materials()
    K.set_paint('Paint_White', *LIVERY['body'])
    K.set_paint('Paint_Accent', *LIVERY['accent'])
    K.set_paint('Paint_Dark', *LIVERY['dark'])
    K.set_paint('Seat', *LIVERY['seat'])
    build_c6()
    for m in list(bpy.data.materials):
        # (the studio floor of the previews uses Paint_White)
        if m.users == 0 and m.name != 'Paint_White':
            bpy.data.materials.remove(m)
    B.check_normals()
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:
        pass
    if '--no-export' not in ARGV:
        try:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, NAME + '.blend'))
        except RuntimeError as ex:
            print('  !! could not save .blend:', ex)
        B.GLB_PATH = os.path.join(K.ROOT, 'public', 'models', NAME + '.glb')
        B.export_glb()
        B.verify_glb(B.GLB_PATH)
    ov = K.arg('--ovl')
    if ov:
        render_ortho(K.arg('--ovl-out', os.path.join(HERE, 'previews', NAME, 'ovl_' + ov + '.png')), ov)
        return
    if '--previews' in ARGV:
        render_previews(scn)


if __name__ == '__main__':
    main()
