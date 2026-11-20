"""
Procedural autogyro (two-seat tandem open-cockpit gyroplane) for the Autogiro web flight sim.

Run headless:
  blender -b -P blender/build_autogiro.py -- [--previews] [--only VIEW[,VIEW]] [--samples N]

Coordinate contract (meters): Blender +X forward, +Y left, +Z up; origin = CG.
glTF export is +Y up -> three.js: +X forward, +Y up, +Z right.
Outputs: blender/autogiro.blend, public/models/autogiro.glb, blender/previews/*.png
"""
import bpy, bmesh, math, os, sys, json, struct
from mathutils import Vector, Matrix, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BLEND_PATH = os.path.join(HERE, "autogiro.blend")
GLB_PATH = os.path.join(ROOT, "public", "models", "autogiro.glb")
PREVIEW_DIR = os.path.join(HERE, "previews")

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
DO_PREVIEWS = "--previews" in ARGV
ONLY = None
SAMPLES = 128
for i, a in enumerate(ARGV):
    if a == "--only" and i + 1 < len(ARGV):
        ONLY = set(ARGV[i + 1].split(","))
    if a == "--samples" and i + 1 < len(ARGV):
        SAMPLES = int(ARGV[i + 1])

TAU = math.tau


def V(x, y=0.0, z=0.0):
    return Vector((x, y, z))


def P(x, h, r=0.0):
    """Contract coords (forward, up, right) -> Blender (x, y=left, z=up)."""
    return Vector((x, -r, h))


# ---------------------------------------------------------------------------
# Scene reset
# ---------------------------------------------------------------------------
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.objects,
                 bpy.data.cameras, bpy.data.lights, bpy.data.images, bpy.data.worlds):
        for d in list(coll):
            coll.remove(d)
    scn = bpy.context.scene
    scn.unit_settings.system = 'METRIC'
    scn.unit_settings.scale_length = 1.0
    return scn


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------
MATS = {}


def srgb(h):
    """'#RRGGBB' -> linear RGB tuple."""
    h = h.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def make_mat(name, color, metal=0.0, rough=0.5, alpha=1.0, emit=None, emit_strength=0.0,
             coat=0.0, spec=0.5):
    m = bpy.data.materials.new(name)
    try:
        if m.node_tree is None:
            m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n
    if bsdf is None:
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    col = tuple(color) + (1.0,)
    bsdf.inputs['Base Color'].default_value = col
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Alpha'].default_value = alpha
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    if coat > 0 and 'Coat Weight' in bsdf.inputs:
        bsdf.inputs['Coat Weight'].default_value = coat
        bsdf.inputs['Coat Roughness'].default_value = 0.04
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = tuple(emit) + (1.0,)
        bsdf.inputs['Emission Strength'].default_value = emit_strength
    m.diffuse_color = col
    m.roughness = rough
    m.metallic = metal
    try:
        m.use_backface_culling = True    # glTF doubleSided = false for closed, opaque meshes
    except Exception:
        pass
    if alpha < 1.0:
        for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
        try:
            m.use_backface_culling = False
        except Exception:
            pass
    MATS[name] = m
    return m


def build_materials():
    make_mat('Paint_White', srgb('#F4F5F6'), metal=0.0, rough=0.16, coat=0.0)
    make_mat('Paint_Accent', srgb('#FF5A1F'), metal=0.0, rough=0.22)
    make_mat('Paint_Dark', srgb('#2B2E33'), metal=0.35, rough=0.32)
    make_mat('Metal_Frame', srgb('#C9CCD0'), metal=1.0, rough=0.24)
    make_mat('Rotor_Blade', srgb('#B9BEC4'), metal=0.55, rough=0.30)
    make_mat('Carbon', srgb('#151719'), metal=0.15, rough=0.18)
    make_mat('Rubber', srgb('#141414'), metal=0.0, rough=0.88)
    make_mat('Glass', srgb('#A9C4D2'), metal=0.0, rough=0.05, alpha=0.25)
    make_mat('Seat', srgb('#26282C'), metal=0.0, rough=0.78)
    make_mat('Panel', srgb('#0E0F10'), metal=0.0, rough=0.72)
    make_mat('Gauge_Face', srgb('#E9E6DA'), metal=0.0, rough=0.35,
             emit=srgb('#E9E6DA'), emit_strength=0.15)
    make_mat('Pilot_Suit', srgb('#2F3A4A'), metal=0.0, rough=0.85)
    make_mat('Helmet', srgb('#F2F2F0'), metal=0.0, rough=0.14)
    make_mat('Visor', srgb('#0B0D10'), metal=0.6, rough=0.06)
    make_mat('Engine', srgb('#9EA3A8'), metal=0.75, rough=0.38)
    make_mat('Engine_Dark', srgb('#3A3D41'), metal=0.4, rough=0.5)
    make_mat('Interior', srgb('#3C4046'), metal=0.0, rough=0.7)
    make_mat('Glove', srgb('#1A1A1C'), metal=0.0, rough=0.7)


# ---------------------------------------------------------------------------
# Mesh builder: accumulates geometry (world coordinates) into one bmesh
# ---------------------------------------------------------------------------
class MB:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, mat):
        if mat not in self.mats:
            self.mats.append(mat)
        return self.mats.index(mat)

    def faces(self, coords, faces, mat, smooth=True):
        bm = self.bm
        vs = [bm.verts.new(Vector(c)) for c in coords]
        idx = self.mi(mat)
        out = []
        for f in faces:
            try:
                face = bm.faces.new([vs[i] for i in f])
            except ValueError:
                continue
            face.material_index = idx
            face.smooth = smooth
            out.append(face)
        return out

    # --- grids / lofts ----------------------------------------------------
    def loft(self, rings, mat, closed=True, cap0=False, cap1=False, smooth=True, flip=False):
        """rings: list of lists of points (same count). Degenerate ring (1 point) allowed at ends."""
        coords, faces, starts = [], [], []
        for r in rings:
            starts.append(len(coords))
            coords.extend(r)
        n = max(len(r) for r in rings)
        for k in range(len(rings) - 1):
            a, b = rings[k], rings[k + 1]
            sa, sb = starts[k], starts[k + 1]
            m = n if closed else n - 1
            for i in range(m):
                i2 = (i + 1) % n
                if len(a) == 1:
                    f = [sa, sb + i2, sb + i]
                elif len(b) == 1:
                    f = [sa + i, sa + i2, sb]
                else:
                    f = [sa + i, sa + i2, sb + i2, sb + i]
                if flip:
                    f = f[::-1]
                faces.append(f)
        if cap0 and len(rings[0]) > 2:
            f = list(range(starts[0], starts[0] + len(rings[0])))
            faces.append(f if flip else f[::-1])
        if cap1 and len(rings[-1]) > 2:
            f = list(range(starts[-1], starts[-1] + len(rings[-1])))
            faces.append(f[::-1] if flip else f)
        return self.faces(coords, faces, mat, smooth)

    def tube(self, pts, radius, mat, n=12, cap=True, smooth=True, square=None):
        """Sweep circle (or rounded rect if square=(w,h,exp)) along polyline pts."""
        pts = [Vector(p) for p in pts]
        rad = radius if isinstance(radius, (list, tuple)) else [radius] * len(pts)
        tangents = []
        for i in range(len(pts)):
            if i == 0:
                t = pts[1] - pts[0]
            elif i == len(pts) - 1:
                t = pts[-1] - pts[-2]
            else:
                t = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
            tangents.append(t.normalized())
        # initial normal
        t0 = tangents[0]
        ref = V(0, 0, 1) if abs(t0.z) < 0.9 else V(1, 0, 0)
        nrm = (ref - t0 * ref.dot(t0)).normalized()
        rings = []
        for i, p in enumerate(pts):
            t = tangents[i]
            nrm = (nrm - t * nrm.dot(t)).normalized()
            bi = t.cross(nrm)
            ring = []
            for k in range(n):
                a = TAU * k / n
                if square:
                    w, h, e = square
                    ca, sa = math.cos(a), math.sin(a)
                    cx = math.copysign(abs(ca) ** (2.0 / e), ca) * w * 0.5
                    sy = math.copysign(abs(sa) ** (2.0 / e), sa) * h * 0.5
                    ring.append(p + nrm * sy + bi * cx)
                else:
                    ring.append(p + (nrm * math.sin(a) + bi * math.cos(a)) * rad[i])
            rings.append(ring)
        return self.loft(rings, mat, closed=True, cap0=cap, cap1=cap, smooth=smooth)

    def cyl(self, p0, p1, r, mat, n=16, cap=True, smooth=True):
        return self.tube([p0, p1], r, mat, n=n, cap=cap, smooth=smooth)

    def box(self, center, size, mat, bevel=0.0, segs=2, rot=None, smooth=True):
        bm = self.bm
        mtx = Matrix.Translation(Vector(center))
        if rot is not None:
            mtx = mtx @ (rot.to_matrix().to_4x4() if hasattr(rot, 'to_matrix') else rot)
        mtx = mtx @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
        before = set(bm.faces)
        if bevel > 0:
            # bevel in a temporary bmesh in unit space, then transform (keeps bevel uniform)
            tmp = bmesh.new()
            bmesh.ops.create_cube(tmp, size=1.0)
            for v in tmp.verts:
                v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
            bmesh.ops.bevel(tmp, geom=list(tmp.verts) + list(tmp.edges), offset=bevel, segments=segs,
                            affect='EDGES', profile=0.5, clamp_overlap=True)
            m2 = Matrix.Translation(Vector(center))
            if rot is not None:
                m2 = m2 @ (rot.to_matrix().to_4x4() if hasattr(rot, 'to_matrix') else rot)
            vmap = {}
            for v in tmp.verts:
                vmap[v] = bm.verts.new(m2 @ v.co)
            for f in tmp.faces:
                try:
                    bm.faces.new([vmap[v] for v in f.verts])
                except ValueError:
                    pass
            tmp.free()
        else:
            bmesh.ops.create_cube(bm, size=1.0, matrix=mtx)
        idx = self.mi(mat)
        allf = set(bm.faces) - before
        for f in allf:
            f.material_index = idx
            f.smooth = smooth
        return list(allf)

    def sphere(self, center, r, mat, seg=24, rings=12, scale=(1, 1, 1), rot=None, smooth=True):
        bm = self.bm
        mtx = Matrix.Translation(Vector(center))
        if rot is not None:
            mtx = mtx @ rot.to_matrix().to_4x4()
        mtx = mtx @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        before = set(bm.faces)
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r, matrix=mtx)
        idx = self.mi(mat)
        fs = list(set(bm.faces) - before)
        for f in fs:
            f.material_index = idx
            f.smooth = smooth
        return fs

    def lathe(self, profile, axis_p, axis_d, mat, n=32, smooth=True, closed_profile=False):
        """Revolve profile [(radius, axial)] around axis (point, direction)."""
        d = Vector(axis_d).normalized()
        ref = V(0, 0, 1) if abs(d.z) < 0.9 else V(1, 0, 0)
        u = (ref - d * ref.dot(d)).normalized()
        w = d.cross(u)
        rings = []
        for (rr, aa) in profile:
            ring = []
            for k in range(n):
                a = TAU * k / n
                ring.append(Vector(axis_p) + d * aa + (u * math.cos(a) + w * math.sin(a)) * rr)
            rings.append(ring)
        # build as loft along profile (each profile point is a ring)
        coords, faces = [], []
        for r in rings:
            coords.extend(r)
        m = len(profile) if closed_profile else len(profile) - 1
        for j in range(m):
            j2 = (j + 1) % len(profile)
            for k in range(n):
                k2 = (k + 1) % n
                faces.append([j * n + k, j * n + k2, j2 * n + k2, j2 * n + k])
        fs = self.faces(coords, faces, mat, smooth)
        return fs

    # --- finish ------------------------------------------------------------
    def finish(self, origin=(0, 0, 0), sharp_angle=40.0, merge=1e-6, coll=None, recalc=True, wn=False):
        bm = self.bm
        if merge > 0:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
        if recalc:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.normal_update()
        mark_sharp(bm, sharp_angle)
        o = Vector(origin)
        for v in bm.verts:
            v.co -= o
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        for mname in self.mats:
            me.materials.append(MATS[mname])
        ob = bpy.data.objects.new(self.name, me)
        ob.location = o
        (coll or bpy.context.scene.collection).objects.link(ob)
        if wn:
            mod = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
            mod.keep_sharp = True
            mod.mode = 'FACE_AREA'
            mod.weight = 50
            apply_mods(ob)
        return ob


def mark_sharp(bm, angle_deg):
    lim = math.radians(angle_deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            f1, f2 = e.link_faces
            if f1.normal.length > 0 and f2.normal.length > 0 and f1.normal.angle(f2.normal, 0) > lim:
                e.smooth = False
            else:
                e.smooth = True
        else:
            e.smooth = False


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------
def hermite(xs, ys):
    """Monotone-ish cubic Hermite interpolant, linear extrapolation."""
    pr = sorted(zip(xs, ys))
    X = [p[0] for p in pr]
    Y = [p[1] for p in pr]
    n = len(X)
    M = []
    for i in range(n):
        if i == 0:
            m = (Y[1] - Y[0]) / (X[1] - X[0])
        elif i == n - 1:
            m = (Y[-1] - Y[-2]) / (X[-1] - X[-2])
        else:
            d0 = (Y[i] - Y[i - 1]) / (X[i] - X[i - 1])
            d1 = (Y[i + 1] - Y[i]) / (X[i + 1] - X[i])
            m = 0.0 if d0 * d1 <= 0 else 2.0 / (1.0 / d0 + 1.0 / d1)
        M.append(m)

    def f(x):
        if x <= X[0]:
            return Y[0] + M[0] * (x - X[0])
        if x >= X[-1]:
            return Y[-1] + M[-1] * (x - X[-1])
        for i in range(n - 1):
            if X[i] <= x <= X[i + 1]:
                h = X[i + 1] - X[i]
                t = (x - X[i]) / h
                t2, t3 = t * t, t * t * t
                return ((2 * t3 - 3 * t2 + 1) * Y[i] + (t3 - 2 * t2 + t) * h * M[i]
                        + (-2 * t3 + 3 * t2) * Y[i + 1] + (t3 - t2) * h * M[i + 1])
        return Y[-1]
    return f


def lerp(a, b, t):
    return a + (b - a) * t


def sgnpow(v, e):
    return math.copysign(abs(v) ** e, v)


def link(ob, coll=None):
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def apply_mods(ob):
    """Apply all modifiers of ob (no operator context needed)."""
    if not ob.modifiers:
        return ob
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    me.name = ob.name
    return ob


def remove_faces_with_material(ob, matname):
    me = ob.data
    idx = [i for i, m in enumerate(me.materials) if m and m.name.startswith(matname)]
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = [f for f in bm.faces if f.material_index in idx]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me)
    bm.free()
    for i in sorted(idx, reverse=True):
        me.materials.pop(index=i)


def boolean_cut_shell(ob, cutter, solver='EXACT'):
    """Cut holes in a closed shell: boolean difference, then delete faces that came from the cutter."""
    cm = bpy.data.materials.get('_CUTTER') or bpy.data.materials.new('_CUTTER')
    cutter.data.materials.clear()
    cutter.data.materials.append(cm)
    mod = ob.modifiers.new('cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.solver = solver
    mod.object = cutter
    try:
        mod.material_mode = 'TRANSFER'
    except Exception:
        pass
    apply_mods(ob)
    remove_faces_with_material(ob, '_CUTTER')
    bpy.data.objects.remove(cutter)


def boundary_loops(me):
    """Return list of boundary loops (lists of world-space-ish local coords + vertex normals)."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    bedges = [e for e in bm.edges if e.is_boundary]
    adj = {}
    for e in bedges:
        a, b = e.verts
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen = set()
    loops = []
    for start in list(adj.keys()):
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nxt = [v for v in adj[cur] if v is not prev and v not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        loops.append([(v.co.copy(), v.normal.copy()) for v in loop])
    bm.free()
    return loops


def resample_loop(pts, step):
    """Resample closed polyline to ~uniform spacing, then light smoothing."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    seg = [(pts[(i + 1) % n] - pts[i]).length for i in range(n)]
    L = sum(seg)
    m = max(8, int(L / step))
    out = []
    acc = 0.0
    i = 0
    for k in range(m):
        d = L * k / m
        while acc + seg[i] < d and i < n - 1:
            acc += seg[i]
            i += 1
        t = (d - acc) / seg[i] if seg[i] > 0 else 0
        out.append(pts[i].lerp(pts[(i + 1) % n], t))
    for _ in range(2):
        out = [(out[k - 1] + out[k] * 2 + out[(k + 1) % m]) / 4 for k in range(m)]
    return out


def closed_tube(mb, pts, r, mat, n=10):
    """Tube along a closed loop."""
    m = len(pts)
    rings = []
    nrm_prev = None
    for k in range(m):
        t = (pts[(k + 1) % m] - pts[k - 1]).normalized()
        ref = V(0, 0, 1) if abs(t.z) < 0.9 else V(1, 0, 0)
        nrm = (ref - t * ref.dot(t)).normalized() if nrm_prev is None else (nrm_prev - t * nrm_prev.dot(t)).normalized()
        nrm_prev = nrm
        bi = t.cross(nrm)
        rings.append([pts[k] + (nrm * math.sin(TAU * j / n) + bi * math.cos(TAU * j / n)) * r for j in range(n)])
    rings.append(rings[0])
    return mb.loft(rings, mat, closed=True)


# ---------------------------------------------------------------------------
# Pod (fuselage shell)
# ---------------------------------------------------------------------------
POD_X = [1.70, 1.45, 1.20, 0.95, 0.60, 0.30, 0.00, -0.25, -0.45, -0.60, -0.72]
F_HW = hermite(POD_X, [0.300, 0.352, 0.384, 0.400, 0.410, 0.410, 0.402, 0.385, 0.350, 0.290, 0.190])
F_ZT = hermite(POD_X, [-0.075, 0.03, 0.095, 0.135, 0.150, 0.155, 0.165, 0.200, 0.250, 0.215, 0.110])
F_ZB = hermite(POD_X, [-0.605, -0.675, -0.705, -0.718, -0.72, -0.72, -0.72, -0.71, -0.69, -0.65, -0.57])
F_ZW = hermite(POD_X, [-0.29, -0.25, -0.22, -0.20, -0.19, -0.19, -0.19, -0.20, -0.21, -0.23, -0.26])
POD_NT, POD_NB = 2.4, 2.7
POD_XN, POD_XT, POD_ZTIP = 1.70, 2.10, -0.35


def pod_params(x):
    hw, zt, zb, zw = F_HW(x), F_ZT(x), F_ZB(x), F_ZW(x)
    if x > POD_XN:
        t = min(1.0, (x - POD_XN) / (POD_XT - POD_XN))
        f = max(0.0, 1.0 - t ** 1.7) ** 0.6
        zc0 = (F_ZT(POD_XN) + F_ZB(POD_XN)) * 0.5
        zc = lerp(zc0, POD_ZTIP, t)
        hw *= f
        zt = zc + (zt - zc) * f
        zb = zc - (zc - zb) * f
        zw = zc + (zw - zc) * f
    return hw, zt, zb, zw


def pod_ring(x, n=64, scale=1.0):
    hw, zt, zb, zw = pod_params(x)
    ring = []
    for k in range(n):
        a = TAU * k / n
        c, s = math.cos(a), math.sin(a)
        y = sgnpow(c, 2.0 / (POD_NT if s >= 0 else POD_NB)) * hw * scale
        if s >= 0:
            z = zw + sgnpow(s, 2.0 / POD_NT) * (zt - zw) * scale
        else:
            z = zw + sgnpow(s, 2.0 / POD_NB) * (zw - zb) * scale
        ring.append(V(x, y, z))
    return ring


def pod_top_z(x, y):
    """Height of the pod's upper surface at (x, y) (Blender coords)."""
    hw, zt, zb, zw = pod_params(x)
    u = min(1.0, abs(y) / max(hw, 1e-4))
    return zw + (zt - zw) * max(0.0, 1.0 - u ** POD_NT) ** (1.0 / POD_NT)


def pod_side_y(x, z):
    hw, zt, zb, zw = pod_params(x)
    if z >= zw:
        v = min(1.0, (z - zw) / max(zt - zw, 1e-4))
        return hw * max(0.0, 1.0 - v ** POD_NT) ** (1.0 / POD_NT)
    v = min(1.0, (zw - z) / max(zw - zb, 1e-4))
    return hw * max(0.0, 1.0 - v ** POD_NB) ** (1.0 / POD_NB)


def plan_cutter(name, cx, a, b, e, z0, z1, n=48):
    """Vertical prism with superellipse plan (center cx, half-length a, half-width b)."""
    mb = MB(name)
    rings = []
    for z in (z0, z1):
        r = []
        for k in range(n):
            t = TAU * k / n
            c, s = math.cos(t), math.sin(t)
            r.append(V(cx + sgnpow(c, 2.0 / e) * a, sgnpow(s, 2.0 / e) * b, z))
        rings.append(r)
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    return mb.finish(sharp_angle=80)


# Livery lines in side view (z = z0 + slope*(x - x0)); planes are independent of y.
def line_through(p0, p1):
    (x0, z0), (x1, z1) = p0, p1
    s = (z1 - z0) / (x1 - x0)
    return lambda x: z0 + s * (x - x0), (V(x0, 0, z0), V(-s, 0, 1).normalized())


BELLY = line_through((2.05, -0.43), (-0.75, -0.40))
STRIPE_LO = line_through((2.00, -0.41), (-0.75, -0.08))
STRIPE_HI = line_through((1.70, -0.33), (-0.75, 0.10))
PIN_HI = line_through((2.00, -0.428), (-0.75, -0.098))
PIN_LO = line_through((2.00, -0.440), (-0.75, -0.110))


def build_pod():
    xs = []
    K = 12
    for k in range(K + 1):  # nose region, clustered toward tip
        t = math.sin(0.5 * math.pi * k / K)
        xs.append(POD_XT - (POD_XT - POD_XN) * (1 - t))
    xs = sorted(set(round(x, 5) for x in xs), reverse=True)
    x = POD_XN
    while x > -0.72 + 1e-6:
        x -= 0.055
        xs.append(max(x, -0.72))
    xs = sorted(set(round(v, 5) for v in xs), reverse=True)
    rings = [[V(POD_XT, 0, POD_ZTIP)]]
    for x in xs[1:]:
        rings.append(pod_ring(x))
    # rounded rear edge
    rings.append(pod_ring(-0.735, scale=0.93))
    rings.append(pod_ring(-0.742, scale=0.80))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60)

    # cockpit openings
    boolean_cut_shell(pod, plan_cutter('cut_front', 0.72, 0.36, 0.335, 3.6, -0.10, 1.0))
    boolean_cut_shell(pod, plan_cutter('cut_rear', -0.085, 0.365, 0.335, 3.6, -0.10, 1.2))

    # livery split + material assignment
    me = pod.data
    for nm in ('Paint_Dark', 'Paint_Accent', 'Interior'):
        me.materials.append(MATS[nm])
    names = [m.name for m in me.materials]
    bm = bmesh.new()
    bm.from_mesh(me)
    for (_, (co, no)) in (BELLY, STRIPE_LO, STRIPE_HI, PIN_HI, PIN_LO):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no)
    for f in bm.faces:
        c = f.calc_center_median()
        if c.z < BELLY[0](c.x):
            f.material_index = names.index('Paint_Dark')
        elif PIN_LO[0](c.x) < c.z < PIN_HI[0](c.x) and c.x < 1.62:
            f.material_index = names.index('Paint_Dark')
        elif STRIPE_LO[0](c.x) < c.z < STRIPE_HI[0](c.x) and c.x < 1.75:
            f.material_index = names.index('Paint_Accent')
        else:
            f.material_index = names.index('Paint_White')
        f.smooth = True
    bm.to_mesh(me)
    bm.free()

    # rim along cockpit openings (padded coaming)
    loops = boundary_loops(me)
    rim = MB('cockpit_rim')
    for lp in loops:
        pts = [co - no * 0.006 for co, no in lp]
        pts = resample_loop(pts, 0.02)
        closed_tube(rim, pts, 0.016, 'Seat', n=10)
    rim_ob = rim.finish(sharp_angle=80)

    # shell thickness, inner surface = Interior
    sol = pod.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.012
    sol.offset = -1.0
    sol.use_even_offset = True
    sol.material_offset = 3
    sol.material_offset_rim = 3
    apply_mods(pod)
    for p in pod.data.polygons:
        if p.material_index > 3:
            p.material_index = 3
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    bm.normal_update()
    mark_sharp(bm, 50)
    bm.to_mesh(pod.data)
    bm.free()
    return pod, rim_ob


# ---------------------------------------------------------------------------
# Airfoils
# ---------------------------------------------------------------------------
def naca4(s, t, m=0.0, p=0.4):
    """Return (camber_line_y, half_thickness) at chord fraction s for NACA mpxx (t = thickness ratio)."""
    yt = 5 * t * (0.2969 * math.sqrt(max(s, 0)) - 0.1260 * s - 0.3516 * s ** 2 + 0.2843 * s ** 3 - 0.1036 * s ** 4)
    if m > 0:
        yc = m / p ** 2 * (2 * p * s - s * s) if s < p else m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * s - s * s)
    else:
        yc = 0.0
    return yc, max(yt, 0.0)


def airfoil_ring(npts, t, m=0.0, p=0.4, te_min=0.004, s_end=1.0):
    """Closed airfoil loop as list of (chord_s, thickness_offset) in chord units.
    Upper surface LE->TE then lower TE->LE. te_min is the min half-thickness (blunt TE)."""
    ss = [s_end * (0.5 - 0.5 * math.cos(math.pi * i / npts)) for i in range(npts + 1)]
    upper, lower = [], []
    for s in ss:
        yc, yt = naca4(s, t, m, p)
        yt = max(yt, te_min * min(1.0, s / 0.05)) if s > 0 else 0.0
        upper.append((s, yc + yt))
        lower.append((s, yc - yt))
    # loop: LE (shared) -> upper ... TE upper -> TE lower ... -> lower back (excluding LE)
    return upper + lower[::-1][:-1]


# ---------------------------------------------------------------------------
# Mast, frame, keel
# ---------------------------------------------------------------------------
MAST_BOT = V(-0.42, 0, -0.45)
MAST_TOP = V(-0.30, 0, 1.42)
HEAD_PIVOT = V(-0.27, 0, 1.47)
HUB = V(-0.25, 0, 1.70)
PROP_C = V(-1.50, 0, 0.25)


def catmull(pts, samples=8):
    pts = [Vector(p) for p in pts]
    out = []
    n = len(pts)
    for i in range(n - 1):
        p0 = pts[max(i - 1, 0)]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[min(i + 2, n - 1)]
        for k in range(samples):
            t = k / samples
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out


KEEL_PTS = [(1.10, -0.655), (0.40, -0.665), (-0.20, -0.672), (-0.70, -0.715), (-1.10, -0.750),
            (-1.50, -0.758), (-1.90, -0.742), (-2.50, -0.680), (-3.10, -0.585), (-3.60, -0.515),
            (-3.95, -0.485)]


def build_frame():
    mb = MB('frame')
    # mast: square stainless tube 0.10 (fore-aft) x 0.08 (lateral), extends into keel at the bottom
    d = (MAST_TOP - MAST_BOT).normalized()
    mast_low = MAST_BOT - d * 0.20
    mb.tube([mast_low, MAST_BOT, MAST_TOP], 0.05, 'Metal_Frame', n=28, square=(0.08, 0.10, 10))
    # mast top cheek plates holding the head pitch bolt
    for sy in (1, -1):
        mb.box((HEAD_PIVOT.x - 0.015, sy * 0.058, 1.445), (0.13, 0.012, 0.13), 'Metal_Frame', bevel=0.012, segs=2,
               rot=Euler((0, math.radians(-3.5), 0)))
        mb.cyl(V(HEAD_PIVOT.x, sy * 0.050, HEAD_PIVOT.z), V(HEAD_PIVOT.x, sy * 0.078, HEAD_PIVOT.z), 0.016,
               'Engine', n=12)
    mb.cyl(V(HEAD_PIVOT.x, -0.078, HEAD_PIVOT.z), V(HEAD_PIVOT.x, 0.078, HEAD_PIVOT.z), 0.009, 'Metal_Frame', n=10)
    # keel / tail boom (rounded square tube under the prop arc)
    kp = catmull([V(x, 0, z) for x, z in KEEL_PTS], samples=6)
    mb.tube(kp, 0.045, 'Metal_Frame', n=24, square=(0.075, 0.09, 6))
    # mast foot gussets (visible where the keel leaves the pod)
    for sy in (1, -1):
        mb.box((-0.50, sy * 0.044, -0.62), (0.34, 0.008, 0.16), 'Metal_Frame', bevel=0.01, segs=2)
    # engine mount: plate behind mast + struts
    mb.box((-0.462, 0, 0.13), (0.012, 0.24, 0.30), 'Metal_Frame', bevel=0.01, segs=2)
    for sy in (1, -1):
        for z0, z1 in ((0.24, 0.16), (0.02, -0.06)):
            mb.cyl(V(-0.47, sy * 0.10, z0), V(-0.80, sy * 0.10, z1), 0.012, 'Metal_Frame', n=10)
        # lower struts keel -> engine
        mb.cyl(V(-0.95, sy * 0.02, -0.71), V(-0.86, sy * 0.10, -0.20), 0.012, 'Metal_Frame', n=10)
        mb.cyl(V(-0.62, sy * 0.02, -0.68), V(-0.80, sy * 0.10, -0.20), 0.011, 'Metal_Frame', n=10)
    return mb.finish(sharp_angle=40, wn=True)


# ---------------------------------------------------------------------------
# Rotor head (tilting gimbal + bearing) and rotor
# ---------------------------------------------------------------------------
def build_rotor_head():
    mb = MB('rotor_head')
    c = HEAD_PIVOT
    # gimbal block between cheek plates
    mb.box((c.x, 0, c.z), (0.085, 0.088, 0.075), 'Engine', bevel=0.01, segs=2)
    # roll hinge
    mb.cyl(V(c.x - 0.06, 0, c.z + 0.035), V(c.x + 0.06, 0, c.z + 0.035), 0.018, 'Engine_Dark', n=14)
    # bearing housing + spindle up to the rotor tower base
    ax = V(HUB.x, 0, 0)
    mb.lathe([(0.0, c.z + 0.035), (0.050, c.z + 0.035), (0.055, c.z + 0.05), (0.055, 1.565), (0.048, 1.585),
              (0.040, 1.60), (0.0, 1.60)], V(HUB.x, 0, 0), V(0, 0, 1), 'Engine', n=28)
    # pre-rotator ring gear
    mb.lathe([(0.060, 1.552), (0.092, 1.552), (0.095, 1.560), (0.095, 1.574), (0.092, 1.580), (0.060, 1.580)],
             V(HUB.x, 0, 0), V(0, 0, 1), 'Engine_Dark', n=40, closed_profile=True)
    # control lever arms (pitch fore, roll sides)
    mb.box((c.x + 0.075, 0, c.z - 0.02), (0.08, 0.02, 0.022), 'Engine', bevel=0.006, segs=1)
    for sy in (1, -1):
        mb.box((c.x, sy * 0.075, c.z - 0.03), (0.022, 0.07, 0.02), 'Engine', bevel=0.006, segs=1)
    # pre-rotator pinion housing
    mb.cyl(V(HUB.x - 0.10, 0, 1.60), V(HUB.x - 0.10, 0, 1.50), 0.025, 'Engine_Dark', n=14)
    return mb.finish(origin=HEAD_PIVOT, sharp_angle=40, wn=True)


def blade_geometry(mb, root=0.35, tip=4.20, chord=0.20, tc=0.12, pitch_deg=2.5, precone_deg=1.0):
    """One blade along +X from the hub, leading edge toward +Y; returns nothing (adds to mb)."""
    npts = 14
    loop = airfoil_ring(npts, tc, te_min=0.0035)
    pitch = Matrix.Rotation(math.radians(pitch_deg), 3, 'X')
    cone = Matrix.Rotation(math.radians(-precone_deg), 3, 'Y')

    def section(r, c, thick_scale=1.0):
        ring = []
        for s, tz in loop:
            y = (0.25 - s) * c          # quarter chord on the pitch axis, LE toward +Y
            z = tz * c * thick_scale
            p = pitch @ Vector((0.0, y, z))
            p = Vector((r, p.y, p.z))
            ring.append(HUB + cone @ p)
        return ring

    main_r = [root, root + 0.05, 0.6, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 3.85, 4.0]
    rings = [section(r, chord) for r in main_r]
    mb.loft(rings, 'Rotor_Blade', closed=True, cap0=True)
    # tip cap: rounded planform (LE corner rounded), tip at r = tip
    tip_rings = []
    L = tip - 4.0
    for k in range(0, 9):
        u = k / 8.0
        r = 4.0 + L * math.sin(0.5 * math.pi * u)
        f = math.cos(0.5 * math.pi * u) ** 0.6 if k < 8 else 0.0
        cc = chord * max(f, 0.0)
        if k == 8:
            tip_rings.append([section(r, 0.02, 0.6)[0]])
            continue
        tip_rings.append(section(r, max(cc, 0.02), 1.0 - 0.35 * u))
    # shift the cap so the trailing edge stays straight-ish (keep TE line, round LE)
    mb.loft(tip_rings, 'Paint_Accent', closed=True)


def build_rotor():
    mb = MB('rotor')
    blade_geometry(mb)
    # mirror for the second blade (rotate 180 deg about the hub vertical axis)
    bm = mb.bm
    geom_before = list(bm.verts)
    ret = bmesh.ops.duplicate(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces))
    newv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.rotate(bm, verts=newv, cent=HUB, matrix=Matrix.Rotation(math.pi, 3, 'Z'))
    # hub bar (with 1 deg precone bend) + blade straps; each half runs from the blade root plates
    # into the centre so the blades are visibly bolted to one continuous bar between the teeter towers
    cone = math.radians(1.0)
    for sx in (1, -1):
        rot = Euler((0, -sx * cone, 0))
        mb.box((HUB.x + sx * 0.36, -0.05 * sx, HUB.z + 0.36 * math.sin(cone)), (0.36, 0.215, 0.046),
               'Engine', bevel=0.006, segs=2, rot=rot)
        mb.box((HUB.x + sx * 0.10, 0, HUB.z + 0.10 * math.sin(cone)), (0.24, 0.118, 0.05),
               'Engine', bevel=0.006, segs=2, rot=rot)
        for bx in (0.25, 0.40, 0.50):
            for sy in (1, -1):
                mb.cyl(V(HUB.x + sx * bx, sy * 0.06 - 0.05 * sx, HUB.z + 0.03 + bx * math.sin(cone)),
                       V(HUB.x + sx * bx, sy * 0.06 - 0.05 * sx, HUB.z - 0.03 + bx * math.sin(cone)), 0.008, 'Metal_Frame', n=8)
    mb.box((HUB.x, 0, HUB.z), (0.20, 0.10, 0.06), 'Engine', bevel=0.01, segs=2)
    # teeter towers + bolt
    for sy in (1, -1):
        mb.box((HUB.x, sy * 0.068, 1.655), (0.09, 0.014, 0.12), 'Engine', bevel=0.008, segs=2)
        mb.cyl(V(HUB.x, sy * 0.06, HUB.z), V(HUB.x, sy * 0.095, HUB.z), 0.016, 'Metal_Frame', n=12)
    mb.cyl(V(HUB.x, -0.10, HUB.z), V(HUB.x, 0.10, HUB.z), 0.009, 'Metal_Frame', n=10)
    mb.lathe([(0.0, 1.600), (0.075, 1.600), (0.075, 1.612), (0.06, 1.62), (0.0, 1.62)], V(HUB.x, 0, 0),
             V(0, 0, 1), 'Engine', n=28)
    return mb.finish(origin=HUB, sharp_angle=35, merge=1e-5)


# ---------------------------------------------------------------------------
# Engine (Rotax-912-style flat four, pusher) and propeller
# ---------------------------------------------------------------------------
def finned_profile(r_in, r_fin, a0, a1, pitch=0.011):
    prof = [(0.0, a0), (r_in, a0)]
    a = a0 + 0.006
    while a + pitch < a1:
        prof += [(r_in, a), (r_fin, a + 0.001), (r_fin, a + pitch * 0.45), (r_in, a + pitch * 0.45 + 0.001)]
        a += pitch
    prof += [(r_in, a1), (0.0, a1)]
    return prof


def build_engine():
    mb = MB('engine')
    zc = -0.03
    # crankcase
    mb.box((-1.07, 0, zc), (0.52, 0.22, 0.26), 'Engine', bevel=0.045, segs=3)
    mb.box((-1.07, 0, zc - 0.13), (0.44, 0.18, 0.06), 'Engine_Dark', bevel=0.02, segs=2)  # oil pan
    # cylinders + heads
    for sy, xs in ((1, (-0.93, -1.17)), (-1, (-0.97, -1.21))):
        for x in xs:
            mb.lathe(finned_profile(0.050, 0.064, 0.105, 0.232), V(x, 0, zc), V(0, sy, 0), 'Engine', n=20)
            mb.box((x, sy * 0.262, zc), (0.125, 0.062, 0.135), 'Engine', bevel=0.016, segs=2)
            mb.box((x, sy * 0.302, zc + 0.005), (0.105, 0.026, 0.10), 'Engine_Dark', bevel=0.01, segs=2)
            # spark plug leads
            mb.cyl(V(x + 0.03, sy * 0.30, zc + 0.05), V(x + 0.03, sy * 0.33, zc + 0.09), 0.008, 'Paint_Accent', n=8)
            # exhaust pipe: head bottom -> muffler
            mb.tube(catmull([V(x, sy * 0.27, zc - 0.07), V(x, sy * 0.27, zc - 0.17), V(x - 0.02, sy * 0.21, zc - 0.26),
                             V(-1.10, sy * 0.15, -0.30)], 4), 0.019, 'Metal_Frame', n=10, cap=True)
        # coolant hoses from heads forward to the radiator
        mb.tube(catmull([V(-1.19, sy * 0.262, zc + 0.08), V(-0.95, sy * 0.25, zc + 0.10),
                         V(-0.84, sy * 0.16, -0.05), V(-0.81, sy * 0.13, -0.17)], 5), 0.014, 'Rubber', n=8)
        # carbs + air filters
        mb.cyl(V(-1.07, sy * 0.10, 0.27), V(-1.07, sy * 0.19, 0.24), 0.032, 'Engine', n=14)
        mb.cyl(V(-1.07, sy * 0.19, 0.24), V(-1.07, sy * 0.27, 0.22), 0.052, 'Paint_Accent', n=18)
        mb.cyl(V(-1.07, sy * 0.27, 0.22), V(-1.07, sy * 0.285, 0.216), 0.042, 'Engine_Dark', n=18)
        # intake manifolds carb -> heads
        mb.tube(catmull([V(-1.07, sy * 0.15, 0.25), V(-1.05, sy * 0.20, 0.15), V(-1.05, sy * 0.25, zc + 0.08)], 4),
                0.016, 'Engine', n=8)
    # airbox / top cover
    mb.box((-1.08, 0, 0.31), (0.34, 0.20, 0.11), 'Engine_Dark', bevel=0.035, segs=3)
    # gearbox at the prop end, raises the output shaft to the prop axis
    mb.box((-1.335, 0, 0.10), (0.09, 0.19, 0.34), 'Engine', bevel=0.04, segs=3)
    mb.lathe([(0.0, -1.29), (0.085, -1.29), (0.090, -1.32), (0.080, -1.37), (0.055, -1.40), (0.0, -1.40)],
             V(0, 0, PROP_C.z), V(1, 0, 0), 'Engine', n=28)
    # muffler
    mb.lathe([(0.0, -0.20), (0.05, -0.20), (0.068, -0.17), (0.068, 0.17), (0.05, 0.20), (0.0, 0.20)],
             V(-1.11, 0, -0.30), V(0, 1, 0), 'Metal_Frame', n=24)
    mb.tube(catmull([V(-1.12, -0.06, -0.33), V(-1.25, -0.08, -0.35), V(-1.34, -0.08, -0.33)], 4), 0.022,
            'Metal_Frame', n=12, cap=True)
    # radiator (front-low, behind the pod) with fins
    mb.box((-0.80, 0, -0.25), (0.05, 0.34, 0.17), 'Engine_Dark', bevel=0.008, segs=1)
    for k in range(9):
        y = -0.15 + k * 0.0375
        mb.box((-0.776, y, -0.25), (0.006, 0.004, 0.15), 'Engine', bevel=0.0, segs=1)
    # starter + alternator, expansion tank
    mb.cyl(V(-0.84, -0.10, -0.12), V(-0.99, -0.10, -0.12), 0.042, 'Engine_Dark', n=16)
    mb.cyl(V(-0.84, 0.17, 0.05), V(-0.84, 0.17, 0.20), 0.045, 'Metal_Frame', n=18)
    mb.cyl(V(-0.84, 0.17, 0.20), V(-0.84, 0.17, 0.225), 0.022, 'Engine_Dark', n=12)
    return mb.finish(sharp_angle=38, wn=True)


def build_prop():
    mb = MB('prop')
    c = PROP_C
    # spinner (points aft)
    prof = []
    for k in range(13):
        s = k / 12.0
        r = 0.112 * max(0.0, 1 - s ** 1.9) ** 0.55
        prof.append((r if k < 12 else 0.0, 0.07 - 0.25 * s))
    prof = [(0.0, 0.075), (0.112, 0.075)] + prof
    mb.lathe(prof, c, V(-1, 0, 0) * -1, 'Paint_Accent', n=40)
    mb.lathe([(0.0, 0.085), (0.118, 0.085), (0.118, 0.075), (0.0, 0.075)], c, V(1, 0, 0), 'Engine', n=40)
    # blades
    R = 0.86
    loop = None
    stations = [0.075, 0.10, 0.14, 0.20, 0.28, 0.36, 0.45, 0.55, 0.65, 0.74, 0.80, 0.835, 0.852, 0.86]

    def chord(r):
        if r < 0.14:
            return lerp(0.050, 0.085, (r - 0.075) / 0.065)
        if r < 0.30:
            return lerp(0.085, 0.105, (r - 0.14) / 0.16)
        return lerp(0.105, 0.060, (r - 0.30) / 0.50)

    blade_rings = []
    for r in stations:
        tip_u = max(0.0, (r - 0.80) / (R - 0.80))
        cc = chord(min(r, 0.80)) * math.sqrt(max(0.0, 1 - tip_u ** 2)) if r < R else 0.0
        beta = math.atan(1.15 / (TAU * max(r, 0.14)))
        beta = min(beta, math.radians(48))
        if r < 0.13:
            # round shank blending to airfoil
            u = (r - 0.075) / 0.055
            tc, cam = lerp(0.55, 0.16, u), 0.0
        else:
            tc, cam = lerp(0.12, 0.07, (r - 0.13) / 0.73), 0.035
        if r >= R - 1e-6:
            # tip point
            blade_rings.append([c + V(0.0, 0.0, R)])
            continue
        loopp = airfoil_ring(10, tc, m=cam, p=0.4, te_min=0.0015)
        ring = []
        for s, tz in loopp:
            ch = (0.35 - s) * max(cc, 0.012)        # along chord, LE positive
            th = tz * max(cc, 0.012)
            # chord dir: LE toward +Y tilted by beta toward +X; thickness dir: +X tilted
            px = ch * math.sin(beta) + th * math.cos(beta)
            py = ch * math.cos(beta) - th * math.sin(beta)
            ring.append(c + V(px, py, r))
        blade_rings.append(ring)
    # body + tip band in accent
    split = stations.index(0.80)
    bm = mb.bm
    f_before = set(bm.faces)
    mb.loft(blade_rings[:split + 1], 'Carbon', closed=True, cap0=True)
    mb.loft(blade_rings[split:], 'Paint_White', closed=True)
    blade_faces = list(set(bm.faces) - f_before)
    verts = list({v for f in blade_faces for v in f.verts})
    for k in (1, 2):
        ret = bmesh.ops.duplicate(bm, geom=verts + list({e for f in blade_faces for e in f.edges}) + blade_faces)
        nv = [e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.rotate(bm, verts=nv, cent=c, matrix=Matrix.Rotation(TAU * k / 3, 3, 'X'))
    return mb.finish(origin=PROP_C, sharp_angle=50, merge=1e-5)


# ---------------------------------------------------------------------------
# Tail: horizontal stabilizer with endplates, fin, rudder, tail wheel
# ---------------------------------------------------------------------------
HINGE_X = -3.55
RUDDER_TE = -3.95
FIN_TOP = 0.45


def fin_le(z):
    return lerp(-3.05, -3.36, (z + 0.47) / 0.92) - 0.09 * max(0.0, (z - 0.37) / 0.08) ** 2


def rudder_te(z):
    t = max(0.0, (z + 0.34) / 0.78)
    return lerp(-3.97, -3.89, t) + 0.10 * max(0.0, (z - 0.36) / 0.08) ** 2


def build_tail():
    mb = MB('tail')
    # horizontal stabilizer
    loop = airfoil_ring(14, 0.11, te_min=0.002)
    le, ch, zs = -3.20, 0.45, -0.40
    rings = []
    for y in (-0.752, -0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6, 0.752):
        rings.append([V(le - s * ch, y, zs + tz * ch) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # endplate fins
    for sy in (1, -1):
        rings = []
        zb, zt = -0.54, -0.23
        loop8 = airfoil_ring(12, 0.09, te_min=0.0015)
        ks = [0.0, 0.08, 0.3, 0.6, 0.92, 1.0]
        for k in ks:
            z = lerp(zb, zt, k)
            lex = lerp(-3.28, -3.40, k)
            te = lerp(-3.65, -3.67, k)
            c = te - lex
            sc = 1.0 if 0 < k < 1 else 0.35
            rings.append([V(lex - s * (-c), sy * 0.758 + sy * tz * (-c) * sc, z) for s, tz in loop8])
        mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # central fin (fixed part, LE -> hinge line)
    rings = []
    zst = [-0.50, -0.40, -0.25, -0.05, 0.15, 0.30, 0.40, 0.44, FIN_TOP]
    for z in zst:
        lx = fin_le(z)
        cfull = lx - rudder_te(z)
        s_h = (lx - HINGE_X) / cfull
        lp = airfoil_ring(14, 0.10, te_min=0.002, s_end=s_h)
        sc = 0.45 if z >= FIN_TOP else 1.0
        rings.append([V(lx - s * cfull, tz * cfull * sc, z) for s, tz in lp])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # tail wheel on a stainless spring strut
    mb.tube(catmull([V(-3.70, 0, -0.52), V(-3.76, 0, -0.58), V(-3.84, 0, -0.62)], 4), 0.011, 'Metal_Frame', n=10)
    mb.lathe([(0.03, -0.016), (0.045, -0.014), (0.05, 0.0), (0.045, 0.014), (0.03, 0.016)],
             V(-3.85, 0, -0.645), V(0, 1, 0), 'Rubber', n=20, closed_profile=True)
    mb.cyl(V(-3.85, -0.02, -0.645), V(-3.85, 0.02, -0.645), 0.032, 'Engine', n=14)
    for sy in (1, -1):
        mb.box((-3.84, sy * 0.022, -0.63), (0.05, 0.005, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(sharp_angle=45)


def build_rudder():
    mb = MB('rudder')
    rings = []
    zst = [-0.34, -0.25, -0.05, 0.15, 0.30, 0.36, 0.40, 0.425, 0.44]
    for z in zst:
        lx = fin_le(z)
        cfull = lx - rudder_te(z)
        s_h = (lx - HINGE_X) / cfull
        n = 12
        ring = []
        # upper surface hinge -> TE
        upper, lower = [], []
        for i in range(n + 1):
            s0 = s_h + 0.004 / cfull
            s = s0 + (1 - s0) * (i / n) ** 1.2
            _, yt = naca4(s, 0.10)
            yt = max(yt, 0.0012) * cfull
            upper.append(V(lx - s * cfull, yt, z))
            lower.append(V(lx - s * cfull, -yt, z))
        r0 = upper[0].y
        nose = []
        for j in range(1, 6):
            a = math.pi * (j / 6.0)
            nose.append(V(HINGE_X - 0.004 + math.sin(a) * r0 * 0.9, math.cos(a) * r0, z))
        sc = 0.5 if z >= 0.44 else 1.0
        ring = upper + lower[::-1] + nose[::-1]
        ring = [V(p.x, p.y * sc, p.z) for p in ring]
        # keep orientation consistent: upper(+y) -> TE -> lower(-y) -> nose
        rings.append(ring)
    mb.loft(rings, 'Paint_Accent', closed=True, cap0=True, cap1=True)
    # hinge brackets
    for z in (-0.25, 0.10, 0.38):
        mb.box((HINGE_X + 0.01, 0, z), (0.05, 0.016, 0.03), 'Metal_Frame', bevel=0.004, segs=1)
    return mb.finish(origin=V(HINGE_X, 0, 0.0), sharp_angle=45)


# ---------------------------------------------------------------------------
# Landing gear
# ---------------------------------------------------------------------------
MAIN_WHEEL = V(-0.40, 0, -0.86)
MAIN_Y = 0.95
NOSE_WHEEL = V(1.60, 0, -0.89)


def tire_profile(R, r_in, w):
    hw = w / 2
    return [(r_in, -hw * 0.72), (R * 0.80, -hw * 0.98), (R * 0.93, -hw * 0.94), (R * 0.985, -hw * 0.72),
            (R, -hw * 0.45), (R - 0.004, -hw * 0.30), (R - 0.004, -hw * 0.18), (R, -hw * 0.06),
            (R, hw * 0.06), (R - 0.004, hw * 0.18), (R - 0.004, hw * 0.30), (R, hw * 0.45),
            (R * 0.985, hw * 0.72), (R * 0.93, hw * 0.94), (R * 0.80, hw * 0.98), (r_in, hw * 0.72)]


def build_wheel(name, center, R, w, rim_r):
    mb = MB(name)
    mb.lathe(tire_profile(R, rim_r - 0.004, w), center, V(0, 1, 0), 'Rubber', n=40, closed_profile=True)
    hw = w / 2
    mb.lathe([(0.0, -hw * 0.62), (0.035, -hw * 0.62), (0.05, -hw * 0.45), (rim_r * 0.92, -hw * 0.55),
              (rim_r, -hw * 0.70), (rim_r, hw * 0.70), (rim_r * 0.92, hw * 0.55), (0.05, hw * 0.45),
              (0.035, hw * 0.62), (0.0, hw * 0.62)], center, V(0, 1, 0), 'Engine', n=32)
    return mb.finish(origin=center, sharp_angle=40)


def spat_shell(mb_name, yc):
    x0, x1 = -0.02, -0.90
    rings = [[V(x0, yc, -0.80)]]
    n = 32
    us = [0.004, 0.015, 0.035, 0.07, 0.12, 0.2, 0.3, 0.42, 0.55, 0.68, 0.8, 0.9, 0.96, 1.0]
    for u in us:
        x = lerp(x0, x1, u)
        _, t = naca4(u, 0.20)
        f = t / 0.10
        hw = 0.122 * f + 0.004
        ht = 0.195 * f + 0.004
        zc = -0.80 + 0.02 * u
        ring = []
        for k in range(n):
            a = TAU * k / n
            c, s = math.cos(a), math.sin(a)
            ring.append(V(x, yc + sgnpow(c, 2 / 2.3) * hw, zc + sgnpow(s, 2 / (2.0 if s > 0 else 2.6)) * ht))
        rings.append(ring)
    mb = MB(mb_name)
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    ob = mb.finish(sharp_angle=70)
    cut = MB('spatcut')
    cut.box((-0.40, yc, -1.0), (0.38, 0.17, 0.26), 'Paint_White', bevel=0.04, segs=3)
    boolean_cut_shell(ob, cut.finish(sharp_angle=80))
    me = ob.data
    me.materials.append(MATS['Paint_Dark'])
    bm = bmesh.new()
    bm.from_mesh(me)
    zl = lambda x: -0.875 + 0.06 * (x + 0.40)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                           plane_co=V(-0.40, 0, -0.875), plane_no=V(-0.06, 0, 1).normalized())
    for fc in bm.faces:
        cc = fc.calc_center_median()
        fc.material_index = 1 if cc.z < zl(cc.x) else 0
    bm.to_mesh(me)
    bm.free()
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.006
    sol.offset = -1
    sol.material_offset = 1
    sol.material_offset_rim = 1
    apply_mods(ob)
    return ob


def build_gear():
    mb = MB('main_gear')
    xg = MAIN_WHEEL.x
    for sy in (1, -1):
        pts = catmull([V(xg, 0, -0.728), V(xg, sy * 0.25, -0.742), V(xg, sy * 0.50, -0.785),
                       V(xg, sy * 0.70, -0.835), V(xg, sy * 0.86, -0.862)], 5)
        mb.tube(pts, 0.0, 'Paint_Dark', n=20, square=(0.095, 0.03, 5), cap=True)
        mb.cyl(V(xg, sy * 0.84, -0.86), V(xg, sy * 1.035, -0.86), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(xg, sy * 0.875, -0.86), V(xg, sy * 0.885, -0.86), 0.085, 'Metal_Frame', n=24)  # brake disc
        mb.box((xg + 0.07, sy * 0.88, -0.83), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008, segs=1)
    # clamp block to the keel
    mb.box((xg, 0, -0.722), (0.12, 0.11, 0.035), 'Metal_Frame', bevel=0.008, segs=2)
    # nose gear bracket under the pod
    mb.box((1.60, 0, -0.648), (0.10, 0.09, 0.04), 'Paint_Dark', bevel=0.012, segs=2)
    # pitot tube at the nose tip, comm antenna on the keel, passenger foot steps
    mb.cyl(V(2.06, 0, -0.352), V(2.20, 0, -0.352), 0.006, 'Metal_Frame', n=10)
    mb.lathe([(0.0, 2.20), (0.006, 2.20), (0.0045, 2.215), (0.0, 2.216)], V(0, 0, -0.352), V(1, 0, 0),
             'Metal_Frame', n=10)
    mb.lathe([(0.0, 0.0), (0.012, 0.0), (0.004, 0.02), (0.0025, 0.32), (0.0, 0.322)], V(-2.30, 0, -0.66),
             V(-0.25, 0, 1).normalized(), 'Paint_Dark', n=10)
    for sy in (1, -1):
        mb.cyl(V(-0.15, sy * 0.30, -0.72), V(-0.15, sy * 0.47, -0.74), 0.012, 'Metal_Frame', n=10)
        mb.box((-0.15, sy * 0.48, -0.742), (0.11, 0.07, 0.012), 'Metal_Frame', bevel=0.004, segs=1)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = [spat_shell('spat_L', MAIN_Y), spat_shell('spat_R', -MAIN_Y)]
    wl = build_wheel('wheel_L', V(xg, MAIN_Y, MAIN_WHEEL.z), 0.19, 0.14, 0.122)
    wr = build_wheel('wheel_R', V(xg, -MAIN_Y, MAIN_WHEEL.z), 0.19, 0.14, 0.122)
    # nose wheel + fork (one node, origin on steering pivot / axle line)
    nb = MB('nose_wheel')
    c = NOSE_WHEEL
    R, w = 0.16, 0.095
    nb.lathe(tire_profile(R, 0.092, w), c, V(0, 1, 0), 'Rubber', n=36, closed_profile=True)
    nb.lathe([(0.0, -0.034), (0.03, -0.034), (0.045, -0.025), (0.088, -0.032), (0.096, -0.034), (0.096, 0.034),
              (0.088, 0.032), (0.045, 0.025), (0.03, 0.034), (0.0, 0.034)], c, V(0, 1, 0), 'Engine', n=28)
    nb.cyl(c + V(0, -0.075, 0), c + V(0, 0.075, 0), 0.011, 'Metal_Frame', n=10)
    for sy in (1, -1):
        nb.tube(catmull([c + V(0.0, sy * 0.066, 0.0), c + V(0.012, sy * 0.068, 0.12), c + V(0.0, sy * 0.064, 0.215)],
                        4), 0.0, 'Paint_Dark', n=16, square=(0.012, 0.05, 5), cap=True)
    nb.box(c + V(0, 0, 0.222), (0.07, 0.15, 0.03), 'Paint_Dark', bevel=0.01, segs=2)
    nb.cyl(c + V(0, 0, 0.23), c + V(0, 0, 0.36), 0.022, 'Metal_Frame', n=14)
    # mudguard arc
    arc = []
    for k in range(13):
        a = math.radians(lerp(25, 150, k / 12))
        arc.append(c + V(math.cos(a) * 0.188, 0, math.sin(a) * 0.188))
    nb.tube(arc, 0.0, 'Paint_Accent', n=16, square=(0.10, 0.008, 6), cap=True)
    nose = nb.finish(origin=NOSE_WHEEL, sharp_angle=40)
    return gear, spats, wl, wr, nose


# ---------------------------------------------------------------------------
# Cockpit: windscreen, panel, seats, controls
# ---------------------------------------------------------------------------
def windscreen_point(u, v):
    y = u * lerp(0.375, 0.335, v)
    xb = 1.30 - 0.22 * u * u
    zb = pod_top_z(xb, y) - 0.006
    xt = 0.95 - 0.13 * u * u
    zt = 0.60 - 0.09 * u * u - 0.10 * u ** 10
    x = lerp(xb, xt, v) + 0.045 * math.sin(math.pi * v)
    z = lerp(zb, zt, v)
    return V(x, y, z)


def build_windscreen():
    nu, nv = 28, 14
    coords, faces = [], []
    for j in range(nv + 1):
        for i in range(nu + 1):
            u = -1 + 2 * i / nu
            coords.append(windscreen_point(u, j / nv))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append([a, a + 1, a + nu + 2, a + nu + 1])
    mb = MB('windscreen')
    mb.faces(coords, faces, 'Glass')
    bm = mb.bm
    bm.normal_update()
    # make normals face forward/outward (+X)
    if sum(f.normal.x for f in bm.faces) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    ob = mb.finish(sharp_angle=80, recalc=False)
    sol = ob.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.005
    sol.offset = -1
    apply_mods(ob)
    # bottom seal strip
    sb = MB('windscreen_seal')
    sb.tube([windscreen_point(-1 + 2 * i / 40, 0.0) + V(0, 0, 0.004) for i in range(41)], 0.009, 'Paint_Dark', n=8)
    seal = sb.finish(sharp_angle=60)
    return ob, seal


def build_cockpit():
    mb = MB('cockpit')
    # --- instrument panel (faces the pilot, top tilted forward 15 deg)
    tilt = math.radians(15)
    nrm = V(-math.cos(tilt), 0, math.sin(tilt))
    upv = V(math.sin(tilt), 0, math.cos(tilt))
    pc = V(1.10, 0, -0.02)
    mb.box(pc, (0.03, 0.60, 0.21), 'Panel', bevel=0.012, segs=2, rot=Euler((0, tilt, 0)))
    face_c = pc + nrm * 0.015

    def on_panel(y, z, d=0.0):
        return face_c + V(0, y, 0) + upv * z + nrm * d

    gauges = [(0.125, 0.03, 0.036), (0.215, 0.03, 0.033), (-0.125, 0.03, 0.036), (-0.215, 0.03, 0.033),
              (0.17, -0.055, 0.025), (-0.17, -0.055, 0.025)]
    for (gy, gz, gr) in gauges:
        mb.cyl(on_panel(gy, gz, 0.0), on_panel(gy, gz, 0.008), gr, 'Metal_Frame', n=20)
        mb.cyl(on_panel(gy, gz, 0.008), on_panel(gy, gz, 0.0085), gr * 0.86, 'Gauge_Face', n=20)
        p = on_panel(gy, gz, 0.0095)
        mb.box(p + V(0, -gr * 0.25, 0) + upv * gr * 0.18, (0.002, gr * 0.65, 0.004), 'Paint_Accent',
               rot=Euler((math.radians(-35), tilt, 0)))
    # central EFIS screen
    mb.box(on_panel(0, 0.0, 0.004), (0.008, 0.15, 0.105), 'Paint_Dark', bevel=0.004, segs=1, rot=Euler((0, tilt, 0)))
    mb.box(on_panel(0, 0.0, 0.0085), (0.002, 0.135, 0.09), 'Visor', rot=Euler((0, tilt, 0)))
    # switches row
    for k in range(5):
        mb.cyl(on_panel(-0.06 + k * 0.03, -0.085, 0.0), on_panel(-0.06 + k * 0.03, -0.085, 0.018), 0.004,
               'Metal_Frame', n=6)
    # anti-glare coaming hood over the panel
    rings = []
    for k in range(9):
        x = lerp(1.16, 0.985, k / 8)
        ring = []
        for i in range(15):
            u = -1 + 2 * i / 14
            y = u * 0.27
            z = pod_top_z(max(x, 1.07), y) + 0.010 + 0.022 * (1 - u * u) - 0.25 * max(0.0, 1.07 - x) ** 2
            ring.append(V(x, y, z))
        rings.append(ring)
    lower = [[p - V(0, 0, 0.018) for p in r] for r in rings]
    coords, faces = [], []
    nr, ni = len(rings), 15
    for r in rings:
        coords += r
    for r in lower:
        coords += r
    off = nr * ni
    for k in range(nr - 1):
        for i in range(ni - 1):
            a = k * ni + i
            faces.append([a, a + 1, a + ni + 1, a + ni])
            b = off + a
            faces.append([b, b + ni, b + ni + 1, b + 1])
    for i in range(ni - 1):   # rear lip + front lip
        a = (nr - 1) * ni + i
        faces.append([a, a + off, a + off + 1, a + 1])
        faces.append([i, i + 1, i + 1 + off, i + off])
    for k in range(nr - 1):   # side lips
        a = k * ni
        faces.append([a, a + off, a + off + ni, a + ni])
        a2 = k * ni + ni - 1
        faces.append([a2, a2 + ni, a2 + off + ni, a2 + off])
    mb.faces(coords, faces, 'Panel')
    # --- seats
    mb.box((0.60, 0, -0.53), (0.40, 0.44, 0.075), 'Seat', bevel=0.032, segs=3, rot=Euler((0, math.radians(-6), 0)))
    mb.box((0.375, 0, -0.17), (0.075, 0.44, 0.62), 'Seat', bevel=0.032, segs=3, rot=Euler((0, math.radians(-16), 0)))
    mb.box((0.33, 0, -0.17), (0.03, 0.40, 0.56), 'Paint_Dark', bevel=0.01, segs=2, rot=Euler((0, math.radians(-16), 0)))
    mb.box((-0.10, 0, -0.43), (0.38, 0.44, 0.075), 'Seat', bevel=0.032, segs=3, rot=Euler((0, math.radians(-6), 0)))
    mb.box((-0.295, 0, -0.08), (0.06, 0.42, 0.66), 'Seat', bevel=0.028, segs=3, rot=Euler((0, math.radians(-8), 0)))
    # seat structure / tub floor
    mb.box((0.60, 0, -0.61), (0.36, 0.40, 0.10), 'Interior', bevel=0.02, segs=1)
    mb.box((-0.10, 0, -0.55), (0.34, 0.40, 0.18), 'Interior', bevel=0.02, segs=1)
    # stick console
    mb.box((0.85, 0, -0.63), (0.16, 0.12, 0.14), 'Interior', bevel=0.02, segs=2)
    # rudder pedals
    for sy in (1, -1):
        mb.box((1.33, sy * 0.15, -0.56), (0.025, 0.09, 0.13), 'Metal_Frame', bevel=0.006, segs=1,
               rot=Euler((0, math.radians(-20), 0)))
        mb.cyl(V(1.36, sy * 0.15, -0.66), V(1.33, sy * 0.15, -0.50), 0.008, 'Metal_Frame', n=8)
    # throttle quadrant on the left wall
    mb.box((0.76, 0.335, -0.19), (0.16, 0.04, 0.06), 'Panel', bevel=0.01, segs=2)
    mb.cyl(V(0.76, 0.315, -0.18), V(0.80, 0.30, -0.13), 0.006, 'Metal_Frame', n=8)
    mb.sphere(V(0.80, 0.30, -0.13), 0.016, 'Panel', seg=12, rings=8)
    return mb.finish(sharp_angle=40, wn=True)


def build_stick():
    mb = MB('stick')
    base = V(0.85, 0, -0.55)
    top = V(0.83, 0, 0.0)
    d = (top - base).normalized()
    mb.lathe([(0.0, 0.0), (0.045, 0.0), (0.04, 0.02), (0.03, 0.05), (0.016, 0.085), (0.0, 0.09)], base, d, 'Rubber',
             n=16)
    mb.cyl(base, base + d * 0.44, 0.011, 'Metal_Frame', n=12)
    g0 = base + d * 0.42
    mb.lathe([(0.0, 0.0), (0.017, 0.0), (0.019, 0.03), (0.018, 0.09), (0.020, 0.115), (0.016, 0.13), (0.0, 0.132)],
             g0, d, 'Rubber', n=16)
    mb.cyl(g0 + d * 0.122 + V(0.012, 0, 0), g0 + d * 0.122 + V(0.02, 0, 0), 0.006, 'Paint_Accent', n=8)
    return mb.finish(origin=base, sharp_angle=40)


# ---------------------------------------------------------------------------
# Pilot figures
# ---------------------------------------------------------------------------
FRONT_POSE = dict(
    torso=[(-0.49, 0.50, 0.0, 0.0), (-0.47, 0.50, 0.12, 0.09), (-0.42, 0.495, 0.168, 0.122),
           (-0.30, 0.49, 0.163, 0.113), (-0.15, 0.49, 0.158, 0.104), (0.00, 0.50, 0.178, 0.114),
           (0.12, 0.51, 0.198, 0.114), (0.19, 0.52, 0.188, 0.10), (0.235, 0.535, 0.12, 0.074),
           (0.255, 0.545, 0.06, 0.05)],
    neck=(V(0.54, 0, 0.23), V(0.60, 0, 0.34)),
    head=V(0.62, 0, 0.40),
    shoulders=(V(0.52, 0.185, 0.14), V(0.52, -0.185, 0.14)),
    elbows=(V(0.60, 0.235, -0.10), V(0.60, -0.225, -0.10)),
    wrists=(V(0.755, 0.27, -0.135), V(0.80, -0.045, -0.075)),
    hands=(V(0.79, 0.285, -0.135), V(0.832, -0.008, -0.065)),
    hips=(V(0.52, 0.095, -0.40), V(0.52, -0.095, -0.40)),
    knees=(V(0.93, 0.14, -0.27), V(0.93, -0.14, -0.27)),
    ankles=(V(1.24, 0.15, -0.56), V(1.24, -0.15, -0.56)),
)


def offset_pose(pose, d):
    out = {}
    for k, v in pose.items():
        if k == 'torso':
            out[k] = [(z + d.z, x + d.x, a, b) for (z, x, a, b) in v]
        elif isinstance(v, tuple):
            out[k] = tuple(p + d for p in v)
        else:
            out[k] = v + d
    return out


def build_figure(name, pose):
    mb = MB(name)
    rings = []
    for (z, cx, a, b) in pose['torso']:
        if a == 0:
            rings.append([V(cx, 0, z)])
            continue
        ring = []
        for k in range(28):
            t = TAU * k / 28
            c, s = math.cos(t), math.sin(t)
            ring.append(V(cx + sgnpow(c, 2 / 2.4) * b, sgnpow(s, 2 / 2.4) * a, z))
        rings.append(ring)
    mb.loft(rings, 'Pilot_Suit', closed=True, cap1=True)
    n0, n1 = pose['neck']
    mb.tube([n0, n1], 0.052, 'Pilot_Suit', n=14)
    h = pose['head']
    mb.sphere(h, 0.13, 'Helmet', seg=32, rings=16, scale=(1.12, 0.94, 1.0))
    mb.sphere(h + V(0.066, 0, 0.035), 0.092, 'Visor', seg=28, rings=14, scale=(1.0, 1.10, 0.55))
    mb.box(h + V(-0.02, 0, -0.10), (0.16, 0.13, 0.05), 'Helmet', bevel=0.022, segs=2)   # chin/neck guard
    for side in (0, 1):
        sh, el, wr, hd = pose['shoulders'][side], pose['elbows'][side], pose['wrists'][side], pose['hands'][side]
        hp, kn, an = pose['hips'][side], pose['knees'][side], pose['ankles'][side]
        mb.sphere(sh, 0.056, 'Pilot_Suit', seg=16, rings=8)
        mb.tube([sh, el], [0.052, 0.044], 'Pilot_Suit', n=14)
        mb.sphere(el, 0.044, 'Pilot_Suit', seg=14, rings=8)
        mb.tube([el, wr], [0.042, 0.033], 'Pilot_Suit', n=14)
        d = (hd - wr).normalized()
        rot = d.to_track_quat('X', 'Z').to_euler()
        mb.sphere(hd, 0.046, 'Glove', seg=14, rings=8, scale=(1.0, 0.82, 0.9), rot=rot)
        mb.sphere(hp, 0.085, 'Pilot_Suit', seg=16, rings=8)
        mb.tube([hp, kn], [0.084, 0.060], 'Pilot_Suit', n=16)
        mb.sphere(kn, 0.061, 'Pilot_Suit', seg=14, rings=8)
        mb.tube([kn, an], [0.056, 0.042], 'Pilot_Suit', n=14)
        # boot
        fwd = V(1, 0, 0.25).normalized()
        mb.box(an + V(0.05, 0, -0.035), (0.20, 0.085, 0.085), 'Glove', bevel=0.03, segs=2,
               rot=Euler((0, math.radians(-14), 0)))
    return mb.finish(origin=pose['hips'][0].lerp(pose['hips'][1], 0.5), sharp_angle=60)


def build_pilots():
    front = build_figure('pilot_front', FRONT_POSE)
    rp = offset_pose(FRONT_POSE, V(-0.62, 0, 0.10))
    rp['knees'] = (V(0.27, 0.215, -0.15), V(0.27, -0.215, -0.15))
    rp['ankles'] = (V(0.47, 0.245, -0.52), V(0.47, -0.245, -0.52))
    rp['hips'] = (V(-0.10, 0.10, -0.30), V(-0.10, -0.10, -0.30))
    rp['elbows'] = (V(-0.03, 0.235, -0.04), V(-0.03, -0.235, -0.04))
    rp['wrists'] = (V(0.13, 0.20, -0.17), V(0.13, -0.20, -0.17))
    rp['hands'] = (V(0.17, 0.195, -0.18), V(0.17, -0.195, -0.18))
    rear = build_figure('pilot_rear', rp)
    return front, rear


def build_crew():
    """Seated crew from blender/pilot.py (flight suit, open helmet with headset, IK to the controls)."""
    sys.modules.setdefault('build_autogiro', sys.modules[__name__])   # pilot.py shares this module's MATS
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import pilot
    pilot.ensure_materials()
    base, top = V(0.85, 0, -0.55), V(0.83, 0, 0.0)
    d = (top - base).normalized()
    front = pilot.build_pilot('pilot_front', V(0.57, 0, -0.42), 14,
                              hands={'R': ('stick', base + d * 0.486, d),
                                     'L': ('knob', V(0.80, 0.30, -0.13), V(0.35, 0, 1))},
                              feet={'L': V(1.22, 0.16, -0.56), 'R': V(1.22, -0.16, -0.56)})
    # legs kept inside the tub (half-width 0.40 at knee height, 0.30 at the floor), knees nearly together
    rear = pilot.build_pilot('pilot_rear', V(-0.06, 0, -0.32), 10,
                             hands={'R': ('rest', V(0.12, -0.12, -0.10), None),
                                    'L': ('rest', V(0.12, 0.12, -0.10), None)},
                             feet={'L': V(0.40, 0.16, -0.56), 'R': V(0.40, -0.16, -0.56)}, knee_out=0.03)
    return front, rear


def build_registration(pod):
    """'EC-GYR' as mesh letters conforming to the rear pod sides."""
    obs = []
    for side in (1, -1):
        cu = bpy.data.curves.new('reg_txt', 'FONT')
        cu.body = 'EC-GYR'
        cu.size = 0.105
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
        cx, cz = -0.27, -0.285
        for v in bm.verts:
            tx, ty = v.co.x, v.co.y
            if side > 0:
                wx, wz = cx - tx, cz + ty
            else:
                wx, wz = cx + tx, cz + ty
            origin = V(wx, side * 1.0, wz)
            hit, loc, nrm, idx = pod.ray_cast(origin, V(0, -side, 0))
            if hit:
                v.co = loc + nrm.normalized() * 0.0018
            else:
                v.co = V(wx, side * pod_side_y(wx, wz), wz)
        bm.normal_update()
        # orient faces outward
        for f in bm.faces:
            if f.normal.y * side < 0:
                f.normal_flip()
        for f in bm.faces:
            f.smooth = False
        me2 = bpy.data.meshes.new('registration_' + ('L' if side > 0 else 'R'))
        bm.to_mesh(me2)
        bm.free()
        bpy.data.meshes.remove(me)
        me2.materials.append(MATS['Paint_Dark'])
        ob = bpy.data.objects.new(me2.name, me2)
        link(ob)
        obs.append(ob)
    return obs


def join_objects(name, objs):
    objs = [o for o in objs if o is not None]
    target = objs[0]
    with bpy.context.temp_override(active_object=target, object=target, selected_objects=objs,
                                   selected_editable_objects=objs):
        bpy.ops.object.join()
    target.name = name
    target.data.name = name
    return target


def build_all():
    pod, rim = build_pod()
    frame = build_frame()
    head = build_rotor_head()
    rotor = build_rotor()
    engine = build_engine()
    prop = build_prop()
    tail = build_tail()
    rudder = build_rudder()
    gear, spats, wl, wr, nose = build_gear()
    ws, seal = build_windscreen()
    cockpit = build_cockpit()
    stick = build_stick()
    pf, pr = build_crew()
    regs = build_registration(pod)
    eye = bpy.data.objects.new('eye_front', None)
    eye.empty_display_type = 'PLAIN_AXES'
    eye.empty_display_size = 0.05
    eye.location = (0.53, 0.0, 0.27)    # eyes of the pilot.py crew figure
    link(eye)
    # static parts -> one 'airframe' mesh (fewer draw calls), windscreen kept separate
    airframe = join_objects('airframe', [pod, rim, frame, engine, tail, gear] + spats + [seal, cockpit] + regs)
    ws.name = 'windscreen'
    for ob in bpy.context.scene.collection.objects:
        ob.rotation_euler = (0, 0, 0)
        ob.scale = (1, 1, 1)
        ob.parent = None
    return airframe


# ---------------------------------------------------------------------------
# Export + verification
# ---------------------------------------------------------------------------
REQUIRED = {
    'rotor': (-0.25, 1.70, 0.0), 'rotor_head': (-0.27, 1.47, 0.0), 'prop': (-1.50, 0.25, 0.0),
    'rudder': (-3.55, 0.0, 0.0), 'nose_wheel': (1.60, -0.89, 0.0), 'wheel_L': (-0.40, -0.86, -0.95),
    'wheel_R': (-0.40, -0.86, 0.95), 'stick': (0.85, -0.55, 0.0), 'eye_front': (0.53, 0.27, 0.0),
    'pilot_front': None, 'pilot_rear': None,
}


def check_normals():
    """Signed volume per connected component; negative => inverted normals."""
    bad = 0
    for ob in bpy.context.scene.objects:
        if ob.type != 'MESH':
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        seen = set()
        comps = 0
        for f0 in bm.faces:
            if f0 in seen:
                continue
            stack = [f0]
            seen.add(f0)
            vol = 0.0
            open_edges = 0
            while stack:
                f = stack.pop()
                vs = [l.vert.co for l in f.loops]
                for i in range(1, len(vs) - 1):
                    vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6.0
                for e in f.edges:
                    if len(e.link_faces) < 2:
                        open_edges += 1
                    for g in e.link_faces:
                        if g not in seen:
                            seen.add(g)
                            stack.append(g)
            comps += 1
            if vol < -1e-9 and open_edges == 0:
                bad += 1
                print('  !! inverted component in', ob.name, 'vol=%.6f' % vol)
        bm.free()
    print('  normal check: inverted closed components =', bad)
    return bad


def export_glb():
    os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=GLB_PATH, export_format='GLB', export_yup=True, export_apply=True,
                              export_extras=True, export_cameras=False, export_lights=False,
                              use_selection=False, export_animations=False, export_texcoords=True,
                              export_normals=True, export_materials='EXPORT')


def verify_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, total = struct.unpack_from('<III', data, 0)
    clen, ctype = struct.unpack_from('<II', data, 12)
    js = json.loads(data[20:20 + clen].decode('utf8'))
    nodes = js['nodes']
    roots = js['scenes'][js.get('scene', 0)]['nodes']
    print('=== GLB VERIFY: %s  size=%.2f MB' % (path, len(data) / 1e6))
    tris = 0
    for m in js.get('meshes', []):
        for p in m['primitives']:
            if p.get('mode', 4) == 4:
                if 'indices' in p:
                    tris += js['accessors'][p['indices']]['count'] // 3
                else:
                    tris += js['accessors'][p['attributes']['POSITION']]['count'] // 3
    ok = True
    names_root = {nodes[i].get('name'): i for i in roots}
    for i in roots:
        n = nodes[i]
        t = n.get('translation', [0, 0, 0])
        print('  root node %-14s t=(%.3f, %.3f, %.3f) rot=%s children=%s mesh=%s' % (
            n.get('name'), t[0], t[1], t[2], n.get('rotation'), n.get('children'), n.get('mesh')))
    for name, want in REQUIRED.items():
        if name not in names_root:
            print('  !! missing root node', name)
            ok = False
            continue
        n = nodes[names_root[name]]
        t = n.get('translation', [0, 0, 0])
        if n.get('rotation') or n.get('scale'):
            print('  !! node has rotation/scale', name)
            ok = False
        if want and max(abs(a - b) for a, b in zip(t, want)) > 1e-3:
            print('  !! wrong translation', name, t, want)
            ok = False
    mats = [m['name'] for m in js.get('materials', [])]
    print('  materials:', mats)
    for m in js.get('materials', []):
        if m.get('alphaMode'):
            print('  material %s alphaMode=%s' % (m['name'], m['alphaMode']))
    print('  triangles:', tris)
    print('  VERIFY', 'OK' if ok else 'FAILED')
    return ok, tris


# ==== CONTINUE ====


# ---------------------------------------------------------------------------
# Preview rendering
# ---------------------------------------------------------------------------
def setup_render(scn):
    eng = 'CYCLES'
    try:
        import addon_utils
        addon_utils.enable('cycles', default_set=True)
        scn.render.engine = 'CYCLES'
    except Exception as ex:
        print('Cycles unavailable, using EEVEE', ex)
        eng = 'BLENDER_EEVEE'
        scn.render.engine = eng
    if eng == 'CYCLES':
        try:
            prefs = bpy.context.preferences.addons['cycles'].preferences
            for dt in ('OPTIX', 'CUDA'):
                try:
                    prefs.compute_device_type = dt
                    prefs.refresh_devices()
                    devs = [d for d in prefs.devices if d.type == dt]
                    if devs:
                        for d in prefs.devices:
                            d.use = (d.type == dt)
                        scn.cycles.device = 'GPU'
                        print('Cycles device', dt, [d.name for d in devs])
                        break
                except Exception as ex:
                    print('device', dt, ex)
        except Exception as ex:
            print('GPU setup failed', ex)
        scn.cycles.samples = SAMPLES
        scn.cycles.use_denoising = True
        try:
            scn.cycles.denoiser = 'OPTIX'
        except Exception:
            pass
        scn.cycles.max_bounces = 8
        scn.cycles.sample_clamp_indirect = 4.0
        scn.cycles.transparent_max_bounces = 16
    scn.render.resolution_x = 1280
    scn.render.resolution_y = 720
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = 'PNG'
    try:
        scn.view_settings.view_transform = 'AgX'
        scn.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        try:
            scn.view_settings.look = 'None'
        except Exception:
            pass
    scn.view_settings.exposure = 0.0


def setup_studio(scn):
    world = bpy.data.worlds.new('Studio')
    scn.world = world
    try:
        if world.node_tree is None:
            world.use_nodes = True
    except Exception:
        pass
    nt = world.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], bg.inputs['Color'])
    nt.links.new(bg.outputs[0], out.inputs[0])
    ramp.color_ramp.elements[0].position = 0.50
    ramp.color_ramp.elements[0].color = (0.78, 0.78, 0.78, 1)
    ramp.color_ramp.elements[1].position = 0.85
    ramp.color_ramp.elements[1].color = (0.42, 0.50, 0.62, 1)
    bg.inputs['Strength'].default_value = 1.0

    coll = bpy.data.collections.new('PreviewRig')
    scn.collection.children.link(coll)
    # ground
    # seamless studio cyclorama: flat floor at h=-1.05 curving up into a distant wall
    prof = [(0.0, -1.05), (22.0, -1.05)]
    for k in range(1, 13):
        a = 0.5 * math.pi * k / 12
        prof.append((22.0 + 12.0 * math.sin(a), -1.05 + 12.0 * (1 - math.cos(a))))
    prof.append((34.0, 60.0))
    gb = MB('ground')
    gb.lathe(prof, V(0, 0, 0), V(0, 0, 1), 'Paint_White', n=128)
    g = gb.finish(sharp_angle=89, recalc=False)
    g.users_collection[0].objects.unlink(g)
    try:
        g.visible_shadow = False   # let the sun through the backdrop wall
    except Exception:
        pass
    me = g.data
    me.materials.clear()
    bmg = bmesh.new()
    bmg.from_mesh(me)
    bmg.normal_update()
    if sum(fc.normal.z for fc in bmg.faces) < 0:
        bmesh.ops.reverse_faces(bmg, faces=bmg.faces[:])
    bmg.to_mesh(me)
    bmg.free()
    gm = bpy.data.materials.new('Ground')
    gm.diffuse_color = (0.5, 0.5, 0.5, 1)
    try:
        if gm.node_tree is None:
            gm.use_nodes = True
    except Exception:
        pass
    bs = [n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'][0]
    bs.inputs['Base Color'].default_value = (0.36, 0.36, 0.37, 1)
    bs.inputs['Roughness'].default_value = 0.55
    me.materials.append(gm)
    coll.objects.link(g)
    # lights
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = 3.2
    sun.angle = math.radians(3.0)
    so = bpy.data.objects.new('Sun', sun)
    so.rotation_euler = Euler((math.radians(42), math.radians(-18), math.radians(-35)), 'XYZ')
    coll.objects.link(so)
    for nm, loc, en, size in (('KeyArea', (6, 7, 6), 900, 6), ('FillArea', (-7, -6, 4), 500, 8),
                              ('RimArea', (-4, 6, 7), 400, 5)):
        L = bpy.data.lights.new(nm, 'AREA')
        L.energy = en
        L.size = size
        lo = bpy.data.objects.new(nm, L)
        lo.location = loc
        d = Vector((0, 0, 0)) - Vector(loc)
        lo.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        coll.objects.link(lo)
    cam = bpy.data.cameras.new('PreviewCam')
    co = bpy.data.objects.new('PreviewCam', cam)
    coll.objects.link(co)
    scn.camera = co
    return coll, co


def aim(cam_ob, loc, target, lens=50, ortho=None):
    cam_ob.location = Vector(loc)
    d = Vector(target) - Vector(loc)
    cam_ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam = cam_ob.data
    if ortho:
        cam.type = 'ORTHO'
        cam.ortho_scale = ortho
    else:
        cam.type = 'PERSP'
        cam.lens = lens
    cam.clip_start = 0.05
    cam.clip_end = 200


PREVIEW_VIEWS = {
    'three_quarter_front': dict(loc=(7.6, 6.3, 2.5), target=(-0.40, 0.0, 0.42), lens=33, rotor=-58, prop=20),
    'side': dict(loc=(0.0, 30.0, 0.30), target=(-0.75, 0.0, 0.30), ortho=9.4, rotor=0, prop=0),
    'top': dict(loc=(-0.3, 0.0, 30.0), target=(-0.3, 0.0, 0.0), ortho=9.6, rotor=30, prop=0),
    'rear_three_quarter': dict(loc=(-8.0, -6.6, 2.8), target=(-0.6, 0.0, 0.45), lens=35, rotor=-40, prop=40),
    'closeup_cockpit_rotorhead': dict(loc=(2.25, 1.85, 2.15), target=(0.0, 0.0, 0.72), lens=30, rotor=75, prop=0),
    'engine_detail': dict(loc=(-2.6, 1.9, 0.9), target=(-1.05, 0.0, 0.0), lens=45, rotor=75, prop=30, extra=True),
    'front_detail': dict(loc=(3.6, 0.9, 0.9), target=(0.9, 0.0, 0.05), lens=40, rotor=75, prop=30, extra=True),
}


def render_previews(scn):
    setup_render(scn)
    coll, cam = setup_studio(scn)
    rotor = bpy.data.objects.get('rotor')
    prop = bpy.data.objects.get('prop')
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    for name, v in PREVIEW_VIEWS.items():
        if (ONLY and name not in ONLY) or (v.get('extra') and not (ONLY and name in ONLY)):
            continue
        aim(cam, v['loc'], v['target'], v.get('lens', 50), v.get('ortho'))
        if rotor:
            rotor.rotation_euler = (0, 0, math.radians(v['rotor']))
        if prop:
            prop.rotation_euler = (math.radians(v['prop']), 0, 0)
        scn.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', scn.render.filepath)
    if rotor:
        rotor.rotation_euler = (0, 0, 0)
    if prop:
        prop.rotation_euler = (0, 0, 0)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    scn = reset_scene()
    build_materials()
    build_all()
    for m in list(bpy.data.materials):
        if m.users == 0:
            bpy.data.materials.remove(m)
    check_normals()
    try:
        bpy.context.preferences.filepaths.save_version = 0   # no .blend1 backups
    except Exception:
        pass
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
    export_glb()
    verify_glb(GLB_PATH)
    pr = bpy.data.objects.get('pilot_rear')
    if pr and '--show-rear' not in ARGV:
        pr.hide_render = True
    if DO_PREVIEWS:
        render_previews(scn)


if __name__ == '__main__':
    main()
