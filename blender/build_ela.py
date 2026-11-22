"""
ELA Aviación (Córdoba) gyroplanes for the Autogiro web sim:
  ela07  ELA 07 Cougar  - open tandem, long drooping nose, two cockpits with their own windscreens,
                          body-coloured mast and keel, exposed Rotax, ELA box tail
  ela10  ELA 10 Eclipse - enclosed tandem cabin (one-piece canopy on a chined hull), thin faired
                          pylon with intakes, cowled engine, swan-neck boom up to a high tail:
                          stabiliser on top of a ventral fin, endplates pointing up and down

Shapes were fitted to ELA factory photos (elaaviacion.com) and Wikimedia Commons photos.
Reuses build_autogiro.py for rotor, head, prop, engine, wheels, export and previews, and pilot.py
for the crew. Keeps the node contract AND the physics reference points (hub, head pivot, prop,
wheels), so src/sim stays valid for every variant.

Run headless (one variant per run):
  blender -b -P blender/build_ela.py -- --variant ela10 [--previews] [--only VIEW[,VIEW]] [--samples N]
Outputs: public/models/<variant>.glb, blender/<variant>.blend, blender/previews/<variant>/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import build_autogiro as B  # noqa: E402
import pilot  # noqa: E402
import controls  # noqa: E402
import panel as PANEL  # noqa: E402
from build_autogiro import (V, MB, MATS, TAU, hermite, lerp, sgnpow, catmull, airfoil_ring, naca4, link,  # noqa: E402
                            apply_mods, boundary_loops, resample_loop, closed_tube, mark_sharp,
                            remove_faces_with_material, line_through)

ROOT = os.path.dirname(HERE)
ARGV = B.ARGV


def arg(name, default):
    if name in ARGV:
        i = ARGV.index(name)
        if i + 1 < len(ARGV):
            return ARGV[i + 1]
    return default


VARIANT = arg('--variant', 'ela10')

# Material names are kept so the sim's material tuning still applies:
# Paint_White = main body colour, Paint_Accent / Paint_Dark = trim.
LIVERY = {
    'ela07': dict(body=('#F5B400', 0.0, 0.16), accent=('#C41E1E', 0.1, 0.30), dark=('#18191C', 0.25, 0.32),
                  reg='EC-CUG'),
    'ela10': dict(body=('#1B6FC0', 0.55, 0.22), accent=('#C9CCD0', 1.0, 0.18), dark=('#0F1012', 0.3, 0.30),
                  reg='EC-ECL'),
}


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


def apply_livery(v):
    L = LIVERY[v]
    set_paint('Paint_White', *L['body'])
    set_paint('Paint_Accent', *L['accent'])
    set_paint('Paint_Dark', *L['dark'])
    set_paint('Seat', '#141517', 0.0, 0.8)


def swap_material(ob, old, new):
    me = ob.data
    for i, m in enumerate(me.materials):
        if m and m.name == old:
            me.materials[i] = MATS[new]


def shift(ob, d):
    ob.location += Vector(d)
    return ob


# ---------------------------------------------------------------------------
# Fuselage from stations: (x, z_top, z_shoulder, half_w_shoulder, z_chine, half_w_chine, z_bottom)
# Cross-section: rounded top arc -> near-vertical side -> chine -> flattish belly.
# ---------------------------------------------------------------------------
class Fuselage:
    KEYS = ('zt', 'zu', 'wu', 'zc', 'wc', 'zb')

    def __init__(self, table, tip, nt=2.25, nb=2.7, nose_exp=0.8, bow=0.012, chine_sharp=False, flare=1.0,
                 linear_nose=False, nose_curve=None):
        cols = list(zip(*table))
        self.xs = list(cols[0])
        self.F = {k: hermite(self.xs, list(cols[i + 1])) for i, k in enumerate(self.KEYS)}
        self.xn, self.xrear = self.xs[0], self.xs[-1]
        self.tip = tip
        self.nt, self.nb, self.nose_exp, self.bow = nt, nb, nose_exp, bow
        self.chine_sharp, self.flare, self.linear_nose = chine_sharp, flare, linear_nose
        self.nose_curve = nose_curve       # ((m0, m1) top, (m0, m1) bottom, (m0, m1) half-width), slopes per unit t

    def params(self, x):
        p = {k: f(min(x, self.xn)) for k, f in self.F.items()}
        if x > self.xn and self.nose_curve:
            t = min(1.0, (x - self.xn) / (self.tip[0] - self.xn))
            herm = lambda p0, p1, m0, m1: ((2 * t ** 3 - 3 * t * t + 1) * p0 + (t ** 3 - 2 * t * t + t) * m0
                                           + (-2 * t ** 3 + 3 * t * t) * p1 + (t ** 3 - t * t) * m1)
            (tm0, tm1), (bm0, bm1), (wm0, wm1) = self.nose_curve
            span = max(p['zt'] - p['zb'], 1e-6)
            fu, fc = (p['zu'] - p['zb']) / span, (p['zc'] - p['zb']) / span
            rw = p['wc'] / max(p['wu'], 1e-6)
            zt = herm(p['zt'], self.tip[1], tm0, tm1)
            zb = herm(p['zb'], self.tip[1], bm0, bm1)
            w = max(0.0, herm(p['wu'], 0.0, wm0, wm1))
            return {'zt': zt, 'zb': zb, 'zu': zb + fu * (zt - zb), 'zc': zb + fc * (zt - zb), 'wu': w, 'wc': w * rw}
        if x > self.xn:
            t = min(1.0, (x - self.xn) / (self.tip[0] - self.xn))
            if self.linear_nose:
                s = (1.0 - t) ** self.nose_exp
            else:
                s = max(0.0, math.cos(0.5 * math.pi * t)) ** self.nose_exp
            zc0 = (p['zt'] + p['zb']) * 0.5
            zc = lerp(zc0, self.tip[1], t)
            for k in ('zt', 'zu', 'zc', 'zb'):
                p[k] = zc + (p[k] - zc0) * s
            p['wu'] *= s
            p['wc'] *= s
        return p

    def half(self, p, m=40):
        """Half cross-section (y >= 0) from top centre to bottom centre.
        Returns (upper, lower) split at the chine when chine_sharp, else one list."""
        nt, nb = self.nt, self.nb
        up = []
        for i in range(m + 1):
            t = 0.5 * math.pi * i / m
            up.append((p['wu'] * math.sin(t) ** (2 / nt), p['zu'] + (p['zt'] - p['zu']) * math.cos(t) ** (2 / nt)))
        for i in range(1, m + 1):
            t = i / m
            up.append((lerp(p['wu'], p['wc'], t ** self.flare) + self.bow * math.sin(math.pi * t) * min(1.0, p['wc'] * 8),
                       lerp(p['zu'], p['zc'], t)))
        lo = [up[-1]]
        for i in range(1, m + 1):
            t = 0.5 * math.pi * i / m
            lo.append((p['wc'] * math.cos(t) ** (2 / nb), p['zc'] - (p['zc'] - p['zb']) * math.sin(t) ** (2 / nb)))
        if not self.chine_sharp:
            pts = up + lo[1:]
            for _ in range(5):
                pts = [pts[0]] + [((pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
                                   (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4) for i in range(1, len(pts) - 1)] + [pts[-1]]
            return pts
        def smooth(pts, k):
            for _ in range(k):
                pts = [pts[0]] + [((pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4,
                                   (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4) for i in range(1, len(pts) - 1)] + [pts[-1]]
            return pts
        return smooth(up, 4), smooth(lo, 2)

    def ring(self, x, n_half=36, scale=1.0):
        p = self.params(x)
        hh = self.half(p)
        if self.chine_sharp:
            n_up = int(round(n_half * 0.64))
            h = resample2d(hh[0], n_up) + resample2d(hh[1], n_half - n_up)[1:]
        else:
            h = resample2d(hh, n_half)
        zc = (p['zt'] + p['zb']) * 0.5
        h = [(y * scale, zc + (z - zc) * scale) for y, z in h]
        ring = [V(x, y, z) for (y, z) in h]
        ring += [V(x, -y, z) for (y, z) in reversed(h[1:-1])]
        return ring

    def shell(self, name, step=0.035, n_half=36, rear=((0.012, 0.93), (0.022, 0.75)), mat='Paint_White'):
        xs = []
        K = 14
        for k in range(K + 1):
            t = math.sin(0.5 * math.pi * k / K)
            xs.append(self.tip[0] - (self.tip[0] - self.xn) * (1 - t))
        x = self.xn
        while x > self.xrear + 1e-6:
            x -= step
            xs.append(max(x, self.xrear))
        xs = sorted(set(round(v, 5) for v in xs), reverse=True)
        rings = [[V(self.tip[0], 0, self.tip[1])]]
        for x in xs[1:]:
            rings.append(self.ring(x, n_half))
        for dx, sc in rear:
            rings.append(self.ring(self.xrear - dx, n_half, scale=sc))
        mb = MB(name)
        mb.loft(rings, mat, closed=True, cap1=True)
        return mb.finish(sharp_angle=60)

    def top_z(self, x, y):
        p = self.params(x)
        h = self.half(p)
        if self.chine_sharp:
            h = h[0] + h[1][1:]
        best = None
        for (a, b), (c, d) in zip(h, h[1:]):
            if (a - abs(y)) * (c - abs(y)) <= 0 and b > p['zc']:
                t = 0 if c == a else (abs(y) - a) / (c - a)
                z = lerp(b, d, t)
                best = z if best is None else max(best, z)
        return best if best is not None else p['zt']


def resample2d(pts, n):
    seg = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)]
    L = sum(seg)
    out = [pts[0]]
    acc, i = 0.0, 0
    for k in range(1, n):
        d = L * k / n
        while i < len(seg) - 1 and acc + seg[i] < d:
            acc += seg[i]
            i += 1
        t = (d - acc) / seg[i] if seg[i] > 0 else 0
        out.append((lerp(pts[i][0], pts[i + 1][0], t), lerp(pts[i][1], pts[i + 1][1], t)))
    out.append(pts[-1])
    return out


def plane_pts(p0, p1):
    """Side-view line through (x,z) points -> (co, normal) plane, independent of y."""
    (x0, z0), (x1, z1) = p0, p1
    d = Vector((x1 - x0, 0, z1 - z0))
    return V(x0, 0, z0), Vector((d.z, 0, -d.x)).normalized()


def bisect_all(bm, planes):
    for co, no in planes:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no)


def thicken_shell(ob, n_outer, thickness=0.012):
    """Solidify inward; inner faces + rims -> 'Interior' (appended as last slot)."""
    me = ob.data
    me.materials.append(MATS['Interior'])
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = thickness
    sol.offset = -1.0
    sol.use_even_offset = True
    sol.material_offset = n_outer
    sol.material_offset_rim = n_outer
    apply_mods(ob)
    for p in ob.data.polygons:
        if p.material_index > n_outer:
            p.material_index = n_outer
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    mark_sharp(bm, 50)
    bm.to_mesh(ob.data)
    bm.free()


def opening_rim(ob, name, r=0.014, mat='Seat', inset=0.006):
    loops = boundary_loops(ob.data)
    rim = MB(name)
    for lp in loops:
        pts = [co - no * inset for co, no in lp]
        pts = resample_loop(pts, 0.02)
        closed_tube(rim, pts, r, mat, n=10)
    return rim.finish(sharp_angle=80)


def ray_down(ob, x, y, z0=2.0):
    inv = ob.matrix_world.inverted()
    ok, loc, nrm, _ = ob.ray_cast(inv @ V(x, y, z0), V(0, 0, -1), distance=4.0)
    return (ob.matrix_world @ loc).z if ok else None


# ---------------------------------------------------------------------------
# Cockpit parts
# ---------------------------------------------------------------------------
def bucket_seat(mb, hip, back_deg, width=0.44, headrest=True, cushion_len=0.42, base=True):
    """Composite bucket seat for an occupant whose H-point is `hip`."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rot_back = Euler((0, -b, 0))
    seat_top = hip.z - 0.085
    c = V(hip.x + cushion_len * 0.5 - 0.10, 0, seat_top - 0.04)
    mb.box(c, (cushion_len, width, 0.08), 'Seat', bevel=0.03, segs=3, rot=Euler((0, math.radians(-7), 0)))
    if base:
        mb.box(c - V(0, 0, 0.08), (cushion_len - 0.04, width - 0.06, 0.10), 'Interior', bevel=0.02, segs=1)
    back_c = hip - f * 0.13 + u * 0.33
    mb.box(back_c, (0.07, width, 0.66), 'Seat', bevel=0.03, segs=3, rot=rot_back)
    mb.box(back_c - f * 0.045, (0.03, width - 0.02, 0.64), 'Paint_Dark', bevel=0.012, segs=2, rot=rot_back)
    for sy in (1, -1):   # side bolsters
        mb.box(back_c + f * 0.04 + V(0, sy * (width * 0.5 - 0.03), -0.05), (0.12, 0.05, 0.48), 'Seat', bevel=0.022,
               segs=2, rot=rot_back)
        mb.box(c + V(0.02, sy * (width * 0.5 - 0.03), 0.04), (cushion_len - 0.08, 0.05, 0.06), 'Seat', bevel=0.02,
               segs=2, rot=Euler((0, math.radians(-7), 0)))
    if headrest:
        hc = hip - f * 0.12 + u * 0.78
        mb.box(hc, (0.08, 0.26, 0.17), 'Seat', bevel=0.03, segs=3, rot=rot_back)
        for sy in (1, -1):
            mb.cyl(hc - u * 0.08 + V(0, sy * 0.07, 0), hc - u * 0.14 + V(0, sy * 0.07, 0), 0.007, 'Metal_Frame', n=8)


def panel(mb, pc, width, height, tilt_deg, gauges=True, glare=None, center='efis'):
    """Instrument panel box with dummy gauges. center: 'efis' screen, 'compass' (1930s board) or None."""
    tilt = math.radians(tilt_deg)
    nrm = V(-math.cos(tilt), 0, math.sin(tilt))
    upv = V(math.sin(tilt), 0, math.cos(tilt))
    mb.box(pc, (0.03, width, height), 'Panel', bevel=0.012, segs=2, rot=Euler((0, tilt, 0)))
    face_c = pc + nrm * 0.015

    def on(y, z, d=0.0):
        return face_c + V(0, y, 0) + upv * z + nrm * d

    if gauges:
        for (gy, gz, gr) in ((0.125, 0.025, 0.034), (0.205, 0.025, 0.031), (-0.125, 0.025, 0.034),
                             (-0.205, 0.025, 0.031), (0.165, -0.05, 0.023), (-0.165, -0.05, 0.023)):
            if abs(gy) + gr > width * 0.5 - 0.01:
                continue
            mb.cyl(on(gy, gz), on(gy, gz, 0.008), gr, 'Metal_Frame', n=20)
            mb.cyl(on(gy, gz, 0.008), on(gy, gz, 0.0085), gr * 0.86, 'Gauge_Face', n=20)
            p = on(gy, gz, 0.0095)
            mb.box(p + V(0, -gr * 0.25, 0) + upv * gr * 0.18, (0.002, gr * 0.65, 0.004), 'Paint_Dark',
                   rot=Euler((math.radians(-35), tilt, 0)))
        if center == 'efis':
            mb.box(on(0, -0.005, 0.004), (0.008, 0.15, 0.10), 'Paint_Dark', bevel=0.004, segs=1,
                   rot=Euler((0, tilt, 0)))
            mb.box(on(0, -0.005, 0.0085), (0.002, 0.135, 0.085), 'Visor', rot=Euler((0, tilt, 0)))
        elif center == 'compass':
            # P-type compass let into the board: bowl, card, lubber line
            mb.cyl(on(0, 0.005), on(0, 0.005, 0.016), 0.046, 'Metal_Frame', n=28)
            mb.cyl(on(0, 0.005, 0.016), on(0, 0.005, 0.0165), 0.039, 'Gauge_Face', n=28)
            mb.box(on(0, 0.005 + 0.025, 0.018), (0.002, 0.003, 0.014), 'Paint_Dark', rot=Euler((0, tilt, 0)))
            mb.box(on(0, 0.005, 0.018), (0.002, 0.050, 0.0025), 'Paint_Dark', rot=Euler((0, tilt, 0)))
        for k in range(5):
            mb.cyl(on(-0.06 + k * 0.03, -0.075), on(-0.06 + k * 0.03, -0.075, 0.018), 0.004, 'Metal_Frame', n=6)
    # glare shield over the panel
    top = pc + upv * (height * 0.5) + nrm * -0.02
    if glare is False:
        return
    gl, gw = glare if glare else (0.17, width + 0.02)
    mb.box(top + V(gl * 0.35, 0, 0.012), (gl, gw, 0.022), 'Panel', bevel=0.01, segs=2,
           rot=Euler((0, math.radians(-6), 0)))


def make_eye(p):
    eye = bpy.data.objects.new('eye_front', None)
    eye.empty_display_type = 'PLAIN_AXES'
    eye.empty_display_size = 0.05
    eye.location = p
    link(eye)
    return eye


def build_registration(pod, text, cx, cz, size=0.105, mat='Paint_Dark'):
    obs = []
    for side in (1, -1):
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
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        for v in bm.verts:
            tx, ty = v.co.x, v.co.y
            wx, wz = (cx - tx, cz + ty) if side > 0 else (cx + tx, cz + ty)
            hit, loc, nrm, idx = pod.ray_cast(V(wx, side * 1.0, wz), V(0, -side, 0))
            v.co = loc + nrm.normalized() * 0.0018 if hit else V(wx, side * 0.3, wz)
        bm.normal_update()
        for f in bm.faces:
            if f.normal.y * side < 0:
                f.normal_flip()
            f.smooth = False
        me2 = bpy.data.meshes.new('registration_' + ('L' if side > 0 else 'R'))
        bm.to_mesh(me2)
        bm.free()
        bpy.data.meshes.remove(me)
        me2.materials.append(MATS[mat])
        ob = bpy.data.objects.new(me2.name, me2)
        link(ob)
        obs.append(ob)
    return obs


def finalize(objs_static, glass_objs):
    airframe = B.join_objects('airframe', objs_static)
    glass = B.join_objects('windscreen', glass_objs) if len(glass_objs) > 1 else glass_objs[0]
    glass.name = 'windscreen'
    for ob in bpy.context.scene.collection.objects:
        ob.rotation_euler = (0, 0, 0)
        ob.scale = (1, 1, 1)
        ob.parent = None
    return airframe


def build_rudder_surface(name, zs, le_fn, te_fn, hinge_x, origin, t=0.10, mat='Paint_White'):
    """Rudder = aft part (hinge -> TE) of a symmetric fin, node origin on the hinge line."""
    mb = MB(name)
    rings = []
    for z in zs:
        lx, tx = le_fn(z), te_fn(z)
        cfull = lx - tx
        s_h = (lx - hinge_x) / cfull
        n = 12
        upper, lower = [], []
        for i in range(n + 1):
            s0 = s_h + 0.004 / cfull
            s = s0 + (1 - s0) * (i / n) ** 1.2
            _, yt = naca4(s, t)
            yt = max(yt, 0.0012) * cfull
            upper.append(V(lx - s * cfull, yt, z))
            lower.append(V(lx - s * cfull, -yt, z))
        r0 = upper[0].y
        nose = [V(hinge_x - 0.004 + math.sin(math.pi * j / 6) * r0 * 0.9, math.cos(math.pi * j / 6) * r0, z)
                for j in range(1, 6)]
        rings.append(upper + lower[::-1] + nose[::-1])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True)
    for z in (zs[0] + 0.08, (zs[0] + zs[-1]) * 0.5, zs[-1] - 0.08):
        mb.box((hinge_x + 0.01, 0, z), (0.05, 0.016, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(origin=origin, sharp_angle=45)


def fin_loft(mb, zs, le_fn, te_fn, y_fn=lambda z: 0.0, t=0.10, mat='Paint_White', s_end_fn=None, side=0):
    rings = []
    for z in zs:
        lx, tx = le_fn(z), te_fn(z)
        c = lx - tx
        s_end = s_end_fn(z) if s_end_fn else 1.0
        lp = airfoil_ring(14, t, te_min=0.002, s_end=s_end)
        rings.append([V(lx - s * c, y_fn(z) + tz * c, z) for s, tz in lp])
    mb.loft(rings, mat, closed=True, cap0=True, cap1=True)


def build_gear(leg_mat='Paint_Dark', pitot=None, antenna=True, steps=True, root=None, spats=True, tube=False,
               tyre_w=0.14, nose_bracket_z=-0.648, nose_spat=False, main_x=None, nose_x=None, mudguard=True):
    """Spring legs + optional spats + wheels. main_x / nose_x place the visual wheels (default: physics points)."""
    mb = MB('main_gear')
    xg = B.MAIN_WHEEL.x if main_x is None else main_x
    for sy in (1, -1):
        r0 = root if root else (0.0, -0.728)
        pts = catmull([V(xg, sy * r0[0], r0[1]), V(xg, sy * lerp(r0[0], 0.86, 0.35), lerp(r0[1], -0.862, 0.25)),
                       V(xg, sy * lerp(r0[0], 0.86, 0.65), lerp(r0[1], -0.862, 0.62)),
                       V(xg, sy * 0.86, -0.862)], 6)
        if tube:
            mb.tube(pts, 0.022, leg_mat, n=12, cap=True)
        else:
            mb.tube(pts, 0.0, leg_mat, n=20, square=(0.10, 0.032, 5), cap=True)
        mb.cyl(V(xg, sy * 0.84, -0.86), V(xg, sy * 1.035, -0.86), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(xg, sy * 0.875, -0.86), V(xg, sy * 0.885, -0.86), 0.085, 'Metal_Frame', n=24)
        mb.box((xg + 0.07, sy * 0.88, -0.83), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008, segs=1)
    if root is None:
        mb.box((xg, 0, -0.722), (0.12, 0.11, 0.035), 'Metal_Frame', bevel=0.008, segs=2)
    c = V(B.NOSE_WHEEL.x if nose_x is None else nose_x, 0, B.NOSE_WHEEL.z)
    mb.box((c.x, 0, nose_bracket_z), (0.10, 0.09, 0.04), 'Paint_Dark', bevel=0.012, segs=2)
    if pitot:
        x0, z = pitot
        mb.cyl(V(x0, 0, z), V(x0 + 0.14, 0, z), 0.006, 'Metal_Frame', n=10)
        mb.lathe([(0.0, x0 + 0.14), (0.006, x0 + 0.14), (0.0045, x0 + 0.155), (0.0, x0 + 0.156)], V(0, 0, z),
                 V(1, 0, 0), 'Metal_Frame', n=10)
    if antenna:
        mb.lathe([(0.0, 0.0), (0.012, 0.0), (0.004, 0.02), (0.0025, 0.32), (0.0, 0.322)], V(-2.30, 0, -0.66),
                 V(-0.25, 0, 1).normalized(), 'Paint_Dark', n=10)
    if steps:
        for sy in (1, -1):
            mb.cyl(V(-0.15, sy * 0.30, -0.72), V(-0.15, sy * 0.47, -0.74), 0.012, 'Metal_Frame', n=10)
            mb.box((-0.15, sy * 0.48, -0.742), (0.11, 0.07, 0.012), 'Metal_Frame', bevel=0.004, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats_l = []
    if spats:
        for name, yc in (('spat_L', B.MAIN_Y), ('spat_R', -B.MAIN_Y)):
            sp = B.spat_shell(name, yc)
            shift(sp, (xg - B.MAIN_WHEEL.x, 0, 0))
            spats_l.append(sp)
    B.build_wheel('wheel_L', V(xg, B.MAIN_Y, B.MAIN_WHEEL.z), 0.19, tyre_w, 0.11)
    B.build_wheel('wheel_R', V(xg, -B.MAIN_Y, B.MAIN_WHEEL.z), 0.19, tyre_w, 0.11)
    nb = MB('nose_wheel')
    R, w = 0.16, 0.095
    nb.lathe(B.tire_profile(R, 0.092, w), c, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    nb.lathe([(0.0, -0.034), (0.03, -0.034), (0.045, -0.025), (0.088, -0.032), (0.096, -0.034), (0.096, 0.034),
              (0.088, 0.032), (0.045, 0.025), (0.03, 0.034), (0.0, 0.034)], c, V(0, 1, 0), 'Engine', n=28)
    nb.cyl(c + V(0, -0.075, 0), c + V(0, 0.075, 0), 0.011, 'Metal_Frame', n=10)
    for sy in (1, -1):
        nb.tube(catmull([c + V(0.0, sy * 0.066, 0.0), c + V(0.012, sy * 0.068, 0.12), c + V(0.0, sy * 0.064, 0.215)],
                        4), 0.0, leg_mat, n=16, square=(0.012, 0.05, 5), cap=True)
    nb.box(c + V(0, 0, 0.222), (0.07, 0.15, 0.03), leg_mat, bevel=0.01, segs=2)
    nb.cyl(c + V(0, 0, 0.23), c + V(0, 0, 0.36), 0.022, 'Metal_Frame', n=14)
    if mudguard:
        arc = [c + V(math.cos(math.radians(lerp(25, 150, k / 12))) * 0.188, 0,
                     math.sin(math.radians(lerp(25, 150, k / 12))) * 0.188) for k in range(13)]
        nb.tube(arc, 0.0, 'Paint_White', n=16, square=(0.10, 0.008, 6), cap=True)
    nb.finish(origin=c, sharp_angle=40)
    return gear, spats_l


# ===========================================================================
# ELA 10 Eclipse  (traced on side photos, anchored on the rotor hub, which the sim fixes)
# ===========================================================================
E_DX = 0.23            # real cabin sits this much further forward of the hub than the old layout
E_PROP_X = -1.25       # visual prop plane (real); physics keeps its own thrust point
E_NOSE_X = 1.83        # visual nose wheel (real)
_E_TABLE = [
    # x      zt      zu     wu     zc     wc     zb      (low, smooth canopy; widest at the blunt engine cowling)
    (1.30, -0.120, -0.290, 0.290, -0.490, 0.300, -0.730),
    (1.05, 0.050, -0.220, 0.310, -0.470, 0.320, -0.740),
    (0.70, 0.200, -0.170, 0.320, -0.460, 0.330, -0.740),
    (0.30, 0.290, -0.150, 0.330, -0.460, 0.335, -0.740),
    (-0.10, 0.330, -0.140, 0.340, -0.460, 0.345, -0.740),
    (-0.45, 0.350, -0.120, 0.360, -0.450, 0.365, -0.720),
    (-0.70, 0.370, -0.090, 0.400, -0.430, 0.400, -0.660),
    (-0.91, 0.380, -0.060, 0.410, -0.400, 0.410, -0.560),
    (-1.15, 0.370, -0.040, 0.380, -0.300, 0.380, -0.400),
    (-1.35, 0.360, -0.020, 0.330, -0.150, 0.330, -0.200),
    (-1.42, 0.355, 0.000, 0.310, -0.100, 0.310, -0.140),
]
ECLIPSE = Fuselage([(r[0] + E_DX,) + r[1:] for r in _E_TABLE], tip=(1.96 + E_DX, -0.60), nt=2.0, nb=2.6,
                   nose_exp=1.0, bow=0.0, nose_curve=((-0.45, -0.80), (0.0, 0.45), (-0.05, -0.75)))

E_SILL = [(1.45 + E_DX, -0.215), (-0.45 + E_DX, -0.225)]               # side-glass lower edge (side view)
E_FRONT = ((1.30 + E_DX, 0.15), (1.43 + E_DX, -0.22))                  # canopy front edge
E_REAR = ((-0.255 + E_DX, 0.56), (-0.32 + E_DX, -0.25))                # canopy rear edge
E_FRONT_HIP = V(0.72 + E_DX, 0, -0.56)
E_REAR_HIP = V(0.17 + E_DX, 0, -0.52)


def sill_z(x, pts=E_SILL):
    if x >= pts[0][0]:
        return pts[0][1]
    for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
        if x1 <= x <= x0:
            return lerp(z0, z1, (x0 - x) / (x0 - x1))
    return pts[-1][1]


def rear_edge_x(z):
    (x0, z0), (x1, z1) = E_REAR
    return x0 + (x1 - x0) * (z - z0) / (z1 - z0)


def front_edge_x(z):
    (x0, z0), (x1, z1) = E_FRONT
    return x0 + (x1 - x0) * (z - z0) / (z1 - z0)


def build_pod_ela10():
    pod = ECLIPSE.shell('pod', step=0.035, n_half=36, rear=((0.008, 0.94), (0.016, 0.80), (0.020, 0.55)))
    me = pod.data
    for nm in ('Paint_Dark', 'Glass'):
        me.materials.append(MATS[nm])
    names = [m.name for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    planes = [plane_pts(a, b) for a, b in zip(E_SILL, E_SILL[1:])] + [plane_pts(*E_REAR), plane_pts(*E_FRONT)]
    bisect_all(bm, planes)
    gi, wi = names.index('Glass'), names.index('Paint_White')
    for f in bm.faces:
        c = f.calc_center_median()
        f.material_index = gi if (c.z > sill_z(c.x) and rear_edge_x(c.z) < c.x < front_edge_x(c.z)) else wi
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    can_me = me.copy()
    can = bpy.data.objects.new('canopy', can_me)
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
    remove_faces_with_material(pod, 'Paint_Dark')
    frame = opening_rim(pod, 'canopy_frame', r=0.008, mat='Paint_White', inset=0.004)
    seal = opening_rim(pod, 'canopy_seal', r=0.006, mat='Paint_Dark', inset=0.010)
    thicken_shell(pod, 1)
    return pod, frame, seal, can


def build_pylon_ela10():
    mb = MB('pylon')
    TE = hermite([0.28, 0.50, 0.75, 1.00, 1.385], [-1.02, -0.88, -0.70, -0.55, -0.44])
    LE = lambda z: lerp(-0.33, -0.20, (z - 0.28) / 1.105)
    rings = []
    for z in (0.28, 0.38, 0.48, 0.60, 0.72, 0.86, 1.00, 1.14, 1.26, 1.34, 1.385):
        u = (z - 0.28) / 1.105
        le = LE(z)
        c = le - TE(z)
        thick = lerp(0.135, 0.115, u)
        loop = airfoil_ring(18, min(thick / c, 0.9), te_min=0.004)
        rings.append([V(le - s * c, tz * c, z) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    mb.sphere(V(LE(0.52) + 0.004, 0, 0.52), 0.05, 'Paint_Dark', seg=24, rings=12, scale=(0.45, 1.05, 1.55))
    d = (B.MAST_TOP - B.MAST_BOT).normalized()
    mb.tube([B.MAST_TOP - d * 0.10, B.MAST_TOP], 0.05, 'Metal_Frame', n=28, square=(0.08, 0.10, 10))
    hp = B.HEAD_PIVOT
    for sy in (1, -1):
        mb.box((hp.x - 0.015, sy * 0.058, 1.445), (0.13, 0.012, 0.13), 'Metal_Frame', bevel=0.012, segs=2,
               rot=Euler((0, math.radians(-3.5), 0)))
        mb.cyl(V(hp.x, sy * 0.050, hp.z), V(hp.x, sy * 0.078, hp.z), 0.016, 'Engine', n=12)
    mb.cyl(V(hp.x, -0.078, hp.z), V(hp.x, 0.078, hp.z), 0.009, 'Metal_Frame', n=10)
    # prop gearbox flange between the blunt cowling face and the spinner, exhaust stub
    xr = ECLIPSE.xrear
    mb.cyl(V(xr - 0.012, 0, B.PROP_C.z), V(E_PROP_X + 0.075, 0, B.PROP_C.z), 0.15, 'Engine_Dark', n=32)
    mb.tube(catmull([V(xr + 0.40, -0.13, -0.52), V(xr + 0.26, -0.14, -0.46), V(xr + 0.16, -0.14, -0.36)], 4),
            0.025, 'Metal_Frame', n=12, cap=True)
    return mb.finish(sharp_angle=50)


def build_sponsons_ela10():
    """Rounded side sponsons along the lower cabin."""
    mb = MB('sponsons')
    for sy in (1, -1):
        xs = [x + E_DX for x in (1.47, 1.40, 1.30, 1.10, 0.80, 0.40, 0.00, -0.15, -0.26)]
        pts = [V(x, sy * (ECLIPSE.params(x)['wc'] + 0.030), -0.45 + 0.02 * max(0.0, x - E_DX - 1.2)) for x in xs]
        rad = [0.030, 0.055, 0.078, 0.086, 0.088, 0.088, 0.085, 0.070, 0.035]
        pts = catmull(pts, 5)
        n = len(pts)
        rr = []
        for i in range(n):
            t = i / (n - 1) * (len(rad) - 1)
            k = min(int(t), len(rad) - 2)
            rr.append(lerp(rad[k], rad[k + 1], t - k))
        mb.tube(pts, rr, 'Paint_White', n=18)
    return mb.finish(sharp_angle=60)


def build_boom_ela10():
    """Straight and low under the prop, then a tight curve up into the ventral fin."""
    mb = MB('boom')
    ctrl = [(-0.40, -0.64), (-0.70, -0.75), (-1.10, -0.81), (-1.50, -0.82), (-1.76, -0.78), (-1.95, -0.67),
            (-2.07, -0.52), (-2.16, -0.38), (-2.24, -0.22), (-2.29, -0.04), (-2.31, 0.14), (-2.32, 0.24)]
    pts = catmull([V(x, 0, z) for x, z in ctrl], samples=6)
    n = len(pts)
    mb.tube(pts, [lerp(0.056, 0.040, i / (n - 1)) for i in range(n)], 'Paint_White', n=22)
    return mb.finish(sharp_angle=60)


# tail box measured at x -2.15 .. -3.09 (stabiliser top ~+0.25, ventral fin bottom ~-0.6)
E_STAB_Z = 0.24
E_HINGE = -2.78


def e_fin_le(z):
    return lerp(-2.27, -2.18, (z + 0.58) / 0.82)


def e_fin_te(z):
    return lerp(-3.06, -3.00, (z + 0.58) / 0.82)


def build_tail_ela10():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.10, te_min=0.002)
    rings = []
    for y in (-0.80, -0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6, 0.80):
        u = abs(y) / 0.80
        le = lerp(-2.18, -2.30, u)
        ch = lerp(0.52, 0.42, u)
        rings.append([V(le - s * ch, y, E_STAB_Z + tz * ch) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    for sy in (1, -1):
        y = sy * 0.805
        up_le = lambda z: lerp(-2.30, -2.66, max(0.0, (z - E_STAB_Z) / 0.30) ** 0.9)
        up_te = lambda z: lerp(-2.74, -2.76, (z - E_STAB_Z) / 0.30)
        fin_loft(mb, [E_STAB_Z - 0.02, E_STAB_Z + 0.06, E_STAB_Z + 0.14, E_STAB_Z + 0.22, E_STAB_Z + 0.28,
                      E_STAB_Z + 0.30], lambda z: max(up_le(z), up_te(z) + 0.06), up_te, y_fn=lambda z: y, t=0.08)
        lo_le = lambda z: lerp(-2.30, -2.42, (E_STAB_Z - z) / 0.42)
        lo_te = lambda z: lerp(-2.74, -2.92, (E_STAB_Z - z) / 0.42)
        fin_loft(mb, [E_STAB_Z - 0.42, E_STAB_Z - 0.39, E_STAB_Z - 0.26, E_STAB_Z - 0.10, E_STAB_Z + 0.02],
                 lo_le, lo_te, y_fn=lambda z: y, t=0.08)
    zs = (-0.58, -0.54, -0.40, -0.22, -0.02, 0.12, E_STAB_Z)
    fin_loft(mb, zs, e_fin_le, e_fin_te, t=0.11,
             s_end_fn=lambda z: (e_fin_le(z) - E_HINGE) / (e_fin_le(z) - e_fin_te(z)))
    mb.box((-2.65, 0, -0.595), (0.20, 0.035, 0.03), 'Paint_Dark', bevel=0.012, segs=2)
    return mb.finish(sharp_angle=45)


def build_cockpit_ela10():
    mb = MB('cockpit')
    o = V(E_DX, 0, 0)
    bucket_seat(mb, E_FRONT_HIP, 32, width=0.36, base=False)
    bucket_seat(mb, E_REAR_HIP, 30, width=0.40, base=False)
    # (instrument panel: blender/panel.py, built once the hull exists)
    mb.box(V(1.00, 0, -0.67) + o, (0.18, 0.12, 0.08), 'Interior', bevel=0.02, segs=2)
    for sy in (1, -1):
        mb.tube(catmull([V(0.28, sy * 0.29, -0.18) + o, V(0.35, sy * 0.30, -0.14) + o,
                         V(0.42, sy * 0.29, -0.18) + o], 4), 0.012, 'Panel', n=8)
    return mb.finish(sharp_angle=40, wn=True)


def build_ela10():
    o = V(E_DX, 0, 0)
    pod, cframe, seal, canopy = build_pod_ela10()
    pylon = build_pylon_ela10()
    B.build_rotor_head()
    B.build_rotor()
    shift(B.build_prop(), (E_PROP_X - B.PROP_C.x, 0, 0))
    boom = build_boom_ela10()
    spons = build_sponsons_ela10()
    tail = build_tail_ela10()
    build_rudder_surface('rudder', (-0.56, -0.46, -0.30, -0.12, 0.04, 0.14, 0.20), e_fin_le, e_fin_te, E_HINGE,
                         V(E_HINGE, 0, -0.17), t=0.11)
    gear, spats = build_gear(leg_mat='Paint_White', antenna=False, steps=False, root=(0.33, -0.52),
                             nose_bracket_z=-0.62, nose_x=E_NOSE_X)
    cockpit = build_cockpit_ela10()
    # grip top 0.31 m above the H-point (it used to hide the bottom of the panel from the pilot's eye)
    ctrl = MB('controls_static')
    stick, grip, axis = controls.gyro_stick(V(0.95, 0, -0.70) + o, V(0.869, 0, -0.25) + o)
    knob, lever = controls.throttle_lever(ctrl, V(0.79, 0.275, -0.365) + o)
    pilot.build_pilot('pilot_front', E_FRONT_HIP, 32,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': V(1.31, 0.13, -0.55) + o, 'R': V(1.31, -0.13, -0.55) + o}, knee_out=0.05,
                      elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], -0.65)
    # carbon panel that follows the canopy, live instruments on the shoulders, console between the
    # legs (the shins cross the panel plane 9-21 cm below its centre, 9-21 cm either side)
    PANEL.build_panel(ctrl, V(1.45, 0, -0.25), 26, [pod, canopy, cframe], zone=(0.0, 0.007, 0.40, 0.146),
                      cw=0.062, v_leg=-0.066, v_sb=-0.30, v_b=-0.36, leg_exp=0.25)
    ctrl = ctrl.finish(sharp_angle=40)
    # the passenger's knees straddle the (narrower) front seat back; boots stay off the rounded belly
    pilot.build_pilot('pilot_rear', E_REAR_HIP, 30,
                      hands={'R': ('rest', E_REAR_HIP + V(0.17, -0.19, 0.27), None),
                             'L': ('rest', E_REAR_HIP + V(0.17, 0.19, 0.27), None)},
                      feet={'L': V(0.47, 0.17, -0.58) + o, 'R': V(0.47, -0.17, -0.58) + o}, knee_out=0.07)
    vents = MB('vents')
    for sy in (1, -1):
        pilot.surface_patch(vents, pod, V(-0.80, sy * 0.38, 0.12), V(0, sy, 0), V(1, 0, 0), V(0, 0, 1),
                            0.16, 0.05, 0.004, 'Paint_Dark')
    vents = vents.finish(sharp_angle=60)
    regs = build_registration(pod, LIVERY['ela10']['reg'], cx=-0.62, cz=0.05, size=0.10, mat='Paint_Accent')
    make_eye(V(0.50, 0.0, 0.05) + o)
    finalize([pod, cframe, seal, pylon, boom, spons, tail, gear, vents] + spats + [cockpit, ctrl] + regs, [canopy])
    B.REQUIRED = dict(B.REQUIRED)
    B.REQUIRED['stick'] = (0.95 + E_DX, -0.70, 0.0)
    B.REQUIRED['eye_front'] = (0.50 + E_DX, 0.05, 0.0)
    B.REQUIRED['rudder'] = (E_HINGE, -0.17, 0.0)
    B.REQUIRED['prop'] = (E_PROP_X, B.PROP_C.z, 0.0)
    B.REQUIRED['nose_wheel'] = (E_NOSE_X, B.NOSE_WHEEL.z, 0.0)


# ===========================================================================
# ELA 07 Cougar  (traced on a side photo, anchored on the rotor hub)
# ===========================================================================
COUGAR = Fuselage([
    # x      zt      zu     wu     zc     wc     zb      (closed envelope; the open tub is cut below)
    (2.10, -0.420, -0.450, 0.055, -0.500, 0.060, -0.540),
    (1.98, -0.350, -0.400, 0.100, -0.520, 0.105, -0.580),
    (1.82, -0.215, -0.300, 0.160, -0.530, 0.165, -0.610),
    (1.69, -0.080, -0.220, 0.200, -0.520, 0.205, -0.665),
    (1.56, 0.050, -0.140, 0.240, -0.500, 0.245, -0.690),
    (1.40, 0.120, -0.080, 0.280, -0.460, 0.290, -0.690),
    (1.20, 0.200, -0.040, 0.310, -0.450, 0.320, -0.690),
    (0.90, 0.300, 0.000, 0.325, -0.440, 0.335, -0.690),
    (0.40, 0.370, 0.040, 0.330, -0.440, 0.335, -0.690),
    (0.00, 0.390, 0.060, 0.330, -0.440, 0.335, -0.690),
    (-0.30, 0.380, 0.070, 0.320, -0.440, 0.325, -0.685),
    (-0.43, 0.360, 0.060, 0.300, -0.430, 0.305, -0.670),
], tip=(2.22, -0.455), nt=2.3, nb=3.0, nose_exp=1.0, bow=0.004, linear_nose=True)

# top edge of the side walls (side view, traced): rear shell, rear cockpit, closed hoop behind the front
# seat (carries the rear windscreen), long low front cockpit, front cowl rising to the windscreen
C_RIM = [(-0.415, 0.36), (-0.305, 0.24), (-0.169, 0.053), (-0.075, -0.066), (0.044, -0.134), (0.227, -0.172),
         (0.362, -0.177), (0.368, 0.45), (0.44, 0.45), (0.495, 0.104), (0.546, -0.160), (0.627, -0.291),
         (0.895, -0.347), (1.133, -0.385), (1.290, -0.291), (1.397, -0.215), (1.478, -0.109), (1.533, 0.0),
         (1.565, 0.055)]
C_FRONT_HIP = V(0.68, 0, -0.42)
C_REAR_HIP = V(-0.17, 0, -0.34)   # far enough forward (and upright) for the passenger's helmet to clear the mast
C_ENG_DX = 0.21        # Rotax sits right behind the rear-seat shell
C_PROP_X = -1.24
C_MAIN_X = -0.62
C_NOSE_X = 1.30
C_RUDDER = V(-2.65, 0, 0.0)


def rim_z(x):
    for (x0, z0), (x1, z1) in zip(C_RIM, C_RIM[1:]):
        if x0 <= x <= x1:
            return lerp(z0, z1, (x - x0) / (x1 - x0))
    return 9.0


def windscreen(name, pod, xc, xside, hw, h, rake_deg, nu=26, nv=10, base_z=None):
    rake = math.radians(rake_deg)
    up = V(-math.sin(rake), 0, math.cos(rake))

    def base(u):
        y = u * hw
        x = xc - (xc - xside) * u * u
        z = base_z if base_z is not None else ray_down(pod, x, y)
        return V(x, y, (z if z is not None else 0.0) - 0.004)

    coords, faces = [], []
    bases = [base(-1 + 2 * i / nu) for i in range(nu + 1)]
    for j in range(nv + 1):
        v = j / nv
        for i in range(nu + 1):
            u = -1 + 2 * i / nu
            hh = h * (1 - 0.55 * abs(u) ** 5)
            coords.append(bases[i] + up * (hh * v) + V(0.035 * math.sin(math.pi * v), u * hw * 0.06 * v, 0))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append([a, a + 1, a + nu + 2, a + nu + 1])
    mb = MB(name)
    mb.faces(coords, faces, 'Glass')
    bm = mb.bm
    bm.normal_update()
    if sum(f.normal.x for f in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    ob = mb.finish(sharp_angle=80, recalc=False)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    apply_mods(ob)
    fr = MB(name + '_frame')
    fr.tube([b + V(0, 0, 0.006) for b in bases], 0.010, 'Paint_Dark', n=8)
    fr.tube([coords[nv * (nu + 1) + i] for i in range(nu + 1)], 0.006, 'Paint_Dark', n=8)
    return ob, fr.finish(sharp_angle=60)


def build_pod_ela07():
    pod = COUGAR.shell('pod', step=0.03, n_half=36, rear=((0.010, 0.93), (0.020, 0.74), (0.026, 0.42)))
    me = pod.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bisect_all(bm, [plane_pts(a, b) for a, b in zip(C_RIM, C_RIM[1:])])
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if C_RIM[0][0] < c.x < C_RIM[-1][0] and c.z > rim_z(c.x):
            kill.append(f)
        f.smooth = True
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    rim = opening_rim(pod, 'cockpit_rim', r=0.017, mat='Seat', inset=0.004)
    thicken_shell(pod, 1)
    return pod, rim


def build_chin_ela07():
    """Long fairing under the nose that wraps the top of the nose wheel."""
    mb = MB('chin')
    x0, x1 = 1.66, 0.92
    rings = [[V(x0, 0, -0.705)]]
    for u in (0.02, 0.06, 0.14, 0.26, 0.40, 0.55, 0.70, 0.82, 0.91, 0.97, 1.0):
        _, t = naca4(u, 0.24)
        f = t / 0.12
        hw = 0.095 * f + 0.004
        dn = 0.15 * f + 0.004
        x = lerp(x0, x1, u)
        ring = []
        for k in range(28):
            a = TAU * k / 28
            ca, sa = math.cos(a), math.sin(a)
            ring.append(V(x, sgnpow(ca, 2 / 2.4) * hw, -0.69 + (sgnpow(sa, 2 / 2.4) * 0.03 if sa > 0 else sa * dn)))
        rings.append(ring)
    faces = mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    kill = [f for f in faces if f.calc_center_median().z < -0.80 and abs(f.calc_center_median().x - C_NOSE_X) < 0.21]
    bmesh.ops.delete(mb.bm, geom=kill, context='FACES')
    ob = mb.finish(sharp_angle=60)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.006
    sol.offset = -1
    apply_mods(ob)
    return ob


def build_frame_ela07():
    """Body-coloured mast, keel that runs straight then kicks up to the tail, engine mount, pre-rotator shaft."""
    mb = MB('frame')
    d = (B.MAST_TOP - B.MAST_BOT).normalized()
    mb.tube([B.MAST_BOT - d * 0.2, B.MAST_BOT, B.MAST_TOP], 0.05, 'Paint_White', n=28, square=(0.08, 0.10, 10))
    hp = B.HEAD_PIVOT
    for sy in (1, -1):
        mb.box((hp.x - 0.015, sy * 0.058, 1.445), (0.13, 0.012, 0.13), 'Metal_Frame', bevel=0.012, segs=2,
               rot=Euler((0, math.radians(-3.5), 0)))
        mb.cyl(V(hp.x, sy * 0.050, hp.z), V(hp.x, sy * 0.078, hp.z), 0.016, 'Engine', n=12)
    mb.cyl(V(hp.x, -0.078, hp.z), V(hp.x, 0.078, hp.z), 0.009, 'Metal_Frame', n=10)
    keel = [(1.10, -0.655), (0.40, -0.665), (-0.20, -0.672), (-0.60, -0.70), (-0.90, -0.735), (-1.25, -0.745),
            (-1.48, -0.72), (-1.62, -0.63), (-1.74, -0.565), (-1.90, -0.548), (-2.30, -0.548), (-2.70, -0.55)]
    mb.tube(catmull([V(x, 0, z) for x, z in keel], samples=6), 0.045, 'Paint_White', n=24, square=(0.075, 0.09, 6))
    # diagonal brace from the engine mount down to the keel (the 'V' seen from the side)
    mb.tube([V(-0.66, 0, -0.42), V(-1.45, 0, -0.71)], 0.03, 'Paint_White', n=16, square=(0.05, 0.06, 6))
    # engine mount plate + struts (engine moved forward against the shell)
    mb.box((-0.47, 0, 0.13), (0.012, 0.24, 0.30), 'Paint_White', bevel=0.01, segs=2)
    for sy in (1, -1):
        for z0, z1 in ((0.24, 0.16), (0.02, -0.06)):
            mb.cyl(V(-0.47, sy * 0.10, z0), V(-0.80 + C_ENG_DX, sy * 0.10, z1), 0.012, 'Paint_White', n=10)
        mb.cyl(V(-0.62, sy * 0.02, -0.69), V(-0.80 + C_ENG_DX, sy * 0.10, -0.20), 0.012, 'Paint_White', n=10)
    # pre-rotator drive shaft from the mast back over the engine to the prop gearbox
    mb.cyl(V(-0.36, 0, 0.43), V(C_PROP_X + 0.10, 0, 0.43), 0.016, 'Metal_Frame', n=12)
    mb.box((C_PROP_X + 0.09, 0, 0.34), (0.05, 0.10, 0.20), 'Engine_Dark', bevel=0.012, segs=2)
    return mb.finish(sharp_angle=40, wn=True)


C_HINGE = -2.50


def c_fin_le(z):
    """Central fin leading edge: vertical, with a rounded top-front corner."""
    return -2.15 - 0.05 * max(0.0, (z - 0.30) / 0.12) ** 2


def c_rudder_te(z):
    """Rudder trailing edge, further aft at the bottom."""
    return lerp(-2.86, -2.66, (z + 0.48) / 0.90)


def build_tail_ela07():
    """Central fin with a big rudder, swept and slightly drooping tailplane at its foot, two smaller side fins."""
    mb = MB('tail')
    loop = airfoil_ring(14, 0.09, te_min=0.002)
    rings = []
    for y in (-0.78, -0.64, -0.50, -0.36, -0.22, -0.10, 0.0, 0.10, 0.22, 0.36, 0.50, 0.64, 0.78):
        u = abs(y) / 0.78
        le = lerp(-1.82, -2.55, u ** 0.9)
        te = lerp(-2.70, -2.80, u)
        ch = le - te
        z = -0.49 - 0.07 * u
        rings.append([V(le - s * ch, y, z + tz * ch) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    zs = (-0.50, -0.44, -0.30, -0.10, 0.10, 0.26, 0.34, 0.39, 0.42)
    fin_loft(mb, zs, c_fin_le, c_rudder_te, t=0.10,
             s_end_fn=lambda z: (c_fin_le(z) - C_HINGE) / (c_fin_le(z) - c_rudder_te(z)))
    # two smaller side fins standing on the tailplane tips (photos: U seen from the front),
    # swept, about half the central fin's height, leaning slightly outwards
    for sy in (1, -1):
        fin_loft(mb, [-0.61, -0.57, -0.48, -0.36, -0.24, -0.13, -0.07, -0.05],
                 lambda z: lerp(-2.49, -2.68, (z + 0.61) / 0.56), lambda z: lerp(-2.82, -2.86, (z + 0.61) / 0.56),
                 y_fn=lambda z, sy=sy: sy * (0.765 + 0.05 * max(0.0, z + 0.56) / 0.51), t=0.08)
    mb.box((-2.60, 0, -0.565), (0.18, 0.03, 0.03), 'Paint_Dark', bevel=0.01, segs=2)
    return mb.finish(sharp_angle=45)


def build_cockpit_ela07():
    mb = MB('cockpit')
    bucket_seat(mb, C_FRONT_HIP, 14, width=0.44)
    bucket_seat(mb, C_REAR_HIP, 4, width=0.44, headrest=False)
    # (front instrument panel: blender/panel.py, built once the hull exists)
    panel(mb, V(0.355, 0, 0.10), 0.26, 0.10, 6, gauges=False, glare=False)
    for gy in (0.065, -0.065):
        c = V(0.338, gy, 0.10)
        mb.cyl(c, c + V(-0.008, 0, 0.001), 0.028, 'Metal_Frame', n=18)
        mb.cyl(c + V(-0.008, 0, 0.001), c + V(-0.0085, 0, 0.001), 0.024, 'Gauge_Face', n=18)
    mb.box((0.92, 0, -0.63), (0.16, 0.12, 0.12), 'Interior', bevel=0.02, segs=2)
    return mb.finish(sharp_angle=40, wn=True)


def build_ela07():
    pod, rim = build_pod_ela07()
    chin = build_chin_ela07()
    frame = build_frame_ela07()
    B.build_rotor_head()
    B.build_rotor()
    engine = shift(B.build_engine(), (C_ENG_DX, 0, 0))
    shift(B.build_prop(), (C_PROP_X - B.PROP_C.x, 0, 0))
    tail = build_tail_ela07()
    build_rudder_surface('rudder', (-0.46, -0.40, -0.25, -0.05, 0.15, 0.30, 0.38, 0.41), c_fin_le, c_rudder_te,
                         C_HINGE, V(C_HINGE, 0, 0.0), t=0.10)
    gear, spats = build_gear(pitot=None, antenna=False, steps=False, spats=False, tube=True, tyre_w=0.17,
                             main_x=C_MAIN_X, nose_x=C_NOSE_X, mudguard=False, nose_bracket_z=-0.64)
    ws1, fr1 = windscreen('ws_front', pod, 1.60, 1.555, 0.24, 0.42, 25)
    ws2, fr2 = windscreen('ws_rear', pod, 0.42, 0.40, 0.25, 0.26, 25, base_z=0.372)
    cockpit = build_cockpit_ela07()
    ctrl = MB('controls_static')
    stick, grip, axis = controls.gyro_stick(V(0.92, 0, -0.62), V(0.893, 0, -0.12))
    knob, lever = controls.throttle_lever(ctrl, V(0.83, 0.29, -0.315))
    pilot.build_pilot('pilot_front', C_FRONT_HIP, 14,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': V(1.31, 0.14, -0.55), 'R': V(1.31, -0.14, -0.55)}, elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], -0.65)
    # (open cockpit: the top follows a fixed arch under the front cowl)
    PANEL.build_panel(ctrl, V(1.38, 0, -0.18), 28, [pod, chin, ws1], zone=(0.0, -0.01, 0.44, 0.17),
                      cw=0.08, v_leg=-0.13, v_sb=-0.36, v_b=-0.42, top_arch=(0.285, 0.03, 0.135),
                      max_u=0.265)
    ctrl = ctrl.finish(sharp_angle=40)
    # legs inside the tub (half-width 0.33, floor -0.62), feet clear of the front seat
    pilot.build_pilot('pilot_rear', C_REAR_HIP, 4,
                      hands={'R': ('rest', C_REAR_HIP + V(0.22, -0.14, 0.23), None),
                             'L': ('rest', C_REAR_HIP + V(0.22, 0.14, 0.23), None)},
                      feet={'L': V(0.29, 0.16, -0.52), 'R': V(0.29, -0.16, -0.52)}, knee_out=0.03, elbow_out=0.05)
    regs = build_registration(pod, LIVERY['ela07']['reg'], cx=0.05, cz=-0.40, size=0.10)
    make_eye((0.64, 0.0, 0.27))
    finalize([pod, rim, chin, frame, engine, tail, gear, fr1, fr2] + spats + [cockpit, ctrl] + regs, [ws1, ws2])
    B.REQUIRED = dict(B.REQUIRED)
    B.REQUIRED['eye_front'] = (0.64, 0.27, 0.0)
    B.REQUIRED['stick'] = (0.92, -0.62, 0.0)
    B.REQUIRED['prop'] = (C_PROP_X, B.PROP_C.z, 0.0)
    B.REQUIRED['rudder'] = (C_HINGE, 0.0, 0.0)
    B.REQUIRED['nose_wheel'] = (C_NOSE_X, B.NOSE_WHEEL.z, 0.0)
    B.REQUIRED['wheel_L'] = (C_MAIN_X, B.MAIN_WHEEL.z, -B.MAIN_Y)
    B.REQUIRED['wheel_R'] = (C_MAIN_X, B.MAIN_WHEEL.z, B.MAIN_Y)


# ---------------------------------------------------------------------------
def main():
    if VARIANT not in LIVERY:
        raise SystemExit('unknown --variant %s (use %s)' % (VARIANT, ', '.join(LIVERY)))
    scn = B.reset_scene()
    B.build_materials()
    pilot.ensure_materials()
    apply_livery(VARIANT)
    {'ela07': build_ela07, 'ela10': build_ela10}[VARIANT]()
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    B.check_normals()
    try:
        bpy.context.preferences.filepaths.save_version = 0
    except Exception:
        pass
    try:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, VARIANT + '.blend'))
    except RuntimeError as ex:       # e.g. the .blend is open elsewhere: still export the GLB
        print('  !! could not save .blend:', ex)
    B.GLB_PATH = os.path.join(ROOT, 'public', 'models', VARIANT + '.glb')
    B.export_glb()
    B.verify_glb(B.GLB_PATH)
    pr = bpy.data.objects.get('pilot_rear')
    if pr and '--show-rear' not in ARGV:
        pr.hide_render = True
    if B.DO_PREVIEWS:
        # the generic side camera (y=30) sits behind the curved backdrop; keep it on the flat floor
        B.PREVIEW_VIEWS['side'] = dict(loc=(0.0, 18.0, 0.30), target=(-0.75, 0.0, 0.30), ortho=9.4, rotor=0, prop=0)
        B.PREVIEW_VIEWS['photo_side'] = dict(loc=(1.2, -16.0, 0.9), target=(-0.6, 0.0, 0.2), lens=85, rotor=-30,
                                             prop=10, extra=True)
        B.PREVIEW_VIEWS['photo_low34'] = dict(loc=(4.6, -3.2, -0.55), target=(0.5, 0.0, -0.15), lens=32, rotor=-20,
                                              prop=15, extra=True)
        B.PREVIEW_VIEWS['tail_side'] = dict(loc=(-1.6, -4.2, 0.2), target=(-2.4, 0.0, -0.2), lens=45, rotor=75,
                                            prop=15, extra=True)
        B.PREVIEW_VIEWS['nose_detail'] = dict(loc=(3.4, -2.2, 0.0), target=(1.7, 0.0, -0.45), lens=45, rotor=75,
                                              prop=15, extra=True)
        B.PREVIEW_VIEWS['photo_front'] = dict(loc=(9.0, 0.0, 0.15), target=(0.0, 0.0, 0.25), lens=55, rotor=90, prop=0,
                                              extra=True)
        B.PREVIEW_VIEWS['photo_34'] = dict(loc=(5.2, -5.6, 4.6), target=(-0.5, 0.0, 0.0), lens=38, rotor=-25,
                                           prop=10, extra=True)
        B.PREVIEW_VIEWS['tail_detail'] = dict(loc=(-1.0, -3.2, 1.3), target=(-3.2, 0.0, -0.1), lens=40, rotor=75,
                                              prop=10, extra=True)
        B.PREVIEW_DIR = os.path.join(HERE, 'previews', VARIANT)
        B.render_previews(scn)


if __name__ == '__main__':
    main()
