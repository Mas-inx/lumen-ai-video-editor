"""
Lumen's Blender render runner.

Runs inside `blender -b --factory-startup -P runner.py -- spec.json`, builds a
scene from a template (or from AI-written bpy code), renders it to a PNG
sequence and reports progress on stdout as `LUMEN {json}` lines.

Templates animate through a plain `animate(t)` function that is baked to
keyframes, so Blender's motion blur sees the movement.
"""
import json
import math
import os
import random
import sys
import traceback

import bmesh
import bpy
from mathutils import Vector


def emit(kind, **data):
    data["type"] = kind
    sys.stdout.write("LUMEN " + json.dumps(data) + "\n")
    sys.stdout.flush()


ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
with open(ARGS[0], encoding="utf-8") as fh:
    SPEC = json.load(fh)

P = SPEC.get("params") or {}
W = int(SPEC["width"])
H = int(SPEC["height"])
FPS = max(1, int(round(SPEC["fps"])))
DURATION = float(SPEC["duration"])
FRAMES = max(1, int(round(DURATION * FPS)))
OUT = SPEC["out"]
QUALITY = SPEC.get("quality") or "standard"
TRANSPARENT = bool(SPEC.get("transparent", True))
FONTS = SPEC.get("fonts") or {}

scene = bpy.context.scene


# ─── Helpers (also available to AI-written scripts) ──────────────────────────

def clamp01(x):
    return max(0.0, min(1.0, x))


def lerp(a, b, t):
    return a + (b - a) * t


def ease_out_cubic(x):
    x = clamp01(x)
    return 1 - (1 - x) ** 3


def ease_in_out(x):
    x = clamp01(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out_back(x, s=1.4):
    x = clamp01(x)
    return 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2


def ease_out_elastic(x):
    x = clamp01(x)
    if x in (0.0, 1.0):
        return x
    return 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * (2 * math.pi) / 3) + 1


def hex_color(value, fallback=(1.0, 1.0, 1.0)):
    """'#rrggbb' → linear RGB, which is what Blender colour sockets expect."""
    try:
        s = str(value).strip().lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        rgb = [int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    except (ValueError, TypeError):
        return fallback

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(lin(c) for c in rgb)


def set_input(node, names, value):
    """Principled inputs were renamed across versions; try each name."""
    for name in names if isinstance(names, (list, tuple)) else [names]:
        sock = node.inputs.get(name)
        if sock is not None:
            sock.default_value = value
            return sock
    return None


def principled(name, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.4, coat=0.0, emission=None, strength=0.0, transmission=0.0, ior=1.45):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, "Base Color", (*color[:3], 1.0))
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, ["Coat Weight", "Clearcoat"], coat)
    set_input(bsdf, ["Transmission Weight", "Transmission"], transmission)
    set_input(bsdf, "IOR", ior)
    if emission is not None:
        set_input(bsdf, ["Emission Color", "Emission"], (*emission[:3], 1.0))
        set_input(bsdf, "Emission Strength", strength)
    return mat, bsdf


def ramp_base_color(mat, bsdf, stops, axis="Y"):
    """Paints a vertical colour ramp into Base Color (object-space), the classic banded chrome/gold look."""
    nt = mat.node_tree
    coords = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(coords.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs[axis], ramp.inputs["Fac"])
    elems = ramp.color_ramp.elements
    while len(elems) > 1:
        elems.remove(elems[-1])
    for i, (pos, col) in enumerate(stops):
        el = elems[0] if i == 0 else elems.new(pos)
        el.position = pos
        el.color = (*col, 1.0)
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    return ramp


def material_preset(kind, color_hex=None):
    kind = (kind or "chrome").lower()
    color = hex_color(color_hex or "#ffffff")
    if kind == "gold":
        mat, bsdf = principled("Gold", (1.0, 0.71, 0.29), metallic=1.0, roughness=0.16)
        ramp_base_color(mat, bsdf, [(0.0, (0.55, 0.3, 0.07)), (0.45, (1.0, 0.7, 0.26)), (0.52, (0.42, 0.22, 0.04)), (0.8, (1.0, 0.76, 0.36)), (1.0, (1.0, 0.86, 0.52))])
    elif kind == "glass":
        mat, _ = principled("Glass", color, roughness=0.02, transmission=1.0, ior=1.45)
        for attr, value in (("use_raytrace_refraction", True), ("surface_render_method", "BLENDED")):
            try:
                setattr(mat, attr, value)
            except (AttributeError, TypeError):
                pass
    elif kind == "neon":
        mat, _ = principled("Neon", tuple(c * 0.2 for c in color), roughness=0.3, emission=color, strength=9.0)
    elif kind in ("plastic", "clay", "matte"):
        rough = {"plastic": 0.28, "clay": 0.75, "matte": 0.55}[kind]
        mat, _ = principled(kind.title(), color, roughness=rough, coat=0.6 if kind == "plastic" else 0.0)
    else:  # chrome
        mat, bsdf = principled("Chrome", (0.92, 0.93, 0.95), metallic=1.0, roughness=0.07)
        ramp_base_color(mat, bsdf, [(0.0, (0.35, 0.37, 0.42)), (0.46, (0.95, 0.96, 1.0)), (0.5, (0.12, 0.13, 0.16)), (0.7, (0.55, 0.58, 0.66)), (1.0, (1.0, 1.0, 1.0))])
    return mat


def studio_world(strength=1.3, visible_color=None):
    """Dark dome, hot horizon band and a floor: what metal needs to reflect."""
    world = bpy.data.worlds.new("Studio")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    coords = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    # World "Generated" is the view direction (-1..1); map elevation onto the ramp's 0..1.
    remap = nt.nodes.new("ShaderNodeMapRange")
    remap.inputs["From Min"].default_value = -1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(coords.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], remap.inputs["Value"])
    nt.links.new(remap.outputs["Result"], ramp.inputs["Fac"])
    # Elevation ramp (0.5 = horizon). Upright letter faces seen from slightly
    # above reflect just below the horizon, so that band is kept bright.
    elems = ramp.color_ramp.elements
    elems[0].position, elems[0].color = 0.0, (0.015, 0.015, 0.02, 1)
    elems[1].position, elems[1].color = 0.3, (0.08, 0.085, 0.1, 1)
    for pos, col in ((0.43, (0.42, 0.43, 0.47, 1)), (0.49, (1.0, 1.0, 1.0, 1)), (0.515, (0.92, 0.94, 1.0, 1)), (0.6, (0.3, 0.32, 0.4, 1)), (1.0, (0.05, 0.055, 0.075, 1))):
        el = elems.new(pos)
        el.color = col
    bg.inputs["Strength"].default_value = strength
    if visible_color is not None:
        # Opaque renders: what the camera sees is a flat colour, reflections still see the studio.
        light_path = nt.nodes.new("ShaderNodeLightPath")
        flat = nt.nodes.new("ShaderNodeBackground")
        flat.inputs["Color"].default_value = (*visible_color, 1)
        mix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(light_path.outputs["Is Camera Ray"], mix.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
        nt.links.new(bg.outputs[0], mix.inputs[1])
        nt.links.new(flat.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs["Surface"])
    else:
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
        nt.links.new(bg.outputs[0], out.inputs["Surface"])
    return world


def add_light(kind, location, energy, size=2.0, color=(1, 1, 1), target=(0, 0, 0)):
    data = bpy.data.lights.new(f"{kind.title()}Light", kind.upper())
    data.energy = energy
    data.color = color
    if kind.upper() == "AREA":
        data.size = size
    obj = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    look_at(obj, target)
    return obj


def look_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_camera(location=(0, -10, 0), target=(0, 0, 0), lens=50.0):
    data = bpy.data.cameras.new("Camera")
    data.lens = lens
    data.clip_end = 1000
    cam = bpy.data.objects.new("Camera", data)
    scene.collection.objects.link(cam)
    cam.location = location
    look_at(cam, target)
    scene.camera = cam
    return cam


def load_font(name):
    path = FONTS.get(name or "sans") or (name if name and os.path.exists(str(name)) else None)
    if path:
        try:
            return bpy.data.fonts.load(path, check_existing=True)
        except (RuntimeError, OSError):
            pass
    return None


TRACKS = []


def track(owner, *paths):
    """Registers properties that animate() changes, so they get baked to keyframes."""
    for path in paths:
        TRACKS.append((owner, path))


def bake(animate):
    for frame in range(1, FRAMES + 1):
        animate((frame - 1) / FPS)
        for owner, path in TRACKS:
            owner.keyframe_insert(data_path=path, frame=frame)


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def configure_render(transparent):
    r = scene.render
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            r.engine = engine
            break
        except TypeError:
            continue
    r.resolution_x, r.resolution_y, r.resolution_percentage = W, H, 100
    r.fps = FPS
    r.film_transparent = transparent
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA" if transparent else "RGB"
    r.image_settings.compression = 15
    r.use_lock_interface = True
    r.use_motion_blur = QUALITY != "draft"
    r.motion_blur_shutter = 0.45
    scene.frame_start = 1
    scene.frame_end = FRAMES
    ee = scene.eevee
    for attr, value in (
        ("taa_render_samples", {"draft": 8, "standard": 24, "high": 64}.get(QUALITY, 24)),
        ("use_raytracing", QUALITY != "draft"),
        ("use_shadows", True),
        ("shadow_ray_count", 2 if QUALITY == "high" else 1),
        ("use_fast_gi", QUALITY != "draft"),
        ("motion_blur_steps", 2 if QUALITY == "high" else 1),
    ):
        try:
            setattr(ee, attr, value)
        except (AttributeError, TypeError):
            pass
    vs = scene.view_settings
    try:
        vs.view_transform = "AgX"
    except TypeError:
        pass
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            vs.look = look
            break
        except TypeError:
            continue


# ─── Templates ───────────────────────────────────────────────────────────────

def template_title3d():
    """Extruded, bevelled title with a studio-lit material and an intro move."""
    text = str(P.get("text") or "LUMEN")
    curve = bpy.data.curves.new("Title", "FONT")
    curve.body = text.upper() if P.get("uppercase") else text
    font = load_font(P.get("font", "sans"))
    if font:
        curve.font = font
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = 1.0
    curve.space_character = 1.0 + float(P.get("tracking", 0.02))
    curve.space_line = 0.9
    depth = float(P.get("depth", 0.35))
    curve.extrude = 0.015 + depth * 0.22
    if P.get("bevel", True):
        curve.bevel_depth = 0.014
        curve.bevel_resolution = 4
    curve.resolution_u = 10
    curve.materials.append(material_preset(P.get("material"), P.get("color")))

    title = bpy.data.objects.new("Title", curve)
    rig = bpy.data.objects.new("Rig", None)
    scene.collection.objects.link(rig)
    scene.collection.objects.link(title)
    title.parent = rig
    title.rotation_euler = (math.radians(90), 0, 0)  # stand the text up, facing -Y
    bpy.context.view_layer.update()
    width = max(0.5, title.dimensions.x)
    height = max(0.3, title.dimensions.y)

    # Frame so the title spans ~66% of the width (or 60% of the height).
    cam = add_camera(lens=50)
    fov = 2 * math.atan(18 / cam.data.lens)
    vis_w = width / 0.66
    vis_h = height / 0.6 * (W / H)
    dist = max(vis_w, vis_h) / (2 * math.tan(fov / 2))
    elevation = math.radians(float(P.get("elevation", 6)))
    cam.location = (0, -dist * math.cos(elevation), dist * math.sin(elevation))
    look_at(cam, (0, 0, 0))

    studio_world(strength=1.0)
    add_light("AREA", (-dist * 0.5, -dist * 0.8, dist * 0.6), 180 * dist ** 2 / 25, size=dist * 0.5)
    add_light("AREA", (dist * 0.6, dist * 0.4, dist * 0.2), 120 * dist ** 2 / 25, size=dist * 0.3, color=(0.75, 0.82, 1.0))
    add_light("AREA", (0, -dist, -dist * 0.4), 40 * dist ** 2 / 25, size=dist)

    motion = str(P.get("motion", "spin")).lower()
    intro = min(1.4, DURATION * 0.45)
    track(rig, "location", "rotation_euler", "scale")
    track(cam, "location", "rotation_euler")
    base_cam = cam.location.copy()

    def animate(t):
        k = clamp01(t / intro)
        idle = t - intro
        rig.location = (0, 0, 0)
        rig.rotation_euler = (0, 0, 0)
        rig.scale = (1, 1, 1)
        cam.location = base_cam
        if motion == "spin":
            e = ease_out_back(k, 1.2)
            rig.rotation_euler = (0, 0, math.radians(lerp(-110, 0, e)))
            s = lerp(0.35, 1.0, ease_out_cubic(k))
            rig.scale = (s, s, s)
            rig.location = (0, lerp(dist * 0.6, 0, ease_out_cubic(k)), 0)
        elif motion == "rise":
            e = ease_out_cubic(k)
            rig.location = (0, 0, lerp(-height * 2.2, 0, e))
            rig.rotation_euler = (math.radians(lerp(-80, 0, e)), 0, 0)
        elif motion == "slam":
            e = ease_out_back(clamp01(t / (intro * 0.5)), 2.2)
            s = lerp(3.2, 1.0, e)
            rig.scale = (s, s, s)
            shake = math.exp(-max(0.0, t - intro * 0.5) * 6) * (t > intro * 0.45)
            cam.location = base_cam + Vector((math.sin(t * 71) * 0.03, 0, math.cos(t * 63) * 0.03)) * shake * dist
        elif motion == "orbit":
            a = math.radians(lerp(-38, 38, ease_in_out(t / max(0.01, DURATION))))
            r = base_cam.length
            cam.location = (math.sin(a) * r * math.cos(elevation), -math.cos(a) * r * math.cos(elevation), base_cam.z)
        look_at(cam, (0, 0, 0))
        if motion != "orbit" and idle > 0:
            # Settle into a slow, breathing float.
            rz, rx = rig.rotation_euler.z, rig.rotation_euler.x
            rig.rotation_euler = (rx + math.radians(math.sin(idle * 0.7) * 3), 0, rz + math.radians(math.sin(idle * 0.5) * 6))

    bake(animate)


def template_shapes():
    """A seamless-looping abstract background: glossy forms drifting through soft depth of field."""
    palettes = {
        "aurora": ["#7cf7ff", "#8b5cf6", "#22d3ee", "#34d399", "#1e1b4b"],
        "sunset": ["#fb923c", "#f472b6", "#facc15", "#ef4444", "#7c2d12"],
        "candy": ["#f9a8d4", "#a78bfa", "#93c5fd", "#fde68a", "#fbcfe8"],
        "mono": ["#f4f4f5", "#a1a1aa", "#52525b", "#27272a", "#e4e4e7"],
        "ocean": ["#38bdf8", "#0ea5e9", "#1d4ed8", "#a5f3fc", "#0f172a"],
    }
    palette = P.get("palette") or "aurora"
    colors = [hex_color(c) for c in (palette if isinstance(palette, list) else palettes.get(str(palette), palettes["aurora"]))]
    style = str(P.get("style", "mix")).lower()
    count = int(P.get("count", 16))
    speed = float(P.get("speed", 1.0))
    rng = random.Random(int(P.get("seed", 7)))
    bg = hex_color(P.get("background") or "#07070b")

    studio_world(strength=0.8, visible_color=bg)
    cam = add_camera(location=(0, -14, 0), lens=45)
    cam.data.dof.use_dof = True
    cam.data.dof.focus_distance = 14
    cam.data.dof.aperture_fstop = 1.8
    add_light("AREA", (-6, -8, 7), 2600, size=6)
    add_light("AREA", (7, 4, 3), 1400, size=4, color=colors[0])
    add_light("AREA", (0, 6, -5), 900, size=5, color=colors[1 % len(colors)])

    mats = []
    for i, c in enumerate(colors):
        glow = i == 0 and style != "mono"
        m, _ = principled(f"Shape{i}", c, metallic=0.0 if i % 2 else 0.35, roughness=0.18 + 0.1 * (i % 3), coat=0.8, emission=c if glow else None, strength=2.5 if glow else 0.0)
        mats.append(m)

    kinds = {"blobs": ["sphere"], "rings": ["torus"], "cubes": ["cube"]}.get(style, ["sphere", "torus", "cube", "sphere"])
    shapes = []
    for i in range(count):
        kind = kinds[i % len(kinds)]
        if kind == "sphere":
            mesh = bpy.data.meshes.new("Sphere")
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=1.0)
            bm.to_mesh(mesh)
            bm.free()
        elif kind == "torus":
            mesh = bpy.data.meshes.new("Torus")
            bm = bmesh.new()
            major, minor, seg_u, seg_v = 1.0, 0.32, 64, 24
            verts = []
            for a in range(seg_u):
                ta = a / seg_u * 2 * math.pi
                ring = []
                for b in range(seg_v):
                    tb = b / seg_v * 2 * math.pi
                    ring.append(bm.verts.new(((major + minor * math.cos(tb)) * math.cos(ta), (major + minor * math.cos(tb)) * math.sin(ta), minor * math.sin(tb))))
                verts.append(ring)
            for a in range(seg_u):
                for b in range(seg_v):
                    bm.faces.new((verts[a][b], verts[(a + 1) % seg_u][b], verts[(a + 1) % seg_u][(b + 1) % seg_v], verts[a][(b + 1) % seg_v]))
            bm.to_mesh(mesh)
            bm.free()
        else:
            mesh = bpy.data.meshes.new("Cube")
            bm = bmesh.new()
            bmesh.ops.create_cube(bm, size=1.4)
            bm.to_mesh(mesh)
            bm.free()
        for poly in mesh.polygons:
            poly.use_smooth = True
        mesh.materials.append(mats[rng.randrange(len(mats))])
        obj = bpy.data.objects.new(kind.title(), mesh)
        scene.collection.objects.link(obj)
        if kind == "cube":
            bevel = obj.modifiers.new("Bevel", "BEVEL")
            bevel.width = 0.28
            bevel.segments = 6
        size = rng.uniform(0.35, 1.25)
        home = Vector((rng.uniform(-7.5, 7.5), rng.uniform(-6, 8), rng.uniform(-4.2, 4.2)))
        obj.scale = (size, size, size)
        shapes.append({
            "obj": obj,
            "home": home,
            "amp": Vector((rng.uniform(0.3, 1.1), rng.uniform(0.3, 1.4), rng.uniform(0.3, 1.0))),
            "phase": rng.uniform(0, math.tau),
            "spin": Vector((rng.choice([-1, 1]) * rng.randint(0, 1), rng.choice([-1, 1]), rng.choice([-1, 1]) * rng.randint(0, 1))),
            "rot0": Vector((rng.uniform(0, math.tau), rng.uniform(0, math.tau), rng.uniform(0, math.tau))),
        })
        track(obj, "location", "rotation_euler")
    track(cam, "location", "rotation_euler")

    cycles = max(1, int(round(speed)))

    def animate(t):
        # Every motion completes whole cycles over the clip, so the render loops seamlessly.
        w = 2 * math.pi * cycles * t / DURATION
        for s in shapes:
            ph = s["phase"]
            s["obj"].location = s["home"] + Vector((math.sin(w + ph) * s["amp"].x, math.sin(w + ph * 1.3) * s["amp"].y, math.cos(w + ph) * s["amp"].z))
            s["obj"].rotation_euler = s["rot0"] + s["spin"] * w
        cam.location = (math.sin(w) * 0.8, -14 + math.sin(w * 2) * 0.6, math.cos(w) * 0.5)
        look_at(cam, (0, 0, 0))

    bake(animate)


def template_script():
    """AI-written bpy code. It may build anything; defining animate(t, frame) animates it per frame."""
    code = SPEC.get("script") or ""
    namespace = {
        "bpy": bpy, "math": math, "random": random, "Vector": Vector, "scene": scene,
        "P": P, "W": W, "H": H, "FPS": FPS, "FRAMES": FRAMES, "DURATION": DURATION,
        "hex_color": hex_color, "principled": principled, "material_preset": material_preset,
        "studio_world": studio_world, "add_light": add_light, "add_camera": add_camera, "look_at": look_at,
        "load_font": load_font, "ease_out_cubic": ease_out_cubic, "ease_in_out": ease_in_out,
        "ease_out_back": ease_out_back, "ease_out_elastic": ease_out_elastic, "lerp": lerp, "clamp01": clamp01,
        "track": track, "__name__": "lumen_script",
    }
    exec(compile(code, "lumen_script.py", "exec"), namespace)
    if scene.camera is None:
        add_camera()
    if scene.world is None:
        studio_world()
    if not any(o.type == "LIGHT" for o in scene.objects):
        add_light("AREA", (-4, -6, 6), 1200, size=4)
    return namespace.get("animate")


# ─── Main ────────────────────────────────────────────────────────────────────

def render_animation(per_frame=None):
    os.makedirs(OUT, exist_ok=True)
    scene.render.filepath = os.path.join(OUT, "frame_")
    if per_frame is None:
        def on_write(sc, *_):
            emit("frame", frame=sc.frame_current, total=FRAMES)
        bpy.app.handlers.render_write.append(on_write)
        bpy.ops.render.render(animation=True)
        return
    # Script-driven animation: step frames ourselves so animate() can touch anything.
    for frame in range(1, FRAMES + 1):
        scene.frame_set(frame)
        per_frame((frame - 1) / FPS, frame)
        scene.render.filepath = os.path.join(OUT, "frame_%04d" % frame)
        bpy.ops.render.render(write_still=True)
        emit("frame", frame=frame, total=FRAMES)


def main():
    template = SPEC.get("template", "title3d")
    clear_scene()
    configure_render(TRANSPARENT)
    emit("status", message="Building scene")
    per_frame = None
    if template == "title3d":
        template_title3d()
    elif template == "shapes":
        template_shapes()
    elif template == "script":
        per_frame = template_script()
    else:
        raise ValueError("Unknown template: %s" % template)
    emit("status", message="Rendering")
    render_animation(per_frame)
    emit("done", frames=FRAMES)


try:
    main()
except Exception as exc:  # noqa: BLE001 — report anything to Lumen, then fail the process
    emit("error", message="%s: %s" % (type(exc).__name__, exc), trace=traceback.format_exc()[-2000:])
    sys.exit(1)
