// [OBLIGATION] ... Flush() { ... >>> } — своя } функции, а не } вложенного if: тот тоже закрыватель, но обязательство берётся первым
namespace io {

void Writer::Flush() {
  if (pending_ > 0) {
    WriteAll(buffer_, pending_);
  }
  pending_ = 0;
  Sync();
}

void Writer::Close() {
  Flush();
}

}  // namespace io
