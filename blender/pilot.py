"""
Seated gyroplane pilot / passenger for the Autogiro sim models.

Body, limbs, gloves and boots are metaballs (smooth organic blends) converted to meshes; the
full-face helmet, harness, collar and zip are modelled meshes. The pose comes from the seat:
H-point + back recline, and 2-bone IK to the hand targets (stick grip, throttle knob, thighs)
and foot targets (pedals / floor).

Usage (from a build script that already imported build_autogiro as B and built materials):
    import pilot
    pilot.ensure_materials()
    ob = pilot.build_pilot('pilot_front', hip=V(0.52, 0, -0.40), back_deg=14,
                           hands={'R': ('stick', grip_point, grip_axis), 'L': ('knob', knob_point, None)},
                           feet={'L': V(1.24, 0.15, -0.58), 'R': V(1.24, -0.15, -0.58)})
Blender axes: +X forward, +Y left, +Z up.  Units: metres.
"""
import bpy, bmesh, math
from mathutils import Vector, Quaternion, Matrix
import build_autogiro as B

MB, MATS, V = B.MB, B.MATS, B.V
K = 1.0 / 0.574          # metaball radius for stiffness 2 / threshold 0.6 -> visible radius
Z = Vector((0, 0, 1))
X = Vector((1, 0, 0))
Y = Vector((0, 1, 0))

# body dimensions (a ~1.78 m adult)
HIP_HALF = 0.088
SPINE = 0.50            # H-point -> shoulder line
SHOULDER_HALF = 0.185
UPPER_ARM = 0.295
FOREARM = 0.265
THIGH = 0.445
SHIN = 0.44


def ensure_materials():
    def mk(name, hexcol, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexcol), **kw)
    mk('Pilot_Suit', '#2C3542', rough=0.86)
    mk('Suit_Dark', '#1D232C', rough=0.9)
    mk('Glove', '#17181A', rough=0.62)
    mk('Boot', '#231E1A', rough=0.55)
    mk('Helmet', '#F3F3F1', rough=0.12, coat=1.0)
    mk('Helmet_Stripe', '#C8102E', rough=0.18)
    mk('Visor', '#0B0D10', metal=0.6, rough=0.06)
    mk('Harness', '#B3141F', rough=0.75)
    mk('Flag_Red', '#AA151B', rough=0.7)
    mk('Skin', '#C68E6B', rough=0.5)
    mk('Lips', '#9A5B50', rough=0.45)
    mk('Lens', '#2E3A48', metal=0.85, rough=0.04)
    mk('Smoke', '#3A4450', metal=0.5, rough=0.06)
    mk('Flag_Yellow', '#F1BF00', rough=0.7)
    mk('Metal_Frame', '#C9CCD0', metal=1.0, rough=0.24)
    mk('Rubber', '#141414', rough=0.88)
    mk('Leather', '#4A2E1C', rough=0.55)


# ---------------------------------------------------------------------------
# metaball helpers
# ---------------------------------------------------------------------------
class Meta:
    def __init__(self, name, res=0.011):
        self.mb = bpy.data.metaballs.new(name)
        self.mb.resolution = res
        self.mb.render_resolution = res
        self.mb.threshold = 0.6
        self.ob = bpy.data.objects.new(name, self.mb)
        bpy.context.scene.collection.objects.link(self.ob)

    def ball(self, c, r):
        e = self.mb.elements.new(type='BALL')
        e.co = c
        e.radius = r * K
        e.stiffness = 2.0
        return e

    def capsule(self, a, b, r):
        a, b = Vector(a), Vector(b)
        d = b - a
        L = max(d.length, 1e-4)
        e = self.mb.elements.new(type='CAPSULE')
        e.co = (a + b) * 0.5
        e.radius = r * K
        e.stiffness = 2.0
        e.size_x = L * 0.5
        e.rotation = X.rotation_difference(d.normalized())
        return e

    def ellipsoid(self, c, radii, rot=None):
        rmax = max(radii)
        e = self.mb.elements.new(type='ELLIPSOID')
        e.co = c
        e.radius = rmax * K
        e.stiffness = 2.0
        e.size_x, e.size_y, e.size_z = (radii[0] / rmax, radii[1] / rmax, radii[2] / rmax)
        if rot is not None:
            e.rotation = rot
        return e

    def to_mesh(self, mat, decimate=None):
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(self.ob.evaluated_get(dg))
        name = self.ob.name
        bpy.data.objects.remove(self.ob)
        bpy.data.metaballs.remove(self.mb)
        me.materials.clear()
        me.materials.append(MATS[mat])
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        if decimate:
            mod = ob.modifiers.new('dec', 'DECIMATE')
            mod.ratio = decimate
            B.apply_mods(ob)
        for p in ob.data.polygons:
            p.use_smooth = True
        return ob


def frame_quat(fwd, up):
    """Rotation whose local +X = fwd, +Z = up (orthonormalised)."""
    f = fwd.normalized()
    u = (up - f * up.dot(f)).normalized()
    l = u.cross(f)
    m = Matrix((f, l, u)).transposed()
    return m.to_quaternion()


def ik2(root, target, l1, l2, pole):
    d = target - root
    dist = min(max(d.length, 1e-4), (l1 + l2) * 0.999)
    dn = d.normalized()
    ca = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    ca = max(-1.0, min(1.0, ca))
    sa = math.sqrt(1 - ca * ca)
    p = (pole - dn * pole.dot(dn))
    p = p.normalized() if p.length > 1e-6 else Z
    joint = root + dn * (l1 * ca) + p * (l1 * sa)
    end = root + dn * dist
    return joint, end


# ---------------------------------------------------------------------------
# helmet (full face, visor down)
# ---------------------------------------------------------------------------
# (z, front, back, half-width) in the helmet frame, head centre at the origin
HELMET = [(0.168, 0.0, 0.0, 0.0), (0.160, 0.050, 0.060, 0.052), (0.145, 0.080, 0.094, 0.084),
          (0.120, 0.106, 0.122, 0.106), (0.090, 0.124, 0.140, 0.119), (0.060, 0.134, 0.149, 0.126),
          (0.020, 0.140, 0.153, 0.129), (-0.020, 0.143, 0.152, 0.129), (-0.045, 0.147, 0.149, 0.127),
          (-0.075, 0.153, 0.143, 0.124), (-0.105, 0.156, 0.134, 0.119), (-0.130, 0.152, 0.124, 0.113),
          (-0.150, 0.144, 0.114, 0.107)]
VISOR_ROWS = (4, 8)        # ring indices bounding the eye port (z 0.090 .. -0.045)
VISOR_HALF_ANGLE = 74.0


def build_helmet(name, center, fwd, up, n=64):
    q = frame_quat(fwd, up)
    M = Matrix.Translation(center) @ q.to_matrix().to_4x4() @ Matrix.Scale(0.95, 4)
    mb = MB(name)
    rings = []
    for (z, af, ab, w) in HELMET:
        if af == 0:
            rings.append([M @ Vector((0.012, 0, z))])
            continue
        r = []
        for k in range(n):
            a = math.tau * k / n
            c, s = math.cos(a), math.sin(a)
            x = (af if c >= 0 else ab) * B.sgnpow(c, 2 / 2.25)
            y = w * B.sgnpow(s, 2 / 2.1)
            r.append(M @ Vector((x, y, z)))
        rings.append(r)
    faces = mb.loft(rings, 'Helmet', closed=True)
    # material regions: visor port, crown stripes
    vi, si = mb.mi('Visor'), mb.mi('Helmet_Stripe')
    lim = math.radians(VISOR_HALF_ANGLE)
    for f in faces:
        c = M.inverted() @ f.calc_center_median()
        ring = max(i for i, h in enumerate(HELMET) if h[0] >= c.z - 1e-6) if c.z < HELMET[0][0] else 0
        ang = math.atan2(abs(c.y), c.x)
        if VISOR_ROWS[0] <= ring < VISOR_ROWS[1] and ang < lim and c.x > 0:
            f.material_index = vi
        elif 0.013 < abs(c.y) < 0.033 and c.z > 0.07:
            f.material_index = si
        elif c.z < -0.08 and c.x < -0.05 and abs(c.y) < 0.05:
            f.material_index = si
    # bottom neck roll
    bot = rings[-1]
    B.closed_tube(mb, [p for p in bot], 0.016, 'Suit_Dark', n=10)
    # visor gasket (follows the port outline)
    port = []
    zs = (HELMET[VISOR_ROWS[0]][0], HELMET[VISOR_ROWS[1]][0])
    for j in range(25):
        t = j / 24
        port.append(helmet_pt(M, zs[0], lerp(-lim, lim, t), n))
    for j in range(1, 9):
        port.append(helmet_pt(M, lerp(zs[0], zs[1], j / 8), lim, n))
    for j in range(1, 25):
        port.append(helmet_pt(M, zs[1], lerp(lim, -lim, j / 24), n))
    for j in range(1, 8):
        port.append(helmet_pt(M, lerp(zs[1], zs[0], j / 8), -lim, n))
    B.closed_tube(mb, port, 0.0055, 'Suit_Dark', n=8)
    # visor pivots, chin vents, crown vent
    for sy in (1, -1):
        p = M @ Vector((0.0, sy * 0.131, 0.028))
        d = (M.to_3x3() @ Vector((0, sy, 0))).normalized()
        mb.cyl(p - d * 0.006, p + d * 0.006, 0.024, 'Suit_Dark', n=20)
        mb.cyl(p + d * 0.006, p + d * 0.009, 0.014, 'Metal_Frame', n=16)
    c = M @ Vector((0.03, 0.0, 0.158))
    mb.box(c, (0.07, 0.030, 0.016), 'Suit_Dark', bevel=0.006, segs=2, rot=q @ Quaternion(Y, math.radians(8)))
    return mb.finish(sharp_angle=55)


# open-face aviation helmet with integrated headset (gyro pilots' usual kit)
OPEN_HELMET = [(0.152, 0.0, 0.0, 0.0), (0.145, 0.044, 0.054, 0.048), (0.131, 0.074, 0.086, 0.078),
               (0.110, 0.096, 0.108, 0.097), (0.082, 0.109, 0.121, 0.107), (0.052, 0.114, 0.127, 0.111),
               (0.022, 0.114, 0.129, 0.113), (-0.008, 0.110, 0.128, 0.113), (-0.038, 0.101, 0.123, 0.110),
               (-0.066, 0.088, 0.114, 0.104), (-0.088, 0.074, 0.103, 0.097)]


def build_head_open(name, center, fwd, up, n=56, visor_down=False):
    """Face + open-face helmet + headset cups + boom mic + sunglasses. Returns list of objects."""
    q = frame_quat(fwd, up)
    M = Matrix.Translation(center) @ q.to_matrix().to_4x4()
    R = q.to_matrix()
    P = lambda x, y, z: M @ Vector((x, y, z))
    out = []
    # --- face / head (skin)
    H = Meta(name + '_face', 0.0055)
    H.ellipsoid(P(-0.005, 0, 0.018), (0.097, 0.076, 0.094), q)
    H.ellipsoid(P(0.045, 0, -0.035), (0.060, 0.058, 0.060), q)
    H.ellipsoid(P(0.050, 0, -0.072), (0.046, 0.044, 0.036), q)
    H.ball(P(0.083, 0, -0.100), 0.020)
    for sy in (1, -1):
        H.ball(P(0.064, sy * 0.042, -0.006), 0.022)
        H.capsule(P(0.084, sy * 0.012, 0.031), P(0.080, sy * 0.050, 0.030), 0.014)
    H.capsule(P(0.097, 0, 0.012), P(0.110, 0, -0.028), 0.009)
    H.ball(P(0.109, 0, -0.029), 0.012)
    H.capsule(P(-0.012, 0, -0.07), P(-0.035, 0, -0.19), 0.050)
    out.append(H.to_mesh('Skin', decimate=0.3))
    # lips
    mb = MB(name + '_gear')
    mb.cyl(P(0.0975, -0.020, -0.067), P(0.0975, 0.020, -0.067), 0.0065, 'Lips', n=10)
    # --- helmet shell (single surface, face opening + bottom open)
    rings = []
    for (z, af, ab, w) in OPEN_HELMET:
        if af == 0:
            rings.append([P(0.010, 0, z)])
            continue
        r = []
        for k in range(n):
            a = math.tau * k / n
            c, s = math.cos(a), math.sin(a)
            r.append(P((af if c >= 0 else ab) * B.sgnpow(c, 2 / 2.3), w * B.sgnpow(s, 2 / 2.15), z))
        rings.append(r)
    shell = MB(name + '_shell')
    faces = shell.loft(rings, 'Helmet', closed=True)
    Mi = M.inverted()
    kill = []
    si = shell.mi('Helmet_Stripe')
    for f in faces:
        c = Mi @ f.calc_center_median()
        ang = math.degrees(math.atan2(abs(c.y), c.x))
        if c.z < 0.050 and ang < 64 - max(0.0, (-0.03 - c.z)) * 250:
            kill.append(f)
        elif 0.010 < abs(c.y) < 0.026 and c.z > 0.06 and not visor_down:
            f.material_index = si
    bmesh.ops.delete(shell.bm, geom=kill, context='FACES')
    sh = shell.finish(sharp_angle=60)
    sol = sh.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.007
    sol.offset = -1
    sh.data.materials.append(MATS['Suit_Dark'])
    sol.material_offset = len(sh.data.materials) - 1
    sol.material_offset_rim = len(sh.data.materials) - 1
    trim = MB(name + '_trim')
    for lp in B.boundary_loops(sh.data):
        pts = B.resample_loop([co for co, no in lp], 0.012)
        B.closed_tube(trim, pts, 0.0055, 'Suit_Dark', n=8)
    B.apply_mods(sh)
    out += [sh, trim.finish(sharp_angle=60)]
    # --- headset ear domes, visor (raised), pivots
    for sy in (1, -1):
        d = (R @ Vector((0, sy, 0))).normalized()
        c0 = P(-0.008, sy * 0.108, -0.028)
        mb.lathe([(0.0, 0.0), (0.046, 0.0), (0.047, 0.010), (0.042, 0.022), (0.030, 0.028), (0.0, 0.029)],
                 c0, d, 'Helmet', n=28)
        mb.lathe([(0.033, 0.024), (0.036, 0.026), (0.033, 0.030), (0.030, 0.026)], c0, d, 'Suit_Dark', n=24,
                 closed_profile=True)
        mb.cyl(P(0.005, sy * 0.110, 0.062), P(0.005, sy * 0.123, 0.062), 0.016, 'Suit_Dark', n=16)
    vis = []
    for j in range(5):
        z = lerp(0.068, 0.112, j / 4)
        row = []
        for i in range(17):
            a = math.radians(lerp(-66, 66, i / 16))
            # point on the shell at height z, azimuth a, pushed out 7 mm
            k = max(i0 for i0, h in enumerate(OPEN_HELMET) if h[0] >= z)
            h0, h1 = OPEN_HELMET[k], OPEN_HELMET[min(k + 1, len(OPEN_HELMET) - 1)]
            t = 0 if h0[0] == h1[0] else (h0[0] - z) / (h0[0] - h1[0])
            af, w = lerp(h0[1], h1[1], t) + 0.007, lerp(h0[3], h1[3], t) + 0.007
            row.append(P(af * B.sgnpow(math.cos(a), 2 / 2.3), w * B.sgnpow(math.sin(a), 2 / 2.15), z))
        vis.append(row)
    coords = [p for row in vis for p in row]
    vf = [[j * 17 + i, j * 17 + i + 1, (j + 1) * 17 + i + 1, (j + 1) * 17 + i] for j in range(4) for i in range(16)]
    mb.faces(coords, vf, 'Smoke')
    mb.tube([vis[0][i] for i in range(17)], 0.004, 'Suit_Dark', n=6)
    # --- boom mic from the left cup to the mouth
    mic = B.catmull([P(0.010, 0.118, -0.045), P(0.060, 0.090, -0.072), P(0.098, 0.040, -0.074),
                     P(0.112, 0.016, -0.070)], 6)
    mb.tube(mic, 0.0035, 'Suit_Dark', n=6)
    mb.sphere(mic[-1], 0.012, 'Suit_Dark', seg=12, rings=8)
    # --- chin strap
    strap = [P(-0.005, 0.104, -0.075), P(0.035, 0.070, -0.115), P(0.050, 0.0, -0.128), P(0.035, -0.070, -0.115),
             P(-0.005, -0.104, -0.075)]
    mb.tube(B.catmull(strap, 5), 0.0045, 'Suit_Dark', n=6)
    # --- sunglasses
    for sy in (1, -1):
        # aviator lens: teardrop outline, slightly curved, thin metal rim
        ring = []
        for k in range(20):
            a = math.tau * k / 20
            yy = 0.030 + 0.021 * math.cos(a) + 0.004 * math.cos(2 * a)
            zz = 0.010 + 0.016 * math.sin(a) - 0.005 * max(0.0, math.cos(a)) * max(0.0, -math.sin(a)) * 2
            ring.append(P(0.101 - 0.10 * (yy - 0.030) ** 2 * 4 - 0.0, sy * yy, zz))
        cen = P(0.103, sy * 0.030, 0.007)
        mb.faces([cen] + ring, [[0, i + 1, (i + 1) % 20 + 1] for i in range(20)], 'Lens', smooth=True)
        mb.faces([cen + (M.to_3x3() @ Vector((-0.002, 0, 0)))] + [p + (M.to_3x3() @ Vector((-0.002, 0, 0))) for p in ring],
                 [[0, (i + 1) % 20 + 1, i + 1] for i in range(20)], 'Lens', smooth=True)
        B.closed_tube(mb, ring, 0.0018, 'Metal_Frame', n=5)
        mb.cyl(P(0.094, sy * 0.052, 0.016), P(0.015, sy * 0.079, 0.014), 0.0018, 'Metal_Frame', n=5)
    mb.tube([P(0.102, -0.010, 0.019), P(0.106, 0.0, 0.021), P(0.102, 0.010, 0.019)], 0.0016, 'Metal_Frame', n=5)
    out.append(mb.finish(sharp_angle=55))
    return out


# 1930s leather flying helmet (Cierva C.30A crew): close-fitting cap over the ears, chin strap,
# goggles pushed up on the forehead. (z, front, back, half-width) in the head frame.
LEATHER_HELMET = [(0.128, 0.0, 0.0, 0.0), (0.124, 0.036, 0.046, 0.042), (0.112, 0.066, 0.078, 0.071),
                  (0.093, 0.088, 0.099, 0.090), (0.068, 0.101, 0.112, 0.101), (0.040, 0.106, 0.118, 0.106),
                  (0.010, 0.106, 0.120, 0.107), (-0.020, 0.102, 0.118, 0.105), (-0.050, 0.094, 0.110, 0.099),
                  (-0.078, 0.082, 0.097, 0.090), (-0.098, 0.070, 0.084, 0.080)]


def build_head_leather(name, center, fwd, up, n=56):
    """Face + leather helmet with ear flaps and chin strap + goggles on the forehead."""
    q = frame_quat(fwd, up)
    M = Matrix.Translation(center) @ q.to_matrix().to_4x4()
    R = q.to_matrix()
    P = lambda x, y, z: M @ Vector((x, y, z))
    out = []
    H = Meta(name + '_face', 0.0055)
    H.ellipsoid(P(-0.005, 0, 0.018), (0.097, 0.076, 0.094), q)
    H.ellipsoid(P(0.045, 0, -0.035), (0.060, 0.058, 0.060), q)
    H.ellipsoid(P(0.050, 0, -0.072), (0.046, 0.044, 0.036), q)
    H.ball(P(0.083, 0, -0.100), 0.020)
    for sy in (1, -1):
        H.ball(P(0.064, sy * 0.042, -0.006), 0.022)
        H.capsule(P(0.084, sy * 0.012, 0.031), P(0.080, sy * 0.050, 0.030), 0.014)
    H.capsule(P(0.097, 0, 0.012), P(0.110, 0, -0.028), 0.009)
    H.ball(P(0.109, 0, -0.029), 0.012)
    H.capsule(P(-0.012, 0, -0.07), P(-0.035, 0, -0.19), 0.050)
    out.append(H.to_mesh('Skin', decimate=0.3))
    mb = MB(name + '_gear')
    mb.cyl(P(0.0975, -0.020, -0.067), P(0.0975, 0.020, -0.067), 0.0065, 'Lips', n=10)
    # --- leather cap: face opening in front, covers forehead, ears and nape
    rings = []
    for (z, af, ab, w) in LEATHER_HELMET:
        if af == 0:
            rings.append([P(0.005, 0, z)])
            continue
        r = []
        for k in range(n):
            a = math.tau * k / n
            c, s = math.cos(a), math.sin(a)
            r.append(P((af if c >= 0 else ab) * B.sgnpow(c, 2 / 2.2), w * B.sgnpow(s, 2 / 2.1), z))
        rings.append(r)
    shell = MB(name + '_shell')
    faces = shell.loft(rings, 'Leather', closed=True)
    Mi = M.inverted()
    kill = []
    for f in faces:
        c = Mi @ f.calc_center_median()
        ang = math.degrees(math.atan2(abs(c.y), c.x))
        if c.z < 0.045 and ang < 58 - max(0.0, (-0.02 - c.z)) * 120:
            kill.append(f)
    bmesh.ops.delete(shell.bm, geom=kill, context='FACES')
    sh = shell.finish(sharp_angle=60)
    sol = sh.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.006
    sol.offset = -1
    B.apply_mods(sh)
    trim = MB(name + '_trim')
    for lp in B.boundary_loops(sh.data):
        pts = B.resample_loop([co for co, no in lp], 0.012)
        B.closed_tube(trim, pts, 0.0045, 'Leather', n=8)
    out += [sh, trim.finish(sharp_angle=60)]
    # seams over the crown, ear pads, chin strap with buckle
    # centre seam over the crown (forehead -> nape), 3 mm proud of the cap
    fr = [(af + 0.003, z + 0.002) for (z, af, ab, w) in LEATHER_HELMET[1:6]][::-1]
    bk = [(-ab - 0.003, z + 0.002) for (z, af, ab, w) in LEATHER_HELMET[1:10]]
    seam = [P(x, 0, z) for x, z in fr] + [P(0.0, 0, LEATHER_HELMET[0][0] + 0.003)] + [P(x, 0, z) for x, z in bk]
    mb.tube(B.catmull(seam, 3), 0.0032, 'Leather', n=5)
    for sy in (1, -1):
        d = (R @ Vector((0, sy, 0))).normalized()
        c0 = P(-0.005, sy * 0.104, -0.030)
        mb.lathe([(0.0, 0.0), (0.036, 0.0), (0.037, 0.005), (0.032, 0.010), (0.0, 0.011)], c0, d, 'Leather', n=24)
    strap = [P(-0.005, 0.098, -0.068), P(0.030, 0.070, -0.112), P(0.050, 0.0, -0.126), P(0.030, -0.070, -0.112),
             P(-0.005, -0.098, -0.068)]
    mb.tube(B.catmull(strap, 5), 0.005, 'Leather', n=6)
    mb.box(P(0.040, -0.052, -0.118), (0.016, 0.012, 0.012), 'Metal_Frame', bevel=0.002, segs=1)
    # --- goggles pushed up on the forehead: two round lenses in chrome rims, leather pad, elastic strap
    gz = 0.082
    for sy in (1, -1):
        cen = P(0.103, sy * 0.034, gz)
        nrm = (R @ Vector((1.0, sy * 0.25, 0.35))).normalized()
        u = (R @ Vector((0, 1, 0))).cross(nrm).normalized()
        v = nrm.cross(u).normalized()
        ring = [cen + (u * math.cos(TAU_ * k / 20) + v * math.sin(TAU_ * k / 20)) * 0.026 for k in range(20)]
        mb.faces([cen + nrm * 0.006] + ring, [[0, i + 1, (i + 1) % 20 + 1] for i in range(20)], 'Lens', smooth=True)
        B.closed_tube(mb, ring, 0.0045, 'Metal_Frame', n=8)
        back = [p - nrm * 0.016 for p in ring]
        B.closed_tube(mb, back, 0.007, 'Leather', n=8)
    mb.cyl(P(0.112, 0.010, gz + 0.004), P(0.112, -0.010, gz + 0.004), 0.004, 'Metal_Frame', n=6)
    # elastic strap round the cap at the goggles' height (on the cap surface, from rim to rim)
    zb, af, ab, w = 0.068 + 0.003, 0.101 + 0.004, 0.112 + 0.004, 0.101 + 0.004
    band = []
    for k in range(29):
        a = math.radians(lerp(38, 322, k / 28))
        c, s = math.cos(a), math.sin(a)
        band.append(P((af if c >= 0 else ab) * B.sgnpow(c, 2 / 2.2), w * B.sgnpow(s, 2 / 2.1), zb))
    mb.tube(band, 0.0, 'Suit_Dark', n=4, square=(0.004, 0.020, 6), cap=True)
    out.append(mb.finish(sharp_angle=55))
    return out


TAU_ = math.tau


def helmet_pt(M, z, ang, n):
    # point on the helmet surface at height z and azimuth ang (front = 0), slightly outside
    idx = [i for i, h in enumerate(HELMET)]
    for i in range(len(HELMET) - 1):
        z0, z1 = HELMET[i][0], HELMET[i + 1][0]
        if z1 <= z <= z0:
            t = (z0 - z) / (z0 - z1)
            af = lerp(HELMET[i][1], HELMET[i + 1][1], t)
            ab = lerp(HELMET[i][2], HELMET[i + 1][2], t)
            w = lerp(HELMET[i][3], HELMET[i + 1][3], t)
            break
    else:
        af, ab, w = HELMET[-1][1:]
    c, s = math.cos(ang), math.sin(ang)
    x = (af if c >= 0 else ab) * B.sgnpow(c, 2 / 2.25)
    y = w * B.sgnpow(s, 2 / 2.1)
    p = Vector((x, y, z))
    return M @ (p * 1.012)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------------------
# hands
# ---------------------------------------------------------------------------
def fist(meta, wrist, grip, axis, side):
    """Glove closed around a cylinder (grip centre, axis). side=+1 left hand, -1 right."""
    axis = axis.normalized()
    to_w = wrist - grip
    radial = (to_w - axis * to_w.dot(axis)).normalized()        # from grip axis toward the wrist side
    lat = axis.cross(radial).normalized() * side
    # palm on the wrist side of the grip, fingers wrap round the far side
    palm_c = grip + radial * 0.030
    meta.ellipsoid(palm_c, (0.042, 0.046, 0.024), frame_quat(axis, radial))
    for i in range(4):
        h = (i - 1.5) * 0.021
        base = grip + axis * h
        pts = []
        for k in range(5):
            a = math.radians(-60 + 210 * k / 4)
            pts.append(base + (radial * math.cos(a) + lat * math.sin(a)) * 0.032)
        for a, b in zip(pts, pts[1:]):
            meta.capsule(a, b, 0.0105 - i * 0.0008)
    # thumb over the top of the grip
    t0 = grip + radial * 0.03 + axis * 0.035 + lat * 0.022
    t1 = grip + axis * 0.048 + lat * 0.028
    meta.capsule(t0, t1, 0.012)
    meta.capsule(wrist, palm_c, 0.034)


def flat_hand(meta, wrist, fwd, up):
    """Glove resting flat (on the thigh): fingers forward along fwd."""
    fwd = fwd.normalized()
    lat = up.cross(fwd).normalized()
    palm = wrist + fwd * 0.055 + up * 0.005
    meta.ellipsoid(palm, (0.052, 0.045, 0.017), frame_quat(fwd, up))
    for i in range(4):
        o = lat * ((i - 1.5) * 0.019)
        a = palm + fwd * 0.045 + o
        b = a + fwd * (0.065 - abs(i - 1.2) * 0.008) - up * 0.012
        meta.capsule(a, b, 0.0095)
    meta.capsule(palm - lat * 0.035, palm - lat * 0.05 + fwd * 0.05 - up * 0.01, 0.011)
    meta.capsule(wrist, palm, 0.033)


# ---------------------------------------------------------------------------
# main builder
# ---------------------------------------------------------------------------
def build_pilot(name, hip, back_deg, hands, feet, head_pitch_deg=-4.0, knee_out=0.07, elbow_out=0.12,
                stripe=True, helmet='open'):
    ensure_materials()
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))          # spine up
    f = Vector((math.cos(b), 0, math.sin(b)))           # chest forward
    hip = Vector(hip)
    S = hip + u * SPINE
    sh = {'L': S + Y * SHOULDER_HALF - u * 0.02, 'R': S - Y * SHOULDER_HALF - u * 0.02}
    hp = {'L': hip + Y * HIP_HALF, 'R': hip - Y * HIP_HALF}
    head = S + u * 0.13 + Z * 0.072 + X * 0.035
    neck0 = S + u * 0.03
    parts = []

    # ---- torso + neck (flight suit)
    T = Meta(name + '_torso', 0.016)
    T.ellipsoid(hip + u * 0.07 - f * 0.01, (0.115, 0.170, 0.110), frame_quat(f, u))       # pelvis
    T.ellipsoid(hip + u * 0.23 + f * 0.005, (0.112, 0.160, 0.120), frame_quat(f, u))      # belly
    T.ellipsoid(hip + u * 0.37 + f * 0.012, (0.122, 0.185, 0.125), frame_quat(f, u))      # chest
    T.capsule(sh['L'] - u * 0.03 - Y * 0.06, sh['R'] - u * 0.03 + Y * 0.06, 0.072)         # shoulder girdle
    T.capsule(neck0, head - (head - neck0).normalized() * 0.115, 0.054)                     # collar / neck
    for s in ('L', 'R'):
        T.ball(hp[s] - f * 0.02 + u * 0.01, 0.092)                                           # seat / hips
    parts.append(T.to_mesh('Pilot_Suit', decimate=0.45))

    # ---- legs
    knee, ankle, legs, arms, elbows = {}, {}, {}, {}, {}
    for s, sy in (('L', 1), ('R', -1)):
        pole = Z * 1.0 + X * 0.3 + Y * sy * knee_out * 4
        knee[s], ankle[s] = ik2(hp[s], Vector(feet[s]), THIGH, SHIN, pole)
        L = Meta(name + '_leg' + s, 0.016)
        L.ball(hp[s] + f * 0.03, 0.088)
        L.capsule(hp[s] + (knee[s] - hp[s]) * 0.15, knee[s], 0.074)
        L.capsule(hp[s] + (knee[s] - hp[s]) * 0.5, knee[s], 0.068)
        L.ball(knee[s], 0.058)
        L.capsule(knee[s], ankle[s] + (knee[s] - ankle[s]).normalized() * 0.04, 0.053)
        L.capsule(knee[s] + (ankle[s] - knee[s]) * 0.15, knee[s] + (ankle[s] - knee[s]) * 0.45, 0.058)
        legs[s] = L.to_mesh('Pilot_Suit', decimate=0.4)
        parts.append(legs[s])
        # boot
        Bt = Meta(name + '_boot' + s, 0.011)
        down = (ankle[s] - knee[s]).normalized()
        fwd = (X - down * X.dot(down)).normalized()
        foot_dir = (fwd * 0.95 + Z * 0.15).normalized()
        Bt.capsule(ankle[s] - down * 0.09, ankle[s], 0.052)
        Bt.ellipsoid(ankle[s] + foot_dir * 0.07 - Z * 0.045, (0.125, 0.047, 0.040), frame_quat(foot_dir, Z))
        Bt.ball(ankle[s] - foot_dir * 0.02 - Z * 0.05, 0.040)
        Bt.ellipsoid(ankle[s] + foot_dir * 0.165 - Z * 0.058, (0.045, 0.042, 0.030), frame_quat(foot_dir, Z))
        parts.append(Bt.to_mesh('Boot', decimate=0.4))

    # ---- arms + gloves
    for s, sy in (('L', 1), ('R', -1)):
        kind, target, axis = hands[s]
        target = Vector(target)
        if kind in ('stick', 'knob'):
            ax = Vector(axis) if axis is not None else Z
            radial_guess = (sh[s] - target)
            radial_guess = (radial_guess - ax * radial_guess.dot(ax)).normalized()
            wrist_t = target + radial_guess * 0.085 - ax * 0.01
        else:                      # rest: target = palm centre on the thigh
            wrist_t = target - X * 0.07 + Z * 0.02
        pole = -Z * 1.0 - X * 0.4 + Y * sy * elbow_out * 4
        elbow, wrist = ik2(sh[s], wrist_t, UPPER_ARM, FOREARM, pole)
        A = Meta(name + '_arm' + s, 0.014)
        A.ball(sh[s], 0.068)
        A.capsule(sh[s], elbow, 0.054)
        A.ball(elbow, 0.047)
        A.capsule(elbow, wrist + (elbow - wrist).normalized() * 0.03, 0.045)
        arms[s] = A.to_mesh('Pilot_Suit', decimate=0.4)
        elbows[s] = elbow
        parts.append(arms[s])
        H = Meta(name + '_hand' + s, 0.0055)
        H.capsule(wrist + (elbow - wrist).normalized() * 0.07, wrist, 0.049)       # gauntlet
        if kind in ('stick', 'knob'):
            fist(H, wrist, target, Vector(axis) if axis is not None else Z, sy)
        else:
            thigh_dir = (knee[s] - hp[s]).normalized()
            flat_hand(H, wrist, thigh_dir, Z)
        parts.append(H.to_mesh('Glove', decimate=0.22))

    # ---- helmet
    hf = Quaternion(Y, math.radians(-head_pitch_deg)) @ X
    hu = Quaternion(Y, math.radians(-head_pitch_deg)) @ Z
    if helmet == 'full':
        parts.append(build_helmet(name + '_helmet', head, hf, hu))
    elif helmet == 'leather':
        parts += build_head_leather(name + '_head', head, hf, hu)
    else:
        parts += build_head_open(name + '_head', head, hf, hu)

    # ---- collar, zip, harness (on the torso surface)
    torso = parts[0]
    mb = MB(name + '_details')
    ring = []
    for k in range(24):
        a = math.tau * k / 24
        ring.append(neck0 + u * 0.035 + (f * math.cos(a) * 0.062 + Y * math.sin(a) * 0.070))
    B.closed_tube(mb, ring, 0.019, 'Pilot_Suit', n=10)
    zip_pts = surface_path(torso, [neck0 + u * 0.0 + f * 0.1, hip + u * 0.30 + f * 0.2, hip + u * 0.12 + f * 0.2], f, 0.002)
    if zip_pts:
        mb.tube(zip_pts, 0.004, 'Suit_Dark', n=6)
    # cargo pockets on the outer thighs, Spanish flag on the left shoulder
    for s, sy in (('L', 1), ('R', -1)):
        leg = legs[s]
        c = hp[s] + (knee[s] - hp[s]) * 0.55
        tdir = (knee[s] - hp[s]).normalized()
        out = Y * sy
        surface_patch(mb, leg, c + out * 0.2, out, tdir, Z, 0.15, 0.12, 0.006, 'Pilot_Suit')
        surface_patch(mb, leg, c + out * 0.2 + tdir * 0.0 + Z * 0.05, out, tdir, Z, 0.155, 0.03, 0.009, 'Suit_Dark')
    arm = arms['L']
    a0, a1 = sh['L'], elbows['L']
    adir = (a1 - a0).normalized()
    c = a0 + (a1 - a0) * 0.32
    perp = Y.cross(adir).normalized()
    for col, hh, d in (('Flag_Red', 0.012, 0.018), ('Flag_Yellow', 0.024, 0.0), ('Flag_Red', 0.012, -0.018)):
        surface_patch(mb, arm, c - adir * d, Y, perp, -adir, 0.07, hh, 0.0035, col, cols=4, rows=1)
    buckle = surface_path(torso, [hip + u * 0.13 + f * 0.25], f, 0.012)
    for sy in (1, -1):
        over = S + Y * sy * 0.095 + u * 0.075 - f * 0.02
        path = [S + Y * sy * 0.10 - f * 0.16 + u * 0.03, over, S + Y * sy * 0.10 + f * 0.13 - u * 0.04,
                hip + u * 0.32 + Y * sy * 0.075 + f * 0.2, hip + u * 0.20 + Y * sy * 0.035 + f * 0.2]
        pts = surface_path(torso, path, None, 0.006, ref=hip + u * 0.3)
        if pts:
            mb.tube(pts, 0.0, 'Harness', n=4, square=(0.044, 0.005, 6), cap=True)
        lap = [hip + Y * sy * 0.21 + u * 0.03, hip + Y * sy * 0.15 + u * 0.08 + f * 0.17,
               hip + Y * sy * 0.04 + u * 0.12 + f * 0.2]
        pts = surface_path(torso, lap, None, 0.006, ref=hip + u * 0.12)
        if pts:
            mb.tube(pts, 0.0, 'Harness', n=4, square=(0.046, 0.005, 6), cap=True)
    if buckle:
        c = buckle[0]
        mb.cyl(c - f * 0.004, c + f * 0.012, 0.036, 'Metal_Frame', n=24)
        mb.cyl(c + f * 0.012, c + f * 0.016, 0.022, 'Suit_Dark', n=20)
    parts.append(mb.finish(sharp_angle=50))

    ob = B.join_objects(name, parts)
    # origin at the H-point (pose pivot)
    off = hip - ob.location
    ob.data.transform(Matrix.Translation(-off))
    ob.location = hip
    return ob


def surface_patch(mb, target, center, n, right, up, w, h, thick, mat, cols=5, rows=4):
    """Thin slab (pocket/patch) shrink-wrapped onto target around center; n = outward direction."""
    inv = target.matrix_world.inverted()
    n = Vector(n).normalized()
    r = (Vector(right) - n * Vector(right).dot(n)).normalized()
    v = n.cross(r).normalized()
    if v.dot(Vector(up)) < 0:
        v = -v
    grid = []
    for j in range(rows + 1):
        row = []
        for i in range(cols + 1):
            p = center + r * ((i / cols - 0.5) * w) + v * ((j / rows - 0.5) * h)
            ok, loc, nrm, _ = target.ray_cast(inv @ (p + n * 0.3), (inv.to_3x3() @ -n).normalized(), distance=0.6)
            if not ok:
                return
            row.append(target.matrix_world @ loc)
        grid.append(row)
    coords, faces = [], []
    W = cols + 1
    for row in grid:
        coords += [p + n * thick for p in row]
    for row in grid:
        coords += [p - n * 0.002 for p in row]
    off = len(grid) * W
    for j in range(rows):
        for i in range(cols):
            a = j * W + i
            faces.append([a, a + 1, a + W + 1, a + W])
    ring = [(0, i) for i in range(cols)] + [(j, cols) for j in range(rows)] + \
           [(rows, i) for i in range(cols, 0, -1)] + [(j, 0) for j in range(rows, 0, -1)]
    for k in range(len(ring)):
        (j0, i0), (j1, i1) = ring[k], ring[(k + 1) % len(ring)]
        a, b = j0 * W + i0, j1 * W + i1
        faces.append([b, a, a + off, b + off])
    mb.faces(coords, faces, mat, smooth=False)


def surface_path(target, pts, direction, offset, ref=None, samples=6):
    """Project a polyline onto target's surface (ray from outside, along -normal guess)."""
    pts = B.catmull([Vector(p) for p in pts], samples) if len(pts) > 1 else [Vector(pts[0])]
    out = []
    inv = target.matrix_world.inverted()
    for p in pts:
        n = Vector(direction) if direction is not None else (p - ref).normalized()
        o = p + n * 0.35
        ok, loc, nrm, _ = target.ray_cast(inv @ o, (inv.to_3x3() @ -n).normalized(), distance=0.7)
        if ok:
            w = target.matrix_world @ loc
            out.append(w + n * offset)
    return out if (len(out) == len(pts) or len(pts) == 1) else out
