---
name: color-grading
description: Use when grading or matching colour, building a look, fixing white balance or exposure, making shots feel consistent, relighting a shot, or adding light effects (bloom, halation, god rays, lens flares, light leaks, vignettes) — how to grade and light with Lumen's tools like a colourist.
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
| `balance` | white balance `{ r, g, b }`, gains in linear light (1 = neutral) — the correction stage, applied first |
| `levels` | `{ black, white, gamma }`: black and white points (0…1) and midtones — after the balance |
| `match` | per-channel curves from `match_color` that line a clip up with a reference shot |
| `exposure`, `contrast`, `saturation`, `temperature`, `tint`, `vignette` | basics, −100…100 (a vignette below 0 lightens the edges) |
| `curves` | `{ master, red, green, blue }`, lists of `[x, y]` points from 0 to 1 |
| `wheels` | `{ lift, gamma, gain }`, each `{ x, y, luma }`, for shadows, mids and highlights |
| `hsl` | targeted hue, saturation and luma adjustments |
| `lut` | `{ id, amount }` with a LUT from `lut_add`; amount 0…1 |

- **Adjustment layers.** `clip_add` with kind `adjustment` on a top video track, spanning the shots to grade, gives one look for many clips.
- **Looks.** Ready-made looks are listed in `list_catalog`.

## Correct first

- **Start with `auto_color`** on each shot: it takes out the colour cast (a real white balance, so whites go white) and sets black and white points. It's careful with mood; pass `white_balance: false` for a scene that is meant to be coloured (stage light, sunset).
- **Exposure.** Skin sits around 55–70% brightness. Don't clip highlights you need, and keep blacks just above zero unless the look wants crushed shadows.
- **White balance by hand.** Neutral things should read neutral: white shirts, grey walls, clouds. Nudge `balance` (raise `b` to cool, raise `r` to warm, a few hundredths at a time). Temperature and tint are creative washes on top, not a correction.
- **Contrast.** A gentle S-curve on master, e.g. `[[0,0.02],[0.25,0.22],[0.75,0.80],[1,0.98]]`, beats the contrast slider for a filmic roll-off.
- **Match shots in a scene** with `match_color`: correct the best shot first, then match the others to it (`copy_look: true` also copies its creative grade). It reports how close each shot got. Check the cuts with get_frame either side.

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

## Light and lens

Effects added with `effect_add` (params in its description). They run after the grade, in the order relight → rays → glow → halation → flare → leak → vignette, and look the same in preview and export.

- **Bloom** (`glow`): threshold 50–70 so only highlights bloom, radius 40–60, amount 25–45. Threshold 0 glows the whole picture (dreamy, low contrast).
- **Halation**: the red-orange glow film gets around bright edges. Threshold 60–75, amount 30–55. Pairs with grain for a film look; skip it on clean commercial work.
- **God rays** (`rays`): needs bright areas to cast them — a window, sky, a lamp. Put the light where the source is (off the frame is fine: `y: -0.1` for sun above), or `follow: 1` to track the brightest light. Haze 20–40 adds atmosphere.
- **Lens flare** (`flare`): place it on the light source, or `follow: 1`. `anamorphic` for the cinematic blue streak, `star` for a sharp sun. Amount 30–60; a flare should feel caught, not stuck on.
- **Light leak** (`leak`): `burst`, `streak`, `edge` or `prism`, with two colours. Best on transitions or openers, 1–3 seconds, amount 30–60.
- **Vignette**: amount 20–40 with feather 50–70 is invisible but draws the eye in; a white `color` lightens the edges for an airy look; move `x`/`y` to keep the clear area on the subject.

## Relight

`relight_clip` adds a light shaped by the shot's depth map (made on this computer, reused afterwards):
- To **add** a light (a kicker, a lamp just out of frame): keep `ambient` 70–85, amount 40–70, place it on the side the motivation comes from.
- To **move** the light (it should come from the other side): lower `ambient` to 40–55 and raise amount, light at a low `height` (20–40) on the new side.
- Warm light `#ffd2a0`, cool moonlight `#a8c4ff`. Check faces with get_frame — skin must stay natural.

## Deliver

- Apply the look on an adjustment layer so it's one undo and easy to tweak.
- Say what you did in a sentence:
  - the correction ("evened exposure across the interview");
  - the look ("warm, soft contrast, lifted shadows").
