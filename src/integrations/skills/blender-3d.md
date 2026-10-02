---
name: blender-3d
description: Use for anything rendered in Blender — 3D titles, 3D backgrounds, product shots, abstract loops and custom bpy scenes (render_3d_title, render_3d_background, render_blender_script, blender_live) — so 3D looks lit and shot by a professional, not like a default render.
---

# Blender 3D that looks professional

The generic 3D look has these tells:
- default grey studio light;
- plastic materials with no roughness variation;
- a camera dead-centre at eye height;
- objects spinning for no reason;
- glossy blobs in rainbow gradients;
- everything perfectly clean.

Avoid them unless the brief asks. The motion-design-craft rules (typography, easing by role, holds, cutting to the beat) apply to 3D as well.

## Choose the right tool

- **render_3d_title:** extruded type. Choose:
  - material: matte, clay and metal read premium; neon only when it suits the film;
  - colour, taken from the footage or brand;
  - font: `serif` and `serif-italic` for elegance, `display` for energy;
  - motion: `rise` and `float` are calm, `slam` hits a beat, `orbit` and `spin` are showy;
  - depth: 0.15–0.35 looks refined, deeper looks heavy.

  Keep the text short (1–4 words).
- **render_3d_background:** looping backgrounds. Prefer the `mono` palette or a palette sampled from the film over `aurora` and `candy`. Slow speed. Use them behind titles, not as decoration everywhere.
- **render_blender_script:** anything bespoke. You write bpy; the user approves it. Helpers in scope: `principled`, `material_preset`, `studio_world`, `add_camera`, `add_light`, `look_at`, `load_font`, eases.
- **blender_live:** inspect or change the user's own open Blender scene (with their approval).

## Lighting

- **Three-point or motivated light, never one flat source:**
  - key light at 30–45 degrees, from above and to one side;
  - a large soft fill at 1/3 to 1/4 of its energy;
  - a rim/back light to separate the subject from the background.
  Area lights with size, not points, give soft, believable shadows.
- **Contrast with intent:**
  - low-key (dark background, one strong key, rim) for drama;
  - high-key (bright, soft, low contrast) for clean commercial.
- **Colour temperature:** a warm key with a cooler fill or rim gives depth. Don't light everything pure white.
- **Reflections:** reflective materials need something to reflect. Use studio_world() or large emissive cards, or metal looks black.

## Materials

- Real surfaces vary: roughness 0.25–0.6 for most things, small roughness variation (noise), subtle bevels on edges (light catches bevels; perfectly sharp edges look CG).
- **Metals:** metallic 1, roughness 0.15–0.35, coloured by base colour (gold, copper), lit by a world or reflectors.
- **Glass:** transmission 1, roughness 0–0.05, only with something interesting behind or refracted.
- Keep saturation natural; rely on light and material contrast, not neon colours.

## Camera

- Use a longer lens for objects and type: 50–85 mm compresses and flatters; 24–35 mm only for drama or space.
- Place the camera slightly off-axis and a little above or below. Compose with negative space for any 2D text that will sit next to it.
- Use depth of field gently (f/2.8–f/5.6 equivalent) to separate the subject; avoid miniature-looking blur.
- Every camera move has a reason (see motion-design-craft). Slow, eased push-ins or orbits of 10–30 degrees beat full spins.

## Motion

- Ease every move: no linear starts and stops. Entrances `ease_out_cubic` or `ease_out_back` (sparingly); camera moves `ease_in_out`.
- Hold the finished pose long enough to read: 1.5–3 s for a title.
- Turn on motion blur for fast moves (the title renderer does). For loops, make the first and last frames match.
- For music, land the hit (a slam, a reveal) on a beat. detect_beats gives the beat times.

## Render settings

- Use `draft` while iterating, `standard` for most deliverables, `high` for hero shots.
- Render at the project's size (the tools do), with a transparent background for titles and overlays, so they composite over footage.
- After rendering, look at frames (get_media_frames) before placing. Check edges, flicker, legibility and whether it matches the grade of the film. Grade it like any other shot (use_skill color-grading).
