// [DRIFT] upstream поменял Picker и Toolbar — новая ячейка в строке таблицы ложится как прежде
import type { Task } from './types.ts';

interface Props<T> {
  items: readonly T[];
  loading: boolean;
  onPick: (item: T) => void;
}

export function Toolbar() {
  return (
    <>
      <button type="button">refresh</button>
      <button type="button">filter</button>
      <button type="button">clear</button>
    </>
  );
}

export function TaskTable<T extends Task>({ items, loading, onPick }: Props<T>) {
  if (loading) {
    return <Spinner size="small" />;
  }

  return (
    <section className="table">
      <Toolbar />
      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} onClick={() => onPick(item)}>
              <td>{item.title}</td>
              <td>{item.done ? 'done' : 'open'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <Empty hint="nothing here" />}
    </section>
  );
}

export function Picker<T extends Task>(props: Props<T>) {
  return (
    <Select<T>
      {...props}
      render={(item) => <Badge value={item.title} />}
      empty={<Placeholder text="none" />}
    />
  );
}
