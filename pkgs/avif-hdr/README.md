# @paplico/avif-hdr

Pure TypeScript AVIF HDR encoder. No WASM, no native dependencies.

Encodes HDR image data (10-bit/12-bit, PQ/HLG transfer functions, BT.2020 color space) into valid AVIF files.

## Usage

```typescript
import { encodeAvifHdr } from "@paplico/avif-hdr";

// From planar YUV data
const avifBytes = encodeAvifHdr(yuvData, {
  width: 1920,
  height: 1080,
  bitDepth: 10,
  colorPrimaries: "bt2020",
  transferCharacteristics: "pq",
  matrixCoefficients: "bt2020",
  fullRange: true,
  qp: 32,
});

// From linear RGBA Float32Array (auto-converted to BT.2020 YCbCr)
const avifBytes = encodeAvifHdr(rgbaFloat32, {
  width: 1920,
  height: 1080,
  bitDepth: 10,
  colorPrimaries: "bt2020",
  transferCharacteristics: "pq",
  matrixCoefficients: "bt2020",
  qp: 32,
});
```

## API

### `encodeAvifHdr(pixels, options): Uint8Array`

Encodes image data into an AVIF file.

**Parameters:**

- `pixels` — Either a `PlanarYuvData` object or a `Float32Array` of linear RGBA values (4 floats per pixel)
- `options` — Encoding options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `width` | `number` | required | Image width |
| `height` | `number` | required | Image height |
| `bitDepth` | `8 \| 10 \| 12` | `10` | Bit depth |
| `chromaSubsampling` | `"4:2:0" \| "4:4:4"` | `"4:2:0"` | Chroma subsampling |
| `colorPrimaries` | `"bt709" \| "bt2020" \| "display-p3"` | `"bt2020"` | Color primaries |
| `transferCharacteristics` | `"srgb" \| "pq" \| "hlg" \| "linear"` | `"pq"` | Transfer function |
| `matrixCoefficients` | `"bt709" \| "bt2020"` | `"bt2020"` | Matrix coefficients |
| `fullRange` | `boolean` | `true` | Full range (vs studio range) |
| `qp` | `number` | `32` | Quantization parameter (0-63). 0 = lossless, lower = better quality |
| `inputColorSpace` | `"srgb-linear" \| "display-p3-linear" \| "srgb" \| "display-p3"` | `"srgb-linear"` | Input color space (Float32 RGBA path only) |
| `maxNits` | `number` | `203` | Peak luminance in cd/m² for PQ transfer (Float32 RGBA path only) |

## Architecture

Three-layer AV1 still-image encoder:

1. **ISOBMFF Container** — Writes AVIF file structure (ftyp, meta, mdat boxes) with NCLX color metadata
2. **AV1 OBU Framing** — Assembles Open Bitstream Units (Sequence Header, Frame OBU)
3. **AV1 Low-Level Encoding** — DC prediction, integer DCT/WHT, quantization, Daala-based entropy coding

Based on the architecture of [tinyavif](https://github.com/rachelplusplus/tinyavif) (BSD 2-Clause + AOM Patent License 1.0).

## Supported Features

- 8/10/12-bit encoding
- 4:2:0 and 4:4:4 chroma subsampling
- Alpha channel (monochrome AV1 auxiliary item)
- Lossless mode (qp=0): 4x4 Walsh-Hadamard Transform, pixel-exact roundtrip (4:4:4 only)
- Lossy mode (qp=1-63): 8x8 DCT with quantization
- HDR transfer functions: PQ (SMPTE ST 2084), HLG (ARIB STD-B67), sRGB, linear
- Color space conversion: sRGB-linear, Display P3-linear, sRGB (gamma), Display P3 (gamma) → BT.2020
- Multi-tile encoding for wide images (>4096px)
- AV1 Profile 0 (4:2:0), Profile 1 (4:4:4), Profile 2 (12-bit)

## Limitations

- Still images only (no animation/sequence)
- DC prediction only (no directional intra prediction modes)
- No rate control (fixed QP only)
- No CDEF or loop restoration filters
- Lossless mode requires 4:4:4 chroma subsampling
- Performance is limited by pure TypeScript execution

## License

BSD 2-Clause. CDF probability tables derived from AV1 specification (AOM Patent License 1.0).
