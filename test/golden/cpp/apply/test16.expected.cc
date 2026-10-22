// [OBLIGATION] за своей } Flush() нет `pending_ = 0;` — берётся } вложенного if: обязательство первое, но не единственное
namespace io {

void Writer::Flush() {
  if (pending_ > 0) {
    WriteAll(buffer_, pending_);
    Sync();
  }
  pending_ = 0;
}

}  // namespace io
