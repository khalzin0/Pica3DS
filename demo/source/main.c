// Demo for the 3DS emulator: plasma animation, movable sprite, live input readout.
#include <3ds.h>
#include <stdio.h>
#include <string.h>
#include <math.h>

static u8 sintab[256];
static u8 pal[256][3];

static void put(u8* fb, int x, int y, const u8* c) {
    if (x < 0 || x >= 400 || y < 0 || y >= 240) return;
    u8* p = fb + (x * 240 + (239 - y)) * 3;
    p[0] = c[2]; p[1] = c[1]; p[2] = c[0];
}

int main(void) {
    gfxInitDefault();
    consoleInit(GFX_BOTTOM, NULL);

    for (int i = 0; i < 256; i++) {
        sintab[i] = (u8)(127.5 + 127.4 * sin(i * 2 * M_PI / 256));
        pal[i][0] = (u8)(128 + 127 * sin(i * M_PI / 64));
        pal[i][1] = (u8)(128 + 127 * sin(i * M_PI / 64 + 2.1));
        pal[i][2] = (u8)(128 + 127 * sin(i * M_PI / 64 + 4.2));
    }

    float sx = 200, sy = 120;
    u32 t = 0, frames = 0, fps = 0;
    u64 lastSec = osGetTime();
    static const char* names[] = {"A","B","SELECT","START","RIGHT","LEFT","UP","DOWN","R","L","X","Y"};

    printf("\x1b[1;1H\x1b[33;1m  3DS Emulator Demo\x1b[0m\n");
    printf("  ------------------\n");
    printf("  D-Pad / Circle Pad: move square\n");
    printf("  Touch screen: jump square there\n");
    printf("  A: change color   START: exit\n");

    int colorShift = 0;
    while (aptMainLoop()) {
        hidScanInput();
        u32 kd = hidKeysDown(), kh = hidKeysHeld();
        if (kd & KEY_START) break;
        if (kd & KEY_A) colorShift += 64;

        circlePosition cp; hidCircleRead(&cp);
        touchPosition tp; hidTouchRead(&tp);
        if (kh & KEY_DLEFT) sx -= 3;
        if (kh & KEY_DRIGHT) sx += 3;
        if (kh & KEY_DUP) sy -= 3;
        if (kh & KEY_DDOWN) sy += 3;
        sx += cp.dx / 25.0f; sy -= cp.dy / 25.0f;
        if (kh & KEY_TOUCH) { sx = tp.px * 400 / 320; sy = tp.py; }
        if (sx < 10) sx = 10;
        if (sx > 390) sx = 390;
        if (sy < 10) sy = 10;
        if (sy > 230) sy = 230;

        u8* fb = gfxGetFramebuffer(GFX_TOP, GFX_LEFT, NULL, NULL);
        for (int x = 0; x < 400; x += 2) {
            u8 a = sintab[(x + t) & 255];
            for (int y = 0; y < 240; y += 2) {
                int v = a + sintab[(y * 2 + t * 3 / 2) & 255] + sintab[((x + y) / 2 + t * 2) & 255];
                const u8* c = pal[(v / 3 + colorShift) & 255];
                u8* p = fb + (x * 240 + (238 - y)) * 3;
                p[0] = p[3] = p[720] = p[723] = c[2];
                p[1] = p[4] = p[721] = p[724] = c[1];
                p[2] = p[5] = p[722] = p[725] = c[0];
            }
        }
        static const u8 white[3] = {255, 255, 255}, black[3] = {0, 0, 0};
        for (int dx = -10; dx <= 10; dx++)
            for (int dy = -10; dy <= 10; dy++)
                put(fb, (int)sx + dx, (int)sy + dy, (dx == -10 || dx == 10 || dy == -10 || dy == 10) ? black : white);

        frames++;
        u64 now = osGetTime();
        if (now - lastSec >= 1000) { fps = frames; frames = 0; lastSec = now; }

        printf("\x1b[8;1H  FPS: %-3lu   frame: %lu      \n", fps, t);
        printf("  Circle pad: %4d, %4d      \n", cp.dx, cp.dy);
        printf("  Touch: %s %3d, %3d      \n", (kh & KEY_TOUCH) ? "yes" : "no ", tp.px, tp.py);
        printf("  Square: %3d, %3d      \n", (int)sx, (int)sy);
        printf("\x1b[13;1H  Held:                                  \n\x1b[13;9H");
        for (int i = 0; i < 12; i++) if (kh & BIT(i)) printf("%s ", names[i]);

        gfxFlushBuffers();
        gfxSwapBuffers();
        gspWaitForVBlank();
        t++;
    }
    gfxExit();
    return 0;
}
