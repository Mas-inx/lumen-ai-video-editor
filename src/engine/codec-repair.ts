/**
 * Video files whose decoder configuration is wrong although the video is fine.
 *
 * H.264 in MP4 states its profile, constraint flags and level twice: in the
 * first bytes of the configuration record (avcC), and in the SPS the decoder
 * really reads. Old Chromium builds — the one in FiveM's browser among them —
 * write the record's constraint byte with its bits in reverse order (0x03 for
 * 0xC0). The codec string is made from the record, and Chromium refuses a
 * string whose two low constraint bits are set ("avc1.420328") without looking
 * at the video. So such a config is rewritten from its own SPS before a
 * decoder sees it.
 */

const AVC = /^(avc[13])\.([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

const hex = (n: number) => n.toString(16).padStart(2, '0')

const bytesOf = (data: AllowSharedBufferSource) => (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data))

/** Where the first SPS starts in an avcC record. Its bytes 1 to 3 are the profile, constraint flags and level. */
function firstSps(record: Uint8Array): number | null {
  if (record.length < 12 || record[0] !== 1 || (record[5] & 0x1f) === 0) return null
  const length = (record[6] << 8) | record[7]
  if (length < 4 || 8 + length > record.length || (record[8] & 0x1f) !== 7) return null
  return 8
}

/** An H.264 config Chromium would refuse for its constraint byte, restated from its SPS. Anything else comes back as it is. */
export function repairAvcConfig<T extends { codec: string; description?: AllowSharedBufferSource }>(config: T): T {
  const m = AVC.exec(config.codec)
  if (!m) return config
  const constraints = parseInt(m[3], 16)
  // The two low bits are reserved: zero in every valid stream.
  if ((constraints & 3) === 0) return config
  const record = config.description ? bytesOf(config.description) : null
  const sps = record ? firstSps(record) : null
  if (record && sps !== null && (record[sps + 2] & 3) === 0) {
    const fixed = record.slice()
    fixed.set(record.subarray(sps + 1, sps + 4), 1)
    return { ...config, codec: `${m[1]}.${hex(fixed[1])}${hex(fixed[2])}${hex(fixed[3])}`, description: fixed }
  }
  return { ...config, codec: `${m[1]}.${m[2]}${hex(constraints & 0xfc)}${m[4]}` }
}

let installed = false

/**
 * Makes every video decoder in this window take repaired configs. It sits
 * under Mediabunny, which makes the codec string from the file and asks
 * WebCodecs with it, so all of Mediabunny's own handling stays in place.
 */
export function installDecoderRepair() {
  if (installed || typeof VideoDecoder === 'undefined') return
  installed = true
  const isConfigSupported = VideoDecoder.isConfigSupported.bind(VideoDecoder)
  VideoDecoder.isConfigSupported = (config) => isConfigSupported(repairAvcConfig(config))
  const configure = VideoDecoder.prototype.configure
  VideoDecoder.prototype.configure = function (config) {
    configure.call(this, repairAvcConfig(config))
  }
}
