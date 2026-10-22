// [ESC] \... — обособленное многоточие из кода; typename... и , ...) — литералы, не операторы
namespace content {

template <typename... Args>
void LogAll(Args&&... args) {
  // ... and then the rest
  Flush();
  (Log(args), ...);
}

}  // namespace content
