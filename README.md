<p align="center"><img src="assets/logo.webp" alt="Pica3DS" width="420"></p>

# Pica3DS

**Try it in your browser: [pica3ds.netlify.app](https://pica3ds.netlify.app/)** (nothing to install; your games stay on your computer)

An experimental Nintendo 3DS emulator written from scratch in JavaScript. It runs in the browser with no build step, no install and no server.

It runs homebrew built with devkitARM/libctru and some commercial games, with 3D graphics drawn on your graphics card (WebGL 2), sound, and a software reference renderer that the fast paths are tested against.

> **Bring your own games.** This repository contains no Nintendo games, firmware, system files or encryption keys. Use dumps of games and system data you own, decrypted on your own console.

## Quick start

Open [pica3ds.netlify.app](https://pica3ds.netlify.app/), or run it locally:

1. Download or clone this repository.
2. Open `index.html` in a browser. Double-clicking it usually works; if your browser blocks something when opened from a file, serve the folder instead (for example `npx serve` or `python -m http.server`) and open the address it prints.
3. Click **Open** and choose a `.3dsx`, `.elf`, or decrypted `.3ds` / `.cci` / `.cxi` / `.cia` file, drag a file onto the page, or press **Run the demo**.
4. Click anywhere on the page once to let the browser start sound.

Open `index.html?demo` to start the demo automatically.

**On a phone or tablet:** on-screen controls appear automatically (Circle Pad or D-Pad, A/B/X/Y, L/R, ZL/ZR, Start/Select), in portrait or landscape. For the most screen space, install it: *Add to Home Screen* on iPhone and iPad (Share menu), or *Install app* on Android. It then opens full screen like an app and works offline (the emulator's own files are cached; games stay on your device). Speed depends heavily on the phone; recent high-end phones do best. On slower phones, turn on **Settings → Low-power mode** (the game keeps full speed; the screens update 30 times a second at a lower resolution).

## Status

| Works | Partly works | Not yet |
|---|---|---|
| Homebrew (libctru, citro2d/citro3d) | Commercial games: see [Games tested](#games-tested) | Audio effects (reverb, delay) and per-voice filters |
| 3D graphics on your graphics card (vertex shaders, textures, lighting, fog, blending, depth/stencil) | Speed: most tested scenes run at full speed; video and some busy scenes are slower | Procedural textures, gas rendering |
| | Geometry shaders: point mode (the mode citro3d uses); variable- and fixed-size primitive modes are not emulated yet | |
| Save data and extra data (kept in the browser), save states | System applets: the Mii selector picks a stand-in Mii; the keyboard and error display close straight away | Networking, camera, the stereoscopic 3D effect |
| Sound: 24 DSP voices, PCM8/PCM16/DSP-ADPCM, mixing and volume | Microphone (records silence), video (`y2r` colour conversion) | |
| System files from your own console, or built-in stand-ins | Code modules loaded at run time (`ldr:ro` / CRO); the HOME Menu (see below) | Encrypted games and encrypted `.cia` files |

## How it works

| Part | File | Notes |
|---|---|---|
| ARM11 CPU | `src/cpu.js` | ARMv6K interpreter: ARM and Thumb instructions, ARMv6 media/SIMD instructions, exclusive loads/stores, and VFPv2 floating point, plus a compiler that turns hot ARM code into JavaScript (including floating point; loops run inside their compiled block) |
| WebAssembly CPU (experimental) | `src/wasmjit.js` | Optional second compiler tier (**Settings → WebAssembly CPU**): ARM blocks that stay hot are compiled again, to WebAssembly, with the console's RAM in one WebAssembly memory and a page table the generated code reads directly. Off by default: not faster than the JavaScript compiler yet |
| Memory | `src/memory.js` | 4 KB page table with aligned fast paths |
| Save states | `src/state.js` | Writes the whole emulated console (memory, CPU, threads, kernel objects, services, GPU and sound state) to a compressed file and reads it back into the same game |
| Kernel (HLE) | `src/kernel.js` | Threads with a priority scheduler, mutexes, semaphores, events, timers, address arbiters, shared memory, and heap/linear memory (old and new linear heap layouts) |
| 3D GPU | `src/gpu.js` | PICA200 in software: command lists, vertex and geometry shaders, clipping, rasterizer, all 14 texture formats including ETC1, texture combiners, fragment lighting, fog, and the output merger. This is also the reference the WebGL renderer is checked against |
| Audio (HLE) | `src/audio.js` | The DSP's audio pipeline: reads the voices the game sets up in DSP shared memory, plays their buffer queues (PCM8, PCM16, DSP-ADPCM), resamples, mixes with the game's gains and reports playback status back. The browser plays it as scheduled buffers, time-stretched (WSOLA) when the game runs below full speed so the pitch stays right |
| WebGL renderer | `src/glrender.js` | Draws with your graphics card: vertex shaders translated to GLSL, texture combiners, lighting and fog as generated fragment shaders, render targets kept on the graphics card and copied to emulated memory only when something reads them, display transfers without copies, and both screens drawn straight onto the page (no WebGL-to-2D-canvas copies, which are slow in Safari). A per-game shader cache is kept in the browser and built in the background when the game starts again, so effects do not stutter the first time they appear |
| Services (HLE) | `src/services.js` | `srv:`, `APT` (parameters, shared font, library applets), `gsp::Gpu`, `hid`, `fs` (RomFS, save data, extra data, SD card), `dsp` (with `src/audio.js`), `y2r:u` (YUV to RGB for video), `mic:u` (silence), `ldr:ro` (code modules), `cfg`, `ptm`, `err:f`. Other services are stubbed |
| System data | `src/sysdata.js` | RomFS builder, plus stand-ins for missing system data (Mii data, system fonts, bad word list) and an empty archive for any other |
| Loader | `src/loader.js` | `.3dsx`, ARM ELF, and decrypted `.3ds`/`.cci` (NCSD), `.cxi` (NCCH) and `.cia` (installable titles: the main program is taken from content 0), including compressed code and RomFS. Decryption is judged by the contents, so dumps whose header still says "encrypted" load too. Games over 256 MB (up to 4 GB cartridges) are not read whole: the code is loaded and game data is read from the file in 1 MB chunks as the game asks for it |
| Front-end | `index.html`, `src/main.js` | Both screens (stacked, side by side or top only; fit to window or fixed size; fullscreen), sound with volume, rebindable keyboard controls, on-screen touch controls for phones, gamepad, save states and game saves (**Saves** tab), low-power mode, performance graph, settings, system files manager, and a log. Installable as an app with offline support (`manifest.webmanifest`, `sw.js`) |

## Games tested

Tested with dumps of games we own, decrypted on our own console, using the default settings (graphics card renderer, compilers on) in a desktop browser.

| Game | Status | Notes |
|---|---|---|
| *New Super Mario Bros. 2* (EUR) | Playable | Intro, menus, world map and levels. World 1-1 runs at 60 FPS. Sound works |
| *Cut the Rope: Triple Treat* (EUR) | Playable | Intro video, menus and levels. Video intros and some menus run below full speed on slower PCs |
| *Mario Kart 7* (EUR) | Boots | Title screen and menus (Grand Prix, Time Trials, battles) with 3D graphics; races not tested yet |
| *Super Mario 3D Land* | Boots | Reaches its menus; selecting a Mii uses a built-in stand-in Mii |
| *Pokémon Ultra Moon* (USA) | In progress | A 4 GB cartridge: loads, starts up (80 MB memory mode) and loads its code modules (`ldr:ro`); getting in-game is not confirmed yet |
| Bundled demo and libctru examples | Works | Graphics, input, threads, RomFS |
| *HOME Menu* (EUR, from our own console) | In progress | Starts at full speed with the real system font; touch and buttons work; first-run tips. Launching apps and the installed-title list are not done yet, and the first-time "Creating HOME Menu management information" screen runs very slowly |

Statuses: **Playable** = can be played through what was tested; **Boots** = starts and shows menus; **In progress** = starts, does not reach gameplay yet.

Settings that help with speed: **Settings → Renderer** (graphics card is much faster than software), **Compilers (JIT)**, **Skip busy background threads**, and **Low-power mode** on slower phones. **Settings → Graphics device** shows whether your browser draws with your graphics card. The **Performance** tab shows FPS, speed and where frame time goes.

## Controls

| 3DS | Keyboard |
|---|---|
| D-Pad | Arrow keys |
| Circle Pad | I / J / K / L |
| A / B / X / Y | X / Z / S / A |
| L / R | Q / W |
| Start / Select | Enter / Backspace |
| ZL / ZR | 1 / 2 |
| Touch screen | Mouse or finger on the bottom screen |

Keys can be changed in the **Controls** tab. Gamepads use the standard browser mapping. Shortcuts: **P** pause, **F** fullscreen, **M** mute, **Shift+F1–F4** / **F1–F4** save / load a state (when the key is not bound to a button). Browsers start sound only after a click or key press on the page.

## Saves and save states

The **Saves** tab has both:

- **Game saves:** what the game saves itself (save data, extra data, SD card files) is kept in your browser automatically and comes back the next time you open the game. You can download them as a file, restore them from one, or delete them.
- **Save states:** a snapshot of the whole game at one moment. Four slots per game, plus download/open as a `.p3ds` file. Keyboard: **Shift+F1–F4** saves, **F1–F4** loads. A state loads into the same game only.

## Games and system files

**Games** must be decrypted. Retail dumps are usually encrypted, and this emulator does not include console keys. Decrypt your own dump on your 3DS, for example with GodMode9 ("Decrypt file"; for a `.cia`: "CIA image options" → "Decrypt file").

**System files.** Some games read data that ships with the console, such as Mii data or the system font. If one is missing, the emulator uses a built-in stand-in where it has one (Mii data, system fonts, bad word list) and an empty archive for any other, so games are not stopped just because a file is missing. The log names each file that was replaced, and if a game stops after reading from an empty one, the error screen names it. To use the real files from your own console:

1. On your 3DS, in GodMode9, open `[1:] SYSNAND CTRNAND/title/0004009b/<title>/content/`.
2. Select the `.app` file and choose **NCCH image options → Decrypt file**. The decrypted copy goes to `gm9/out/` on your SD card. (A decrypted `.cia` built with GodMode9 works too.)
3. In the emulator, open **Settings → System files → Add system files…** (or drag the `.app` onto the page). Files are saved in your browser, so you only add them once.

The real shared system font is used when its archive (`0004009B00014002`, or the Chinese/Korean/Taiwanese one) is added. The console region follows the game (or, for system titles, their title ID).

## HOME Menu (experimental)

The 3DS HOME Menu can be started from your own console's files:

1. Dump and decrypt these from your 3DS with GodMode9 (as `.app` with **NCCH image options → Decrypt file**, or as a CIA with **Build CIA from this file**, then **CIA image options → Decrypt file**), all from `[1:] SYSNAND CTRNAND/title/`:
   - the HOME Menu: `00040030/00009802` (Europe), `00008f02` (USA) or `00008202` (Japan);
   - the built-in apps in `00040010/` (System Settings, Download Play, Activity Log, Health and Safety, Camera, Sound, Mii Maker, StreetPass Mii Plaza, eShop);
   - the system data in `0004009b/` and `000400db/` (Mii data, country list, fonts, bad word list).
2. Add them all at once with **Settings → System files → Add system files…**.
3. Press **Start HOME Menu** (on the welcome screen or in Settings → System files).

First-time setup is reported as done, so the HOME Menu goes straight to its menus. It runs, draws, plays its first-run tips and reacts to touch and buttons. Starting apps from it, the list of installed games and online features (SpotPass, StreetPass, eShop) are not emulated yet. The HOME Menu checks that each app's start-up logo is signed by Nintendo, so apps it shows must be added from your console (stand-in icons are used for the rest).

## Development

```
node tools/test.js                        # regression suite
node tests/gpu/scenes.js                  # GPU tests only
node tools/bench.js app.3dsx --frames=600 --skip=60          # frame-time benchmark (avg, median, p95, p99, CPU/GPU split)
node tools/bench.js app.3dsx --no-cpu-jit --no-shader-jit --no-raster-jit   # the same with the interpreters
node tools/run.js app.3dsx 120 shot       # run headless for 120 frames, save shot-top.png / shot-bottom.png
node tools/run.js app.3dsx 300 shot --keys=A@60-70,START@200-205
```

The tests cover:

- **CPU:** 64-bit integer math, VFP float/double, libm, printf/scanf, qsort, CRC32 and setjmp/longjmp, compared against output computed independently in Python, plus hand-written Thumb assembly with ARM↔Thumb interworking.
- **Programs:** the libctru hello-world and thread examples, and the bundled demo.
- **RomFS and loading:** the libctru RomFS example in four formats (`.3dsx`, `.3ds`, compressed `.3ds`, `.cxi`), rejection of encrypted images, decrypted `.cia` files (also read on demand like large cartridges), reading system data files, and the RomFS builder.
- **GPU:** hand-built command lists and shader binaries rendered and checked pixel by pixel. They cover fill rules, color interpolation, depth, textures, ETC1, shader math and flow control, geometry shaders, immediate mode, culling, scissor, stencil, blending, alpha test and texture combiners.
- **GPU regression scenes** (`tests/gpu/regress.js`): seeded random scenes at 400×240 (all texture formats and wrap modes, NaN and huge texture coordinates, blending and logic ops in every color format, stencil, scissor, fog, lighting, clipping). Each scene must give identical bytes from the reference and compiled rasterizers and match a recorded hash.
- **Texture cache:** partial re-decoding of changed tiles matches a full decode in every tested format.
- **Stand-in system data:** the bad word list, the shared font archives (LZ11) and the empty fallback archive.
- **Formats:** decrypted `.cia` files (also read on demand like large cartridges), encrypted ones rejected, and decrypted dumps whose header still says "encrypted".
- **Compilers against interpreters:** random shader programs (`tests/gpu/shaderfuzz.js`) and random ARM instruction sequences including VFP (`tests/cpu/armfuzz.js`; `--wasm` checks the WebAssembly compiler the same way), plus whole test programs run in lockstep with and without the ARM compiler, comparing registers, flags, screens and memory after every frame.

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
