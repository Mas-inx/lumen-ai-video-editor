---
name: video-director
description: Use when making a video from a brief, a script or a pile of footage — anything longer than a couple of shots. Plan it as a storyboard, get the plan reviewed, produce it scene by scene in one style and brand, and revise single scenes without rebuilding the rest.
---

# Directing a video

Plan before you produce. A storyboard the user has agreed to is far cheaper to change than an edit, and it keeps every scene in one voice.

## 1. Understand the job

- Read what's there: get_project, get_storyboard (there may be a plan already), get_brand_kit, list_styles.
- Know the material: suggest_broll and find_media for what the project already has, get_transcript for what's said, get_contact_sheet for the footage.
- If the brief is thin, settle three things — who it's for, how long it runs, what it should make them do — by asking once, or by stating your assumptions in the brief.

## 2. Plan it as a storyboard

- **storyboard_update:** the brief (purpose, audience, tone, length, format) and one style — an id from list_styles, or `brand` when the project has a brand.
- **storyboard_addScenes,** every scene in one call, in order:
  - `title` says what the scene does: "Hook: the problem", "Proof: three numbers".
  - `script` is the exact words: narration, dialogue or on-screen text.
  - `treatment` is how it's made. Prefer what the project has: `footage` and `broll` before `generated-image` or `generated-video`. `kinetic-type`, `infographic` and `motion-graphic` are made in Lumen (add_title, render_motion_graphic — an infographic is its `chart`, with the scene's real numbers); `3d` in Blender.
  - `seconds` follows the script (about 2.5 spoken words a second) and the style's pacing.
  - `transition` is the style's on most cuts, null for a straight cut. Save a different one for a change of chapter.
  - `needs` lists what's missing: shots to find, media to generate. Put the project media you matched (suggest_broll with the scene's script) in `assetIds`.
- **Shape:** a hook in the first 2–3 seconds, one idea per scene, a clear end (the payoff or the call to action). Keep the total near the brief's length.

## 3. Let the user review it

Stop after planning. Show the plan in a few lines — number, title, seconds, treatment — with the running length, and say it can be edited in the Story panel. Produce when the user says go, unless they asked you to go straight through.

## 4. Produce scene by scene

For each scene, in order:

1. storyboard_updateScene → `status: "in-progress"`.
2. Build it at its place on the timeline:
   - project media first: suggest_broll's `pick` and `source_seconds`, place_asset, clip_trim;
   - titles with add_title, graphics with render_motion_graphic, using the style's `motion_graphics` settings and the brand's font and accent;
   - generate (generate_image, generate_video, generate_voiceover) only for needs nothing in the project covers.
3. Give its clips the style: apply_style with the storyboard's style and `clip_ids`.
4. Record what you made: storyboard_updateScene → `produced: { clipIds: [every clip of the scene] }`, `status: "done"`. From then on the scene follows its clips through later edits.
5. Check it: get_frame at its key moments, or get_contact_sheet over its stretch.

Then finish the whole: captions in the style's caption style, music ducked under speech, and a get_contact_sheet of the full edit.

## 5. Revise one scene, not the film

- get_storyboard gives the scene's stretch and clip ids. Change only those clips; leave other scenes' clips alone.
- A new version that runs longer or shorter keeps the scenes after it in step on the magnetic main track (it closes up and opens by itself), or with ripple edits elsewhere.
- Update the scene — script, seconds, notes, `produced.clipIds` — so the plan matches the edit.
- Apply the style again to just that scene (apply_style `scene_id`) so it matches its neighbours.

## Keep one identity

- One style for the whole video — the storyboard's — on every scene. Change style only on purpose (a flashback, a new chapter).
- With a brand kit, apply_brand_kit once: fonts, colours, logos and house style. After that, apply_style keeps the brand's typefaces and colours. Use the brand's fonts and accent in generated graphics and prompts too.
- The same treatment for the same job everywhere: one lower-third style, one caption style, one transition grammar.
- Generated media in one visual language: repeat the same style words, palette and light in every prompt (see generation-prompts).
- Cut to the style's pacing: its shot lengths, and whether cuts land on the beat.
