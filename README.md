# Airgapped QR Transfer v2

Move files off an offline machine using its screen and a phone or tablet camera. This is a rework of
[mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer).

| File | Runs on | Notes |
|---|---|---|
| `sender.html` | Airgapped machine | Single file of about 70 KB. Makes no network requests (CSP blocks them). Works from `file://`. |
| `receiver.html` | Phone or iPad, served over HTTPS (GitHub Pages) | Self-contained (zbar-wasm inlined). After loading it makes no network requests, and received data stays on the device. |
| `sender-classic.html` | Airgapped machine | v1 wire format, for the original hosted scanner. |

## What changed from v1

- **Block grid:** the receiver shows each block as received (green), missed (red), recovered (blue) or not yet seen (grey).
- **Auto-repair (fountain code):** after one pass, the sender emits repair codes. Each one is the XOR of a seeded random half of
  all blocks. A receiver that missed *m* blocks needs about *m*+1 repair codes, whichever blocks they were. There is no
  back-channel and no second full pass.
- **Manual resend:** the receiver's "Missed blocks" list (`12,45-48,97`) can be pasted into the sender's *Resend only blocks* field.
- **About 2.5× more data per QR code:** frames are base45-encoded in QR alphanumeric mode instead of base64 of UTF-8 of latin1
  in byte mode.
- **1, 2 or 4 codes per frame**, with configurable chunk size, ECC level and frame time.
- **Integrity and robustness:** a whole-file CRC32 is checked before saving. Every frame carries a session ID, so a late start
  or a repeated header no longer resets the transfer.

## Frame format

The format is base45 of the following fields (big endian):

`type(1) session(4) total(4) chunk(2) id(4) payload`

| Type | `id` holds | Payload |
|---|---|---|
| `0x21` data | block index | `chunk` bytes of the file |
| `0x22` repair | seed | XOR of the blocks in the seeded mask (mulberry32, see `repairMask`) |
| `0x23` meta | – | JSON `{n, s, c, z}` |

The meta frame is repeated every 20 frames. See `build/protocol.js`.

## Build and test

```sh
python3 build/build.py            # regenerates sender.html, receiver.html, sender-classic.html
node build/test-protocol.js       # protocol unit tests (no dependencies)
```

### Vendored libraries (`build/vendor/`)

- Nayuki QR Code generator 1.8.0 (MIT), transpiled from `qrcodegen.ts` with esbuild.
- pako 2.0.3 deflate and inflate (MIT), matching cdnjs SRI.
- zbar-wasm 0.11.0 inlined build (LGPL-2.1+).

## Hosting the receiver on GitHub Pages

Push this folder to a GitHub repository. Then go to Settings → Pages → Deploy from branch → `main` / root.
The receiver is then served at `https://<user>.github.io/<repo>/receiver.html`.
