# Pica3DS

An experimental Nintendo 3DS emulator written from scratch in JavaScript. It runs in the browser with no build step, no install and no server.

It runs homebrew built with devkitARM/libctru, and it boots some commercial games into their menus and 3D scenes, all drawn by a software PICA200 GPU.

> **Bring your own games.** This repository contains no Nintendo games, firmware, system files or encryption keys. Use dumps of games and system data you own, decrypted on your own console.

## Quick start

1. Download or clone this repository.
2. Open `index.html` in a browser (double-click works).
3. Press **Demo**, or open a `.3dsx`, `.elf`, or decrypted `.3ds` / `.cxi` file. You can also drag a file onto the page.

Open `index.html?demo` to start the demo automatically.

## Status

| Works | Partly works | Not yet |
|---|---|---|
| Homebrew (libctru, citro2d/citro3d) | Commercial games: tested with *New Super Mario Bros. 2*, which reaches its intro pages and 3D opening cutscene | Sound output |
| 3D graphics (vertex shaders, textures, lighting, fog, blending, depth/stencil) | Speed: 2D screens run well, heavy 3D scenes run at roughly 10 to 15 FPS | Geometry shaders, procedural textures, gas rendering |
| Save data and extra data (kept in memory) | System applets (keyboard, error display) close straight away instead of showing | Networking, camera, the stereoscopic 3D effect |
| System files from your own console, or built-in stand-ins | | `.cia` files and encrypted games |

## How it works

| Part | File | Notes |
|---|---|---|
| ARM11 CPU | `src/cpu.js` | ARMv6K interpreter: ARM and Thumb instructions, ARMv6 media/SIMD instructions, exclusive loads/stores, and VFPv2 floating point |
| Memory | `src/memory.js` | 4 KB page table with aligned fast paths |
| Kernel (HLE) | `src/kernel.js` | Threads with a priority scheduler, mutexes, semaphores, events, timers, address arbiters, shared memory, and heap/linear memory (old and new linear heap layouts) |
| 3D GPU | `src/gpu.js` | PICA200 in software: command lists, vertex shader interpreter, clipping, rasterizer, all 14 texture formats including ETC1, texture combiners, fragment lighting, fog, and the output merger. Each GPU state is compiled into a specialized JavaScript function for speed |
| Services (HLE) | `src/services.js` | `srv:`, `APT` (parameters, shared font, library applets), `gsp::Gpu`, `hid`, `fs` (RomFS, save data, extra data, SD card), `dsp` (silent), `cfg`, `ptm`, `err:f`. Other services are stubbed |
| System data | `src/sysdata.js` | RomFS builder, plus stand-ins for missing system data (Mii data, system font) |
| Loader | `src/loader.js` | `.3dsx`, ARM ELF, and decrypted `.3ds`/`.cci` (NCSD) and `.cxi` (NCCH), including compressed code and RomFS |
| Front-end | `index.html`, `src/main.js` | Both screens, keyboard, mouse/touch, gamepad, system files manager, and a log |

## Controls

| 3DS | Keyboard |
|---|---|
| D-Pad | Arrow keys |
| Circle Pad | I / J / K / L |
| A / B / X / Y | X / Z / S / A |
| L / R | Q / W |
| Start / Select | Enter / Backspace |
| Touch screen | Mouse or finger on the bottom screen |

Gamepads use the standard browser mapping.

## Games and system files

**Games** must be decrypted. Retail dumps are usually encrypted, and this emulator does not include console keys. Decrypt your own dump on your 3DS, for example with GodMode9 ("Decrypt file").

**System files.** Some games read data that ships with the console, such as Mii data or the system font. If one is missing, the emulator uses a built-in stand-in where it has one, and otherwise names the missing file in the log. To use the real files from your own console:

1. On your 3DS, in GodMode9, open `[1:] SYSNAND CTRNAND/title/0004009b/<title>/content/`.
2. Select the `.app` file and choose **NCCH image options → Decrypt file**. The decrypted copy goes to `gm9/out/` on your SD card.
3. In the emulator, click **System files…** (or drag the `.app` onto the page). Files are saved in your browser, so you only add them once.

## Development

```
node tools/test.js                        # regression suite
node tests/gpu/scenes.js                  # GPU tests only
node tools/run.js app.3dsx 120 shot       # run headless for 120 frames, save shot-top.png / shot-bottom.png
node tools/run.js app.3dsx 300 shot --keys=A@60-70,START@200-205
```

The tests cover:

- **CPU:** 64-bit integer math, VFP float/double, libm, printf/scanf, qsort, CRC32 and setjmp/longjmp, compared against output computed independently in Python, plus hand-written Thumb assembly with ARM↔Thumb interworking.
- **Programs:** the libctru hello-world and thread examples, and the bundled demo.
- **RomFS and loading:** the libctru RomFS example in four formats (`.3dsx`, `.3ds`, compressed `.3ds`, `.cxi`), rejection of encrypted images, reading system data files, and the RomFS builder.
- **GPU:** hand-built command lists and shader binaries rendered and checked pixel by pixel. They cover fill rules, color interpolation, depth, textures, ETC1, shader math and flow control, immediate mode, culling, scissor, stencil, blending, alpha test and texture combiners.

### Packaging homebrew as .3ds

```
node tools/make3ds.js app.elf app.3ds [--from3dsx=app.3dsx] [--compress] [--cxi]
```

This builds a decrypted (NoCrypto) cartridge image from a libctru ELF. `--from3dsx` copies the RomFS and icon from the matching `.3dsx`, `--compress` BLZ-compresses the code, and `--cxi` writes a bare NCCH instead of a `.3ds`.

To rebuild the test ROMs or the demo (`demo/source/main.c`), install [devkitPro](https://devkitpro.org/wiki/Getting_Started) with the `3ds-dev` group and use the standard libctru Makefile template.

## License

Pica3DS is licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).

## Legal

This project is not affiliated with or endorsed by Nintendo. "Nintendo 3DS" is a trademark of Nintendo. The emulator is written from scratch and contains no Nintendo code, firmware, keys or game data.
