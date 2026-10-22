// [GONE] MUST-REFUSE: upstream переименовал wire: в connect: — метода, в который шла правка, нет
#import "Downloader.h"

@interface Downloader () <NSURLSessionDelegate>
@property(nonatomic, copy) NSString *endpoint;
@property(nonatomic, assign) NSInteger retries;
@property(nonatomic, strong) NSMutableArray *queue;
@end

@implementation Downloader {
  NSInteger _inFlight;
  NSString *_token;
}

- (instancetype)initWithEndpoint:(NSString *)endpoint {
  self = [super init];
  if (self) {
    _endpoint = [endpoint copy];
    _retries = 3;
    _queue = [NSMutableArray array];
  }
  return self;
}

- (void)start:(NSURLRequest *)request {
  _inFlight += 1;
  [[self session] dataTaskWithRequest:request
                    completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                      [self handleData:data error:error];
                    }];
}

- (void)handleData:(NSData *)data error:(NSError *)error {
  @try {
    [self.delegate downloader:self didLoad:data];
  } @catch (NSException *e) {
    [self report:e];
  } @finally {
    _inFlight -= 1;
  }
}

- (void)connect:(UIButton *)button {
  [button addTarget:self action:@selector(tap:withEvent:) forControlEvents:UIControlEventTouchUpInside];
}

@end

@interface NSString (Downloader)
- (NSString *)dl_trimmed;
@end
