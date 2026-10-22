// [DRIFT] MUST-REFUSE 0.4.1: upstream удалил метод, в который шла правка — нет места
#include "components/feature/feature_list.h"

#include <memory>
#include <string>

#include "base/logging.h"
#include "base/strings/string_util.h"

namespace content {

namespace {

constexpr int kMaxRetries = 3;

bool IsEnabledByDefault(const std::string& name) {
  return base::StartsWith(name, "Enable");
}

}  // namespace

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

 private:
  FeatureList* list_;
  int retries_ = 0;
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
