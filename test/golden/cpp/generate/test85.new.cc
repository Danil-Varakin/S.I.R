// [CHOICE] одна и та же функция в двух блоках одного имени: заголовок внешнего блока расширен до строки, что их различает
namespace config {
constexpr int kVersion = 1;
void Load() {
  Read();
}
}  // namespace config

namespace config {
constexpr int kVersion = 2;
void Load() {
  ReadV2();
}
}  // namespace config
