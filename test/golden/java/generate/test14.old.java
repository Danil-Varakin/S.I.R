// [SHIFTASSIGN] составное присваивание `>>>=` рядом с правкой (оператор Sir как префикс)
static int fold(int acc, int bits) {
    acc >>>= 3;
    acc ^= bits;
    return acc;
}
