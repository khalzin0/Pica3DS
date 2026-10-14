    .syntax unified
    .thumb
    .global thumb_mix
    .thumb_func
@ u32 thumb_mix(const u8* p, u32 n)
thumb_mix:
    push {r4-r7, lr}
    ldr r2, =0x811C9DC5
    ldr r3, =0x01000193
    movs r4, #0
    movs r7, #0
1:  cmp r4, r1
    bhs 2f
    ldrb r5, [r0, r4]
    eors r2, r5
    muls r2, r3
    mov r6, r2
    rors r6, r4
    lsrs r5, r2, #3
    eors r6, r5
    adds r7, r6
    sxtb r5, r2
    subs r7, r7, r5
    ldrsh r5, [r0, r4]
    asrs r5, r5, #1
    adcs r7, r5
    adds r4, #1
    b 1b
2:  bl helper
    adds r0, r7, r2
    pop {r4-r7, pc}
    .thumb_func
helper:
    rev r6, r7
    asrs r5, r7, #5
    adds r7, r6, r5
    mov r12, r7
    mvns r5, r5
    bics r7, r5
    mov r5, r12
    eors r7, r5
    bx lr
    .pool
