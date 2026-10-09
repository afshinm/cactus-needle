/** Small, deterministic uncompressed WAVs for format and inference checks. */
export function wav(samples, { channels = 1, sampleRate = 16_000, bits = 16, float = false } = {}) {
  const width = bits / 8;
  const size = samples.length * width;
  const bytes = Buffer.alloc(44 + size + (size % 2));
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(float ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * width, 28);
  bytes.writeUInt16LE(channels * width, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(size, 40);
  samples.forEach((value, index) => {
    const offset = 44 + index * width;
    if (float && bits === 32) bytes.writeFloatLE(value, offset);
    else if (float) bytes.writeDoubleLE(value, offset);
    else if (bits === 8) bytes.writeUInt8(Math.round(value * 128 + 128), offset);
    else bytes.writeIntLE(Math.round(value * 2 ** (bits - 1)), offset, width);
  });
  return bytes;
}
