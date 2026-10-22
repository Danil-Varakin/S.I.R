// [SHIFTASSIGN] `>>>=` в правящейся строке (в js это один токен, для Sir — точка вставки)
export function scramble(seed) {
  let h = seed;
  h >>>= 8;
  return h;
}
