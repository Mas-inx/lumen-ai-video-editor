---
name: color-grading
description: Use when grading or matching colour, building a look, fixing white balance or exposure, or making shots feel consistent — how to grade with Lumen's tools like a colourist.
---

# Colour grading

Grade in two passes, always in this order:
1. **Correct**: make every shot neutral, exposed well and matching.
2. **Look**: add the creative grade, usually once on an adjustment layer over everything.

Look at frames before and after every change (get_frame, or get_contact_sheet for the whole edit).

## Tools in Lumen

All of these are set through `clip_update` on `color` (on clips or adjustment layers):

| Field | What it does |
|---|---|
| `exposure`, `contrast`, `saturation`, `temperature`, `tint`, `vignette` | basics, −100…100 |
| `curves` | `{ master, red, green, blue }`, lists of `[x, y]` points from 0 to 1 |
| `wheels` | `{ lift, gamma, gain }`, each `{ x, y, luma }`, for shadows, mids and highlights |
| `hsl` | targeted hue, saturation and luma adjustments |
| `lut` | `{ id, amount }` with a LUT from `lut_add`; amount 0…1 |

- **Adjustment layers.** `clip_add` with kind `adjustment` on a top video track, spanning the shots to grade, gives one look for many clips.
- **Looks.** Ready-made looks are listed in `list_catalog`.

## Correct first

- **Exposure.** Skin sits around 55–70% brightness. Don't clip highlights you need, and keep blacks just above zero unless the look wants crushed shadows.
- **White balance.** Neutral things should read neutral: white shirts, grey walls, clouds. Use temperature and tint, or balance the wheels' gain.
- **Contrast.** A gentle S-curve on master, e.g. `[[0,0.02],[0.25,0.22],[0.75,0.80],[1,0.98]]`, beats the contrast slider for a filmic roll-off.
- **Match shots in a scene.** Compare frames side by side. Match brightness first, then colour temperature, then saturation.

## Then the look, with restraint

- Decide what the look is for:
  - **warm nostalgia:** lift shadows slightly warm, soften contrast;
  - **cool thriller:** teal shadows, protected skin, more contrast;
  - **clean commercial:** neutral, bright, saturated but natural.
- **Teal and orange, done right:** push lift slightly toward teal/blue and gain slightly toward warm. Protect skin with HSL (keep orange hues where they are, ±5 degrees). Keep it subtle: x/y offsets around 0.02–0.06.
- **Film feel:**
  - lifted blacks via the curve's first point at 0.03–0.06;
  - slightly compressed highlights;
  - a touch of grain (`effect_add` grain, 15–30);
  - a gentle vignette (10–20).
- **Saturation.** Usually lower overall saturation slightly and raise it selectively. Oversaturation is the most common amateur tell.
- **LUTs.** Apply them at amount 0.4–0.8, after correction; never stack several.
- **Skin is the anchor.** Whatever the look, faces must look healthy. Check every shot with a face.

## Deliver

- Apply the look on an adjustment layer so it's one undo and easy to tweak.
- Say what you did in a sentence:
  - the correction ("evened exposure across the interview");
  - the look ("warm, soft contrast, lifted shadows").
