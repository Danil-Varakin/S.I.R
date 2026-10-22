// [WEBIDL] .webidl расширений: функция в namespace, комментарий /* */ со скобками рядом
// Use the <code>chrome.developerPrivate</code> API to manage extensions.
namespace developerPrivate {
  /* Returns {items} of the profile (see [ItemInfo]). */
  callback ItemsInfoCallback = void (sequence<ItemInfo> result);

  interface Functions {
    static void getExtensionsInfo(optional GetExtensionsInfoOptions options,
                                  ItemsInfoCallback callback);
    static void getProfileConfiguration(ProfileInfoCallback callback);
    static void braveGetExtensionsAllowed(BooleanCallback callback);
  };
};
