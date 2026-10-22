// [OBJCPROTO] ObjC-заголовок .h: @protocol с @optional — новый метод протокола
#import <Foundation/Foundation.h>

@protocol BraveWalletObserver <NSObject>

- (void)walletDidUnlock;

@optional
- (void)walletDidLock;
- (void)accountsChanged:(NSArray<NSString*>*)accounts;
- (void)networkChanged:(NSString*)chainId;

@end

@protocol BraveRewardsObserver <NSObject>

- (void)rewardsDidUnlock;

@optional
- (void)walletDidLock;

@end
