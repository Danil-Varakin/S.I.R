// [RENAMED] MUST-REFUSE: upstream переименовал ring_push в ring_write — родителя, на которого опирается ханк, больше нет
#include <stdlib.h>
#include <string.h>

#define STATES(X) \
  X(IDLE, 0)      \
  X(BUSY, 1)      \
  X(DEAD, 2)

struct header {
  unsigned int ready : 1;
  unsigned int level : 3;
  unsigned int spare : 4;
};

struct ring {
  struct header head;
  size_t capacity;
  size_t used;
  unsigned char *data;
};

static struct ring make_ring(size_t capacity) {
  return (struct ring){ .capacity = capacity, .used = 0, .data = NULL };
}

int ring_init(struct ring *r, size_t capacity) {
  *r = make_ring(capacity);
  r->data = malloc(capacity);
  if (r->data == NULL) goto fail;
  if (capacity == 0) goto fail;
  r->head.ready = 1;
  return 1;
fail:
  free(r->data);
  r->data = NULL;
  return 0;
}

size_t ring_write(struct ring *r, const unsigned char *src, size_t n) {
  if (r->used + n > r->capacity) {
    n = r->capacity - r->used;
  }
  memcpy(r->data + r->used, src, n);
  r->used += n;
  return n;
}

int ring_compare(const void *a, const void *b) {
  const struct ring *x = a;
  const struct ring *y = b;
  if (x->used < y->used) return -1;
  if (x->used > y->used) return 1;
  return 0;
}
