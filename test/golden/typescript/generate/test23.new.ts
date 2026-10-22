// [TEMPLITMULTI] многострочный шаблонный литерал: { } и ; внутри — текст, правка в его середине
export function page(title: string, items: string[]): string {
  return `
<html>
  <head><style>body { margin: 0; }</style></head>
  <body>
    <h1 class="title">${title}</h1>
    <p>${items.length} items</p>
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
  </body>
</html>`;
}

export function empty(): string {
  return page('', []);
}
