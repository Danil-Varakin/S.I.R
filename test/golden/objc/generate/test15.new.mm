// [MMCLASS] .mm: класс C++ с шаблонами и лямбдой рядом с @implementation — правка в методе C++
#import <Cocoa/Cocoa.h>

#include <memory>
#include <vector>

#include "base/functional/bind.h"

namespace brave {

class ShieldsObserver : public content::WebContentsObserver {
 public:
  explicit ShieldsObserver(content::WebContents* contents)
      : content::WebContentsObserver(contents) {}

  void DidFinishLoad(content::RenderFrameHost* host, const GURL& url) override {
    std::vector<std::unique_ptr<Counter>> counters;
    for (auto& counter : counters_) {
      counter->Reset();
      counter->Record(url.host());
    }
    callbacks_.push_back([this](int count) { OnCount(count); });
  }

 private:
  std::vector<std::unique_ptr<Counter>> counters_;
  std::vector<base::RepeatingCallback<void(int)>> callbacks_;
};

}  // namespace brave

@implementation BraveShieldsController

- (void)showPanel:(id)sender {
  [self.window makeKeyAndOrderFront:sender];
}

@end
