---
name: generation-prompts
description: Use before generating images or video (generate_image, generate_video, Blender renders) — how to write prompts that produce cinematic, specific results instead of the generic AI look.
---

# Prompts for generated images and video

Generated media should match the film around it and look shot, not synthesised. Vague prompts give the generic AI look: glossy, centred, over-saturated, plastic skin, fantasy lighting.

## First, look

- Check what the generation has to sit next to (get_frame on neighbouring shots, get_contact_sheet): the palette, lens feel, time of day, grain and aspect ratio.
- Match the project size and orientation (get_project → settings).

## Structure a prompt like a shot description

1. **Subject and action:** concrete and specific. "A barista in her 50s pours latte art", not "a person making coffee".
2. **Setting:** the place, era, time of day and weather.
3. **Camera:**
   - shot size (extreme wide, wide, medium, close-up, macro);
   - angle (eye level, low, high, overhead);
   - lens ("35mm", "85mm portrait", "anamorphic") and depth of field ("shallow, f/1.8");
   - for video, the move ("slow push-in", "locked-off", "handheld follow", "dolly left").
4. **Light:** the source and quality ("soft window light from the left", "overcast diffuse", "golden hour backlight", "practical tungsten lamps", "hard noon sun").
5. **Look:** film stock or grade ("Kodak Portra 400 palette", "muted teal-orange", "high-contrast black and white"), texture ("fine film grain", "slight halation"), era cues.
6. **Composition:** the rule of thirds, negative space for titles ("empty sky in the upper third for text"), foreground layers.

## Avoid the AI tells

- Don't use "hyperrealistic, 8k, masterpiece, trending, ultra-detailed": they push the glossy look.
- Keep saturation and contrast natural. Ask for "natural skin texture" and "imperfect, lived-in details".
- Steer away from perfect symmetry and dead-centre subjects unless intended.
- Ask for one clear subject. Crowds and hands are where artefacts hide; keep them out of focus or out of frame.
- Keep text out of generated images (add titles in Lumen instead).

## Video specifics

- Describe one shot with one action and one camera move. 4–8 seconds is the sweet spot.
- Say how it starts and ends ("starts on the cup, ends on her smile") so it cuts well.
- Match frame rate and motion feel to the edit. Calm footage needs calm motion.

## After generating

- Look at the result (get_media_frames) before placing it. Regenerate rather than use something off.
- Grade it to match the neighbouring shots (use_skill color-grading).
- Add grain if the rest of the film has it.
