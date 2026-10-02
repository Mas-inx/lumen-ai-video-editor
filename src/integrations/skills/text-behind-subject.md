---
name: text-behind-subject
description: Use for text behind a person or object, cut-outs, putting someone on a new background, or removing a person — how to make the effect read and look intentional (cut_out_subject).
---

# Text behind the subject

The effect: big words that sit behind the person, as if printed on the world behind them. It reads when the text is large, the subject overlaps it, and nothing else competes.

## Make it

- `cut_out_subject` with mode `text-behind` builds the stack in one step:
  - the clip;
  - a title above it (a new one from `text`, or `title_id`);
  - a silent copy of the clip cut down to the subject, on top.
- `subject: "person"` works on any computer. `"any"` (objects, animals, products) needs a GPU.
- Mattes are reused: trying different words or fonts on the same shot is instant.

## Choose the shot

- Use a stable shot with clear separation between subject and background: a medium or medium-close shot, with the subject large in the frame.
- Use space behind and around the head: the text should be partly hidden by the subject, not fully covered.
- Avoid busy, fast handheld shots and very thin details (hair against a similar background); they show matte edges.

## Set the text

- Use 1–3 words, uppercase or a strong display face (`display`, `art`, `wide`), very big: 150–260 px on 1080p, spanning 60–90% of the width.
- Place it behind the head or upper body:
  - y slightly above centre (−120 to −220 px), so the head overlaps the lower half of the letters;
  - nudge x so the subject covers one or two letters, not all of them.
- Use a colour from the scene, or white or off-white. Avoid outlines, glows and gradients.
- Timing:
  - let the shot breathe first (0.3–0.8 s), then fade or wipe the text in over 0.4–0.8 s (`fade`, or a mask wipe);
  - hold it long enough to read (motion-design-craft holds);
  - take it out before the cut.
  On music, land the reveal on a beat (detect_beats).

## Other uses

- **New background:** mode `cutout` on the clip, then put the new background (generated, stock, or a blurred copy of the shot) on a track below. Match its colour and light (use_skill color-grading) and add a little grain to both.
- **Remove the person:** mode `remove`. The hole shows whatever is on the track below, such as a clean plate of the same location.
- **Blur only the background:** duplicate the clip, blur the bottom copy, and cut out the person on the top copy.

## Check

- Look at frames through the shot (get_frame at the start, middle and end, especially in motion).
- Check that the edges are clean, the text is readable, the subject overlaps it and nothing flickers.
- If the edges chatter, a slight feather or a calmer shot helps more than a bigger font.
