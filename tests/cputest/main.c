#include <3ds.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdarg.h>
static void out(const char* fmt, ...) { char b[512]; va_list ap; va_start(ap, fmt); int n = vsnprintf(b, sizeof b, fmt, ap); va_end(ap); svcOutputDebugString(b, n); }

static volatile int vol = 7;
static jmp_buf jb;

static int cmp_int(const void* a, const void* b) { int x = *(const int*)a, y = *(const int*)b; return (x > y) - (x < y); }

static uint32_t crc32_buf(const uint8_t* p, size_t n) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & -(c & 1)); }
    return ~c;
}

static void __attribute__((noinline)) jumper(double d) { if (d > 1.0) longjmp(jb, 42); }

int main(void) {
    gfxInitDefault();
    consoleInit(GFX_TOP, NULL);

    // 64-bit integer math
    int64_t a = 0x123456789ABCDEFLL * vol, b = -987654321LL * vol;
    uint64_t ua = 0xFEDCBA9876543210ULL / (uint64_t)vol;
    out("I64 %lld %lld %lld %lld %llu %llu\n", a * b, a / b, a % b, a >> 13, ua, ua % 1000003ULL);
    int32_t s = -123456789 * vol; uint32_t u = 4000000000u / (uint32_t)vol;
    out("I32 %d %d %u %u %d %d\n", s / 13, s % 13, u / 17, u % 17, __builtin_clz((unsigned)vol << 9), s >> 7);

    // doubles and libm
    double x = 1.2345678 * vol;
    out("DBL %.10f %.10f %.10f %.10f %.10f %.10f\n", sin(x), cos(x), sqrt(x), exp(x / 10), log(x), pow(x, 1.7));
    out("DBL2 %.10f %.10f %.6e %d %lld\n", atan2(x, -3.0), fmod(x * 100, 7.25), x * 1e300 * 1e5 / 1e10, (int)(x * 1000), (long long)(x * 1e15));
    // floats
    float f = 3.14159f * vol, g = 2.71828f;
    out("FLT %.4f %.4f %.4f %.4f %d %u\n", (double)(f * g), (double)(f / g), (double)(f - g * 2), (double)sqrtf(f), (int)(f * -100), (unsigned)(f * 1000));

    // strings / stdlib
    char buf[256];
    snprintf(buf, sizeof buf, "%s-%08x-%5.2f-%c", "hello", 0xBEEFu * vol, 12.5 * vol, 'A' + vol);
    int n1, n2; char w[32];
    sscanf("17 0x2a word", "%d %i %31s", &n1, &n2, w);
    out("STR %s %zu %d %d %s %d\n", buf, strlen(buf), n1, n2, w, strcmp("abcdefgh", "abcdefgz") < 0);

    // qsort + crc
    int arr[200];
    uint32_t seed = 12345;
    for (int i = 0; i < 200; i++) { seed = seed * 1103515245u + 12345u; arr[i] = (int)(seed >> 8) - (1 << 22); }
    qsort(arr, 200, sizeof(int), cmp_int);
    uint8_t data[4096];
    for (int i = 0; i < 4096; i++) data[i] = (uint8_t)(i * 31 + (i >> 5));
    memmove(data + 3, data, 1000);
    out("SORT %d %d %d CRC %08lx\n", arr[0], arr[100], arr[199], (unsigned long)crc32_buf(data, sizeof data));

    // setjmp / longjmp
    int r = setjmp(jb);
    if (r == 0) jumper(2.0 + vol);
    out("JMP %d\n", r);

    // tick and time sanity
    u64 t0 = svcGetSystemTick(); svcSleepThread(1000000); u64 t1 = svcGetSystemTick();
    out("SLEEP %s\n", (t1 - t0) >= 268000 ? "ok" : "bad");
    out("DONE\n");

    while (aptMainLoop()) {
        hidScanInput();
        if (hidKeysDown() & KEY_START) break;
        gfxFlushBuffers(); gfxSwapBuffers(); gspWaitForVBlank();
    }
    gfxExit();
    return 0;
}
