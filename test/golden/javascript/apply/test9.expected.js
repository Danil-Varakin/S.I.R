// [DRIFT] upstream добавил метод off и поменял entries — правка в on ложится как прежде
const EVENT = { open: 'open', close: 'close' };

export class Bus {
  #handlers = new Map();
  #depth = 0;

  static registry = new Map();

  static {
    Bus.registry.set('default', new Bus());
  }

  get size() {
    return this.#handlers.size;
  }

  set size(n) {
    if (n === 0) this.#handlers.clear();
  }

  on(name, fn) {
    const list = this.#handlers.get(name) ?? [];
    if (!list.includes(fn)) list.push(fn);
    this.#handlers.set(name, list);
    return this;
  }

  off(name) {
    this.#handlers.delete(name);
    return this;
  }

  *entries() {
    for (const [name, list] of this.#handlers) {
      yield [name, list.length, this.#depth];
    }
  }

  emit(name, payload) {
    this.#depth += 1;
    try {
      for (const fn of this.#handlers.get(name) ?? []) {
        fn(payload);
      }
    } catch {
      return false;
    } finally {
      this.#depth -= 1;
    }
    return true;
  }
}

export const defaults = (function () {
  const items = new Map();
  items.set(EVENT.open, 1);
  items.set(EVENT.close, 2);
  return items;
})();

export function connect({ host = 'localhost', port = 8080, ...rest }) {
  return new Bus().on(EVENT.open, () => ({ host, port, rest }));
}
