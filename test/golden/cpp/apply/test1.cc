// [DRIFT] 0.4.1, база из git: вставка в конец тела функции, upstream добавил include, функцию и метод
#include "components/feature/feature_list.h"

#include <memory>
#include <string>

#include "base/check.h"
#include "base/logging.h"
#include "base/strings/string_util.h"

namespace content {

namespace {

constexpr int kMaxRetries = 3;

bool IsEnabledByDefault(const std::string& name) {
  return base::StartsWith(name, "Enable");
}

}  // namespace

void UnregisterFeatures(FeatureList* list) {
  list->Clear();
}

void RegisterFeatures(FeatureList* list) {
  list->Add(kFastPath);
  list->Add(kSlowPath);
}

class Registry {
 public:
  explicit Registry(FeatureList* list) : list_(list) {}

  void Reset() {
    list_->Clear();
    retries_ = 0;
  }

  void Pause() { paused_ = true; }

  bool Retry() {
    if (retries_ >= kMaxRetries) {
      return false;
    }
    ++retries_;
    return true;
  }

 private:
  FeatureList* list_;
  int retries_ = 0;
  bool paused_ = false;
};

#if BUILDFLAG(IS_WIN)
void PlatformInit() {
  InitCom();
}
#else
void PlatformInit() {
  InitPosix();
}
#endif

}  // namespace content
