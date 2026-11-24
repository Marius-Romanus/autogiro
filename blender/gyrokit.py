"""
Shared kit for the gyroplanes added after the ELAs and the Cierva: AutoGyro MT-03, Calidus and
Cavalon, ELA 07 Scorpion, DTA J-RO, Niki Lightning, Carter PAV and Sport Copter Lightning.

Every aircraft is traced on side photos / factory three-views in a HUB FRAME: origin on the rotor
teeter bolt (head un-tilted), X forward, Z up, metres. `Ref(cg)` turns that frame into model
coordinates, whose origin is placed so that the centre of gravity falls on (0.08, 0.10) like every
model of the sim (CG_COMMON in src/sim/airframes.ts). Blender axes: +X forward, +Y left, +Z up.

Reuses build_autogiro.py (mesh builder, engine, wheels, export, previews), build_ela.py (stationed
fuselage, seats, fins) and pilot.py / controls.py / panel.py (crew, moving controls, instrument panel).
build_mt03.py is the worked example.

HOW A MODEL IS TRACED (what made the MT-03 match its photo at the first render)
1. Pick the purest side photo (camera level, far away, whole aircraft). Overlay a pixel grid on zoomed
   crops and read pixel coordinates of every feature (nose tip, belly line, rims, mast foot and top,
   prop hub and tips, keel bends, fin/rudder corners, wheel centres and tyre bottoms).
2. Scale (px per metre) from something of known size seen edge-on: propeller diameter (blade tips;
   for a 3-blader solve the two visible blades), wheel diameter, a dimensioned three-view; check it
   against the published overall length and height.
3. Camera yaw from the two main wheels: sin(yaw) = (near wheel x - far wheel x) / (track in px).
   If the FAR wheel appears nearer the TAIL the camera stands BEHIND the pure side view (negative yaw
   for render_overlay); off-centre parts (end fins, spats) shift by y*sin(yaw), lengths shrink by
   cos(yaw). Ground line = mean of both main tyre bottoms (the near one looks lower).
4. Convert to the hub frame: X = (x - x_hub) / (ppm * cos(yaw)) (sign so that the nose is +X),
   Z = (y_hub - y) / ppm. Trace in that frame; never eyeball.
5. Centre of gravity: the sim's flight model is validated with the hub 0.33 m BEHIND the CG (rotor
   thrust line through the CG with the fuselage level), so CG = (0.33, z) in the hub frame; z from
   published vertical limits when they exist (AutoGyro: UK CAA data sheets, datum = main wheel axle),
   else 0.80-0.90 m above the main axle. (The data-sheet longitudinal CG, almost under the hub, makes
   the model fly very nose-high and tail-slide power off.) Ref(cg) then fixes the model origin.
6. Build, then `--overlay yaw,cx,cz,ppm,w,h[,side]` renders an orthographic view from the photo's
   direction at the photo's scale on a transparent film (cx, cz = model point at the picture centre:
   cx = hub.x - (x_hub_px - w/2)/ppm, cz = hub.z - (h/2 - y_hub_px)/ppm for a nose-right photo; side
   -1 = camera on the right of the aircraft, nose to the right of the picture; +1 = from the left).
   Composite it over the photo and correct the numbers until the outlines coincide.
7. Noses: never a cap whose slope differs from the last station (linear_nose with nose_exp =
   cap length x convergence rate / section height, or nose_curve); it shows as a knob.
8. Crew: K.print_joints + K.clearance; the passenger is hidden in previews (--show-rear).
9. Judge the overlay on the EDGE at 4x zoom, part by part (nose, canopy front, tail), not on the whole
   photo at 45 %: a profile 5 cm proud of the real one with an S-bend passed the whole-photo look on
   the ELA 10 and showed in the sim as a hump on the nose. Recipe: crop the overlay's alpha,
   `-threshold 60% -scale 400% -morphology EdgeOut Diamond:1`, tint it and composite on the same crop of
   the photo. A top or bottom line must only curve one way unless the photo clearly shows otherwise.
10. Do NOT draw panel seams, door / hatch cut lines or cowl joints as thin dark tubes on the paint: in
   the sim they read as pen lines and break into dashes at a distance (removed from every model after
   the owner's review). Keep only what is really dark and wide: glazing seals and frames, window
   frames, livery stripes, decals. Hinges, latches and caps are enough to suggest a door or a hatch.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import build_autogiro as B  # noqa: E402
import build_ela as E  # noqa: E402
import pilot  # noqa: E402
import controls  # noqa: E402
import panel as PANEL  # noqa: E402
from build_autogiro import (V, MB, MATS, TAU, hermite, lerp, sgnpow, catmull, airfoil_ring, naca4, link,  # noqa: E402,F401
                            apply_mods, boundary_loops, resample_loop, closed_tube, mark_sharp,
                            remove_faces_with_material)

ROOT = os.path.dirname(HERE)
ARGV = B.ARGV


def arg(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return default


class Ref:
    """Hub frame (X forward, Z up, origin on the teeter bolt) -> model coordinates."""
    CG_MODEL = (0.08, 0.10)

    def __init__(self, cg):
        self.cg = cg
        self.dx = self.CG_MODEL[0] - cg[0]
        self.dz = self.CG_MODEL[1] - cg[1]

    def __call__(self, X, Z, y=0.0):
        return V(X + self.dx, y, Z + self.dz)

    def x(self, X):
        return X + self.dx

    def z(self, Z):
        return Z + self.dz

    def pts(self, pts):
        return [(X + self.dx, Z + self.dz) for X, Z in pts]

    def table(self, rows):
        """Fuselage stations (X, zt, zu, wu, zc, wc, zb) in the hub frame -> model."""
        return [(r[0] + self.dx, r[1] + self.dz, r[2] + self.dz, r[3], r[4] + self.dz, r[5], r[6] + self.dz)
                for r in rows]


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
EXTRA_MATS = (
    ('Alu_Gold', '#B49238', dict(metal=1.0, rough=0.34)),
    ('Alu_Blue', '#2456B8', dict(metal=1.0, rough=0.30)),
    ('Alu_Black', '#1B1C1F', dict(metal=0.8, rough=0.38)),
    ('Chrome', '#E6E8EA', dict(metal=1.0, rough=0.08)),
    ('Steel_Exhaust', '#8E857A', dict(metal=1.0, rough=0.45)),
    ('Rotax_Cover', '#1E8F86', dict(metal=0.3, rough=0.35)),
    ('Radiator', '#1A1B1D', dict(metal=0.6, rough=0.6)),
    ('Lens_Red', '#D8141C', dict(rough=0.12, emit='#D8141C', emit_strength=0.5)),
    ('Lens_Green', '#12B455', dict(rough=0.12, emit='#12B455', emit_strength=0.5)),
    ('Lens_White', '#F2F5FA', dict(rough=0.10, emit='#F2F5FA', emit_strength=0.35)),
    ('Lens_Amber', '#F08A12', dict(rough=0.12, emit='#F08A12', emit_strength=0.4)),
    ('Decal_Black', '#0C0D0E', dict(rough=0.4)),
    ('Decal_White', '#F2F2F0', dict(rough=0.4)),
    ('Wood', '#8A5A2B', dict(rough=0.35)),
)


def ensure_materials():
    for name, hexc, kw in EXTRA_MATS:
        if name in MATS:
            continue
        kw = dict(kw)
        if 'emit' in kw:
            kw['emit'] = B.srgb(kw['emit'])
        B.make_mat(name, B.srgb(hexc), **kw)


def set_paint(name, hexcol, metal=0.0, rough=0.2):
    E.set_paint(name, hexcol, metal, rough)


def shift(ob, d):
    ob.location += Vector(d)
    return ob


def rot_y(deg):
    return Euler((0, math.radians(deg), 0))


# ---------------------------------------------------------------------------
# Rotor (node `rotor`, origin on the teeter bolt)
# ---------------------------------------------------------------------------
def _blade(mb, hub, R, chord, root, tc, pitch_deg, precone_deg, az, drop, mat, tip_mat, tip_len, camber=0.0,
           tip_weight=None, taper=None):
    loop = airfoil_ring(14, tc, m=camber, te_min=0.0035)
    pitch = Matrix.Rotation(math.radians(pitch_deg), 3, 'X')
    cone = Matrix.Rotation(math.radians(-precone_deg), 3, 'Y')
    spin = Matrix.Rotation(az, 3, 'Z')

    def chord_at(r):
        if taper is None:
            return chord
        return lerp(chord, chord * taper, max(0.0, (r - root) / (R - root)))

    def section(r, c, thick=1.0):
        ring = []
        for s, tz in loop:
            p = pitch @ Vector(((0.0), (0.25 - s) * c, tz * c * thick))
            ring.append(hub + spin @ (cone @ Vector((r, p.y, p.z - drop))))
        return ring

    r_tip0 = R - min(0.5 * chord, 0.12)
    n_mid = max(4, int((r_tip0 - tip_len - root) / 0.45))
    rs = [root, root + 0.04] + [lerp(root + 0.04, r_tip0 - tip_len, k / n_mid) for k in range(1, n_mid + 1)]
    mb.loft([section(r, chord_at(r)) for r in rs], mat, closed=True, cap0=True)
    mb.loft([section(r_tip0 - tip_len, chord_at(r_tip0 - tip_len)), section(r_tip0, chord_at(r_tip0))], tip_mat,
            closed=True)
    tip = []
    for k in range(0, 9):
        u = k / 8.0
        r = r_tip0 + (R - r_tip0) * math.sin(0.5 * math.pi * u)
        if k == 8:
            tip.append([section(r, 0.02, 0.6)[0]])
        else:
            tip.append(section(r, max(chord_at(R) * math.cos(0.5 * math.pi * u) ** 0.6, 0.02), 1.0 - 0.35 * u))
    mb.loft(tip, tip_mat, closed=True)
    if tip_weight:
        # streamlined tip weight pod ahead of the leading edge (Carter)
        length, rad = tip_weight
        c0 = hub + spin @ (cone @ Vector((R - 0.10, 0.25 * chord_at(R) + 0.3 * length, -drop)))
        d = spin @ Vector((0, 1, 0))
        prof = [(0.0, -0.6 * length)] + [(rad * math.sin(math.pi * k / 10) ** 0.7, lerp(-0.6, 0.4, k / 10) * length)
                                        for k in range(1, 10)] + [(0.0, 0.4 * length)]
        mb.lathe(prof, c0, d, tip_mat, n=14)


def build_rotor(hub, R=4.2, chord=0.20, blades=2, root=0.52, tc=0.12, pitch_deg=2.5, precone_deg=1.3, name='rotor',
                mat='Rotor_Blade', tip_mat='Paint_Accent', tip_len=0.16, under=0.045, bar_mat='Engine',
                clamp_len=0.46, clamp_mat='Alu_Black', tower_h=0.105, camber=0.0, tip_weight=None, taper=None,
                bar_w=0.11):
    """Teetering rotor (2 blades) or rigid star hub (3+). The hub bar hangs `under` below the teeter bolt
    between two tower plates; each blade root is sandwiched between ribbed clamp plates with two rows of
    bolts, as on the AutoGyro / ELA / Averso extruded blades."""
    ensure_materials()
    mb = MB(name)
    cone = math.radians(precone_deg)
    for b in range(blades):
        az = TAU * b / blades
        _blade(mb, hub, R, chord, root, tc, pitch_deg, precone_deg, az, under, mat, tip_mat, tip_len, camber,
               tip_weight, taper)
        spin = Matrix.Rotation(az, 4, 'Z')
        T = Matrix.Translation(hub) @ spin @ Matrix.Rotation(-cone, 4, 'Y')

        def P(r, y, z):
            return T @ Vector((r, y, z - under))
        rot = (spin @ Matrix.Rotation(-cone, 4, 'Y'))
        # hub bar half (rectangular aluminium bar)
        mb.box(P(root * 0.5 + 0.02, 0, 0), (root + 0.04, bar_w, 0.05), bar_mat, bevel=0.006, segs=2, rot=rot)
        # clamp plates above and below the blade root + bolts
        c_mid = root - 0.10 + clamp_len * 0.5
        for sz in (1, -1):
            mb.box(P(c_mid, 0.25 * chord - 0.5 * chord + 0.02, sz * (0.06 * chord + 0.012)),
                   (clamp_len, chord * 0.86, 0.014), clamp_mat, bevel=0.004, segs=1, rot=rot)
        nb = max(4, int(clamp_len / 0.065))
        for k in range(nb):
            r = root - 0.07 + (clamp_len - 0.06) * k / (nb - 1)
            for y in (0.25 * chord - 0.16 * chord, 0.25 * chord - 0.72 * chord):
                mb.cyl(P(r, y, 0.06 * chord + 0.026), P(r, y, -0.06 * chord - 0.026), 0.0065, 'Metal_Frame', n=6)
    # teeter block, towers and bolt
    mb.box(hub - V(0, 0, under), (0.17, bar_w + 0.012, 0.062), bar_mat, bevel=0.008, segs=2)
    if blades == 2:
        for sy in (1, -1):
            mb.box(hub + V(0, sy * (bar_w * 0.5 + 0.022), -tower_h * 0.5 + 0.03), (0.10, 0.016, tower_h + 0.06),
                   bar_mat, bevel=0.008, segs=2)
            mb.cyl(hub + V(0, sy * (bar_w * 0.5 + 0.012), 0), hub + V(0, sy * (bar_w * 0.5 + 0.046), 0), 0.017,
                   'Metal_Frame', n=12)
        mb.cyl(hub + V(0, -(bar_w * 0.5 + 0.05), 0), hub + V(0, bar_w * 0.5 + 0.05, 0), 0.0095, 'Metal_Frame', n=10)
    # base plate that bolts on the bearing spindle
    mb.lathe([(0.0, -tower_h - 0.012), (0.082, -tower_h - 0.012), (0.082, -tower_h), (0.06, -tower_h + 0.01),
              (0.0, -tower_h + 0.01)], hub, V(0, 0, 1), bar_mat, n=28)
    return mb.finish(origin=hub, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Rotor head (node `rotor_head`, origin on the pitch pivot)
# ---------------------------------------------------------------------------
def build_head(pivot, hub, tower_h=0.105, ring_r=0.125, arm=-0.24, arm_w=0.24, plate_mat='Alu_Gold',
               bendix=True, name='rotor_head'):
    """Gimbal head of the AutoGyro / ELA family: bridge plate on the pitch pivot with a control arm
    (aft if arm < 0) whose cross bar takes the two push rods, roll hinge, bearing housing, pre-rotator
    ring gear and Bendix drive."""
    ensure_materials()
    mb = MB(name)
    c = Vector(pivot)
    top = hub.z - tower_h - 0.012           # under the rotor base plate
    ax = V(hub.x, 0, 0)
    zp = c.z + 0.032                        # bridge plate
    # gimbal block + pitch axle
    mb.box(c, (0.09, 0.07, 0.05), 'Engine', bevel=0.01, segs=2)
    mb.cyl(c + V(0, -0.07, 0), c + V(0, 0.07, 0), 0.011, 'Metal_Frame', n=10)
    # bridge plate (anodised) with the roll hinge along it
    mb.box(V(c.x + arm * 0.42, 0, zp), (abs(arm) + 0.15, 0.115, 0.02), plate_mat, bevel=0.007, segs=2)
    mb.cyl(V(c.x - 0.075, 0, zp - 0.004), V(c.x + 0.075, 0, zp - 0.004), 0.016, 'Engine_Dark', n=14)
    # control arm end: cross bar with rod-end forks
    xa = c.x + arm
    mb.box(V(xa, 0, zp), (0.035, arm_w + 0.03, 0.02), plate_mat, bevel=0.006, segs=1)
    for sy in (1, -1):
        mb.cyl(V(xa, sy * arm_w * 0.5, zp - 0.022), V(xa, sy * arm_w * 0.5, zp + 0.022), 0.011, 'Metal_Frame', n=10)
    # bearing housing and spindle
    z0 = zp + 0.010
    mb.lathe([(0.0, z0), (0.058, z0), (0.064, z0 + 0.008), (0.064, top - 0.012), (0.05, top - 0.004), (0.036, top),
              (0.0, top)], ax, V(0, 0, 1), 'Engine', n=28)
    # pre-rotator ring gear (toothed rim)
    zr = min(top - 0.022, max(z0 + 0.02, (z0 + top) * 0.5 + 0.006))
    mb.lathe([(0.066, zr - 0.010), (ring_r - 0.006, zr - 0.010), (ring_r, zr - 0.006), (ring_r, zr + 0.006),
              (ring_r - 0.006, zr + 0.010), (0.066, zr + 0.010)], ax, V(0, 0, 1), 'Engine_Dark', n=48,
             closed_profile=True)
    for k in range(48):
        a = TAU * k / 48
        mb.box(V(hub.x + math.cos(a) * (ring_r + 0.002), math.sin(a) * (ring_r + 0.002), zr), (0.008, 0.008, 0.014),
               'Engine_Dark', rot=Euler((0, 0, a)))
    if bendix:
        # Bendix pinion housing and the upper end of the drive shaft, behind the ring gear
        xb = hub.x - ring_r - 0.012 if arm < 0 else hub.x + ring_r + 0.012
        mb.cyl(V(xb, 0.0, zr + 0.02), V(xb, 0.0, zr - 0.085), 0.022, 'Engine_Dark', n=14)
        mb.cyl(V(xb, 0.0, zr - 0.085), V(xb, 0.0, zr - 0.13), 0.013, 'Metal_Frame', n=10)
    return mb.finish(origin=pivot, sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Propeller (node `prop`, origin on the hub centre, axis X)
# ---------------------------------------------------------------------------
def build_prop(c, R=0.86, blades=3, hub='spinner', mat='Carbon', tip_mat='Paint_White', chord_k=1.0, pitch=1.15,
               hub_r=0.112, hub_len=0.25, tip_band=0.06, spinner_mat='Paint_Accent', name='prop', scimitar=0.0,
               tractor=False):
    """Pusher propeller seen in the generic model, with selectable hub: 'spinner' (pointed cone aft),
    'drum' (bare aluminium hub with a hollow extension, as on the MT-03) or 'flange' (plain plates,
    wooden two-blader). scimitar > 0 sweeps the tips back (Carter)."""
    ensure_materials()
    mb = MB(name)
    c = Vector(c)
    s = -1.0 if not tractor else 1.0        # spinner points aft on a pusher
    if hub == 'spinner':
        prof = [(0.0, 0.075), (hub_r, 0.075)]
        for k in range(13):
            u = k / 12.0
            prof.append((hub_r * max(0.0, 1 - u ** 1.9) ** 0.55 if k < 12 else 0.0, 0.07 - hub_len * u))
        mb.lathe([(r, a * -s) for r, a in prof], c, V(1, 0, 0), spinner_mat, n=40)
        mb.lathe([(0.0, 0.085), (hub_r + 0.006, 0.085), (hub_r + 0.006, 0.075), (0.0, 0.075)], c, V(-s, 0, 0),
                 'Engine', n=40)
    elif hub == 'drum':
        mb.lathe([(0.0, 0.07), (hub_r, 0.07), (hub_r + 0.004, 0.06), (hub_r + 0.004, -0.045), (hub_r, -0.055),
                  (0.03, -0.055), (0.03, -0.06)], c, V(-s, 0, 0), 'Engine', n=36)
        mb.lathe([(0.0, -0.06), (0.034, -0.06), (0.034, -0.06 - hub_len), (0.026, -0.065 - hub_len),
                  (0.018, -0.065 - hub_len), (0.018, -0.03 - hub_len), (0.0, -0.03 - hub_len)], c, V(-s, 0, 0),
                 'Chrome', n=24)
        for k in range(6):
            a = TAU * k / 6
            p = c + V(0, math.cos(a) * hub_r * 0.62, math.sin(a) * hub_r * 0.62)
            mb.cyl(p + V(s * 0.062, 0, 0), p + V(s * 0.048, 0, 0), 0.009, 'Metal_Frame', n=6)
    else:
        mb.lathe([(0.0, 0.03), (hub_r, 0.03), (hub_r, 0.022), (hub_r * 0.7, 0.022), (hub_r * 0.7, -0.022),
                  (hub_r, -0.022), (hub_r, -0.03), (0.0, -0.03)], c, V(1, 0, 0), 'Engine', n=28)
        for k in range(6):
            a = TAU * k / 6
            p = c + V(0, math.cos(a) * hub_r * 0.6, math.sin(a) * hub_r * 0.6)
            mb.cyl(p + V(0.036, 0, 0), p + V(-0.036, 0, 0), 0.007, 'Metal_Frame', n=6)
    k_r = R / 0.86
    stations = [x * k_r for x in (0.075, 0.10, 0.14, 0.20, 0.28, 0.36, 0.45, 0.55, 0.65, 0.74)] + \
               [R - tip_band, R - tip_band * 0.42, R - tip_band * 0.13, R]

    def chord(r):
        u = r / k_r
        if u < 0.14:
            cc = lerp(0.050, 0.085, (u - 0.075) / 0.065)
        elif u < 0.30:
            cc = lerp(0.085, 0.105, (u - 0.14) / 0.16)
        else:
            cc = lerp(0.105, 0.060, (u - 0.30) / 0.50)
        return cc * chord_k * (0.75 + 0.25 * k_r)

    rings = []
    r_band = R - tip_band
    for r in stations:
        tip_u = max(0.0, (r - r_band) / (R - r_band))
        cc = chord(min(r, r_band)) * math.sqrt(max(0.0, 1 - tip_u ** 2)) if r < R else 0.0
        beta = min(math.atan(pitch * k_r / (TAU * max(r, 0.14 * k_r))), math.radians(48))
        u = r / k_r
        if u < 0.13:
            tc, cam = lerp(0.55, 0.16, (u - 0.075) / 0.055), 0.0
        else:
            tc, cam = lerp(0.12, 0.07, min(1.0, (u - 0.13) / 0.73)), 0.035
        sweep = -scimitar * max(0.0, (r - 0.45 * R) / (0.55 * R)) ** 2 * R
        if r >= R - 1e-6:
            rings.append([c + V(0.0, sweep, R)])
            continue
        ring = []
        for sc, tz in airfoil_ring(10, tc, m=cam, p=0.4, te_min=0.0015):
            ch = (0.35 - sc) * max(cc, 0.012)
            th = tz * max(cc, 0.012)
            ring.append(c + V(ch * math.sin(beta) + th * math.cos(beta), ch * math.cos(beta) - th * math.sin(beta) + sweep,
                              r))
        rings.append(ring)
    split = stations.index(R - tip_band)
    bm = mb.bm
    f_before = set(bm.faces)
    mb.loft(rings[:split + 1], mat, closed=True, cap0=True)
    mb.loft(rings[split:], tip_mat, closed=True)
    blade_faces = list(set(bm.faces) - f_before)
    verts = list({v for f in blade_faces for v in f.verts})
    for k in range(1, blades):
        ret = bmesh.ops.duplicate(bm, geom=verts + list({e for f in blade_faces for e in f.edges}) + blade_faces)
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=c, matrix=Matrix.Rotation(TAU * k / blades, 3, 'X'))
    return mb.finish(origin=c, sharp_angle=50, merge=1e-5)


# ---------------------------------------------------------------------------
# Wheels, nose gear, spats
# ---------------------------------------------------------------------------
def wheel(name, c, R=0.19, w=0.11, rim_r=None, brake=True):
    """Main wheel node (origin on the axle centre). Brake disc on the inboard side."""
    ob = B.build_wheel(name, Vector(c), R, w, rim_r if rim_r else R * 0.60)
    return ob


def nose_gear(c, R=0.175, w=0.10, leg_top=None, fork_mat='Metal_Frame', mudguard=None, name='nose_wheel',
              rake=0.0, single=False):
    """Steerable nose wheel + fork + leg, one node with the origin on the wheel centre.
    leg_top: z (model) where the leg enters the hull."""
    c = Vector(c)
    nb = MB(name)
    nb.lathe(B.tire_profile(R, R * 0.56, w), c, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    hw = w * 0.36
    nb.lathe([(0.0, -hw), (0.03, -hw), (0.045, -hw * 0.75), (R * 0.55, -hw * 0.95), (R * 0.6, -hw),
              (R * 0.6, hw), (R * 0.55, hw * 0.95), (0.045, hw * 0.75), (0.03, hw), (0.0, hw)], c, V(0, 1, 0),
             'Engine', n=28)
    yf = w * 0.5 + 0.022
    nb.cyl(c + V(0, -yf - 0.008, 0), c + V(0, yf + 0.008, 0), 0.010, 'Metal_Frame', n=10)
    zt = R + 0.045
    sides = (1,) if single else (1, -1)
    for sy in sides:
        nb.tube(catmull([c + V(0.0, sy * yf, 0.0), c + V(rake * 0.4, sy * (yf + 0.002), zt * 0.55),
                         c + V(rake, sy * (yf - 0.004), zt)], 4), 0.0, fork_mat, n=16, square=(0.014, 0.045, 5),
                cap=True)
    nb.box(c + V(rake, 0, zt + 0.008), (0.06, 2 * yf + 0.02, 0.028), fork_mat, bevel=0.008, segs=2)
    top = (leg_top if leg_top is not None else c.z + zt + 0.14)
    nb.cyl(c + V(rake, 0, zt + 0.01), V(c.x + rake, 0, top), 0.020, 'Metal_Frame', n=14)
    if mudguard:
        arc = [c + V(math.cos(math.radians(lerp(20, 160, k / 14))) * (R + 0.025), 0,
                     math.sin(math.radians(lerp(20, 160, k / 14))) * (R + 0.025)) for k in range(15)]
        nb.tube(arc, 0.0, mudguard, n=16, square=(w + 0.03, 0.008, 6), cap=True)
    return nb.finish(origin=c, sharp_angle=40)


def spat(name, c, R=0.19, front=0.33, back=0.30, hw=0.105, top=0.115, lift=0.07, mat='Paint_White', cut=True,
         tail_up=0.05, exp_top=2.0, belly=0.6):
    """Teardrop wheel spat round a wheel at `c`: `front`/`back` lengths from the axle, top `top` above
    the tyre, the tail rising by `tail_up`. The wheel shows through a slot underneath."""
    c = Vector(c)
    x0, x1 = c.x + front, c.x - back
    zc0 = c.z + lift
    ht_u = R + top - lift
    ht_d = lift + R * belly
    rings = [[V(x0, c.y, zc0 - 0.02)]]
    n = 32
    us = [0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.96, 1.0]
    u_max = front / (front + back)
    for u in us:
        x = lerp(x0, x1, u)
        # thickness law with its maximum over the axle
        t = u / u_max if u < u_max else (1 - u) / (1 - u_max)
        f = math.sin(0.5 * math.pi * min(1.0, t)) ** (0.62 if u < u_max else 1.25)
        f = max(f, 0.02)
        zc = zc0 - 0.02 * (1 - u) + tail_up * max(0.0, (u - u_max) / (1 - u_max)) ** 1.5
        ring = []
        for k in range(n):
            a = TAU * k / n
            ca, sa = math.cos(a), math.sin(a)
            ring.append(V(x, c.y + sgnpow(ca, 2 / 2.3) * (hw * f + 0.003),
                          zc + (sgnpow(sa, 2 / exp_top) * ht_u if sa > 0 else sgnpow(sa, 2 / 2.6) * ht_d) * f))
        rings.append(ring)
    mb = MB(name)
    mb.loft(rings, mat, closed=True, cap1=True)
    ob = mb.finish(sharp_angle=70)
    if cut:
        cm = MB('spatcut')
        cm.box((c.x, c.y, c.z - R), (2 * R * 0.98, hw * 1.5, 2 * R * 0.62), mat, bevel=0.04, segs=3)
        B.boolean_cut_shell(ob, cm.finish(sharp_angle=80))
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    apply_mods(ob)
    return ob


def leg_blade(mb, pts, chord=0.10, thick=0.03, mat='Paint_White', n=20):
    """Spring leg / strut with a rounded-rectangle section swept along pts (catmull)."""
    mb.tube(catmull([Vector(p) for p in pts], 6), 0.0, mat, n=n, square=(chord, thick, 5), cap=True)


# ---------------------------------------------------------------------------
# Hull helpers
# ---------------------------------------------------------------------------
def cut_openings(pod, rims, rim_r=0.014, rim_mat='Seat', thickness=0.012, name='cockpit_rim'):
    """Open cockpits: `rims` = list of side-view polylines (model x, z), each from rear to front; every
    face above a polyline (within its x range) is removed, the edge gets a padded rim and the shell an
    inner skin."""
    me = pod.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for rim in rims:
        E.bisect_all(bm, [E.plane_pts(a, b) for a, b in zip(rim, rim[1:]) if abs(a[0] - b[0]) > 1e-6])
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        f.smooth = True
        for rim in rims:
            if rim[0][0] < c.x < rim[-1][0]:
                for (x0, z0), (x1, z1) in zip(rim, rim[1:]):
                    if x0 <= c.x <= x1 and x1 > x0 and c.z > lerp(z0, z1, (c.x - x0) / (x1 - x0)):
                        kill.append(f)
                        break
    bmesh.ops.delete(bm, geom=list(set(kill)), context='FACES')
    bm.to_mesh(me)
    bm.free()
    rim_ob = E.opening_rim(pod, name, r=rim_r, mat=rim_mat, inset=0.004)
    E.thicken_shell(pod, len(me.materials), thickness)
    return rim_ob


def split_glass(pod, inside, frame_r=0.008, frame_mat='Paint_White', seal=True, thickness=0.012, name='canopy'):
    """Closed cabin: faces whose centre satisfies inside(c) become the canopy (separate Glass object).
    Returns (canopy, frame, seal_or_None). The pod keeps the rest and gets an inner skin."""
    me = pod.data
    me.materials.append(MATS['Glass'])
    gi = len(me.materials) - 1
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.smooth = True
        if inside(f.calc_center_median()):
            f.material_index = gi
    bm.to_mesh(me)
    bm.free()
    can_me = me.copy()
    can = bpy.data.objects.new(name, can_me)
    link(can)
    bm = bmesh.new()
    bm.from_mesh(can_me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != gi], context='FACES')
    for f in bm.faces:
        f.material_index = 0
    bm.to_mesh(can_me)
    bm.free()
    can_me.materials.clear()
    can_me.materials.append(MATS['Glass'])
    remove_faces_with_material(pod, 'Glass')
    frame = E.opening_rim(pod, name + '_frame', r=frame_r, mat=frame_mat, inset=0.004)
    sl = E.opening_rim(pod, name + '_seal', r=frame_r * 0.75, mat='Paint_Dark', inset=0.010) if seal else None
    E.thicken_shell(pod, gi, thickness)
    return can, frame, sl


def repaint(ob, test, mat):
    """Give material `mat` to the faces whose centre satisfies test(c) (two-tone liveries, cheeks)."""
    me = ob.data
    names = [m.name for m in me.materials]
    if mat not in names:
        me.materials.append(MATS[mat])
        names.append(mat)
    idx = names.index(mat)
    for p in me.polygons:
        if test(p.center):
            p.material_index = idx


def paint_band(ob, planes, test, mat):
    """Bisect along side-view lines first so the colour boundary is crisp, then repaint."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    E.bisect_all(bm, planes)
    bm.to_mesh(ob.data)
    bm.free()
    repaint(ob, test, mat)


def _inside(poly, x, z):
    return PANEL.inside(poly, x, z)


def bisect_poly(bm, poly):
    planes = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        if (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 > 1e-10:
            planes.append(E.plane_pts(a, b))
    E.bisect_all(bm, planes)


def cut_polys(pod, polys, rim_r=0.014, rim_mat='Seat', thickness=0.012, name='cockpit_rim', keep=None):
    """Open cockpits from closed side-view polygons (model x, z): faces whose centre falls inside any
    polygon are removed (unless keep(c) says otherwise); padded rim on the edge, inner skin."""
    me = pod.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for poly in polys:
        bisect_poly(bm, poly)
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        f.smooth = True
        if any(_inside(poly, c.x, c.z) for poly in polys) and not (keep and keep(c)):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    n_outer = len(me.materials)
    rim_ob = E.opening_rim(pod, name, r=rim_r, mat=rim_mat, inset=0.004)
    E.thicken_shell(pod, n_outer, thickness)
    return rim_ob


def paint_poly(ob, poly, mat, test=None):
    """Crisp two-tone paint: bisect along a side-view polygon (model x, z) and repaint what is inside."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bisect_poly(bm, poly)
    bm.to_mesh(ob.data)
    bm.free()
    repaint(ob, lambda c: _inside(poly, c.x, c.z) and (test is None or test(c)), mat)


def recess_rear(pod, x_rear, depth=0.08, inset=0.02, mat='Interior'):
    """Turn the flat rear cap of a hull into a shallow recess (pods whose open back wraps the engine)."""
    me = pod.data
    names = [m.name for m in me.materials]
    if mat not in names:
        me.materials.append(MATS[mat])
        names.append(mat)
    mi = names.index(mat)
    bm = bmesh.new()
    bm.from_mesh(me)
    caps = [f for f in bm.faces if all(abs(v.co.x - x_rear) < 1e-4 for v in f.verts)]
    ret = bmesh.ops.inset_region(bm, faces=caps, thickness=inset, depth=0.0)
    for v in {v for f in caps for v in f.verts}:
        v.co.x += depth
    for f in caps + ret['faces']:
        f.material_index = mi
        f.smooth = False
    bm.to_mesh(me)
    bm.free()


def print_joints(name, ref):
    """Joint positions of a pilot in the hub frame (to tune seats, pedals and panel)."""
    J = pilot.JOINTS.get(name)
    if not J:
        return
    for k in ('hip', 'knee', 'ankle', 'shoulder', 'elbow', 'wrist'):
        v = J.get(k, {}).get('L')
        if v is not None:
            print('  joint %s %-8s X %.3f  y %.3f  Z %.3f' % (name, k, v.x - ref.dx, v.y, v.z - ref.dz))


def clearance(a_names, b_objs, label=''):
    """Print the overlap between crew parts (objects whose name starts with one of a_names) and b_objs."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()

    def tree(o):
        bm = bmesh.new()
        bm.from_object(o, dg)
        bm.transform(o.matrix_world)
        t = BVHTree.FromBMesh(bm)
        bm.free()
        return t
    bt = [(o.name, tree(o)) for o in b_objs if o is not None]
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not any(o.name.startswith(n) for n in a_names):
            continue
        ta = tree(o)
        for bn, tb in bt:
            hits = ta.overlap(tb)
            if hits:
                print('  !! clearance%s: %s crosses %s (%d face pairs)' % (label, o.name, bn, len(hits)))


# ---------------------------------------------------------------------------
# Small details
# ---------------------------------------------------------------------------
def lamp(mb, p, d, kind='white', r=0.022, length=0.03, base='Paint_Dark'):
    """Small faired lamp: base + coloured lens bulging along d."""
    ensure_materials()
    p, d = Vector(p), Vector(d).normalized()
    lens = {'red': 'Lens_Red', 'green': 'Lens_Green', 'white': 'Lens_White', 'amber': 'Lens_Amber'}[kind]
    mb.lathe([(0.0, -0.004), (r * 1.15, -0.004), (r * 1.15, 0.004), (r, 0.006)], p, d, base, n=16)
    mb.lathe([(r, 0.006), (r * 0.92, length * 0.5), (r * 0.6, length * 0.86), (0.0, length)], p, d, lens, n=16)


def oval_lamp(mb, target, p, n, fwd, kind='white', a=0.035, b=0.016):
    """Flush oval marker lamp on a hull side (AutoGyro pods): lens patch shrink-wrapped on `target`."""
    ensure_materials()
    lens = {'red': 'Lens_Red', 'green': 'Lens_Green', 'white': 'Lens_White', 'amber': 'Lens_Amber'}[kind]
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    up = n.cross(fwd).normalized()
    inv = target.matrix_world.inverted()
    ring, ring2 = [], []
    for k in range(20):
        t = TAU * k / 20
        for rr, out, hh in ((1.0, ring, 0.002), (0.55, ring2, 0.009)):
            q = Vector(p) + fwd * (math.cos(t) * a * rr) + up * (math.sin(t) * b * rr) + n * 0.3
            ok, loc, _nn, _i = target.ray_cast(inv @ q, inv.to_3x3() @ (-n), distance=0.8)
            out.append((target.matrix_world @ loc if ok else Vector(p)) + n * hh)
    ctr = sum(ring2, Vector()) / len(ring2) + n * 0.003
    mb.loft([ring, ring2, [ctr]], lens, closed=True)


def pitot(mb, p, d=(1, 0, 0), length=0.16, r=0.006):
    p, d = Vector(p), Vector(d).normalized()
    mb.cyl(p, p + d * length, r, 'Metal_Frame', n=10)
    mb.lathe([(0.0, length), (r, length), (r * 0.7, length + 0.016), (0.0, length + 0.017)], p, d, 'Metal_Frame', n=10)


def antenna(mb, p, d=(-0.2, 0, 1), length=0.34, mat='Paint_Dark'):
    mb.lathe([(0.0, 0.0), (0.012, 0.0), (0.004, 0.02), (0.0025, length), (0.0, length + 0.002)], Vector(p),
             Vector(d).normalized(), mat, n=10)


def delta_plate(mb, stations, mat='Paint_White'):
    """Flat plate along a path on the centre plane: stations = [(point, half_width, thickness), ...] in
    order along the path (the plate may change slope from one station to the next). The ELA 07 keel truss
    carries one ("la aleta"): a delta with its apex FORWARD lying on the lower bar, its trailing edge just
    behind the node bolt, strut and tail boom landing on its top (build_ela07.py, build_scorpion.py)."""
    pts = [Vector(q[0]) for q in stations]
    rings = []
    for i, (q, hw, th) in enumerate(stations):
        q = Vector(q)
        d = (pts[min(len(pts) - 1, i + 1)] - pts[max(0, i - 1)]).normalized()
        up = Vector((-d.z, 0.0, d.x))
        if up.z < 0:
            up = -up
        hw = max(hw, 0.004)
        side, lift = Vector((0.0, hw, 0.0)), up * (0.5 * th)
        rings.append([q + lift + side, q + lift - side, q - lift - side, q - lift + side])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True, smooth=False)


def louvres(mb, target, p, n, fwd, count=4, length=0.16, pitch=0.035, depth=0.012, mat='Paint_Dark',
            body_mat=None, slant=0.0):
    """Row of cooling gills on a cowling side: each a dark slot with a raised lip above it, laid on
    `target` at p (outward normal n, slots running along fwd, stacked along the surface 'up')."""
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    up = n.cross(fwd).normalized()
    inv = target.matrix_world.inverted()

    def on(q, h):
        ok, loc, nn, _i = target.ray_cast(inv @ (q + n * 0.3), inv.to_3x3() @ (-n), distance=0.8)
        if not ok:
            return q + n * h, n
        nw = (target.matrix_world.to_3x3() @ nn).normalized()
        return target.matrix_world @ loc + nw * h, nw
    for i in range(count):
        o = Vector(p) + up * ((i - (count - 1) / 2) * pitch) + fwd * (slant * (i - (count - 1) / 2))
        lo, hi, lip = [], [], []
        m = 10
        for k in range(m + 1):
            t = k / m
            s = math.sin(math.pi * t) ** 0.35
            q = o + fwd * ((t - 0.5) * length)
            a, _ = on(q - up * (0.006 * s), 0.0015)
            b, _ = on(q + up * (0.006 * s), 0.0015)
            c, nw = on(q + up * (0.006 * s + 0.004), 0.0)
            lo.append(a)
            hi.append(b)
            lip.append(c + nw * (depth * s) - up * (0.008 * s))
        faces = []
        coords = lo + hi + lip
        for k in range(m):
            faces.append([k, k + 1, m + 2 + k, m + 1 + k])
        mb.faces(lo + hi, faces, mat, smooth=False)
        if body_mat:
            faces = [[k, k + 1, m + 2 + k, m + 1 + k] for k in range(m)]
            mb.faces(hi + lip, faces, body_mat)
    del coords


def exhaust_stub(mb, pts, r=0.022, mat='Steel_Exhaust'):
    mb.tube(catmull([Vector(p) for p in pts], 5), r, mat, n=12, cap=True)
    return mb


def decal_text(pod, text, cx, cz, size=0.10, mat='Paint_Dark'):
    return E.build_registration(pod, text, cx, cz, size=size, mat=mat)


def make_eye(p):
    return E.make_eye(Vector(p))


def lamp_node(kind, p, tag=None):
    """Empty `lamp_<kind>[_<tag>]`: one light emitter of the sim (src/aircraft/AircraftLights.ts).
    kind: navL (red, left = +Y), navR (green), tail (white, seen from behind), strobeL / strobeR (white
    double flash, both together), beacon (single flash, out of phase with the strobes; tag 'red' or
    'amber' gives that colour), landing (white beam forwards).
    As soon as a model declares ONE lamp the sim shows only the declared ones, so declare every light
    the real aircraft carries, each on its real lens, and none that it does not carry. Several lamps of
    one kind take different tags: lamp_node('landing', p, 'L'), lamp_node('landing', q, 'R'). All the
    landing lamps share one beam, from their mid point. Put the empty 2-3 cm outside the opaque surface
    (the glowing dot is depth-tested); a clear cover over it does not hide it."""
    ob = bpy.data.objects.new('lamp_' + kind + ('_' + str(tag) if tag else ''), None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.04
    ob.location = Vector(p)
    link(ob)
    return ob


# ---------------------------------------------------------------------------
# Rotax 912/914 (the generic engine, moved so that its prop flange is at `prop_c`)
# ---------------------------------------------------------------------------
def rotax(prop_c, covers='Rotax_Cover'):
    """Uncowled Rotax 912/914 with its accessories; prop_c = propeller hub centre (model)."""
    ensure_materials()
    eng = B.build_engine()
    shift(eng, Vector(prop_c) - B.PROP_C)
    if covers:
        # valve covers in the Rotax colour (teal on the 912, red on the 912 S / 914)
        me = eng.data
        d = Vector(prop_c) - B.PROP_C
        names = [m.name for m in me.materials]
        if covers not in names:
            me.materials.append(MATS[covers])
            names.append(covers)
        ci = names.index(covers)
        di = names.index('Engine_Dark') if 'Engine_Dark' in names else -1
        for p in me.polygons:
            c = p.center
            if p.material_index == di and abs(c.y) > 0.285 and abs(c.z - (-0.025)) < 0.07 and -1.30 < c.x < -0.85:
                p.material_index = ci
        del d
    return eng


# ---------------------------------------------------------------------------
# Assemble, export, previews
# ---------------------------------------------------------------------------
def finalize(static, glass):
    static = [o for o in static if o is not None]
    airframe = B.join_objects('airframe', static)
    glass = [g for g in glass if g is not None]
    if glass:
        g = B.join_objects('windscreen', glass) if len(glass) > 1 else glass[0]
        g.name = 'windscreen'
    for ob in bpy.context.scene.collection.objects:
        ob.rotation_euler = (0, 0, 0)
        ob.scale = (1, 1, 1)
        ob.parent = None
    return airframe


def required(nodes):
    """nodes: {name: Vector (model, Blender axes) or None}. Sets B.REQUIRED (glTF axes: y up, z right)."""
    req = {k: None for k in ('pilot_front', 'throttle', 'throttle_brake', 'pedal_L', 'pedal_R', 'panel_face', 'key')}
    for k in controls.rig_nodes('pilot_front'):
        req[k] = None
    for name, p in nodes.items():
        req[name] = None if p is None else (round(p.x, 4), round(p.z, 4), round(-p.y, 4))
    B.REQUIRED = req


OVERLAY = None   # (yaw_deg, centre (x, z) model, px_per_m, (w, h)) set with --overlay


def render_overlay(scn, path, yaw_deg, centre, ppm, size, side=-1):
    """Orthographic render from the camera direction of a reference photo, on a transparent film:
    yaw_deg = how far the camera sits ahead (+) of the pure side view; side -1 = seen from the right
    (nose to the right of the picture), +1 from the left."""
    B.setup_render(scn)
    scn.cycles.samples = 24
    scn.render.film_transparent = True
    scn.render.resolution_x, scn.render.resolution_y = size
    cam = bpy.data.cameras.new('OverlayCam')
    co = bpy.data.objects.new('OverlayCam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    a = math.radians(yaw_deg)
    tgt = Vector((centre[0], 0, centre[1]))
    d = Vector((math.sin(a), side * math.cos(a), 0.0))
    # (Blender applies the ortho scale to the LARGER image side: portrait overlays need the height)
    B.aim(co, tgt + d * 40.0, tgt, ortho=max(size) / ppm)
    sun = bpy.data.lights.new('OSun', 'SUN')
    sun.energy = 3.0
    so = bpy.data.objects.new('OSun', sun)
    so.rotation_euler = Euler((math.radians(50), 0, math.radians(20 if side < 0 else 160)), 'XYZ')
    scn.collection.objects.link(so)
    w = bpy.data.worlds.new('OW')
    scn.world = w
    try:
        w.use_nodes = True
        w.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
        w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    except Exception:
        pass
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('rendered overlay', path)


def run(name, build, livery=None, views=None, glb=None, rest_ground=None):
    """Build one aircraft: scene, materials, build(), checks, .blend + GLB, previews / photo overlay.
    Extra args: --previews [--only a,b] [--samples N] [--show-rear]
                --overlay yaw,cx,cz,ppm,w,h[,side]  (ortho render matching a reference photo)"""
    scn = B.reset_scene()
    B.build_materials()
    pilot.ensure_materials()
    ensure_materials()
    if livery:
        set_paint('Paint_White', *livery['body'])
        set_paint('Paint_Accent', *livery['accent'])
        set_paint('Paint_Dark', *livery['dark'])
        set_paint('Seat', *livery.get('seat', ('#141517', 0.0, 0.8)))
    build()
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    B.check_normals()
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:
        pass
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, name + '.blend'))
    except RuntimeError as ex:
        print('  !! could not save .blend:', ex)
    B.GLB_PATH = glb or os.path.join(ROOT, 'public', 'models', name + '.glb')
    if '--no-export' not in ARGV:
        B.export_glb()
        B.verify_glb(B.GLB_PATH)
    pr = bpy.data.objects.get('pilot_rear')
    if pr and '--show-rear' not in ARGV:
        pr.hide_render = True
    ov = arg('--overlay')
    if ov:
        f = [float(x) for x in ov.split(',')]
        out = arg('--overlay-out', os.path.join(HERE, 'previews', name, 'overlay.png'))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        render_overlay(scn, out, f[0], (f[1], f[2]), f[3], (int(f[4]), int(f[5])), side=int(f[6]) if len(f) > 6 else -1)
        return
    if B.DO_PREVIEWS:
        gz = rest_ground if rest_ground is not None else -1.05
        pv = {
            'three_quarter_front': dict(loc=(7.6, 6.3, 2.5), target=(-0.40, 0.0, 0.42), lens=33, rotor=-58, prop=20),
            'side': dict(loc=(0.0, 18.0, 0.30), target=(-0.4, 0.0, 0.30), ortho=9.4, rotor=0, prop=0),
            'top': dict(loc=(-0.3, 0.0, 30.0), target=(-0.3, 0.0, 0.0), ortho=9.6, rotor=30, prop=0),
            'rear_three_quarter': dict(loc=(-8.0, -6.6, 2.8), target=(-0.6, 0.0, 0.45), lens=35, rotor=-40, prop=40),
            # menu card picture (public/models/thumbs/<id>.jpg): render with --show-rear, then
            # magick <thumb.png> -resize 800x450 -quality 82 public/models/thumbs/<id>.jpg
            'thumb': dict(extra=True, loc=(5.2, -5.6, 4.6), target=(-0.5, 0.0, 0.0), lens=38, rotor=-25, prop=10),
            'photo_side': dict(extra=True, loc=(1.2, -16.0, 0.9), target=(-0.3, 0.0, 0.2), lens=85, rotor=-30, prop=10),
            'photo_front': dict(extra=True, loc=(9.0, 0.6, 0.15), target=(0.0, 0.0, 0.25), lens=55, rotor=90, prop=0),
            'tail_detail': dict(extra=True, loc=(-0.6, -3.4, 1.2), target=(-2.4, 0.0, -0.1), lens=40, rotor=75, prop=10),
            'nose_detail': dict(extra=True, loc=(3.8, -2.4, 0.3), target=(1.5, 0.0, -0.3), lens=45, rotor=75, prop=15),
            'engine_detail': dict(extra=True, loc=(-2.9, 2.0, 1.0), target=(-0.9, 0.0, 0.0), lens=45, rotor=75, prop=30),
            'head_detail': dict(extra=True, loc=(1.5, -1.5, 2.25), target=(0.1, 0.0, 1.55), lens=50, rotor=75, prop=0),
            'cockpit': dict(extra=True, loc=(2.0, 1.7, 1.5), target=(0.6, 0.0, 0.0), lens=32, rotor=75, prop=0),
        }
        if views:
            pv.update(views)
        B.PREVIEW_VIEWS = pv
        B.PREVIEW_DIR = os.path.join(HERE, 'previews', name)
        # the studio floor sits at z = -1.05: lift/lower the camera targets is not needed, but the
        # aircraft must stand on it, so shift the floor to the wheels of this aircraft
        _orig = B.setup_studio

        def studio(s):
            coll, cam = _orig(s)
            for o in coll.objects:
                if o.name.startswith('ground'):
                    o.location.z += gz + 1.05
            return coll, cam
        B.setup_studio = studio
        B.render_previews(scn)
