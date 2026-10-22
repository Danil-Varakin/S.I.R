// [CHOICE] две перегрузки с одинаковым телом: обобщённое ( ... ) неоднозначно — список аргументов прописан
namespace net {

void Send(const Packet& packet) {
  Flush();
}

void Send(const Frame& frame) {
  Flush();
}

}  // namespace net
