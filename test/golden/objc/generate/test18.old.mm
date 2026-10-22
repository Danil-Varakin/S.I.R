// [MMMETHOD] .mm: метод ObjC с C++ внутри — auto, std::string, base::BindOnce с блоком ^{}
#import <Foundation/Foundation.h>

#include <string>

@implementation BraveSyncBridge {
  std::unique_ptr<SyncService> _service;
}

- (void)startWithCode:(NSString*)code {
  std::string words = base::SysNSStringToUTF8(code);
  auto callback = base::BindOnce(^(bool ok) {
    [self didFinish:ok];
  });
  _service->Start(words, std::move(callback));
}

- (void)stop {
  _service->Stop();
}

@end
