// [CLOSED] MUST-REFUSE: шаблон закрывает Open() своей } — if из Close() вне блока, его } за просроченной } Open() не берётся
namespace io {

void Writer::Open() {
  fd_ = OpenFile(path_);
}

void Writer::Close() {
  if (fd_ >= 0) {
    CloseFile(fd_);
  }
}

}  // namespace io
