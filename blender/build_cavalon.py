"""
AutoGyro Cavalon (Hildesheim, 2011-) for the Autogiro web sim: enclosed side-by-side gyroplane. Wide
egg-shaped monocoque cabin (flat duck-bill nose with an almond landing light each side, one-piece
bubble canopy: windscreen/roof strip + a framed window door each side), slim faired mast growing out
of the roof and sweeping back into the engine hood, fully cowled Rotax 914 with a forward-facing
oil-cooler scoop each side of the hood and slanted gills below it, HTC three-blader with spinner,
keel tube leaving a boot under the cowl, bending up to a swept tailplane with two end fins and a
central fin + rudder, composite bow gear with big spats, spatted nose wheel.

Traced on the factory three-view of the POH (912/914 rev 3.1; native raster 969 px wide, 113.7 px/m
from the dimensioned 4730 mm, widths from its top and front views), details from Wikimedia Commons
photos (G-OSVN, D-MGHO, G-YFLI, RA-0 orange). Hub frame as in gyrokit.py; `tv()` converts the pixels
of the three-view side image. Centre of gravity: sim convention 0.33 m ahead of the hub, height from
the UK CAA data sheet BG06 (0.745-0.940 m above the main axle -> 0.84).

SEATING: the pilot in command sits in the RIGHT seat (y = -SEAT_Y in Blender, +z in the sim):
pilot_front, stick, throttle (centre console, his left hand), pedals, eye_front and the live zone of
the panel belong to that seat; pilot_rear is the person in the LEFT seat, with a static second stick.

  blender -b -P blender/build_cavalon.py -- [--previews] [--only VIEW,...] [--overlay yaw,cx,cz,ppm,w,h,side]
Outputs: public/models/cavalon.glb, blender/cavalon.blend, blender/previews/cavalon/*.png
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Euler, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import gyrokit as K  # noqa: E402
from gyrokit import B, E, V, MB, MATS, TAU, lerp, catmull, airfoil_ring, pilot, controls, PANEL  # noqa: E402

# ---- three-view (native side image, hub at px 484, 48) -> hub frame -----------------------------
S_TV = 113.7


def tv(x, y):
    return ((484.0 - x) / S_TV, (48.0 - y) / S_TV)


def tvs(pts):
    return [tv(x, y) for x, y in pts]


# ---- hub frame -----------------------------------------------------------------------------------
GROUND = -2.705                         # 2.77 m overall height, teeter tower top 0.065 above the bolt
AXLE = (-0.44, GROUND + 0.205)          # main axle (4.00-8 tyres, 0.41 m)
CG = (0.33, AXLE[1] + 0.84)             # sim convention in x; height: middle of the BG06 range
R = K.Ref(CG)
HUB = R(0.0, 0.0)
PIVOT = R(-0.005, -0.21)
PROP = R(-1.02, -1.355)
MAIN_Y = 0.775                          # track 1.55 m (front view)
NOSE = (1.571, GROUND + 0.15)           # nose wheel 400-4
SEAT_Y = 0.28                           # lateral seat offset: pilot at y = -SEAT_Y (right), passenger +SEAT_Y

LIVERY = dict(body=('#D25E1B', 0.35, 0.24), accent=('#C4C8CC', 0.85, 0.26), dark=('#1D1F22', 0.3, 0.30))
REG = 'EC-GV5'

# ---- hull: side outline (three-view px), plan half-width and belt (max width) height ------------
XTIP, ZTIP = tv(264.4, 293.8)
X_END = -0.944
TOP_PX = [(264.4, 293.8), (266.9, 285), (271.3, 276.3), (277.5, 267.5), (285, 258.8), (292.5, 251.9), (300, 246.3),
          (305, 243.5), (313.8, 236), (322.5, 229), (332.5, 221.5), (342.5, 215), (352.5, 209.3), (362.5, 204),
          (372.5, 199.3), (385, 193.5), (400, 187.5), (415, 182.3), (430, 177.8), (445, 174.3), (457, 172.5),
          (470, 170.3), (483.4, 168.7), (515, 168.5), (540, 172.5), (558.4, 179.5), (571.6, 186), (585, 190.5),
          (591.3, 191.5)]
BOT_PX = [(264.4, 293.8), (265.6, 297.5), (268.8, 300.6), (275, 303.8), (283.8, 306.9), (295, 309.4), (307.5, 311.9),
          (325, 313.5), (342.5, 314.8), (367.5, 315.4), (391.4, 315.2), (427.7, 314.1), (450.5, 312.5), (480, 310.5),
          (510, 308.5), (527, 306), (538, 300), (545.5, 290), (549.5, 280), (552.5, 269), (556.5, 259.5),
          (564, 250.3), (577, 238.4), (587, 224), (591.3, 214.5)]
W_TAB = [(XTIP, 0.0), (1.913, 0.130), (1.875, 0.221), (1.82, 0.299), (1.755, 0.358), (1.667, 0.414), (1.557, 0.462),
         (1.425, 0.505), (1.315, 0.537), (1.161, 0.570), (0.985, 0.602), (0.809, 0.620), (0.633, 0.630),
         (0.457, 0.630), (0.281, 0.624), (0.15, 0.617), (0.062, 0.607), (-0.07, 0.576), (-0.246, 0.527),
         (-0.378, 0.49), (-0.536, 0.416), (-0.668, 0.345), (-0.80, 0.255), (-0.90, 0.165), (X_END, 0.115)]
BELT_TAB = [(XTIP, ZTIP), (1.84, -2.110), (1.60, -2.070), (1.30, -2.020), (0.90, -1.970), (0.40, -1.950),
            (0.00, -1.950), (-0.30, -1.930), (-0.50, -1.800), (-0.65, -1.580), (-0.80, -1.430), (X_END, -1.360)]


def _u(X):
    return math.sqrt(max(0.0, XTIP - X))


def _prof(pairs):
    return B.hermite([_u(X) for X, _ in pairs], [z for _, z in pairs])


F_T, F_B, F_W, F_M = _prof(tvs(TOP_PX)), _prof(tvs(BOT_PX)), _prof(W_TAB), _prof(BELT_TAB)
# section exponents: full shoulders and a broad flat-ish belly in the front view of the three-view
F_NT = B.hermite([X_END, -0.45, -0.1, 0.3, 1.0, 1.6, XTIP], [2.2, 2.4, 2.9, 3.1, 3.0, 2.4, 2.0])
F_NB = B.hermite([X_END, -0.6, -0.3, 1.0, 1.6, XTIP], [2.2, 2.8, 3.0, 3.2, 2.6, 2.0])


def hull(X):
    """Section parameters at hub X: (top, bottom, half-width, belt z, upper exponent, lower exponent)."""
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


def hull_ring(X, n_half=28, scale=1.0):
    h = E.resample2d(hull_half(X), n_half)
    zt, zb = h[0][1], h[-1][1]
    zc = 0.5 * (zt + zb)
    h = [(y * scale, zc + (z - zc) * scale) for y, z in h]
    return [R(X, z, y) for y, z in h] + [R(X, z, -y) for y, z in reversed(h[1:-1])]


def hull_y(X, Z):
    """Half-width of the hull at hub (X, Z)."""
    zt, zb, w, zm, nt, nb = hull(X)
    if Z >= zm:
        f = min(1.0, (Z - zm) / (zt - zm))
        return w * max(0.0, 1 - f ** nt) ** (1 / nt)
    f = min(1.0, (zm - Z) / (zm - zb))
    return w * max(0.0, 1 - f ** nb) ** (1 / nb)


def hull_z(X, y, top=True):
    zt, zb, w, zm, nt, nb = hull(X)
    f = min(1.0, abs(y) / w)
    if top:
        return zm + (zt - zm) * max(0.0, 1 - f ** nt) ** (1 / nt)
    return zm - (zm - zb) * max(0.0, 1 - f ** nb) ** (1 / nb)


# glazing (side view px): windscreen + roof strip above this edge, door window, door cut line
ROOF_EDGE = [(305, 244.4), (313.8, 244), (322.5, 241.9), (332.5, 238.1), (342.5, 233.8), (352.5, 230.5),
             (362.5, 226.5), (372.5, 222.5), (390, 216.4), (410, 207.1), (430, 198.6), (444.3, 191.4),
             (452.9, 185.7), (456.4, 180), (457.1, 173.6)]
P_ROOF = ROOF_EDGE + [(457.1, 150), (300, 150), (300, 246)]
P_DOOR = [(347.1, 272.9), (351.4, 280), (360, 284.6), (380, 284.8), (400, 283), (430, 277.5), (448.6, 272.9),
          (457.1, 267.1), (462.9, 252.9), (468.6, 231.4), (473.6, 210), (472.9, 203.6), (467.1, 200.7),
          (455.7, 200.7), (438.6, 204.3), (421.4, 211.4), (404.3, 220), (387.1, 231.4), (370, 245.7),
          (355.7, 260), (348.6, 268.6)]
P_DOORCUT = [(337.9, 272.9), (338.6, 281.4), (342.9, 291.4), (352.9, 298.6), (370, 301.4), (398.6, 302.1),
             (421.4, 300.7), (441.4, 297.1), (455.7, 290.7), (464.3, 281.4), (469.3, 268.6), (474.3, 245.7),
             (480, 217.1), (481.4, 207.1), (478.6, 198.6), (471.4, 194.3), (458.6, 193.1), (450, 194.3),
             (430, 201.4), (410, 211.4), (390, 223.6), (372.9, 236.4), (355.7, 251.4), (344.3, 262.9)]
P_VENT = [(408, 246), (438, 240), (441, 257), (411, 263)]            # sliding vent window in each door
# anthracite lower hull: the belly under the cabin, running out under the cowl where the hull bottom rises
P_LOW = [(255, 297), (264.4, 296.8), (285, 301.5), (310, 305), (340, 307), (390, 307), (430, 304.5), (455, 299.5),
         (475, 293), (500, 286), (525, 280), (545, 276), (560, 274), (600, 274), (600, 345), (255, 345)]
# six slanted gills on each cowl side (top end forward), three-view px (top end, bottom end)
GILLS = [((551, 227), (559, 254)), ((557, 224), (565, 248)), ((563, 221), (570, 245)), ((569, 219), (575, 238)),
         ((575, 217), (580, 233)), ((581, 214), (584, 228))]
# hot-air exit grille: the aft/down-facing lower rear of the cowl, behind the panel line under the gills
P_EXIT = [(550, 263), (556, 258.5), (591, 221.5), (600, 221.5), (600, 280), (550, 280)]

PILOT_HIP = R(0.43, -2.11, -SEAT_Y)
PASS_HIP = R(0.43, -2.11, SEAT_Y)
BACK = 18.0


def cast_side(target, x, z, sy):
    ok, loc, nrm, _ = target.ray_cast(V(x, sy * 1.5, z), V(0, -sy, 0))
    return (loc, nrm) if ok else (None, None)


def side_loop(mb, target, px, sy, r=0.004, mat='Paint_Dark', lift=0.001, step=0.02):
    """Closed line drawn on the hull side from a side-view polygon (three-view px)."""
    pts = B.resample_loop([R(X, Z) for X, Z in tvs(px)], step)
    out = []
    for p in pts:
        loc, nrm = cast_side(target, p.x, p.z, sy)
        if loc is not None:
            out.append(loc + nrm * lift)
    if len(out) > 3:
        B.closed_tube(mb, out, r, mat, n=6)


def oval_patch(mb, target, p, n, fwd, a, b, mat, h0=0.002, h1=0.006, taper=0.55):
    """Oval patch shrink-wrapped on the hull (lamp housings, caps)."""
    n, fwd = Vector(n).normalized(), Vector(fwd).normalized()
    fwd = (fwd - n * fwd.dot(n)).normalized()
    up = n.cross(fwd).normalized()
    ring, ring2 = [], []
    for k in range(24):
        t = TAU * k / 24
        for rr, out, hh in ((1.0, ring, h0), (taper, ring2, h1)):
            q = Vector(p) + fwd * (math.cos(t) * a * rr) + up * (math.sin(t) * b * rr) + n * 0.3
            ok, loc, _nn, _i = target.ray_cast(q, -n, distance=0.8)
            out.append((loc if ok else Vector(p)) + n * hh)
    ctr = sum(ring2, Vector()) / len(ring2)
    mb.loft([ring, ring2, [ctr]], mat, closed=True)


def build_hull():
    us = [0.02 * k for k in range(1, 38)]
    xs = [XTIP - u * u for u in us]
    x = xs[-1]
    while x > X_END + 0.045:
        x -= 0.036
        xs.append(x)
    xs.append(X_END)
    rings = [[R(XTIP, ZTIP)]] + [hull_ring(X) for X in xs]
    rings.append(hull_ring(X_END - 0.012, scale=0.86))
    mb = MB('pod')
    mb.loft(rings, 'Paint_White', closed=True, cap1=True)
    pod = mb.finish(sharp_angle=60)
    K.paint_poly(pod, R.pts(tvs(P_LOW)), 'Paint_Dark')
    return pod


def build_hull_lines(pod):
    """Everything drawn on the closed hull before the glazing is cut out: door cut lines, hinges,
    handles, vent windows, nose lights, fuel filler."""
    mb = MB('hull_lines')
    for sy in (1, -1):
        # (no drawn seams: thin black tubes on the paint read as pen lines (and alias into dashes) in the sim: door cut line removed)
        side_loop(mb, pod, P_VENT, sy, r=0.004, mat='Paint_Dark', lift=0.002, step=0.015)
        # two hinges on the upper edge, latch handle at the rear lower corner, vent latch
        for (x, y), size, mat in (((405, 213.5), (0.07, 0.014, 0.022), 'Paint_White'),
                                  ((445, 195.6), (0.07, 0.014, 0.022), 'Paint_White'),
                                  ((467.5, 276), (0.085, 0.016, 0.024), 'Chrome'),
                                  ((414, 254), (0.02, 0.012, 0.035), 'Decal_White')):
            X, Z = tv(x, y)
            loc, nrm = cast_side(pod, R.x(X), R.z(Z), sy)
            if loc is not None:
                mb.box(loc + nrm * 0.004, size, mat, bevel=0.004, segs=2,
                       rot=Euler((0, math.radians(-25 if y < 220 else 0), 0)))
        # almond landing light along the nose flank: black housing, LED strip in its front half
        # (three-view: 0.19 m long in the side view, centre X 1.715 Z -2.05; front view: 0.17-0.43 m out)
        p = R(1.735, -2.060, sy * 0.31)
        n = V(0.70, sy * 0.70, 0.18)
        fw = V(-0.264, sy * 0.29, 0.12)
        oval_patch(mb, pod, p, n, fw, 0.16, 0.036, 'Decal_Black', h0=0.0015, h1=0.004, taper=0.75)
        oval_patch(mb, pod, p - fw.normalized() * 0.015 + n.normalized() * 0.004, n, fw, 0.125, 0.025, 'Lens_White',
                   h0=0.004, h1=0.007, taper=0.6)
        # three LED dots behind the lens
        for k in (-1, 0, 1):
            q = p - fw.normalized() * (0.015 + 0.06 * k)
            ok, loc, _nn, _i = pod.ray_cast(q + n.normalized() * 0.3, -n.normalized(), distance=0.8)
            if ok:
                mb.lathe([(0.0, 0.0), (0.016, 0.0), (0.012, 0.006), (0.0, 0.007)], loc + n.normalized() * 0.006,
                         n.normalized(), 'Chrome', n=12)
        ok, loc, _nn, _i = pod.ray_cast(p + n.normalized() * 0.3, -n.normalized(), distance=0.8)
        if ok:
            K.lamp_node('landing', loc + n.normalized() * 0.03, 'L' if sy > 0 else 'R')
        # nav + strobe: one teardrop LED unit (tinted clear lens, round end forward with the coloured LED,
        # strobe in the pointed rear) on each cabin side just behind the door, ahead of the cowl joint and
        # above the gills (G-OSVN left, G-YFLI right, D-MGHO 2025 right lit green)
        X, Z = tv(512, 213)
        loc, nrm = cast_side(pod, R.x(X), R.z(Z), sy)
        if loc is not None:
            nn = V(0, nrm.y, nrm.z).normalized()
            oval_patch(mb, pod, loc + V(-0.008, 0, 0), nn, V(1, 0, 0), 0.044, 0.019, 'Lens_White', h0=0.002,
                       h1=0.009, taper=0.6)
            oval_patch(mb, pod, loc + V(0.022, 0, 0), nn, V(1, 0, 0), 0.017, 0.016,
                       'Lens_Red' if sy > 0 else 'Lens_Green', h0=0.004, h1=0.011, taper=0.6)
            K.lamp_node('navL' if sy > 0 else 'navR', loc + V(0.024, 0, 0) + nn * 0.025)
            K.lamp_node('strobeL' if sy > 0 else 'strobeR', loc + V(-0.024, 0, 0) + nn * 0.025)
    # fuel filler (left side, behind the door)
    X, Z = tv(486, 232)
    loc, nrm = cast_side(pod, R.x(X), R.z(Z), 1)
    if loc is not None:
        mb.lathe([(0.0, 0.012), (0.034, 0.012), (0.042, 0.008), (0.046, 0.0), (0.046, -0.004)], loc, nrm, 'Chrome', n=24)
        mb.cyl(loc + nrm * 0.012, loc + nrm * 0.018, 0.012, 'Alu_Black', n=10)
    return mb.finish(sharp_angle=50)


def split_canopy(pod):
    roof, door = R.pts(tvs(P_ROOF)), R.pts(tvs(P_DOOR))
    bm = bmesh.new()
    bm.from_mesh(pod.data)
    K.bisect_poly(bm, roof)
    K.bisect_poly(bm, door)
    bm.to_mesh(pod.data)
    bm.free()
    return K.split_glass(pod, lambda c: PANEL.inside(roof, c.x, c.z) or PANEL.inside(door, c.x, c.z),
                         frame_r=0.007, frame_mat='Paint_White', seal=False, thickness=0.012, name='canopy')


# ---- engine hood: raised panel over the cowl with a forward-facing oil-cooler scoop each side ----
HOOD_X0 = -0.29


def build_hood():
    mb = MB('hood')
    N, M = 22, 14
    z0, z1 = tv(0, 219.3)[1], tv(0, 204.2)[1]          # ledge: from the scoop foot to the prop flange
    rows_o, rows_i = [], []
    for i in range(N + 1):
        X = lerp(HOOD_X0, X_END, i / N)
        zt, zb, w, zm, nt, nb = hull(X)
        t = (X - X_END) / (HOOD_X0 - X_END)
        d = 0.003 + 0.024 * t ** 1.2
        zl = max(lerp(z0, z1, i / N), zm + 0.004)
        a1 = math.acos(min(1.0, max(0.0, ((zl - zm) / (zt - zm)) ** (nt / 2))))
        ro, ri = [], []
        for j in range(-M, M + 1):
            a = a1 * abs(j) / M
            sg = 1 if j >= 0 else -1
            fy, fz = math.sin(a) ** (2 / nt), math.cos(a) ** (2 / nt)
            y, z = w * fy * sg, zm + (zt - zm) * fz
            ny, nz = sg * fy ** (nt - 1) / w, fz ** (nt - 1) / (zt - zm)
            ln = math.hypot(ny, nz)
            ny, nz = ny / ln, nz / ln
            # the scoop mouths stand proud on the flanks only
            dd = d * (0.35 + 0.65 * min(1.0, abs(j) / (M * 0.45)) ** 1.5)
            ro.append(R(X, z + nz * dd, y + ny * dd))
            ri.append(R(X, z - nz * 0.006, y - ny * 0.006))
        rows_o.append(ro)
        rows_i.append(ri)
    W = 2 * M + 1

    def grid(rows, mat):
        coords = [p for r in rows for p in r]
        faces = [[i * W + j, i * W + j + 1, (i + 1) * W + j + 1, (i + 1) * W + j]
                 for i in range(len(rows) - 1) for j in range(W - 1)]
        mb.faces(coords, faces, mat)
    grid(rows_o, 'Paint_White')
    grid(rows_i, 'Interior')
    # front edge: a black oil-cooler scoop mouth on each upper flank (photos G-CGYX, RA-0: a short dark
    # slot just behind the mast foot), the rest of the step in body colour
    for j in range(W - 1):
        k = abs(j + 0.5 - M) / M
        mat = 'Radiator' if 0.42 < k < 0.78 else 'Paint_White'
        mb.faces([rows_o[0][j], rows_o[0][j + 1], rows_i[0][j + 1], rows_i[0][j]], [[0, 1, 2, 3]], mat, smooth=False)
        mb.faces([rows_o[N][j], rows_o[N][j + 1], rows_i[N][j + 1], rows_i[N][j]], [[0, 1, 2, 3]], 'Paint_White')
    for i in range(N):
        for j in (0, W - 1):
            mb.faces([rows_o[i][j], rows_o[i + 1][j], rows_i[i + 1][j], rows_i[i][j]], [[0, 1, 2, 3]], 'Paint_White',
                     smooth=False)
    return mb.finish(sharp_angle=50, merge=1e-5)


# ---- mast fairing (hub Z, leading / trailing edge in three-view px, thickness from the front view) ----
# thickness (front view): 0.105 m up the neck, flaring to 0.14 / 0.17 / 0.22 / 0.31 / 0.43 m at hub Z
# -0.73 / -0.82 / -0.90 / -0.99 / -1.03 where it blends into the roof
MAST = [(-1.270, 466.0, 578.0, 0.85), (-1.160, 474.0, 563.0, 0.70), (-1.100, 479.0, 554.0, 0.55),
        (-1.055, 482.0, 548.5, 0.42), (-1.003, 482.1, 541.0, 0.33), (-0.950, 481.9, 535.5, 0.26),
        (-0.897, 481.8, 531.0, 0.21), (-0.820, 481.7, 526.0, 0.16), (-0.749, 481.6, 521.5, 0.135),
        (-0.720, 484.5, 520.3, 0.125), (-0.691, 488.5, 519.2, 0.120), (-0.600, 488.3, 517.0, 0.110),
        (-0.4925, 487.5, 515.0, 0.105), (-0.400, 483.0, 514.6, 0.110), (-0.300, 478.0, 514.2, 0.120),
        (-0.245, 475.5, 514.0, 0.125)]


def build_mast():
    mb = MB('mast')
    rings = []
    for Z, le, te, th in MAST:
        xl, xt = tv(le, 0)[0], tv(te, 0)[0]
        c = xl - xt
        rings.append([R(xl - s * c, Z, tz * c) for s, tz in airfoil_ring(18, min(th / c, 0.9), te_min=0.004)])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    mast = mb.finish(sharp_angle=50)
    # black air intake wrapped round the leading edge above the roof
    le_f = B.hermite([m[0] for m in MAST], [tv(m[1], 0)[0] for m in MAST])
    te_f = B.hermite([m[0] for m in MAST], [tv(m[2], 0)[0] for m in MAST])

    def intake(c):
        Z, X = c.z - R.dz, c.x - R.dx
        return -1.003 < Z < -0.749 and (le_f(Z) - X) / (le_f(Z) - te_f(Z)) < 0.17
    K.repaint(mast, intake, 'Decal_Black')
    # mast head: cheek plates on the pitch pivot, pre-rotator shaft up the rear of the fairing
    hb = MB('mast_head')
    for sy in (1, -1):
        hb.box(PIVOT + V(-0.03, sy * 0.045, -0.035), (0.16, 0.010, 0.13), 'Metal_Frame', bevel=0.012, segs=2)
        hb.cyl(PIVOT + V(0, sy * 0.040, 0), PIVOT + V(0, sy * 0.062, 0), 0.016, 'Engine', n=12)
    hb.box(R(-0.11, -0.262), (0.30, 0.085, 0.04), 'Alu_Black', bevel=0.01, segs=2)
    hb.cyl(R(-0.21, -0.26), PIVOT + V(-0.137, 0, -0.07), 0.010, 'Metal_Frame', n=10)
    # pneumatic trim / rotor brake cylinder behind the head
    hb.cyl(R(-0.17, -0.255, 0.05), R(-0.19, -0.13, 0.05), 0.016, 'Alu_Black', n=12)
    hb.cyl(R(-0.19, -0.13, 0.05), R(-0.20, -0.085, 0.05), 0.007, 'Chrome', n=8)
    return mast, hb.finish(sharp_angle=40, wn=True)


# ---- keel: boot under the cowl, oval tube under the prop and up to the tail ----
BOOT = [(-0.30, -2.200, 0.200, 0.070), (-0.45, -2.220, 0.170, 0.100), (-0.56, -2.250, 0.130, 0.110),
        (-0.64, -2.285, 0.100, 0.100), (-0.72, -2.325, 0.075, 0.075), (-0.82, -2.365, 0.052, 0.050),
        (X_END, -2.410, 0.0375, 0.040)]
KEEL = [(X_END, -2.410), (-1.08, -2.418), (-1.22, -2.410), (-1.38, -2.360), (-1.62, -2.272), (-1.86, -2.185),
        (-2.10, -2.155), (-2.38, -2.125)]


def build_keel():
    mb = MB('keel')
    rings = [[R(X, Z + hh * math.sin(TAU * k / 24), hw * math.cos(TAU * k / 24)) for k in range(24)]
             for X, Z, hw, hh in BOOT]
    mb.loft(rings, 'Paint_Dark', closed=True, cap0=True, cap1=True)
    # bare aluminium keel tube (silver on most Cavalons, see RA-0, G-CGYX)
    mb.tube(catmull([R(X, Z) for X, Z in KEEL], 5), 0.04, 'Keel_Alu', n=20, square=(0.075, 0.080, 2.4))
    return mb.finish(sharp_angle=50)


# ---- tail (hub frame) ----
STAB_LE0, STAB_LE1, STAB_TE = -1.847, -2.076, -2.414
SPAN = 0.80
HINGE = -2.31
FIN_TOP = -1.326
FIN_BOT = -2.150


def stab_z(X):
    return -2.140 + (STAB_LE0 - X) * (0.045 / 0.567)


def fin_le(z):
    Z = z - R.dz
    t = (Z - FIN_BOT) / (FIN_TOP - FIN_BOT)
    x = lerp(-1.923, -2.047, t)
    x -= 0.055 * max(0.0, (t - 0.93) / 0.07) ** 2
    return R.x(x)


def rud_te(z):
    Z = z - R.dz
    if Z < -1.913:
        x = lerp(HINGE - 0.03, -2.799, max(0.0, (Z + 2.095) / 0.182))
    else:
        x = lerp(-2.799, -2.569, (Z + 1.913) / 0.520)
    t = (Z - FIN_BOT) / (FIN_TOP - FIN_BOT)
    x += 0.10 * max(0.0, (t - 0.925) / 0.075) ** 2
    return R.x(x)


def build_tail():
    mb = MB('tail')
    loop = airfoil_ring(14, 0.085, te_min=0.002)
    rings = []
    for y in (-SPAN, -0.76, -0.66, -0.5, -0.3, -0.12, 0.0, 0.12, 0.3, 0.5, 0.66, 0.76, SPAN):
        le = lerp(STAB_LE0, STAB_LE1, abs(y) / SPAN)
        ch = le - STAB_TE
        rings.append([R(le - s * ch, stab_z(le - s * ch) + tz * ch, y) for s, tz in loop])
    mb.loft(rings, 'Paint_White', closed=True, cap0=True, cap1=True)
    # end fins: 0.57 m above the tailplane, vertical trailing edge, rounded top corners
    z0, z1 = -2.155, -1.530
    zs = [lerp(z0, z1, t) for t in (0.0, 0.03, 0.10, 0.3, 0.5, 0.7, 0.85, 0.93, 0.975, 1.0)]

    def efin_le(z):
        t = (z - R.dz - z0) / (z1 - z0)
        return R.x(lerp(-2.052, -2.150, t) - 0.07 * max(0.0, (t - 0.9) / 0.1) ** 2
                   - 0.03 * max(0.0, (0.06 - t) / 0.06) ** 2)

    def efin_te(z):
        t = (z - R.dz - z0) / (z1 - z0)
        return R.x(-2.414 + 0.035 * max(0.0, (t - 0.92) / 0.08) ** 2 + 0.03 * max(0.0, (0.06 - t) / 0.06) ** 2)
    for sy in (1, -1):
        E.fin_loft(mb, [R.z(z) for z in zs], efin_le, efin_te, y_fn=lambda z, sy=sy: sy * SPAN, t=0.10)
    # central fin (the rudder is its aft part)
    zs = [FIN_BOT, -2.08, -1.95, -1.80, -1.65, -1.50, -1.42, -1.37, -1.345, -1.332, FIN_TOP]
    E.fin_loft(mb, [R.z(z) for z in zs], fin_le, rud_te, t=0.085,
               s_end_fn=lambda z: (fin_le(z) - R.x(HINGE)) / (fin_le(z) - rud_te(z)))
    # tailplane saddle on the keel, rudder post foot
    mb.box(R(-2.12, -2.152), (0.46, 0.085, 0.03), 'Paint_Dark', bevel=0.008, segs=2, rot=K.rot_y(-6))
    mb.cyl(R(HINGE, -2.16), R(HINGE, -2.07), 0.012, 'Metal_Frame', n=10)
    return mb.finish(sharp_angle=45)


def build_rudder():
    zs = [-2.092, -2.03, -1.913, -1.80, -1.65, -1.50, -1.42, -1.37, -1.345, -1.332, FIN_TOP - 0.003]
    origin = R(HINGE, -1.70)
    rud = E.build_rudder_surface('rudder', [R.z(z) for z in zs], fin_le, rud_te, R.x(HINGE), origin, t=0.085,
                                 mat='Paint_White')
    # ground-adjustable trim tab on the trailing edge (bare aluminium)
    tab = MB('trimtab')
    tab.box(R(-2.775, -1.772), (0.09, 0.004, 0.14), 'Metal_Frame', bevel=0.0, rot=Euler((0, math.radians(23.8), 0)))
    tab_ob = tab.finish(sharp_angle=60)
    regs = E.build_registration(rud, REG, cx=R.x(-2.515) - origin.x, cz=R.z(-1.62) - origin.z, size=0.068,
                                mat='Decal_Black')
    for r in regs:
        r.location = r.location + origin
    B.join_objects('rudder', [rud, tab_ob] + regs)
    return rud


def build_gear():
    mb = MB('main_gear')
    ax = R(AXLE[0], AXLE[1])
    for sy in (1, -1):
        # composite bow: under the cabin floor, out and down to the axle
        K.leg_blade(mb, [R(-0.40, -2.270, sy * 0.02), R(-0.40, -2.278, sy * 0.28), R(-0.405, -2.305, sy * 0.47),
                         R(-0.42, -2.385, sy * 0.62), R(-0.435, -2.470, sy * 0.70)], chord=0.17, thick=0.038,
                    mat='Paint_Dark')
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.10), ax.z), V(ax.x, sy * (MAIN_Y + 0.05), ax.z), 0.014, 'Metal_Frame', n=12)
        mb.cyl(V(ax.x, sy * (MAIN_Y - 0.072), ax.z), V(ax.x, sy * (MAIN_Y - 0.064), ax.z), 0.09, 'Metal_Frame', n=24)
        mb.box(V(ax.x + 0.075, sy * (MAIN_Y - 0.068), ax.z + 0.03), (0.05, 0.03, 0.05), 'Engine_Dark', bevel=0.008,
               segs=1)
        # anti-slip step patch on the leg root
        mb.box(R(-0.405, -2.288, sy * 0.50), (0.12, 0.10, 0.004), 'Rubber', bevel=0.0,
               rot=Euler((math.radians(-sy * 17), 0, 0)))
    # radiator with its fan shroud under the bow, coolant hoses up into the cowl
    rc = R(-0.545, -2.385)
    mb.box(rc, (0.11, 0.38, 0.16), 'Radiator', bevel=0.012, segs=2)
    for k in range(15):
        mb.box(rc + V(0.056, -0.168 + k * 0.024, 0), (0.004, 0.004, 0.14), 'Engine')
    for sy in (1, -1):
        mb.tube(catmull([rc + V(-0.03, sy * 0.15, 0.07), rc + V(-0.05, sy * 0.15, 0.16), R(-0.62, -2.10, sy * 0.10)], 5),
                0.014, 'Rubber', n=8)
    gear = mb.finish(sharp_angle=40, wn=True)
    spats = []
    for name, sy in (('spat_L', 1), ('spat_R', -1)):
        c = V(ax.x, sy * MAIN_Y, ax.z)
        # three-view: 0.26 ahead / 0.40 behind the axle, top 0.21 above it, 0.25 wide (top view)
        spats.append(K.spat(name, c, R=0.205, front=0.27, back=0.40, hw=0.122, top=0.012, lift=0.075,
                            mat='Paint_White', tail_up=0.05, belly=0.46))
        K.wheel('wheel_L' if sy > 0 else 'wheel_R', c, R=0.205, w=0.11)
    nc = R(NOSE[0], NOSE[1])
    nose = K.nose_gear(nc, R=0.15, w=0.09, leg_top=R.z(-2.30), rake=-0.083)
    nspat = K.spat('nose_spat', nc, R=0.15, front=0.21, back=0.30, hw=0.085, top=0.025, lift=0.06,
                   mat='Paint_White', tail_up=0.0, belly=0.5)
    B.join_objects('nose_wheel', [nose, nspat])
    return gear, spats


def seat(mb, hip, back_deg, width=0.44, cushion_len=0.42):
    """E.bucket_seat (made to fit pilot.py's occupant) for a hip off the centreline, with the Cavalon's
    integrated headrest and carbon back shell."""
    b = math.radians(back_deg)
    u = Vector((-math.sin(b), 0, math.cos(b)))
    f = Vector((math.cos(b), 0, math.sin(b)))
    rb = Euler((0, -b, 0))
    rc = Euler((0, math.radians(-7), 0))
    c = V(hip.x + cushion_len * 0.5 - 0.10, hip.y, hip.z - 0.125)
    mb.box(c, (cushion_len, width, 0.08), 'Seat', bevel=0.03, segs=3, rot=rc)
    mb.box(c - V(0, 0, 0.08), (cushion_len - 0.04, width - 0.06, 0.10), 'Interior', bevel=0.02, segs=1)
    back_c = hip - f * 0.175 + u * 0.33
    mb.box(back_c, (0.07, width, 0.66), 'Seat', bevel=0.03, segs=3, rot=rb)
    mb.box(back_c - f * 0.045, (0.03, width - 0.02, 0.64), 'Carbon', bevel=0.012, segs=2, rot=rb)
    # lumbar bolster on the outboard side only (the inboard arm hangs down to the centre console)
    sy = 1 if hip.y > 0 else -1
    mb.box(hip - f * 0.13 + u * 0.14 + V(0, sy * (width * 0.5 - 0.02), 0), (0.08, 0.04, 0.18), 'Seat',
           bevel=0.016, segs=2, rot=rb)
    for sy in (1, -1):
        mb.box(c + V(0.02, sy * (width * 0.5 - 0.02), 0.04), (cushion_len - 0.08, 0.04, 0.05), 'Seat', bevel=0.016,
               segs=2, rot=rc)
    hc = hip - f * 0.175 + u * 0.80
    mb.box(hc, (0.08, 0.26, 0.19), 'Seat', bevel=0.03, segs=3, rot=rb)
    mb.box(hc - f * 0.045, (0.03, 0.24, 0.17), 'Carbon', bevel=0.012, segs=2, rot=rb)


def build_cockpit():
    mb = MB('cockpit')
    seat(mb, PILOT_HIP, BACK)
    seat(mb, PASS_HIP, BACK)
    # floor, centre console between the seats (throttle / brake quadrant on it), rear bulkhead
    mb.box(R(0.78, -2.300), (1.45, 0.66, 0.012), 'Interior', bevel=0.0)
    mb.box(R(0.55, -2.160), (0.86, 0.10, 0.20), 'Panel', bevel=0.02, segs=2)
    ring = [p for p in hull_ring(-0.02, n_half=20, scale=0.975)]
    ring2 = [p + V(-0.03, 0, 0) for p in ring]
    mb.loft([ring, ring2], 'Interior', closed=True, cap0=True, cap1=True)
    # baggage / tank covers behind the seats
    for sy in (1, -1):
        mb.box(R(0.07, -1.99, sy * 0.28), (0.14, 0.46, 0.36), 'Interior', bevel=0.04, segs=3)
    return mb.finish(sharp_angle=40, wn=True)


def build_cavalon():
    if 'Keel_Alu' not in MATS:
        B.make_mat('Keel_Alu', B.srgb('#BFC3C7'), metal=0.9, rough=0.30)
    pod = build_hull()
    lines = build_hull_lines(pod)
    hood = build_hood()
    canopy, cframe, cseal = split_canopy(pod)
    mast, mast_head = build_mast()
    keel = build_keel()
    K.build_head(PIVOT, HUB, arm=-0.22, arm_w=0.22, plate_mat='Metal_Frame')
    K.build_rotor(HUB, R=4.2, chord=0.20, root=0.50, tip_mat='Decal_White', clamp_len=0.50)
    K.build_prop(PROP, R=0.86, blades=3, hub='spinner', hub_r=0.112, hub_len=0.24, tip_mat='Carbon',
                 spinner_mat='Paint_White')
    tail = build_tail()
    build_rudder()
    gear, spats = build_gear()
    cockpit = build_cockpit()

    # ---- controls and crew: everything that moves belongs to the RIGHT seat
    ctrl = MB('controls_static')
    yp = -SEAT_Y
    stick_base = R(0.93, -2.290, yp)
    stick, grip, axis = controls.gyro_stick(stick_base, R(0.80, -1.815, yp))
    stick_l, grip_l, axis_l = controls.gyro_stick(R(0.93, -2.290, SEAT_Y), R(0.80, -1.815, SEAT_Y), name='stick_left')
    knob, lever = controls.throttle_lever(ctrl, R(0.66, -2.035, -0.040))
    feet_z = -2.125
    pilot.build_pilot('pilot_front', PILOT_HIP, BACK,
                      hands={'R': ('stick', grip, axis), 'L': ('knob', knob, lever)},
                      feet={'L': R(1.25, feet_z, yp + 0.11), 'R': R(1.25, feet_z, yp - 0.11)}, knee_out=0.03,
                      elbow_out=0.05, rig=True)
    controls.pedals(ctrl, pilot.JOINTS['pilot_front'], R.z(-2.275))
    # static pedals of the left seat
    for dy in (0.11, -0.11):
        c = R(1.335, -2.215, SEAT_Y + dy)
        ctrl.box(c, (0.008, 0.10, 0.15), 'Metal_Frame', bevel=0.003, segs=1, rot=K.rot_y(-18))
        ctrl.cyl(c + V(-0.03, 0, -0.075), R(1.32, -2.285, SEAT_Y + dy), 0.008, 'Metal_Frame', n=8)
    # wide binnacle across the cabin: live instruments in front of the pilot (zone u = +SEAT_Y), centre
    # stack with the switches between the seats, leg well each side
    p0 = R(0.985, -1.740)
    tilt = 15.0
    PANEL.build_panel(ctrl, p0, tilt, [pod, canopy], zone=(SEAT_Y + 0.01, 0.0, 0.38, 0.15), cw=0.085, v_leg=-0.10,
                      v_sb=-0.24, v_b=-0.42, top_arch=(0.60, 0.03, 0.115), max_u=0.555, leg_exp=0.25)
    t = math.radians(tilt)
    upv, nrm = V(math.sin(t), 0, math.cos(t)), V(-math.cos(t), 0, math.sin(t))
    # glare shield, passenger-side display and gauges (decor), console foot down to the floor console
    ctrl.box(p0 + upv * 0.118 - nrm * 0.075, (0.20, 0.96, 0.022), 'Panel', bevel=0.01, segs=2, rot=K.rot_y(-10))
    ctrl.box(p0 + upv * 0.118 + nrm * 0.022 - V(0, 0, 0.006), (0.03, 0.98, 0.026), 'Panel', bevel=0.012, segs=3)
    pc = p0 + V(0, SEAT_Y + 0.01, 0)
    ctrl.box(pc + nrm * 0.003, (0.006, 0.21, 0.135), 'Btn_Black', bevel=0.003, segs=1, rot=Euler((0, t, 0)))
    ctrl.box(pc + nrm * 0.0065, (0.002, 0.19, 0.118), 'Visor', rot=Euler((0, t, 0)))
    for dy, dv in ((0.15, 0.035), (0.15, -0.035), (-0.15, 0.035), (-0.15, -0.035)):
        g = pc + V(0, dy, 0) + upv * dv
        ctrl.cyl(g, g + nrm * 0.007, 0.028, 'Metal_Frame', n=20)
        ctrl.cyl(g + nrm * 0.007, g + nrm * 0.0075, 0.024, 'Gauge_Face', n=20)
    ctrl.box(R(0.955, -2.08), (0.10, 0.165, 0.30), 'Panel', bevel=0.02, segs=2, rot=K.rot_y(tilt))
    K.print_joints('pilot_front', R)
    ctrl = ctrl.finish(sharp_angle=40)
    pilot.build_pilot('pilot_rear', PASS_HIP, BACK,
                      hands={'R': ('rest', PASS_HIP + V(0.24, -0.09, 0.115), None),
                             'L': ('rest', PASS_HIP + V(0.24, 0.09, 0.115), None)},
                      feet={'L': R(1.25, feet_z, SEAT_Y + 0.11), 'R': R(1.25, feet_z, SEAT_Y - 0.11)}, knee_out=0.03,
                      elbow_out=0.04)
    K.print_joints('pilot_rear', R)

    # ---- details
    det = MB('details')
    K.pitot(det, R(XTIP - 0.004, ZTIP), (1, 0, -0.05), length=0.10)
    # (end fins and fin top carry no lamp on any photographed Cavalon: G-OSVN, G-YFLI, D-MGHO)
    for sy in (1, -1):
        # six big slanted gills under the hood ("\" seen from the left: top end forward, G-OSVN, three-view),
        # hot-air exit slots stacked along the lower rear rim of the cowl
        # (three-view px: top and bottom end of each gill; the bottom ends stop 15 % short of the exit grille)
        for (xa, ya), (xb, yb) in GILLS:
            (Xa, Za), (Xb, Zb) = tv(xa, ya), tv(xb, yb)
            Xb, Zb = lerp(Xa, Xb, 0.85), lerp(Za, Zb, 0.85)
            d = V(Xa - Xb, 0, Za - Zb)
            L = d.length
            g = d.normalized() * (1 if sy > 0 else -1)
            K.louvres(det, pod, R(0.5 * (Xa + Xb), 0.5 * (Za + Zb), sy * 0.3), V(0, sy, 0), g, count=1, length=L,
                      depth=0.020, mat='Radiator', body_mat='Paint_White')
    # exhaust tail pipe (left, under the gills), prop flange, belly antenna, transponder blade
    # short exhaust tail pipe poking out of the left cowl side under the gills (G-OSVN)
    ye = hull_y(-0.60, -1.87)
    K.exhaust_stub(det, [R(-0.60, -1.85, ye - 0.05), R(-0.61, -1.88, ye + 0.005), R(-0.62, -1.925, ye + 0.03)],
                   r=0.019)
    det.cyl(R(X_END + 0.01, -1.355), PROP + V(0.085, 0, 0), 0.10, 'Engine_Dark', n=28)
    K.antenna(det, R(0.25, -2.33), (-0.25, 0, -1), length=0.24)
    K.antenna(det, R(-0.05, -1.07, 0.30), (-0.3, 0.25, 1), length=0.30)
    det = det.finish(sharp_angle=50)
    script = K.decal_text(hood, 'cavalon', R.x(-0.62), R.z(-1.325), size=0.062, mat='Paint_Accent')

    b = math.radians(BACK)
    u = V(-math.sin(b), 0, math.cos(b))
    head = PILOT_HIP + u * pilot.SPINE + u * 0.13 + V(0.035, 0, 0.072)
    eye = head + V(0.077, 0, 0.007)
    K.make_eye(eye)
    K.clearance(['pilot_front'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit], ' (pilot)')
    K.clearance(['pilot_rear'], [bpy.data.objects.get('panel_face'), ctrl, pod, cockpit, stick_l], ' (passenger)')
    K.finalize([pod, lines, hood, cframe, cseal, mast, mast_head, keel, tail, gear, cockpit, ctrl, det, stick_l]
               + spats + script, [canopy])
    ax = R(AXLE[0], AXLE[1])
    K.required({
        'rotor': HUB, 'rotor_head': PIVOT, 'prop': PROP, 'rudder': R(HINGE, -1.70), 'stick': stick_base,
        'eye_front': eye, 'nose_wheel': R(NOSE[0], NOSE[1]), 'wheel_L': V(ax.x, MAIN_Y, ax.z),
        'wheel_R': V(ax.x, -MAIN_Y, ax.z), 'pilot_rear': None,
    })

    def g(p):       # Blender (x, y, z) -> sim (x forward, y up, z right)
        return '(%.3f, %.3f, %.3f)' % (p.x, p.z, -p.y)
    print('CAVALON hub %s pivot %s prop %s eye %s' % (g(HUB), g(PIVOT), g(PROP), g(eye)))
    print('CAVALON ground y %.3f  main axle %s  nose axle %s  stick %s' % (
        R.z(GROUND), g(V(ax.x, MAIN_Y, ax.z)), g(R(NOSE[0], NOSE[1])), g(stick_base)))
    print('CAVALON nose tip %s  rudder TE %s  fin top %s  keel low %s  stab LE root %s tip %s TE %s' % (
        g(R(XTIP, ZTIP)), g(R(-2.799, -1.913)), g(R(-2.19, FIN_TOP)), g(R(-1.15, -2.458)),
        g(R(STAB_LE0, stab_z(STAB_LE0))), g(R(STAB_LE1, stab_z(STAB_LE1), SPAN)), g(R(STAB_TE, stab_z(STAB_TE)))))


VIEWS = {
    # same angles as the reference photos G-OSVN (rear left quarter) and RA-0 orange (front left quarter)
    'ref_rear_left': dict(extra=True, loc=(-7.6, 12.6, 0.25), target=(-0.75, 0.0, 0.25), lens=85, rotor=8, prop=20),
    'ref_front_left': dict(extra=True, loc=(6.4, 5.6, 0.55), target=(-0.2, 0.0, 0.25), lens=60, rotor=-70, prop=20),
    'ref_front': dict(extra=True, loc=(10.0, 0.0, 0.35), target=(0.0, 0.0, 0.35), ortho=4.2, rotor=90, prop=0),
    'ref_top': dict(extra=True, loc=(0.0, 0.0, 30.0), target=(0.0, 0.0, 0.0), ortho=6.0, rotor=90, prop=0),
    # G-OSVN (photo 45, left side from slightly ahead), G-CGYX (photo 31, left front quarter, high),
    # G-YFLI (photo 40, right rear quarter, low)
    'ref45': dict(extra=True, loc=(4.2, 10.5, 0.35), target=(-0.45, 0.0, 0.15), lens=62, rotor=12, prop=20),
    'ref31': dict(extra=True, loc=(4.6, 5.2, 1.0), target=(-0.2, 0.0, -0.1), lens=30, rotor=60, prop=20),
    'pilot_eye': dict(extra=True, loc=(0.17, -0.28, 0.33), target=(1.3, -0.05, -0.12), lens=16, rotor=75, prop=0),
    'cabin_front': dict(extra=True, loc=(2.3, -0.25, 1.05), target=(0.55, 0.0, -0.15), lens=24, rotor=75, prop=0),
    'ref26': dict(extra=True, loc=(-7.5, 7.0, 0.9), target=(-0.6, 0.0, 0.3), lens=55, rotor=-20, prop=30),
    'ref40': dict(extra=True, loc=(-4.4, -4.6, 0.1), target=(-0.3, 0.0, 0.35), lens=28, rotor=-50, prop=40),
    # lamp close-ups: left unit (G-OSVN, 45), right unit (G-YFLI 40 / D-MGHO 27), nose landing lights
    'lamp_left': dict(extra=True, loc=(0.6, 1.9, 0.45), target=(-0.50, 0.38, 0.30), lens=50, rotor=75, prop=20),
    'lamp_right': dict(extra=True, loc=(-1.4, -1.9, 0.40), target=(-0.50, -0.38, 0.30), lens=50, rotor=75, prop=20),
    'nose_lamps': dict(extra=True, loc=(3.1, 1.2, -0.05), target=(1.50, 0.0, -0.30), lens=45, rotor=75, prop=20),
}

if __name__ == '__main__':
    K.run('cavalon', build_cavalon, LIVERY, views=VIEWS, rest_ground=R.z(GROUND))
