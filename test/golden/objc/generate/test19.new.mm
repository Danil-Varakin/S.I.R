// [MMDUP] .mm: одинаковая строка в функции C++ и в методе ObjC — правка в методе
#import <Foundation/Foundation.h>

void ResetCounters(Stats* stats) {
  stats->blocked = 0;
  stats->allowed = 0;
}

@implementation StatsController

- (void)reset {
  _stats->blocked = 0;
  _stats->allowed = 0;
  _stats->upgraded = 0;
}

@end
