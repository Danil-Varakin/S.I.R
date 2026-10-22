// [NSSTR] заголовки разметки Sir внутри строкового литерала Objective-C
static NSString *const kTemplate = @"# match objc\n    - (void)sample;\n# end\n";

- (NSString *)template {
  return [kTemplate mutableCopy];
}
