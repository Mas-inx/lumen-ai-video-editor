import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { analyze, applyRun, checkPrompt, collectOutputs, ConvertError, imageInfo, outcome, parseWorkflow, pngText, promptError, readWorkflow, RunProgress, uiToApi, type ApiPrompt, type NodeDefs, type UiGraph } from './workflow'

type Json = Record<string, any>

/** ComfyUI's default text-to-image workflow, as Export (API) writes it. */
const TXT2IMG: ApiPrompt = {
  '3': { class_type: 'KSampler', inputs: { seed: 156680208700286, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, _meta: { title: 'KSampler' } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' }, _meta: { title: 'Load Checkpoint' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a glass bottle with a galaxy inside', clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: 'VAE Decode' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] }, _meta: { title: 'Save Image' } },
}

/** What ComfyUI's /object_info says about the nodes above (trimmed). */
const DEFS: NodeDefs = {
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { default: 0, min: 0, max: 18446744073709551615, control_after_generate: true }],
        steps: ['INT', { default: 20, min: 1, max: 10000 }],
        cfg: ['FLOAT', { default: 8, min: 0, max: 100, step: 0.1, round: 0.01 }],
        sampler_name: [['euler', 'dpmpp_2m'], {}],
        scheduler: [['normal', 'karras'], {}],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', { default: 1, min: 0, max: 1, step: 0.01 }],
      },
    },
    output: ['LATENT'],
    output_node: false,
    display_name: 'KSampler',
  },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5-pruned-emaonly.safetensors', 'sdxl.safetensors'], {}] } }, output: ['MODEL', 'CLIP', 'VAE'], display_name: 'Load Checkpoint' },
  EmptyLatentImage: {
    input: { required: { width: ['INT', { default: 512, min: 16, max: 16384, step: 8 }], height: ['INT', { default: 512, min: 16, max: 16384, step: 8 }], batch_size: ['INT', { default: 1, min: 1, max: 4096 }] } },
    output: ['LATENT'],
    display_name: 'Empty Latent Image',
  },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true, dynamicPrompts: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'], display_name: 'CLIP Text Encode (Prompt)' },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'], display_name: 'VAE Decode' },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } }, output: [], output_node: true, display_name: 'Save Image' },
  PreviewImage: { input: { required: { images: ['IMAGE'] } }, output: [], output_node: true, display_name: 'Preview Image' },
  LoadImage: { input: { required: { image: [['photo.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'], display_name: 'Load Image' },
}

const roles = (prompt: ApiPrompt, defs?: NodeDefs) => analyze(prompt, defs).inputs.map((i) => `${i.node}.${i.input}:${i.role}`)

describe('reading a workflow', () => {
  it('takes the API format, and the body of a POST /prompt', () => {
    expect(parseWorkflow(JSON.stringify(TXT2IMG))).toEqual({ kind: 'api', prompt: TXT2IMG })
    expect(readWorkflow({ prompt: TXT2IMG, client_id: 'x' })).toEqual({ kind: 'api', prompt: TXT2IMG })
  })

  it('knows ComfyUI’s own format, to convert', () => {
    expect(readWorkflow({ last_node_id: 9, nodes: [], links: [] }).kind).toBe('ui')
  })

  it('wires with number ids become strings', () => {
    const read = readWorkflow({ '1': { class_type: 'A', inputs: {} }, '2': { class_type: 'B', inputs: { a: [1, 0] } } })
    expect(read.kind === 'api' && read.prompt['2'].inputs.a).toEqual(['1', 0])
  })

  it('says what is wrong with anything else', () => {
    expect(() => parseWorkflow('not json')).toThrow(/isn’t JSON/)
    expect(() => parseWorkflow('{"hello": "world"}')).toThrow(/neither ComfyUI’s nodes nor an API-format prompt/)
    expect(() => parseWorkflow('[]')).toThrow(/isn’t a ComfyUI workflow/)
  })

  it('refuses wires to nodes that aren’t there', () => {
    expect(() => checkPrompt({ '1': { class_type: 'VAEDecode', inputs: { samples: ['99', 0] } } })).toThrow(/“samples” of node 1 \(VAEDecode\) is wired to node 99/)
    expect(() => checkPrompt(TXT2IMG)).not.toThrow()
  })
})

describe('finding what a workflow lets you change', () => {
  it('reads prompts, seed, steps, cfg, denoise and size from the default workflow — positive and negative by the sampler input they reach', () => {
    const { inputs, outputs, missing } = analyze(TXT2IMG)
    expect(inputs.map((i) => [i.label, i.node, i.input, i.value])).toEqual([
      ['Prompt', '6', 'text', 'a glass bottle with a galaxy inside'],
      ['Negative prompt', '7', 'text', 'text, watermark'],
      ['Seed', '3', 'seed', 156680208700286],
      ['Steps', '3', 'steps', 20],
      ['CFG', '3', 'cfg', 8],
      ['Denoise', '3', 'denoise', 1],
      ['Width', '5', 'width', 512],
      ['Height', '5', 'height', 512],
      ['Batch size', '5', 'batch_size', 1],
    ])
    expect(inputs.find((i) => i.role === 'seed')).toMatchObject({ integer: true, title: 'KSampler', classType: 'KSampler' })
    expect(inputs.find((i) => i.role === 'cfg')?.integer).toBeUndefined()
    expect(outputs).toEqual([{ node: '9', classType: 'SaveImage', title: 'Save Image', kind: 'image' }])
    expect(missing).toEqual([])
  })

  it('takes ranges and missing nodes from the server’s definitions', () => {
    const { inputs, missing } = analyze({ ...TXT2IMG, '10': { class_type: 'MysteryNode', inputs: {} } }, { ...DEFS, MysteryNode: null })
    expect(inputs.find((i) => i.role === 'seed')).toMatchObject({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
    expect(inputs.find((i) => i.role === 'cfg')).toMatchObject({ min: 0, max: 100, step: 0.1 })
    expect(inputs.find((i) => i.role === 'cfg')?.integer).toBeUndefined()
    expect(missing).toEqual(['MysteryNode'])
  })

  it('follows Flux’s single conditioning through its guidance and guider, and finds the seed on RandomNoise', () => {
    const flux: ApiPrompt = {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a fox in the snow', clip: ['11', 0] } },
      '11': { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' } },
      '26': { class_type: 'FluxGuidance', inputs: { guidance: 3.5, conditioning: ['6', 0] } },
      '22': { class_type: 'BasicGuider', inputs: { model: ['12', 0], conditioning: ['26', 0] } },
      '12': { class_type: 'UNETLoader', inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' } },
      '25': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
      '17': { class_type: 'BasicScheduler', inputs: { scheduler: 'simple', steps: 20, denoise: 1, model: ['12', 0] } },
      '27': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '13': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['25', 0], guider: ['22', 0], sampler: ['16', 0], sigmas: ['17', 0], latent_image: ['27', 0] } },
      '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    }
    expect(roles(flux)).toEqual(['6.text:prompt', '25.noise_seed:seed', '17.steps:steps', '17.denoise:denoise', '27.width:width', '27.height:height', '27.batch_size:batch'])
  })

  it('looks through ControlNets and ConditioningZeroOut, nearest sampler socket first', () => {
    const cn: ApiPrompt = {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a city at night', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x' } },
      '10': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['6', 0], negative: ['7', 0], control_net: ['11', 0], image: ['12', 0], strength: 1, start_percent: 0, end_percent: 1 } },
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['10', 0], negative: ['10', 1], latent_image: ['5', 0] } },
    }
    expect(roles(cn).slice(0, 2)).toEqual(['6.text:prompt', '7.text:negative'])

    // Flux: the negative is the positive zeroed out — the text is still the prompt.
    const zero: ApiPrompt = {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse', clip: ['4', 1] } },
      '8': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } },
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['8', 0], latent_image: ['5', 0] } },
    }
    expect(roles(zero)[0]).toBe('6.text:prompt')
  })

  it('finds a prompt typed into a primitive that feeds the encoder, and a seed on a seed node', () => {
    const wan: ApiPrompt = {
      '30': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'a cat surfing a wave' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: ['30', 0], clip: ['38', 0] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'static, blurry', clip: ['38', 0] } },
      '52': { class_type: 'LoadImage', inputs: { image: 'start.png', upload: 'image' } },
      '50': { class_type: 'WanImageToVideo', inputs: { width: 832, height: 480, length: 81, batch_size: 1, positive: ['6', 0], negative: ['7', 0], vae: ['39', 0], start_image: ['52', 0] } },
      '40': { class_type: 'Seed (rgthree)', inputs: { seed: 777 } },
      '3': { class_type: 'KSampler', inputs: { seed: ['40', 0], steps: 20, cfg: 6, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: ['37', 0], positive: ['50', 0], negative: ['50', 1], latent_image: ['50', 2] } },
      '28': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 16, loop_count: 0, filename_prefix: 'Wan', format: 'video/h264-mp4', pingpong: false, save_output: true, images: ['8', 0] } },
    }
    const { inputs, outputs } = analyze(wan)
    expect(inputs.map((i) => `${i.node}.${i.input}:${i.role}`)).toEqual(['30.value:prompt', '7.text:negative', '52.image:image', '40.seed:seed', '3.steps:steps', '3.cfg:cfg', '3.denoise:denoise', '50.width:width', '50.height:height', '50.length:frames', '50.batch_size:batch', '28.frame_rate:fps'])
    expect(inputs.find((i) => i.role === 'image')).toMatchObject({ label: 'Image', title: 'LoadImage', value: 'start.png' })
    expect(outputs).toEqual([{ node: '28', classType: 'VHS_VideoCombine', title: 'VHS_VideoCombine', kind: 'video' }])
  })

  it('reads positive and negative from input names, and labels several of a kind apart', () => {
    const wrapper: ApiPrompt = {
      '16': { class_type: 'WanVideoTextEncode', inputs: { positive_prompt: 'a red kite', negative_prompt: 'ugly', t5: ['11', 0] }, _meta: { title: 'Wan Text' } },
      '20': { class_type: 'CLIPTextEncodeSDXL', inputs: { text_g: 'a dog', text_l: 'a dog', clip: ['4', 1], width: 1024, height: 1024 } },
      '21': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, positive: ['20', 0], negative: ['16', 1] } },
      '22': { class_type: 'KSampler', inputs: { seed: 2, steps: 10, cfg: 7, positive: ['20', 0], negative: ['16', 1] } },
    }
    const { inputs } = analyze(wrapper)
    expect(inputs.filter((i) => i.role === 'prompt').map((i) => i.label)).toEqual(['Prompt · Wan Text', 'Prompt · CLIPTextEncodeSDXL text_g', 'Prompt · CLIPTextEncodeSDXL text_l'])
    expect(inputs.filter((i) => i.role === 'negative').map((i) => i.input)).toEqual(['negative_prompt'])
    expect(inputs.filter((i) => i.role === 'seed').map((i) => i.label)).toEqual(['Seed · KSampler #21', 'Seed · KSampler #22'])
    // An SDXL encoder's width and height are conditioning, not the canvas.
    expect(inputs.some((i) => i.role === 'width')).toBe(false)
  })

  it('finds video and audio loaders, and every kind of output', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'VHS_LoadVideo', inputs: { video: 'clip.mp4', force_rate: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 } },
      '2': { class_type: 'LoadVideo', inputs: { file: 'b-roll.mp4' } },
      '3': { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } },
      '10': { class_type: 'PreviewImage', inputs: { images: ['1', 0] } },
      '11': { class_type: 'SaveAnimatedWEBP', inputs: { filename_prefix: 'x', fps: 12, lossless: false, quality: 90, method: 'default', images: ['1', 0] } },
      '12': { class_type: 'SaveAudio', inputs: { filename_prefix: 'audio/x', audio: ['3', 0] } },
      '13': { class_type: 'SaveGLB', inputs: { filename_prefix: 'mesh/x', mesh: ['20', 0] } },
      '14': { class_type: 'ShowText|pysssss', inputs: { text: ['21', 0] } },
      '15': { class_type: 'SaveVideo', inputs: { filename_prefix: 'video/x', format: 'auto', codec: 'auto', video: ['2', 0] } },
    }
    expect(roles(p).slice(0, 3)).toEqual(['1.video:video', '2.file:video', '3.audio:audio'])
    expect(analyze(p).outputs.map((o) => `${o.node}:${o.kind}`)).toEqual(['10:preview', '11:video', '12:audio', '13:3d', '14:text', '15:video'])
  })

  it('with definitions, trusts them: custom text boxes count, nodes that aren’t outputs don’t', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'StyleTextNode', inputs: { style_text: 'cinematic, 35mm', strength: 1 } },
      '2': { class_type: 'PreviewThing', inputs: {} },
      '3': { class_type: 'MyUploader', inputs: { picture: 'p.png' } },
    }
    const defs: NodeDefs = {
      StyleTextNode: { input: { required: { style_text: ['STRING', { multiline: true }], strength: ['FLOAT', {}] } } },
      PreviewThing: { input: {}, output_node: false },
      MyUploader: { input: { required: { picture: [['p.png'], { image_upload: true }] } }, output_node: false },
    }
    expect(roles(p, defs)).toEqual(['1.style_text:text', '3.picture:image'])
    expect(analyze(p, defs).inputs[0].label).toBe('StyleTextNode · style_text')
    expect(analyze(p, defs).outputs).toEqual([])
  })
})

describe('applying a run', () => {
  const analysis = analyze(TXT2IMG, DEFS)
  const run = (req: Json, random = () => 0.5) => applyRun(TXT2IMG, { workflowId: 'wf_00000000', ...req }, analysis, DEFS, random)

  it('puts prompts, steps, cfg and size where they belong, without touching the workflow', () => {
    const before = JSON.stringify(TXT2IMG)
    const { prompt, notes } = run({ prompt: 'a lighthouse at dusk', negative: 'people', steps: 30, cfg: 6.5, denoise: 0.6, width: 1024, height: 576 })
    expect(prompt['6'].inputs.text).toBe('a lighthouse at dusk')
    expect(prompt['7'].inputs.text).toBe('people')
    expect(prompt['3'].inputs).toMatchObject({ steps: 30, cfg: 6.5, denoise: 0.6 })
    expect(prompt['5'].inputs).toMatchObject({ width: 1024, height: 576 })
    expect(notes).toEqual([])
    expect(JSON.stringify(TXT2IMG)).toBe(before)
  })

  it('draws a new seed by default, within what the input takes; keeps or sets one when asked', () => {
    expect(run({}).seeds).toEqual({ '3.seed': 2 ** 49 })
    expect(run({}, () => 0).prompt['3'].inputs.seed).toBe(0)
    // Without definitions, seeds stay within 32 bits, which every seed input takes.
    expect(applyRun(TXT2IMG, { workflowId: 'x' }, analyze(TXT2IMG), undefined, () => 0.5).seeds['3.seed']).toBe(2 ** 31)
    expect(run({ seed: 'keep' }).seeds).toEqual({ '3.seed': 156680208700286 })
    expect(run({ seed: 1234 }).prompt['3'].inputs.seed).toBe(1234)
  })

  it('lets overrides set any input by node and name — and win', () => {
    const { prompt, seeds } = run({ steps: 30, overrides: [{ node: '3', input: 'steps', value: 12 }, { node: '3', input: 'sampler_name', value: 'dpmpp_2m' }, { node: '3', input: 'seed', value: '99' }, { node: '9', input: 'filename_prefix', value: 7 }] })
    expect(prompt['3'].inputs).toMatchObject({ steps: 12, sampler_name: 'dpmpp_2m', seed: 99 })
    expect(prompt['9'].inputs.filename_prefix).toBe('7')
    expect(seeds).toEqual({ '3.seed': 99 })
  })

  it('says what an input takes when a value won’t do', () => {
    expect(() => run({ overrides: [{ node: '42', input: 'x', value: 1 }] })).toThrow(/no node 42 in this workflow\. Its nodes: 3 \(KSampler\), 4 \(Load Checkpoint\)/)
    expect(() => run({ overrides: [{ node: '6', input: 'txt', value: 'a' }] })).toThrow(/Node 6 \(CLIP Text Encode \(Prompt\)\) has no input “txt”\. It has: text, clip/)
    expect(() => run({ overrides: [{ node: '3', input: 'model', value: 'x' }] })).toThrow(/“model” on node 3 \(KSampler\) is wired to node 4 \(Load Checkpoint\) — set the value there instead/)
    expect(() => run({ overrides: [{ node: '3', input: 'steps', value: 7.5 }] })).toThrow(/takes whole numbers/)
    expect(() => run({ overrides: [{ node: '3', input: 'steps', value: 'many' }] })).toThrow(/takes a number/)
    expect(() => run({ denoise: 1.5 })).toThrow(/“denoise” on node 3 \(KSampler\) goes from 0 to 1/)
    expect(() => run({ overrides: [{ node: '4', input: 'ckpt_name', value: 'nope.ckpt' }] })).toThrow(/is one of: v1-5-pruned-emaonly\.safetensors, sdxl\.safetensors/)
  })

  it('needs a prompt to put a prompt in, but only notes the settings a workflow lacks', () => {
    const noPrompt: ApiPrompt = { '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } }
    expect(() => applyRun(noPrompt, { workflowId: 'x', prompt: 'hi' }, analyze(noPrompt))).toThrow(/no prompt Lumen can find/)
    const { notes } = applyRun(noPrompt, { workflowId: 'x', negative: 'blur', steps: 4, seed: 3 }, analyze(noPrompt))
    expect(notes).toEqual(['This workflow has no negative prompt, so the negative prompt wasn’t used.', 'This workflow has no steps setting, so steps wasn’t used.', 'This workflow has no seed, so the seed wasn’t used.'])
  })

  it('points loaders at uploaded files, and Video Helper Suite’s at the stretch of the clip', () => {
    const p: ApiPrompt = {
      '1': { class_type: 'VHS_LoadVideo', inputs: { video: 'old.mp4', force_rate: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 } },
      '2': { class_type: 'LoadVideo', inputs: { file: 'old.mp4' } },
      '3': { class_type: 'VHS_LoadAudioUpload', inputs: { audio: 'old.wav', start_time: 0, duration: 0 } },
      '4': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    }
    const file = (filename: string) => ({ filename, subfolder: 'lumen', type: 'input' })
    const { prompt, notes } = applyRun(
      p,
      {
        workflowId: 'x',
        media: [
          { node: '1', input: 'video', file: file('a.mp4'), trim: { from: 2, to: 6, fps: 30 } },
          { node: '2', input: 'file', file: file('b.mp4'), trim: { from: 1, to: 2, fps: 24 } },
          { node: '3', input: 'audio', file: file('c.wav'), trim: { from: 1.5, to: 4 } },
          { node: '4', input: 'image', file: { filename: 'd.png', subfolder: '', type: 'input' } },
        ],
      },
      analyze(p),
      { LoadImage: DEFS.LoadImage },
    )
    expect(prompt['1'].inputs).toMatchObject({ video: 'lumen/a.mp4', skip_first_frames: 60, frame_load_cap: 120 })
    expect(prompt['2'].inputs.file).toBe('lumen/b.mp4')
    expect(prompt['3'].inputs).toMatchObject({ audio: 'lumen/c.wav', start_time: 1.5, duration: 2.5 })
    // A file ComfyUI doesn't list yet is fine for a loader.
    expect(prompt['4'].inputs.image).toBe('d.png')
    expect(notes).toEqual([
      'VHS_LoadVideo loads the 4 s the clip uses, from 2 s into its file.',
      'LoadVideo loads the whole file: it can’t start partway in, so the clip’s trim isn’t applied.',
      'VHS_LoadAudioUpload loads the 2.5 s the clip uses, from 1.5 s into its file.',
    ])

    // Frames are counted at a forced rate, and only every nth is kept.
    const forced = { ...p, '1': { ...p['1'], inputs: { ...p['1'].inputs, force_rate: 12, select_every_nth: 2 } } }
    const again = applyRun(forced, { workflowId: 'x', media: [{ node: '1', input: 'video', file: file('a.mp4'), trim: { from: 2, to: 6, fps: 30 } }] }, analyze(forced))
    expect(again.prompt['1'].inputs).toMatchObject({ skip_first_frames: 24, frame_load_cap: 24 })
  })

  it('asks Video Combine for an MP4 rather than a GIF when the server can make one, and says what comes in as a still', () => {
    const p: ApiPrompt = {
      '28': { class_type: 'VHS_VideoCombine', inputs: { frame_rate: 8, loop_count: 0, filename_prefix: 'AnimateDiff', format: 'image/gif', pingpong: false, save_output: true, images: ['8', 0] } },
      '29': { class_type: 'SaveAnimatedWEBP', inputs: { filename_prefix: 'x', fps: 12, lossless: false, quality: 80, method: 'default', images: ['8', 0] } },
    }
    const defs: NodeDefs = { VHS_VideoCombine: { input: { required: { format: [['image/gif', 'image/webp', 'video/h264-mp4', 'video/webm'], {}] } }, output_node: true } }
    const { prompt, notes } = applyRun(p, { workflowId: 'x' }, analyze(p, defs), defs)
    expect(prompt['28'].inputs.format).toBe('video/h264-mp4')
    expect(notes).toEqual(['VHS_VideoCombine saves an MP4 instead of a GIF, so it plays as video in Lumen.', 'SaveAnimatedWEBP saves an animated WebP, which Lumen shows as a still — Save Video (or Video Combine with an MP4 format) makes video.'])
    // Without ffmpeg (no MP4 among its formats) it stays a GIF; asked for a GIF on purpose, it is one.
    const noMp4 = applyRun(p, { workflowId: 'x' }, analyze(p))
    expect(noMp4.prompt['28'].inputs.format).toBe('image/gif')
    expect(noMp4.notes[0]).toBe('VHS_VideoCombine saves a GIF, which Lumen shows as a still — set its format to an MP4 or WebM one in ComfyUI.')
    const asked = applyRun(p, { workflowId: 'x', overrides: [{ node: '28', input: 'format', value: 'image/gif' }] }, analyze(p, defs), defs)
    expect(asked.prompt['28'].inputs.format).toBe('image/gif')
    expect(asked.notes).toHaveLength(1)
  })

  it('only keeps outputs the workflow has', () => {
    expect(() => run({ outputs: ['9', '8'] })).toThrow(/node 8 isn’t an output\. The workflow’s outputs: 9 \(Save Image\)/)
    expect(() => run({ outputs: ['9'] })).not.toThrow()
  })
})

describe('converting ComfyUI’s own format', () => {
  // A text-to-image graph with a reroute, a primitive driving the width, a bypassed upscale, a muted preview and a note.
  const graph = (): UiGraph => ({
    nodes: [
      { id: 4, type: 'CheckpointLoaderSimple', mode: 0, outputs: [{ type: 'MODEL' }, { type: 'CLIP' }, { type: 'VAE' }], widgets_values: ['v1-5-pruned-emaonly.safetensors'] },
      { id: 6, type: 'CLIPTextEncode', mode: 0, title: 'Positive', inputs: [{ name: 'clip', type: 'CLIP', link: 3 }], widgets_values: ['a red fox'] },
      { id: 7, type: 'CLIPTextEncode', mode: 0, inputs: [{ name: 'clip', type: 'CLIP', link: 5 }], widgets_values: ['blurry'] },
      { id: 20, type: 'Reroute', mode: 0, inputs: [{ name: '', type: '*', link: 4 }], outputs: [{ type: 'CLIP' }] },
      { id: 5, type: 'EmptyLatentImage', mode: 0, inputs: [{ name: 'width', type: 'INT', widget: { name: 'width' }, link: 9 }], widgets_values: [512, 512, 1] },
      { id: 30, type: 'PrimitiveNode', mode: 0, outputs: [{ type: 'INT' }], widgets_values: [768, 'fixed'] },
      { id: 40, type: 'LatentUpscaleBy', mode: 4, inputs: [{ name: 'samples', type: 'LATENT', link: 8 }], outputs: [{ type: 'LATENT' }], widgets_values: ['nearest-exact', 1.5] },
      {
        id: 3,
        type: 'KSampler',
        mode: 0,
        inputs: [
          { name: 'model', type: 'MODEL', link: 1 },
          { name: 'positive', type: 'CONDITIONING', link: 6 },
          { name: 'negative', type: 'CONDITIONING', link: 7 },
          { name: 'latent_image', type: 'LATENT', link: 10 },
        ],
        widgets_values: [42, 'randomize', 20, 7.5, 'euler', 'normal', 1],
      },
      { id: 8, type: 'VAEDecode', mode: 0, inputs: [{ name: 'samples', type: 'LATENT', link: 11 }, { name: 'vae', type: 'VAE', link: 12 }] },
      { id: 9, type: 'SaveImage', mode: 0, inputs: [{ name: 'images', type: 'IMAGE', link: 13 }], widgets_values: ['Lumen'] },
      { id: 10, type: 'PreviewImage', mode: 2, inputs: [{ name: 'images', type: 'IMAGE', link: 14 }] },
      { id: 11, type: 'Note', mode: 0, widgets_values: ['Remember to set the prompt'] },
      { id: 12, type: 'LoadImage', mode: 0, widgets_values: ['photo.png', 'image'] },
    ],
    links: [
      [1, 4, 0, 3, 0, 'MODEL'],
      [3, 4, 1, 6, 0, 'CLIP'],
      [4, 4, 1, 20, 0, 'CLIP'],
      [5, 20, 0, 7, 0, 'CLIP'],
      [6, 6, 0, 3, 1, 'CONDITIONING'],
      [7, 7, 0, 3, 2, 'CONDITIONING'],
      [8, 5, 0, 40, 0, 'LATENT'],
      [9, 30, 0, 5, 0, 'INT'],
      [10, 40, 0, 3, 3, 'LATENT'],
      [11, 3, 0, 8, 0, 'LATENT'],
      [12, 4, 2, 8, 1, 'VAE'],
      [13, 8, 0, 9, 0, 'IMAGE'],
      [14, 8, 0, 10, 0, 'IMAGE'],
    ],
  })

  it('does what ComfyUI’s page does before queueing: follows reroutes, uses primitives, passes bypassed nodes through, leaves out muted ones and notes', () => {
    const prompt = uiToApi(graph(), DEFS)
    expect(Object.keys(prompt).sort()).toEqual(['12', '3', '4', '5', '6', '7', '8', '9'])
    expect(prompt['4']).toEqual({ class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'v1-5-pruned-emaonly.safetensors' }, _meta: { title: 'Load Checkpoint' } })
    expect(prompt['6']).toEqual({ class_type: 'CLIPTextEncode', inputs: { text: 'a red fox', clip: ['4', 1] }, _meta: { title: 'Positive' } })
    expect(prompt['7'].inputs).toEqual({ text: 'blurry', clip: ['4', 1] })
    expect(prompt['5'].inputs).toEqual({ width: 768, height: 512, batch_size: 1 })
    expect(prompt['3'].inputs).toEqual({ seed: 42, steps: 20, cfg: 7.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] })
    expect(prompt['8'].inputs).toEqual({ samples: ['3', 0], vae: ['4', 2] })
    expect(prompt['9'].inputs).toEqual({ filename_prefix: 'Lumen', images: ['8', 0] })
    // The upload button's value after the file name isn't an input.
    expect(prompt['12'].inputs).toEqual({ image: 'photo.png' })
    // And the result reads like any API workflow.
    expect(analyze(prompt, DEFS).inputs.filter((i) => i.role === 'prompt' || i.role === 'negative').map((i) => `${i.node}:${i.role}`)).toEqual(['6:prompt', '7:negative'])
  })

  it('reads widgets saved by name (Video Helper Suite)', () => {
    const defs: NodeDefs = {
      VHS_LoadVideo: {
        input: {
          required: { video: [['clip.mp4'], { video_upload: true }], force_rate: ['FLOAT', {}], frame_load_cap: ['INT', {}], skip_first_frames: ['INT', {}], select_every_nth: ['INT', {}] },
          optional: { meta_batch: ['VHS_BatchManager'], vae: ['VAE'] },
        },
      },
    }
    const prompt = uiToApi({ nodes: [{ id: 1, type: 'VHS_LoadVideo', widgets_values: { video: 'clip.mp4', force_rate: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, videopreview: { hidden: false } } }] }, defs)
    expect(prompt['1'].inputs).toEqual({ video: 'clip.mp4', force_rate: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1 })
  })

  it('refuses rather than guesses', () => {
    const misaligned = graph()
    misaligned.nodes.find((n) => n.id === 3)!.widgets_values = [42, 20, 7.5, 'euler', 'normal', 1]
    expect(() => uiToApi(misaligned, DEFS)).toThrow(ConvertError)
    expect(() => uiToApi(misaligned, DEFS)).toThrow(/settings saved on node 3 \(KSampler\) don’t line up/)

    const custom = graph()
    custom.nodes.push({ id: 50, type: 'SetNode', mode: 0 }, { id: 51, type: 'GetNode', mode: 0 })
    expect(() => uiToApi(custom, DEFS)).toThrow(/your ComfyUI doesn’t have SetNode and GetNode/)

    const grouped = graph()
    grouped.nodes.push({ id: 60, type: 'workflow>Upscale group', mode: 0 })
    expect(() => uiToApi(grouped, DEFS)).toThrow(/group nodes \(Upscale group\)/)

    expect(() => uiToApi({ ...graph(), definitions: { subgraphs: [{ id: 'x' }] } }, DEFS)).toThrow(/subgraphs/)
  })
})

describe('results', () => {
  it('collects every file an output lists, leaving previews out when the workflow saved something', () => {
    const { files, texts } = collectOutputs({
      outputs: {
        '9': { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }, { filename: 'ComfyUI_00002_.png', subfolder: '', type: 'output' }] },
        '10': { images: [{ filename: 'ComfyUI_temp_abc.png', subfolder: '', type: 'temp' }] },
        '28': { gifs: [{ filename: 'Wan_00001.mp4', subfolder: '', type: 'output', format: 'video/h264-mp4', frame_rate: 16 }] },
        '11': { images: [{ filename: 'anim_00001_.webp', subfolder: '', type: 'output' }], animated: [true] },
        '12': { audio: [{ filename: 'x_00001_.flac', subfolder: 'audio', type: 'output' }] },
        '13': { '3d': [{ filename: 'mesh_00001_.glb', subfolder: 'mesh', type: 'output' }] },
        '14': { text: ['A red fox runs through snow.'] },
      },
    })
    // In node order, as ComfyUI's history lists them.
    expect(files.map((f) => `${f.node}:${f.kind}:${f.subfolder}/${f.filename}`)).toEqual([
      '9:image:/ComfyUI_00001_.png',
      '9:image:/ComfyUI_00002_.png',
      '11:image:/anim_00001_.webp',
      '12:audio:audio/x_00001_.flac',
      '13:3d:mesh/mesh_00001_.glb',
      '28:video:/Wan_00001.mp4',
    ])
    expect(texts).toEqual([{ node: '14', text: 'A red fox runs through snow.' }])
  })

  it('keeps previews when that’s all there is, and only the outputs asked for', () => {
    const entry = { outputs: { '10': { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }, { filename: 'p.png', subfolder: '', type: 'temp' }] }, '9': { images: [{ filename: 's.png', subfolder: '', type: 'output' }] } } }
    expect(collectOutputs({ outputs: { '10': entry.outputs['10'] } }).files.map((f) => f.filename)).toEqual(['p.png'])
    expect(collectOutputs(entry, ['10']).files.map((f) => f.type)).toEqual(['temp'])
  })

  it('tells a finished run from one still going, and says why one failed', () => {
    expect(outcome(undefined)).toEqual({ done: false })
    expect(outcome({ status: { status_str: 'success', completed: true, messages: [] }, outputs: {} })).toEqual({ done: true, ok: true })
    const failed = outcome({
      status: { status_str: 'error', completed: false, messages: [['execution_start', {}], ['execution_error', { node_id: '3', node_type: 'KSampler', exception_message: 'CUDA out of memory. Tried to allocate 2.00 GiB' }]] },
    })
    expect(failed).toMatchObject({ done: true, ok: false })
    expect(!failed.done || failed.ok ? '' : failed.error).toBe('KSampler (node 3) failed: CUDA out of memory. Tried to allocate 2.00 GiB The graphics card ran out of memory: try a smaller size, fewer frames or a smaller batch.')
    expect(outcome({ status: { status_str: 'error', messages: [['execution_interrupted', { node_id: '3' }]] } })).toMatchObject({ done: true, ok: false, interrupted: true })
  })

  it('reads ComfyUI’s refusals', () => {
    const text = promptError({
      error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
      node_errors: { '4': { errors: [{ type: 'value_not_in_list', message: 'Value not in list', details: "ckpt_name: 'gone.safetensors' not in ['a.safetensors']" }], class_type: 'CheckpointLoaderSimple' } },
    })
    expect(text).toBe("ComfyUI won’t run this workflow: Prompt outputs failed validation\nCheckpointLoaderSimple (node 4): Value not in list — ckpt_name: 'gone.safetensors' not in ['a.safetensors']")
    expect(promptError({ error: { type: 'prompt_no_outputs', message: 'Prompt has no outputs' }, node_errors: [] })).toMatch(/no output node/)
    expect(promptError({ error: { type: 'invalid_prompt', message: 'Cannot execute because node SetNode does not exist.' } })).toMatch(/does not exist\. Install that custom node/)
  })

  it('turns websocket messages into progress: nodes done, plus the sampler’s steps', () => {
    const p = new RunProgress(TXT2IMG)
    expect(p.take('execution_start', {})).toEqual({ progress: 0, message: 'Starting…' })
    expect(p.take('execution_cached', { nodes: ['4', '6', '7'] })).toBeNull()
    expect(p.take('executing', { node: '5' })).toEqual({ progress: 0, message: 'Empty Latent Image…' })
    expect(p.take('executing', { node: '3' })).toEqual({ progress: 0.25, message: 'KSampler…' })
    expect(p.take('progress', { value: 10, max: 20, node: '3' })).toEqual({ progress: 0.375, message: 'KSampler · step 10 of 20' })
    expect(p.take('executing', { node: '8' })?.progress).toBe(0.5)
    expect(p.take('executing', { node: null })).toBeNull()
  })
})

// ─── Files ComfyUI saves ─────────────────────────────────────────────────

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  new DataView(out.buffer).setUint32(0, data.length)
  out.set([...type].map((c) => c.charCodeAt(0)), 4)
  out.set(data, 8)
  return out
}

function png(colorType: number, text: Uint8Array[] = []) {
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, 1280)
  new DataView(ihdr.buffer).setUint32(4, 720)
  ihdr.set([8, colorType, 0, 0, 0], 8)
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...text, chunk('IDAT', new Uint8Array(4)), chunk('IEND', new Uint8Array())]
  return Buffer.concat(parts)
}

const bytes = (s: string) => new TextEncoder().encode(s)
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts)

describe('PNG and WebP', () => {
  it('reads the prompt and workflow ComfyUI writes into its PNGs (plain, international and compressed text)', () => {
    const prompt = JSON.stringify(TXT2IMG)
    const file = png(6, [
      chunk('tEXt', cat(bytes('prompt'), Uint8Array.of(0), bytes(prompt))),
      chunk('iTXt', cat(bytes('workflow'), Uint8Array.of(0, 0, 0), bytes('en'), Uint8Array.of(0), Uint8Array.of(0), bytes('{"nodes":[],"title":"Füchse"}'))),
      chunk('iTXt', cat(bytes('note'), Uint8Array.of(0, 1, 0, 0, 0), deflateSync(bytes('squeezed')))),
    ])
    const text = pngText(file)
    expect(JSON.parse(text.prompt)).toEqual(TXT2IMG)
    expect(JSON.parse(text.workflow)).toEqual({ nodes: [], title: 'Füchse' })
    expect(text.note).toBe('squeezed')
    expect(pngText(Uint8Array.from([1, 2, 3]))).toEqual({})
  })

  it('tells size and transparency from the header', () => {
    expect(imageInfo(png(6))).toEqual({ width: 1280, height: 720, alpha: true })
    expect(imageInfo(png(2))).toEqual({ width: 1280, height: 720, alpha: false })
    expect(imageInfo(png(2, [chunk('tRNS', new Uint8Array(6))]))).toEqual({ width: 1280, height: 720, alpha: true })

    const webp = (tag: string, body: number[]) => cat(bytes('RIFF'), new Uint8Array(4), bytes('WEBP'), bytes(tag), new Uint8Array(4), Uint8Array.from(body))
    // VP8X: flags (alpha 0x10), three reserved bytes, then width − 1 and height − 1 in 24 bits each.
    expect(imageInfo(webp('VP8X', [0x10, 0, 0, 0, 0xff, 0x04, 0, 0xcf, 0x02, 0]))).toEqual({ width: 1280, height: 720, alpha: true })
    // VP8L: signature, then 14 bits of width − 1, 14 of height − 1 and the alpha bit.
    const bits = (1279 | (719 << 14) | (1 << 28)) >>> 0
    expect(imageInfo(webp('VP8L', [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, bits >>> 24, 0, 0, 0, 0, 0]))).toEqual({ width: 1280, height: 720, alpha: true })
    expect(imageInfo(Uint8Array.from([1, 2, 3]))).toBeNull()
  })
})
