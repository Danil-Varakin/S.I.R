// [MMMSG] .mm: посылки сообщений [obj msg] внутри функции C++ — правка в ней
#import <AppKit/AppKit.h>

#include "base/strings/sys_string_conversions.h"

namespace {

void SetWindowTitle(NSWindow* window, const std::string& title) {
  if (!window) {
    return;
  }
  [window setTitle:base::SysUTF8ToNSString(title)];
  [[window standardWindowButton:NSWindowCloseButton] setEnabled:YES];
}

void SetWindowAlpha(NSWindow* window, double alpha) {
  [window setAlphaValue:alpha];
}

}  // namespace

void BrowserWindowCocoa::UpdateTitle() {
  SetWindowTitle(window_, GetTitle());
}
