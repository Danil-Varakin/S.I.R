// [OBJCCAT] ObjC-заголовок .h: две категории с одинаковыми методами — правка во второй
#import <AppKit/AppKit.h>

@interface NSView (BraveLayout)
- (void)brave_layout;
- (NSRect)brave_frame;
@end

@interface NSWindow (BraveLayout)
- (void)brave_layout;
- (NSRect)brave_frame;
@end
