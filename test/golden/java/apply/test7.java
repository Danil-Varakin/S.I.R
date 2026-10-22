// [REPLACE] значение в статическом блоке инициализации
package cache;

import java.util.*;
import java.util.function.*;

public final class Cache<K, V> {

    public enum Policy {
        LRU {
            int weight(int age, int hits) {
                return age - hits;
            }
        },
        LFU {
            int weight(int age, int hits) {
                return -hits;
            }
        };

        abstract int weight(int age, int hits);
    }

    private static final Map<String, Integer> LIMITS = new HashMap<>();

    static {
        LIMITS.put("default", 1024);
        LIMITS.put("burst", 4096);
    }

    private final Map<K, V> store = new LinkedHashMap<>();
    private final Policy policy;
    private int capacity;

    public Cache(Policy policy, int capacity) {
        this.policy = policy;
        this.capacity = capacity;
    }

    public V get(K key, Function<? super K, ? extends V> loader) {
        V existing = store.get(key);
        if (existing != null) {
            return existing;
        }
        V created = loader.apply(key);
        store.put(key, created);
        return created;
    }

    public void evictAll(Collection<? extends K> keys) {
        for (K key : keys) {
            store.remove(key);
        }
    }

    public Runnable cleaner() {
        return new Runnable() {
            @Override
            public void run() {
                store.clear();
            }
        };
    }

    public List<String> names() {
        return store.keySet().stream()
                .map(Object::toString)
                .sorted()
                .collect(java.util.stream.Collectors.toList());
    }
}
