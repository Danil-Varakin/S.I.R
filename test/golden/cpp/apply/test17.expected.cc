// [ESCAPE] незакрытая { упорядочивает, не запирает: в Open() нет if, шаблон уходит в Close() — выход из блока разрешён
namespace io {

void Writer::Open() {
  fd_ = OpenFile(path_);
}

void Writer::Close() {
  if (fd_ >= 0) {
    CloseFile(fd_);
    fd_ = -1;
  }
}

}  // namespace io
