# [DEPS] DEPS Chromium: новая переменная в словаре vars — синтаксис Python
use_relative_paths = False

gclient_gn_args_file = 'src/build/config/gclient_args.gni'
gclient_gn_args = [
  'checkout_android',
  'checkout_nacl',
]

vars = {
  'build_with_chromium': True,
  'checkout_android': False,
  'checkout_nacl': True,
  'checkout_brave': True,
  'chromium_git': 'https://chromium.googlesource.com',
}

deps = {
  'src/third_party/abseil-cpp': {
    'url': Var('chromium_git') + '/chromium/src/third_party/abseil-cpp.git',
    'condition': 'checkout_android',
  },
}
