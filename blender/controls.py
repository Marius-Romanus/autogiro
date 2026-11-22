"""
Cockpit controls shared by the gyro build scripts (generic, ELA 07, ELA 10, Cierva C.30A).

Moving parts are separate root nodes with their origin on the pivot; src/aircraft/AircraftView.ts
animates them from the controls:
  stick           centre stick, floor pivot (pitch and roll)
  throttle        lever in a quadrant on the left wall, pivot in the quadrant. Drawn at IDLE (lever
                  back); full power = THROTTLE_TRAVEL degrees forward
  throttle_brake  wheel-brake lever on the throttle handle, squeezed back toward it; the sim parents
                  it to `throttle`
  pedal_L/R       hinged rudder pedals under the pilot's boots, hinge on the lateral axis
The front pilot's hands and boots follow these nodes (pilot.build_pilot(..., rig=True)).
Blender axes: +X forward, +Y left, +Z up. Metres.
"""
import math
from mathutils import Vector, Matrix
import build_autogiro as B

MB, MATS, V = B.MB, B.MATS, B.V
THROTTLE_IDLE = 25.0     # deg aft of vertical at idle (as drawn)
THROTTLE_TRAVEL = 50.0   # deg idle -> full; keep in sync with AircraftView.ts


def ensure_materials():
    def mk(name, hexcol, **kw):
        if name not in MATS:
            B.make_mat(name, B.srgb(hexcol), **kw)
    mk('Btn_Red', '#B3141C', rough=0.35)
    mk('Btn_Black', '#0C0D0F', rough=0.45)
    mk('Grip_Rubber', '#1B1C1E', rough=0.8)
    mk('Rubber', '#141414', rough=0.88)
    mk('Metal_Frame', '#C9CCD0', metal=1.0, rough=0.24)
    mk('Panel', '#0E0F10', rough=0.72)


def basis(x, y, z, origin=None):
    """4x4 matrix whose columns are x, y, z (unit vectors), translated to origin."""
    m = Matrix((x, y, z)).transposed().to_4x4()
    if origin is not None:
        m.translation = origin
    return m


# ---------------------------------------------------------------------------
# Centre stick
# ---------------------------------------------------------------------------
def gyro_stick(base, top, name='stick'):
    """Stick from its floor pivot `base` to the top of the grip `top`. Contoured grip with a 4-way
    trim hat, an intercom button, a thumb button (pre-rotator) and a red push-to-talk trigger.
    Returns (object, hand point, grip axis) for pilot.build_pilot."""
    ensure_materials()
    mb = MB(name)
    base, top = Vector(base), Vector(top)
    d = (top - base).normalized()
    fwd = (V(1, 0, 0) - d * d.x).normalized()
    lat = d.cross(fwd).normalized()                    # +Y: the pilot's left
    # corrugated rubber boot over the floor pivot
    boot = [(0.0, 0.0), (0.050, 0.0), (0.050, 0.010), (0.043, 0.020), (0.046, 0.030), (0.037, 0.042),
            (0.040, 0.052), (0.030, 0.064), (0.032, 0.074), (0.022, 0.086), (0.014, 0.096), (0.0, 0.098)]
    mb.lathe(boot, base, d, 'Rubber', n=20)
    head_h = 0.034
    g0 = top - d * (0.100 + head_h)                    # bottom of the handle
    mb.cyl(base, g0 + d * 0.012, 0.011, 'Metal_Frame', n=12)
    mb.lathe([(0.0, -0.004), (0.0145, -0.004), (0.0145, 0.004), (0.0, 0.004)], g0, d, 'Metal_Frame', n=16)
    # handle: slightly barrel-shaped, four finger ridges on the front
    prof = [(0.0, 0.0), (0.0165, 0.0), (0.0185, 0.006)]
    for k in range(4):
        h = 0.014 + k * 0.021
        prof += [(0.0177, h), (0.0193, h + 0.0105)]
    prof += [(0.0186, 0.098), (0.0175, 0.104), (0.012, 0.114), (0.0, 0.114)]
    mb.lathe(prof, g0, d, 'Grip_Rubber', n=20)
    # head, tipped 12 deg forward
    tilt = math.radians(12)
    hu = (d * math.cos(tilt) + fwd * math.sin(tilt)).normalized()
    hf = lat.cross(hu).normalized()
    hc = g0 + d * (0.100 + head_h * 0.5) + fwd * 0.006
    R = basis(hf, lat, hu)
    mb.box(hc, (0.048, 0.040, head_h), 'Grip_Rubber', bevel=0.013, segs=3, rot=R)

    def P(x, y, z):
        return hc + hf * x + lat * y + hu * z
    top_z = head_h * 0.5
    # 4-way trim hat under the thumb (top, aft)
    hat = P(-0.008, 0.0, top_z)
    mb.cyl(hat - hu * 0.003, hat + hu * 0.004, 0.0105, 'Btn_Black', n=18)
    mb.box(hat + hu * 0.0055, (0.017, 0.0045, 0.003), 'Btn_Black', bevel=0.001, segs=1, rot=R)
    mb.box(hat + hu * 0.0055, (0.0045, 0.017, 0.003), 'Btn_Black', bevel=0.001, segs=1, rot=R)
    mb.sphere(hat + hu * 0.0075, 0.0034, 'Metal_Frame', seg=10, rings=6)
    # intercom button (top, front)
    ic = P(0.014, -0.006, top_z)
    mb.cyl(ic - hu * 0.003, ic + hu * 0.003, 0.0055, 'Btn_Black', n=12)
    mb.cyl(ic - hu * 0.003, ic + hu * 0.0015, 0.0075, 'Metal_Frame', n=12)
    # thumb button on the left face (pre-rotator)
    tb = P(-0.004, 0.020, 0.002)
    mb.cyl(tb - lat * 0.003, tb + lat * 0.0045, 0.0065, 'Btn_Black', n=14)
    mb.cyl(tb - lat * 0.003, tb + lat * 0.002, 0.0085, 'Metal_Frame', n=14)
    # push-to-talk trigger in front, under the head (index finger)
    tr = g0 + d * 0.087 + fwd * 0.021
    mb.box(tr, (0.011, 0.017, 0.022), 'Btn_Red', bevel=0.0035, segs=2, rot=basis(fwd, lat, d))
    ob = mb.finish(origin=base, sharp_angle=40)
    return ob, g0 + d * 0.050, d


# ---------------------------------------------------------------------------
# Throttle quadrant (left wall) with the wheel-brake lever on the handle
# ---------------------------------------------------------------------------
def throttle_lever(static, pivot, length=0.12, brake=True):
    """Quadrant housing into `static`; nodes `throttle` (+ `throttle_brake`). Returns the knob
    (hand target, lever at idle) and the lever axis."""
    ensure_materials()
    pivot = Vector(pivot)
    a = math.radians(THROTTLE_IDLE)
    up = V(-math.sin(a), 0, math.cos(a))               # lever direction at idle (top aft)
    fw = V(math.cos(a), 0, math.sin(a))
    # housing: slotted box, rubber slot seal, friction knob inboard, end stops
    static.box(pivot + V(0, 0, -0.012), (0.20, 0.042, 0.05), 'Panel', bevel=0.012, segs=2)
    static.box(pivot + V(0, 0, 0.0135), (0.17, 0.012, 0.002), 'Rubber', bevel=0.0008, segs=1)
    static.cyl(pivot + V(0.065, -0.020, -0.012), pivot + V(0.065, -0.034, -0.012), 0.0095, 'Btn_Black', n=14)
    static.cyl(pivot + V(0.065, -0.034, -0.012), pivot + V(0.065, -0.037, -0.012), 0.006, 'Metal_Frame', n=10)
    for sx in (-1, 1):
        static.box(pivot + V(sx * 0.088, 0, 0.016), (0.008, 0.016, 0.006), 'Metal_Frame', bevel=0.001, segs=1)
    mb = MB('throttle')
    knob = pivot + up * length
    mb.cyl(pivot + V(0, -0.012, 0), pivot + V(0, 0.012, 0), 0.011, 'Metal_Frame', n=14)
    mb.cyl(pivot, knob - up * 0.02, 0.0065, 'Metal_Frame', n=10)
    mb.lathe([(0.0, 0.0), (0.011, 0.0), (0.0165, 0.012), (0.0178, 0.030), (0.0168, 0.046), (0.011, 0.054),
              (0.0, 0.056)], knob - up * 0.026, up, 'Btn_Black', n=18)
    mb.finish(origin=pivot, sharp_angle=40)
    if brake:
        bb = MB('throttle_brake')
        bp = knob - up * 0.036 + fw * 0.019            # pivot just under the handle, in front
        mid = bp - up * 0.035 + fw * 0.013
        tip = bp - up * 0.088 + fw * 0.026
        bb.cyl(bp - V(0, 0.009, 0), bp + V(0, 0.009, 0), 0.0055, 'Metal_Frame', n=10)
        bb.box(bp - fw * 0.008, (0.018, 0.010, 0.012), 'Metal_Frame', bevel=0.002, segs=1,
               rot=basis(fw, V(0, 1, 0), up))
        bb.tube(B.catmull([bp, mid, tip], 4), 0.0, 'Btn_Red', n=8, square=(0.013, 0.006, 4.0), cap=True)
        bb.sphere(tip, 0.0062, 'Btn_Red', seg=10, rings=6)
        bb.finish(origin=bp, sharp_angle=40)
    return knob, up


# ---------------------------------------------------------------------------
# Hinged rudder pedals under the pilot's boots
# ---------------------------------------------------------------------------
def pedals(static, joints, floor_z, plate_len=0.15, plate_w=0.10):
    """`joints`: pilot.JOINTS[name] of a pilot built with rig=True. Each plate lies under the ball of
    the boot, parallel to the sole; the hinge sits below its heel end, on a cross tube bolted to the
    floor (into `static`). Nodes pedal_L / pedal_R, origin on the hinge."""
    ensure_materials()
    hinges = {}
    for s, sy in (('L', 1), ('R', -1)):
        ank, f, u = joints['ankle'][s], joints['foot_dir'][s], joints['foot_up'][s]
        lat = u.cross(f).normalized()
        # sole under the ball of the foot (boot ellipsoid: centre ankle + f*0.07 - Z*0.045, half-height 0.04)
        c = ank + f * 0.105 - V(0, 0, 0.045) - u * 0.0405
        pc = c - u * 0.004                             # plate centre (8 mm plate)
        h = pc - f * (plate_len * 0.5 + 0.02) - u * 0.03
        h.z = max(h.z, floor_z + 0.03)
        hinges[s] = h
        mb = MB('pedal_' + s)
        R = basis(f, lat, u)
        mb.box(pc, (plate_len, plate_w, 0.008), 'Metal_Frame', bevel=0.003, segs=1, rot=R)
        # toe lip and rubber treads
        mb.box(pc + f * (plate_len * 0.5 - 0.004) + u * 0.009, (0.008, plate_w, 0.022), 'Metal_Frame',
               bevel=0.003, segs=1, rot=R)
        for k in range(4):
            mb.box(pc + f * (-0.045 + k * 0.03) + u * 0.0045, (0.012, plate_w - 0.016, 0.002), 'Rubber',
                   bevel=0.0007, segs=1, rot=R)
        # arm from the hinge to the back of the plate, hinge tube
        back = pc - u * 0.006
        for k in (-1, 1):
            o = lat * (k * (plate_w * 0.5 - 0.012))
            mb.tube([h + o, back - f * 0.03 + o, back + f * 0.02 + o], 0.0, 'Metal_Frame', n=8,
                    square=(0.006, 0.018, 4.0), cap=True)
        mb.cyl(h + lat * (plate_w * 0.5 + 0.004), h - lat * (plate_w * 0.5 + 0.004), 0.011, 'Metal_Frame', n=14)
        # cable eye at the outer side
        mb.cyl(back + lat * (plate_w * 0.5 + 0.002) * sy - f * 0.02,
               back + lat * (plate_w * 0.5 + 0.012) * sy - f * 0.02, 0.006, 'Metal_Frame', n=8)
        mb.finish(origin=h, sharp_angle=40)
    # cross tube (axle) through both hinges and two floor brackets per pedal
    hl, hr = hinges['L'], hinges['R']
    static.cyl(hl + V(0, 0.07, 0), hr - V(0, 0.07, 0), 0.0075, 'Metal_Frame', n=12)
    for h, sy in ((hl, 1), (hr, -1)):
        for k in (-1, 1):
            p = h + V(0, k * (plate_w * 0.5 + 0.02), 0)
            static.box(V(p.x, p.y, (p.z + floor_z) * 0.5), (0.035, 0.008, p.z - floor_z + 0.03), 'Metal_Frame',
                       bevel=0.002, segs=1)
        static.box(V(h.x, h.y, floor_z + 0.003), (0.07, plate_w + 0.06, 0.006), 'Metal_Frame', bevel=0.002,
                   segs=1)
    return hinges


def rig_nodes(name='pilot_front'):
    """Root nodes of a pilot built with rig=True (for the build scripts' REQUIRED checks)."""
    out = {}
    for s in ('L', 'R'):
        for part in ('arm%s_up', 'arm%s_lo', 'hand%s', 'leg%s_up', 'leg%s_lo', 'foot%s'):
            out[name + '_' + part % s] = None
    return out
