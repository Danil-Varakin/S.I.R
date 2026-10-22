// [TEMPLITMULTI] многострочный шаблонный литерал: { } и ; внутри — текст, правка в его середине
export function query(table, where) {
  const sql = `
    SELECT id, name, created_at
    FROM ${table}
    WHERE ${where} AND deleted = 0;
  `;
  return run(sql);
}

export function css() {
  return `.panel { display: flex; }
.panel > .item { flex: 1; min-width: 0; }`;
}
