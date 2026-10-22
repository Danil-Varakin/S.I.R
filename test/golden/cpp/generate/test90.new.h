// [OBJCMIXED] .h с #ifdef __OBJC__: @class для ObjC, class для C++, класс C++ с указателем на NSWindow
#ifndef CHROME_BROWSER_UI_COCOA_BRAVE_WINDOW_H_
#define CHROME_BROWSER_UI_COCOA_BRAVE_WINDOW_H_

#include <memory>

#ifdef __OBJC__
@class NSWindow;
@class BraveTitlebarView;
#else
class NSWindow;
class BraveTitlebarView;
#endif

class BraveWindow {
 public:
  explicit BraveWindow(NSWindow* window);
  ~BraveWindow();

  void UpdateTitlebar();
  void SetTitlebarHidden(bool hidden);

 private:
  NSWindow* window_;
  BraveTitlebarView* titlebar_;
};

#endif  // CHROME_BROWSER_UI_COCOA_BRAVE_WINDOW_H_
