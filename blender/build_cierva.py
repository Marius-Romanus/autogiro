"""
Cierva C.30A (Avro 671 Rota, 1934) for the Autogiro web sim - a tribute to Juan de la Cierva,
the Spanish engineer who invented the autogiro (first flight of the C.4, Getafe, 9 January 1923).

Layout of the real aircraft (built under licence by Avro, also flown in Spain):
  - fabric-covered steel-tube fuselage with a rounded top decking and two open cockpits in tandem:
    passenger in front, under the rotor pylon; pilot behind;
  - Armstrong Siddeley Genet Major IA seven-cylinder radial at the nose, direct-drive two-blade
    wooden propeller (tractor);
  - three-blade articulated rotor on a four-legged steel pylon; NO wings, ailerons or elevators:
    "direct control" - the pilot tilts the whole rotor head with a control column that hangs from
    it into the rear cockpit;
  - wide-track main gear with long oleo legs, tailwheel, fixed tailplane with upturned tips.

Coordinates follow the sim's node contract (see README): metres, nose toward +X, up +Z (Blender),
origin such that the centre of gravity sits at the common CG (0.08, 0, 0.10), every animated part
a direct child of the root with its origin on its pivot. Fuselage datum level.

Run headless:
  blender -b -P blender/build_cierva.py -- [--previews] [--only VIEW[,VIEW]] [--samples N] [--show-rear]
Outputs: public/models/cierva_c30a.glb, blender/cierva_c30a.blend, blender/previews/cierva/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import build_autogiro as B  # noqa: E402
import pilot  # noqa: E402
from build_autogiro import (V, MB, MATS, TAU, hermite, lerp, sgnpow, catmull, airfoil_ring, naca4, link,  # noqa: E402
                            apply_mods, boundary_loops, resample_loop, closed_tube, mark_sharp)

ROOT = os.path.dirname(HERE)
ARGV = B.ARGV
NAME = 'cierva_c30a'


def arg(name, default):
    if name in ARGV:
        i = ARGV.index(name)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return default


def set_paint(name, hexcol, metal, rough):
    m = MATS[name]
    col = B.srgb(hexcol) + (1.0,)
    bsdf = [n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    bsdf.inputs['Base Color'].default_value = col
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    m.diffuse_color = col
    m.metallic = metal
    m.roughness = rough


def shift(ob, d):
    ob.location += Vector(d)
    return ob


# ---------------------------------------------------------------------------
# Armstrong Siddeley Genet Major IA: seven-cylinder air-cooled radial, direct drive
# ---------------------------------------------------------------------------
def build_radial(c, axis_x=1.0, n_cyl=7, crank_r=0.20, cyl_len=0.30, bore=0.108, head_r=0.505, rot0=0.0):
    """Radial engine centred at c (crankcase centre, Blender coords), thrust along +X.
    head_r = radius to the outer end of the rocker boxes (overall diameter / 2)."""
    mb = MB('engine')
    ax = V(1, 0, 0)
    # crankcase: polygonal drum + nose case + rear cover
    mb.lathe([(0.0, -0.13), (0.15, -0.13), (0.19, -0.11), (crank_r, -0.08), (crank_r, 0.07),
              (0.185, 0.10), (0.13, 0.13), (0.11, 0.20), (0.075, 0.27), (0.05, 0.30), (0.0, 0.30)],
             c, ax, 'Engine', n=42)
    # rear accessory case
    mb.lathe([(0.0, -0.30), (0.12, -0.30), (0.16, -0.26), (0.17, -0.13), (0.0, -0.13)], c, ax, 'Engine_Dark', n=36)
    for k in range(n_cyl):
        a = rot0 + TAU * k / n_cyl
        d = V(0, math.sin(a), math.cos(a))           # radial direction (k=0: up)
        side = V(0, math.cos(a), -math.sin(a))
        base = c + d * (crank_r - 0.01)
        # finned steel barrel
        prof = B.finned_profile(bore * 0.52, bore * 0.52 + 0.022, 0.0, cyl_len * 0.62, pitch=0.013)
        mb.lathe(prof, base, d, 'Engine_Dark', n=18)
        # finned aluminium head (wider fins), slightly offset back
        h0 = base + d * cyl_len * 0.60
        prof = B.finned_profile(bore * 0.56, bore * 0.56 + 0.036, 0.0, cyl_len * 0.36, pitch=0.012)
        mb.lathe(prof, h0, d, 'Engine', n=20)
        # rocker boxes (inlet / exhaust) on top of the head
        top = base + d * (head_r - crank_r - 0.045)
        for s in (1, -1):
            mb.box(top + side * s * 0.032 + ax * 0.0, (0.05, 0.036, 0.05), 'Engine', bevel=0.008, segs=1,
                   rot=Matrix.Rotation(-a, 4, 'X'))
        # push-rod tubes from the crankcase front to the rocker boxes
        for s in (1, -1):
            p0 = c + ax * 0.09 + d * (crank_r - 0.02) + side * s * 0.03
            p1 = top + ax * 0.02 + side * s * 0.032 - d * 0.02
            mb.cyl(p0, p1, 0.0085, 'Metal_Frame', n=8)
        # exhaust stub from the rear of each head into the collector ring
        e0 = h0 + d * 0.03 - ax * 0.05
        e1 = c - ax * 0.20 + d * (crank_r + 0.17)
        mb.tube(catmull([e0, e0 - ax * 0.06, e1], 4), 0.020, 'Exhaust', n=10, cap=True)
        # spark plug leads
        mb.cyl(h0 + d * 0.05 + ax * 0.05, h0 + d * 0.05 + ax * 0.09, 0.006, 'Paint_Dark', n=6)
    # exhaust collector ring behind the cylinders
    ring = []
    for k in range(48):
        a = TAU * k / 48
        ring.append(c - ax * 0.20 + V(0, math.sin(a), math.cos(a)) * (crank_r + 0.17))
    closed_tube(mb, ring, 0.032, 'Exhaust', n=12)
    # ignition harness ring on the front of the crankcase
    ring = []
    for k in range(40):
        a = TAU * k / 40
        ring.append(c + ax * 0.12 + V(0, math.sin(a), math.cos(a)) * 0.15)
    closed_tube(mb, ring, 0.010, 'Paint_Dark', n=8)
    return mb


# ---------------------------------------------------------------------------
# Three-blade articulated rotor: wooden blades (ribs on a steel spar, fabric covered), hub with
# flapping and drag hinges. Node 'rotor', origin on the hub, blade A along +X.
# ---------------------------------------------------------------------------
def c30_blade(mb, hub, R, chord, root, pitch_deg=2.5, cone_deg=3.0, tc=0.12):
    loop = airfoil_ring(14, tc, m=0.0, te_min=0.003)
    pitch = Matrix.Rotation(math.radians(pitch_deg), 3, 'X')
    cone = Matrix.Rotation(math.radians(-cone_deg), 3, 'Y')

    def section(r, c, th=1.0):
        ring = []
        for s, tz in loop:
            p = pitch @ Vector((0.0, (0.25 - s) * c, tz * c * th))
            ring.append(hub + cone @ Vector((r, p.y, p.z)))
        return ring

    # root fairing: round cuff over the spar that blends into the aerofoil
    rs = [root, root + 0.10, root + 0.30, root + 0.60, 1.2, 2.0, 3.0, 4.0, R - 0.45, R - 0.22]
    rings = []
    for r in rs:
        u = min(1.0, (r - root) / 0.6)
        rings.append(section(r, lerp(chord * 0.55, chord, u), lerp(1.8, 1.0, u)))
    mb.loft(rings, 'Rotor_Blade', closed=True, cap0=True)
    # rounded tip (planform: LE rounded, TE straight), painted band
    tip = []
    for k in range(9):
        u = k / 8.0
        r = R - 0.22 + 0.22 * math.sin(0.5 * math.pi * u)
        if k == 8:
            tip.append([section(r, 0.03, 0.6)[0]])
            continue
        f = math.cos(0.5 * math.pi * u) ** 0.5
        tip.append(section(r, max(chord * f, 0.03), 1.0 - 0.3 * u))
    mb.loft(tip, 'Rotor_Blade', closed=True)
    # steel spar root + cuff between the drag hinge and the blade
    mb.cyl(hub + cone @ V(0.30, 0, 0), hub + cone @ V(root + 0.05, 0, 0), 0.032, 'Metal_Frame', n=14)
    for x in (root - 0.06, root + 0.02):
        mb.cyl(hub + cone @ V(x, 0, 0), hub + cone @ V(x + 0.03, 0, 0), 0.042, 'Engine_Dark', n=14)


def build_c30_rotor(hub, R, chord, root, blades=3):
    mb = MB('rotor')
    c30_blade(mb, hub, R, chord, root)
    bm = mb.bm
    one = list(bm.verts)
    for k in range(1, blades):
        ret = bmesh.ops.duplicate(bm, geom=one + list({e for v in one for e in v.link_edges}) +
                                  list({f for v in one for f in v.link_faces}))
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=hub, matrix=Matrix.Rotation(TAU * k / blades, 3, 'Z'))
    # hub: central drum with three arms carrying the flapping (horizontal) and drag (vertical) hinges
    mb.lathe([(0.0, -0.10), (0.11, -0.10), (0.13, -0.07), (0.13, 0.05), (0.10, 0.08), (0.05, 0.10), (0.0, 0.11)],
             hub, V(0, 0, 1), 'Engine', n=36)
    for k in range(blades):
        a = TAU * k / blades
        d = V(math.cos(a), math.sin(a), 0)
        t = V(-math.sin(a), math.cos(a), 0)
        rot = Matrix.Rotation(a, 4, 'Z')
        mb.box(hub + d * 0.17, (0.12, 0.10, 0.07), 'Engine', bevel=0.012, segs=2, rot=rot)
        # flapping hinge pin (tangential), drag hinge pin (vertical) + friction damper
        mb.cyl(hub + d * 0.21 - t * 0.075, hub + d * 0.21 + t * 0.075, 0.016, 'Metal_Frame', n=10)
        mb.box(hub + d * 0.27, (0.07, 0.07, 0.10), 'Engine_Dark', bevel=0.01, segs=1, rot=rot)
        mb.cyl(hub + d * 0.27 + V(0, 0, -0.07), hub + d * 0.27 + V(0, 0, 0.07), 0.014, 'Metal_Frame', n=10)
        mb.cyl(hub + d * 0.24 + t * 0.06, hub + d * 0.36 + t * 0.05, 0.018, 'Engine', n=10)
    # cap
    mb.lathe([(0.0, 0.11), (0.06, 0.11), (0.05, 0.15), (0.0, 0.16)], hub, V(0, 0, 1), 'Engine', n=24)
    return mb.finish(origin=hub, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Rotor head (tilting, node 'rotor_head', origin on its pivot) and the hanging control column
# (node 'stick', same pivot, drawn with the head untilted: the sim tilts both together)
# ---------------------------------------------------------------------------
def build_c30_head(pivot, hub):
    mb = MB('rotor_head')
    # universal-joint block on the pylon apex
    mb.box(pivot, (0.12, 0.12, 0.09), 'Engine', bevel=0.015, segs=2)
    mb.cyl(pivot + V(-0.09, 0, 0), pivot + V(0.09, 0, 0), 0.022, 'Metal_Frame', n=12)
    mb.cyl(pivot + V(0, -0.09, 0), pivot + V(0, 0.09, 0), 0.022, 'Metal_Frame', n=12)
    # bearing housing + vertical shaft up to the hub
    mb.lathe([(0.0, 0.0), (0.085, 0.0), (0.095, 0.03), (0.095, 0.12), (0.075, 0.16), (0.06, 0.16),
              (0.05, hub.z - pivot.z - 0.10), (0.0, hub.z - pivot.z - 0.10)], pivot + V(0, 0, 0.04),
             V(0, 0, 1), 'Engine_Dark', n=30)
    # starter drive bevel box on the shaft
    mb.box(pivot + V(-0.11, 0, 0.11), (0.10, 0.09, 0.09), 'Engine', bevel=0.012, segs=1)
    return mb.finish(origin=pivot, sharp_angle=40, wn=True)


def build_hanging_stick(pivot, grip):
    """Control column fixed to the head: out of the underside of the head fairing, back over the front
    cockpit, then down almost vertically BEHIND the rear windscreen (top edge x -0.70, z 0.72) and the
    instrument board, so that it clears both over its whole travel."""
    mb = MB('stick')
    pts = catmull([pivot + V(-0.06, 0, -0.04), V(-0.30, 0, 1.44), V(-0.62, 0, 1.15), V(-0.83, 0, 0.84),
                   V(grip.x, 0, 0.56), grip + V(0.0, 0, 0.06)], 6)
    mb.tube(pts, 0.019, 'Metal_Frame', n=12, cap=True)
    # leather-bound grip
    mb.cyl(grip + V(0, 0, 0.07), grip + V(0, 0, -0.08), 0.024, 'Leather', n=14)
    mb.sphere(grip + V(0, 0, -0.085), 0.026, 'Leather', seg=14, rings=8)
    return mb.finish(origin=pivot, sharp_angle=40)


# ---------------------------------------------------------------------------
# Two-blade wooden propeller (laminated, varnished; brass-sheathed tips), hub bolts, no spinner
# ---------------------------------------------------------------------------
def build_wood_prop(c, R, pitch_ratio=0.62, spin=1, body_mat='Wood', tip_mat='Brass'):
    """Tractor prop at c, thrust +X. spin=+1: clockwise seen from behind."""
    mb = MB('prop')
    stations = [0.06, 0.10, 0.15, 0.22, 0.32, 0.45, 0.60, 0.75, 0.86, 0.93, 0.97, 1.0]

    def chord(u):
        if u < 0.15:
            return lerp(0.10, 0.14, (u - 0.06) / 0.09)
        if u < 0.5:
            return lerp(0.14, 0.17, (u - 0.15) / 0.35)
        return lerp(0.17, 0.10, (u - 0.5) / 0.5)

    rings_body, rings_tip = [], []
    for u in stations:
        r = u * R
        if u >= 1.0:
            rings_tip.append([c + V(0.0, 0.0, R)])
            continue
        tip_u = max(0.0, (u - 0.90) / 0.10)
        cc = chord(min(u, 0.9)) * math.sqrt(max(0.0, 1 - tip_u ** 2))
        beta = math.atan(pitch_ratio * 2 * R / (TAU * max(r, 0.12)))
        if u < 0.12:
            tc, cam = 0.45, 0.0
        else:
            tc, cam = lerp(0.20, 0.08, (u - 0.12) / 0.88), 0.03
        loop = airfoil_ring(10, tc, m=cam, p=0.4, te_min=0.002)
        ring = []
        for s, tz in loop:
            ch = (0.4 - s) * max(cc, 0.02)
            th = tz * max(cc, 0.02)
            # chord toward -Y*spin, tilted toward +X (thrust) by the blade angle
            px = ch * math.sin(beta) + th * math.cos(beta)
            py = -spin * (ch * math.cos(beta) - th * math.sin(beta))
            ring.append(c + V(px, py, r))
        if u <= 0.86:
            rings_body.append(ring)
        if u >= 0.86:
            rings_tip.append(ring)
    bm = mb.bm
    f0 = set(bm.faces)
    mb.loft(rings_body, body_mat, closed=True, cap0=True)
    mb.loft(rings_tip, tip_mat, closed=True)
    blade = list(set(bm.faces) - f0)
    verts = list({v for f in blade for v in f.verts})
    ret = bmesh.ops.duplicate(bm, geom=verts + list({e for f in blade for e in f.edges}) + blade)
    nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.rotate(bm, verts=nv, cent=c, matrix=Matrix.Rotation(math.pi, 3, 'X'))
    # boss + hub plates + bolts
    mb.lathe([(0.0, -0.09), (0.11, -0.09), (0.11, 0.07), (0.0, 0.07)], c, V(1, 0, 0), body_mat, n=28)
    mb.lathe([(0.0, 0.07), (0.12, 0.07), (0.12, 0.085), (0.0, 0.085)], c, V(1, 0, 0), 'Metal_Frame', n=28)
    mb.lathe([(0.0, -0.105), (0.12, -0.105), (0.12, -0.09), (0.0, -0.09)], c, V(1, 0, 0), 'Metal_Frame', n=28)
    for k in range(6):
        a = TAU * k / 6
        p = c + V(0, math.cos(a) * 0.085, math.sin(a) * 0.085)
        mb.cyl(p + V(0.085, 0, 0), p + V(0.105, 0, 0), 0.011, 'Engine_Dark', n=6)
    mb.lathe([(0.0, 0.085), (0.045, 0.085), (0.04, 0.12), (0.0, 0.125)], c, V(1, 0, 0), 'Metal_Frame', n=20)
    return mb.finish(origin=c, sharp_angle=50, merge=1e-5)


# ---------------------------------------------------------------------------
# Fuselage: stations (x, z_top, z_bottom, half_width, z_widest). Section = superellipse with a
# rounder top (stringered decking) and a boxier bottom, widest at z_widest.
# ---------------------------------------------------------------------------
class Body:
    def __init__(self, table, e_top=2.2, e_bot=3.2, e_side=3.0):
        cols = list(zip(*table))
        self.xs = list(cols[0])
        self.zt = hermite(self.xs, list(cols[1]))
        self.zb = hermite(self.xs, list(cols[2]))
        self.hw = hermite(self.xs, list(cols[3]))
        self.zw = hermite(self.xs, list(cols[4]))
        self.e_top, self.e_bot, self.e_side = e_top, e_bot, e_side

    def ring(self, x, n=64):
        zt, zb, hw, zw = self.zt(x), self.zb(x), self.hw(x), self.zw(x)
        out = []
        for k in range(n):
            a = TAU * k / n
            c, s = math.cos(a), math.sin(a)          # c: up/down, s: left/right
            e = self.e_top if c >= 0 else self.e_bot
            h = (zt - zw) if c >= 0 else (zw - zb)
            y = hw * sgnpow(s, 2 / self.e_side)
            z = zw + h * sgnpow(c, 2 / e)
            out.append(V(x, y, z))
        return out

    def half_width_at(self, x, z):
        zt, zb, hw, zw = self.zt(x), self.zb(x), self.hw(x), self.zw(x)
        h = (zt - zw) if z >= zw else (zw - zb)
        e = self.e_top if z >= zw else self.e_bot
        t = min(1.0, abs(z - zw) / max(h, 1e-6))
        return hw * max(0.0, 1 - t ** e) ** (1 / self.e_side)


def tyre(mb, c, R, w, rim_r, hub_mat='Paint_Dark', axis=V(0, 1, 0)):
    mb.lathe(B.tire_profile(R, rim_r - 0.004, w), c, axis, 'Rubber', n=40, closed_profile=True)
    hw = w / 2
    # dished wheel disc (1930s pressed-steel wheel) with a hub cap
    mb.lathe([(0.0, -hw * 0.75), (0.05, -hw * 0.75), (0.07, -hw * 0.55), (rim_r * 0.9, -hw * 0.45),
              (rim_r, -hw * 0.70), (rim_r, hw * 0.70), (rim_r * 0.9, hw * 0.45), (0.07, hw * 0.55),
              (0.05, hw * 0.75), (0.0, hw * 0.75)], c, axis, hub_mat, n=32)


# ---------------------------------------------------------------------------
# Materials / livery. Material names of the generic model are kept (the sim tunes Paint_*).
# ---------------------------------------------------------------------------
def build_c30_materials(livery):
    B.build_materials()
    pilot.ensure_materials()
    L = livery
    set_paint('Paint_White', *L['body'])         # doped fabric + metal panels
    set_paint('Paint_Accent', *L['accent'])      # blade tips, trim
    set_paint('Paint_Dark', *L['dark'])          # registration letters, struts
    set_paint('Rotor_Blade', *L['blades'])
    set_paint('Seat', '#3B2618', 0.0, 0.6)       # leather cockpit coaming / seats
    B.make_mat('Wood', B.srgb('#6E3F1E'), rough=0.32, coat=0.6)
    B.make_mat('Brass', B.srgb('#B48A3C'), metal=1.0, rough=0.30)
    B.make_mat('Exhaust', B.srgb('#2B2725'), metal=0.55, rough=0.55)
    B.make_mat('Cowl', B.srgb(L['cowl'][0]), metal=L['cowl'][1], rough=L['cowl'][2])
    B.make_mat('Prop_Metal', B.srgb('#C4C8CB'), metal=1.0, rough=0.22)
    B.make_mat('Roundel_Yellow', B.srgb('#F1BF00'), rough=0.45)
    B.make_mat('Flash_White', B.srgb('#F2F2EE'), rough=0.45)
    # 1930s crew: leather coats, darker trousers, leather gloves and helmets
    set_paint('Pilot_Suit', '#5A3B26', 0.0, 0.62)
    set_paint('Suit_Dark', '#2A2420', 0.0, 0.8)
    set_paint('Glove', '#3A2618', 0.0, 0.55)
    set_paint('Harness', '#6B5A44', 0.0, 0.8)


# ===========================================================================
# Geometry, traced on the NACA AC-196 general arrangement (Flight, Aug 1934; fuselage datum level,
# 10 deg ground angle) and placed with the CG from ARC R&M 1859 (rotor centre 5.78 ft above the CG
# perpendicular to the body axis and 0.42 ft behind it). Blender axes: x forward, y left, z up.
# ===========================================================================
from build_ela import thicken_shell, opening_rim, panel, make_eye  # noqa: E402
import controls  # noqa: E402

HUB = V(-0.03, 0, 1.82)
HEAD_PIVOT = V(-0.03, 0, 1.62)
PROP_C = V(1.63, 0, 0.02)
PROP_R = 1.065                    # 7 ft Fairey Reed two-blade metal propeller
ENGINE_C = V(1.31, 0, 0.02)
ROTOR_R, CHORD, BLADE_ROOT = 5.64, 0.279, 0.55
MAIN_C = (1.05, 1.37, -1.25)      # left wheel centre (x, |y|, z): track 9 ft
MAIN_R, MAIN_W = 0.245, 0.15
TAIL_C = V(-3.47, 0, -0.575)      # tailwheel axle, 270 x 100 mm tyre
TAIL_R = 0.135
TAIL_PIVOT = V(-3.33, 0, -0.30)
TP_LE, TP_TE, TP_Z, TP_HALF = -2.76, -3.51, 0.10, 1.12
TIP_LEN, TIP_ANG = 0.58, 44.0
CK_F = (0.13, -0.44, 0.27)        # front (passenger) cockpit: x front, x rear, half width
CK_R = (-0.62, -1.27, 0.26)       # rear (pilot) cockpit
PILOT_HIP = V(-1.07, 0, 0.02)
PASS_HIP = V(-0.17, 0, -0.06)
GRIP = V(-0.85, 0, 0.30)          # hand on the hanging column, behind the rear windscreen and board
THROTTLE_PIVOT = V(-0.87, 0.33, 0.135)
FOOT_BAR = V(-0.38, 0, -0.32)      # tail-wheel foot bar (no rudder), turns about a vertical pin

LIVERY = dict(
    # replica XVU.1-1 at the Museo del Aire (Cuatro Vientos, Madrid): aluminium-doped fabric and
    # light grey panels, black engine, red propeller tips, Ejercito del Aire roundels
    body=('#BCC0C2', 0.12, 0.5), accent=('#B5161B', 0.0, 0.35), dark=('#121314', 0.1, 0.5),
    blades=('#ADB1B4', 0.25, 0.45), cowl=('#BCC0C2', 0.12, 0.5), code='XVU.1-1',
)

BODY = Body([
    # x      top    bottom  half-w  z widest
    (1.10, 0.35, -0.33, 0.30, 0.00),
    (1.05, 0.43, -0.41, 0.38, 0.00),
    (0.95, 0.475, -0.45, 0.415, 0.00),
    (0.60, 0.56, -0.46, 0.42, 0.02),
    (0.20, 0.57, -0.47, 0.42, 0.03),
    (-0.40, 0.55, -0.465, 0.42, 0.03),
    (-0.90, 0.52, -0.445, 0.41, 0.03),
    (-1.40, 0.50, -0.43, 0.385, 0.03),
    (-1.90, 0.455, -0.41, 0.345, 0.03),
    (-2.40, 0.395, -0.38, 0.28, 0.02),
    (-2.90, 0.33, -0.345, 0.20, 0.00),
    (-3.30, 0.275, -0.31, 0.115, -0.01),
    (-3.62, 0.235, -0.28, 0.035, -0.02),
], e_top=2.1, e_bot=3.0, e_side=2.7)


def interp(table, x):
    """Piecewise-linear lookup in a list of (x, value) with x decreasing."""
    if x >= table[0][0]:
        return table[0][1]
    for (x0, v0), (x1, v1) in zip(table, table[1:]):
        if x1 <= x <= x0:
            return lerp(v0, v1, (x0 - x) / (x0 - x1))
    return table[-1][1]


def in_opening(x, y, ck, r=0.10):
    xf, xr, hw = ck
    if not (xr <= x <= xf):
        return False
    dx = max(0.0, max(xr + r - x, x - (xf - r)))
    dy = max(0.0, abs(y) - (hw - r))
    return dx * dx + dy * dy <= r * r


def build_fuselage():
    mb = MB('fuselage')
    xs = []
    x = BODY.xs[0]
    while x > BODY.xs[-1] + 1e-6:
        xs.append(x)
        x -= 0.05 if x > 0.9 else 0.08
    xs.append(BODY.xs[-1])
    rings = [BODY.ring(x, 72) for x in xs]
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # open cockpits: remove the decking inside each opening
    kill = []
    for f in mb.bm.faces:
        c = f.calc_center_median()
        if c.z > 0.30 and (in_opening(c.x, c.y, CK_F) or in_opening(c.x, c.y, CK_R)):
            kill.append(f)
    bmesh.ops.delete(mb.bm, geom=kill, context='FACES')
    ob = mb.finish(sharp_angle=60)
    thicken_shell(ob, 1, thickness=0.012)
    rim = opening_rim(ob, 'coaming', r=0.022, mat='Seat', inset=0.004)
    return ob, rim


def build_cockpits():
    mb = MB('cockpit')
    # floors and front/rear bulkheads of both cockpits (dark interior)
    for (xf, xr, hw), floor in ((CK_F, -0.40), (CK_R, -0.36)):
        # floor: follows the inside of the skin
        xs_f = [xr - 0.05 + (xf - xr + 0.1) * k / 8 for k in range(9)]
        coords = []
        for x in xs_f:
            w = BODY.half_width_at(x, floor) - 0.012
            coords += [V(x, -w, floor), V(x, w, floor)]
        mb.faces(coords, [[2 * k, 2 * k + 2, 2 * k + 3, 2 * k + 1] for k in range(8)], 'Interior')
        # bulkheads: the fuselage section, shrunk 1.5 %, facing into the cockpit
        for xb, sgn in ((xf + 0.03, -1), (xr - 0.03, 1)):
            c = V(xb, 0, BODY.zw(xb))
            ring = [c + (p - c) * 0.985 for p in BODY.ring(xb, 48)]
            ring = [p + V(sgn * 0.003, 0, 0) for p in ring]
            idx = list(range(len(ring)))
            mb.faces(ring, [idx if sgn < 0 else idx[::-1]], 'Interior', smooth=False)
    # leather seats (wicker-backed buckets of the period)
    for hip, back in ((PILOT_HIP, 10), (PASS_HIP, 8)):
        mb.box(hip + V(0.10, 0, -0.12), (0.44, 0.46, 0.08), 'Seat', bevel=0.03, segs=2)
        mb.box(hip + V(-0.14, 0, 0.18), (0.06, 0.46, 0.56), 'Seat', bevel=0.03, segs=2,
               rot=Euler((0, math.radians(-back), 0)))
        mb.box(hip + V(0.10, 0, -0.22), (0.38, 0.40, 0.12), 'Interior', bevel=0.02, segs=1)
    # pilot's instrument board (wood) under the rear windscreen: ASI, altimeter, rev counter, rotor
    # rev counter, oil pressure; compass below
    # (compass in the middle of the board, out of the way of the hanging column)
    panel(mb, V(-0.635, 0, 0.36), 0.50, 0.18, 12, gauges=True, glare=False, center='compass')
    # passenger's small board (altimeter + rev counter)
    panel(mb, V(0.11, 0, 0.36), 0.40, 0.14, 12, gauges=True, glare=False, center=None)
    # rotor-starter (red) and wheel-brake levers on the right wall: nodes pivoting at their foot
    for name, x, col in (('starter_lever', -0.92, 'Paint_Accent'), ('brake_lever', -0.98, 'Paint_Dark')):
        p0 = V(x, -0.30, -0.05)
        mb.box(p0 + V(0, -0.014, 0), (0.05, 0.012, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
        lv = MB(name)
        lv.cyl(p0 + V(0, -0.010, 0), p0 + V(0, 0.012, 0), 0.012, 'Metal_Frame', n=12)
        lv.cyl(p0, V(x + 0.05, -0.27, 0.22), 0.007, 'Metal_Frame', n=8)
        lv.sphere(V(x + 0.05, -0.27, 0.23), 0.018, col, seg=10, rings=6)
        lv.finish(origin=p0, sharp_angle=40)
    # tail-wheel foot bar on a vertical pin
    mb.cyl(FOOT_BAR + V(0, 0, -0.012), V(FOOT_BAR.x, 0, -0.37), 0.016, 'Metal_Frame', n=12)
    mb.box(V(FOOT_BAR.x, 0, -0.365), (0.10, 0.08, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    fb = MB('foot_bar')
    fb.cyl(FOOT_BAR + V(0, 0.22, 0), FOOT_BAR + V(0, -0.22, 0), 0.014, 'Metal_Frame', n=10)
    fb.cyl(FOOT_BAR + V(0, 0, -0.016), FOOT_BAR + V(0, 0, 0.018), 0.022, 'Metal_Frame', n=14)
    for sy in (1, -1):
        fb.box(V(-0.37, sy * 0.16, -0.30), (0.03, 0.10, 0.10), 'Metal_Frame', bevel=0.006, segs=1)
    fb.finish(origin=FOOT_BAR, sharp_angle=40)
    # fuel filler cap on the decking ahead of the passenger
    mb.cyl(V(0.62, 0, 0.552), V(0.62, 0, 0.585), 0.05, 'Metal_Frame', n=20)
    return mb.finish(sharp_angle=40, wn=True)


def windscreen(name, x0, x1, z0, z1, hw, bow=0.05):
    """Small curved screen: base at x0 (front), top at x1 (raked back), rounded top corners."""
    mb = MB(name)
    nu, nv = 18, 8
    rows = []
    for j in range(nv + 1):
        v = j / nv
        row = []
        for i in range(nu + 1):
            u = -1 + 2 * i / nu
            w = hw * (1 - 0.35 * v * v) * (1.0 if v < 0.75 else math.sqrt(max(0.05, 1 - ((v - 0.75) / 0.25) ** 2 * 0.6)))
            x = lerp(x0, x1, v) - bow * u * u
            row.append(V(x, u * w, lerp(z0, z1, v)))
        rows.append(row)
    coords = [p for r in rows for p in r]
    faces = [[j * (nu + 1) + i, j * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i + 1, (j + 1) * (nu + 1) + i]
             for j in range(nv) for i in range(nu)]
    mb.faces(coords, faces, 'Glass')
    glass = mb.finish(sharp_angle=80)
    fr = MB(name + '_frame')
    edge = rows[0][::-1] + [r[0] for r in rows] + rows[-1] + [r[-1] for r in rows][::-1]
    fr.tube(edge, 0.008, 'Metal_Frame', n=8, cap=True)
    return glass, fr.finish(sharp_angle=50)


def lens_fin(mb, xs, lo_fn, hi_fn, half_t_fn, mat='Paint_White', n=14):
    """Thin vertical surface: for each x a lens-shaped section from z=lo to z=hi."""
    rings = []
    for x in xs:
        lo, hi = lo_fn(x), hi_fn(x)
        t = half_t_fn(x)
        if hi - lo < 0.004:
            rings.append([V(x, 0, (lo + hi) / 2)])
            continue
        ring = []
        for k in range(n):
            a = TAU * k / n
            s = 0.5 - 0.5 * math.cos(a)                 # 0 at bottom, 1 at top
            z = lerp(lo, hi, s)
            y = t * math.sin(a) * (1 - 0.6 * abs(math.cos(a)) ** 6)
            ring.append(V(x, y, z))
        rings.append(ring)
    mb.loft(rings, mat, closed=True)


FIN_HI = [(-1.20, 0.505), (-1.40, 0.53), (-1.60, 0.56), (-1.85, 0.62), (-2.05, 0.69), (-2.30, 0.725),
          (-2.70, 0.72), (-3.10, 0.67), (-3.50, 0.60), (-3.80, 0.52), (-4.05, 0.40), (-4.18, 0.27),
          (-4.25, 0.14), (-4.275, 0.04)]
FIN_LO = [(-1.20, 0.48), (-3.30, 0.20), (-3.42, -0.05), (-3.52, -0.27), (-3.65, -0.355), (-3.85, -0.37),
          (-4.02, -0.32), (-4.14, -0.23), (-4.22, -0.10), (-4.275, 0.04)]
VENTRAL = [(-1.80, -0.40), (-1.95, -0.50), (-2.20, -0.59), (-2.60, -0.61), (-3.00, -0.58), (-3.14, -0.50),
           (-3.22, -0.36)]


def build_tail():
    mb = MB('tail')
    # upper fin, running from the pilot's headrest fairing to the rounded tail
    xs = [-1.20 - 0.05 * k for k in range(62)] + [-4.275]

    def half_t(x):
        if x > -1.6:
            return lerp(0.10, 0.045, (-1.2 - x) / 0.4)         # headrest fairing blending into the fin
        return max(0.008, 0.045 * min(1.0, (x + 4.275) / 0.5) ** 0.5)
    lens_fin(mb, xs, lambda x: interp(FIN_LO, x), lambda x: interp(FIN_HI, x), half_t)
    # ventral fin
    xv = [-1.80 - 0.06 * k for k in range(24)]
    lens_fin(mb, xv, lambda x: interp(VENTRAL, x), lambda x: BODY.zb(x) + 0.06,
             lambda x: 0.02 if x > -3.2 else 0.012)
    # tailplane: no elevators; port half cambered downward, starboard upward (engine torque)
    ch = TP_LE - TP_TE
    inc = math.radians(2.0)
    rings = []
    for y in (-TP_HALF, -0.85, -0.5, -0.2, -0.08, 0.08, 0.2, 0.5, 0.85, TP_HALF):
        m = 0.035 if y < 0 else -0.035
        loop = airfoil_ring(14, 0.10, m=m, p=0.4, te_min=0.002)
        ring = []
        for s, tz in loop:
            x = TP_LE - s * ch
            z = TP_Z + tz * ch + (x - TP_LE) * math.sin(inc)
            ring.append(V(x, y, z))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # upturned tips (fixed fins at 44 deg) with rounded outer corners; trimming extension on each
    a = math.radians(TIP_ANG)
    for sy in (1, -1):
        root = V(0, sy * (TP_HALF - 0.02), TP_Z)
        d = V(0, sy * math.cos(a), math.sin(a))
        nrm = V(0, -sy * math.sin(a), math.cos(a))
        rings = []
        ctip, r_c = 0.72, 0.12
        us = [0.0, 0.1, 0.3, 0.5, 0.7, 0.8, 0.86, 0.91, 0.95, 0.98, 1.0]
        for u in us:
            span = u * TIP_LEN
            k = max(0.0, (span - (TIP_LEN - r_c)) / r_c)
            inset = r_c * (1 - math.sqrt(max(0.0, 1 - k * k)))
            le = -2.78 - inset
            c = max(0.02, ctip - 2 * inset)
            loop = airfoil_ring(12, 0.09, te_min=0.0015)
            rings.append([root + d * span + V(le - s * c, 0, 0) + nrm * (tz * c) for s, tz in loop])
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
        tab = root + d * (TIP_LEN * 0.55) + V(-2.78 - 0.72, 0, 0)
        mb.box(tab + V(-0.04, 0, 0), (0.08, 0.004, 0.004), 'Metal_Frame', rot=None)
        mb.faces([tab + d * -0.10, tab + d * 0.10, tab + d * 0.10 + V(-0.07, 0, 0), tab + d * -0.10 + V(-0.07, 0, 0)],
                 [[0, 1, 2, 3], [3, 2, 1, 0]], 'Paint_White', smooth=False)
        # V struts from the tailplane underside to the bottom longeron
        apex = V(-3.12, sy * 0.13, BODY.zb(-3.12) + 0.03)
        for xs_ in (-2.97, -3.27):
            mb.cyl(apex, V(xs_, sy * 0.62, TP_Z - 0.02), 0.012, 'Paint_White', n=8)
    # tailwheel spring box under the tail post
    mb.box(V(-3.31, 0, -0.29), (0.10, 0.08, 0.05), 'Metal_Frame', bevel=0.01, segs=1)
    return mb.finish(sharp_angle=45)


def build_tailwheel():
    nb = MB('nose_wheel')          # node-contract name: the steerable wheel (here at the tail)
    c = TAIL_C
    nb.lathe(B.tire_profile(TAIL_R, 0.075, 0.09), c, V(0, 1, 0), 'Rubber', n=32, closed_profile=True)
    nb.lathe([(0.0, -0.03), (0.03, -0.03), (0.04, -0.02), (0.07, -0.03), (0.078, -0.032), (0.078, 0.032),
              (0.07, 0.03), (0.04, 0.02), (0.03, 0.03), (0.0, 0.03)], c, V(0, 1, 0), 'Paint_Dark', n=24)
    nb.cyl(c + V(0, -0.06, 0), c + V(0, 0.06, 0), 0.01, 'Metal_Frame', n=10)
    for sy in (1, -1):
        nb.cyl(TAIL_PIVOT + V(0, sy * 0.055, -0.03), c + V(0, sy * 0.055, 0), 0.013, 'Metal_Frame', n=10)
    nb.cyl(TAIL_PIVOT + V(0, 0, 0.02), TAIL_PIVOT + V(0, 0, -0.04), 0.022, 'Metal_Frame', n=12)
    nb.box(TAIL_PIVOT + V(0, 0, -0.04), (0.05, 0.13, 0.03), 'Metal_Frame', bevel=0.006, segs=1)
    return nb.finish(origin=TAIL_PIVOT, sharp_angle=40)


def body_top_z(x, y):
    """Height of the fuselage's upper surface at (x, y) (Body.ring: (y/hw)^e_side + (dz/h)^e_top = 1)."""
    zt, hw, zw = BODY.zt(x), BODY.hw(x), BODY.zw(x)
    t = min(1.0, abs(y) / hw)
    return zw + (zt - zw) * max(0.0, 1 - t ** BODY.e_side) ** (1 / BODY.e_top)


def body_entry(p, d, step=0.002):
    """First point of the ray p + d*s that is inside the fuselage (below its upper surface)."""
    s = 0.0
    while s < 3.0:
        q = p + d * s
        if abs(q.y) < BODY.hw(q.x) and q.z <= body_top_z(q.x, q.y):
            return q
        s += step
    raise ValueError('leg misses the fuselage')


def body_normal(x, y, e=0.004):
    gx = (body_top_z(x + e, y) - body_top_z(x - e, y)) / (2 * e)
    gy = (body_top_z(x, y + e) - body_top_z(x, y - e)) / (2 * e)
    return V(-gx, -gy, 1.0).normalized()


def build_pylon():
    mb = MB('pylon')
    # four streamlined legs down to the top longerons: each leg runs on until it meets the rounded
    # decking (photos: the feet sit ON the fuselage shoulders, ~0.2 m below the top line) and ends in a
    # faired shoe on a bolted plate. The old feet stopped ~0.2 m above the skin and looked loose.
    for sy in (1, -1):
        for top, fx, sq in ((V(0.28, sy * 0.09, 1.33), 0.38, (0.07, 0.035)),
                            (V(-0.05, sy * 0.09, 1.35), -0.42, (0.06, 0.03))):
            # aim 2 cm under the skin at |y| 0.33 (the legs splay about as steeply as the shoulder curves)
            foot = V(fx, sy * 0.33, body_top_z(fx, 0.33) - 0.02)
            d = (foot - top).normalized()
            hit = body_entry(top, d)
            mb.tube([top, hit + d * 0.03], 0.0, 'Paint_White', n=14, square=(sq[0], sq[1], 2.2), cap=True)
            n = body_normal(hit.x, hit.y)
            ax = (V(1, 0, 0) - n * n.x).normalized()
            R = controls.basis(ax, n.cross(ax), n)
            # shoe: the leg section flares into the plate
            mb.tube([hit - d * 0.07, hit - d * 0.02, hit + d * 0.01], [0.0, 0.0, 0.0], 'Paint_White', n=14,
                    square=(sq[0] * 1.45, sq[1] * 1.6, 2.2), cap=True)
            mb.box(hit - n * 0.002, (0.13, 0.085, 0.012), 'Metal_Frame', bevel=0.004, segs=1, rot=R)
            for bx in (-0.045, 0.045):
                for by in (-0.028, 0.028):
                    mb.cyl(hit + ax * bx + n.cross(ax) * by + n * 0.003, hit + ax * bx + n.cross(ax) * by + n * 0.008,
                           0.006, 'Metal_Frame', n=8)
            print('  pylon leg foot on the skin at (%.3f, %.3f, %.3f)' % tuple(hit))
    mb.cyl(V(0.33, 0.0, 0.50), V(0.20, 0.0, 1.33), 0.018, 'Metal_Frame', n=10)
    # streamline fairing round the head: blunt rounded front, pointed tail, slanted underside
    top = [(0.33, 1.66), (0.30, 1.71), (0.27, 1.72), (-0.02, 1.72), (-0.52, 1.47)]
    bot = [(0.33, 1.29), (-0.52, 1.47)]
    wid = [(0.335, 0.0), (0.33, 0.07), (0.315, 0.12), (0.29, 0.145), (0.20, 0.155), (0.0, 0.15),
           (-0.25, 0.10), (-0.45, 0.035), (-0.52, 0.0)]
    rings = []
    xs = [0.335, 0.333, 0.33, 0.32, 0.30, 0.26, 0.2, 0.1, 0.0, -0.1, -0.2, -0.3, -0.4, -0.46, -0.5, -0.52]
    for x in xs:
        zt, zb, w = interp(top, x), interp(bot, x), interp(wid, x)
        if w < 1e-3:
            rings.append([V(x, 0, (zt + zb) / 2)])
            continue
        ring = []
        for k in range(28):
            a = TAU * k / 28
            c, s = math.cos(a), math.sin(a)
            z = (zt + zb) / 2 + (zt - zb) / 2 * sgnpow(c, 2 / 3.0)
            ring.append(V(x, w * sgnpow(s, 2 / 2.2), z))
        rings.append(ring)
    mb.loft(rings, 'Paint_White', closed=True)
    return mb.finish(sharp_angle=50, wn=True)


def build_main_gear():
    mb = MB('main_gear')
    x0, yw, zw = MAIN_C
    for sy in (1, -1):
        K = V(0.99, sy * 1.14, -0.44)
        A = V(x0, sy * 1.25, zw)
        # long-travel oil-and-spring leg: fat upper cylinder, slimmer sliding tube, gaiter
        mid = K + (A - K) * 0.55
        mb.cyl(K + (A - K) * -0.03, mid, 0.048, 'Paint_White', n=16)
        mb.cyl(mid - (A - K) * 0.02, A, 0.032, 'Metal_Frame', n=14)
        mb.cyl(mid - (A - K) * 0.05, mid + (A - K) * 0.04, 0.052, 'Rubber', n=16)
        # outrigger, upper strut and the two radius rods of the pyramid
        mb.cyl(K, V(0.99, sy * 0.38, -0.44), 0.028, 'Paint_White', n=12)
        mb.cyl(K, V(0.92, sy * 0.43, 0.07), 0.022, 'Paint_White', n=12)
        mb.tube([A, V(0.66, sy * 0.34, -0.45)], 0.0, 'Paint_White', n=12, square=(0.06, 0.03, 2.2), cap=True)
        mb.tube([A + V(-0.03, 0, 0.02), V(0.00, sy * 0.34, -0.47)], 0.0, 'Paint_White', n=12,
                square=(0.075, 0.035, 2.2), cap=True)
        mb.sphere(K, 0.04, 'Metal_Frame', seg=12, rings=8)
        mb.cyl(A, V(x0, sy * (yw + 0.09), zw), 0.022, 'Metal_Frame', n=10)        # stub axle
        mb.box(A + V(0, sy * 0.03, 0), (0.09, 0.05, 0.09), 'Metal_Frame', bevel=0.01, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    wheels = []
    for name, sy in (('wheel_L', 1), ('wheel_R', -1)):
        wb = MB(name)
        c = V(x0, sy * yw, zw)
        tyre(wb, c, MAIN_R, MAIN_W, 0.15, hub_mat='Paint_Dark')
        wheels.append(wb.finish(origin=c, sharp_angle=40))
    return gear, wheels


def build_engine_group():
    mb = build_radial(ENGINE_C, crank_r=0.19, cyl_len=0.27, bore=0.108, head_r=0.46)
    ax = V(1, 0, 0)
    # big exhaust collector ring behind the cylinders + its down pipe (the black ring in the photos)
    c = V(1.04, 0, ENGINE_C.z)
    ring = [c + V(0, math.sin(TAU * k / 64), math.cos(TAU * k / 64)) * 0.475 for k in range(64)]
    closed_tube(mb, ring, 0.042, 'Exhaust', n=14)
    mb.tube(catmull([c + V(0, 0.0, -0.47), c + V(-0.03, 0, -0.60), c + V(-0.08, 0, -0.70)], 4), 0.04,
            'Exhaust', n=12, cap=True)
    for k in range(7):
        a = TAU * k / 7
        d = V(0, math.sin(a), math.cos(a))
        mb.tube(catmull([ENGINE_C + d * 0.40 - ax * 0.07, ENGINE_C + d * 0.46 - ax * 0.18, c + d * 0.475], 3),
                0.022, 'Exhaust', n=8, cap=True)
    # mount: ring on the firewall and tubes to the crankcase rear
    for k in range(4):
        a = TAU * (k + 0.5) / 4
        d = V(0, math.sin(a), math.cos(a))
        mb.cyl(V(1.10, 0, ENGINE_C.z) + d * 0.30, ENGINE_C - ax * 0.12 + d * 0.15, 0.016, 'Paint_Dark', n=8)
    mb.lathe([(0.0, 1.095), (0.31, 1.095), (0.31, 1.11), (0.0, 1.11)], V(0, 0, ENGINE_C.z), ax, 'Paint_Dark', n=36)
    return mb.finish(sharp_angle=38, wn=True)


def decal_disc(target, cx, cz, rings_cols, side, name):
    """Concentric coloured rings (outer first) projected onto the target from the side."""
    mb = MB(name)
    radii = [r for r, _ in rings_cols] + [0.0]
    for (r0, col), r1 in zip(rings_cols, radii[1:]):
        n = 64
        for k in range(n):
            a0, a1 = TAU * k / n, TAU * (k + 1) / n
            pts = []
            for rr, aa in ((r0, a0), (r0, a1), (r1, a1), (r1, a0)):
                wx, wz = cx + rr * math.cos(aa), cz + rr * math.sin(aa)
                hit, loc, nrm, _ = target.ray_cast(V(wx, side * 2.0, wz), V(0, -side, 0))
                pts.append(loc + nrm * 0.002 if hit else V(wx, side * 0.4, wz))
            f = [0, 1, 2, 3] if side < 0 else [3, 2, 1, 0]
            mb.faces(pts, [f], col, smooth=False)
    return mb.finish(sharp_angle=89, recalc=False, merge=1e-5)


def decal_poly(target, polys, side, name, mat, y0=2.0):
    """Flat polygons (lists of (x, z)) projected onto the target from the side."""
    mb = MB(name)
    for poly in polys:
        pts = []
        for wx, wz in poly:
            hit, loc, nrm, _ = target.ray_cast(V(wx, side * y0, wz), V(0, -side, 0))
            pts.append(loc + nrm * 0.003 if hit else V(wx, side * 0.05, wz))
        idx = list(range(len(pts)))
        mb.faces(pts, [idx if side < 0 else idx[::-1]], mat, smooth=False)
    return mb.finish(sharp_angle=89, recalc=False, merge=1e-5)


def build_markings(fus, tail):
    obs = []
    # Ejercito del Aire roundel (red / yellow / red) on the rear fuselage sides
    for side in (1, -1):
        obs.append(decal_disc(fus, -1.78, 0.04, [(0.22, 'Paint_Accent'), (0.147, 'Roundel_Yellow'),
                                                  (0.073, 'Paint_Accent')], side, 'roundel_' + str(side)))
    # fin: black St Andrew's cross on a white square
    cx, cz, h = -3.15, 0.40, 0.13
    sq = [(cx + h, cz - h), (cx + h, cz + h), (cx - h, cz + h), (cx - h, cz - h)]
    w = 0.028
    bar1 = [(cx + h, cz + h - w), (cx + h - w, cz + h), (cx - h, cz - h + w), (cx - h + w, cz - h)]
    bar2 = [(cx - h + w, cz + h), (cx - h, cz + h - w), (cx + h - w, cz - h), (cx + h, cz - h + w)]
    for side in (1, -1):
        # (rays start between the fin and the upturned tips, so they land on the fin)
        obs.append(decal_poly(tail, [sq], side, 'finflash_' + str(side), 'Flash_White', y0=0.3))
        o = decal_poly(tail, [bar1, bar2], side, 'saltire_' + str(side), 'Paint_Dark', y0=0.3)
        for v in o.data.vertices:
            v.co.y += side * 0.0015
        obs.append(o)
    return obs


def build_crew():
    pilot.ensure_materials()
    d = V(0, 0, 1)
    ctrl = MB('controls_static')
    knob, lever = controls.throttle_lever(ctrl, THROTTLE_PIVOT, length=0.10, brake=False)
    pf = pilot.build_pilot('pilot_front', PILOT_HIP, 10,
                           hands={'R': ('stick', GRIP, d), 'L': ('knob', knob, lever)},
                           feet={'L': V(-0.40, 0.15, -0.31), 'R': V(-0.40, -0.15, -0.31)},
                           helmet='leather', elbow_out=0.05, rig=True)
    pr = pilot.build_pilot('pilot_rear', PASS_HIP, 8,
                           hands={'R': ('rest', PASS_HIP + V(0.22, -0.13, 0.20), None),
                                  'L': ('rest', PASS_HIP + V(0.22, 0.13, 0.20), None)},
                           feet={'L': V(0.47, 0.15, -0.36), 'R': V(0.47, -0.15, -0.36)},
                           helmet='leather', knee_out=0.03, elbow_out=0.04)
    return pf, pr, ctrl.finish(sharp_angle=40)


# ---------------------------------------------------------------------------
REQUIRED = {
    'rotor': (HUB.x, HUB.z, 0.0), 'rotor_head': (HEAD_PIVOT.x, HEAD_PIVOT.z, 0.0),
    'prop': (PROP_C.x, PROP_C.z, 0.0), 'nose_wheel': (TAIL_PIVOT.x, TAIL_PIVOT.z, 0.0),
    'wheel_L': (MAIN_C[0], MAIN_C[2], -MAIN_C[1]), 'wheel_R': (MAIN_C[0], MAIN_C[2], MAIN_C[1]),
    'stick': (HEAD_PIVOT.x, HEAD_PIVOT.z, 0.0), 'pilot_front': None, 'pilot_rear': None, 'eye_front': None,
    'throttle': None, 'brake_lever': None, 'starter_lever': None,
    'foot_bar': (FOOT_BAR.x, FOOT_BAR.z, 0.0),
}
REQUIRED.update(controls.rig_nodes('pilot_front'))


def build_all():
    fus, rim = build_fuselage()
    cockpit = build_cockpits()
    ws1, fr1 = windscreen('ws_rear', -0.575, -0.70, 0.50, 0.72, 0.22, bow=0.06)
    ws2, fr2 = windscreen('ws_front', 0.155, 0.075, 0.535, 0.65, 0.20, bow=0.04)
    pylon = build_pylon()
    tail = build_tail()
    gear, wheels = build_main_gear()
    build_tailwheel()
    engine = build_engine_group()
    build_wood_prop(PROP_C, PROP_R, pitch_ratio=0.62, spin=-1, body_mat='Prop_Metal', tip_mat='Paint_Accent')
    build_c30_rotor(HUB, ROTOR_R, CHORD, BLADE_ROOT)
    build_c30_head(HEAD_PIVOT, HUB)
    build_hanging_stick(HEAD_PIVOT, GRIP)
    _pf, _pr, ctrl = build_crew()
    marks = build_markings(fus, tail)
    code = []
    try:
        from build_ela import build_registration
        code = build_registration(fus, LIVERY['code'], cx=0.45, cz=0.12, size=0.075, mat='Paint_Dark')
    except Exception as ex:          # fonts unavailable: no code letters
        print('  !! code letters skipped:', ex)
    # pilot's eye (rear cockpit), from pilot.py: hip + back recline -> head centre, eyes 8 cm ahead
    b = math.radians(10)
    u = V(-math.sin(b), 0, math.cos(b))
    eye = PILOT_HIP + u * 0.63 + V(0.035 + 0.08, 0, 0.072)
    make_eye(eye)
    REQUIRED['eye_front'] = (eye.x, eye.z, 0.0)
    airframe = B.join_objects('airframe', [fus, rim, cockpit, ctrl, fr1, fr2, pylon, tail, gear, engine] + marks
                              + code)
    glass = B.join_objects('windscreen', [ws1, ws2])
    glass.name = 'windscreen'
    for ob in bpy.context.scene.collection.objects:
        ob.rotation_euler = (0, 0, 0)
        ob.scale = (1, 1, 1)
        ob.parent = None
    return airframe


# ---------------------------------------------------------------------------
# Previews: parked attitude (tail on the ground, 10 deg) on the studio floor, plus a level ortho side
# view framed like the NACA drawing for an overlay check.
# ---------------------------------------------------------------------------
REST_PITCH = math.atan2((TAIL_C.z - TAIL_R) - (MAIN_C[2] - MAIN_R), MAIN_C[0] - TAIL_C.x)
PREVIEWS = {
    'three_quarter_front': dict(loc=(9.0, 7.0, 2.6), target=(-0.6, 0.0, 0.7), lens=30, rotor=-20, prop=30),
    'side': dict(loc=(-0.8, 22.0, 0.6), target=(-0.8, 0.0, 0.6), ortho=12.4, rotor=0, prop=90),
    'rear_three_quarter': dict(loc=(-10.0, -7.5, 3.2), target=(-0.8, 0.0, 0.7), lens=32, rotor=40, prop=20),
    'front': dict(loc=(14.0, 0.0, 0.4), target=(0.0, 0.0, 0.4), ortho=7.0, rotor=90, prop=90),
    'top': dict(loc=(-0.8, 0.0, 30.0), target=(-0.8, 0.0, 0.0), ortho=12.0, rotor=30, prop=90),
    'cockpit_closeup': dict(loc=(1.6, 2.6, 2.2), target=(-0.6, 0.0, 0.7), lens=30, rotor=75, prop=30),
    'engine_closeup': dict(loc=(3.6, 1.8, 0.9), target=(1.2, 0.0, 0.0), lens=40, rotor=75, prop=30),
    'tail_closeup': dict(loc=(-1.4, 3.0, 1.2), target=(-3.2, 0.0, 0.2), lens=35, rotor=75, prop=30),
    'photo_museo': dict(loc=(6.2, 4.6, 0.3), target=(-0.2, 0.0, 0.5), lens=28, rotor=-35, prop=60),
}
LEVEL_SIDE = dict(x0=-4.4, x1=2.0, z0=-1.6, z1=2.1)   # same window as the NACA crop used for tracing


def stand_objects(scn, on):
    """Parent everything to a stand rotated to the parked attitude, wheels on the floor (z=-1.05)."""
    st = bpy.data.objects.get('stand')
    if st is None:
        st = bpy.data.objects.new('stand', None)
        scn.collection.objects.link(st)
        for ob in list(scn.collection.objects):
            if ob is not st and ob.type in ('MESH', 'EMPTY') and ob.name not in ('ground',):
                ob.parent = st
    if on:
        piv = V(MAIN_C[0], 0, MAIN_C[2] - MAIN_R)
        rot = Matrix.Rotation(-REST_PITCH, 4, 'Y')
        m = Matrix.Translation(V(0, 0, -1.05)) @ rot @ Matrix.Translation(-piv)
        st.matrix_world = m
    else:
        st.matrix_world = Matrix.Identity(4)


def render_previews(scn):
    B.setup_render(scn)
    coll, cam = B.setup_studio(scn)
    samples = int(arg('--samples', '96'))
    try:
        scn.cycles.samples = samples
    except Exception:
        pass
    only = arg('--only', None)
    only = set(only.split(',')) if only else None
    rotor = bpy.data.objects.get('rotor')
    prop = bpy.data.objects.get('prop')
    out = os.path.join(HERE, 'previews', 'cierva')
    os.makedirs(out, exist_ok=True)
    stand_objects(scn, True)
    for name, v in PREVIEWS.items():
        if only and name not in only:
            continue
        B.aim(cam, v['loc'], v['target'], v.get('lens', 50), v.get('ortho'))
        rotor.rotation_euler = (0, 0, math.radians(v['rotor']))
        prop.rotation_euler = (math.radians(v['prop']), 0, 0)
        scn.render.filepath = os.path.join(out, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
    if not only or 'level_side' in only:
        # level, orthographic, framed exactly like the traced drawing window; floor hidden
        stand_objects(scn, False)
        g = bpy.data.objects.get('ground')
        if g:
            g.hide_render = True
        L = LEVEL_SIDE
        w, h = L['x1'] - L['x0'], L['z1'] - L['z0']
        rx = 1600
        scn.render.resolution_x = rx
        scn.render.resolution_y = int(round(rx * h / w))
        cx, cz = (L['x0'] + L['x1']) / 2, (L['z0'] + L['z1']) / 2
        B.aim(cam, (cx, 30.0, cz), (cx, 0.0, cz), ortho=w)
        rotor.rotation_euler = (0, 0, math.radians(180))
        prop.rotation_euler = (math.radians(90), 0, 0)
        scn.render.filepath = os.path.join(out, 'level_side.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
    rotor.rotation_euler = (0, 0, 0)
    prop.rotation_euler = (0, 0, 0)


def main():
    scn = B.reset_scene()
    build_c30_materials(LIVERY)
    build_all()
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    B.check_normals()
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:
        pass
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, NAME + '.blend'))
    except RuntimeError as ex:
        print('  !! could not save .blend:', ex)
    B.GLB_PATH = os.path.join(ROOT, 'public', 'models', NAME + '.glb')
    B.REQUIRED = REQUIRED
    B.export_glb()
    B.verify_glb(B.GLB_PATH)
    print('REST_PITCH deg', math.degrees(REST_PITCH))
    pr = bpy.data.objects.get('pilot_rear')
    if pr and '--show-rear' not in ARGV:
        pr.hide_render = True
    if '--previews' in ARGV:
        render_previews(scn)


if __name__ == '__main__':
    main()
