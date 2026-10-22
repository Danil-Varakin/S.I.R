// [SHIFT] `>>>` — беззнаковый сдвиг Java: оператор Sir, стоящий В САМОЙ правящейся строке
static int mix(int seed) {
    int h = seed;
    h ^= h >>> 16;
    h *= 0x85ebca6b;
    return h;
}
