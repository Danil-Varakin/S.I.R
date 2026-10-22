// [REGEXOPS] операторы Sir ВНУТРИ регулярки: >>> и ... как обычные символы
const MARKS = />>>|<<<|\.\.\./g;

export function strip(text) {
  return text.replace(MARKS, ' ');
}
