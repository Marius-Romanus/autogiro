"""
Instrument panel shaped like the ELA / AutoGyro carbon panels: its top follows the cabin section
(canopy or cowl, found with rays in the panel plane), the shoulders carry the live instruments (drawn
by the sim over `zone`, src/aircraft/Cockpit.ts) and a central console runs down between the pilot's
legs with the switches, ignition key, USB sockets, fuel LEDs, pneumatic gauge, radio and transponder.
Leg wells are cut on both sides of the console.

Nodes:
  panel_face   front face, UV = panel coordinates; the sim paints placards, LEDs and displays on it.
               extras['layout'] = JSON: frame, outline, zone and items (see build_panel)
  sw_<id>      toggle switches, origin on the pivot, lever along the panel normal; the sim tilts them
               about the panel's horizontal axis (lever up = ON)
  key          ignition key, origin in the keyhole, turns about the panel normal
Static parts (panel body, switch nuts, key lock, bezels, knobs, USB) go into `static`, which the
build script joins into the airframe.
Panel coordinates: u to the pilot's right, v up along the panel, origin at p0; n toward the pilot.
Blender axes: +X forward, +Y left, +Z up. Metres.
"""
import json
import math
import bpy
import bmesh
from mathutils import Matrix, Vector
import build_autogiro as B
import controls

MB, MATS, V = B.MB, B.MATS, B.V


class Frame:
    def __init__(self, p0, tilt_deg):
        t = math.radians(tilt_deg)
        self.p0 = Vector(p0)
        self.tilt = tilt_deg
        self.U = V(0, -1, 0)
        self.Vv = V(math.sin(t), 0, math.cos(t))
        self.N = V(-math.cos(t), 0, math.sin(t))

    def P(self, u, v, n=0.0):
        return self.p0 + self.U * u + self.Vv * v + self.N * n

    def R(self):
        return controls.basis(self.U, self.Vv, self.N)


def ray(targets, p, d, far=1.0):
    best = None
    for o in targets:
        inv = o.matrix_world.inverted()
        ok, loc, _n, _i = o.ray_cast(inv @ p, (inv.to_3x3() @ d).normalized(), distance=far)
        if ok:
            dist = ((o.matrix_world @ loc) - p).length
            if best is None or dist < best:
                best = dist
    return best


def ensure_materials():
    controls.ensure_materials()
    if 'Panel_Face' not in MATS:
        B.make_mat('Panel_Face', B.srgb('#17181B'), rough=0.55)
    if 'Panel' not in MATS:
        B.make_mat('Panel', B.srgb('#0E0F10'), rough=0.72)


# ---------------------------------------------------------------------------
# outline
# ---------------------------------------------------------------------------
def outline(F, targets, zone, cw, v_leg, v_sb, v_b, margin=0.014, c_v=None, max_r=0.6, top_arch=None,
            rc=0.02, leg_exp=0.4, max_u=None):
    """Closed outline (u, v), counter-clockwise. The upper part follows the cabin: radial rays in the
    panel plane from (0, c_v), minus `margin`; top_cap limits the height (v). Below the shoulders the
    outer sides drop to v_sb, leg wells arch up to v_leg between the sides and the console (half width
    cw), which goes down to v_b. top_arch = (a, v_side, v_top): also stay under that superellipse (open
    cockpits, where the rays find no cowl above the panel)."""
    zu, zv, zw, zh = zone
    if c_v is None:
        c_v = zv
    angs = [math.radians(a) for a in range(-14, 195, 2)]
    rs = []
    for a in angs:
        d = F.U * math.cos(a) + F.Vv * math.sin(a)
        r = ray(targets, F.P(0, c_v), d, max_r)
        rs.append((r if r is not None else max_r) - margin)
    # smooth: 5-tap minimum then 5-tap mean (bumps of the hull never poke through)
    n = len(rs)
    mins = [min(rs[max(0, i - 2):i + 3]) for i in range(n)]
    rs = [sum(mins[max(0, i - 2):i + 3]) / len(mins[max(0, i - 2):i + 3]) for i in range(n)]
    upper = []
    for a, r in zip(angs, rs):
        u, v = math.cos(a) * r, c_v + math.sin(a) * r
        if top_arch is not None:
            a_, vs_, vt_ = top_arch
            t_ = min(1.0, abs(u) / a_)
            v = min(v, vs_ + (vt_ - vs_) * (1 - t_ ** 2.5) ** (1 / 2.5))
        if max_u is not None:
            u = max(-max_u, min(max_u, u))
        upper.append((u, v))

    def side_u(v, sign):
        r = ray(targets, F.P(0, v), F.U * sign, max_r)
        return (r if r is not None else max_r) - margin
    ur = min(upper[0][0], min(side_u(v, 1) for v in (v_sb, (v_sb + upper[0][1]) / 2)))
    ul = min(-upper[-1][0], min(side_u(v, -1) for v in (v_sb, (v_sb + upper[-1][1]) / 2)))
    pts = [(0.0, v_b)]
    for k in range(1, 5):                         # rounded console corner (right)
        a = -math.pi / 2 + (math.pi / 2) * k / 4
        pts.append((cw - rc + rc * math.cos(a), v_b + rc + rc * math.sin(a)))
    pts.append((cw, v_sb))

    def well(u0, u1):
        uc, hw = (u0 + u1) / 2, (u1 - u0) / 2
        out = []
        for k in range(1, 24):
            t = math.pi * k / 24
            out.append((uc - hw * math.cos(t), v_sb + (v_leg - v_sb) * math.sin(t) ** leg_exp))
        return out
    pts += well(cw, ur)
    pts.append((ur, v_sb))
    pts.append((ur, upper[0][1]))
    pts += upper
    pts.append((-ul, upper[-1][1]))
    pts.append((-ul, v_sb))
    pts += [(-u, v) for (u, v) in reversed(well(cw, ul))]
    pts.append((-cw, v_sb))
    for k in range(0, 4):
        a = math.pi + (math.pi / 2) * k / 4
        pts.append((-cw + rc + rc * math.cos(a), v_b + rc + rc * math.sin(a)))
    # drop near-duplicates
    clean = [pts[0]]
    for p in pts[1:]:
        if (p[0] - clean[-1][0]) ** 2 + (p[1] - clean[-1][1]) ** 2 > 1e-8:
            clean.append(p)
    return clean


def inside(poly, u, v):
    c = False
    j = len(poly) - 1
    for i in range(len(poly)):
        (ui, vi), (uj, vj) = poly[i], poly[j]
        if (vi > v) != (vj > v) and u < (uj - ui) * (v - vi) / (vj - vi) + ui:
            c = not c
        j = i
    return c


# ---------------------------------------------------------------------------
# console items (placed top-down; rows that do not fit are left out)
# ---------------------------------------------------------------------------
def console_items(cw, v_top, v_bot):
    items = []
    v = v_top
    pitch = min(0.033, (2 * cw - 0.02) / 4)

    def row(ids, leds):
        nonlocal v
        n = len(ids)
        for i, (sid, led) in enumerate(zip(ids, leds)):
            u = (i - (n - 1) / 2) * pitch
            items.append({'type': 'toggle', 'id': sid, 'u': u, 'v': v - 0.026, 'led': led})
        v -= 0.052
    rows = [
        (['master', 'avionics', 'pump1', 'pump2'], 0.052, lambda: row(['master', 'avionics', 'pump1', 'pump2'],
                                                                      ['g', 'g', 'g', 'g'])),
        (['light', 'strobe', 'rbrake'], 0.052, lambda: row(['light', 'strobe', 'rbrake'], ['y', 'y', 'a'])),
    ]
    for _ids, h, fn in rows:
        if v - h < v_bot:
            return items
        fn()
    # ignition key + USB
    if v - 0.05 >= v_bot:
        items.append({'type': 'key', 'u': -cw * 0.42, 'v': v - 0.026})
        items.append({'type': 'usb', 'u': cw * 0.48, 'v': v - 0.026})
        v -= 0.054
    # fuel LEDs + pneumatic pressure gauge
    if v - 0.05 >= v_bot:
        items.append({'type': 'fuel', 'u': -cw * 0.42, 'v': v - 0.026})
        items.append({'type': 'mano', 'u': cw * 0.48, 'v': v - 0.026, 'd': min(0.042, cw * 0.75)})
        v -= 0.054
    # radio and transponder
    for kind in ('com', 'xpdr'):
        if v - 0.044 >= v_bot:
            items.append({'type': kind, 'u': 0.0, 'v': v - 0.022, 'w': 2 * cw - 0.022, 'h': 0.03})
            v -= 0.046
    return items


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
def build_panel(static, p0, tilt_deg, targets, zone, cw, v_leg, v_sb, v_b, thickness=0.008, margin=0.014,
                c_v=None, top_arch=None, leg_exp=0.4, max_u=None):
    """zone = (u, v, w, h) of the live-instrument rectangle. Returns the panel_face object."""
    ensure_materials()
    F = Frame(p0, tilt_deg)
    poly = outline(F, targets, zone, cw, v_leg, v_sb, v_b, margin=margin, c_v=c_v, top_arch=top_arch,
                   leg_exp=leg_exp, max_u=max_u)
    zu, zv, zw, zh = zone
    for cu, cv in ((zu - zw / 2, zv - zh / 2), (zu + zw / 2, zv - zh / 2), (zu - zw / 2, zv + zh / 2),
                   (zu + zw / 2, zv + zh / 2)):
        if not inside(poly, cu, cv):
            print('  !! panel: instrument zone corner (%.3f, %.3f) outside the outline' % (cu, cv))
    us = [p[0] for p in poly]
    vs = [p[1] for p in poly]
    A = max(abs(min(us)), abs(max(us)))
    vmin, vmax = min(vs), max(vs)
    # --- front face (node), UVs = panel coordinates
    bm = bmesh.new()
    uv_l = bm.loops.layers.uv.new('UVMap')
    verts = [bm.verts.new(F.P(u, v)) for (u, v) in poly]
    face = bm.faces.new(verts)
    face.normal_update()
    if face.normal.dot(F.N) < 0:
        face.normal_flip()
    bmesh.ops.triangulate(bm, faces=[face], quad_method='BEAUTY', ngon_method='EAR_CLIP')
    for f in bm.faces:
        f.smooth = False
        for loop in f.loops:
            p = loop.vert.co - F.p0
            u, v = p.dot(F.U), p.dot(F.Vv)
            loop[uv_l].uv = ((u + A) / (2 * A), (v - vmin) / (vmax - vmin))
    me = bpy.data.meshes.new('panel_face')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(MATS['Panel_Face'])
    ob = bpy.data.objects.new('panel_face', me)
    bpy.context.scene.collection.objects.link(ob)
    # origin at p0 (no rotation: the build scripts clear rotations)
    me.transform(Matrix.Translation(-F.p0))
    ob.location = F.p0
    # --- body: back + edge band, rounded lip on the front edge
    n = len(poly)
    back = [F.P(u, v, -thickness) for (u, v) in poly]
    front = [F.P(u, v, -0.0004) for (u, v) in poly]
    faces = [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    static.faces(front + back, faces, 'Panel', smooth=False)
    static.faces(back, [list(range(n))[::-1]], 'Panel', smooth=False)
    edge = [F.P(u, v, -0.002) for (u, v) in poly]
    B.closed_tube(static, edge, 0.0032, 'Panel', n=6)
    # --- items
    items = console_items(cw, zv - zh / 2 - 0.012, v_b + 0.012)
    R = F.R()
    for it in items:
        u, v = it['u'], it['v']
        t = it['type']
        if t == 'toggle':
            c = F.P(u, v)
            static.cyl(c - F.N * 0.001, c + F.N * 0.0035, 0.0062, 'Metal_Frame', n=6)       # hex nut
            static.cyl(c + F.N * 0.0035, c + F.N * 0.006, 0.0038, 'Metal_Frame', n=12)     # bushing
            sw = MB('sw_' + it['id'])
            piv = c + F.N * 0.006
            tip = piv + F.N * 0.017
            sw.tube([piv - F.N * 0.002, tip], [0.0021, 0.0016], 'Metal_Frame', n=10)
            sw.sphere(tip, 0.0029, 'Metal_Frame', seg=10, rings=6)
            sw.finish(origin=piv, sharp_angle=40)
            it['pivot'] = [round(x, 5) for x in piv]
        elif t == 'key':
            c = F.P(u, v)
            static.cyl(c - F.N * 0.001, c + F.N * 0.006, 0.0145, 'Metal_Frame', n=24)
            static.cyl(c + F.N * 0.006, c + F.N * 0.0065, 0.0105, 'Btn_Black', n=20)
            k = MB('key')
            piv = c + F.N * 0.0065
            k.box(piv + F.N * 0.006, (0.003, 0.0085, 0.012), 'Metal_Frame', bevel=0.0008, segs=1, rot=R)
            k.box(piv + F.N * 0.019, (0.0045, 0.026, 0.016), 'Btn_Black', bevel=0.002, segs=2, rot=R)   # bow upright = OFF
            k.finish(origin=piv, sharp_angle=40)
        elif t == 'usb':
            c = F.P(u, v, 0.002)
            static.box(c, (0.026, 0.020, 0.005), 'Btn_Black', bevel=0.002, segs=1, rot=R)
            for sv in (0.0045, -0.0045):
                static.box(F.P(u, v + sv, 0.0045), (0.012, 0.0045, 0.0012), 'Metal_Frame', bevel=0.0004, segs=1,
                           rot=R)
        elif t == 'mano':
            c = F.P(u, v)
            r = it['d'] / 2
            static.lathe([(r * 0.86, 0.0), (r * 1.08, 0.0), (r * 1.08, 0.006), (r * 0.98, 0.008), (r * 0.86, 0.007)],
                         c, F.N, 'Metal_Frame', n=28, closed_profile=True)
        elif t in ('com', 'xpdr'):
            # bezel round the display (drawn by the sim) + two knobs
            w, h = it['w'], it['h']
            c = F.P(u, v)
            for (du, dv, sw_, sh_) in ((0, h / 2 + 0.002, w + 0.006, 0.004), (0, -h / 2 - 0.002, w + 0.006, 0.004),
                                      (-w / 2 - 0.002, 0, 0.004, h), (w / 2 + 0.002, 0, 0.004, h)):
                static.box(F.P(u + du, v + dv, 0.002), (sw_, sh_, 0.004), 'Btn_Black', bevel=0.001, segs=1, rot=R)
            for ku in (-w / 2 + 0.009, w / 2 - 0.009):
                kc = F.P(u + ku, v - h * 0.18)
                static.cyl(kc, kc + F.N * 0.010, 0.0062, 'Btn_Black', n=14)
                static.cyl(kc + F.N * 0.010, kc + F.N * 0.011, 0.005, 'Metal_Frame', n=12)
    layout = {
        'p0': [round(x, 5) for x in F.p0], 'tilt': tilt_deg, 'A': round(A, 5), 'vmin': round(vmin, 5),
        'vmax': round(vmax, 5), 'zone': [round(x, 5) for x in zone],
        'outline': [[round(u, 4), round(v, 4)] for (u, v) in poly], 'items': items,
    }
    ob['layout'] = json.dumps(layout, separators=(',', ':'))
    print('  panel: %d outline points, A=%.3f v %.3f..%.3f, %d items: %s' % (
        len(poly), A, vmin, vmax, len(items), ' '.join(i.get('id', i['type']) for i in items)))
    return ob, F, poly
