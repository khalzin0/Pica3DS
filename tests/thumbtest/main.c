#include <3ds.h>
#include <stdio.h>
#include <stdint.h>
uint32_t thumb_mix(const uint8_t* p, uint32_t n);
static uint32_t ror32(uint32_t v, unsigned n) { n &= 31; return n ? (v >> n) | (v << (32 - n)) : v; }
static uint32_t __attribute__((noinline)) ref(const uint8_t* p, uint32_t n, volatile int* carry_guess) {
    uint32_t h = 0x811C9DC5, acc = 0;
    for (uint32_t i = 0; i < n; i++) {
        h ^= p[i]; h *= 0x01000193;
        acc += ror32(h, i) ^ (h >> 3);
        uint32_t before = acc; uint32_t sub = (uint32_t)(int32_t)(int8_t)(h & 0xFF);
        acc = before - sub;
        int16_t hw = (int16_t)(p[i] | (p[i + 1] << 8));
        acc = acc + (uint32_t)(hw >> 1) + (uint32_t)(hw & 1); /* ASRS #1 sets C = bit0, then ADCS */
    }
    uint32_t rv = __builtin_bswap32(acc), a5 = (uint32_t)((int32_t)acc >> 5);
    uint32_t r7 = rv + a5;
    uint32_t r12 = r7, r5 = ~a5;
    r7 &= ~r5; r7 ^= r12;
    return r7 + h;
}
int main(void) {
    static uint8_t data[256];
    for (int i = 0; i < 256; i++) data[i] = (uint8_t)(i * 73 + 11);
    char b[128];
    uint32_t (*fn)(const uint8_t*, uint32_t) = thumb_mix;
    volatile int g = 0;
    for (uint32_t n = 1; n <= 200; n += 37) {
        uint32_t t = fn(data, n), r = ref(data, n, &g);
        int len = snprintf(b, sizeof b, "THUMB n=%lu %08lx %08lx %s\n", n, t, r, t == r ? "ok" : "MISMATCH");
        svcOutputDebugString(b, len);
    }
    return 0;
}
