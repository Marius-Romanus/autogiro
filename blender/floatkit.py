"""
Amphibious float kits for the AutoGyro Cavalon (Cavalon Amphib, C-FGYE) and the MT-03 (MTOamphib-style kit),
used by `build_cavalon.py --floats` and `build_mt03.py --floats` (outputs public/models/<id>_floats.glb).

Everything is in MODEL coordinates (Blender axes: +X forward, +Y left, +Z up; the sim reads x forward, y up,
z right = -Blender y). A float is described by tables along x (hermite-interpolated, see FloatSpec):
centreline deck height, deck and chine half-widths, chine and keel heights (forebody / afterbody, with the
step between them), bow tip and transom. Sections: crowned flat deck with a rounded gunwale, sides flaring
out to a chine with a small spray rail, chined V bottom.

CAVALON (C-FGYE, ref/ag/image-42-e1679989922627.jpeg, taken from the aircraft's LEFT, about 5 m away with
a phone): the photo camera was solved from 12 points of the base Cavalon model (nose tip, spinner, nav
light, fuel filler, door window, fin corners; rms 9 px) and every float line was traced by intersecting
its pixel ray with the plane it lies in (float centreline y = 0.86, inner gunwale, outer chine). Results:
floats 4.69 m long, centrelines 1.72 m apart (2.2 m over the chines), deck 0.22 m wide flaring to a
0.48 m chine beam, 0.6 m deep at the step, deck sloping 1.4 deg nose-down against the cabin datum, step
0.55 m behind the sim CG (0.2 m behind the data-sheet CG). The cabin's composite main gear bow is kept,
reshaped to end on a block on each float; two front struts from the bow blocks to brackets on the nose
flanks, diagonal tubes from a cross tube under the belly to the bow-leg blocks, three spreader tubes with
a black mesh trampoline laced between them.

MT-03 (MTOamphib, ref/ag/AG-MTOAMPHIB-SHOT-BY-MAGNUS-HANSSON-SWEDEN.jpg: an MTOsport seen from its RIGHT
side, in flight, about 93 px/m; orthographic camera fitted on the pod nose, rotor head and prop hub, yaw 5 deg
behind the beam from the near/far bows): the Cavalon float lines scaled to 4.40 m and 0.44 m deep (POH float
supplement drawing: 4216 / 2200 mm; the photo gives 4.4 m bow under the pod nose to transom), deck level
0.18 m under the pod belly, painted in the body colour with a white bottom as on SE-..Z, full-height flat
transom; main struts clamped on the keel tube under the mast (as the photo's struts under the mast), front
struts to the nose-gear hardpoint, a V brace from the keel bend, three spreaders and a light deck mesh.

Nodes added: amph_main_L/R, amph_nose_L/R (wheel + fork + post, origin on the wheel centre, axle along
Blender Y, modelled DOWN; the sim raises them straight up by RETRACT into the wells), rudder_waterL/R
(origin on the vertical hinge at the transom, modelled down).
"""
import bpy, bmesh, math, os
from mathutils import Vector, Euler, Matrix

import gyrokit as K
from gyrokit import B, V, MB, MATS, TAU, lerp, catmull

GROUND_CLEAR = 0.13          # keel at the step above the ground with the wheels down


def ensure_mats():
    for name, hexc, kw in (('Float_White', '#EEF0F1', dict(rough=0.22)),
                           ('Float_Well', '#1A1B1D', dict(rough=0.7)),
                           ('Tramp_Black', '#141517', dict(rough=0.85)),
                           ('Tramp_Light', '#C9CCCF', dict(rough=0.8)),
                           ('Alu_Bare', '#B9BDC1', dict(metal=0.9, rough=0.32))):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexc), **kw)


def table(pairs):
    return B.hermite([p[0] for p in pairs], [p[1] for p in pairs])


class FloatSpec:
    """One float (the left one; the right one is its mirror). Tables are [(x, value)] in model metres.
    deck: centreline deck height; hd / hc: deck / chine half-widths; chine_f / keel_f: forebody (ahead of
    the step), chine_a / keel_a: afterbody."""

    def __init__(self, yc, x_bow, z_bow, x_tr, x_step, deck, hd, hc, chine_f, keel_f, chine_a, keel_a,
                 mat='Float_White', bottom_mat=None, rail_mat=None, crown=0.016):
        self.yc, self.x_bow, self.z_bow, self.x_tr, self.x_step = yc, x_bow, z_bow, x_tr, x_step
        self.deck, self.hd, self.hc = table(deck), table(hd), table(hc)
        self.chine_f, self.keel_f, self.chine_a, self.keel_a = table(chine_f), table(keel_f), table(chine_a), table(keel_a)
        self.mat, self.bottom_mat, self.rail_mat = mat, bottom_mat or mat, rail_mat or mat
        self.crown = crown

    def keel(self, x):
        return self.keel_f(x) if x >= self.x_step else self.keel_a(x)

    def chine(self, x):
        return self.chine_f(x) if x >= self.x_step else self.chine_a(x)

    def half_section(self, x, aft=None):
        """[(y, z, part)] from the deck centreline round the near side to the keel."""
        fore = (x >= self.x_step) if aft is None else not aft
        zd = self.deck(x)
        hd = max(self.hd(x), 0.004)
        hc = max(self.hc(x), hd + 0.004)
        zk = self.keel_f(x) if fore else self.keel_a(x)
        cr = min(self.crown, 0.25 * (zd - zk))
        rr = min(0.022, 0.35 * hd, 0.2 * (zd - zk))
        zg = zd - cr - rr                       # gunwale (bottom of its round)
        zc = self.chine_f(x) if fore else self.chine_a(x)
        zc = min(max(zc, zk + 0.25 * (zg - zk)), zg - 0.25 * (zg - zk))
        lip = min(0.012, 0.3 * hc)
        s = 'side'
        return [(0.0, zd, s), (0.55 * hd, zd - 0.3 * cr, s), (hd - rr * 0.4, zd - cr, s), (hd, zd - cr - rr * 0.6, s),
                (lerp(hd, hc, 0.40), lerp(zg, zc, 0.40), s), (lerp(hd, hc, 0.78), lerp(zg, zc, 0.78), s),
                (hc, zc + 0.012, 'rail'), (hc + lip, zc + 0.002, 'rail'), (hc - 0.004, zc - 0.010, 'bottom'),
                (0.58 * hc, lerp(zk, zc, 0.62), 'bottom'), (0.12 * hc, zk + 0.012 * hc / 0.24, 'bottom'), (0.0, zk, 'bottom')]

    def ring(self, x, sy, aft=None):
        h = self.half_section(x, aft)
        pts = [V(x, sy * (self.yc + y), z) for y, z, _ in h]
        pts += [V(x, sy * (self.yc - y), z) for y, z, _ in reversed(h[1:-1])]
        return pts

    def stations(self):
        """x of the rings: dense at the bow and the transom, a double ring at the step."""
        L = self.x_bow - self.x_tr
        xs = [self.x_bow - L * 0.12 * (k / 14.0) ** 2 for k in range(1, 15)]
        x = xs[-1]
        while x - 0.09 > self.x_tr + 0.12:
            x -= 0.09
            if abs(x - self.x_step) < 0.05:
                continue
            xs.append(x)
        xs += [self.x_tr + 0.08, self.x_tr + 0.035, self.x_tr + 0.01, self.x_tr]
        xs = sorted(set(round(v, 5) for v in xs), reverse=True)
        return xs


def build_float(name, F, sy, wells=()):
    """Float hull mesh, wells cut (boolean) as dark recesses open at the bottom."""
    mb = MB(name)
    xs = F.stations()
    rings, tags = [[V(F.x_bow, sy * F.yc, F.z_bow)]], []
    step_done = False
    for x in xs:
        if not step_done and x < F.x_step:
            rings.append(F.ring(F.x_step + 0.0005, sy, aft=False))
            rings.append(F.ring(F.x_step - 0.0005, sy, aft=True))
            step_done = True
        rings.append(F.ring(x, sy))
    # one loft per material band so the bottom / rail can carry their own colours
    n = len(rings[1])
    half = F.half_section(0.0)
    parts = [p for _, _, p in half] + [p for _, _, p in reversed(half[1:-1])]
    if sy < 0:
        pass
    coords, faces, mats = [], [], []
    starts = []
    for r in rings:
        starts.append(len(coords))
        coords.extend(r)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        sa, sb = starts[k], starts[k + 1]
        for i in range(n):
            i2 = (i + 1) % n
            m = parts[i] if parts[i] == parts[i2] else ('side' if 'side' in (parts[i], parts[i2]) else 'rail')
            if len(a) == 1:
                f = [sa, sb + i2, sb + i]
            else:
                f = [sa + i, sa + i2, sb + i2, sb + i]
            faces.append((f, m))
    # transom
    sl = starts[-1]
    faces.append((list(range(sl, sl + n)), 'side'))
    by_mat = {}
    for f, m in faces:
        by_mat.setdefault(m, []).append(f)
    matname = {'side': F.mat, 'rail': F.rail_mat, 'bottom': F.bottom_mat}
    bm = mb.bm
    vs = [bm.verts.new(Vector(c)) for c in coords]
    for m, fl in by_mat.items():
        idx = mb.mi(matname[m])
        for f in fl:
            try:
                face = bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            face.material_index = idx
            face.smooth = True
    ob = mb.finish(sharp_angle=38, merge=1e-6)
    for (cx, cy, z0, z1, lx, ly) in wells:
        cm = MB('wellcut')
        cm.box(((cx), sy * cy, 0.5 * (z0 + z1)), (lx, ly, z1 - z0), 'Float_Well', bevel=0.02, segs=2)
        cut = cm.finish(sharp_angle=80)
        mod = ob.modifiers.new('well', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'
        mod.solver = 'EXACT'
        mod.object = cut
        try:
            mod.material_mode = 'TRANSFER'
        except Exception:
            pass
        B.apply_mods(ob)
        bpy.data.objects.remove(cut)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    F.volume = abs(bm.calc_volume(signed=True))
    bm.free()
    return ob


def deck_fittings(mb, F, sy, xs_blocks, xs_covers, block=(0.12, 0.085, 0.05)):
    for x in xs_blocks:
        zd = F.deck(x)
        mb.box(V(x, sy * F.yc, zd + block[2] * 0.5 - 0.004), block, 'Alu_Bare', bevel=0.008, segs=1)
    for x in xs_covers:
        zd = F.deck(x)
        mb.cyl(V(x, sy * F.yc, zd - 0.004), V(x, sy * F.yc, zd + 0.006), 0.075, 'Alu_Bare', n=24)
        mb.cyl(V(x, sy * F.yc, zd + 0.006), V(x, sy * F.yc, zd + 0.009), 0.055, 'Metal_Frame', n=24)


def stem_strip(mb, F, sy, x_end, mat='Rubber', r=0.009):
    """Rubber rubbing strip on the stem, from the bow tip down the keel to x_end."""
    pts = []
    for k in range(13):
        x = lerp(F.x_bow - 0.004, x_end, (k / 12.0) ** 1.4)
        pts.append(V(x, sy * F.yc, (F.z_bow if k == 0 else F.keel_f(x)) - 0.002))
    mb.tube(pts, r, mat, n=8)


def amph_wheel(name, c, R, w, post_top, mat_fork='Metal_Frame', nose=False):
    """Amphibious wheel node: tyre + hub + fork + post up into the well; origin on the wheel centre."""
    c = Vector(c)
    mb = MB(name)
    mb.lathe(B.tire_profile(R, R * 0.55, w), c, V(0, 1, 0), 'Rubber', n=32, closed_profile=True)
    hw = w * 0.5
    mb.lathe([(0.0, -hw * 0.62), (0.03, -hw * 0.62), (0.045, -hw * 0.45), (R * 0.55, -hw * 0.6), (R * 0.58, -hw * 0.72),
              (R * 0.58, hw * 0.72), (R * 0.55, hw * 0.6), (0.045, hw * 0.45), (0.03, hw * 0.62), (0.0, hw * 0.62)],
             c, V(0, 1, 0), 'Engine', n=24)
    yf = hw + 0.018
    mb.cyl(c + V(0, -yf - 0.01, 0), c + V(0, yf + 0.01, 0), 0.009, 'Metal_Frame', n=10)
    top = c.z + R + 0.03
    rake = 0.035 if nose else -0.02
    for s in (1, -1):
        mb.tube([c + V(0, s * yf, 0), c + V(rake * 0.5, s * yf, (top - c.z) * 0.6), c + V(rake, s * (yf - 0.004), top - c.z)],
                0.0, mat_fork, n=12, square=(0.012, 0.04, 5), cap=True)
    mb.box(c + V(rake, 0, top - c.z + 0.01), (0.06, 2 * yf + 0.02, 0.024), mat_fork, bevel=0.006, segs=1)
    mb.cyl(V(c.x + rake, c.y, top + 0.02), V(c.x + rake, c.y, post_top), 0.022, 'Chrome', n=14)
    mb.cyl(V(c.x + rake, c.y, post_top - 0.10), V(c.x + rake, c.y, post_top), 0.030, 'Alu_Black', n=14)
    return mb.finish(origin=c, sharp_angle=40)


def water_rudder(name, hinge, depth, chord, top_chord=None, mat='Alu_Bare'):
    """Kick-up water rudder hung on the transom; origin on the (vertical) hinge."""
    h = Vector(hinge)
    mb = MB(name)
    tc = top_chord or chord * 0.7
    # blade (thin plate): leading edge on the hinge line, trailing edge sweeping back
    z0, z1 = h.z + 0.02, h.z - depth
    rings = []
    t = 0.008
    for k in range(9):
        f = k / 8.0
        z = lerp(z0, z1, f)
        c = lerp(tc, chord, min(1.0, f * 1.6)) * (1.0 - 0.45 * max(0.0, (f - 0.75) / 0.25) ** 2)
        rings.append([V(h.x - 0.005, h.y + t * 0.5, z), V(h.x - c, h.y + t * 0.15, z), V(h.x - c, h.y - t * 0.15, z),
                      V(h.x - 0.005, h.y - t * 0.5, z)])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True, smooth=False)
    # pintle post, horn arm (cable ends) on top
    mb.cyl(h + V(0, 0, 0.06), h + V(0, 0, -0.06), 0.012, 'Metal_Frame', n=10)
    mb.box(h + V(0.0, 0, 0.065), (0.025, 0.16, 0.012), 'Metal_Frame', bevel=0.003, segs=1)
    area = 0.0
    for k in range(8):
        za, zb = lerp(z0, z1, k / 8.0), lerp(z0, z1, (k + 1) / 8.0)
        fa, fb = k / 8.0, (k + 1) / 8.0
        ca = lerp(tc, chord, min(1.0, fa * 1.6)) * (1.0 - 0.45 * max(0.0, (fa - 0.75) / 0.25) ** 2)
        cb = lerp(tc, chord, min(1.0, fb * 1.6)) * (1.0 - 0.45 * max(0.0, (fb - 0.75) / 0.25) ** 2)
        area += 0.5 * (ca + cb) * (za - zb)
    ob = mb.finish(origin=h, sharp_angle=30)
    return ob, area


def strut(mb, a, b, r, mat='Alu_Bare', n=12):
    mb.cyl(Vector(a), Vector(b), r, mat, n=n)


class Kit:
    """Result of a kit builder: static objects (joined into the airframe), required nodes, report data."""

    def __init__(self):
        self.static, self.nodes, self.info = [], {}, {}


def wheels_and_rudders(kit, F, main_x, nose_x, Rm, wm, Rn, wn, rudder_depth, rudder_chord):
    """Amph wheels (down) + wells in the floats, water rudders. Ground plane = step keel - GROUND_CLEAR."""
    zg = F.keel_f(F.x_step) - GROUND_CLEAR
    # retract: the nose wheel needs the most travel (the bow keel is higher); one distance for all four
    loc_bot = {}
    for nm, x, R in (('main', main_x, Rm), ('nose', nose_x, Rn)):
        loc_bot[nm] = F.keel(x) + 0.012
    retract = round(max(loc_bot['main'] - zg, loc_bot['nose'] - zg) + 0.01, 3)
    wells = []
    nodes = {}
    for nm, x, R, w in (('main', main_x, Rm, wm), ('nose', nose_x, Rn, wn)):
        cz = zg + R
        crown = cz + R + 0.055                          # top of the fork crown
        well_top = crown + retract + 0.015              # everything of the raised wheel fits under it
        if well_top > F.deck(x) - 0.02:              # keep a 2 cm deck skin over the well
            print('  !! %s well reaches the deck (%.3f > %.3f)' % (nm, well_top, F.deck(x) - 0.02))
        wells.append((x, F.yc, F.keel(x) - 0.15, well_top, 2 * R + 0.07, w + 0.07))
        post_top = max(crown + 0.03, well_top - 0.01 - retract)
        kit.info['%s_well_top' % nm] = well_top
        for sy, tag in ((1, 'L'), (-1, 'R')):
            c = V(x, sy * F.yc, cz)
            name = 'amph_%s_%s' % (nm, tag)
            amph_wheel(name, c, R, w, post_top, nose=(nm == 'nose'))
            nodes[name] = c
        kit.info['%s_wheel' % nm] = dict(x=x, z=cz, R=R, w=w, contact=zg)
    kit.info['retract'] = retract
    kit.info['ground'] = zg
    for sy, tag in ((1, 'L'), (-1, 'R')):
        x = F.x_tr
        zt = 0.5 * (F.deck(x) + F.keel_a(x))
        hinge = V(x - 0.035, sy * F.yc, zt)
        ob, area = water_rudder('rudder_water' + tag, hinge, rudder_depth, rudder_chord)
        nodes['rudder_water' + tag] = hinge
        kit.info['rudder_area'] = area
        kit.info['rudder_hinge'] = hinge
        kit.info['rudder_bottom'] = hinge.z - rudder_depth
    return wells, nodes


def finish_floats(kit, F, wells, extra_fit):
    """Both float hulls (+ deck fittings, stem strips) into kit.static."""
    for sy, tag in ((1, 'L'), (-1, 'R')):
        kit.static.append(build_float('float_' + tag, F, sy, wells=[(x, yc, z0, z1, lx, ly) for x, yc, z0, z1, lx, ly in wells]))
        mb = MB('float_fit_' + tag)
        extra_fit(mb, sy)
        kit.static.append(mb.finish(sharp_angle=40, wn=True))


# ---------------------------------------------------------------------------
# Report (sim axes: x forward, y up, z right)
# ---------------------------------------------------------------------------
def g(p):
    return '(%.3f, %.3f, %.3f)' % (p[0], p[2], -p[1])


def report(label, kit, F, crash):
    i = kit.info
    print('=== FLOATS REPORT %s (sim axes x fwd, y up, z right; metres) ===' % label)
    for tag, sy in (('L', 1), ('R', -1)):
        zb = 0.5 * (F.deck(F.x_tr) + F.keel_a(F.x_tr))
        print('  float %s: bow tip %s  stern (transom, mid height) %s  centre-line z %.3f' % (
            tag, g(V(F.x_bow, sy * F.yc, F.z_bow)), g(V(F.x_tr, sy * F.yc, zb)), -sy * F.yc))
    xm = 0.5 * (F.x_step + F.x_bow)
    print('  half-width: deck %.3f, chine %.3f (+%.3f spray rail) | length %.3f' % (
        F.hd(xm), F.hc(xm), 0.012, F.x_bow - F.x_tr))
    print('  deck height (centreline) bow-end %.3f  at step %.3f  stern-end %.3f | axis height (mid deck-keel at step) %.3f' % (
        F.deck(F.x_bow - 0.4), F.deck(F.x_step), F.deck(F.x_tr + 0.2), 0.5 * (F.deck(F.x_step) + F.keel_f(F.x_step))))
    print('  volume per float %.3f m3 (wells cut) -> %.0f kg fresh-water buoyancy for both' % (F.volume, 2000 * F.volume))
    print('  keel at step %.3f (fore) / %.3f (aft), at bow (x %.2f) %.3f; step x %.3f' % (
        F.keel_f(F.x_step), F.keel_a(F.x_step), F.x_bow - 0.35, F.keel_f(F.x_bow - 0.35), F.x_step))
    for nm in ('main', 'nose'):
        w = i['%s_wheel' % nm]
        print('  amph_%s_L/R centre (%.3f, %.3f, -/+%.3f) R %.3f w %.3f  contact y %.3f' % (
            nm, w['x'], w['z'], F.yc, w['R'], w['w'], w['contact']))
    print('  retract %.3f (straight up)' % i['retract'])
    h = i['rudder_hinge']
    print('  rudder_waterL/R hinge (%.3f, %.3f, -/+%.3f)  area %.4f m2 each  blade bottom y %.3f' % (
        h.x, h.z, F.yc, i['rudder_area'], i['rudder_bottom']))
    for n, p in crash:
        print('  crash candidate %-22s %s' % (n, g(p)))
    lo = bounds_low(list(bpy.context.scene.objects))
    print('  lowest point %s' % g(lo))


def bounds_low(objs):
    lo = None
    for ob in objs:
        if ob.type != 'MESH':
            continue
        for v in ob.data.vertices:
            p = ob.matrix_world @ v.co
            if lo is None or p.z < lo.z:
                lo = p.copy()
    return lo


# ---------------------------------------------------------------------------
# Cavalon Amphib (C-FGYE)
# ---------------------------------------------------------------------------
CAV = dict(
    yc=0.86, x_bow=1.736, z_bow=-0.972, x_tr=-2.95, x_step=-0.47,
    # centreline deck (inspection covers traced at -0.870 / -0.835 / -0.820 for x 0.96 / -0.05 / -1.03),
    # dropping into the bow tip and rounding down at the stern
    deck=[(1.736, -0.972), (1.70, -0.935), (1.62, -0.905), (1.50, -0.885), (1.30, -0.869), (0.5, -0.849),
          (-0.5, -0.824), (-1.5, -0.799), (-2.5, -0.774), (-2.75, -0.772), (-2.86, -0.790), (-2.95, -0.850)],
    hd=[(1.736, 0.0), (1.70, 0.035), (1.60, 0.068), (1.45, 0.092), (1.25, 0.106), (1.0, 0.11), (-2.4, 0.11),
        (-2.75, 0.10), (-2.95, 0.085)],
    hc=[(1.736, 0.0), (1.70, 0.05), (1.60, 0.11), (1.45, 0.165), (1.25, 0.21), (1.0, 0.235), (0.8, 0.24),
        (-0.5, 0.24), (-1.5, 0.225), (-2.4, 0.19), (-2.95, 0.15)],
    chine_f=[(1.736, -0.972), (1.60, -1.05), (1.45, -1.11), (1.31, -1.152), (1.22, -1.186), (1.12, -1.205),
             (1.02, -1.22), (0.92, -1.233), (0.5, -1.234), (-0.47, -1.228)],
    keel_f=[(1.736, -0.972), (1.65, -1.04), (1.557, -1.114), (1.455, -1.184), (1.35, -1.29), (1.25, -1.35),
            (1.145, -1.375), (1.04, -1.393), (0.94, -1.408), (0.6, -1.425), (0.0, -1.432), (-0.47, -1.435)],
    chine_a=[(-0.47, -1.12), (-0.71, -1.086), (-1.04, -1.05), (-1.37, -1.009), (-1.72, -0.971), (-2.07, -0.926),
             (-2.42, -0.88), (-2.70, -0.866), (-2.95, -0.88)],
    keel_a=[(-0.47, -1.365), (-0.58, -1.358), (-0.81, -1.324), (-1.16, -1.272), (-1.52, -1.216), (-1.88, -1.155),
            (-2.25, -1.09), (-2.62, -1.02), (-2.80, -0.985), (-2.95, -0.962)],
)


def cavalon_kit(R):
    """Float kit for the Cavalon. R: hub-frame Ref of build_cavalon (unused geometry stays in the builder)."""
    ensure_mats()
    kit = Kit()
    F = FloatSpec(**CAV, mat='Float_White', rail_mat='Rubber')
    yc = F.yc
    wells, nodes = wheels_and_rudders(kit, F, main_x=-0.72, nose_x=1.15, Rm=0.16, wm=0.10, Rn=0.12, wn=0.08,
                                      rudder_depth=0.30, rudder_chord=0.17)
    kit.nodes.update(nodes)
    X_FS, X_SF, X_SM, X_LEG, X_SR = 1.306, 0.755, -0.398, -0.695, -1.676     # traced blocks on the decks

    def fit(mb, sy):
        deck_fittings(mb, F, sy, [X_FS, X_SF, X_SM, X_LEG, X_SR], [0.959, -0.053, -1.029, -2.05])
        stem_strip(mb, F, sy, 1.10)
    finish_floats(kit, F, wells, fit)

    mb = MB('float_frame')
    tz = lambda x: F.deck(x) + 0.068                     # spreader tube axis (on the blocks)
    # spreaders (front / middle / rear), trampoline laced between them and the side rails
    for x in (X_SF, X_SM, X_SR):
        mb.cyl(V(x, yc + 0.03, tz(x)), V(x, -yc - 0.03, tz(x)), 0.022, 'Alu_Bare', n=14)
        for sy in (1, -1):
            mb.cyl(V(x, sy * (yc + 0.03), tz(x)), V(x, sy * (yc + 0.045), tz(x)), 0.026, 'Alu_Black', n=14)
    yi = yc - 0.13
    for sy in (1, -1):
        mb.tube([V(X_SF, sy * yi, tz(X_SF)), V(X_SM, sy * yi, tz(X_SM)), V(X_SR, sy * yi, tz(X_SR))], 0.012, 'Alu_Bare', n=10)
    for x0, x1 in ((X_SF, X_SM), (X_SM, X_SR)):
        z0, z1 = tz(x0) - 0.012, tz(x1) - 0.012
        pts = [V(x0 - 0.03, yi, z0), V(x1 + 0.03, yi, z1), V(x1 + 0.03, -yi, z1), V(x0 - 0.03, -yi, z0)]
        mb.faces([p + V(0, 0, 0.002) for p in pts], [[0, 1, 2, 3]], 'Tramp_Black', smooth=False)
        mb.faces([p - V(0, 0, 0.002) for p in pts], [[3, 2, 1, 0]], 'Tramp_Black', smooth=False)
        # lacing hooks along the spreaders
        for k in range(1, 12):
            y = lerp(-yi, yi, k / 12.0)
            for x, z in ((x0 - 0.03, z0), (x1 + 0.03, z1)):
                mb.box(V(x, y, z + 0.004), (0.022, 0.008, 0.008), 'Metal_Frame')
    # front struts: bow block -> bracket on the nose flank (traced: 1.037, 0.52, -0.02)
    top_l = V(1.037, 0.52, -0.02)
    for sy in (1, -1):
        foot = V(X_FS, sy * yc, F.deck(X_FS) + 0.05)
        top = V(top_l.x, sy * top_l.y, top_l.z)
        mb.cyl(foot, top + (foot - top).normalized() * 0.03, 0.018, 'Alu_Bare', n=12)
        mb.cyl(foot + (top - foot) * 0.18, foot + (top - foot) * 0.24, 0.024, 'Alu_Black', n=12)   # turnbuckle
        mb.box(top + V(0, -sy * 0.006, 0), (0.06, 0.03, 0.09), 'Alu_Black', bevel=0.008, segs=1,
               rot=Euler((sy * math.radians(20), 0, 0)))
    # cross tube under the belly (two brackets) and the diagonals down to the bow-leg blocks
    xc, zc = -0.38, -0.578
    mb.cyl(V(xc, 0.32, zc), V(xc, -0.32, zc), 0.020, 'Alu_Bare', n=12)
    for sy in (1, -1):
        mb.box(V(xc, sy * 0.16, zc + 0.03), (0.07, 0.04, 0.07), 'Alu_Black', bevel=0.006, segs=1)
        mb.cyl(V(xc, sy * 0.28, zc), V(X_LEG, sy * yc, F.deck(X_LEG) + 0.05), 0.017, 'Alu_Bare', n=12)
    # main gear bow (composite, as on the land Cavalon), reshaped to end on the bow-leg blocks
    for sy in (1, -1):
        K.leg_blade(mb, [R(-0.40, -2.270, sy * 0.02), R(-0.40, -2.278, sy * 0.28), R(-0.405, -2.31, sy * 0.48),
                         R(-0.42, -2.40, sy * 0.66), V(X_LEG + 0.005, sy * 0.80, F.deck(X_LEG) + 0.11),
                         V(X_LEG, sy * yc, F.deck(X_LEG) + 0.05)], chord=0.15, thick=0.036, mat='Paint_Dark')
        mb.box(V(X_LEG, sy * yc, F.deck(X_LEG) + 0.075), (0.16, 0.10, 0.03), 'Alu_Bare', bevel=0.006, segs=1)
    kit.static.append(mb.finish(sharp_angle=40, wn=True))

    i = kit.info
    crash = [('bow tip L', V(F.x_bow, yc, F.z_bow)), ('bow keel L (x-0.35)', V(F.x_bow - 0.35, yc, F.keel_f(F.x_bow - 0.35))),
             ('step keel L', V(F.x_step, yc, F.keel_f(F.x_step))),
             ('stern bottom L', V(F.x_tr, yc, F.keel_a(F.x_tr))), ('rudder blade tip L', V(F.x_tr - 0.2, yc, i['rudder_bottom'])),
             ('front spreader L end', V(X_SF, yc + 0.045, tz(X_SF))), ('rear spreader L end', V(X_SR, yc + 0.045, tz(X_SR))),
             ('chine max L (x 0)', V(0.0, yc + F.hc(0.0) + 0.012, F.chine_f(0.0)))]
    kit.report = lambda: report('CAVALON', kit, F, crash)
    kit.F = F
    return kit


# ---------------------------------------------------------------------------
# MT-03 (MTOamphib-style kit)
# ---------------------------------------------------------------------------
MT03_DECK = -0.855         # level deck, 0.18 m under the pod belly (MTOamphib)


def mt03_spec(x_nose):
    """The Cavalon float lines scaled to 4.40 m, 28 % shallower, deck level (the Cavalon's 1.4 deg slope
    removed), bow tip under the pod nose, full-height flat transom (MTOamphib)."""
    c = CAV
    x_bow = x_nose - 0.03
    s = 4.40 / (c['x_bow'] - c['x_tr'])
    vs = 0.72                # MTOamphib overlay: 0.44 m deep at the step (the Cavalon floats are 0.61 m)

    def sx(x):
        return x_bow - (c['x_bow'] - x) * s

    def sz(x, z):            # Cavalon height -> MT-03 (levelled about the Cavalon deck line -0.8365 - 0.025 x)
        return MT03_DECK + (z + 0.025 * x + 0.8365) * vs

    def tz(pairs):
        return [(sx(x), sz(x, z)) for x, z in pairs]
    deck = tz(c['deck'])
    flat = deck[-4][1]
    deck[-3:] = [(sx(-2.86), flat - 0.002), (sx(-2.93), flat - 0.008), (sx(-2.95), flat - 0.018)]
    spec = dict(yc=0.86, x_bow=x_bow, z_bow=sz(c['x_bow'], c['z_bow']), x_tr=sx(c['x_tr']), x_step=sx(c['x_step']),
                deck=deck, hd=[(sx(x), v) for x, v in c['hd']], hc=[(sx(x), v * 0.98) for x, v in c['hc']],
                chine_f=tz(c['chine_f']), keel_f=tz(c['keel_f']), chine_a=tz(c['chine_a']), keel_a=tz(c['keel_a']))
    spec['hd'][-2:] = [(sx(-2.75), 0.11), (sx(-2.95), 0.105)]
    spec['hc'][-1] = (sx(-2.95), 0.17)
    return spec


def mt03_kit(R, x_nose, x_step=None):
    ensure_mats()
    kit = Kit()
    spec = mt03_spec(x_nose)
    if x_step is not None:
        spec['x_step'] = x_step
    F = FloatSpec(**spec, mat='Paint_White', bottom_mat='Decal_White', rail_mat='Decal_White')
    yc = F.yc
    xm = F.x_step - 0.24
    wells, nodes = wheels_and_rudders(kit, F, main_x=xm, nose_x=F.x_bow - 0.56, Rm=0.125, wm=0.09, Rn=0.10, wn=0.07,
                                      rudder_depth=0.28, rudder_chord=0.16)
    kit.nodes.update(nodes)
    # main struts clamp onto the keel tube at the mast foot (MTOamphib: struts straight under the mast)
    root = R(-0.35, -2.40)
    X_FS = F.x_bow - 0.62                           # front strut feet (photo: 0.5-0.6 m behind the nose)
    X_SF, X_SM, X_SR = X_FS - 0.05, root.x, R.x(-0.93)
    X_V = R.x(-1.25)                                # rear V-brace feet

    def fit(mb, sy):
        deck_fittings(mb, F, sy, [X_FS, X_SM, X_SR, X_V], [F.x_bow - 0.95, F.x_step + 0.35, F.x_step - 0.75, F.x_tr + 0.55],
                      block=(0.11, 0.08, 0.045))
        stem_strip(mb, F, sy, F.x_bow - 0.55, mat='Decal_White')
    finish_floats(kit, F, wells, fit)

    mb = MB('float_frame')
    tz = lambda x: F.deck(x) + 0.062
    for x in (X_SF, X_SM, X_SR):
        mb.cyl(V(x, yc + 0.03, tz(x)), V(x, -yc - 0.03, tz(x)), 0.021, 'Alu_Bare', n=14)
        for sy in (1, -1):
            mb.cyl(V(x, sy * (yc + 0.03), tz(x)), V(x, sy * (yc + 0.045), tz(x)), 0.025, 'Alu_Black', n=14)
    yi = yc - 0.13
    for sy in (1, -1):
        mb.tube([V(X_SF, sy * yi, tz(X_SF)), V(X_SM, sy * yi, tz(X_SM)), V(X_SR, sy * yi, tz(X_SR))], 0.011, 'Alu_Bare', n=10)
    for x0, x1 in ((X_SF, X_SM), (X_SM, X_SR)):
        z0, z1 = tz(x0) - 0.012, tz(x1) - 0.012
        pts = [V(x0 - 0.03, yi, z0), V(x1 + 0.03, yi, z1), V(x1 + 0.03, -yi, z1), V(x0 - 0.03, -yi, z0)]
        mb.faces([p + V(0, 0, 0.002) for p in pts], [[0, 1, 2, 3]], 'Tramp_Light', smooth=False)
        mb.faces([p - V(0, 0, 0.002) for p in pts], [[3, 2, 1, 0]], 'Tramp_Light', smooth=False)
    # main struts: from the old gear root (plate under the pod) out and down to the floats, body colour
    mb.box(root + V(0, 0, 0.005), (0.16, 0.30, 0.03), 'Metal_Frame', bevel=0.008, segs=2)
    for sy in (1, -1):
        K.leg_blade(mb, [root + V(0, sy * 0.10, 0), root + V(0, sy * 0.34, -0.02), root + V(-0.005, sy * 0.60, -0.07),
                         V(X_SM, sy * 0.80, F.deck(X_SM) + 0.12), V(X_SM, sy * yc, F.deck(X_SM) + 0.05)],
                    chord=0.11, thick=0.034, mat='Paint_White')
    # front struts: bow-area blocks -> nose-gear hardpoint under the pod
    top = R(1.48, -2.36)
    for sy in (1, -1):
        foot = V(X_FS, sy * yc, F.deck(X_FS) + 0.045)
        mb.cyl(foot, top + V(0, sy * 0.10, 0), 0.017, 'Alu_Bare', n=12)
    mb.box(top + V(0, 0, 0.01), (0.10, 0.26, 0.03), 'Metal_Frame', bevel=0.006, segs=1)
    # rear V brace from the keel bend to both floats
    bend = R(-1.15, -2.47)
    mb.box(bend + V(0, 0, -0.045), (0.10, 0.10, 0.03), 'Metal_Frame', bevel=0.006, segs=1)
    for sy in (1, -1):
        mb.cyl(bend + V(0, sy * 0.04, -0.05), V(X_V, sy * yc, F.deck(X_V) + 0.045), 0.016, 'Alu_Bare', n=12)
    kit.static.append(mb.finish(sharp_angle=40, wn=True))

    i = kit.info
    crash = [('bow tip L', V(F.x_bow, yc, F.z_bow)), ('bow keel L (x-0.35)', V(F.x_bow - 0.35, yc, F.keel_f(F.x_bow - 0.35))),
             ('step keel L', V(F.x_step, yc, F.keel_f(F.x_step))),
             ('stern bottom L', V(F.x_tr, yc, F.keel_a(F.x_tr))), ('rudder blade tip L', V(F.x_tr - 0.2, yc, i['rudder_bottom'])),
             ('front spreader L end', V(X_SF, yc + 0.045, tz(X_SF))), ('rear spreader L end', V(X_SR, yc + 0.045, tz(X_SR))),
             ('chine max L (x 0)', V(0.0, yc + F.hc(0.0) + 0.012, F.chine_f(0.0)))]
    kit.report = lambda: report('MT-03', kit, F, crash)
    kit.F = F
    return kit


def cavalon_ground():
    return table(CAV['keel_f'])(CAV['x_step']) - GROUND_CLEAR


def mt03_ground(x_nose):
    sp = mt03_spec(x_nose)
    return table(sp['keel_f'])(sp['x_step']) - GROUND_CLEAR


# ---------------------------------------------------------------------------
# Run wrapper: <name>_floats outputs only
# ---------------------------------------------------------------------------
def run(name, build, livery, views, rest_ground):
    """K.run under the name <name>_floats (GLB + previews), then remove the variant .blend so the flag writes
    only the GLB and the previews (never the base files)."""
    vname = name + '_floats'
    K.run(vname, build, livery, views=views, rest_ground=rest_ground)
    blend = os.path.join(K.HERE, vname + '.blend')
    if '--keep-blend' not in K.ARGV and os.path.exists(blend):
        try:
            os.remove(blend)
        except OSError:
            pass
