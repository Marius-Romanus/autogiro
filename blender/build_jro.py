"""
DTA J-RO (DTA, Montelimar, 2011-) for the Autogiro web sim: fully faired tandem two-seater. Carbon/epoxy
egg-shaped monocoque with a pointed nose, a glued plexiglass bubble canopy over the front two thirds
and two removable gull-wing doors (black frames) hinged on the roof spine; Rotax 914 under a cowl that
ends round the gearbox, four slanted meshed louvres and the J-RO script on each cowl side, a second row
of small gills and an oval air exit lower down; two parallel mast tubes from the cowl top to the gimbal
head, 8.60 m Averso two-blader; DUC Flash-2 three-blader on a bare hub (orange flange); thin steel
boom from under the cell, kinked under the prop, rising to a one-piece swept tailplane with dihedral
carrying three big trapezoid vertical surfaces: the fin + rudder in the middle and a winglet on each
tip; long aluminium cantilever main legs in fairings, Beringer wheels in teardrop clamshell spats,
free-castering nose wheel on a fork under the nose.

Traced on the dimensioned three-view of the POH (page 14 rendered 2084 x 2947; side view scale
125 px/m: compromise of the 5.20 m overall length (121.5), the 2.62 m overall height (129) and the
8.60 m rotor (126); hub at px (1240, 552)); wheelbase 1.80 m from the POH dimension and the orange
05-OQ side photo (the drawing places the nose wheel 0.3 m too far forward); widths from the plan view
(1.95 m over the spats, 1.73 m over the winglets). Seat and panel stations from the POH weighing sheet
(lever arms from the firewall). Hub frame as in gyrokit.py; `tv()` converts the pixels of the side view.

  blender -b -P blender/build_jro.py -- [--previews] [--only VIEW,...] [--overlay yaw,cx,cz,ppm,w,h,side]
Outputs: public/models/jro.glb, blender/jro.blend, blender/previews/jro/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- three-view side image (hub at px 1240, 552) -> hub frame ------------------------------------
S_TV = 125.0


def tv(x, y):
    return ((x - 1240.0) / S_TV, (552.0 - y) / S_TV)


def tvs(pts):
    return [tv(x, y) for x, y in pts]


# ---- hub frame -----------------------------------------------------------------------------------
GROUND = -2.624
WR = 0.19                                   # main wheels (Beringer, about 4.00-6)
AXLE = (-0.272, GROUND + WR)
CG = (0.33, AXLE[1] + 0.85)                 # sim convention in x; height 0.85 m above the main axle
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(-0.03, -0.20)
PROP = R(-1.024, -1.312)
PROP_R = 0.86
MAIN_Y = 0.85                               # track 1.70 m (1.95 m over the spats)
NWR = 0.15
NOSE = (AXLE[0] + 1.85, GROUND + NWR)       # POH 1800 mm, side photos 1.85-1.9

LIVERY = dict(body=('#C3161C', 0.25, 0.22), accent=('#C9CDD1', 0.85, 0.26), dark=('#141517', 0.3, 0.30),
              seat=('#1A1B1E', 0.0, 0.8))
REG = '26-AZR'

# ---- hull: side outline (px), plan half-width and belt (max width) height -----------------------
XTIP, ZTIP = tv(1528, 811)
X_END = -0.92
TOP_PX = [(1528, 811), (1525, 806), (1519, 798), (1510, 790), (1500, 781), (1480, 763), (1460, 745), (1440, 729),
          (1420, 716), (1400, 705), (1380, 697), (1360, 690), (1340, 684), (1320, 679), (1300, 675), (1280, 672),
          (1260, 670), (1240, 668), (1220, 667.5), (1200, 669), (1180, 673), (1160, 678), (1140, 684),
          (1125, 690)]
BOT_PX = [(1528, 811), (1526.5, 817), (1521, 823), (1510, 828), (1495, 832), (1480, 835), (1460, 837),
          (1440, 838.5), (1420, 839.5), (1400, 840), (1380, 840), (1360, 840), (1340, 839), (1320, 837.5),
          (1300, 835.5), (1280, 833), (1262, 830), (1248, 825), (1236, 817), (1224, 808), (1210, 801),
          (1196, 795), (1180, 787), (1165, 773), (1150, 758), (1137, 745), (1125, 733)]
W_TAB = [(XTIP, 0.0), (2.192, 0.129), (2.008, 0.265), (1.832, 0.345), (1.464, 0.426), (1.104, 0.456),
         (0.736, 0.470), (0.376, 0.463), (0.008, 0.426), (-0.352, 0.345), (-0.72, 0.257), (X_END, 0.200)]
BELT_TAB = [(XTIP, ZTIP), (2.10, -2.035), (1.80, -1.990), (1.40, -1.935), (1.00, -1.890), (0.50, -1.860),
            (0.00, -1.820), (-0.30, -1.730), (-0.60, -1.520), (X_END, -1.300)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T, F_B, F_W, F_M = _prof(tvs(TOP_PX)), _prof(tvs(BOT_PX)), _prof(W_TAB), _prof(BELT_TAB)
F_NT = B.hermite([X_END, -0.5, 0.0, 0.8, 1.6, 2.1, XTIP], [2.4, 2.3, 2.15, 2.05, 2.1, 2.2, 2.2])
F_NB = B.hermite([X_END, -0.5, 0.0, 0.8, 1.6, 2.1, XTIP], [2.3, 2.5, 2.6, 2.6, 2.5, 2.3, 2.2])


def hull(X):
    u = _u(X)
    zt, zb, w = F_T(u), F_B(u), max(F_W(u), 1e-4)
    h = zt - zb
    zm = min(max(F_M(u), zb + 0.2 * h), zt - 0.2 * h)
    return zt, zb, w, zm, F_NT(X), F_NB(X)


def hull_half(X, m=40):
    zt, zb, w, zm, nt, nb = hull(X)
    half = []
    for i in range(m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.sin(a) ** (2 / nt), zm + (zt - zm) * math.cos(a) ** (2 / nt)))
    for i in range(1, m + 1):
        a = 0.5 * math.pi * i / m
        half.append((w * math.cos(a) ** (2 / nb), zm - (zm - zb) * math.sin(a) ** (2 / nb)))
    return half


def hull_ring(X, n_half=30, scale=1.0):
    h = E.resample2d(hull_half(X), n_half)
    zt, zb = h[0][1], h[-1][1]
    zc = 0.5 * (zt + zb)
    h = [(y * scale, zc + (z - zc) * scale) for y, z in h]
    return [R(X, z, y) for y, z in h] + [R(X, z, -y) for y, z in reversed(h[1:-1])]


def hull_y(X, Z):
    zt, zb, w, zm, nt, nb = hull(X)
    if Z >= zm:
        f = min(1.0, (Z - zm) / (zt - zm))
        return w * max(0.0, 1 - f ** nt) ** (1 / nt)
    f = min(1.0, (zm - Z) / (zm - zb))
    return w * max(0.0, 1 - f ** nb) ** (1 / nb)


# ---- glazing and door (side view px) -------------------------------------------------------------
# bubble canopy: windscreen from 0.22 m behind the nose tip, door windows down to the sill, back to the
# rear door edge just ahead of the mast (everything above this line inside the x range is glass)
P_GLASS = [(1503, 779), (1488, 788.5), (1470, 797.5), (1452, 807), (1441, 815), (1420, 816.5), (1400, 815.5),
           (1370, 811.5), (1340, 805.5), (1310, 796.5), (1285, 785), (1265, 770.5), (1250, 755.5), (1239, 736),
           (1233.5, 711), (1234, 690), (1237, 600), (1530, 600)]
# door = everything behind the slanted front frame bar (the windscreen stays fixed)
P_DOOR = [(1441, 815), (1420, 786), (1402, 758), (1384, 733), (1366, 711), (1352, 692)]
SPINE_X = (1490, 1236)                      # roof spine with the door hinges (px x range)

FRONT_HIP = R(0.86, -2.105)
REAR_HIP = R(0.22, -1.985)
FRONT_BACK, REAR_BACK = 20.0, 15.0


def cast_side(target, x, z, sy):
    ok, loc, nrm, _ = target.ray_cast(V(x, sy * 1.5, z), V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def side_line(mb, target, pts_hub, sy, r=0.006, mat='Paint_Dark', lift=0.002, step=0.02, closed=False):
    pts = [R(X, Z) for X, Z in pts_hub]
    if closed:
        pts = B.resample_loop(pts, step)
    else:
        dense = []
        for a, b in zip(pts, pts[1:]):
            n = max(1, int((b - a).length / step))
            dense += [a.lerp(b, k / n) for k in range(n)]
        pts = dense + [pts[-1]]
    out = []
    for p in pts:
        loc, nrm = cast_side(target, p.x, p.z, sy)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 2:
        if closed:
            B.closed_tube(mb, out, r, mat, n=8)
        else:
            mb.tube(out, r, mat, n=8)


def oval_patch(mb, target, p, n, fwd, a, b, mat, h0=0.002, h1=0.006, taper=0.55, k=24):
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    fwd = (fwd - n * fwd.dot(n)).normalized()
    up = n.cross(fwd).normalized()
    ring, ring2 = [], []
    for i in range(k):
        t = TAU * i / k
        for rr, out, hh in ((1.0, ring, h0), (taper, ring2, h1)):
            q = Vector(p) + fwd * (math.cos(t) * a * rr) + up * (math.sin(t) * b * rr) + n * 0.3
            ok, loc, _nn, _i = target.ray_cast(q, -n, distance=0.8)
            out.append((loc if ok else Vector(p)) + n * hh)
    ctr = sum(ring2, Vector()) / len(ring2)
    mb.loft([ring, ring2, [ctr]], mat, closed=True)


def fin_decal(target, text, cx, cz, size, mat, y0=0.3):
    """E.build_registration with the rays starting at |y| = y0 (between the winglets and the fin), so the
    text lands on the central fin and not on the winglet outside it."""
    obs = []
    for side in (1, -1):
        cu = bpy.data.curves.new('dec_txt', 'FONT')
        cu.body = text
        cu.size = size
        cu.align_x = 'CENTER'
        cu.align_y = 'CENTER'
        tob = bpy.data.objects.new('dec_tmp', cu)
        bpy.context.scene.collection.objects.link(tob)
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(tob.evaluated_get(dg))
        bpy.data.objects.remove(tob)
        bpy.data.curves.remove(cu)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        for v in bm.verts:
            tx, ty = v.co.x, v.co.y
            wx, wz = (cx - tx, cz + ty) if side > 0 else (cx + tx, cz + ty)
            hit, loc, nrm, _ = target.ray_cast(V(wx, side * y0, wz), V(0, -side, 0))
            v.co = loc + nrm.normalized() * 0.0018 if hit else V(wx, side * 0.05, wz)
        bm.normal_update()
        for f in bm.faces:
            if f.normal.y * side < 0:
                f.normal_flip()
            f.smooth = False
        me2 = bpy.data.meshes.new('decal_' + ('L' if side > 0 else 'R'))
        bm.to_mesh(me2)
        bm.free()
        bpy.data.meshes.remove(me)
        me2.materials.append(MATS[mat])
        ob = bpy.data.objects.new(me2.name, me2)
        K.link(ob)
        obs.append(ob)
    return obs


def where(a_names, b_objs, label=''):
    """Like K.clearance, but prints where (hub frame) the crew crosses each object."""
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()

    def tree(o):
        bm = bmesh.new()
        bm.from_object(o, dg)
        bm.transform(o.matrix_world)
        bm.faces.ensure_lookup_table()
        cs = [f.calc_center_median() for f in bm.faces]
        t = BVHTree.FromBMesh(bm)
        bm.free()
        return t, cs
    bt = [(o.name, tree(o)) for o in b_objs if o is not None]
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or not any(o.name.startswith(n) for n in a_names):
            continue
        ta, ca = tree(o)
        for bn, (tb, cb) in bt:
            hits = ta.overlap(tb)
            if hits:
                ps = [ca[i] for i, _ in hits]
                lo = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
                hi = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
                print('  ?? %s%s x %s: %d  X %.2f..%.2f  y %.2f..%.2f  Z %.2f..%.2f' % (
                    o.name, label, bn, len(hits), lo.x - R.dx, hi.x - R.dx, lo.y, hi.y, lo.z - R.dz, hi.z - R.dz))


def build_hull():
    us = [0.02 * k for k in range(1, 40)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.04:
        x -= 0.035
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    rings.append(hull_ring(X_END - 0.012, scale=0.88))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60)
    K.recess_rear(pod, R.x(X_END - 0.012), depth=0.10, inset=0.03, mat='Engine_Dark')
    return pod


def build_hull_lines(pod):
    """Painted / moulded details on the closed hull before the canopy is cut out: windscreen frame
    band, cowl panel lines, louvres, oval air exit, landing light, fuel filler, static vents."""
    mb = MB('hull_lines')
    for sy in (1, -1):
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: cowl panel lines removed)
        # four big slanted louvres with black mesh (top end aft), upper middle of the cowl side
        for i in range(4):
            X = -0.36 - 0.075 * i
            Z = -1.33 + 0.01 * i
            y = hull_y(X, Z)
            n = V(0, sy, 0.25)
            d = V(-0.34, 0, 0.94)
            ln = 0.12 - 0.007 * i
            oval_patch(mb, pod, R(X, Z, sy * y), n, d, ln + 0.008, 0.026, 'Paint_White', h0=0.0, h1=0.004, taper=0.92)
            oval_patch(mb, pod, R(X, Z, sy * y), n, d, ln, 0.017, 'Louvre_Mesh', h0=0.0045, h1=0.0045, taper=0.9)
        # lower row of small gills and the oval air exit behind it
        for i in range(4):
            xc = -0.44 - 0.06 * i
            zc = -1.66 + 0.035 * i
            loc, nrm = cast_side(pod, R.x(xc), R.z(zc), sy)
            if loc is None:
                continue
            K.louvres(mb, pod, loc, V(0, sy, 0), V(-0.45, 0, 0.9).normalized(), count=1, length=0.085, depth=0.005,
                      mat='Radiator', body_mat='Paint_White')
        X, Z = -0.70, -1.60
        y = hull_y(X, Z)
        oval_patch(mb, pod, R(X, Z, sy * y), V(0, sy, -0.25), V(-1, 0, 0.42), 0.10, 0.042, 'Radiator',
                   h0=0.0015, h1=0.003, taper=0.8)
        # bulge over the turbo / air box ahead of the gills
        oval_patch(mb, pod, R(-0.30, -1.70, sy * hull_y(-0.30, -1.70)), V(0, sy, -0.1), V(1, 0, 0.1), 0.07, 0.035,
                   'Paint_White', h0=0.0, h1=0.018, taper=0.7)
        # door vents are on the glass (see build_canopy_details); fuel filler cap on the right only
    loc, nrm = cast_side(pod, R.x(-0.10), R.z(-1.42), -1)
    if loc is not None:
        mb.lathe([(0.0, 0.010), (0.030, 0.010), (0.037, 0.006), (0.040, 0.0), (0.040, -0.004)], loc, nrm, 'Chrome', n=24)
    # round landing light under the nose (left of the centreline, front photo)
    p = R(2.12, -2.105, 0.07)
    oval_patch(mb, pod, p, V(0.8, 0.25, -0.55), V(0, 1, 0), 0.032, 0.032, 'Chrome', h0=0.001, h1=0.004, taper=0.85)
    oval_patch(mb, pod, p + V(0.004, 0, 0), V(0.8, 0.25, -0.55), V(0, 1, 0), 0.025, 0.025, 'Lens_White', h0=0.004,
               h1=0.010, taper=0.6)
    return mb.finish(sharp_angle=50)


def split_canopy(pod):
    poly = R.pts(tvs(P_GLASS))
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    K.bisect_poly(bm, poly)
    bm.to_mesh(pod.data)
    bm.free()
    return K.split_glass(pod, lambda c: PANEL.inside(poly, c.x, c.z), frame_r=0.009, frame_mat='Paint_Dark',
                         seal=False, thickness=0.012, name='canopy')


def build_canopy_details(canopy):
    """Black door frames (front bar, sill, rear edge), roof spine with the two hinges and gas struts
    inside, two round adjustable vents in each door, door latch handle."""
    mb = MB('canopy_frames')
    door_front = tvs(P_DOOR)
    for sy in (1, -1):
        # slanted front bar between the fixed windscreen and the door (wide, black)
        side_line(mb, canopy, door_front, sy, r=0.014, mat='Paint_Dark', lift=0.004, step=0.015)
        # inner window line of the door: sill parallel to the lower edge, rear edge
        sill = [tv(1432, 810), (tv(1400, 809.5)), tv(1370, 805.5), tv(1340, 799.5), tv(1310, 790.5),
                tv(1287, 779), tv(1270, 765), tv(1257, 750), tv(1248, 733), tv(1244, 711), tv(1245, 688)]
        side_line(mb, canopy, sill, sy, r=0.010, mat='Paint_Dark', lift=0.004, step=0.015)
        # door top edge along the hinge (a little below the roof spine)
        top = [tv(1352, 694), tv(1320, 686), tv(1290, 681), tv(1260, 678.5), tv(1245, 679)]
        mb_tmp = []
        for X, Z in top:
            mb_tmp.append((X, Z))
        side_line(mb, canopy, mb_tmp, sy, r=0.008, mat='Paint_Dark', lift=0.004, step=0.015)
        # two round vents (80 mm) in each door window
        for (x, y) in ((1300, 742), (1336, 752)):
            X, Z = tv(x, y)
            loc, nrm = cast_side(canopy, R.x(X), R.z(Z), sy)
            if loc is not None:
                mb.lathe([(0.030, 0.0), (0.040, 0.0), (0.040, 0.004), (0.030, 0.006), (0.0, 0.006)], loc, nrm,
                         'Paint_Dark', n=20)
                mb.cyl(loc + nrm * 0.004, loc + nrm * 0.008, 0.008, 'Alu_Black', n=10)
        # latch handle at the rear lower corner of the door
        X, Z = tv(1268, 776)
        loc, nrm = cast_side(canopy, R.x(X), R.z(Z), sy)
        if loc is not None:
            mb.box(loc + nrm * 0.008, (0.09, 0.016, 0.02), 'Paint_Dark', bevel=0.006, segs=2,
                   rot=Euler((0, math.radians(-30), 0)))
    # roof spine: black strip over the canopy centreline with the two door hinges
    sp = []
    for x in range(SPINE_X[0], SPINE_X[1] - 1, -6):
        X = (x - 1240.0) / S_TV
        zt = hull(X)[0]
        sp.append(R(X, zt + 0.006))
    mb.tube(sp, 0.0, 'Paint_Dark', n=12, square=(0.075, 0.016, 4))
    for X in (0.30, 0.85):
        zt = hull(X)[0]
        mb.box(R(X, zt + 0.016), (0.10, 0.09, 0.022), 'Metal_Frame', bevel=0.006, segs=2)
        mb.cyl(R(X - 0.05, zt + 0.02, 0.05), R(X + 0.05, zt + 0.02, 0.05), 0.008, 'Chrome', n=10)
        mb.cyl(R(X - 0.05, zt + 0.02, -0.05), R(X + 0.05, zt + 0.02, -0.05), 0.008, 'Chrome', n=10)
    # gas struts of the doors (inside, along the roof)
    for sy in (1, -1):
        mb.cyl(R(0.20, -1.03, sy * 0.10), R(0.70, -1.14, sy * 0.13), 0.009, 'Alu_Black', n=8)
    return mb.finish(sharp_angle=45)


# ---- mast: two parallel steel tubes from the cowl top to the head ----------------------------------
MAST_X = -0.14
MAST_Y = 0.062


def build_mast():
    mb = MB('mast')
    zt = hull(MAST_X)[0]
    for sy in (1, -1):
        mb.tube([R(MAST_X - 0.01, zt - 0.25, sy * MAST_Y), R(MAST_X, -0.27, sy * MAST_Y)], 0.0, 'Paint_White', n=16,
                square=(0.05, 0.04, 3))
        # cheek plates on the pitch pivot
        mb.box(R(-0.07, -0.23, sy * 0.050), (0.17, 0.010, 0.13), 'Metal_Frame', bevel=0.012, segs=2)
        mb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.064, 0), 0.016, 'Engine', n=12)
    # middle plates (the mast folds back here for transport) and a top bridge
    for Z, h in ((-0.62, 0.11), (-0.30, 0.06)):
        for sy in (1, -1):
            mb.box(R(MAST_X, Z, sy * (MAST_Y + 0.028)), (0.085, 0.006, h), 'Metal_Frame', bevel=0.002, segs=1)
        for k in range(3):
            zz = Z + (k - 1) * h * 0.32
            mb.cyl(R(MAST_X, zz, MAST_Y + 0.034), R(MAST_X, zz, -MAST_Y - 0.034), 0.006, 'Chrome', n=8)
    mb.box(R(MAST_X, -0.275), (0.07, 2 * MAST_Y + 0.05, 0.03), 'Metal_Frame', bevel=0.006, segs=2)
    # base fairing round both tubes where they leave the cowl
    rings = []
    for k, Z in enumerate((zt - 0.02, zt + 0.03, zt + 0.08)):
        hw, hx = 0.11 - 0.025 * k, 0.09 - 0.02 * k
        rings.append([R(MAST_X + hx * math.cos(TAU * i / 24), Z, hw * math.sin(TAU * i / 24)) for i in range(24)])
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    # control push rods behind the mast (pitch / roll) up to the head arm
    for sy in (1, -1):
        lo = R(MAST_X - 0.11, zt + 0.02, sy * 0.10)
        hi = PIVOT + V(-0.20, sy * 0.10, 0.022)
        mb.cyl(lo, hi, 0.0075, 'Chrome', n=10)
        mb.cyl(hi, hi + V(0, 0, 0.03), 0.011, 'Alu_Black', n=8)
        mb.box(lo + V(0.0, 0, -0.01), (0.06, 0.012, 0.05), 'Metal_Frame', bevel=0.004, segs=1)
    # pre-rotator flexible shaft (black) curving up in front of the tubes to the Bendix, pneumatic hose
    fs = catmull([R(MAST_X - 0.10, zt + 0.02, 0.0), R(MAST_X - 0.14, zt + 0.30, 0.02), R(-0.21, -0.55, 0.02),
                  R(-0.16, -0.36, 0.0), R(-0.137, -0.27, 0.0)], 5)
    mb.tube(fs, 0.012, 'Rubber', n=10)
    # trim / brake cylinder behind the head
    mb.cyl(R(-0.20, -0.30, 0.0), R(-0.17, -0.19, 0.0), 0.014, 'Alu_Black', n=12)
    return mb.finish(sharp_angle=40, wn=True)


# ---- boom, strut, gear ----------------------------------------------------------------------------
BOOM = [(-0.02, -2.215), (-0.50, -2.245), (-1.04, -2.270), (-1.62, -2.115), (-2.27, -1.960)]


def build_frame():
    mb = MB('frame')
    pts = [R(X, Z) for X, Z in BOOM]
    mb.tube(catmull(pts[:3], 4) + catmull(pts[2:], 4)[1:], 0.03, 'Keel_Alu', n=18)
    # diagonal strut from the kink up to the engine mount under the cowl
    mb.cyl(R(-1.00, -2.255), R(-0.47, -1.905), 0.018, 'Keel_Alu', n=12)
    mb.box(R(-1.04, -2.27), (0.12, 0.07, 0.07), 'Keel_Alu', bevel=0.012, segs=2, rot=K.rot_y(-8))
    # tail tie-down ring, cable guides
    mb.cyl(R(-1.98, -2.08, -0.02), R(-1.98, -2.08, 0.02), 0.018, 'Metal_Frame', n=10)
    # exhaust: down-pipe and muffler under the cowl, tail pipe aft (left side)
    mb.tube(catmull([R(-0.50, -1.70, 0.13), R(-0.55, -1.80, 0.14), R(-0.62, -1.83, 0.12)], 4), 0.02, 'Steel_Exhaust',
            n=10)
    mb.lathe([(0.0, -0.12), (0.05, -0.11), (0.06, -0.07), (0.06, 0.07), (0.05, 0.11), (0.0, 0.12)],
             R(-0.72, -1.80, 0.08), V(1, 0, 0.35), 'Steel_Exhaust', n=18)
    mb.tube(catmull([R(-0.83, -1.75, 0.08), R(-0.90, -1.70, 0.10), R(-0.95, -1.66, 0.11)], 4), 0.018,
            'Steel_Exhaust', n=10)
    # radiator under the gearbox with its hoses, oil cooler
    rc = R(-0.60, -1.76, -0.06)
    mb.box(rc, (0.20, 0.22, 0.05), 'Radiator', bevel=0.006, segs=1, rot=K.rot_y(-25))
    # gearbox nose and prop flange extension in the cowl opening
    mb.cyl(R(X_END + 0.06, -1.312), PROP + V(0.06, 0, 0), 0.085, 'Engine', n=24)
    mb.cyl(PROP + V(0.06, 0, 0), PROP + V(0.035, 0, 0), 0.06, 'Engine_Dark', n=20)
    return mb.finish(sharp_angle=40, wn=True)


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # long cantilever aluminium leg in its fairing ("pantalon"): out of the lower hull side, down to the spat
        pts = [R(-0.20, -2.08, sy * 0.30), R(-0.215, -2.12, sy * 0.42), R(-0.24, -2.19, sy * 0.58),
               R(-0.265, -2.255, sy * 0.72), R(-0.275, -2.28, sy * (MAIN_Y - 0.03))]
        mb.tube(catmull(pts, 5), 0.0, 'Paint_White', n=20, square=(0.25, 0.042, 3.2), cap=True)
        # stub axle, brake disc and calliper
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.06), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.075), ax.z), V(ax.x, sy * (MAIN_Y - 0.067), ax.z), 0.085, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.07, sy * (MAIN_Y - 0.07), ax.z + 0.035), (0.05, 0.03, 0.05), 'Alu_Gold', bevel=0.008, segs=1)
        mb.tube([V(ax.x + 0.02, sy * (MAIN_Y - 0.07), ax.z + 0.06), R(-0.26, -2.25, sy * (MAIN_Y - 0.06))], 0.004,
                'Rubber', n=6)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        # side view: 0.33 m ahead / 0.49 m behind the axle, top level with the tyre top, tail raised
        spats.append(K.spat(name, c, R=WR, front=0.33, back=0.49, hw=0.125, top=0.012, lift=0.07,
                            mat='Paint_White', tail_up=0.085, belly=0.5))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=WR, w=0.11)
    nc = R(NOSE[0], NOSE[1])
    zb = hull(NOSE[0])[1]
    nose = K.nose_gear(nc, R=NWR, w=0.09, leg_top=R.z(zb + 0.05), rake=-0.03)
    return gear, spats, nose


# ---- tail (hub frame) ------------------------------------------------------------------------------
STAB = dict(le0=-1.62, te0=-2.18, z0=-2.085, zt0=-2.04, le1=-2.00, te1=-2.44, z1=-1.945, zt1=-1.80, span=0.845)
HINGE = -2.25
FIN_TOP = -1.12
WL_TOP = -1.21


def fin_le(z):
    Z = z - R.dz
    t = (Z + 2.08) / (FIN_TOP + 2.08)
    x = lerp(-1.60, -2.00, t)
    x -= 0.06 * max(0.0, (t - 0.92) / 0.08) ** 2
    return R.x(x)


def fin_te(z):
    Z = z - R.dz
    if Z < -1.73:
        # rising bottom edge (on the drawing a straight line from the boom to the winglet foot)
        x = lerp(-2.21, -2.68, max(0.0, (Z + 2.06) / 0.33))
    else:
        x = lerp(-2.68, -2.56, (Z + 1.73) / (FIN_TOP + 1.73))
    t = (Z + 2.08) / (FIN_TOP + 2.08)
    x += 0.05 * max(0.0, (t - 0.93) / 0.07) ** 2
    return R.x(x)


def wl_le(z):
    Z = z - R.dz
    t = (Z + 1.96) / (WL_TOP + 1.96)
    x = lerp(-2.00, -2.05, t) - 0.07 * max(0.0, (t - 0.9) / 0.1) ** 2 + 0.02 * max(0.0, (0.05 - t) / 0.05)
    return R.x(x)


def wl_te(z):
    Z = z - R.dz
    if Z < -1.68:
        # bottom edge on the side-view line from the stab tip LE to the rear corner
        x = lerp(-2.00, -2.79, max(0.0, (Z + 1.948) / 0.268))
    else:
        x = lerp(-2.79, -2.70, (Z + 1.68) / (WL_TOP + 1.68))
    t = (Z + 1.96) / (WL_TOP + 1.96)
    x += 0.05 * max(0.0, (t - 0.92) / 0.08) ** 2
    return R.x(x)


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.10, te_min=0.002)
    S = STAB
    rings = []
    ys = [-S['span'], -0.80, -0.65, -0.45, -0.25, -0.08, 0.0, 0.08, 0.25, 0.45, 0.65, 0.80, S['span']]
    for y in ys:
        u = abs(y) / S['span']
        le, te = lerp(S['le0'], S['le1'], u), lerp(S['te0'], S['te1'], u)
        zl, zt = lerp(S['z0'], S['z1'], u), lerp(S['zt0'], S['zt1'], u)
        ch = le - te
        rings.append([R(le - s * ch, lerp(zl, zt, s) + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # winglets on the tips (outer face flat-ish: thin symmetric section)
    zs = [-1.942, -1.93, -1.90, -1.85, -1.75, -1.68, -1.55, -1.40, -1.30, -1.25, -1.23, WL_TOP]
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], wl_le, wl_te, y_fn=lambda z, sy=sy: sy * S['span'], t=0.08)
    # central fin: fixed part ahead of the rudder hinge
    zs = [-2.08, -2.04, -1.95, -1.85, -1.73, -1.60, -1.45, -1.30, -1.20, -1.16, -1.135, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, fin_te, t=0.09,
               s_end_fn=lambda z: min(1.0, (fin_le(z) - R.x(HINGE)) / (fin_le(z) - fin_te(z))))
    # saddle on the boom end, rudder post foot
    mb.box(R(-1.95, -2.06), (0.50, 0.08, 0.03), 'Paint_White', bevel=0.01, segs=2, rot=K.rot_y(-14))
    return mb.finish(sharp_angle=45)


def build_rudder():
    zs = [-1.87, -1.80, -1.73, -1.60, -1.45, -1.30, -1.20, -1.16, -1.135, FIN_TOP - 0.003]
    origin = R(HINGE, -1.50)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], fin_le, fin_te, R.x(HINGE), origin, t=0.09,
                                 mat='Paint_White')
    return rud


# ---- cockpit ----------------------------------------------------------------------------------------
def build_cockpit():
    mb = MB('cockpit')
    # front seat: white moulded shell with black cushions (cabin photo), no headrest
    E.bucket_seat(mb, FRONT_HIP + V(-0.045, 0, -0.02), FRONT_BACK, width=0.40, headrest=False, base=False)
    mb.box(R(0.95, -2.215), (0.34, 0.26, 0.06), 'Interior', bevel=0.02, segs=1)
    # rear seat: grey cushions on the 70 l tank, backrest against the firewall
    E.bucket_seat(mb, REAR_HIP + V(-0.045, 0, -0.02), REAR_BACK, width=0.46, headrest=True, base=False)
    mb.box(R(0.20, -2.09), (0.40, 0.44, 0.13), 'Interior', bevel=0.03, segs=2)
    # floor, firewall
    mb.box(R(1.05, -2.215), (1.30, 0.24, 0.012), 'Interior', bevel=0.0)
    ring = hull_ring(-0.09, n_half=20, scale=0.975)
    mb.loft([ring, [p + V(-0.02, 0, 0) for p in ring]], 'Interior', closed=True, cap0=True, cap1=True)
    # passenger foot rests either side of the front seat
    for sy in (1, -1):
        mb.box(R(0.75, -2.165, sy * 0.27), (0.20, 0.10, 0.012), 'Metal_Frame', bevel=0.003, segs=1, rot=K.rot_y(-12))
    return mb.finish(sharp_angle=40, wn=True)


def build_jro():
    if 'Keel_Alu' not in MATS:
        B.make_mat('Keel_Alu', B.srgb('#BFC3C7'), metal=0.9, rough=0.30)
    if 'Louvre_Mesh' not in MATS:
        B.make_mat('Louvre_Mesh', B.srgb('#0B0B0C'), metal=0.6, rough=0.55)
    if 'Prop_Orange' not in MATS:
        B.make_mat('Prop_Orange', B.srgb('#E8820E'), metal=0.4, rough=0.35)
    pod = build_hull()
    lines = build_hull_lines(pod)
    canopy, cframe, _ = split_canopy(pod)
    frames = build_canopy_details(canopy)
    mast = build_mast()
    frame = build_frame()
    K.build_head(PIVOT, HUB, arm=-0.20, arm_w=0.20, plate_mat='Alu_Black')
    K.build_rotor(HUB, R=4.30, chord=0.216, root=0.50, tip_mat='Rotor_Blade', clamp_len=0.48, tip_len=0.10)
    prop = K.build_prop(PROP, R=PROP_R, blades=3, hub='flange', hub_r=0.10, tip_mat='Carbon', chord_k=1.05,
                        pitch=1.2)
    # DUC hub: orange flange plate with its bolts, black hub body, orange root collars
    ph = MB('prop_hub')
    ph.lathe([(0.0, 0.035), (0.10, 0.035), (0.112, 0.028), (0.112, 0.014), (0.10, 0.008), (0.0, 0.008)], PROP,
             V(1, 0, 0), 'Prop_Orange', n=36)
    ph.lathe([(0.0, 0.008), (0.075, 0.008), (0.082, -0.06), (0.06, -0.085), (0.0, -0.085)], PROP, V(1, 0, 0),
             'Carbon', n=28)
    for k in range(6):
        a = TAU * k / 6 + 0.3
        p = PROP + V(0.036, math.cos(a) * 0.088, math.sin(a) * 0.088)
        ph.cyl(p, p + V(0.012, 0, 0), 0.009, 'Metal_Frame', n=6)
    hub_ob = ph.finish(sharp_angle=40)
    hub_ob.location = Vector((0, 0, 0))
    prop = B.join_objects('prop', [prop, hub_ob])
    # orange root sleeves of the DUC blades
    names = [m.name for m in prop.data.materials]
    ci, oi = names.index('Carbon'), names.index('Prop_Orange')
    for pl in prop.data.polygons:
        c = pl.center
        if pl.material_index == ci and 0.118 < math.hypot(c.y, c.z) < 0.175 and abs(c.x) < 0.07:
            pl.material_index = oi
    tail = build_tail()
    rud = build_rudder()
    gear, spats, nose = build_gear()
    cockpit = build_cockpit()

    # ---- controls and crew: pilot in front, passenger behind
    ctrl = MB('controls_static')
    stick_base = R(1.20, -2.245)
    stick, grip, axis = controls.gyro_stick(stick_base, R(1.10, -1.79))
    knob, lever = controls.throttle_lever(ctrl, R(1.06, -1.95, 0.28))
    pilot.build_pilot('pilot_front', FRONT_HIP, FRONT_BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.62, -2.10, 0.14), 'R': R(1.62, -2.10, -0.14)}, knee_out=0.03, elbow_out=0.10,
                      rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.245))
    # rear (dual) stick in front of the passenger, static
    stick_r, grip_r, axis_r = controls.gyro_stick(R(0.64, -2.20), R(0.55, -1.82), name='stick_rear')
    p0 = R(1.52, -1.64)
    PANEL.build_panel(ctrl, p0, 24.0, [pod, canopy], zone=(0.0, 0.05, 0.38, 0.14), cw=0.055, v_leg=-0.05,
                      v_sb=-0.16, v_b=-0.40, top_arch=(0.36, 0.10, 0.17), max_u=0.37, leg_exp=0.3)
    # glare shield hood over the panel
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', REAR_HIP, REAR_BACK,
                      hands={'R': ('rest', REAR_HIP + V(0.26, -0.15, 0.12), None), 'L': ('rest', REAR_HIP + V(0.26, 0.15, 0.12), None)},
                      feet={'L': R(0.75, -2.10, 0.27), 'R': R(0.75, -2.10, -0.27)}, knee_out=0.14, elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    # ---- details
    det = MB('details')
    K.pitot(det, R(XTIP - 0.01, ZTIP), (1, 0, -0.05), length=0.08)
    # the only exterior light the photos show is the round landing lamp under the nose, left of the
    # centreline (front_gullwing_doors_open_white.jpg; dark recess also on Z-DTA and 74-AGH); no nav,
    # strobe or tail lights on the winglets, fin or boom in any photo (WDTA01, 9N-AMR, 77-BQZ, 26AEF)
    K.lamp_node('landing', R(2.12, -2.105, 0.07) + V(0.8, 0.25, -0.55).normalized() * 0.028)
    # MINIMUM SET, NOT ON THE PHOTOS (nav lights are a factory option): nav + strobe on the outer face of
    # each winglet, near its top front corner. The owner asked for at least landing + nav + one
    # anti-collision light on every aircraft, so that it can be flown and seen at night in the sim.
    for sy, kind in ((1, 'red'), (-1, 'green')):
        K.lamp(det, R(-2.12, -1.30, sy * (STAB['span'] + 0.014)), V(0, sy, 0), kind=kind, r=0.018, length=0.022)
        K.lamp(det, R(-2.20, -1.30, sy * (STAB['span'] + 0.014)), V(0, sy, 0), kind='white', r=0.015, length=0.02)
        K.lamp_node('navL' if sy > 0 else 'navR', R(-2.12, -1.30, sy * (STAB['span'] + 0.045)))
        K.lamp_node('strobeL' if sy > 0 else 'strobeR', R(-2.20, -1.30, sy * (STAB['span'] + 0.045)))
    K.antenna(det, R(-0.45, -1.05, 0.0), (-0.3, 0, 1), length=0.30)
    K.antenna(det, R(0.30, -2.29), (-0.25, 0, -1), length=0.18)
    det = det.finish(sharp_angle=50)
    # J-RO script ahead of the louvres, DTA logo on the fin, registration on the winglets
    script = K.decal_text(pod, 'J-RO', R.x(-0.19), R.z(-1.36), size=0.07, mat='Decal_White')
    dta = fin_decal(tail, 'DTA', cx=R.x(-2.07), cz=R.z(-1.42), size=0.075, mat='Decal_White')
    regs = E.build_registration(tail, REG, cx=R.x(-2.40), cz=R.z(-1.52), size=0.10, mat='Decal_Black')

    b = math.radians(FRONT_BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = FRONT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    if '--where' in K.ARGV:
        where(['pilot_'], [bpy.data.objects.get('panel_face'), ctrl, pod, canopy, cockpit, stick_r])
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, canopy, cockpit], ' (pilot)')
    K.clearance(['pilot_rear'], [pod, canopy, cockpit, stick_r], ' (passenger)')
    if '--xray' in K.ARGV:                       # debug: cut the shell away to check the crew
        for o in (pod, lines, cframe, frames, canopy):
            bpy.data.objects.remove(o)
        pod = lines = cframe = frames = None
        canopy = MB('canopy').finish()
    K.finalize([pod, lines, cframe, frames, mast, frame, tail, gear, cockpit, ctrl, det, stick_r] + spats + script
               + dta + regs, [canopy])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.50), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })

    def g(p):       # Blender (x, y, z) -> sim (x forward, y up, z right)
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('JRO hub %s pivot %s prop %s eye %s' % (g(HUB), g(PIVOT), g(PROP), g(eye)))
    print('JRO ground y %.3f  main axle %s  nose axle %s  stick %s' % (
        R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)), g(R(NOSE[0], NOSE[1])), g(stick_base)))
    print('JRO nose tip %s  fin top %s  winglet top TE %s  boom end %s  belly %s' % (
        g(R(XTIP, ZTIP)), g(R(-2.30, FIN_TOP)), g(R(-2.70, WL_TOP, STAB['span'])), g(R(-2.27, -1.96)),
        g(R(1.0, hull(1.0)[1]))))


VIEWS = {
    'ref_aef': dict(extra=True, loc=(-4.5, 12.0, 0.6), target=(-0.3, 0.0, 0.2), lens=60, rotor=-15, prop=20),
    'ref_front': dict(extra=True, loc=(10.0, 0.0, 0.35), target=(0.0, 0.0, 0.35), ortho=4.2, rotor=90, prop=0),
    'ref_top': dict(extra=True, loc=(0.0, 0.0, 30.0), target=(0.0, 0.0, 0.0), ortho=6.0, rotor=90, prop=0),
    'ref_wdta': dict(extra=True, loc=(5.0, -5.6, 0.9), target=(-0.2, 0.0, 0.2), lens=38, rotor=-40, prop=20),
    'ref_red': dict(extra=True, loc=(6.0, 6.0, 7.5), target=(-0.3, 0.0, 0.2), lens=45, rotor=-30, prop=20),
    'ref_tail': dict(extra=True, loc=(-6.0, -4.6, 0.6), target=(-1.6, 0.0, 0.0), lens=50, rotor=-30, prop=20),
    'lamp_nose': dict(extra=True, loc=(4.4, 2.0, -0.75), target=(1.75, 0.0, -0.40), lens=55,
                      rotor=-30, prop=20),
    'cab_side': dict(extra=True, loc=(0.6, 12.0, -0.1), target=(0.6, 0.0, -0.1), ortho=2.6, rotor=75, prop=0),
    'pilot_eye': dict(extra=True, loc=(0.52, -0.02, 0.26), target=(1.6, 0.0, -0.20), lens=16, rotor=75, prop=0),
}

if __name__ == '__main__':
    K.run('jro', build_jro, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
