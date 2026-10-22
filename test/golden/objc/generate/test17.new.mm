// [MMTEMPLATE] .mm: шаблон C++ с `>>`, `if constexpr` и лямбдой — правка внутри шаблона
#include <map>
#include <string>
#include <type_traits>

template <typename T>
class Bridge {
 public:
  void Register(const std::string& key, T value) {
    if constexpr (std::is_pointer_v<T>) {
      CHECK(value);
    }
    values_[key] = value;
    history_[key].emplace_back(++version_, value);
  }

  std::map<std::string, std::vector<std::pair<int, T>>> history_;

 private:
  std::map<std::string, T> values_;
};

@interface BridgeHolder : NSObject
@property(nonatomic) int count;
@end

@implementation BridgeHolder
@end
