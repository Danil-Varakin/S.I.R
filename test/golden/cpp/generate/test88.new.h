// [OBJCH] ObjC-заголовок .h: @interface с @property — новое свойство
#ifndef BRAVE_IOS_BROWSER_API_SHIELDS_H_
#define BRAVE_IOS_BROWSER_API_SHIELDS_H_

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

OBJC_EXPORT
@interface BraveShieldsSettings : NSObject

@property(nonatomic, readonly) bool adBlockEnabled;
@property(nonatomic, readonly) bool httpsUpgradeEnabled;
@property(nonatomic, readonly) bool fingerprintingBlocked;

- (instancetype)initWithProfile:(Profile*)profile;
- (void)setAdBlockEnabled:(bool)enabled forHost:(NSString*)host;

@end

NS_ASSUME_NONNULL_END

#endif  // BRAVE_IOS_BROWSER_API_SHIELDS_H_
